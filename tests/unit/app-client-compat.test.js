// tests/unit/app-client-compat.test.js
// task-64 / SPEC-0001 v0.10 §D-6/§E + AC-28：App.onLaunch 最早期低版本兜底 + 业务页防御性 return。
'use strict'

var path = require('path')

var APP_PATH = path.resolve(__dirname, '../../miniprogram/app.js')
var PAGES_DIR = path.resolve(__dirname, '../../miniprogram/pages')

function loadAppConfig() {
  var captured = null
  global.App = function (config) {
    captured = config
  }
  jest.isolateModules(function () {
    require(APP_PATH)
  })
  delete global.App
  return captured
}

function loadPage(relativePath) {
  var captured = null
  global.Page = function (config) {
    captured = config
  }
  jest.isolateModules(function () {
    require(path.join(PAGES_DIR, relativePath))
  })
  delete global.Page
  return captured
}

describe('app.js 低版本微信兜底（AC-28①②④）', function () {
  var originalSkylineInfo
  var originalExitMiniProgram

  beforeEach(function () {
    originalSkylineInfo = wx.getSkylineInfo
    originalExitMiniProgram = wx.exitMiniProgram
    delete wx.getSkylineInfo
    wx.exitMiniProgram = jest.fn()
    wx.__reset()
  })

  afterEach(function () {
    if (originalSkylineInfo === undefined) {
      delete wx.getSkylineInfo
    } else {
      wx.getSkylineInfo = originalSkylineInfo
    }
    if (originalExitMiniProgram === undefined) {
      delete wx.exitMiniProgram
    } else {
      wx.exitMiniProgram = originalExitMiniProgram
    }
    jest.resetModules()
  })

  test('wx.getSkylineInfo 缺失 → 原生弹窗提示升级，确认后 exitMiniProgram', function () {
    var config = loadAppConfig()
    expect(config).toBeTruthy()
    config.onLaunch.call(config)

    expect(config.globalData.clientTooOld).toBe(true)
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    var opts = wx.showModal.mock.calls[0][0]
    expect(opts.title).toBe('需要升级微信')
    expect(opts.content).toContain('当前微信版本过低')
    expect(opts.content).toContain('8.0.30 及以上')
    expect(opts.content).toContain('应用商店升级后重试')
    expect(opts.showCancel).toBe(false)
    expect(opts.confirmText).toBe('知道了')
    expect(wx.exitMiniProgram).toHaveBeenCalledTimes(1)
  })

  test('兜底分支不初始化云开发、不请求云函数、不读写 Storage（AC-28①）', function () {
    var config = loadAppConfig()
    config.onLaunch.call(config)

    expect(wx.cloud.init).not.toHaveBeenCalled()
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
    expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
    expect(wx.setStorageSync).not.toHaveBeenCalled()
    expect(wx.getStorageSync).not.toHaveBeenCalled()
    expect(wx.removeStorageSync).not.toHaveBeenCalled()
    expect(config.globalData.cloudReady).toBe(false)
  })

  test('isSupported === false → 同样走原生兜底（不进入业务）', function () {
    wx.getSkylineInfo = jest.fn(function () {
      return { isSupported: false }
    })
    var config = loadAppConfig()
    config.onLaunch.call(config)

    expect(config.globalData.clientTooOld).toBe(true)
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(wx.cloud.init).not.toHaveBeenCalled()
  })

  test('检测抛异常 → 不白屏（不抛出），按低版本兜底', function () {
    wx.getSkylineInfo = jest.fn(function () {
      throw new Error('unsupported')
    })
    var config = loadAppConfig()
    expect(function () {
      config.onLaunch.call(config)
    }).not.toThrow()

    expect(config.globalData.clientTooOld).toBe(true)
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(wx.cloud.init).not.toHaveBeenCalled()
  })

  test('正常版本（mock 返回支持）→ 不弹窗，cloud.init 正常（AC-28③）', function () {
    wx.getSkylineInfo = jest.fn(function () {
      return { isSupported: true }
    })
    var config = loadAppConfig()
    config.onLaunch.call(config)

    expect(config.globalData.clientTooOld).toBe(false)
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(wx.exitMiniProgram).not.toHaveBeenCalled()
    expect(wx.cloud.init).toHaveBeenCalledTimes(1)
    expect(wx.cloud.init).toHaveBeenCalledWith({
      env: 'simn-01-d5gjsxm0ocb78add8',
      traceUser: true
    })
    expect(config.globalData.cloudReady).toBe(true)
  })
})

describe('业务页 onLoad/onShow 防御（AC-28③）', function () {
  afterEach(function () {
    delete global.getApp
    wx.__reset()
    jest.resetModules()
  })

  test('index.onShow：clientTooOld 时不请求、不渲染业务，仅置 clientBlocked', function () {
    global.getApp = function () {
      return { globalData: { clientTooOld: true } }
    }
    var page = loadPage('index/index.js')
    var setData = jest.fn()
    page.setData = setData
    page.data = { clientBlocked: false }

    page.onShow.call(page)

    expect(setData).toHaveBeenCalledTimes(1)
    expect(setData).toHaveBeenCalledWith({ clientBlocked: true })
    var loadingCalls = setData.mock.calls.filter(function (args) {
      return args[0] && args[0].loading === true
    })
    expect(loadingCalls).toHaveLength(0)
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('result.onLoad：clientTooOld 时直接 return（不 setData、不请求）', function () {
    global.getApp = function () {
      return { globalData: { clientTooOld: true } }
    }
    var page = loadPage('result/result.js')
    var setData = jest.fn()
    page.setData = setData

    page.onLoad.call(page, { taskId: 't_1' })

    expect(setData).not.toHaveBeenCalled()
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('capture.onLoad：clientTooOld 时直接 return（不进入同意门禁/不请求）', function () {
    global.getApp = function () {
      return { globalData: { clientTooOld: true } }
    }
    var page = loadPage('capture/capture.js')
    var setData = jest.fn()
    page.setData = setData

    page.onLoad.call(page)

    expect(setData).not.toHaveBeenCalled()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
  })
})
