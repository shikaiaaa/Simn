/**
 * tests/unit/cloudfunctions/task/volcengine-vendor.test.js
 * DEV-0001-25 火山引擎「图片换装 V2」VendorAdapter（SPEC-0001 v0.5 §B.4）：
 * 六方法语义、状态映射、错误码映射、超时兜底、密钥安全、与 mock 的契约一致性。
 * 全部离线：真实 HTTP 经 options.transport 注入；不访问网络、不需要真实凭证。
 */
'use strict'

var volcengine = require('../../../../cloudfunctions/sinn-task/lib/vendor/volcengine-vendor')
var vendorLib = require('../../../../cloudfunctions/sinn-task/lib/vendor')
var mockVendor = require('../../../../cloudfunctions/sinn-task/lib/vendor/mock-vendor')

var CREDS = {
  SINN_VENDOR: 'volcengine',
  SINN_VOLC_AK: 'AK_TEST_SECRET_123',
  SINN_VOLC_SK: 'SK_TEST_SECRET_456',
  SINN_VOLC_REGION: 'cn-north-1'
}

function makeTransport(overrides) {
  var calls = { submit: 0, query: 0, fetchResult: 0, ping: 0 }
  var transport = {
    calls: calls,
    submit: function () {
      calls.submit += 1
      return Promise.resolve({ taskId: 'vt_volc_1' })
    },
    query: function () {
      calls.query += 1
      return Promise.resolve({ status: 'processing' })
    },
    fetchResult: function () {
      calls.fetchResult += 1
      return Promise.resolve(Buffer.from('result-image'))
    },
    ping: function () {
      calls.ping += 1
      return Promise.resolve({ ok: true })
    }
  }
  return Object.assign(transport, overrides || {})
}

var SILENT_LOGGER = { warn: function () {} }

function adapterWith(env, transport, extra) {
  return volcengine.createVolcengineVendorAdapter(
    env || CREDS,
    Object.assign({ transport: transport, timeoutMs: 100, logger: SILENT_LOGGER }, extra || {})
  )
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection but promise resolved')
}

function expectAppError(error, code, hintPattern) {
  expect(error).toBeTruthy()
  expect(error.isAppError).toBe(true)
  expect(error.code).toBe(code)
  if (hintPattern) expect(error.hint).toMatch(hintPattern)
}

