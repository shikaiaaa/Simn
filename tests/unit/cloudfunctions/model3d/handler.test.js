/**
 * tests/unit/cloudfunctions/model3d/handler.test.js —— sinn-model3d 业务链路（SPEC-0002 §B.2/§2/§3）。
 */
'use strict'

var helpers = require('./helpers')
var util = require('../../../../cloudfunctions/sinn-model3d/lib/util')
var errors = require('../../../../cloudfunctions/sinn-model3d/lib/errors')

var USER = helpers.USER
var OTHER = helpers.OTHER
var MB = helpers.MB

describe('sinn-model3d handler —— 提交（API-02-01）', function () {
  test('合法请求：建 QUEUED 任务并提交供应商，返回 taskId/vendorProvider', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var asset = await helpers.seedPersonAsset(ctx.store, USER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload({ personAssetIds: [asset.assetId] }))
    expect(res.ok).toBe(true)
    expect(res.requestId).toBe('req-test')
    expect(res.serverTime).toBe(ctx.clock.now())
    expect(res.data.status).toBe('QUEUED')
    expect(res.data.taskId).toMatch(/^t_[0-9a-f]{24}$/)
    expect(res.data.vendorProvider).toBe('mock')
    var task = await ctx.store.getTask(res.data.taskId)
    expect(task.status).toBe('GENERATING')
    expect(task.stage).toBe('MODELING')
    expect(task.vendorJobId).toMatch(/^mock3d_/)
    expect(task.taskType).toBe('3D_MODEL')
    expect(task.purgeAt).toBe(task.createdAt + util.PURGE_TTL_MS)
    expect(task.failure).toBeNull()
    var user = await ctx.store.getUser(USER)
    expect(user.activeModel3dTaskId).toBe(task.taskId)
    expect(user.model3dUsedToday).toBe(1)
    // 人像资产已绑定 taskId（供 cleanup 物理删除）
    expect((await ctx.store.getAsset(asset.assetId)).taskId).toBe(task.taskId)
  })

  test('同一 clientReqId 幂等：返回同一 taskId 且不重复提交供应商', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var asset = await helpers.seedPersonAsset(ctx.store, USER)
    var payload = helpers.personPayload({ personAssetIds: [asset.assetId] })
    var first = await ctx.call('model3dSubmit', payload)
    var second = await ctx.call('model3dSubmit', payload)
    expect(second.ok).toBe(true)
    expect(second.data.taskId).toBe(first.data.taskId)
    expect(ctx.vendor.__calls().submit).toBe(1)
  })

  test('未同意 → 1003 E_CONSENT_REQUIRED', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedPersonAsset(ctx.store, USER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload())
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1003)
  })

  test('clientReqId 非法 → 1001', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    await helpers.seedPersonAsset(ctx.store, USER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload({ clientReqId: 'not-a-uuid' }))
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1001)
  })

  test('personAssetIds 数量/重复/格式非法 → 1001', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var a = helpers.makeAssetId(1)
    var b = helpers.makeAssetId(2)
    var c = helpers.makeAssetId(3)
    var d = helpers.makeAssetId(4)
    var tooMany = await ctx.call('model3dSubmit', helpers.personPayload({ personAssetIds: [a, b, c, d] }))
    expect(tooMany.error.code).toBe(1001)
    var duplicate = await ctx.call('model3dSubmit', helpers.personPayload({ personAssetIds: [a, a] }))
    expect(duplicate.error.code).toBe(1001)
    var bad = await ctx.call('model3dSubmit', helpers.personPayload({ personAssetIds: ['not-an-asset'] }))
    expect(bad.error.code).toBe(1001)
  })

  test('他人资产 → 1001（不泄露存在性）', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var otherAsset = await helpers.seedPersonAsset(ctx.store, OTHER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload({ personAssetIds: [otherAsset.assetId] }))
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1001)
  })

  test('人像超出供应商规格（bytes/长边/MIME）→ 3015 且不建任务不扣日额度', async function () {
    var cases = [
      { bytes: 6 * MB },
      { width: 5000, height: 3000 },
      { mime: 'image/png' }
    ]
    for (var i = 0; i < cases.length; i += 1) {
      var ctx = helpers.makeContext()
      await helpers.seedConsentUser(ctx.store, USER)
      var asset = await helpers.seedPersonAsset(ctx.store, USER, Object.assign({ index: i + 1 }, cases[i]))
      var res = await ctx.call('model3dSubmit', helpers.personPayload({ clientReqId: helpers.makeUuid(i + 20), personAssetIds: [asset.assetId] }))
      expect(res.ok).toBe(false)
      expect(res.error.code).toBe(3015)
      expect(ctx.store.__countTasks()).toBe(0)
      expect((await ctx.store.getUser(USER)).model3dUsedToday).toBe(0)
    }
  })

  test('并发进行中 → 2002 并带 existingTaskId', async function () {
    var ctx = helpers.makeContext()
    var submitted = await helpers.withSubmittedTask(ctx)
    var asset = await helpers.seedPersonAsset(ctx.store, USER, { index: 9 })
    var res = await ctx.call('model3dSubmit', helpers.personPayload({ clientReqId: helpers.makeUuid(30), personAssetIds: [asset.assetId] }))
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(2002)
    // 错误信封不含详情字段，但任务数仍为 1，且没有新任务写入
    expect(ctx.store.__countTasks()).toBe(1)
    expect(submitted.res.ok).toBe(true)
  })

  test('日上限用尽 → 6006（配置 1 次）', async function () {
    var ctx = helpers.makeContext({ dailyLimit: 1 })
    await helpers.seedConsentUser(ctx.store, USER, {
      model3dUsedDayKey: util.beijingDayKey(ctx.clock.now()),
      model3dUsedToday: 1
    })
    await helpers.seedPersonAsset(ctx.store, USER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload())
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(6006)
    expect(ctx.store.__countTasks()).toBe(0)
    expect(ctx.vendor.__calls().submit).toBe(0)
  })

  test('未知 action → 1001；缺 openid → 1001', async function () {
    var ctx = helpers.makeContext()
    var unknown = await ctx.call('model3dNope', {})
    expect(unknown.ok).toBe(false)
    expect(unknown.error.code).toBe(1001)
    var noOpenid = await ctx.handler.handle({ action: 'model3dList', payload: {} }, {})
    expect(noOpenid.ok).toBe(false)
    expect(noOpenid.error.code).toBe(1001)
  })

  test('供应商提交失败（缺凭证/网络）→ 任务 FAILED 6001 且退还日额度', async function () {
    var ctx = helpers.makeContext()
    ctx.vendor.submit = function () { return Promise.reject(errors.fail(6001, { hint: '供应商不可用' })) }
    await helpers.seedConsentUser(ctx.store, USER)
    var asset = await helpers.seedPersonAsset(ctx.store, USER)
    var res = await ctx.call('model3dSubmit', helpers.personPayload())
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(6001)
    var tasks = await ctx.store.listTasksByOpenid(USER)
    expect(tasks.length).toBe(1)
    expect(tasks[0].status).toBe('FAILED')
    expect(tasks[0].failure.code).toBe(6001)
    expect(tasks[0].failure.name).toBe('E_MODEL3D_UNAVAILABLE')
    expect((await ctx.store.getUser(USER)).model3dUsedToday).toBe(0)
  })
})

