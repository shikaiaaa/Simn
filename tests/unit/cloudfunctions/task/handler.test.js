/**
 * tests/unit/cloudfunctions/task/handler.test.js
 * sinn-task 云函数 L1 覆盖（DEV-0001-03 acceptance）：
 * 统一包裹/错误码、预检三态拦截、额度预扣与幂等返还、单活跃任务、
 * 60s 超时、物理删除、越权 404、auditTask 白名单、AC-2/3/4/5/6/10/24 判定路径。
 */
'use strict'

var util = require('../../../../cloudfunctions/sinn-task/lib/util')
var createMockPrecheckAdapter = require('../../../../cloudfunctions/sinn-task/lib/precheck').createMockPrecheckAdapter
var fixtures = require('./fixtures')

var USER = fixtures.USER
var QA = fixtures.QA
var OTHER = fixtures.OTHER
var IDS = fixtures.IDS

var DEFAULT_METRICS = {
  heightCm: 175,
  weightKg: 70,
  gender: 'male',
  chestCm: 92,
  waistCm: 78,
  hipCm: 96
}

function newUuid() {
  return util.newRequestId()
}

async function withConsentUser(options) {
  options = options || {}
  var ctx = fixtures.makeContext(options)
  await fixtures.seedConsentUser(ctx.store, options.openid || USER, options.user || {})
  return ctx
}

async function injectAsset(ctx, options) {
  options = options || {}
  return fixtures.seedAsset(ctx.store, {
    openid: options.openid || USER,
    kind: options.kind || 'PERSON',
    fileID: options.fileID,
    precheckStatus: options.precheckStatus === undefined ? 'pass' : options.precheckStatus,
    clientReqId: options.clientReqId || newUuid()
  })
}

async function createTaskWithAssets(ctx, options) {
  options = options || {}
  var openid = options.openid || USER
  var personCount = options.personCount || 1
  var personAssetIds = []
  for (var i = 0; i < personCount; i += 1) {
    var person = await injectAsset(ctx, {
      openid: openid,
      kind: 'PERSON',
      fileID: i === 0 ? IDS.person1 : IDS.person2
    })
    personAssetIds.push(person.assetId)
  }
  var garment = await injectAsset(ctx, { openid: openid, kind: 'GARMENT', fileID: IDS.garment })
  var clientReqId = options.clientReqId || newUuid()
  var res = await ctx.call(
    'createTask',
    {
      clientReqId: clientReqId,
      personAssetIds: personAssetIds,
      garmentAssetId: garment.assetId,
      metrics: options.metrics || DEFAULT_METRICS
    },
    openid
  )
  return { res: res, clientReqId: clientReqId, personAssetIds: personAssetIds, garmentAssetId: garment.assetId }
}

