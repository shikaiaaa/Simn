// tests/unit/client-compat.test.js
// task-64 / SPEC-0001 v0.10 §E + AC-28①②：低版本微信 Skyline 可用性检测（保守判定，API 缺失即低版本）。
'use strict'

var path = require('path')

var COMPAT_PATH = path.resolve(__dirname, '../../miniprogram/utils/client-compat.js')

function loadCompat() {
  var mod = null
  jest.isolateModules(function () {
    mod = require(COMPAT_PATH)
  })
  return mod
}

describe('client-compat：isSkylineSupported（AC-28）', function () {
  var originalGetSkylineInfo

  beforeEach(function () {
    originalGetSkylineInfo = wx.getSkylineInfo
    delete wx.getSkylineInfo
  })

  afterEach(function () {
    if (originalGetSkylineInfo === undefined) {
      delete wx.getSkylineInfo
    } else {
      wx.getSkylineInfo = originalGetSkylineInfo
    }
    if (global.getApp) delete global.getApp
  })

  test('支持：wx.getSkylineInfo 存在且 isSupported 为 true', function () {
    wx.getSkylineInfo = jest.fn(function () {
      return { isSupported: true, version: '1.0.0' }
    })
    expect(loadCompat().isSkylineSupported()).toBe(true)
  })

  test('不支持：isSupported 明确为 false', function () {
    wx.getSkylineInfo = jest.fn(function () {
      return { isSupported: false }
    })
    expect(loadCompat().isSkylineSupported()).toBe(false)
  })

  test('缺 API：typeof wx.getSkylineInfo !== function 视为低版本，不调用不存在的 API', function () {
    expect(typeof wx.getSkylineInfo).toBe('undefined')
    expect(function () {
      loadCompat().isSkylineSupported()
    }).not.toThrow()
    expect(loadCompat().isSkylineSupported()).toBe(false)
  })

  test('异常：调用抛错按不支持处理且不外抛（旧版不白屏）', function () {
    wx.getSkylineInfo = jest.fn(function () {
      throw new Error('not supported on old client')
    })
    var result
    expect(function () {
      result = loadCompat().isSkylineSupported()
    }).not.toThrow()
    expect(result).toBe(false)
  })

  test('返回空对象/undefined 不误判为低版本（只有明确 false 才判不支持）', function () {
    wx.getSkylineInfo = jest.fn(function () {
      return undefined
    })
    expect(loadCompat().isSkylineSupported()).toBe(true)
    wx.getSkylineInfo = jest.fn(function () {
      return {}
    })
    expect(loadCompat().isSkylineSupported()).toBe(true)
  })
})

describe('client-compat：isClientTooOld（业务页兜底，AC-28③）', function () {
  afterEach(function () {
    if (global.getApp) delete global.getApp
  })

  test('无 getApp 时安全返回 false（不抛错）', function () {
    expect(loadCompat().isClientTooOld()).toBe(false)
  })

  test('getApp().globalData.clientTooOld === true 时返回 true', function () {
    global.getApp = function () {
      return { globalData: { clientTooOld: true } }
    }
    expect(loadCompat().isClientTooOld()).toBe(true)
  })

  test('正常版本（clientTooOld 缺省/false）返回 false', function () {
    global.getApp = function () {
      return { globalData: { cloudReady: true } }
    }
    expect(loadCompat().isClientTooOld()).toBe(false)
    global.getApp = function () {
      return { globalData: { clientTooOld: false } }
    }
    expect(loadCompat().isClientTooOld()).toBe(false)
  })

  test('getApp 抛错时保守返回 false，不影响正常页面', function () {
    global.getApp = function () {
      throw new Error('getApp failed')
    }
    expect(loadCompat().isClientTooOld()).toBe(false)
  })
})