describe('DEV-0001-25 火山引擎 VendorAdapter', function () {
  test('工厂装配：默认仍 mock；显式 volcengine 才切换；缺凭证不假装可用', async function () {
    expect(vendorLib.createVendorAdapter({}).provider).toBe('mock')

    var adapter = vendorLib.createVendorAdapter(CREDS, { transport: makeTransport() })
    expect(adapter.provider).toBe('volcengine')
    vendorLib.VENDOR_METHODS.forEach(function (method) {
      expect(typeof adapter[method]).toBe('function')
    })

    var noCreds = vendorLib.createVendorAdapter({ SINN_VENDOR: 'volcengine' }, { transport: makeTransport() })
    expect(noCreds.provider).toBe('volcengine')
    expect(noCreds.configured).toBe(false)
    var health = await noCreds.health()
    expect(health.ok).toBe(false)
    expect(health.configured).toBe(false)
    expect(health.reason).toBe('missing_credentials')
    expectAppError(await rejection(noCreds.submit({})), 5001, /未配置 SINN_VOLC_AK\/SINN_VOLC_SK/)
  })

  test('凭证只从 env 读取：options 里的 AK/SK 不被采用', function () {
    var adapter = volcengine.createVolcengineVendorAdapter(
      { SINN_VENDOR: 'volcengine' },
      { transport: makeTransport(), SINN_VOLC_AK: 'lead-through-options', SINN_VOLC_SK: 'lead-through-options' }
    )
    expect(adapter.configured).toBe(false)
  })

  test('validate：无独立预检端点 → 永远 unknown（unknown ≠ pass），且不发起网络请求', async function () {
    var transport = makeTransport()
    var adapter = adapterWith(CREDS, transport)
    var result = await adapter.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(result.status).toBe('unknown')
    expect(result.status).not.toBe('pass')
    expect(result.unknown).toContain('vendor_validate_unavailable')
    expect(result.detail.reason).toBe('volcengine_no_validate_endpoint')
    expect(transport.calls.submit).toBe(0)
    expect(transport.calls.query).toBe(0)
  })

  test('submit：成功返回 vendorTaskId；把图片 Buffer 透传给 transport（真实 V2 需要 base64 直传）', async function () {
    var seen = null
    var transport = makeTransport({
      submit: function (payload) {
        seen = payload
        return Promise.resolve({ task_id: 'vt_volc_2' })
      }
    })
    var adapter = adapterWith(CREDS, transport)
    var personA = Buffer.from('PERSON_IMAGE_A')
    var personB = Buffer.from('PERSON_IMAGE_B')
    var garment = Buffer.from('GARMENT_IMAGE')
    var result = await adapter.submit({
      personBuffers: [personA, personB],
      garmentBuffer: garment,
      metrics: { heightCm: 175, weightKg: 70, gender: 'male' }
    })
    expect(result.vendorTaskId).toBe('vt_volc_2')
    expect(seen.personBuffers).toHaveLength(2)
    expect(seen.personBuffers[0]).toBe(personA)
    expect(seen.garmentBuffer).toBe(garment)
    expect(seen.metrics).toEqual({ heightCm: 175, weightKg: 70, gender: 'male' })
    expect(JSON.stringify(seen.metrics)).not.toMatch(/PERSON_IMAGE|GARMENT_IMAGE/)
  })

  test('submit：缺 taskId → 5005；超时 → 5002', async function () {
    var missing = adapterWith(CREDS, makeTransport({ submit: function () { return Promise.resolve({ ok: true }) } }))
    expectAppError(await rejection(missing.submit({})), 5005, /缺少任务 ID/)

    var slow = adapterWith(CREDS, makeTransport({ submit: function () { return new Promise(function () {}) } }), { timeoutMs: 20 })
    expectAppError(await rejection(slow.submit({})), 5002, /超时/)
  })

  test('submit 错误码映射：鉴权/欠费/限流/内容/人体不合格/未知', async function () {
    var cases = [
      ['InvalidCredential', 200, 5001, /鉴权|凭证/],
      ['SignatureMismatch', 200, 5001, /鉴权|凭证/],
      ['InsufficientBalance', 200, 5001, /未开通|余额/],
      ['RateLimitExceeded', 200, 5001, /限流/],
      ['ContentRiskDetected', 200, 4001, /内容安全/],
      ['PersonNotDetected', 200, 3001, /单人/],
      ['ApplyRegionNotDetected', 200, 3002, /全身/],
      ['WeirdVendorCode', 418, 5001, /未识别|暂时不可用/]
    ]
    for (var i = 0; i < cases.length; i += 1) {
      var item = cases[i]
      var transport = makeTransport({
        submit: (function (vendorCode, httpStatus) {
          return function () {
            return Promise.reject({ vendorCode: vendorCode, httpStatus: httpStatus, message: 'raw vendor message' })
          }
        })(item[0], item[1])
      })
      var adapter = adapterWith(CREDS, transport)
      var error = await rejection(adapter.submit({ personBuffers: [], garmentBuffer: null }))
      expectAppError(error, item[2], item[3])
    }
  })

  test('submit 已解析响应内 errorCode 同样映射；httpStatus 401 单独可判定鉴权失败', async function () {
    var resolved = adapterWith(CREDS, makeTransport({ submit: function () { return Promise.resolve({ errorCode: 'ContentRiskDetected', httpStatus: 200 }) } }))
    expectAppError(await rejection(resolved.submit({})), 4001, /内容安全/)

    var authOnly = adapterWith(CREDS, makeTransport({ submit: function () { return Promise.reject({ httpStatus: 401 }) } }))
    expectAppError(await rejection(authOnly.submit({})), 5001, /鉴权|凭证/)
  })

  test('query 状态映射：queued→PENDING、running→RUNNING', async function () {
    var pending = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'queued' }) } }))
    expect((await pending.query({ vendorTaskId: 'vt_1' })).state).toBe('PENDING')

    var running = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'running' }) } }))
    expect((await running.query({ vendorTaskId: 'vt_1' })).state).toBe('RUNNING')
  })

  test('query SUCCEEDED：resultUrl 经 transport.fetchResult 下载，返回 Buffer 与尺寸', async function () {
    var seenUrl = null
    var transport = makeTransport({
      query: function () {
        return Promise.resolve({ status: 'success', resultUrl: 'https://mock.example.com/result.jpg', width: 2048, height: 3072 })
      },
      fetchResult: function (payload) {
        seenUrl = payload.url
        return Promise.resolve(Buffer.from('downloaded-image'))
      }
    })
    transport.calls.fetchResult = 0
    var adapter = adapterWith(CREDS, transport)
    var result = await adapter.query({ vendorTaskId: 'vt_1' })
    expect(result.state).toBe('SUCCEEDED')
    expect(Buffer.isBuffer(result.imageBuffer)).toBe(true)
    expect(result.imageBuffer.toString()).toBe('downloaded-image')
    expect(result.width).toBe(2048)
    expect(result.height).toBe(3072)
    expect(seenUrl).toBe('https://mock.example.com/result.jpg')
  })

  test('query SUCCEEDED：inline buffer 不再下载；无图 → 5005', async function () {
    var transport = makeTransport({
      query: function () { return Promise.resolve({ status: 'succeeded', imageBuffer: Buffer.from('inline-image') }) }
    })
    var adapter = adapterWith(CREDS, transport)
    var result = await adapter.query({ vendorTaskId: 'vt_1' })
    expect(result.imageBuffer.toString()).toBe('inline-image')
    expect(transport.calls.fetchResult).toBe(0)

    var noImage = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'success' }) } }))
    expectAppError(await rejection(noImage.query({ vendorTaskId: 'vt_1' })), 5005, /结果图 URL/)
  })

  test('query FAILED：failureCode 映射（内容/区域/其他）', async function () {
    var content = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'failed', errorCode: 'ContentRiskDetected' }) } }))
    expect((await content.query({ vendorTaskId: 'vt_1' })).failureCode).toBe('content_blocked')

    var region = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'failed', errorCode: 'ApplyRegionNotDetected' }) } }))
    expect((await region.query({ vendorTaskId: 'vt_1' })).failureCode).toBe('error_apply_region_not_detected')

    var other = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'failed', errorCode: 'WeirdFailure' }) } }))
    expect((await other.query({ vendorTaskId: 'vt_1' })).failureCode).toBe('vendor_generation_failed')
  })

  test('query：未知状态 → 5005；超时 → 5002', async function () {
    var unknown = adapterWith(CREDS, makeTransport({ query: function () { return Promise.resolve({ status: 'no-such-state' }) } }))
    expectAppError(await rejection(unknown.query({ vendorTaskId: 'vt_1' })), 5005, /未知任务状态/)

    var slow = adapterWith(CREDS, makeTransport({ query: function () { return new Promise(function () {}) } }), { timeoutMs: 20 })
    expectAppError(await rejection(slow.query({ vendorTaskId: 'vt_1' })), 5002, /超时/)
  })

  test('cancel / erase：无供应商能力 → 明确 unsupported，不假装成功', async function () {
    var adapter = adapterWith(CREDS, makeTransport())
    expect(await adapter.cancel({ vendorTaskId: 'vt_1' })).toBe('unsupported')
    expect(await adapter.erase({ vendorTaskId: 'vt_1' })).toBe('unsupported')
  })

  test('health：已配置但无 ping → 未就绪；ping 成功/失败', async function () {
    var noPing = adapterWith(CREDS, makeTransport({ ping: undefined }))
    var pendingHealth = await noPing.health()
    expect(pendingHealth.ok).toBe(false)
    expect(pendingHealth.configured).toBe(true)
    expect(pendingHealth.reason).toBe('health_pending_cp04b')

    var okAdapter = adapterWith(CREDS, makeTransport())
    var okHealth = await okAdapter.health()
    expect(okHealth.ok).toBe(true)
    expect(typeof okHealth.latencyMs).toBe('number')

    var failAdapter = adapterWith(CREDS, makeTransport({ ping: function () { return Promise.reject({ vendorCode: 'AuthFailed' }) } }))
    var failHealth = await failAdapter.health()
    expect(failHealth.ok).toBe(false)
    expect(failHealth.reason).toBe('ping_failed')
  })

  test('默认 transport 缺失：网络方法返回 5001 且不发起请求（不编造真实报文）', async function () {
    var adapter = volcengine.createVolcengineVendorAdapter(CREDS, {})
    expectAppError(await rejection(adapter.submit({ personBuffers: [], garmentBuffer: null })), 5001, /HTTP 传输层未实现/)
    expectAppError(await rejection(adapter.query({ vendorTaskId: 'vt_1' })), 5001, /HTTP 传输层未实现/)
  })

  test('密钥安全：错误信息、异常对象、日志、适配器对象均不出现 AK/SK 明文', async function () {
    var warnSpy = jest.spyOn(console, 'warn').mockImplementation(function () {})
    var errorSpy = jest.spyOn(console, 'error').mockImplementation(function () {})
    var logSpy = jest.spyOn(console, 'log').mockImplementation(function () {})
    try {
      var adapter = adapterWith(
        CREDS,
        makeTransport({
          submit: function () {
            return Promise.reject({
              vendorCode: 'InvalidCredential',
              httpStatus: 401,
              message: 'sign failed for ' + CREDS.SINN_VOLC_AK + ' / ' + CREDS.SINN_VOLC_SK
            })
          }
        }),
        { logger: console }
      )
      var error = await rejection(adapter.submit({ personBuffers: [Buffer.from('x')], garmentBuffer: null }))
      var serialized = JSON.stringify({ message: error.message, hint: error.hint, detail: error.detail })
      var consoleText = warnSpy.mock.calls.concat(errorSpy.mock.calls).concat(logSpy.mock.calls).map(function (args) {
        return args.map(String).join(' ')
      }).join('\n')
      expect(serialized).not.toMatch(/AK_TEST_SECRET_123|SK_TEST_SECRET_456/)
      expect(consoleText).not.toMatch(/AK_TEST_SECRET_123|SK_TEST_SECRET_456/)
      expect(JSON.stringify(adapter)).not.toMatch(/AK_TEST_SECRET_123|SK_TEST_SECRET_456/)
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  test('与 mock 的契约一致性：validate/submit/query/cancel/erase/health 同套断言', async function () {
    var adapters = [
      mockVendor.createMockVendorAdapter({ scenario: 'success', queueMs: 100, generateMs: 200 }),
      adapterWith(CREDS, makeTransport())
    ]
    for (var i = 0; i < adapters.length; i += 1) {
      var adapter = adapters[i]
      var validated = await adapter.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
      expect(['pass', 'fail', 'unknown']).toContain(validated.status)

      var submitted = await adapter.submit({ personBuffers: [Buffer.from('a')], garmentBuffer: Buffer.from('b'), metrics: {} })
      expect(typeof submitted.vendorTaskId).toBe('string')
      expect(submitted.vendorTaskId.length).toBeGreaterThan(0)

      var queried = await adapter.query({ vendorTaskId: submitted.vendorTaskId })
      expect(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']).toContain(queried.state)

      var cancelled = await adapter.cancel({ vendorTaskId: submitted.vendorTaskId })
      expect(cancelled === undefined || cancelled === 'unsupported').toBe(true)

      var erased = await adapter.erase({ vendorTaskId: submitted.vendorTaskId })
      expect(erased === undefined || erased === 'unsupported').toBe(true)

      var health = await adapter.health()
      expect(typeof health.ok).toBe('boolean')
      expect(typeof health.latencyMs).toBe('number')
    }
  })
})