describe('DEV-0001-03 sinn-task handler：包裹与同意门禁', function () {
  test('未知 action → E_PARAM 1001；缺 openid → 1004 且 httpStatus 404', async function () {
    var ctx = await withConsentUser()
    var bad = await ctx.call('not-exist', {})
    expect(bad.ok).toBe(false)
    expect(bad.error.code).toBe(1001)

    var missingOpenid = await ctx.handler.handle({ action: 'assetRegister' }, {})
    expect(missingOpenid.ok).toBe(false)
    expect(missingOpenid.error.code).toBe(1004)
    expect(missingOpenid.error.httpStatus).toBe(404)
  })

  test('写接口未同意 → E_CONSENT_REQUIRED 1003，不落任何数据', async function () {
    var ctx = fixtures.makeContext()
    var res = await ctx.call('assetRegister', {
      clientReqId: newUuid(),
      kind: 'PERSON',
      fileID: IDS.person1,
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1000,
      height: 1500
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1003)
    expect(ctx.store.__countAssets()).toBe(0)
  })

  test('响应包裹恒定包含 ok/data/error/requestId/serverTime', async function () {
    var ctx = await withConsentUser()
    var res = await ctx.call('assetRegister', {
      clientReqId: newUuid(),
      kind: 'PERSON',
      fileID: IDS.person1,
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1000,
      height: 1500
    })
    expect(Object.keys(res).sort()).toEqual(['data', 'error', 'ok', 'requestId', 'serverTime'])
    expect(res.ok).toBe(true)
    expect(res.error).toBeNull()
    expect(typeof res.requestId).toBe('string')
    expect(typeof res.serverTime).toBe('number')
  })
})

describe('DEV-0001-03 assetRegister', function () {
  test('注册成功：assetId/purgeAt 正确，且 clientReqId 幂等', async function () {
    var ctx = await withConsentUser()
    var clientReqId = newUuid()
    var payload = {
      clientReqId: clientReqId,
      kind: 'PERSON',
      fileID: IDS.person1,
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1000,
      height: 1500
    }
    var first = await ctx.call('assetRegister', payload)
    expect(first.ok).toBe(true)
    expect(first.data.assetId).toMatch(/^a_[0-9a-f]{24}$/)
    expect(first.data.kind).toBe('PERSON')
    var asset = await ctx.store.getAsset(first.data.assetId)
    expect(asset.purgeAt - asset.createdAt).toBe(util.PURGE_TTL_MS)
    expect(asset.openid).toBe(USER)

    var second = await ctx.call('assetRegister', payload)
    expect(second.data.assetId).toBe(first.data.assetId)
    expect(ctx.store.__countAssets()).toBe(1)
  })

  test('非法参数：kind/fileID/clientReqId → E_PARAM 1001；供应商规格超限 → 3015', async function () {
    var ctx = await withConsentUser()
    var base = {
      clientReqId: newUuid(),
      kind: 'PERSON',
      fileID: IDS.person1,
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1000,
      height: 1500
    }
    // SPEC v0.11 §B.2：超供应商规格（>5MB / 长边 >4096 / 非 JPEG）→ 3015，不再兜 1001。
    var vendorCases = [
      Object.assign({}, base, { mime: 'image/gif' }),
      Object.assign({}, base, { bytes: 11 * 1024 * 1024 }),
      Object.assign({}, base, { width: 5000, height: 5000 })
    ]
    for (var i = 0; i < vendorCases.length; i += 1) {
      var vendorRes = await ctx.call('assetRegister', vendorCases[i])
      expect(vendorRes.ok).toBe(false)
      expect(vendorRes.error.code).toBe(3015)
      expect(vendorRes.error.name).toBe('E_PRECHECK_VENDOR_LIMIT')
    }
    var cases = [
      Object.assign({}, base, { kind: 'OTHER' }),
      Object.assign({}, base, { fileID: 'https://example.com/a.jpg' }),
      Object.assign({}, base, { clientReqId: 'not-a-uuid' })
    ]
    for (var j = 0; j < cases.length; j += 1) {
      var res = await ctx.call('assetRegister', cases[j])
      expect(res.ok).toBe(false)
      expect(res.error.code).toBe(1001)
    }
  })
})

describe('DEV-0001-03 precheck：三态与缓存（AC-2/3/4/5/24）', function () {
  test('pass → pass:true；同 assetId 第二次命中 10min 缓存', async function () {
    var ctx = await withConsentUser()
    var asset = await injectAsset(ctx, { precheckStatus: null })
    var first = await ctx.call('precheck', { assetId: asset.assetId })
    expect(first.ok).toBe(true)
    expect(first.data.pass).toBe(true)
    expect(first.data.status).toBe('pass')
    expect(first.data.checks.length).toBeGreaterThan(0)

    var second = await ctx.call('precheck', { assetId: asset.assetId })
    expect(second.ok).toBe(true)
    expect(second.data.cached).toBe(true)
    expect(ctx.precheck.__calls()).toBe(1)
  })

  test.each([
    ['full_body', 3002],
    ['single_person', 3001],
    ['face_occlusion', 3003],
    ['body_occlusion', 3004],
    ['upright', 3005],
    ['lighting', 3006],
    ['no_garment', 3007],
    ['single_garment', 3008],
    ['on_model', 3009],
    ['tag_visible', 3010],
    ['mall_image', 3011],
    ['image_valid', 3012]
  ])('fail(%s) → ok:true + pass:false + 子码 %i', async function (checkCode, expectedCode) {
    var ctx = await withConsentUser({
      precheckResult: { status: 'fail', failed: [checkCode] }
    })
    var asset = await injectAsset(ctx, { precheckStatus: null })
    var res = await ctx.call('precheck', { assetId: asset.assetId })
    expect(res.ok).toBe(true)
    expect(res.data.pass).toBe(false)
    expect(res.data.status).toBe('fail')
    expect(res.data.code).toBe(expectedCode)
    expect(res.data.hint).toBeTruthy()
  })

  test('unknown → pass:false + 3013 E_PRECHECK_UNKNOWN（不得当 pass）', async function () {
    var ctx = await withConsentUser({
      precheckResult: { status: 'unknown', unknown: ['model_offline'] }
    })
    var asset = await injectAsset(ctx, { precheckStatus: null })
    var res = await ctx.call('precheck', { assetId: asset.assetId })
    expect(res.ok).toBe(true)
    expect(res.data.pass).toBe(false)
    expect(res.data.status).toBe('unknown')
    expect(res.data.code).toBe(3013)
    expect(res.data.name).toBe('E_PRECHECK_UNKNOWN')
  })

  test('预检硬超时 8s 可注入：超时 → E_TIMEOUT 5002', async function () {
    var ctx = await withConsentUser({
      precheck: createMockPrecheckAdapter({ delayMs: 100 }),
      precheckTimeoutMs: 10
    })
    var asset = await injectAsset(ctx, { precheckStatus: null })
    var res = await ctx.call('precheck', { assetId: asset.assetId })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(5002)
  })

  test('越权预检他人资产 → 1004（httpStatus 404，不泄露存在性）', async function () {
    var ctx = await withConsentUser()
    var asset = await injectAsset(ctx)
    await fixtures.seedConsentUser(ctx.store, OTHER)
    var res = await ctx.call('precheck', { assetId: asset.assetId }, OTHER)
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1004)
    expect(res.error.httpStatus).toBe(404)
  })
})

