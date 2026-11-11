/**
 * tests/unit/pages/capture/capture-page.test.js
 * 覆盖：consent 门禁（AC-25）、人像 1–3 张增删改、L0 拦截、表单禁用与具体缺失项、
 * 上传失败可重试、服务端预检未过停留本页不跳转、全部通过后携带草稿跳 garment。
 */
'use strict'

var CAPTURED = null
global.Page = function (config) {
  CAPTURED = config
}
require('../../../../miniprogram/pages/capture/capture.js')

var CONSENT = JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 1 })
var CONSENT_NO_AGE = JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 0 })

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

function envelopeFor(data) {
  if (data.action === 'assetRegister') {
    return {
      result: {
        ok: true,
        data: { assetId: 'a_' + String(data.kind || '').toLowerCase() + '_1', kind: data.kind, purgeAt: 1 },
        error: null,
        requestId: 'req-asset',
        serverTime: 1
      }
    }
  }
  if (data.action === 'precheck') {
    return { result: { ok: true, data: { pass: true, status: 'pass', checks: [] }, error: null, requestId: 'req-precheck', serverTime: 1 } }
  }
  return { result: { ok: true, data: {}, error: null, requestId: 'req-other', serverTime: 1 } }
}

var appMock = null

beforeEach(function () {
  wx.__reset()
  wx.getStorageSync = jest.fn(function (key) {
    return key === 'sinn_consent_v1' ? CONSENT : ''
  })
  wx.setStorageSync = jest.fn()
  wx.redirectTo = jest.fn()
  wx.navigateTo = jest.fn()
  wx.chooseMedia = jest.fn(function (options) {
    options.success({ tempFiles: [{ tempFilePath: '/tmp/a.jpg', size: 2 * 1024 * 1024, fileType: 'image/jpeg' }] })
  })
  wx.getImageInfo = jest.fn(function (options) {
    options.success({ width: 1080, height: 1920, orientation: 'up', type: 'jpeg' })
  })
  wx.cloud.uploadFile = jest.fn(function () {
    return Promise.resolve({ fileID: 'cloud://mock-env/sinn/person/a.jpg' })
  })
  wx.cloud.callFunction = jest.fn(function (options) {
    return Promise.resolve(envelopeFor(options.data))
  })
  appMock = { globalData: {} }
  global.getApp = function () {
    return appMock
  }
})

function pickEvent(index) {
  return { currentTarget: { dataset: { index: index } } }
}

function inputEvent(field, value) {
  return { currentTarget: { dataset: { field: field } }, detail: { value: value } }
}

function fillValidForm(page) {
  page.onInputField(inputEvent('heightCm', '175'))
  page.onInputField(inputEvent('weightKg', '70.5'))
  page._refreshCanSubmit()
}

describe('capture 页：同意门禁（AC-25）', function () {
  test('已同意且已确认 18+ 可进入', function () {
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(page.data.canSubmit).toBe(false)
  })

  test('未同意时回 consent 页', function () {
    wx.getStorageSync = jest.fn(function () {
      return ''
    })
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo).toHaveBeenCalled()
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/consent/consent')
  })

  test('有同意记录但 18+ 未确认（ageConfirmedAt=0）仍回 consent 页', function () {
    wx.getStorageSync = jest.fn(function (key) {
      return key === 'sinn_consent_v1' ? CONSENT_NO_AGE : ''
    })
    var page = createPage()
    page.onLoad()
    expect(wx.redirectTo).toHaveBeenCalled()
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/consent/consent')
  })
})

describe('capture 页：照片增删改与 L0', function () {
  test('添加一张照片后进入列表', function () {
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      expect(page.data.photos.length).toBe(1)
      expect(page.data.photos[0].mime).toBe('image/jpeg')
      expect(page.data.errorText).toBe('')
    })
  })

  test('L0 拦截超过 10MB 的照片，不进入列表、不上传', function () {
    wx.chooseMedia = jest.fn(function (options) {
      options.success({ tempFiles: [{ tempFilePath: '/tmp/big.jpg', size: 12 * 1024 * 1024, fileType: 'image/jpeg' }] })
    })
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      expect(page.data.photos.length).toBe(0)
      expect(page.data.errorText).toContain('10MB')
      expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
    })
  })

  test('L0 拦截非 JPG/PNG 格式', function () {
    wx.chooseMedia = jest.fn(function (options) {
      options.success({ tempFiles: [{ tempFilePath: '/tmp/a.webp', size: 1024 * 1024, fileType: 'image/webp' }] })
    })
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      expect(page.data.photos.length).toBe(0)
      expect(page.data.errorText).toContain('JPG / PNG')
    })
  })

  test('重拍替换指定照片，删除后列表减少', function () {
    var page = createPage()
    page.onLoad()
    var sequence = [{ tempFilePath: '/tmp/a.jpg' }, { tempFilePath: '/tmp/b.jpg' }, { tempFilePath: '/tmp/c.jpg' }]
    var call = 0
    wx.chooseMedia = jest.fn(function (options) {
      var file = sequence[call]
      call += 1
      options.success({ tempFiles: [Object.assign({ size: 1024 * 1024, fileType: 'image/jpeg' }, file) ] })
    })
    return page
      .onPickPhoto(pickEvent(-1))
      .then(function () {
        return page.onPickPhoto(pickEvent(-1))
      })
      .then(function () {
        expect(page.data.photos.length).toBe(2)
        return page.onPickPhoto(pickEvent(0))
      })
      .then(function () {
        expect(page.data.photos.length).toBe(2)
        expect(page.data.photos[0].path).toBe('/tmp/c.jpg')
        page.onRemovePhoto(pickEvent(1))
        expect(page.data.photos.length).toBe(1)
      })
  })
})

