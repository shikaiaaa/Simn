/**
 * tests/unit/pages/garment/garment-page.test.js
 * 覆盖：草稿/同意门禁、单张上装 L0、服务端四类拦截（AC-24 创建任务 0 次）、
 * createTask 成功跳转、额度失败可重试且幂等、2002 恢复进行中任务、敏感值不落本地缓存。
 */
'use strict'

var CAPTURED = null
global.Page = function (config) {
  CAPTURED = config
}
require('../../../../miniprogram/pages/garment/garment.js')

var api = require('../../../../miniprogram/services/api')
var CONSENT = JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 1 })
var DRAFT = {
  personAssetIds: ['a_person_1'],
  metrics: { heightCm: 175, weightKg: 70.5, gender: 'unspecified' },
  createdAt: 1
}

function createPage() {
  var page = {
    data: JSON.parse(JSON.stringify(CAPTURED.data)),
    setData: function (patch) {
      Object.assign(this.data, patch)
    }
  }
  Object.keys(CAPTURED).forEach(function (key) {
    if (typeof CAPTURED[key] === 'function') page[key] = CAPTURED[key].bind(page)
  })
  return page
}

function envelope(data, payload) {
  return { result: { ok: true, data: payload || {}, error: null, requestId: 'req-' + data.action, serverTime: 1 } }
}

function errorEnvelope(data, code, name, message) {
  return {
    result: {
      ok: false,
      data: null,
      error: { code: code, name: name, message: message, hint: '', httpStatus: code === 2001 ? 429 : 409 },
      requestId: 'req-err',
      serverTime: 1
    }
  }
}

var appMock = null
var precheckResult = { pass: true, status: 'pass', checks: [] }
var createTaskResult = { ok: true, taskId: 't_1' }

beforeEach(function () {
  wx.__reset()
  delete wx.createOffscreenCanvas
  delete wx.canvasToTempFilePath
  delete wx.getFileInfo
  wx.getStorageSync = jest.fn(function (key) {
    return key === 'sinn_consent_v1' ? CONSENT : ''
  })
  wx.setStorageSync = jest.fn()
  wx.redirectTo = jest.fn()
  wx.navigateTo = jest.fn()
  wx.chooseMedia = jest.fn(function (options) {
    options.success({ tempFiles: [{ tempFilePath: '/tmp/garment.jpg', size: 2 * 1024 * 1024, fileType: 'image/jpeg' }] })
  })
  wx.getImageInfo = jest.fn(function (options) {
    options.success({ width: 1080, height: 1440, orientation: 'up', type: 'jpeg' })
  })
  wx.cloud.uploadFile = jest.fn(function () {
    return Promise.resolve({ fileID: 'cloud://mock-env/sinn/garment/g.jpg' })
  })
  wx.cloud.callFunction = jest.fn(function (options) {
    var data = options.data || {}
    if (data.action === 'assetRegister') {
      return Promise.resolve(envelope(data, { assetId: 'a_garment_1', kind: 'GARMENT', purgeAt: 1 }))
    }
    if (data.action === 'precheck') {
      return Promise.resolve(envelope(data, Object.assign({ status: 'pass', checks: [] }, precheckResult)))
    }
    if (data.action === 'createTask') {
      if (createTaskResult.ok) {
        return Promise.resolve(
          envelope(data, { taskId: createTaskResult.taskId, status: 'QUEUED', quota: { remaining: 0 }, createdAt: 1, purgeAt: 2 })
        )
      }
      return Promise.resolve(errorEnvelope(data, createTaskResult.code, createTaskResult.name, createTaskResult.message))
    }
    if (data.action === 'profile') {
      return Promise.resolve(envelope(data, { activeTaskId: 't_2', quota: {}, consent: null, hasData: true }))
    }
    return Promise.resolve(envelope(data, {}))
  })
  appMock = { globalData: { captureDraft: DRAFT } }
  global.getApp = function () {
    return appMock
  }
  precheckResult = { pass: true, status: 'pass', checks: [] }
  createTaskResult = { ok: true, taskId: 't_1' }
})

