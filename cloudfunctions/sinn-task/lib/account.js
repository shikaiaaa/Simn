/**
 * lib/account.js —— sinn-account / sinn-cleanup 共用的账户、额度与物理删除逻辑。
 *
 * 设计（SPEC §3/§4/§B.3，DEV-0001-04）：
 * - 本文件是额度视图、同意校验、任务/资产物理删除的唯一实现，供 sinn-account 与
 *   sinn-cleanup 复用（不复制逻辑）。sinn-task 的 store 直接实现同规则的 consume/refund，
 *   本文件负责 profile 视图、惰性重置与批量清理。
 * - 删除 = 物理删云存储对象 + 物理删任务/资产记录；无 tombstone/purgedAt/deletedAt 落库。
 * - 额度返还以 task.quotaRefunded 保证同一任务只返还一次。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')

var IN_PROGRESS = ['QUEUED', 'GENERATING', 'SAVING']

function isVip(config, openid) {
  var whitelist = (config && config.vipWhitelist) || []
  return whitelist.indexOf(openid) >= 0
}

function limits(config) {
  return {
    normal: config && typeof config.dailyLimitNormal === 'number' ? config.dailyLimitNormal : 1,
    vip: config && typeof config.dailyLimitVip === 'number' ? config.dailyLimitVip : 10
  }
}

/**
 * 额度视图 + 跨天惰性重置（Asia/Shanghai 00:00，SPEC §3）。
 * 读取时会写回 dayKey/usedToday/vip/dailyLimit，保证下一次调用与端上一致。
 */
async function quotaView(store, openid, nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  var config = (await store.getConfig()) || {}
  var user = (await store.getUser(openid)) || {
    openid: openid,
    dayKey: '',
    usedToday: 0,
    dailyLimit: 0,
    vip: false,
    vipSource: null,
    activeTaskId: null,
    consentVersion: null,
    consentAt: null,
    ageConfirmedAt: null,
    revokedAt: null
  }
  var dayKey = util.beijingDayKey(now)
  var vip = isVip(config, openid)
  var cap = limits(config)
  var limit = vip ? cap.vip : cap.normal
  var changed = false
  if (user.dayKey !== dayKey) {
    user.dayKey = dayKey
    user.usedToday = 0
    changed = true
  }
  if (user.vip !== vip) {
    user.vip = vip
    changed = true
  }
  if (user.dailyLimit !== limit) {
    user.dailyLimit = limit
    changed = true
  }
  if (changed) {
    await store.saveUser(user)
  }
  var used = typeof user.usedToday === 'number' ? user.usedToday : 0
  return {
    used: used,
    limit: limit,
    remaining: Math.max(0, limit - used),
    vip: vip,
    dayKey: dayKey,
    resetAt: util.beijingResetAt(now)
  }
}

/** 写接口同意门禁：未同意/已撤回 → E_CONSENT_REQUIRED(1003)。 */
async function assertConsent(store, openid) {
  var consent = await store.getConsent(openid)
  if (!consent) throw errors.fail(1003)
  return consent
}

/** 幂等返还一次任务额度（仅进行中/失败任务需要调用）。 */
async function refundTaskQuota(store, task) {
  if (!task || task.quotaRefunded) return false
  await store.updateTask(task.taskId, { quotaRefunded: true, statusUpdatedAt: Date.now() })
  await store.refundQuota(task.openid)
  return true
}

/** 取消进行中任务（撤回同意/删除全部时调用），额度幂等返还。 */
async function cancelTask(store, task, nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  if (!task || IN_PROGRESS.indexOf(task.status) < 0) {
    await refundTaskQuota(store, task)
    return task
  }
  var updated = await store.updateTask(task.taskId, {
    status: 'CANCELLED',
    stage: 'CANCELLED',
    statusUpdatedAt: now
  })
  await refundTaskQuota(store, updated)
  return updated
}

/** 收集任务关联的所有云存储 fileID（人像/衣服/结果图）。 */
function collectFileIDs(task, assets) {
  var fileIDs = []
  ;(assets || []).forEach(function (asset) {
    if (asset && asset.fileID) fileIDs.push(asset.fileID)
  })
  if (task && task.resultFileID) fileIDs.push(task.resultFileID)
  return fileIDs
}

