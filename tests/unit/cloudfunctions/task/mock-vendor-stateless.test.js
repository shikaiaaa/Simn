/**
 * tests/unit/cloudfunctions/task/mock-vendor-stateless.test.js
 * task-38（E2E-B10）：MockVendorAdapter 无状态、跨云函数 invocation 可重建；
 * vendorTaskId 可解码；结果图为与尺寸一致的合法 PNG 占位图；各 scenario 语义不变。
 */
'use strict'

var mockVendor = require('../../../../cloudfunctions/sinn-task/lib/vendor/mock-vendor')
var createMockVendorAdapter = mockVendor.createMockVendorAdapter
var parseVendorTaskId = mockVendor.parseVendorTaskId
var createVendorAdapter = require('../../../../cloudfunctions/sinn-task/lib/vendor').createVendorAdapter
var createHandler = require('../../../../cloudfunctions/sinn-task/lib/handler').createHandler
var util = require('../../../../cloudfunctions/sinn-task/lib/util')
var fixtures = require('./fixtures')
var makeClock = require('./fixtures').makeClock

var PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
var IEND_CHUNK_SUFFIX = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

function adapterAt(clock, overrides) {
  return createMockVendorAdapter(Object.assign({ now: clock.now }, overrides || {}))
}

function submitAndQueryEachInvocation(clock, overrides, offsets) {
  // 模拟真实云：每次 callFunction 都新建 adapter 实例（不共享内存）
  return adapterAt(clock, overrides).submit({ personBuffers: [Buffer.from('p')], garmentBuffer: Buffer.from('g'), metrics: {} })
    .then(function (submitted) {
      var states = []
      return offsets.reduce(function (chain, offset) {
        return chain.then(function () {
          clock.advance(offset)
          var adapter = adapterAt(clock, overrides)
          return adapter.query({ vendorTaskId: submitted.vendorTaskId }).then(function (result) {
            states.push(result.state)
          })
        })
      }, Promise.resolve()).then(function () {
        return states
      })
    })
}

