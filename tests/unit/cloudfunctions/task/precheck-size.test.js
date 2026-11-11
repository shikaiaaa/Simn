/**
 * tests/unit/cloudfunctions/task/precheck-size.test.js
 * SPEC v0.8 F-17：服务端兜底 — 资产长边 <1024 或 >4096 时 precheck 返回 3014，
 * 不调用供应商预检适配器、不创建任务（AC-27 ③）。
 */
'use strict'

var fixtures = require('./fixtures')
var errors = require('../../../../cloudfunctions/sinn-task/lib/errors')

function precheckCalls(ctx) {
  return typeof ctx.precheck.__calls === 'function' ? ctx.precheck.__calls() : 0
}

function setup(assetOptions) {
  var ctx = fixtures.makeContext()
  fixtures.seedConsentUser(ctx.store, fixtures.USER)
  return fixtures
    .seedAsset(ctx.store, Object.assign({ openid: fixtures.USER, precheckStatus: null }, assetOptions))
    .then(function (asset) {
      return { ctx: ctx, asset: asset }
    })
}

describe('precheck 服务端尺寸兜底（3014）', function () {
  test('长边 800 <1024：返回 3014，不调用预检适配器、不扣额度', function () {
    return setup({ width: 800, height: 800 }).then(function (data) {
      return data.ctx.call('precheck', { assetId: data.asset.assetId }).then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.data.pass).toBe(false)
        expect(res.data.status).toBe('fail')
        expect(res.data.code).toBe(3014)
        expect(res.data.name).toBe('E_PRECHECK_TOO_SMALL')
        expect(res.data.message).toBe('分辨率过低，请重拍')
        expect(res.data.hint).toContain('1024')
        expect(precheckCalls(data.ctx)).toBe(0)
        expect(data.ctx.store.__countTasks()).toBe(0)
      })
    })
  })

  test('长边 5000 >4096：返回 3014 并提示压缩后仍超限', function () {
    return setup({ width: 5000, height: 6000 }).then(function (data) {
      return data.ctx.call('precheck', { assetId: data.asset.assetId }).then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.data.pass).toBe(false)
        expect(res.data.code).toBe(3014)
        expect(res.data.hint).toContain('4096')
        expect(precheckCalls(data.ctx)).toBe(0)
      })
    })
  })

  test('正常尺寸（1024–4096）仍走供应商预检适配器', function () {
    return setup({ width: 1080, height: 1920 }).then(function (data) {
      return data.ctx.call('precheck', { assetId: data.asset.assetId }).then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.data.pass).toBe(true)
        expect(res.data.status).toBe('pass')
        expect(precheckCalls(data.ctx)).toBe(1)
      })
    })
  })

  test('3014 结果写入资产缓存，第二次 precheck 不再调用适配器（10min 缓存）', function () {
    return setup({ width: 800, height: 800 }).then(function (data) {
      return data.ctx
        .call('precheck', { assetId: data.asset.assetId })
        .then(function () {
          return data.ctx.call('precheck', { assetId: data.asset.assetId })
        })
        .then(function (res) {
          expect(res.data.code).toBe(3014)
          expect(precheckCalls(data.ctx)).toBe(0)
          return data.ctx.store.getAsset(data.asset.assetId)
        })
        .then(function (asset) {
          expect(asset.precheck.code).toBe(3014)
          expect(asset.precheck.status).toBe('fail')
        })
    })
  })

  test('错误码表含 3014 与 5007（名称/httpStatus）', function () {
    expect(errors.ERROR_CODES[3014].name).toBe('E_PRECHECK_TOO_SMALL')
    expect(errors.ERROR_CODES[3014].httpStatus).toBe(200)
    expect(errors.ERROR_CODES[5007].name).toBe('E_PHOTO_PROCESS_FAILED')
    expect(errors.ERROR_CODES[5007].httpStatus).toBe(0)
  })
})
