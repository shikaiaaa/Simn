/**
 * DEV-0001-04：sinn-cleanup 单测（SPEC §4 / API-13）。
 * 覆盖：定时触发器配置、按 purgeAt 物理清理、单条失败不阻塞、批次上限、幂等、无墓碑字段。
 */
'use strict'

var fx = require('./fixtures')

function makeFailingStorage() {
  var deleted = []
  return {
    download: function () { return Promise.resolve(Buffer.from('image')) },
    saveResult: function () { return Promise.reject(new Error('cleanup 不写结果图')) },
    deleteFiles: function (fileIDs) {
      var bad = fileIDs.some(function (fileID) { return fileID.indexOf('bad') >= 0 })
      if (bad) return Promise.reject(new Error('mock storage: delete failed for bad file'))
      deleted = deleted.concat(fileIDs)
      return Promise.resolve({ deleted: fileIDs, failed: [] })
    },
    __deleted: function () { return deleted.slice() }
  }
}

describe('DEV-0001-04 sinn-cleanup', function () {
  test('定时触发器配置：每 10 分钟执行', function () {
    // eslint-disable-next-line global-require
    var config = require('../../../../cloudfunctions/sinn-cleanup/config.json')
    expect(Array.isArray(config.triggers)).toBe(true)
    expect(config.triggers).toHaveLength(1)
    expect(config.triggers[0]).toMatchObject({
      name: 'sinnCleanupEvery10m',
      type: 'timer',
      config: '0 */10 * * * * *'
    })
  })

  test('只物理清理 purgeAt 到期的任务与对象，并写结构化日志', async function () {
    var ctx = fx.makeContext()
    var now = ctx.clock.now()
    var expired = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 1000 })
    var expiredAsset = await fx.seedTaskAsset(ctx.store, expired, { fileID: 'cloud://test/person/expired.jpg' })
    var live = await fx.seedTask(ctx.store, { status: 'QUEUED', purgeAt: now + 60 * 60 * 1000 })
    await fx.seedTaskAsset(ctx.store, live, { fileID: 'cloud://test/person/live.jpg' })
    await fx.seedConsentUser(ctx.store, fx.USER, { usedToday: 1 })

    var res = await ctx.cleanupHandler.handle()
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ scanned: 1, deleted: 1, failed: 0, photosPurged: 0, modelsKept: 0 })
    expect(res.requestId).toBeTruthy()
    expect(ctx.store.__countTasks()).toBe(1)
    expect(ctx.store.__countAssets()).toBe(1)
    expect((await ctx.store.getTask(live.taskId)).taskId).toBe(live.taskId)
    expect(ctx.storage.__deleted()).toEqual([expiredAsset.fileID])
    // 清理不返还已成功任务消耗的额度
    expect((await ctx.store.getUser(fx.USER)).usedToday).toBe(1)

    expect(ctx.logs).toHaveLength(1)
    var log = JSON.parse(ctx.logs[0])
    expect(log).toMatchObject({ action: 'sinn-cleanup', scanned: 1, deleted: 1, failed: 0 })
    expect(typeof log.startedAt).toBe('number')
    expect(typeof log.finishedAt).toBe('number')
  })

  test('单条对象删除失败不阻塞批次，失败任务记录保留', async function () {
    var ctx = fx.makeContext({ storage: makeFailingStorage() })
    var now = ctx.clock.now()
    var bad = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 2000 })
    var badAsset = await fx.seedTaskAsset(ctx.store, bad, { fileID: 'cloud://test/person/bad.jpg' })
    var good = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 1000 })
    var goodAsset = await fx.seedTaskAsset(ctx.store, good, { fileID: 'cloud://test/person/good.jpg' })

    var res = await ctx.cleanupHandler.handle()
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ scanned: 2, deleted: 1, failed: 1 })
    expect(ctx.store.__countTasks()).toBe(1)
    expect((await ctx.store.getTask(bad.taskId)).taskId).toBe(bad.taskId)
    expect(await ctx.store.getTask(good.taskId)).toBeNull()
    expect(ctx.storage.__deleted()).toEqual([goodAsset.fileID])
    expect(badAsset.fileID).toBeTruthy()

    var log = JSON.parse(ctx.logs[0])
    expect(log.failed).toBe(1)
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0].taskId).toBe(bad.taskId)
  })

  test('批次上限生效，剩余任务下次继续清理', async function () {
    var ctx = fx.makeContext({ batchSize: 2 })
    var now = ctx.clock.now()
    var t1 = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 3000 })
    var t2 = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 2000 })
    var t3 = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 1000 })

    var first = await ctx.cleanupHandler.handle()
    expect(first.data).toMatchObject({ scanned: 2, deleted: 2, failed: 0 })
    expect(await ctx.store.getTask(t1.taskId)).toBeNull()
    expect(await ctx.store.getTask(t2.taskId)).toBeNull()
    expect((await ctx.store.getTask(t3.taskId)).taskId).toBe(t3.taskId)

    var second = await ctx.cleanupHandler.handle()
    expect(second.data).toMatchObject({ scanned: 1, deleted: 1, failed: 0 })
    expect(await ctx.store.getTask(t3.taskId)).toBeNull()
    expect(ctx.store.__countTasks()).toBe(0)
  })

  test('幂等：无到期任务时 scanned=0 且不产生副作用', async function () {
    var ctx = fx.makeContext()
    var first = await ctx.cleanupHandler.handle()
    expect(first.data).toEqual({ scanned: 0, deleted: 0, failed: 0, photosPurged: 0, modelsKept: 0 })
    var second = await ctx.cleanupHandler.handle()
    expect(second.data).toEqual({ scanned: 0, deleted: 0, failed: 0, photosPurged: 0, modelsKept: 0 })
    expect(ctx.storage.__deleted()).toEqual([])
  })

  test('无墓碑字段：剩余记录不含 deletedAt/purgedAt', async function () {
    var ctx = fx.makeContext()
    var now = ctx.clock.now()
    var expired = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now - 1000 })
    await fx.seedTaskAsset(ctx.store, expired)
    var live = await fx.seedTask(ctx.store, { status: 'SUCCEEDED', purgeAt: now + 60 * 60 * 1000 })

    await ctx.cleanupHandler.handle()
    var snapshot = ctx.store.__snapshot()
    expect(snapshot.tasks[expired.taskId]).toBeUndefined()
    var remaining = snapshot.tasks[live.taskId]
    expect(remaining).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(remaining, 'deletedAt')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(remaining, 'purgedAt')).toBe(false)
  })
})