describe('capture 页：表单校验与按钮禁用（AC-1/26）', function () {
  test('缺照片/缺数值时 canSubmit=false 且给出具体缺失项', function () {
    var page = createPage()
    page.onLoad()
    expect(page.data.canSubmit).toBe(false)
    expect(page.data.formErrors.length).toBeGreaterThan(0)
  })

  test('完整表单 canSubmit=true；性别默认 unspecified；越界身高禁用', function () {
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      fillValidForm(page)
      expect(page.data.canSubmit).toBe(true)
      expect(page.data.gender).toBe('unspecified')
      page.onInputField(inputEvent('heightCm', '999'))
      expect(page.data.canSubmit).toBe(false)
      expect(page.data.formErrors.map(function (e) { return e.code })).toContain('HEIGHT_RANGE')
    })
  })

  test('性别可切换为 male/female 且不阻塞提交', function () {
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      page.onSelectGender({ currentTarget: { dataset: { value: 'male' } } })
      expect(page.data.gender).toBe('male')
      fillValidForm(page)
      expect(page.data.canSubmit).toBe(true)
    })
  })
})

describe('capture 页：上传 + 服务端预检 + 跳转', function () {
  function prepare() {
    var page = createPage()
    page.onLoad()
    return page.onPickPhoto(pickEvent(-1)).then(function () {
      fillValidForm(page)
      return page
    })
  }

  test('全部通过：上传一次、预检一次、跳 garment 并携带 personAssetIds/metrics', function () {
    return prepare().then(function (page) {
      return page.onNext().then(function () {
        expect(wx.cloud.uploadFile).toHaveBeenCalledTimes(1)
        var calls = wx.cloud.callFunction.mock.calls.map(function (c) {
          return c[0].data
        })
        expect(calls.filter(function (d) { return d.action === 'assetRegister' }).length).toBe(1)
        expect(calls.filter(function (d) { return d.action === 'precheck' }).length).toBe(1)
        expect(wx.navigateTo).toHaveBeenCalledTimes(1)
        expect(wx.navigateTo.mock.calls[0][0].url).toBe('/pages/garment/garment')
        expect(appMock.globalData.captureDraft.personAssetIds.length).toBe(1)
        expect(appMock.globalData.captureDraft.metrics.heightCm).toBe(175)
        expect(appMock.globalData.captureDraft.metrics.weightKg).toBe(70.5)
        expect(appMock.globalData.captureDraft.metrics.gender).toBe('unspecified')
        expect(wx.setStorageSync).not.toHaveBeenCalled()
      })
    })
  })

  test('服务端预检未过：停留 capture、给出全身重拍建议、不跳转', function () {
    wx.cloud.callFunction = jest.fn(function (options) {
      if (options.data.action === 'precheck') {
        return Promise.resolve({
          result: {
            ok: true,
            data: {
              pass: false,
              status: 'fail',
              code: 3002,
              name: 'E_PRECHECK_FULL_BODY',
              message: '照片未拍到全身（含脚部），请重新拍摄',
              hint: '请拍到脚部',
              checks: []
            },
            error: null,
            requestId: 'req-pc',
            serverTime: 1
          }
        })
      }
      return Promise.resolve(envelopeFor(options.data))
    })
    return prepare().then(function (page) {
      return page.onNext().then(function () {
        expect(wx.navigateTo).not.toHaveBeenCalled()
        expect(page.data.errorText).toContain('全身')
        expect(page.data.photos[0].status).toBe('precheck_failed')
        expect(page.data.submitting).toBe(false)
        expect(appMock.globalData.captureDraft).toBeUndefined()
      })
    })
  })

  test('上传失败：错误可见、不跳转，可再次提交重试（同 clientReqId）', function () {
    return prepare().then(function (page) {
      wx.cloud.uploadFile = jest
        .fn()
        .mockReturnValueOnce(Promise.reject({ errMsg: 'network' }))
        .mockReturnValueOnce(Promise.resolve({ fileID: 'cloud://mock-env/sinn/person/a.jpg' }))
      return page
        .onNext()
        .then(function () {
          expect(page.data.errorText).toContain('上传失败')
          expect(wx.navigateTo).not.toHaveBeenCalled()
          return page.onNext()
        })
        .then(function () {
          expect(wx.navigateTo).toHaveBeenCalledTimes(1)
          var uploadCalls = wx.cloud.uploadFile.mock.calls
          expect(uploadCalls.length).toBe(2)
          expect(uploadCalls[0][0].cloudPath).toBe(uploadCalls[1][0].cloudPath)
        })
    })
  })

  test('未通过表单校验时 onNext 不上传、不跳转', function () {
    var page = createPage()
    page.onLoad()
    return page.onNext().then(function () {
      expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
      expect(wx.navigateTo).not.toHaveBeenCalled()
      expect(page.data.errorText.length).toBeGreaterThan(0)
    })
  })
})