describe('sinn-model3d handler —— 查询（API-02-02）', function () {
  test('mock 到点成功：SUCCEEDED + 模型入库 + 临时 URL', async function () {
    var ctx = helpers.makeContext({ delayMs: 3000 })
    var submitted = await helpers.withSubmittedTask(ctx)
    ctx.clock.advance(3001)
    var res = await ctx.call('model3dGet', { taskId: submitted.taskId })
    expect(res.ok).toBe(true)
    expect(res.data.status).toBe('SUCCEEDED')
    expect(res.data.stage).toBe('DONE')
    expect(res.data.modelId).toMatch(/^m_[0-9a-f]{24}$/)
    expect(res.data.model.format).toBe('glb')
    expect(res.data.model.modelFileID).toBeTruthy()
    expect(res.data.model.modelUrl).toContain('https://fake.tcb/')
    expect(res.data.model.bytes).toBeGreaterThan(0)
    expect(res.data.model.triangleCount).toBe(0) // mock GLB 无 POSITION/indices
    expect(res.data.failure).toBeNull()
    expect(ctx.store.__countModels()).toBe(1)
    var model = await ctx.store.getModel(res.data.modelId)
    expect(model.status).toBe('READY')
    expect(model.openid).toBe(USER)
    expect(model.taskId).toBe(submitted.taskId)
    var task = await ctx.store.getTask(submitted.taskId)
    expect(task.status).toBe('SUCCEEDED')
    expect(task.purgeAt).toBe(task.createdAt + util.PURGE_TTL_MS)
    // 成功任务不重复处理
    var again = await ctx.call('model3dGet', { taskId: submitted.taskId })
    expect(again.data.status).toBe('SUCCEEDED')
    expect(ctx.store.__countModels()).toBe(1)
  })

  test('PENDING/BUILDING/TEXTURING 阶段映射', async function () {
    var ctx = helpers.makeContext({ delayMs: 3000 })
    var submitted = await helpers.withSubmittedTask(ctx)
    var queued = await ctx.call('model3dGet', { taskId: submitted.taskId })
    expect(queued.data.status).toBe('GENERATING')
    expect(queued.data.stage).toBe('MODELING')

    ctx.clock.advance(2000) // elapsed 2000 in [delay*0.35, delay)
    var building = await ctx.call('model3dGet', { taskId: submitted.taskId })
    expect(building.data.status).toBe('GENERATING')
    expect(building.data.stage).toBe('MODELING')
    expect(building.data.progress.elapsedMs).toBeGreaterThanOrEqual(2000)
  })

  test('服务端超时：TIMEOUT 5002（不涉及 2D 额度）', async function () {
    var ctx = helpers.makeContext({ delayMs: 3000, fail: 'timeout', timeoutMs: 1000 })
    var submitted = await helpers.withSubmittedTask(ctx)
    ctx.clock.advance(1500)
    var res = await ctx.call('model3dGet', { taskId: submitted.taskId })
    expect(res.ok).toBe(true)
    expect(res.data.status).toBe('TIMEOUT')
    expect(res.data.failure.code).toBe(5002)
    expect(res.data.failure.name).toBe('E_TIMEOUT')
    expect(res.data.failure.at).toBe(ctx.clock.now())
  })

  test('供应商 FAILED → 任务 FAILED 6002，failure 含 vendorCode/httpStatus', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    await helpers.seedPersonAsset(ctx.store, USER)
    await helpers.withSubmittedTask(ctx)
    ctx.vendor.query = function () {
      return Promise.resolve({ status: 'FAILED', failureCode: '50411', httpStatus: 400, failureMessage: 'risk blocked' })
    }
    var tasks = await ctx.store.listTasksByOpenid(USER)
    var res = await ctx.call('model3dGet', { taskId: tasks[0].taskId })
    expect(res.data.status).toBe('FAILED')
    expect(res.data.failure.code).toBe(6002)
    expect(res.data.failure.vendorCode).toBe('50411')
    expect(res.data.failure.httpStatus).toBe(400)
    expect(res.data.failure.at).toBe(ctx.clock.now())
  })

  test('供应商查询异常（网络）→ FAILED 6001；损坏 GLB → FAILED 6002 且不写模型', async function () {
    var ctx = helpers.makeContext()
    await helpers.withSubmittedTask(ctx)
    var tasks = await ctx.store.listTasksByOpenid(USER)
    ctx.vendor.query = function () { return Promise.reject(errors.fail(6001, { hint: 'net down' })) }
    var failed = await ctx.call('model3dGet', { taskId: tasks[0].taskId })
    expect(failed.data.status).toBe('FAILED')
    expect(failed.data.failure.code).toBe(6001)

    var ctx2 = helpers.makeContext({ delayMs: 1000, fail: 'corrupt' })
    var submitted2 = await helpers.withSubmittedTask(ctx2)
    ctx2.clock.advance(1001)
    var corrupt = await ctx2.call('model3dGet', { taskId: submitted2.taskId })
    expect(corrupt.data.status).toBe('FAILED')
    expect(corrupt.data.failure.code).toBe(6002)
    expect(ctx2.store.__countModels()).toBe(0)
  })

  test('不存在/他人任务 → 5004', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var missing = await ctx.call('model3dGet', { taskId: 't_' + '0'.repeat(24) })
    expect(missing.ok).toBe(false)
    expect(missing.error.code).toBe(5004)
    var submitted = await helpers.withSubmittedTask(ctx, OTHER)
    var cross = await ctx.call('model3dGet', { taskId: submitted.taskId }, USER)
    expect(cross.ok).toBe(false)
    expect(cross.error.code).toBe(5004)
  })

  test('taskId 格式非法 → 1001', async function () {
    var ctx = helpers.makeContext()
    var res = await ctx.call('model3dGet', { taskId: 'bad-id' })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1001)
  })
})

