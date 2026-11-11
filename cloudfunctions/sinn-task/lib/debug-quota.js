/**
 * cloudfunctions/sinn-task/lib/debug-quota.js —— task-40：受保护的额度重置调试动作。
 *
 * 背景：QA 的 L3-002（额度拦截链路）需要「同一天两次创建」：
 * 第 1 次生成成功（used=1），第 2 次应被 E_QUOTA_EXHAUSTED 拦截。
 * 当日唯一额度用掉后无法再干净复跑，因此提供只重置**调用者自己**额度的调试动作。
 *
 * 安全：
 * - 门禁复用 lib/debug-gate.js（env.SINN_SELFTEST==='1' 或 event.gate===GATE_TOKEN）；
 *   未启用返回 1004/403 且零数据库读写；
 * - openid 只来自 cloud.getWXContext()（index.js 注入），不接受请求参数里的任意 openid；
 * - 返回 openidTail（末 6 位），不返回完整 openid / 任何密钥；
 * - 写入走 store.saveUser（cloud-store 内部 setDoc + sanitize：不含 _id、不含 undefined）。
 *
 * ⚠️ demo 调试入口：上线前必须连同 bootstrap / selftest / precheckDebug /
 * cleanupSeed / cleanupCheck 一起移除，并登记 SPEC §G / 上线差异清单。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var debugGate = require('./debug-gate')

var ACTION = 'quotaReset'

function openidTail(openid) {
  if (!openid) return null
  var text = String(openid)
  return text.length <= 6 ? text : text.slice(-6)
}

/**
 * 统一的额度快照（与 account.quotaView 的 used/limit/remaining 口径一致，
 * 但不写库、不触发 dayKey 惰性重置；仅用于 before/after 展示）。
 */
function quotaSnapshot(user) {
  if (!user) return null
  var limit = Number(user.dailyLimit) || 0
  var used = Number(user.usedToday) || 0
  return {
    dayKey: user.dayKey || null,
    used: used,
    limit: limit,
    remaining: Math.max(0, limit - used),
    vip: !!user.vip
  }
}

/**
 * quotaReset 核心逻辑。deps: {store, env, now, openid}。
 * 门禁在读取 store 之前（gate 关闭时零读写）。
 * 用户文档不存在时返回 reset:false, reason:'user_missing'，不创建文档（单测固定此语义）。
 */
async function resetQuota(deps, event) {
  var options = deps || {}
  var store = options.store
  var env = options.env || {}
  var nowFn = typeof options.now === 'function' ? options.now : Date.now

  debugGate.assertDebugActionEnabled(event, env, ACTION)

  var openid = options.openid
  if (!openid) {
    throw errors.fail(1004, {
      httpStatus: 403,
      message: '缺少调用者身份',
      hint: 'quotaReset 只能由已登录调用者本人执行'
    })
  }

  var nowMs = nowFn()
  var dayKey = util.beijingDayKey(nowMs)
  var user = await store.getUser(openid)
  var before = quotaSnapshot(user)

  if (!user) {
    return {
      action: ACTION,
      openidTail: openidTail(openid),
      before: null,
      after: null,
      reset: false,
      reason: 'user_missing',
      dayKey: dayKey,
      now: nowMs
    }
  }

  // 保留 limit/vip/额度以外的所有字段，只重置当日 dayKey 与已用次数。
  var next = Object.assign({}, user, {
    openid: openid,
    dayKey: dayKey,
    usedToday: 0
  })
  await store.saveUser(next)

  var after = {
    dayKey: dayKey,
    used: 0,
    limit: before.limit,
    remaining: before.limit,
    vip: before.vip
  }

  return {
    action: ACTION,
    openidTail: openidTail(openid),
    before: before,
    after: after,
    reset: true,
    reason: null,
    dayKey: dayKey,
    now: nowMs
  }
}

function createQuotaDebugHandler(deps) {
  var options = deps || {}
  var requestId = options.requestId || util.newRequestId()
  var nowFn = typeof options.now === 'function' ? options.now : Date.now

  function envelopeOk(data) {
    return { ok: true, data: data, error: null, requestId: requestId, serverTime: nowFn() }
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
    return { ok: false, data: null, error: payload, requestId: requestId, serverTime: nowFn() }
  }

  async function handle(event) {
    var started = nowFn()
    try {
      var action = (event && event.action) || ''
      if (action !== ACTION) {
        throw errors.fail(1001, {
          message: '未知 quota 诊断 action: ' + action,
          hint: '支持 quotaReset'
        })
      }
      var data = await resetQuota(options, event)
      data.elapsedMs = nowFn() - started
      return envelopeOk(data)
    } catch (rawError) {
      return envelopeFail(rawError)
    }
  }

  return { handle: handle }
}

module.exports = {
  ACTION: ACTION,
  openidTail: openidTail,
  quotaSnapshot: quotaSnapshot,
  resetQuota: resetQuota,
  createQuotaDebugHandler: createQuotaDebugHandler
}