describe('DEV-0001-03 createTask：预扣、活跃、幂等、预检拦截', function () {
  test('成功创建：QUEUED 状态、额度预扣、sizeResult、purgeAt=创建+23h、资产绑定', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    expect(created.res.ok).toBe(true)
    var data = created.res.data
    expect(data.taskId).toMatch(/^t_[0-9a-f]{24}$/)
    expect(data.status).toBe('QUEUED')
    expect(data.quota.remaining).toBe(0)
    expect(data.purgeAt - data.createdAt).toBe(util.PURGE_TTL_MS)

    var task = await ctx.store.getTask(data.taskId)
    expect(task.openid).toBe(USER)
    expect(task.vendorProvider).toBe('mock')
    expect(task.metrics.weightKg).toBe(70000)
    expect(task.metrics.chestCm).toBe(920)
    expect(task.sizeResult.rangeMin).toBe('L')
    expect(task.sizeResult.rangeMax).toBe('XL')
    expect(task.sizeResult.standard).toBe('GB/T 1335.1')
    expect(task.sizeResult.disclaimer).toBe('参考尺码，不构成合身承诺')

    var person = await ctx.store.getAsset(created.personAssetIds[0])
    var garment = await ctx.store.getAsset(created.garmentAssetId)
    expect(person.taskId).toBe(data.taskId)
    expect(garment.taskId).toBe(data.taskId)

    var user = await ctx.store.getUser(USER)
    expect(user.usedToday).toBe(1)
    expect(user.activeTaskId).toBe(data.taskId)
  })

  test('clientReqId 幂等：重复提交返回同一 taskId，只扣一次额度', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    expect(created.res.ok).toBe(true)
    var again = await ctx.call('createTask', {
      clientReqId: created.clientReqId,
      personAssetIds: created.personAssetIds,
      garmentAssetId: created.garmentAssetId,
      metrics: DEFAULT_METRICS
    })
    expect(again.ok).toBe(true)
    expect(again.data.taskId).toBe(created.res.data.taskId)
    expect(ctx.store.__countTasks()).toBe(1)
    var user = await ctx.store.getUser(USER)
    expect(user.usedToday).toBe(1)
  })

  test('同一用户第二个进行中任务 → E_ACTIVE_TASK_EXISTS 2002 + existingTaskId', async function () {
    var ctx = await withConsentUser()
    var first = await createTaskWithAssets(ctx)
    var second = await createTaskWithAssets(ctx)
    expect(second.res.ok).toBe(false)
    expect(second.res.error.code).toBe(2002)
    expect(second.res.error.detail.existingTaskId).toBe(first.res.data.taskId)
  })

  test('额度用尽 → E_QUOTA_EXHAUSTED 2001，不创建任务', async function () {
    var ctx = await withConsentUser()
    var dayKey = util.beijingDayKey(ctx.clock.now())
    await fixtures.seedConsentUser(ctx.store, USER, { dayKey: dayKey, usedToday: 1 })
    var created = await createTaskWithAssets(ctx)
    expect(created.res.ok).toBe(false)
    expect(created.res.error.code).toBe(2001)
    expect(ctx.store.__countTasks()).toBe(0)
  })

  test('预检未 pass（unknown/fail）→ E_PRECHECK_NOT_PASSED 3000，创建 0 次、不扣额度', async function () {
    var ctx = await withConsentUser()
    var person = await injectAsset(ctx, { precheckStatus: 'unknown' })
    var garment = await injectAsset(ctx, { kind: 'GARMENT', fileID: IDS.garment })
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [person.assetId],
      garmentAssetId: garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(3000)
    expect(ctx.store.__countTasks()).toBe(0)
    var user = await ctx.store.getUser(USER)
    expect(user.usedToday).toBe(0)
  })

  test('越权 assetId → 1004（对外 404），不泄露资产是否存在', async function () {
    var ctx = await withConsentUser()
    var otherPerson = await injectAsset(ctx, { openid: OTHER, kind: 'PERSON', fileID: IDS.otherPerson })
    var garment = await injectAsset(ctx, { kind: 'GARMENT', fileID: IDS.garment })
    var res = await ctx.call('createTask', {
      clientReqId: newUuid(),
      personAssetIds: [otherPerson.assetId],
      garmentAssetId: garment.assetId,
      metrics: DEFAULT_METRICS
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1004)
    expect(res.error.httpStatus).toBe(404)
  })

  test('gender 缺省 unspecified + 三围 → 中性映射；非法 gender → E_PARAM', async function () {
    var ctx = await withConsentUser()
    var metrics = { heightCm: 168, weightKg: 60, chestCm: 88, waistCm: 72, hipCm: 94 }
    var created = await createTaskWithAssets(ctx, { metrics: metrics })
    expect(created.res.ok).toBe(true)
    var task = await ctx.store.getTask(created.res.data.taskId)
    expect(task.metrics.gender).toBe('unspecified')
    expect(task.sizeResult.standard).toBe('GB/T 1335（中性映射）')

    var ctx2 = await withConsentUser()
    var invalid = await createTaskWithAssets(ctx2, {
      metrics: { heightCm: 170, weightKg: 60, gender: 'robot' }
    })
    expect(invalid.res.ok).toBe(false)
    expect(invalid.res.error.code).toBe(1001)
  })

  test('三围全缺 → sizeResult=null（不编造区间）', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx, {
      metrics: { heightCm: 175, weightKg: 70, gender: 'male' }
    })
    expect(created.res.ok).toBe(true)
    var task = await ctx.store.getTask(created.res.data.taskId)
    expect(task.sizeResult).toBeNull()
  })

  test('供应商提交失败 → 5001，任务 FAILED 且额度幂等返还一次', async function () {
    var ctx = await withConsentUser({ scenario: 'submit_error' })
    var created = await createTaskWithAssets(ctx)
    expect(created.res.ok).toBe(false)
    expect(created.res.error.code).toBe(5001)
    expect(ctx.store.__countTasks()).toBe(1)
    var snapshot = ctx.store.__snapshot()
    var taskId = Object.keys(snapshot.tasks)[0]
    var task = snapshot.tasks[taskId]
    expect(task).not.toBeNull()
    expect(task.status).toBe('FAILED')
    expect(task.quotaRefunded).toBe(true)
    var user = await ctx.store.getUser(USER)
    expect(user.usedToday).toBe(0)
    expect(user.activeTaskId).toBeNull()
  })
})