describe('sinn-model3d handler —— 列表（API-02-03）', function () {
  test('空列表 → items=[]，nextCursor=null', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var res = await ctx.call('model3dList', {})
    expect(res.ok).toBe(true)
    expect(res.data.items).toEqual([])
    expect(res.data.nextCursor).toBeNull()
  })

  test('成功模型出现在列表；limit/cursor 分页', async function () {
    var ctx = helpers.makeContext({ delayMs: 1000 })
    await helpers.seedConsentUser(ctx.store, USER)
    var asset = await helpers.seedPersonAsset(ctx.store, USER)
    var taskIds = []
    for (var i = 0; i < 3; i += 1) {
      var submitted = await ctx.call('model3dSubmit', helpers.personPayload({ clientReqId: helpers.makeUuid(40 + i), personAssetIds: [asset.assetId] }))
      taskIds.push(submitted.data.taskId)
      ctx.clock.advance(1001)
      var got = await ctx.call('model3dGet', { taskId: submitted.data.taskId })
      expect(got.data.status).toBe('SUCCEEDED')
      ctx.clock.advance(10)
    }
    var page1 = await ctx.call('model3dList', { limit: 2 })
    expect(page1.data.items.length).toBe(2)
    expect(page1.data.nextCursor).toBeTruthy()
    expect(page1.data.items[0].status).toBe('READY')
    expect(page1.data.items[0].modelBytes).toBeGreaterThan(0)
    var page2 = await ctx.call('model3dList', { limit: 2, cursor: page1.data.nextCursor })
    expect(page2.data.items.length).toBe(1)
    expect(page2.data.nextCursor).toBeNull()
    expect(ctx.store.__countModels()).toBe(3)
  })

  test('limit 非法 / cursor 非法 → 1001', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var badLimit = await ctx.call('model3dList', { limit: 21 })
    expect(badLimit.error.code).toBe(1001)
    var badCursor = await ctx.call('model3dList', { cursor: '%%%' })
    expect(badCursor.error.code).toBe(1001)
  })
})