describe('task-38 MockVendorAdapter 无状态（跨 invocation 可重建）', function () {
  test('submit 返回可解码 vendorTaskId：vt_<base36(submittedAt)>_<seq>', async function () {
    var clock = makeClock(1700000000123)
    var adapter = adapterAt(clock)
    var first = await adapter.submit({})
    expect(first.vendorTaskId).toMatch(/^vt_[0-9a-z]+_[0-9]+$/)
    var parsed = parseVendorTaskId(first.vendorTaskId, clock.now())
    expect(parsed).not.toBeNull()
    expect(parsed.submittedAt).toBe(1700000000123)
    expect(parsed.seq).toBe(1)
    // 同实例同毫秒多次 submit 用 seq 区分，id 不重复
    var second = await adapter.submit({})
    expect(parseVendorTaskId(second.vendorTaskId, clock.now()).seq).toBe(2)
    expect(second.vendorTaskId).not.toBe(first.vendorTaskId)
  })

  test('跨实例/跨 invocation：A submit，B/C/D 依次推进 PENDING→RUNNING→SUCCEEDED', async function () {
    var clock = makeClock(1000)
    var opts = { queueMs: 100, generateMs: 200 }
    var adapterA = adapterAt(clock, opts)
    var submitted = await adapterA.submit({
      personBuffers: [Buffer.from('person')],
      garmentBuffer: Buffer.from('garment'),
      metrics: {}
    })

    // 每次查询都用全新 adapter（模拟不同云函数 invocation），不再报 unknown
    clock.advance(50)
    var adapterB = adapterAt(clock, opts)
    expect((await adapterB.query({ vendorTaskId: submitted.vendorTaskId })).state).toBe('PENDING')

    clock.advance(100) // t=+150ms
    var adapterC = adapterAt(clock, opts)
    expect((await adapterC.query({ vendorTaskId: submitted.vendorTaskId })).state).toBe('RUNNING')

    clock.advance(250) // t=+400ms >= queueMs+generateMs
    var adapterD = adapterAt(clock, opts)
    var done = await adapterD.query({ vendorTaskId: submitted.vendorTaskId })
    expect(done.state).toBe('SUCCEEDED')
    expect(done.width).toBe(2048)
    expect(done.height).toBe(3072)
  })

  test('重复 query 幂等且时间推导确定（无内存状态依赖）', async function () {
    var clock = makeClock(5000)
    var opts = { queueMs: 100, generateMs: 200 }
    var submitted = await adapterAt(clock, opts).submit({})
    var first = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    var second = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    expect(first.state).toBe('PENDING')
    expect(second.state).toBe(first.state)
    clock.advance(150)
    var running1 = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    var running2 = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    expect(running1.state).toBe('RUNNING')
    expect(running2.state).toBe('RUNNING')
    clock.advance(300)
    var done1 = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    var done2 = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    expect(done1.state).toBe('SUCCEEDED')
    expect(done2.state).toBe('SUCCEEDED')
  })

  test('畸形/伪造 vendorTaskId 仍 reject（保持 unknown 语义）', async function () {
    var clock = makeClock(9000)
    var adapter = adapterAt(clock, { queueMs: 0, generateMs: 0 })
    var badIds = [
      'vt_',
      'vt_abc',
      'vt_1',
      'vt_-1',
      'vt_!!!_1',
      'mock-1',
      'vt_' + (clock.now() + 10 * 60 * 1000).toString(36) + '_1', // 未来 10min，超出 5min 时钟漂移容忍
      '',
      null,
      undefined,
      123
    ]
    for (var i = 0; i < badIds.length; i += 1) {
      await expect(adapter.query({ vendorTaskId: badIds[i] })).rejects.toThrow(/unknown vendorTaskId/)
    }
    expect(parseVendorTaskId('vt_1', clock.now())).toBeNull()
  })

  test('各 scenario 仍按时间语义工作（每次新建实例查询）', async function () {
    // queue：始终 PENDING
    var queueClock = makeClock(20000)
    var queueSubmitted = await adapterAt(queueClock, { scenario: 'queue' }).submit({})
    queueClock.advance(60000)
    expect((await adapterAt(queueClock, { scenario: 'queue' }).query({ vendorTaskId: queueSubmitted.vendorTaskId })).state).toBe('PENDING')

    // timeout：queueMs 后 RUNNING，由 handler 60s 判 TIMEOUT
    var timeoutClock = makeClock(21000)
    var timeoutSubmitted = await adapterAt(timeoutClock, { scenario: 'timeout', queueMs: 100 }).submit({})
    timeoutClock.advance(5000)
    expect((await adapterAt(timeoutClock, { scenario: 'timeout', queueMs: 100 }).query({ vendorTaskId: timeoutSubmitted.vendorTaskId })).state).toBe('RUNNING')

    // content_blocked：queueMs 后 FAILED + content_blocked
    var blockedClock = makeClock(22000)
    var blockedSubmitted = await adapterAt(blockedClock, { scenario: 'content_blocked', queueMs: 10 }).submit({})
    blockedClock.advance(20)
    var blocked = await adapterAt(blockedClock, { scenario: 'content_blocked', queueMs: 10 }).query({ vendorTaskId: blockedSubmitted.vendorTaskId })
    expect(blocked.state).toBe('FAILED')
    expect(blocked.failureCode).toBe('content_blocked')

    // precheck_failed：FAILED + error_apply_region_not_detected
    var regionClock = makeClock(23000)
    var regionSubmitted = await adapterAt(regionClock, { scenario: 'precheck_failed', queueMs: 10 }).submit({})
    regionClock.advance(20)
    var region = await adapterAt(regionClock, { scenario: 'precheck_failed', queueMs: 10 }).query({ vendorTaskId: regionSubmitted.vendorTaskId })
    expect(region.state).toBe('FAILED')
    expect(region.failureCode).toBe('error_apply_region_not_detected')

    // failed：queueMs+generateMs 后 FAILED
    var failedClock = makeClock(24000)
    var failedSubmitted = await adapterAt(failedClock, { scenario: 'failed', queueMs: 100, generateMs: 200 }).submit({})
    failedClock.advance(350)
    var failed = await adapterAt(failedClock, { scenario: 'failed', queueMs: 100, generateMs: 200 }).query({ vendorTaskId: failedSubmitted.vendorTaskId })
    expect(failed.state).toBe('FAILED')
    expect(failed.failureCode).toBe('vendor_generation_failed')

    // invalid_response：无法识别的 state（handler 映射 5005）
    var invalidClock = makeClock(25000)
    var invalidSubmitted = await adapterAt(invalidClock, { scenario: 'invalid_response' }).submit({})
    var invalid = await adapterAt(invalidClock, { scenario: 'invalid_response' }).query({ vendorTaskId: invalidSubmitted.vendorTaskId })
    expect(invalid.state).toBe('SOMETHING_ELSE')

    // submit_error：submit 抛错
    await expect(adapterAt(makeClock(26000), { scenario: 'submit_error' }).submit({})).rejects.toThrow(/submit failed/)
  })

  test('结果图为合法 PNG 占位图，IHDR 宽高与返回 width/height 一致', async function () {
    var clock = makeClock(30000)
    var opts = { queueMs: 0, generateMs: 0, width: 64, height: 96 }
    var submitted = await adapterAt(clock, opts).submit({})
    var done = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    expect(done.state).toBe('SUCCEEDED')
    expect(done.width).toBe(64)
    expect(done.height).toBe(96)
    var buffer = done.imageBuffer
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.slice(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(buffer.readUInt32BE(16)).toBe(64) // IHDR width
    expect(buffer.readUInt32BE(20)).toBe(96) // IHDR height
    expect(buffer.slice(-8).equals(IEND_CHUNK_SUFFIX)).toBe(true)
    expect(buffer.length).toBeGreaterThan(50)
    // 非图片文案（旧 mock-result-image）不得再出现
    expect(buffer.toString('utf8', 0, 16)).not.toMatch(/mock-result/)
  })

  test('默认占位图 2048×3072，长边满足结果页尺寸口径', async function () {
    var clock = makeClock(31000)
    var opts = { queueMs: 0, generateMs: 0 }
    var submitted = await adapterAt(clock, opts).submit({})
    var done = await adapterAt(clock, opts).query({ vendorTaskId: submitted.vendorTaskId })
    var buffer = done.imageBuffer
    expect(buffer.readUInt32BE(16)).toBe(2048)
    expect(buffer.readUInt32BE(20)).toBe(3072)
    expect(done.width).toBe(2048)
    expect(done.height).toBe(3072)
    expect(Math.max(done.width, done.height)).toBeGreaterThanOrEqual(2048)
  })

  test('cancel/erase 为 no-op：不抛错、不伪造墓碑（跨实例查询仍可推导）', async function () {
    var clock = makeClock(40000)
    var adapter = adapterAt(clock, { scenario: 'queue' })
    var submitted = await adapter.submit({})
    expect(adapter.__pending()).toBe(1)
    await adapter.cancel({ vendorTaskId: submitted.vendorTaskId })
    await adapter.erase({ vendorTaskId: submitted.vendorTaskId })
    expect(adapter.__pending()).toBe(0)
    // 无状态：另一实例仍能查询（erase 不能假装供应商侧已删除）
    var another = adapterAt(clock, { scenario: 'queue' })
    expect((await another.query({ vendorTaskId: submitted.vendorTaskId })).state).toBe('PENDING')
  })

  test('validate 默认 unknown（真实供应商无预检端点）；health ok', async function () {
    var adapter = createMockVendorAdapter()
    var validated = await adapter.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(validated.status).toBe('unknown')
    var health = await adapter.health()
    expect(health.ok).toBe(true)
    expect(typeof health.latencyMs).toBe('number')
  })

  test('handler 级跨 invocation：createTask 与各次 taskGet 使用不同 adapter 实例仍能推进到 SUCCEEDED', async function () {
    var clock = makeClock(1762700000000)
    var ctx = fixtures.makeContext({ clock: clock, queueMs: 100, generateMs: 200 })
    await fixtures.seedConsentUser(ctx.store, fixtures.USER, {})
    var person = await fixtures.seedAsset(ctx.store, {
      openid: fixtures.USER,
      kind: 'PERSON',
      fileID: fixtures.IDS.person1
    })
    var garment = await fixtures.seedAsset(ctx.store, {
      openid: fixtures.USER,
      kind: 'GARMENT',
      fileID: fixtures.IDS.garment
    })
    var created = await ctx.call('createTask', {
      clientReqId: util.newRequestId(),
      personAssetIds: [person.assetId],
      garmentAssetId: garment.assetId,
      metrics: { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 }
    })
    expect(created.ok).toBe(true)
    var taskId = created.data.taskId

    // 模拟真实云：每次 callFunction 都新建 vendor adapter + handler，不共享实例内存
    function newInvocation() {
      var vendor = createVendorAdapter(ctx.env, {
        now: clock.now,
        scenario: 'success',
        queueMs: 100,
        generateMs: 200
      })
      var handler = createHandler({
        store: ctx.store,
        storage: ctx.storage,
        vendor: vendor,
        precheck: ctx.precheck,
        env: ctx.env,
        now: clock.now,
        requestId: util.newRequestId()
      })
      return function (action, payload) {
        return handler.handle(Object.assign({ action: action }, payload || {}), { openid: fixtures.USER })
      }
    }

    clock.advance(50) // t0+50ms：PENDING
    var pending = await newInvocation()('taskGet', { taskId: taskId })
    expect(pending.ok).toBe(true)
    expect(pending.data.status).toBe('QUEUED')

    clock.advance(100) // t0+150ms：RUNNING（queueMs<elapsed<queueMs+generateMs）
    var running = await newInvocation()('taskGet', { taskId: taskId })
    expect(running.ok).toBe(true)
    expect(running.data.status).toBe('GENERATING')

    clock.advance(250) // t0+400ms：SUCCEEDED
    var succeeded = await newInvocation()('taskGet', { taskId: taskId })
    expect(succeeded.ok).toBe(true)
    expect(succeeded.data.status).toBe('SUCCEEDED')
    expect(succeeded.data.result.fileID).toMatch(/^cloud:\/\/test\/result\//)
  })
})
