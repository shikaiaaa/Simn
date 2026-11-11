/**
 * tests/unit/cloudfunctions/task/debug-cleanup.test.js
 * task-39：sinn-task 受保护的 cleanup 诊断动作（cleanupSeed / cleanupCheck）离线单测。
 *
 * 目的：验证 10 分钟定时触发器（sinn-cleanup 的 sinnCleanupEvery10m）是否真的在跑：
 * seed 过期任务 → 等 ≥11 分钟 → check，count 归零即触发器工作。
 */
'use strict'

var debugCleanup = require('../../../../cloudfunctions/sinn-task/lib/debug-cleanup')
var debugGate = require('../../../../cloudfunctions/sinn-task/lib/debug-gate')

var NOW = Date.UTC(2026, 10, 10, 15, 0, 0) // 2026-11-10 23:00 Asia/Shanghai
var REQ = 'req-cleanup-debug-0001'
var PURGE_TTL_MS = 23 * 60 * 60 * 1000

/** fake db：只实现 debug-cleanup 需要的 sinn_tasks 读写（doc.set/remove、where.get）。 */
function createFakeTasksDb(options) {
  options = options || {}
  var docs = {}
  var stats = { writes: 0, removes: 0, reads: 0 }

  function matches(doc, query) {
    var keys = Object.keys(query || {})
    for (var i = 0; i < keys.length; i += 1) {
      if (doc[keys[i]] !== query[keys[i]]) return false
    }
    return true
  }

  function collection(name) {
    if (name !== debugCleanup.TASKS_COLLECTION) {
      throw new Error('unexpected collection: ' + name)
    }
    return {
      doc: function (id) {
        return {
          set: function (args) {
            if (options.failWrite) return Promise.reject(options.failWrite)
            stats.writes += 1
            var stored = Object.assign({}, args && args.data)
            delete stored._id
            stored._id = id
            docs[id] = stored
            return Promise.resolve({ _id: id })
          },
          remove: function () {
            stats.removes += 1
            delete docs[id]
            return Promise.resolve({ stats: { removed: 1 } })
          }
        }
      },
      where: function (query) {
        return {
          get: function () {
            stats.reads += 1
            if (options.failRead) return Promise.reject(options.failRead)
            var list = Object.keys(docs)
              .map(function (key) { return docs[key] })
              .filter(function (doc) { return matches(doc, query) })
            return Promise.resolve({ data: list })
          }
        }
      }
    }
  }

  return { collection: collection, __docs: docs, __stats: stats }
}

function makeHandler(overrides) {
  overrides = overrides || {}
  var db = overrides.db || createFakeTasksDb(overrides.dbOptions || {})
  var handler = debugCleanup.createCleanupDebugHandler({
    db: db,
    env: overrides.env === undefined ? { SINN_SELFTEST: '1' } : overrides.env,
    now: function () { return NOW },
    requestId: REQ
  })
  return { handler: handler, db: db }
}

async function callSeed(overrides, payload) {
  var built = makeHandler(overrides)
  var event = { action: 'cleanupSeed', gate: debugGate.GATE_TOKEN }
  Object.keys(payload || {}).forEach(function (key) { event[key] = payload[key] })
  var result = await built.handler.handle(event)
  return { result: result, db: built.db }
}

