// tests/unit/app-cloud-init.test.js
// DEV-0001 CP-02：envId 单一出处 + app.js 云开发初始化入参/降级行为。
'use strict'

var path = require('path')

var APP_PATH = path.resolve(__dirname, '../../miniprogram/app.js')
var ENV_PATH = path.resolve(__dirname, '../../miniprogram/config/env.js')

function loadAppConfig() {
  var captured = null
  global.App = function (config) {
    captured = config
  }
  jest.isolateModules(function () {
    require(APP_PATH)
  })
  return captured
}

describe('app.js 云开发环境初始化（CP-02）', function () {
  var originalCloud
  var originalSkylineInfo

  beforeEach(function () {
    originalCloud = wx.cloud
    originalSkylineInfo = wx.getSkylineInfo
    wx.cloud = { init: jest.fn() }
    // task-64：App.onLaunch 最早期会检测 Skyline；本文件只测正常版本下的云初始化。
    wx.getSkylineInfo = jest.fn(function () {
      return { isSupported: true }
    })
    jest.resetModules()
  })

  afterEach(function () {
    wx.cloud = originalCloud
    if (originalSkylineInfo === undefined) {
      delete wx.getSkylineInfo
    } else {
      wx.getSkylineInfo = originalSkylineInfo
    }
    if (global.App) {
      delete global.App
    }
  })

  test('env.js 是 envId 的唯一出处，值与用户提供的一致（simn 前缀原样）', function () {
    var env = require(ENV_PATH)
    expect(env.ENV_ID).toBe('simn-01-d5gjsxm0ocb78add8')
    expect(typeof env.ENV_ID).toBe('string')
  })

  test('onLaunch 以 ENV_ID 调用 wx.cloud.init 并置 cloudReady=true', function () {
    var config = loadAppConfig()
    expect(config).toBeTruthy()
    config.onLaunch.call(config)
    expect(wx.cloud.init).toHaveBeenCalledTimes(1)
    expect(wx.cloud.init).toHaveBeenCalledWith({
      env: 'simn-01-d5gjsxm0ocb78add8',
      traceUser: true
    })
    expect(config.globalData.cloudReady).toBe(true)
  })

  test('init 抛错时静默降级：不抛出且 cloudReady=false', function () {
    wx.cloud.init = jest.fn(function () {
      throw new Error('env not found')
    })
    var config = loadAppConfig()
    expect(function () {
      config.onLaunch.call(config)
    }).not.toThrow()
    expect(config.globalData.cloudReady).toBe(false)
  })

  test('wx.cloud 不可用时不抛出且 cloudReady=false', function () {
    wx.cloud = undefined
    var config = loadAppConfig()
    expect(function () {
      config.onLaunch.call(config)
    }).not.toThrow()
    expect(config.globalData.cloudReady).toBe(false)
  })

  test('保留 vendor=mock 与非就绪初始状态（不阻塞渲染）', function () {
    var config = loadAppConfig()
    expect(config.globalData.vendor).toBe('mock')
    expect(config.globalData.cloudReady).toBe(false)
  })
})
