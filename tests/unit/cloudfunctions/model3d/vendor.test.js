/**
 * tests/unit/cloudfunctions/model3d/vendor.test.js —— Model3dVendorAdapter 契约 / mock / tripo 映射。
 * 全部离线：tripo 注入 requestFn/fetchFn，不发起真实网络请求。
 */
'use strict'

var createAdapter = require('../../../../cloudfunctions/sinn-model3d/lib/vendor').createModel3dVendorAdapter
var createMock = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/mock-model3d-vendor').createMockModel3dVendorAdapter
var buildMockGlb = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/mock-model3d-vendor').buildMockGlb
var createTripo = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/tripo-model3d-vendor').createTripoModel3dVendorAdapter
var contract = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/model3d-contract')
var glb = require('../../../../cloudfunctions/sinn-model3d/lib/glb')
var errors = require('../../../../cloudfunctions/sinn-model3d/lib/errors')

function expectCode(fn, code) {
  var caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).not.toBeNull()
  expect(caught.code).toBe(code)
}

function makeClock(start) {
  var current = start || 1794444000000
  return { now: function () { return current }, advance: function (ms) { current += ms; return current } }
}

function tripoFixture(options) {
  options = options || {}
  var clock = options.clock || makeClock()
  var requests = []
  var fetches = []
  var requestFn = function (params) {
    requests.push(params)
    var handler = options.onRequest ? options.onRequest(params, requests.length - 1) : null
    if (handler) return handler
    return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: { task_id: 'task-abc' } }) })
  }
  var fetchFn = function (params) {
    fetches.push(params)
    if (options.onFetch) return options.onFetch(params, fetches.length - 1)
    return Promise.resolve({ statusCode: 200, buffer: buildMockGlb() })
  }
  var adapter = createTripo(
    Object.assign({ SINN_TRIPO_API_KEY: 'sk-test-key' }, options.env || {}),
    { now: clock.now, requestFn: requestFn, fetchFn: fetchFn }
  )
  return { adapter: adapter, requests: requests, fetches: fetches, clock: clock }
}

describe('Model3dVendorAdapter 契约与工厂', function () {
  test('工厂：默认 mock；未知 provider → 9000；未接入候选 → 6001 且 health.ok=false', async function () {
    var mockAdapter = createAdapter({}, {})
    expect(mockAdapter.provider).toBe('mock')
    expect(contract.MODEL3D_VENDOR_METHODS.every(function (m) { return typeof mockAdapter[m] === 'function' })).toBe(true)

    expectCode(function () { createAdapter({ SINN_VENDOR_3D: 'unknown-provider' }, {}) }, 9000)

    var tencent = createAdapter({ SINN_VENDOR_3D: 'tencenthunyuan' }, {})
    expect(tencent.provider).toBe('tencenthunyuan')
    await expect(tencent.submit({})).rejects.toMatchObject({ code: 6001 })
    await expect(tencent.health()).resolves.toMatchObject({ ok: false })
  })

  test('契约缺方法 → 9000', function () {
    expectCode(function () { contract.assertModel3dVendorContract({ submit: function () {} }) }, 9000)
  })
})

