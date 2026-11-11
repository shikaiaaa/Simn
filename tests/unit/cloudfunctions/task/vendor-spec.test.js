/**
 * tests/unit/cloudfunctions/task/vendor-spec.test.js
 * SPEC v0.11 §B.2/§B.4（task-69）：
 * - 3015 E_PRECHECK_VENDOR_LIMIT 语义（登记即拒 / 提交前拒，不登记、不建任务、不扣额度、不提交供应商）
 * - 50411/50412/50413 参数类错误映射到 3015，不得兜底 5001
 * - sinn_tasks.failure 持久化形状（code/name/hint/vendorCode/httpStatus/at，脱敏）
 */
'use strict'

var errors = require('../../../../cloudfunctions/sinn-task/lib/errors')
var util = require('../../../../cloudfunctions/sinn-task/lib/util')
var volcengine = require('../../../../cloudfunctions/sinn-task/lib/vendor/volcengine-vendor')
var createVendorAdapter = require('../../../../cloudfunctions/sinn-task/lib/vendor').createVendorAdapter
var fixtures = require('./fixtures')

var USER = fixtures.USER
var IDS = fixtures.IDS

var CREDS = { SINN_VOLC_AK: 'ak-test', SINN_VOLC_SK: 'sk-test', SINN_VOLC_REGION: 'cn-north-1' }
var SILENT_LOGGER = { log: function () {}, warn: function () {}, error: function () {} }
var DEFAULT_METRICS = { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 }
var MB = 1024 * 1024

function newUuid() {
  return util.newRequestId()
}

async function withConsentUser(options) {
  options = options || {}
  var ctx = fixtures.makeContext(options)
  await fixtures.seedConsentUser(ctx.store, USER)
  return ctx
}

async function injectAsset(ctx, options) {
  options = options || {}
  var asset = await fixtures.seedAsset(ctx.store, {
    openid: USER,
    kind: options.kind || 'PERSON',
    fileID: options.fileID,
    clientReqId: options.clientReqId || newUuid()
  })
  var patch = {}
  if (options.bytes !== undefined) patch.bytes = options.bytes
  if (options.width !== undefined) patch.width = options.width
  if (options.height !== undefined) patch.height = options.height
  if (options.mime !== undefined) patch.mime = options.mime
  if (Object.keys(patch).length) {
    asset = await ctx.store.updateAsset(asset.assetId, patch)
  }
  return asset
}

async function seedTaskAssets(ctx, options) {
  options = options || {}
  var person = await injectAsset(ctx, {
    kind: 'PERSON',
    fileID: IDS.person1,
    bytes: options.personBytes === undefined ? 2 * MB : options.personBytes,
    width: options.personWidth === undefined ? 1000 : options.personWidth,
    height: options.personHeight === undefined ? 1500 : options.personHeight,
    mime: options.personMime
  })
  var garment = await injectAsset(ctx, {
    kind: 'GARMENT',
    fileID: IDS.garment,
    bytes: options.garmentBytes === undefined ? 1 * MB : options.garmentBytes,
    width: options.garmentWidth === undefined ? 1000 : options.garmentWidth,
    height: options.garmentHeight === undefined ? 1200 : options.garmentHeight,
    mime: options.garmentMime
  })
  return { person: person, garment: garment }
}

function adapterWithTransport(transport) {
  return volcengine.createVolcengineVendorAdapter(CREDS, {
    transport: transport,
    timeoutMs: 100,
    logger: SILENT_LOGGER
  })
}