function pickEvent(index) {
  return { currentTarget: { dataset: { index: index } } }
}

function callsOfAction(action) {
  return wx.cloud.callFunction.mock.calls
    .map(function (call) {
      return call[0].data
    })
    .filter(function (data) {
      return data.action === action
    })
}

function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve)
  })
}

function prepare() {
  var page = createPage()
  page.onLoad()
  return page.onPickPhoto(pickEvent(-1)).then(function () {
    return page
  })
}

describe('garment 页：入口门禁', function () {
  test('带内存草稿可进入且保存 draft', function () {
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(page.data.draft.personAssetIds).toEqual(['a_person_1'])
  })

  test('草稿缺失（无 personAssetIds）回 capture 页', function () {
    appMock.globalData.captureDraft = null
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo).toHaveBeenCalled()
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/capture/capture')
  })

  test('未同意时回 consent 页', function () {
    wx.getStorageSync = jest.fn(function () {
      return ''
    })
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/consent/consent')
  })
})

describe('garment 页：单张上装与 L0', function () {
  test('选择一张照片后 canSubmit=true 且展示单件提示', function () {
    return prepare().then(function (page) {
      expect(page.data.photo.path).toBe('/tmp/garment.jpg')
      expect(page.data.canSubmit).toBe(true)
      expect(page.data.acceptHint).toContain('仅接受自家衣服平铺/挂拍、单件完整展示')
    })
  })

  test('超限照片自动压缩；无 Canvas 能力时提示处理失败、不进入槽位、不上传', function () {
    wx.chooseMedia = jest.fn(function (options) {
      options.success({ tempFiles: [{ tempFilePath: '/tmp/big.jpg', size: 11 * 1024 * 1024, fileType: 'image/jpeg' }] })
    })
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      expect(page.data.photo).toBeNull()
      expect(page.data.errorText).toContain('照片处理失败')
      expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
    })
  })

  test('大图压缩后进入槽位、提示已自动压缩、上传使用压缩路径（AC-27）', function () {
    wx.chooseMedia = jest.fn(function (options) {
      options.success({ tempFiles: [{ tempFilePath: '/tmp/big.jpg', size: 12 * 1024 * 1024, fileType: 'image/jpeg' }] })
    })
    wx.getImageInfo = jest.fn(function (options) {
      options.success({ width: 6000, height: 4000, orientation: 'up', type: 'jpeg' })
    })
    var canvas = {
      getContext: jest.fn(function () {
        return { save: jest.fn(), translate: jest.fn(), scale: jest.fn(), rotate: jest.fn(), drawImage: jest.fn(), restore: jest.fn() }
      }),
      createImage: jest.fn(function () {
        var image = {}
        Object.defineProperty(image, 'src', {
          set: function () {
            if (image.onload) image.onload()
          }
        })
        return image
      })
    }
    wx.createOffscreenCanvas = jest.fn(function () {
      return canvas
    })
    wx.canvasToTempFilePath = jest.fn(function (opts) {
      opts.success({ tempFilePath: '/tmp/garment-compressed.jpg' })
    })
    wx.getFileInfo = jest.fn(function (opts) {
      var size = wx.getFileInfo.mock.calls.length === 1 ? 8 * 1024 * 1024 : 4 * 1024 * 1024
      opts.success({ size: size })
    })
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      expect(page.data.photo.path).toBe('/tmp/garment-compressed.jpg')
      expect(page.data.compressionNote).toContain('已自动压缩照片')
      expect(page.data.compressionNote).toContain('6000→4096')
      return page.onStart().then(function () {
        expect(wx.cloud.uploadFile).toHaveBeenCalled()
        expect(wx.cloud.uploadFile.mock.calls[0][0].filePath).toBe('/tmp/garment-compressed.jpg')
        expect(callsOfAction('createTask').length).toBe(1)
      })
    })
  })
})