describe('sinn-task cleanup 诊断动作（task-39）', function () {
  test('门禁关闭：cleanupSeed 返回 1004/403，且零读写', async function () {
    var built = makeHandler({ env: {} })
    var result = await built.handler.handle({ action: 'cleanupSeed' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(1004)
    expect(result.error.name).toBe('E_FORBIDDEN')
    expect(result.error.httpStatus).toBe(403)
    expect(built.db.__stats.writes).toBe(0)
    expect(built.db.__stats.reads).toBe(0)
  })

  test('门禁关闭：cleanupCheck 返回 1004/403，且零读取', async function () {
    var built = makeHandler({ env: {} })
    var result = await built.handler.handle({ action: 'cleanupCheck' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(1004)
    expect(result.error.httpStatus).toBe(403)
    expect(built.db.__stats.reads).toBe(0)
    expect(built.db.__stats.writes).toBe(0)
  })

  test('gate token 放行：默认 seed 1 条，文档形状与真实 saveTask 一致且 purgeAt 已过期', async function () {
    var built = await callSeed({ env: {} }, {})
    var result = built.result
    expect(result.ok).toBe(true)
    expect(result.requestId).toBe(REQ)
    expect(result.data.action).toBe('cleanupSeed')
    expect(typeof result.data.elapsedMs).toBe('number')
    expect(result.data.openid).toBe(debugCleanup.SEED_OPENID)
    expect(result.data.count).toBe(1)
    expect(result.data.removedPrevious).toBe(0)
    expect(result.data.tasks).toHaveLength(1)

    var taskId = result.data.tasks[0].taskId
    expect(taskId).toMatch(/^t_seed_[0-9a-z]+_1$/)
    var doc = built.db.__docs[taskId]
    expect(doc).toBeTruthy()
    expect(doc._id).toBe(taskId)
    expect(doc.taskId).toBe(taskId)
    expect(doc.openid).toBe('__debug_cleanup__')
    expect(doc.status).toBe('SUCCEEDED')
    expect(doc.stage).toBe('DONE')
    expect(doc.purgeAt).toBe(NOW - debugCleanup.DEFAULT_AGE_MS)
    expect(doc.createdAt).toBe(doc.purgeAt - PURGE_TTL_MS)
    expect(doc.successAt).toBe(doc.createdAt + 1000)
    expect(doc.metrics).toEqual({ heightCm: 1700, weightKg: 60000, gender: 'unspecified' })
    expect(doc.personAssetIds).toEqual([])
    expect(doc.garmentAssetId).toBeNull()
    expect(doc.resultFileID).toBeNull()
    expect(doc.vendorProvider).toBe('mock')
    expect(doc.quotaRefunded).toBe(false)
    expect(doc.failureCode).toBeNull()
    expect(doc.note).toBeUndefined()
    expect(JSON.parse(JSON.stringify(doc)).status).toBe('SUCCEEDED')
  })

  test('SINN_SELFTEST=1 放行 + count=3：写入 3 条 _1/_2/_3', async function () {
    var built = await callSeed({ env: { SINN_SELFTEST: '1' } }, { count: 3 })
    expect(built.result.ok).toBe(true)
    expect(built.result.data.count).toBe(3)
    var ids = built.result.data.tasks.map(function (task) { return task.taskId })
    expect(ids[0]).toMatch(/_1$/)
    expect(ids[1]).toMatch(/_2$/)
    expect(ids[2]).toMatch(/_3$/)
    expect(Object.keys(built.db.__docs)).toHaveLength(3)
  })

  test('count 支持数字字符串（"2"）', async function () {
    var built = await callSeed({}, { count: '2' })
    expect(built.result.ok).toBe(true)
    expect(built.result.data.count).toBe(2)
  })

  test('count 越界/非法 → 1001 且零写入', async function () {
    var cases = [0, 4, 1.5, 'abc', -1, 2.0001]
    for (var i = 0; i < cases.length; i += 1) {
      var built = await callSeed({}, { count: cases[i] })
      expect(built.result.ok).toBe(false)
      expect(built.result.error.code).toBe(1001)
      expect(built.db.__stats.writes).toBe(0)
    }
  })

  test('重复 seed 会先清掉上一轮 seed（removedPrevious=2），再写新数据', async function () {
    var built = makeHandler({})
    await built.handler.handle({ action: 'cleanupSeed', gate: debugGate.GATE_TOKEN, count: 2 })
    expect(Object.keys(built.db.__docs)).toHaveLength(2)
    var second = await built.handler.handle({ action: 'cleanupSeed', gate: debugGate.GATE_TOKEN, count: 1 })
    expect(second.ok).toBe(true)
    expect(second.data.removedPrevious).toBe(2)
    expect(Object.keys(built.db.__docs)).toHaveLength(1)
    expect(built.db.__stats.removes).toBe(2)
    expect(built.db.__stats.writes).toBe(3)
  })

  test('cleanupCheck 返回 seed 的 count/ids/expired/now', async function () {
    var built = makeHandler({})
    await built.handler.handle({ action: 'cleanupSeed', gate: debugGate.GATE_TOKEN, count: 2 })
    var result = await built.handler.handle({ action: 'cleanupCheck', gate: debugGate.GATE_TOKEN })
    expect(result.ok).toBe(true)
    expect(result.data.action).toBe('cleanupCheck')
    expect(result.data.openid).toBe(debugCleanup.SEED_OPENID)
    expect(result.data.count).toBe(2)
    expect(result.data.ids).toHaveLength(2)
    expect(result.data.ids[0] < result.data.ids[1]).toBe(true)
    expect(result.data.items).toHaveLength(2)
    expect(result.data.expired).toBe(2)
    expect(result.data.now).toBe(NOW)
  })

  test('cleanupCheck 空集合返回 count=0', async function () {
    var built = makeHandler({})
    var result = await built.handler.handle({ action: 'cleanupCheck', gate: debugGate.GATE_TOKEN })
    expect(result.ok).toBe(true)
    expect(result.data.count).toBe(0)
    expect(result.data.ids).toEqual([])
    expect(result.data.expired).toBe(0)
  })

  test('读取失败原样透传（不吞异常，500→9000 envelope，hint 带原始错误）', async function () {
    var error = new Error('db read failed: -502001')
    error.errCode = -502001
    var built = makeHandler({ dbOptions: { failRead: error } })
    var result = await built.handler.handle({ action: 'cleanupCheck', gate: debugGate.GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(9000)
    expect(result.error.hint).toContain('db read failed')
  })

  test('写入失败原样透传（500→9000 envelope，hint 带原始错误）', async function () {
    var built = makeHandler({ dbOptions: { failWrite: new Error('db write failed: -502001') } })
    var result = await built.handler.handle({ action: 'cleanupSeed', gate: debugGate.GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(9000)
    expect(result.error.hint).toContain('db write failed')
  })

  test('未知 action 返回 1001', async function () {
    var built = makeHandler({})
    var result = await built.handler.handle({ action: 'cleanupNope' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(1001)
  })

  test('密钥不泄漏：结果 JSON 不含 env 中的 AK/SK', async function () {
    var built = await callSeed(
      { env: { SINN_SELFTEST: '1', SINN_VOLC_AK: 'AKID-SECRET-0001', SINN_VOLC_SK: 'SK-SECRET-0002' } },
      { count: 1 }
    )
    var serialized = JSON.stringify(built.result)
    expect(serialized.indexOf('AKID-SECRET-0001')).toBe(-1)
    expect(serialized.indexOf('SK-SECRET-0002')).toBe(-1)
  })
})