describe('sinn-model3d handler —— 删除（API-02-04/05）', function () {
  async function seedSuccessModel(ctx, openid) {
    var submitted = await helpers.withSubmittedTask(ctx, openid, { clientReqId: helpers.makeUuid(50) })
    ctx.clock.advance(4000)
    var got = await ctx.call('model3dGet', { taskId: submitted.taskId }, openid)
    expect(got.data.status).toBe('SUCCEEDED')
    return got.data
  }

  test('删除单个模型：对象+模型记录+关联任务物理删除', async function () {
    var ctx = helpers.makeContext({ delayMs: 3000 })
    await helpers.seedConsentUser(ctx.store, USER)
    var data = await seedSuccessModel(ctx, USER)
    var res = await ctx.call('model3dDelete', { modelId: data.modelId })
    expect(res.ok).toBe(true)
    expect(res.data.deletedAt).toBe(ctx.clock.now())
    expect(await ctx.store.getModel(data.modelId)).toBeNull()
    var tasks = await ctx.store.listTasksByOpenid(USER)
    expect(tasks.length).toBe(0)
    expect(ctx.storage.__deletions().length).toBeGreaterThan(0)
  })

  test('删除他人/不存在模型 → 5004；modelId 非法 → 1001', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var foreign = await seedSuccessModel(ctx, OTHER)
    var cross = await ctx.call('model3dDelete', { modelId: foreign.modelId }, USER)
    expect(cross.ok).toBe(false)
    expect(cross.error.code).toBe(5004)
    var missing = await ctx.call('model3dDelete', { modelId: 'm_' + '0'.repeat(24) })
    expect(missing.error.code).toBe(5004)
    var bad = await ctx.call('model3dDelete', { modelId: 'bad' })
    expect(bad.error.code).toBe(1001)
  })

  test('deleteAll：清空当前用户 3D 模型/任务，他人数据不受影响', async function () {
    var ctx = helpers.makeContext({ delayMs: 3000 })
    await helpers.seedConsentUser(ctx.store, USER)
    await helpers.seedConsentUser(ctx.store, OTHER)
    await seedSuccessModel(ctx, USER)
    var otherModel = await seedSuccessModel(ctx, OTHER)
    var res = await ctx.call('model3dDeleteAll', {})
    expect(res.ok).toBe(true)
    expect(res.data.deletedModels).toBe(1)
    expect(res.data.deletedTasks).toBe(1)
    expect(res.data.deletedAt).toBe(ctx.clock.now())
    expect(await ctx.store.listModels(USER, { limit: 20 })).toMatchObject({ items: [] })
    expect(ctx.store.__countModels()).toBe(1)
    expect(await ctx.store.getModel(otherModel.modelId)).toBeTruthy()
    expect((await ctx.store.getUser(USER)).activeModel3dTaskId).toBeNull()
  })

  test('deleteAll 幂等：空数据返回 0', async function () {
    var ctx = helpers.makeContext()
    await helpers.seedConsentUser(ctx.store, USER)
    var res = await ctx.call('model3dDeleteAll', {})
    expect(res.ok).toBe(true)
    expect(res.data.deletedModels).toBe(0)
    expect(res.data.deletedTasks).toBe(0)
  })
})