describe('DEV-0001-03 taskGet：状态机、超时、失败映射、结果转存', function () {
  const FAST = { queueMs: 100, generateMs: 600 }

  test('QUEUED → GENERATING → SUCCEEDED(DONE)，结果转存云存储并返回尺码', async function () {
    var ctx = await withConsentUser(FAST)
    var created = await createTaskWithAssets(ctx)
    var taskId = created.res.data.taskId

    var queued = await ctx.call('taskGet', { taskId: taskId })
    expect(queued.ok).toBe(true)
    expect(queued.data.status).toBe('QUEUED')
    expect(queued.data.stage).toBe('QUEUED')

    ctx.clock.advance(150)
    var generating = await ctx.call('taskGet', { taskId: taskId })
    expect(generating.data.status).toBe('GENERATING')
    expect(generating.data.stage).toBe('GENERATING')
    expect(generating.data.waitedSec).toBeGreaterThanOrEqual(0)

    ctx.clock.advance(700)
    var done = await ctx.call('taskGet', { taskId: taskId })
    expect(done.ok).toBe(true)
    expect(done.data.status).toBe('SUCCEEDED')
    expect(done.data.stage).toBe('DONE')
    expect(done.data.result.fileID).toBe('cloud://test/result/' + taskId + '.png')
    expect(done.data.result.width).toBe(2048)
    expect(done.data.result.sizeResult.rangeMin).toBe('L')
    expect(ctx.storage.__resultUploads()).toHaveLength(1)
    expect(ctx.vendor.__calls().erase).toBeGreaterThanOrEqual(1)
    expect((await ctx.store.getTask(taskId)).status).toBe('SUCCEEDED')
  })

  test('结果长边 <2048 → result.sizeFallback（CP-07 降级复核标记）', async function () {
    var ctx = await withConsentUser(Object.assign({ width: 1152, height: 1536 }, FAST))
    var created = await createTaskWithAssets(ctx)
    ctx.clock.advance(800)
    var done = await ctx.call('taskGet', { taskId: created.res.data.taskId })
    expect(done.data.result.sizeFallback).toEqual({
      degraded: true,
      longSide: 1536,
      expected: 2048,
      requiresReview: true
    })
  })

  test('60s 超时（注入 1s）→ TIMEOUT + 额度只返还一次；重复 taskGet 不重复返', async function () {
    var ctx = await withConsentUser(Object.assign({ taskTimeoutMs: 1000, scenario: 'timeout' }, FAST))
    var created = await createTaskWithAssets(ctx)
    var taskId = created.res.data.taskId
    ctx.clock.advance(1500)

    var timedOut = await ctx.call('taskGet', { taskId: taskId })
    expect(timedOut.ok).toBe(true)
    expect(timedOut.data.status).toBe('TIMEOUT')
    expect(timedOut.data.failure.code).toBe(5002)
    var user = await ctx.store.getUser(USER)
    expect(user.usedToday).toBe(0)
    expect((await ctx.store.getTask(taskId)).quotaRefunded).toBe(true)

    var again = await ctx.call('taskGet', { taskId: taskId })
    expect(again.data.status).toBe('TIMEOUT')
    var userAfter = await ctx.store.getUser(USER)
    expect(userAfter.usedToday).toBe(0)
  })

  test('SINN_TASK_TIMEOUT_MS 覆写 300000ms → 60s 后仍 QUEUED/GENERATING 不判 TIMEOUT，超阈值才 TIMEOUT', async function () {
    var ctx = await withConsentUser(Object.assign({ taskTimeoutMs: 300000, scenario: 'timeout' }, FAST))
    var created = await createTaskWithAssets(ctx)
    var taskId = created.res.data.taskId

    ctx.clock.advance(61000)
    var waiting = await ctx.call('taskGet', { taskId: taskId })
    expect(waiting.ok).toBe(true)
    expect(['QUEUED', 'GENERATING']).toContain(waiting.data.status)
    expect(waiting.data.failure).toBeUndefined()
    expect((await ctx.store.getTask(taskId)).status).not.toBe('TIMEOUT')

    ctx.clock.advance(240000)
    var timedOut = await ctx.call('taskGet', { taskId: taskId })
    expect(timedOut.data.status).toBe('TIMEOUT')
    expect(timedOut.data.failure.code).toBe(5002)
  })

  test('供应商内容拦截 → FAILED + 4001 E_CONTENT_BLOCKED，额度返还', async function () {
    var ctx = await withConsentUser({ scenario: 'content_blocked', queueMs: 10 })
    var created = await createTaskWithAssets(ctx)
    ctx.clock.advance(50)
    var res = await ctx.call('taskGet', { taskId: created.res.data.taskId })
    expect(res.data.status).toBe('FAILED')
    expect(res.data.failure.code).toBe(4001)
    expect(res.data.failure.name).toBe('E_CONTENT_BLOCKED')
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
  })

  test('供应商返回不可识别状态 → 5005 E_VENDOR_RESPONSE_INVALID', async function () {
    var ctx = await withConsentUser({ scenario: 'invalid_response' })
    var created = await createTaskWithAssets(ctx)
    var res = await ctx.call('taskGet', { taskId: created.res.data.taskId })
    expect(res.data.status).toBe('FAILED')
    expect(res.data.failure.code).toBe(5005)
  })

  test('他人任务 / 不存在任务 → 5004 E_TASK_NOT_FOUND 404（不泄露存在性）', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    await fixtures.seedConsentUser(ctx.store, OTHER)
    var other = await ctx.call('taskGet', { taskId: created.res.data.taskId }, OTHER)
    expect(other.ok).toBe(false)
    expect(other.error.code).toBe(5004)
    expect(other.error.httpStatus).toBe(404)

    var missing = await ctx.call('taskGet', { taskId: 't_' + '0'.repeat(24) })
    expect(missing.ok).toBe(false)
    expect(missing.error.code).toBe(5004)
  })
})

