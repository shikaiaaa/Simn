/**
 * tests/unit/pages/capture/upload.test.js
 * 覆盖：上传 + assetRegister（同 clientReqId 幂等重试、不重复资产、失败可重试）。
 */
'use strict'

var upload = require('../../../../miniprogram/services/upload')

var CONSENT = JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 1 })
var CLIENT_REQ_ID = '11111111-1111-4111-8111-111111111111'
var NOW = new Date(2026, 10, 9, 12, 0, 0).getTime()
var FILE_ID = 'cloud://mock-env/sinn/person/x.jpg'

function assetRegisterEnvelope(overrides) {
  var data = Object.assign({ assetId: 'a_1', kind: 'PERSON', purgeAt: 123 }, overrides || {})
  return { result: { ok: true, data: data, error: null, requestId: 'req-upload', serverTime: 1 } }
}

beforeEach(function () {
  wx.__reset()
  wx.getStorageSync = jest.fn(function () {
    return CONSENT
  })
  wx.setStorageSync = jest.fn()
  wx.cloud.uploadFile = jest.fn(function () {
    return Promise.resolve({ fileID: FILE_ID })
  })
  wx.cloud.callFunction = jest.fn(function () {
    return Promise.resolve(assetRegisterEnvelope())
  })
})

describe('services/upload.js', function () {
  test('上传成功后 assetRegister 返回 assetId/purgeAt', function () {
    return upload
      .uploadPersonPhoto({
        wxRef: wx,
        clientReqId: CLIENT_REQ_ID,
        filePath: '/tmp/person.jpg',
        mime: 'image/jpeg',
        bytes: 100,
        width: 1080,
        height: 1920,
        now: NOW
      })
      .then(function (result) {
        expect(result.ok).toBe(true)
        expect(result.assetId).toBe('a_1')
        expect(result.fileID).toBe(FILE_ID)
        expect(result.clientReqId).toBe(CLIENT_REQ_ID)
        expect(result.cloudPath).toBe('sinn/person/' + upload.datePath(NOW) + '/' + CLIENT_REQ_ID + '.jpg')
        expect(result.requestId).toBe('req-upload')
        expect(wx.cloud.uploadFile).toHaveBeenCalledTimes(1)
        expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
      })
  })

  test('重试复用同一 clientReqId：cloudPath 相同、assetRegister 参数相同', function () {
    var options = {
      wxRef: wx,
      clientReqId: CLIENT_REQ_ID,
      filePath: '/tmp/person.jpg',
      mime: 'image/jpeg',
      bytes: 100,
      width: 1080,
      height: 1920,
      now: NOW
    }
    return upload
      .uploadPersonPhoto(options)
      .then(function () {
        return upload.uploadPersonPhoto(options)
      })
      .then(function (second) {
        expect(second.ok).toBe(true)
        expect(wx.cloud.uploadFile).toHaveBeenCalledTimes(2)
        var firstPath = wx.cloud.uploadFile.mock.calls[0][0].cloudPath
        var secondPath = wx.cloud.uploadFile.mock.calls[1][0].cloudPath
        expect(firstPath).toBe(secondPath)
        var first = wx.cloud.callFunction.mock.calls[0][0].data
        var secondCall = wx.cloud.callFunction.mock.calls[1][0].data
        expect(first.clientReqId).toBe(secondCall.clientReqId)
        expect(first.clientReqId).toBe(CLIENT_REQ_ID)
      })
  })

  test('未提供合法 clientReqId 时自动生成 UUID v4', function () {
    return upload
      .uploadPersonPhoto({ wxRef: wx, filePath: '/tmp/person.jpg', bytes: 100, width: 1080, height: 1920, now: NOW })
      .then(function (result) {
        expect(result.ok).toBe(true)
        expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.clientReqId)).toBe(true)
      })
  })

  test('assetRegister 业务失败不抛异常，返回 ok:false（页面可重试）', function () {
    wx.cloud.callFunction = jest.fn(function () {
      return Promise.resolve({
        result: {
          ok: false,
          data: null,
          error: { code: 1003, name: 'E_CONSENT_REQUIRED', message: '请先阅读并同意隐私说明', hint: '', httpStatus: 403 },
          requestId: 'req-fail',
          serverTime: 1
        }
      })
    })
    return upload
      .uploadPersonPhoto({ wxRef: wx, clientReqId: CLIENT_REQ_ID, filePath: '/tmp/person.jpg', bytes: 100, width: 1080, height: 1920, now: NOW })
      .then(function (result) {
        expect(result.ok).toBe(false)
        expect(result.code).toBe(1003)
        expect(result.message).toContain('同意')
        expect(result.clientReqId).toBe(CLIENT_REQ_ID)
      })
  })

  test('上传失败（网络异常）返回 E_UPLOAD_FAILED', function () {
    wx.cloud.uploadFile = jest.fn(function () {
      return Promise.reject({ errMsg: 'uploadFile:fail network' })
    })
    return upload
      .uploadPersonPhoto({ wxRef: wx, clientReqId: CLIENT_REQ_ID, filePath: '/tmp/person.jpg', bytes: 100, width: 1080, height: 1920, now: NOW })
      .then(function (result) {
        expect(result.ok).toBe(false)
        expect(result.code).toBe(5006)
        expect(result.name).toBe('E_UPLOAD_FAILED')
      })
  })

  test('上传未返回 fileID 视为失败', function () {
    wx.cloud.uploadFile = jest.fn(function () {
      return Promise.resolve({})
    })
    return upload
      .uploadPersonPhoto({ wxRef: wx, clientReqId: CLIENT_REQ_ID, filePath: '/tmp/person.jpg', bytes: 100, width: 1080, height: 1920, now: NOW })
      .then(function (result) {
        expect(result.ok).toBe(false)
        expect(result.code).toBe(5006)
        expect(wx.cloud.callFunction).not.toHaveBeenCalled()
      })
  })

  test('garment 上传走 sinn/garment 路径并传 kind=GARMENT', function () {
    return upload
      .uploadGarmentPhoto({
        wxRef: wx,
        clientReqId: CLIENT_REQ_ID,
        filePath: '/tmp/garment.jpg',
        mime: 'image/jpeg',
        bytes: 100,
        width: 1080,
        height: 1440,
        now: NOW
      })
      .then(function (result) {
        expect(result.ok).toBe(true)
        expect(result.cloudPath).toBe('sinn/garment/' + upload.datePath(NOW) + '/' + CLIENT_REQ_ID + '.jpg')
        expect(wx.cloud.callFunction.mock.calls[0][0].data.kind).toBe('GARMENT')
      })
  })

  test('缺少照片路径直接失败且不上传', function () {
    return upload.uploadPersonPhoto({ wxRef: wx, clientReqId: CLIENT_REQ_ID, now: NOW }).then(function (result) {
      expect(result.ok).toBe(false)
      expect(result.code).toBe(1001)
      expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
    })
  })

  test('上传前二次断言：>5MB -> 5007 且不调用 uploadFile（AC-29 ③）', function () {
    return upload
      .uploadPersonPhoto({
        wxRef: wx,
        clientReqId: CLIENT_REQ_ID,
        filePath: '/tmp/person.jpg',
        mime: 'image/jpeg',
        bytes: 6 * 1024 * 1024,
        width: 1080,
        height: 1920,
        now: NOW
      })
      .then(function (result) {
        expect(result.ok).toBe(false)
        expect(result.code).toBe(5007)
        expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
        expect(wx.cloud.callFunction).not.toHaveBeenCalled()
      })
  })

  test('上传前二次断言：长边 >4096 或非 JPG -> 5007 且不上传（AC-29 ③）', function () {
    return upload
      .uploadPersonPhoto({
        wxRef: wx,
        clientReqId: CLIENT_REQ_ID,
        filePath: '/tmp/person.jpg',
        mime: 'image/jpeg',
        bytes: 1024,
        width: 5000,
        height: 3000,
        now: NOW
      })
      .then(function (wide) {
        expect(wide.ok).toBe(false)
        expect(wide.code).toBe(5007)
        return upload.uploadGarmentPhoto({
          wxRef: wx,
          clientReqId: CLIENT_REQ_ID,
          filePath: '/tmp/garment.png',
          mime: 'image/png',
          bytes: 1024,
          width: 1080,
          height: 1440,
          now: NOW
        })
      })
      .then(function (png) {
        expect(png.ok).toBe(false)
        expect(png.code).toBe(5007)
        expect(wx.cloud.uploadFile).not.toHaveBeenCalled()
      })
  })
})