describe('mock 供应商', function () {
  test('无状态 vendorJobId：跨适配器实例可解码/查询', async function () {
    var clock = makeClock()
    var a = createMock({ now: clock.now, delayMs: 1000 })
    var submission = await a.submit({ personUrls: ['https://x/person.jpg'] })
    expect(submission.vendorJobId).toMatch(/^mock3d_/)
    var b = createMock({ now: clock.now, delayMs: 1000 })
    var pending = await b.query({ vendorJobId: submission.vendorJobId })
    expect(pending.status).toBe('PENDING')
    clock.advance(1000)
    var done = await b.query({ vendorJobId: submission.vendorJobId })
    expect(done.status).toBe('SUCCEEDED')
    expect(done.assetUrl).toContain('mock://')
    var asset = await b.fetchAsset({ vendorJobId: submission.vendorJobId })
    expect(Buffer.isBuffer(asset.buffer)).toBe(true)
    var meta = glb.parseGlb(asset.buffer)
    expect(meta.nodeCount).toBe(1)
    expect(meta.meshCount).toBe(1)
  })

  test('缺 personUrls → 6001；畸形 vendorJobId → 6002；未来时间戳不解析', async function () {
    var mockAdapter = createMock({ delayMs: 1000 })
    await expect(mockAdapter.submit({ personUrls: [] })).rejects.toMatchObject({ code: 6001 })
    await expect(mockAdapter.query({ vendorJobId: 'mock3d_@@@_1' })).rejects.toMatchObject({ code: 6002 })
    var future = 'mock3d_' + (Date.now() + 3600 * 1000).toString(36) + '_1'
    await expect(mockAdapter.query({ vendorJobId: future })).rejects.toMatchObject({ code: 6002 })
  })

  test('失败/超时/corrupt 场景', async function () {
    var clock = makeClock()
    var failed = createMock({ now: clock.now, delayMs: 1000, fail: 'fail' })
    var submission = await failed.submit({ personUrls: ['https://x/p.jpg'] })
    clock.advance(1001)
    var failedState = await failed.query({ vendorJobId: submission.vendorJobId })
    expect(failedState.status).toBe('FAILED')
    expect(failedState.failureCode).toBe('vendor_generation_failed')

    var timeout = createMock({ now: clock.now, delayMs: 1000, fail: 'timeout' })
    var t2 = await timeout.submit({ personUrls: ['https://x/p.jpg'] })
    clock.advance(5000)
    expect((await timeout.query({ vendorJobId: t2.vendorJobId })).status).toBe('BUILDING')

    var corrupt = createMock({ now: clock.now, delayMs: 1000, fail: 'corrupt' })
    var c = await corrupt.submit({ personUrls: ['https://x/p.jpg'] })
    var asset = await corrupt.fetchAsset({ vendorJobId: c.vendorJobId })
    expect(asset.buffer.toString('utf8')).toBe('not-a-glb-file')
  })

  test('health / cancel / erase', async function () {
    var mockAdapter = createMock({})
    await expect(mockAdapter.health()).resolves.toMatchObject({ ok: true, provider: 'mock' })
    await expect(mockAdapter.cancel()).resolves.toEqual({ unsupported: true })
    await expect(mockAdapter.erase()).resolves.toEqual({ unsupported: true })
  })
})

