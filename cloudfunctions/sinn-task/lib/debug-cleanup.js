/**
 * cloudfunctions/sinn-task/lib/debug-cleanup.js —— task-39：cleanup 定时触发器诊断动作。
 *
 * 背景：`sinn-cleanup` 的定时触发器 `sinnCleanupEvery10m`（`config.json` triggers，每 10 分钟）
 * 无法通过 `cloud functions info` 回显，控制台也看不到，需要程序化验证「触发器是否真的在跑」。
 *
 * 两个受保护 action（demo 调试入口，上线前必须连同 bootstrap/selftest/precheckDebug 一起移除，
 * 并登记 SPEC §G / 上线差异清单）：
 * - `cleanupSeed`：在 `sinn_tasks` 写入 1–3 条「已过期」的测试任务（openid 固定
 *   `__debug_cleanup__`，purgeAt = now - ageMs），字段形状与 `lib/store/cloud-store.js` 的
 *   `saveTask` 真实文档一致（真实业务永远只经过 saveTask 落库）；
 * - `cleanupCheck`：按 openid 查回这些任务，返回 `{count, ids, now}`。
 *
 * 判断方式：seed 后等待 ≥11 分钟（10 分钟周期 + 1 分钟余量）再 check。
 * count 归零 = 定时触发器确实执行过 cleanup；仍 >0 = 触发器未生效（需控制台补建）。
 *
 * 安全：门禁复用 `lib/debug-gate.js`（env.SINN_SELFTEST==='1' 或 event.gate===GATE_TOKEN），
 * 未启用直接 1004/403 且不产生任何数据库读写；本模块不读取/不返回任何密钥。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var debugGate = require('./debug-gate')

var SEED_OPENID = '__debug_cleanup__'
var TASKS_COLLECTION = 'sinn_tasks'
var DEFAULT_COUNT = 1
var MAX_COUNT = 3
var MIN_AGE_MS = 0
var DEFAULT_AGE_MS = 60 * 1000
var MAX_AGE_MS = 24 * 60 * 60 * 1000
// 与任务的真实 purgeAt 语义保持一致：purgeAt = createdAt + 23h。
var PURGE_TTL_MS = 23 * 60 * 60 * 1000

function normalizeCount(count) {
  if (count === undefined || count === null) return DEFAULT_COUNT
  var value = Number(count)
  if (!isFinite(value) || Math.floor(value) !== value || value < 1 || value > MAX_COUNT) {
    throw errors.fail(1001, {
      message: 'count 需为 1–' + MAX_COUNT + ' 的整数',
      hint: '示例：{"action":"cleanupSeed","count":2}'
    })
  }
  return value
}

function normalizeAgeMs(ageMs) {
  if (ageMs === undefined || ageMs === null) return DEFAULT_AGE_MS
  var value = Number(ageMs)
  if (!isFinite(value) || Math.floor(value) !== value || value < MIN_AGE_MS || value > MAX_AGE_MS) {
    throw errors.fail(1001, {
      message: 'ageMs 需为 0–' + MAX_AGE_MS + ' 的整数',
      hint: '示例：{"action":"cleanupSeed","count":1,"ageMs":60000}'
    })
  }
  return value
}

/**
 * 构造一条「已过期」测试任务文档。字段集合与 handler.createTask 里 saveTask 前的 task 对象一致，
 * 唯一的区别是：status 固定终态 SUCCEEDED（cleanup 不会走取消/退款分支），无资产、无结果图。
 */
function buildSeedTask(nowMs, index, ageMs) {
  var stamp = Number(nowMs).toString(36)
  var taskId = 't_seed_' + stamp + '_' + index
  var purgeAt = nowMs - ageMs
  var createdAt = purgeAt - PURGE_TTL_MS
  return {
    taskId: taskId,
    openid: SEED_OPENID,
    clientReqId: 'seed_' + stamp + '_' + index,
    status: 'SUCCEEDED',
    stage: 'DONE',
    personAssetIds: [],
    garmentAssetId: null,
    metrics: { heightCm: 1700, weightKg: 60000, gender: 'unspecified' },
    sizeResult: null,
    resultFileID: null,
    resultWidth: null,
    resultHeight: null,
    vendorProvider: 'mock',
    vendorTaskId: null,
    submittedAt: createdAt,
    successAt: createdAt + 1000,
    statusUpdatedAt: createdAt + 1000,
    createdAt: createdAt,
    purgeAt: purgeAt,
    quotaRefunded: false,
    failureCode: null,
    failureName: null,
    failureMessage: null
  }
}

function docIdOf(doc) {
  if (!doc) return ''
  return doc._id || doc.taskId || ''
}

async function listSeeds(db) {
  var res = await db.collection(TASKS_COLLECTION).where({ openid: SEED_OPENID }).get()
  return (res && res.data) || []
}

