/**
 * sinn-account/lib/handler.js —— 账户/同意/删除全部（SPEC §B.2 API-1/2/3/4）。
 *
 * actions：
 * - profile        ：额度状态、同意状态、进行中任务、是否有数据（读接口，不要求同意）
 * - recordConsent  ：写同意审计（用户/版本/时间/文本 hash；不含照片/围度/性别）
 * - revokeConsent  ：物理删全部数据 + 清同意 + 取消进行中任务并退款
 * - deleteAll      ：物理删全部任务/资产/对象，保留同意审计；幂等，deletedAt 仅响应不落库
 */
'use strict'

var errors = require('../../sinn-task/lib/errors')
var util = require('../../sinn-task/lib/util')
var account = require('../../sinn-task/lib/account')

var ACTIONS = ['profile', 'recordConsent', 'revokeConsent', 'deleteAll']

function createHandler(deps) {
  deps = deps || {}
  var store = deps.store
  var storage = deps.storage
  var vendor = deps.vendor || null
  var consentStore = deps.consentStore
  var env = deps.env || {}
  var now = deps.now || Date.now
  var requestIdOption = deps.requestId
  var makeRequestId =
    typeof requestIdOption === 'function'
      ? requestIdOption
      : function () {
          return requestIdOption || util.newRequestId()
        }

  function handle(event, context) {
    var requestId = makeRequestId()
    var openid = context && context.openid
    var action = event && event.action
    return Promise.resolve()
      .then(function () {
        if (!openid) throw errors.fail(1004)
        if (ACTIONS.indexOf(action) < 0) throw errors.fail(1001, { hint: '未知 action：' + String(action) })
        return dispatch(action, event || {}, openid, requestId)
      })
      .then(function (data) {
        return { ok: true, data: data, error: null, requestId: requestId, serverTime: now() }
      })
      .catch(function (rawError) {
        var error = errors.normalizeError(rawError)
        return {
          ok: false,
          data: null,
          error: {
            code: error.code,
            name: error.name,
            message: error.message,
            hint: error.hint,
            httpStatus: error.httpStatus,
            detail: error.detail || undefined
          },
          requestId: requestId,
          serverTime: now()
        }
      })
  }

  async function dispatch(action, event, openid, requestId) {
    if (action === 'profile') return profile(openid)
    if (action === 'recordConsent') return recordConsent(event, openid, requestId)
    if (action === 'revokeConsent') return revokeConsent(event, openid)
    return deleteAll(event, openid)
  }

  async function profile(openid) {
    var quota = await account.quotaView(store, openid, now())
    var consent = await store.getConsent(openid)
    var active = await store.getActiveTask(openid)
    var tasks = await store.listTasksByOpenid(openid)
    return {
      quota: quota,
      consent: consent
        ? {
            version: consent.version,
            agreedAt: consent.agreedAt,
            ageConfirmedAt: consent.ageConfirmedAt
          }
        : null,
      activeTaskId: active ? active.taskId : null,
      hasData: tasks.length > 0
    }
  }

  async function recordConsent(event, openid, requestId) {
    var version = event.version
    if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
      throw errors.fail(1001, { hint: 'version 必须是非空字符串（≤64）' })
    }
    var textHash = event.textHash
    if (textHash !== undefined && textHash !== null && (typeof textHash !== 'string' || textHash.length > 128)) {
      throw errors.fail(1001, { hint: 'textHash 必须是字符串（≤128）' })
    }
    if (event.ageConfirmed !== undefined && event.ageConfirmed !== true) {
      throw errors.fail(1001, { hint: '18+ 未确认不能写入同意记录' })
    }
    var nowMs = now()
    var user = (await store.getUser(openid)) || { openid: openid }
    user.openid = openid
    user.consentVersion = version
    user.consentAt = nowMs
    user.ageConfirmedAt = nowMs
    user.revokedAt = null
    await store.saveUser(user)

    var record = {
      recordId: 'c_' + util.randomHex(24),
      openid: openid,
      version: version,
      agreedAt: nowMs,
      ageConfirmedAt: nowMs,
      textHash: textHash || null,
      requestId: requestId,
      createdAt: nowMs
    }
    // 审计只含同意元数据，禁止写入照片、围度、性别（SPEC §B.3）
    await consentStore.append(record)
    return { recordId: record.recordId, recordedAt: nowMs }
  }

  async function revokeConsent(event, openid) {
    var user = await store.getUser(openid)
    if (!user || !user.consentVersion || user.revokedAt) {
      throw errors.fail(1003, { hint: '当前没有可撤回的同意记录' })
    }
    var purged = await account.purgeAllUserData({ store: store, storage: storage, vendor: vendor }, openid, now())
    var revokedAt = now()
    // 重新读取用户，避免覆盖 purge 过程中的额度返还结果
    user = (await store.getUser(openid)) || user
    user.consentVersion = null
    user.consentAt = null
    user.ageConfirmedAt = null
    user.revokedAt = revokedAt
    user.activeTaskId = null
    await store.saveUser(user)
    return {
      deletedTasks: purged.deletedTasks,
      deletedAssets: purged.deletedAssets,
      consentRevokedAt: revokedAt
    }
  }

  async function deleteAll(event, openid) {
    await account.assertConsent(store, openid)
    var purged = await account.purgeAllUserData({ store: store, storage: storage, vendor: vendor }, openid, now())
    // 清理本地可见痕迹，但保留同意审计与额度状态（SPEC §4）
    var user = await store.getUser(openid)
    if (user && user.activeTaskId) {
      user.activeTaskId = null
      await store.saveUser(user)
    }
    return {
      deletedTasks: purged.deletedTasks,
      deletedAssets: purged.deletedAssets,
      deletedAt: now()
    }
  }

  return { handle: handle, ACTIONS: ACTIONS.slice(), __deps: deps, __env: env }
}

module.exports = {
  createHandler: createHandler,
  ACTIONS: ACTIONS
}
