/**
 * tests/unit/cloudfunctions/task/vendor.test.js
 * VendorAdapter 六方法契约、Mock 场景矩阵、Http 骨架（L1）。
 */
'use strict'

var vendorLib = require('../../../../cloudfunctions/sinn-task/lib/vendor')
var mockVendor = require('../../../../cloudfunctions/sinn-task/lib/vendor/mock-vendor')
var createMockVendorAdapter = mockVendor.createMockVendorAdapter
var makeClock = require('./fixtures').makeClock

describe('DEV-0001-03 VendorAdapter', function () {
  test('工厂默认 mock，六方法齐全；未知 provider 抛错', function () {
    var adapter = vendorLib.createVendorAdapter({ SINN_VENDOR: 'mock' })
    expect(adapter.provider).toBe('mock')
    vendorLib.VENDOR_METHODS.forEach(function (method) {
      expect(typeof adapter[method]).toBe('function')
    })
    var failure = null
    try {
      vendorLib.createVendorAdapter({ SINN_VENDOR: 'unknown-vendor' })
    } catch (error) {
      failure = error
    }
    expect(failure).not.toBeNull()
    expect(failure.isAppError).toBe(true)
    expect(failure.code).toBe(9000)
    expect(failure.hint).toMatch(/未知 SINN_VENDOR/)
  })

  test('tencentmps 仅为 Http 骨架：submit 抛 E_VENDOR_UNAVAILABLE，不伪装可用', function () {
    var adapter = vendorLib.createVendorAdapter({ SINN_VENDOR: 'tencentmps' })
    expect(adapter.provider).toBe('tencentmps')
    return adapter.submit({ personBuffers: [], garmentBuffer: null, metrics: {} }).then(
      function () {
        throw new Error('预期 submit 失败')
      },
      function (error) {
        expect(error.code).toBe(5001)
        expect(error.name).toBe('E_VENDOR_UNAVAILABLE')
      }
    )
  })

  test('mock success 场景：PENDING → RUNNING → SUCCEEDED 且返回图片与尺寸', async function () {
    var clock = makeClock(1000)
    var adapter = createMockVendorAdapter({ now: clock.now, scenario: 'success', queueMs: 100, generateMs: 200, width: 2048, height: 3072 })
    var submitted = await adapter.submit({ personBuffers: [Buffer.from('a')], garmentBuffer: Buffer.from('b'), metrics: {} })
    expect(submitted.vendorTaskId).toMatch(/^vt_[0-9a-z]+_[0-9]+$/)

    expect((await adapter.query({ vendorTaskId: submitted.vendorTaskId })).state).toBe('PENDING')
    clock.advance(150)
    expect((await adapter.query({ vendorTaskId: submitted.vendorTaskId })).state).toBe('RUNNING')
    clock.advance(200)
    var done = await adapter.query({ vendorTaskId: submitted.vendorTaskId })
    expect(done.state).toBe('SUCCEEDED')
    expect(done.width).toBe(2048)
    expect(done.height).toBe(3072)
    expect(Buffer.isBuffer(done.imageBuffer)).toBe(true)
  })

  test('mock 场景：queue / timeout / invalid_response / content_blocked / failed / submit_error', async function () {
    var clock = makeClock(2000)
    var queue = createMockVendorAdapter({ now: clock.now, scenario: 'queue' })
    var qTask = await queue.submit({})
    clock.advance(10000)
    expect((await queue.query({ vendorTaskId: qTask.vendorTaskId })).state).toBe('PENDING')

    var timeout = createMockVendorAdapter({ now: clock.now, scenario: 'timeout', queueMs: 100 })
    var tTask = await timeout.submit({})
    clock.advance(5000)
    expect((await timeout.query({ vendorTaskId: tTask.vendorTaskId })).state).toBe('RUNNING')

    var invalid = createMockVendorAdapter({ now: clock.now, scenario: 'invalid_response' })
    var iTask = await invalid.submit({})
    expect((await invalid.query({ vendorTaskId: iTask.vendorTaskId })).state).toBe('SOMETHING_ELSE')

    var blockedClock = makeClock(3000)
    var blocked = createMockVendorAdapter({ now: blockedClock.now, scenario: 'content_blocked', queueMs: 10 })
    var bTask = await blocked.submit({})
    blockedClock.advance(20)
    var bResult = await blocked.query({ vendorTaskId: bTask.vendorTaskId })
    expect(bResult.state).toBe('FAILED')
    expect(bResult.failureCode).toBe('content_blocked')

    var precheckFailClock = makeClock(4000)
    var precheckFail = createMockVendorAdapter({ now: precheckFailClock.now, scenario: 'precheck_failed', queueMs: 10 })
    var pTask = await precheckFail.submit({})
    precheckFailClock.advance(20)
    var pResult = await precheckFail.query({ vendorTaskId: pTask.vendorTaskId })
    expect(pResult.state).toBe('FAILED')
    expect(pResult.failureCode).toBe('error_apply_region_not_detected')

    var failing = createMockVendorAdapter({ scenario: 'submit_error' })
    await expect(failing.submit({})).rejects.toThrow(/submit failed/)
  })

  test('mock validate 默认 unknown（与真实供应商无预检端点一致）', async function () {
    var adapter = createMockVendorAdapter()
    var result = await adapter.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(result.status).toBe('unknown')
  })

  test('cancel/erase 为无状态 no-op：不伪造墓碑，跨实例仍可查询；伪造 id 才 reject', async function () {
    var adapter = createMockVendorAdapter({ scenario: 'queue' })
    var task = await adapter.submit({})
    expect(adapter.__pending()).toBe(1)
    await adapter.erase({ vendorTaskId: task.vendorTaskId })
    expect(adapter.__pending()).toBe(0)
    // 无状态实现无法真正删除供应商侧任务，不能假装有墓碑；跨实例仍可推导状态
    var another = createMockVendorAdapter({ scenario: 'queue' })
    expect((await another.query({ vendorTaskId: task.vendorTaskId })).state).toBe('PENDING')
    await expect(another.query({ vendorTaskId: 'vt_forged' })).rejects.toThrow(/unknown vendorTaskId/)
  })

  test('health 返回 ok；assertVendorContract 校验方法缺失', async function () {
    var adapter = createMockVendorAdapter()
    var health = await adapter.health()
    expect(health.ok).toBe(true)
    var contractFailure = null
    try {
      vendorLib.assertVendorContract({ validate: function () {} })
    } catch (error) {
      contractFailure = error
    }
    expect(contractFailure).not.toBeNull()
    expect(contractFailure.isAppError).toBe(true)
    expect(contractFailure.hint).toMatch(/缺少方法/)
  })
})