describe('3015 错误码定义（SPEC v0.11 §B.2）', function () {
  test('E_PRECHECK_VENDOR_LIMIT：业务码、httpStatus 200、文案可读', function () {
    var meta = errors.getMeta(3015)
    expect(meta.name).toBe('E_PRECHECK_VENDOR_LIMIT')
    expect(meta.httpStatus).toBe(200)
    expect(meta.message).toContain('生成服务规格')
  })

  test('util 暴露供应商规格常量（≤5MB、长边 ≤4096、JPEG）', function () {
    expect(util.VENDOR_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(util.VENDOR_MAX_LONG_SIDE).toBe(4096)
    expect(util.VENDOR_MIME).toBe('image/jpeg')
  })
})

describe('assetRegister 登记即拒（3015，不落库）', function () {
  var cases = [
    { label: '>5MB', payload: { bytes: 6 * MB, width: 2000, height: 3000 }, reason: /5MB/ },
    { label: '长边 >4096', payload: { bytes: 1 * MB, width: 5000, height: 3000 }, reason: /4096/ },
    { label: '非 JPEG', payload: { bytes: 1 * MB, width: 2000, height: 3000, mime: 'image/png' }, reason: /5MB|4096/ }
  ]

  cases.forEach(function (item) {
    test(item.label + '：3015 且不登记资产', async function () {
      var ctx = await withConsentUser()
      var payload = Object.assign(
        {
          clientReqId: newUuid(),
          kind: 'PERSON',
          fileID: IDS.person1,
          mime: 'image/jpeg'
        },
        item.payload
      )
      var res = await ctx.call('assetRegister', payload)
      expect(res.ok).toBe(false)
      expect(res.error.code).toBe(3015)
      expect(res.error.name).toBe('E_PRECHECK_VENDOR_LIMIT')
      expect(res.error.httpStatus).toBe(200)
      expect(res.error.hint).toMatch(item.reason)
      expect(ctx.store.__countAssets()).toBe(0)
    })
  })

  test('合规资产（JPEG/4MB/3000px）登记成功', async function () {
    var ctx = await withConsentUser()
    var res = await ctx.call('assetRegister', {
      clientReqId: newUuid(),
      kind: 'PERSON',
      fileID: IDS.person1,
      mime: 'image/jpeg',
      bytes: 4 * MB,
      width: 3000,
      height: 4000
    })
    expect(res.ok).toBe(true)
    expect(res.data.assetId).toMatch(/^a_/)
    expect(ctx.store.__countAssets()).toBe(1)
  })
})

describe('createTask 提交前规格防御（3015，不建任务/不扣额度/不提交供应商）', function () {
  test('资产超 5MB：3015、task 0、额度未扣、vendor.submit 0 次', async function () {
    var ctx = await withConsentUser()
    var assets = await seedTaskAssets(ctx, { personBytes: 6 * MB })
    var submitSpy = jest.spyOn(ctx.vendor, 'submit')
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(3015)
    expect(ctx.store.__countTasks()).toBe(0)
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
    expect(submitSpy).not.toHaveBeenCalled()
  })

  test('资产长边 >4096：3015 且不建任务', async function () {
    var ctx = await withConsentUser()
    var assets = await seedTaskAssets(ctx, { garmentWidth: 5000, garmentHeight: 3000 })
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(3015)
    expect(ctx.store.__countTasks()).toBe(0)
  })
})

describe('供应商参数类错误映射（50411/50412/50413 -> 3015）', function () {
  test('classifyVendorCode：50411/50412/50413 -> 3015；鉴权/限流仍 5001', function () {
    expect(volcengine.classifyVendorCode('50411', 400).code).toBe(3015)
    expect(volcengine.classifyVendorCode('50412', 400).code).toBe(3015)
    expect(volcengine.classifyVendorCode('50413', 400).code).toBe(3015)
    expect(volcengine.classifyVendorCode('InvalidCredential', 401).code).toBe(5001)
    expect(volcengine.classifyVendorCode('RateLimitExceeded', 429).code).toBe(5001)
  })

  test('mapFailedStateCode：参数类映射为 precheck_vendor_limit', function () {
    expect(volcengine.mapFailedStateCode('50411', 400)).toBe('precheck_vendor_limit')
    expect(volcengine.mapFailedStateCode('ContentRiskDetected', 200)).toBe('content_blocked')
    expect(volcengine.mapFailedStateCode('WeirdFailure', 500)).toBe('vendor_generation_failed')
  })

  test('submit 收到 50411 → AppError 3015（不得 5001），detail 带脱敏 vendorCode/httpStatus', async function () {
    var adapter = adapterWithTransport({
      submit: function () {
        return Promise.resolve({ errorCode: '50411', httpStatus: 400, errorMessage: 'Pre Img Risk' })
      }
    })
    var error = null
    try {
      await adapter.submit({ personBuffers: [Buffer.from('a')], garmentBuffer: Buffer.from('b'), metrics: {} })
    } catch (err) {
      error = err
    }
    expect(error).not.toBeNull()
    expect(error.code).toBe(3015)
    expect(error.name).toBe('E_PRECHECK_VENDOR_LIMIT')
    expect(error.detail.vendorCode).toBe('50411')
    expect(error.detail.httpStatus).toBe(400)
  })

  test('createTask 供应商返回 50411：任务 FAILED，failure 落库 3015 + vendorCode/httpStatus，额度返还', async function () {
    var transportVendor = adapterWithTransport({
      submit: function () {
        return Promise.resolve({ errorCode: '50411', httpStatus: 400, errorMessage: 'Pre Img Risk' })
      }
    })
    var ctx = await withConsentUser({ vendor: transportVendor })
    var assets = await seedTaskAssets(ctx)
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(3015)
    expect(res.error.name).toBe('E_PRECHECK_VENDOR_LIMIT')

    var tasks = await ctx.store.listTasksByOpenid(USER)
    expect(tasks.length).toBe(1)
    expect(tasks[0].status).toBe('FAILED')
    expect(tasks[0].failureCode).toBe(3015)
    expect(tasks[0].quotaRefunded).toBe(true)
    expect(tasks[0].failure).toEqual(
      expect.objectContaining({
        code: 3015,
        name: 'E_PRECHECK_VENDOR_LIMIT',
        vendorCode: '50411',
        httpStatus: 400
      })
    )
    expect(tasks[0].failure.hint).toContain('供应商')
    expect(typeof tasks[0].failure.at).toBe('number')
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
  })
})

describe('sinn_tasks.failure 持久化形状（§B.4）', function () {
  test('供应商通用失败（5001）：failure 含 code/name/hint/at，且不含图片内容', async function () {
    var ctx = await withConsentUser({ scenario: 'submit_error' })
    var assets = await seedTaskAssets(ctx)
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(5001)

    var tasks = await ctx.store.listTasksByOpenid(USER)
    expect(tasks.length).toBe(1)
    var failure = tasks[0].failure
    expect(failure).toEqual(
      expect.objectContaining({
        code: 5001,
        name: 'E_VENDOR_UNAVAILABLE',
        vendorCode: null,
        httpStatus: null
      })
    )
    expect(typeof failure.hint).toBe('string')
    expect(typeof failure.at).toBe('number')
    var serialized = JSON.stringify(failure)
    expect(serialized).not.toMatch(/base64|cloud:\/\/|data:image/i)
  })

  test('taskGet 失败视图透出 failure 基础字段（code/name/message/hint）', async function () {
    var ctx = await withConsentUser({ scenario: 'submit_error' })
    var assets = await seedTaskAssets(ctx)
    await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    var tasks = await ctx.store.listTasksByOpenid(USER)
    var view = await ctx.call('taskGet', { taskId: tasks[0].taskId })
    expect(view.ok).toBe(true)
    expect(view.data.status).toBe('FAILED')
    expect(view.data.failure.code).toBe(5001)
    expect(view.data.failure.name).toBe('E_VENDOR_UNAVAILABLE')
    expect(view.data.failure.message).toContain('生成服务暂时不可用')
  })
})

describe('mock 适配器行为不回归', function () {
  test('默认 mock 供应商仍可创建任务并成功', async function () {
    var ctx = await withConsentUser()
    var assets = await seedTaskAssets(ctx)
    var created = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [assets.person.assetId],
      garmentAssetId: assets.garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(created.ok).toBe(true)
    var polled = await ctx.call('taskGet', { taskId: created.data.taskId })
    expect(polled.ok).toBe(true)
    expect(['QUEUED', 'GENERATING', 'SUCCEEDED']).toContain(polled.data.status)
  })

  test('默认 mock 供应商实例仍能创建（fixtures 未改动）', function () {
    var vendor = createVendorAdapter({ SINN_VENDOR: 'mock' })
    expect(vendor.provider).toBe('mock')
  })
})