describe('garment 页：服务端四类拦截（AC-24，创建任务 0 次）', function () {
  var cases = [
    { code: 3008, label: '多件' },
    { code: 3009, label: '模特上身' },
    { code: 3010, label: '吊牌' },
    { code: 3011, label: '电商图' }
  ]

  cases.forEach(function (item) {
    test('拦截 ' + item.label + '：提示重拍、createTask 0 次、不跳转', function () {
      precheckResult = { pass: false, status: 'fail', code: item.code, name: 'E_PRECHECK', message: api.PRECHECK_MESSAGES[item.code], checks: [] }
      return prepare().then(function (page) {
        return page.onStart().then(function () {
          expect(callsOfAction('createTask').length).toBe(0)
          expect(wx.navigateTo).not.toHaveBeenCalled()
          expect(page.data.errorText).toContain(api.PRECHECK_MESSAGES[item.code])
          expect(page.data.errorText).toContain('仅接受自家衣服平铺/挂拍、单件完整展示')
          expect(page.data.submitting).toBe(false)
        })
      })
    })
  })
})

describe('garment 页：createTask 成功与失败', function () {
  test('预检通过后 createTask 一次，携带草稿 metrics 并跳 generating', function () {
    return prepare().then(function (page) {
      return page.onStart().then(function () {
        var createCalls = callsOfAction('createTask')
        expect(createCalls.length).toBe(1)
        expect(createCalls[0].garmentAssetId).toBe('a_garment_1')
        expect(createCalls[0].personAssetIds).toEqual(['a_person_1'])
        expect(createCalls[0].metrics).toEqual({ heightCm: 175, weightKg: 70.5, gender: 'unspecified' })
        expect(wx.navigateTo).toHaveBeenCalledTimes(1)
        expect(wx.navigateTo.mock.calls[0][0].url).toBe('/pages/generating/generating?taskId=t_1')
        expect(appMock.globalData.captureDraft).toBeNull()
        // AC-7 埋点：仅内存记录计时起点，不写 Storage、不含照片信息。
        expect(appMock.globalData.ac7Timing).toEqual({
          requestId: 'req-createTask',
          taskId: 't_1',
          createdAt: 1
        })
        expect(wx.setStorageSync).not.toHaveBeenCalled()
      })
    })
  })

  test('额度用尽失败后展示文案；重试复用同一 clientReqId（幂等）', function () {
    createTaskResult = { ok: false, code: 2001, name: 'E_QUOTA_EXHAUSTED', message: '今日额度已用完，明日 00:00 重置' }
    return prepare().then(function (page) {
      return page
        .onStart()
        .then(function () {
          expect(page.data.errorText).toContain('额度')
          expect(page.data.submitting).toBe(false)
          createTaskResult = { ok: true, taskId: 't_1' }
          return page.onStart()
        })
        .then(function () {
          var createCalls = callsOfAction('createTask')
          expect(createCalls.length).toBe(2)
          expect(createCalls[0].clientReqId).toBe(createCalls[1].clientReqId)
          expect(wx.navigateTo).toHaveBeenCalledTimes(1)
        })
    })
  })

  test('E_ACTIVE_TASK_EXISTS 时 profile 恢复 activeTaskId 并跳转', function () {
    createTaskResult = { ok: false, code: 2002, name: 'E_ACTIVE_TASK_EXISTS', message: '已有进行中的生成任务' }
    return prepare().then(function (page) {
      return page
        .onStart()
        .then(function () {
          return flush()
        })
        .then(function () {
          expect(wx.navigateTo).toHaveBeenCalledTimes(1)
          expect(wx.navigateTo.mock.calls[0][0].url).toBe('/pages/generating/generating?taskId=t_2')
          expect(callsOfAction('profile').length).toBeGreaterThan(0)
        })
    })
  })
})