describe('DEV-0001-03 cancelTask / deleteTask（物理全删，无墓碑）', function () {
  test('取消进行中任务 → CANCELLED + 额度返还；重复取消幂等', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    var taskId = created.res.data.taskId

    var cancelled = await ctx.call('cancelTask', { taskId: taskId })
    expect(cancelled.ok).toBe(true)
    expect(cancelled.data.status).toBe('CANCELLED')
    expect(cancelled.data.quota.remaining).toBe(1)
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
    expect((await ctx.store.getUser(USER)).activeTaskId).toBeNull()

    var again = await ctx.call('cancelTask', { taskId: taskId })
    expect(again.ok).toBe(true)
    expect(again.data.status).toBe('CANCELLED')
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
  })

  test('已成功任务不可取消 → E_PARAM 1001', async function () {
    var ctx = await withConsentUser({ queueMs: 10, generateMs: 20 })
    var created = await createTaskWithAssets(ctx)
    ctx.clock.advance(100)
    await ctx.call('taskGet', { taskId: created.res.data.taskId })
    var res = await ctx.call('cancelTask', { taskId: created.res.data.taskId })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1001)
  })

  test('deleteTask：物理删任务/资产/云存储对象，返回 deletedAt；重复删除 404', async function () {
    var ctx = await withConsentUser({ queueMs: 10, generateMs: 20 })
    var created = await createTaskWithAssets(ctx)
    var taskId = created.res.data.taskId
    ctx.clock.advance(100)
    await ctx.call('taskGet', { taskId: taskId })

    var deleted = await ctx.call('deleteTask', { taskId: taskId })
    expect(deleted.ok).toBe(true)
    expect(typeof deleted.data.deletedAt).toBe('number')
    expect(await ctx.store.getTask(taskId)).toBeNull()
    expect(ctx.store.__countTasks()).toBe(0)
    expect(ctx.store.__countAssets()).toBe(0)
    expect(ctx.storage.__deleted()).toContain('cloud://test/result/' + taskId + '.png')
    expect((await ctx.store.getUser(USER)).activeTaskId).toBeNull()

    var again = await ctx.call('deleteTask', { taskId: taskId })
    expect(again.ok).toBe(false)
    expect(again.error.code).toBe(5004)
  })

  test('进行中任务直接删除：等价取消并返还额度', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    var deleted = await ctx.call('deleteTask', { taskId: created.res.data.taskId })
    expect(deleted.ok).toBe(true)
    expect((await ctx.store.getUser(USER)).usedToday).toBe(0)
    expect(ctx.store.__countTasks()).toBe(0)
  })

  test('云存储删除失败 → E_INTERNAL 9000 且数据库记录保留（不留中间态）', async function () {
    var ctx = await withConsentUser({
      storage: fixtures.makeStorage({ failDelete: true })
    })
    var created = await createTaskWithAssets(ctx)
    var res = await ctx.call('deleteTask', { taskId: created.res.data.taskId })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(9000)
    expect(await ctx.store.getTask(created.res.data.taskId)).not.toBeNull()
    expect(ctx.store.__countAssets()).toBe(2)
  })

  test('auditTask：删除后 exists=false；删除前资产/结果可审计（CP-08）', async function () {
    var ctx = await withConsentUser({ openid: QA, queueMs: 10, generateMs: 20 })
    var created = await createTaskWithAssets(ctx, { openid: QA })
    var taskId = created.res.data.taskId

    var before = await ctx.call('auditTask', { taskId: taskId }, QA)
    expect(before.ok).toBe(true)
    expect(before.data.exists).toBe(true)
    expect(before.data.task.status).toBe('QUEUED')
    expect(before.data.assets).toHaveLength(2)
    expect(before.data.result.exists).toBe(false)

    ctx.clock.advance(100)
    await ctx.call('taskGet', { taskId: taskId }, QA)
    var successAudit = await ctx.call('auditTask', { taskId: taskId }, QA)
    expect(successAudit.data.result.exists).toBe(true)
    expect(successAudit.data.task.status).toBe('SUCCEEDED')

    await ctx.call('deleteTask', { taskId: taskId }, QA)
    var after = await ctx.call('auditTask', { taskId: taskId }, QA)
    expect(after.ok).toBe(true)
    expect(after.data.exists).toBe(false)
  })

  test('auditTask 非白名单 / 未开启 → 1004', async function () {
    var ctx = await withConsentUser()
    var created = await createTaskWithAssets(ctx)
    var notQa = await ctx.call('auditTask', { taskId: created.res.data.taskId }, USER)
    expect(notQa.ok).toBe(false)
    expect(notQa.error.code).toBe(1004)

    var ctxDisabled = await withConsentUser({ env: { ALLOW_DEBUG_AUDIT: 'false' } })
    var created2 = await createTaskWithAssets(ctxDisabled)
    var disabled = await ctxDisabled.call('auditTask', { taskId: created2.res.data.taskId })
    expect(disabled.ok).toBe(false)
    expect(disabled.error.code).toBe(1004)
  })
})