async function eraseVendorTask(vendor, task) {
  if (!vendor || !task || !task.vendorTaskId) return
  try {
    if (typeof vendor.erase === 'function') await vendor.erase({ vendorTaskId: task.vendorTaskId })
  } catch (error) {
    // 供应商侧删除尽力而为；cloud 侧记录与对象必须删净
  }
}

/**
 * 删除单个任务（cleanup 单条清理 / deleteTask 复用的批量版本）。
 * 先删对象再删记录；对象删除失败 → 返回失败且不删记录（避免"有记录无图"）。
 */
async function purgeTask(deps, task) {
  var store = deps.store
  var storage = deps.storage
  var assets = await store.listAssetsByTaskId(task.taskId)
  var fileIDs = collectFileIDs(task, assets)
  if (fileIDs.length > 0) {
    await storage.deleteFiles(fileIDs)
  }
  await eraseVendorTask(deps.vendor, task)
  for (var i = 0; i < assets.length; i += 1) {
    await store.deleteAsset(assets[i].assetId)
  }
  await store.deleteTask(task.taskId)
  return { deletedAssets: assets.length, fileIDs: fileIDs.length }
}

/**
 * 物理删除某用户全部任务/资产/对象（deleteAll 与 revokeConsent 共用）。
 * 进行中任务先取消并幂等返还额度；对象一次性删除，失败则整体失败、记录保留。
 */
async function purgeAllUserData(deps, openid, nowMs) {
  var store = deps.store
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  var tasks = await store.listTasksByOpenid(openid)
  var assetGroups = []
  var fileIDs = []
  for (var i = 0; i < tasks.length; i += 1) {
    var task = tasks[i]
    if (IN_PROGRESS.indexOf(task.status) >= 0) {
      task = await cancelTask(store, task, now)
    } else if (task.status !== 'SUCCEEDED') {
      // 失败/超时/取消的任务补齐退款（正常情况下失败路径已退过一次，这里按幂等兜底）；
      // 成功任务消耗的额度不返还。
      await refundTaskQuota(store, task)
    }
    var assets = await store.listAssetsByTaskId(task.taskId)
    assetGroups.push({ task: task, assets: assets })
    fileIDs = fileIDs.concat(collectFileIDs(task, assets))
  }
  if (fileIDs.length > 0) {
    await deps.storage.deleteFiles(fileIDs)
  }
  var deletedTasks = 0
  var deletedAssets = 0
  for (var k = 0; k < assetGroups.length; k += 1) {
    var group = assetGroups[k]
    await eraseVendorTask(deps.vendor, group.task)
    for (var a = 0; a < group.assets.length; a += 1) {
      await store.deleteAsset(group.assets[a].assetId)
      deletedAssets += 1
    }
    await store.deleteTask(group.task.taskId)
    deletedTasks += 1
  }
  return { deletedTasks: deletedTasks, deletedAssets: deletedAssets }
}

/** 清理到期任务：单条失败不阻塞批次（sinn-cleanup 使用）。 */
async function purgeExpiredTasks(deps, nowMs, batchSize) {
  var store = deps.store
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  var limit = typeof batchSize === 'number' && batchSize > 0 ? batchSize : 100
  var tasks = await store.listTasksDue(now, limit)
  var result = { scanned: tasks.length, deleted: 0, failed: 0, errors: [] }
  for (var i = 0; i < tasks.length; i += 1) {
    try {
      await purgeTask(deps, tasks[i])
      result.deleted += 1
    } catch (error) {
      result.failed += 1
      result.errors.push({ taskId: tasks[i].taskId, message: error && error.message ? error.message : String(error) })
    }
  }
  return result
}

module.exports = {
  IN_PROGRESS: IN_PROGRESS,
  quotaView: quotaView,
  assertConsent: assertConsent,
  refundTaskQuota: refundTaskQuota,
  cancelTask: cancelTask,
  collectFileIDs: collectFileIDs,
  purgeTask: purgeTask,
  purgeAllUserData: purgeAllUserData,
  purgeExpiredTasks: purgeExpiredTasks
}