async function removePreviousSeeds(db) {
  var seeds = await listSeeds(db)
  var removed = 0
  for (var i = 0; i < seeds.length; i += 1) {
    var id = docIdOf(seeds[i])
    if (!id) continue
    await db.collection(TASKS_COLLECTION).doc(id).remove()
    removed += 1
  }
  return removed
}

/**
 * cleanupSeed：清掉上一轮 seed（保证 count 语义确定），再写入本轮 count 条过期任务。
 * 返回 {openid,count,removedPrevious,tasks,now,note}。
 */
async function seed(deps, event) {
  var db = deps.db
  var nowMs = deps.now()
  var payload = event || {}
  var count = normalizeCount(payload.count)
  var ageMs = normalizeAgeMs(payload.ageMs)
  var removedPrevious = await removePreviousSeeds(db)
  var tasks = []
  for (var i = 1; i <= count; i += 1) {
    var task = buildSeedTask(nowMs, i, ageMs)
    await db.collection(TASKS_COLLECTION).doc(task.taskId).set({ data: task })
    tasks.push({ taskId: task.taskId, purgeAt: task.purgeAt })
  }
  return {
    openid: SEED_OPENID,
    count: tasks.length,
    removedPrevious: removedPrevious,
    tasks: tasks,
    now: nowMs,
    note: '等待 ≥11 分钟后再调 cleanupCheck；count 归零说明 10 分钟定时触发器已执行清理'
  }
}

/**
 * cleanupCheck：查回当前 seed 任务，返回 {openid,count,ids,items,expired,now}。
 * 读取失败原样抛出，由外层统一 envelope 包装（不吞异常）。
 */
async function check(deps) {
  var nowMs = deps.now()
  var list = await listSeeds(deps.db)
  var ids = []
  var items = []
  var expired = 0
  for (var i = 0; i < list.length; i += 1) {
    var doc = list[i] || {}
    var id = docIdOf(doc)
    if (id) ids.push(id)
    var purgeAt = typeof doc.purgeAt === 'number' ? doc.purgeAt : null
    if (purgeAt !== null && purgeAt <= nowMs) expired += 1
    items.push({
      taskId: doc.taskId || id,
      purgeAt: purgeAt,
      status: doc.status || null
    })
  }
  ids.sort()
  return { openid: SEED_OPENID, count: ids.length, ids: ids, items: items, expired: expired, now: nowMs }
}

function createCleanupDebugHandler(deps) {
  deps = deps || {}
  var db = deps.db
  var env = deps.env || {}
  var now = deps.now || Date.now
  var requestId = deps.requestId || util.newRequestId()

  function envelopeOk(data) {
    return { ok: true, data: data, error: null, requestId: requestId, serverTime: now() }
  }

  function envelopeFail(error) {
    var appError = errors.normalizeError(error)
    var payload = {
      code: appError.code,
      name: appError.name,
      message: appError.message,
      hint: appError.hint,
      httpStatus: appError.httpStatus
    }
    // 诊断入口需要看到底层错误原文（仅 message，截断且不含堆栈/密钥）；
    // 门禁已限制在 SINN_SELFTEST=1 或 gate token 下，普通业务错误仍走通用文案。
    if (error && !error.isAppError && error.message) {
      payload.hint = '原始错误：' + String(error.message).slice(0, 300)
    }
    if (appError.detail) payload.detail = appError.detail
    return { ok: false, data: null, error: payload, requestId: requestId, serverTime: now() }
  }

  async function handle(event) {
    var started = now()
    try {
      var action = (event && event.action) || ''
      if (action !== 'cleanupSeed' && action !== 'cleanupCheck') {
        throw errors.fail(1001, {
          message: '未知 cleanup 诊断 action: ' + action,
          hint: '支持 cleanupSeed / cleanupCheck'
        })
      }
      // 门禁必须先于任何数据库读写（关闭时零读写）。
      debugGate.assertDebugActionEnabled(event, env, action)
      var data
      if (action === 'cleanupSeed') {
        data = await seed({ db: db, now: now }, event)
      } else {
        data = await check({ db: db, now: now })
      }
      data.action = action
      data.elapsedMs = now() - started
      return envelopeOk(data)
    } catch (rawError) {
      return envelopeFail(rawError)
    }
  }

  return { handle: handle }
}

module.exports = {
  SEED_OPENID: SEED_OPENID,
  TASKS_COLLECTION: TASKS_COLLECTION,
  DEFAULT_COUNT: DEFAULT_COUNT,
  MAX_COUNT: MAX_COUNT,
  DEFAULT_AGE_MS: DEFAULT_AGE_MS,
  MAX_AGE_MS: MAX_AGE_MS,
  normalizeCount: normalizeCount,
  normalizeAgeMs: normalizeAgeMs,
  buildSeedTask: buildSeedTask,
  seed: seed,
  check: check,
  createCleanupDebugHandler: createCleanupDebugHandler
}
