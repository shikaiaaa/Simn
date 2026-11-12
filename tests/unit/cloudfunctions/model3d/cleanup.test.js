/**
 * tests/unit/cloudfunctions/model3d/cleanup.test.js —— sinn-cleanup 3D 分支。
 *
 * 使用 P1 的 memory-store/fake storage，覆盖：
 * - 失败/超时 3D 任务到期：输入照片对象+资产记录+任务记录物理删除；
 * - 成功 3D 任务到期：只清输入照片，模型长期保留（任务 purgeAt 置 null）；
 * - 未到期/2D 任务不受影响；与 P1 handler 组合后计数正确。
 */
'use strict'

var createMemoryStore = require('../../../../cloudfunctions/sinn-task/lib/store/memory-store').createMemoryStore
var model3dCleanup = require('../../../../cloudfunctions/sinn-cleanup/lib/model3d-cleanup')
var createCleanupHandler = require('../../../../cloudfunctions/sinn-cleanup/lib/handler').createHandler

var START = 1794444000000
var HOUR = 60 * 60 * 1000
var USER = 'o_cleanup_user'

function makeStorage() {
  var deletions = []
  return {
    deleteFiles: function (fileIDs) {
      deletions.push((fileIDs || []).slice())
      return Promise.resolve({ deleted: [], failed: [] })
    },
    __deletions: function () { return deletions.slice() }
  }
}

async function seedTask(store, overrides) {
  var task = Object.assign(
    {
      taskId: 't_' + 'a'.repeat(24),
      openid: USER,
      clientReqId: '11111111-1111-4111-8111-000000000001',
      taskType: '3D_MODEL',
      status: 'FAILED',
      stage: 'FAILED',
      vendorProvider: 'mock',
      vendorJobId: 'mock3d_1_1',
      createdAt: START - 24 * HOUR,
      purgeAt: START - HOUR,
      failureCode: 6002
    },
    overrides || {}
  )
  await store.saveTask(task)
  return task
}

async function seedAsset(store, taskId, index) {
  var asset = {
    assetId: 'a_' + ((index || 1) + 'd'.repeat(23)).slice(0, 24),
    openid: USER,
    kind: 'person',
    fileID: 'cloud://photo/' + (index || 1) + '.jpg',
    cloudPath: 'photo/' + (index || 1) + '.jpg',
    mime: 'image/jpeg',
    bytes: 1000,
    width: 1024,
    height: 1536,
    createdAt: START - 24 * HOUR,
    purgeAt: START - HOUR,
    taskId: taskId
  }
  await store.saveAsset(asset)
  return asset
}

describe('model3d-cleanup.run', function () {
  test('失败 3D 任务到期：照片对象 + 资产 + 任务全删', async function () {
    var store = createMemoryStore()
    var storage = makeStorage()
    var task = await seedTask(store)
    await seedAsset(store, task.taskId, 1)
    await seedAsset(store, task.taskId, 2)
    var result = await model3dCleanup.run({ store: store, storage: storage }, START, 100)
    expect(result).toMatchObject({ scanned: 1, deleted: 1, failed: 0, photosPurged: 2, modelsKept: 0 })
    expect(storage.__deletions()[0].length).toBe(2)
    expect(await store.getTask(task.taskId)).toBeNull()
    expect((await store.listAssetsByTaskId(task.taskId)).length).toBe(0)
  })

  test('成功 3D 任务到期：只清照片，模型任务保留且 purgeAt=null', async function () {
    var store = createMemoryStore()
    var storage = makeStorage()
    var task = await seedTask(store, {
      taskId: 't_' + 'b'.repeat(24),
      status: 'SUCCEEDED',
      stage: 'DONE',
      modelId: 'm_' + 'c'.repeat(24),
      purgeAt: START - HOUR
    })
    await seedAsset(store, task.taskId, 3)
    var result = await model3dCleanup.run({ store: store, storage: storage }, START, 100)
    expect(result).toMatchObject({ scanned: 1, deleted: 0, failed: 0, photosPurged: 1, modelsKept: 1 })
    var kept = await store.getTask(task.taskId)
    expect(kept.status).toBe('SUCCEEDED')
    expect(kept.modelId).toBe(task.modelId)
    expect(kept.purgeAt).toBeNull()
    expect(kept.assetsPurgedAt).toBe(START)
    expect((await store.listAssetsByTaskId(task.taskId)).length).toBe(0)
  })

  test('未到期任务不处理；2D 任务不处理', async function () {
    var store = createMemoryStore()
    var storage = makeStorage()
    await seedTask(store, { taskId: 't_' + 'e'.repeat(24), purgeAt: START + HOUR })
    await seedTask(store, {
      taskId: 't_' + 'f'.repeat(24),
      taskType: '2D_TRYON',
      purgeAt: START - HOUR
    })
    var result = await model3dCleanup.run({ store: store, storage: storage }, START, 100)
    expect(result.scanned).toBe(0)
    expect(result.deleted).toBe(0)
    expect(store.__countTasks()).toBe(2)
  })

  test('单条失败不阻塞批次', async function () {
    var store = createMemoryStore()
    var storage = makeStorage()
    var taskA = await seedTask(store, { taskId: 't_' + '1'.repeat(24) })
    await seedTask(store, { taskId: 't_' + '2'.repeat(24) })
    await seedAsset(store, taskA.taskId, 1)
    var originalDelete = storage.deleteFiles
    storage.deleteFiles = function (fileIDs) {
      if (fileIDs && fileIDs.length && fileIDs[0].indexOf('1.jpg') >= 0) {
        return Promise.reject(new Error('storage down'))
      }
      return originalDelete(fileIDs)
    }
    var result = await model3dCleanup.run({ store: store, storage: storage }, START, 100)
    expect(result.scanned).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.errors[0].taskId).toBe(taskA.taskId)
  })
})

describe('sinn-cleanup handler 组合（3D + 2D）', function () {
  test('data 统计合并 3D/2D，3D 成功任务保留、2D 到期任务删除', async function () {
    var store = createMemoryStore()
    var storage = makeStorage()
    var threeDFailed = await seedTask(store, { taskId: 't_' + '3'.repeat(24) })
    await seedAsset(store, threeDFailed.taskId, 1)
    await seedTask(store, {
      taskId: 't_' + '4'.repeat(24),
      status: 'SUCCEEDED',
      stage: 'DONE',
      modelId: 'm_' + '5'.repeat(24),
      purgeAt: START - HOUR
    })
    await seedTask(store, {
      taskId: 't_' + '6'.repeat(24),
      taskType: '2D_TRYON',
      status: 'SUCCEEDED',
      stage: 'DONE',
      purgeAt: START - HOUR
    })
    var handler = createCleanupHandler({
      store: store,
      storage: storage,
      now: function () { return START },
      batchSize: 100,
      logger: { log: function () {}, error: function () {} }
    })
    var res = await handler.handle()
    expect(res.ok).toBe(true)
    expect(res.data.scanned).toBe(3)
    expect(res.data.deleted).toBe(2) // 3D 失败 + 2D
    expect(res.data.failed).toBe(0)
    expect(res.data.photosPurged).toBe(1)
    expect(res.data.modelsKept).toBe(1)
    expect(store.__countTasks()).toBe(1) // 只剩成功 3D 任务（模型长期保留）
  })
})