describe('tripo 适配器（离线注入）', function () {
  test('缺凭证：configured=false，submit/query 6001，health.ok=false', async function () {
    var adapter = createTripo({}, {})
    expect(adapter.configured).toBe(false)
    await expect(adapter.submit({ personUrls: ['https://x/p.jpg'] })).rejects.toMatchObject({ code: 6001 })
    await expect(adapter.health()).resolves.toMatchObject({ ok: false, configured: false })
  })

  test('submit 组装正确请求并解析 task_id', async function () {
    var fixture = tripoFixture()
    var submission = await fixture.adapter.submit({ personUrls: ['https://x/person.jpg'], textureQuality: 'detailed' })
    expect(submission).toMatchObject({ vendorJobId: 'task-abc', provider: 'tripo' })
    var req = fixture.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toContain('3d-generation')
    expect(req.headers.Authorization).toBe('Bearer sk-test-key')
    expect(req.headers['X-DashScope-Async']).toBe('enable')
    var body = JSON.parse(req.body)
    expect(body.model).toBe('Tripo/Tripo-H3.1')
    expect(body.input.image).toBe('https://x/person.jpg')
    expect(body.parameters.texture_quality).toBe('detailed')
  })

  test('submit 响应缺 task_id → 6002；非 2xx → 6001', async function () {
    var missing = tripoFixture({ onRequest: function () { return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: {} }) }) } })
    await expect(missing.adapter.submit({ personUrls: ['https://x/p.jpg'] })).rejects.toMatchObject({ code: 6002 })
    var failed = tripoFixture({ onRequest: function () { return Promise.resolve({ statusCode: 500, body: 'oops' }) } })
    await expect(failed.adapter.submit({ personUrls: ['https://x/p.jpg'] })).rejects.toMatchObject({ code: 6001 })
  })

  test('query 状态映射：PENDING/RUNNING/TEXTURING/SUCCEEDED/FAILED/CANCELED/UNKNOWN', async function () {
    var states = [
      ['PENDING', 'PENDING'],
      ['RUNNING', 'BUILDING'],
      ['TEXTURING', 'TEXTURING'],
      ['CANCELED', 'CANCELLED'],
      ['UNKNOWN', 'PENDING']
    ]
    for (var i = 0; i < states.length; i += 1) {
      var fixture = tripoFixture({
        onRequest: function () {
          return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: { task_status: states[i][0] } }) })
        }
      })
      var state = await fixture.adapter.query({ vendorJobId: 'vendor-task-1' })
      expect(state.status).toBe(states[i][1])
    }
    var successFixture = tripoFixture({
      onRequest: function () {
        return Promise.resolve({
          statusCode: 200,
          body: JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ pbr_model_url: 'https://cdn/model.glb' }] } })
        })
      }
    })
    var success = await successFixture.adapter.query({ vendorJobId: 'vendor-task-1' })
    expect(success).toMatchObject({ status: 'SUCCEEDED', assetUrl: 'https://cdn/model.glb' })

    var failedFixture = tripoFixture({
      onRequest: function () {
        return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: { task_status: 'FAILED', code: '50411', message: 'risk' } }) })
      }
    })
    var failed = await failedFixture.adapter.query({ vendorJobId: 'vendor-task-1' })
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: '50411' })

    var emptyFixture = tripoFixture({
      onRequest: function () { return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: { task_status: 'SUCCEEDED' } }) }) }
    })
    await expect(emptyFixture.adapter.query({ vendorJobId: 'vendor-task-1' })).rejects.toMatchObject({ code: 6002 })
  })

  test('fetchAsset：query 取新 URL 再下载；403 时重查一次；>45MB → 6003', async function () {
    var clock = makeClock()
    var queryCount = 0
    var fetchCount = 0
    var fixture = tripoFixture({
      clock: clock,
      onRequest: function () {
        queryCount += 1
        return Promise.resolve({
          statusCode: 200,
          body: JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ pbr_model_url: 'https://cdn/model-' + queryCount + '.glb' }] } })
        })
      },
      onFetch: function () {
        fetchCount += 1
        if (fetchCount === 1) return Promise.resolve({ statusCode: 403, buffer: Buffer.alloc(0) })
        return Promise.resolve({ statusCode: 200, buffer: buildMockGlb() })
      }
    })
    var asset = await fixture.adapter.fetchAsset({ vendorJobId: 'vendor-task-1' })
    expect(Buffer.isBuffer(asset.buffer)).toBe(true)
    expect(queryCount).toBe(2)
    expect(fetchCount).toBe(2)

    var huge = tripoFixture({
      onRequest: function () {
        return Promise.resolve({
          statusCode: 200,
          body: JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ pbr_model_url: 'https://cdn/model.glb' }] } })
        })
      },
      onFetch: function () { return Promise.resolve({ statusCode: 200, buffer: Buffer.alloc(45 * 1024 * 1024 + 1) }) }
    })
    await expect(huge.adapter.fetchAsset({ vendorJobId: 'vendor-task-1' })).rejects.toMatchObject({ code: 6003 })

    var notReady = tripoFixture({
      onRequest: function () { return Promise.resolve({ statusCode: 200, body: JSON.stringify({ output: { task_status: 'RUNNING' } }) }) }
    })
    await expect(notReady.adapter.fetchAsset({ vendorJobId: 'vendor-task-1' })).rejects.toMatchObject({ code: 6002 })
  })

  test('health：配置后 2xx → ok:true；异常 → ok:false', async function () {
    var ok = tripoFixture()
    await expect(ok.adapter.health()).resolves.toMatchObject({ ok: true, provider: 'tripo' })
    var bad = tripoFixture({ onRequest: function () { return Promise.reject(errors.fail(6001)) } })
    await expect(bad.adapter.health()).resolves.toMatchObject({ ok: false })
  })
})
