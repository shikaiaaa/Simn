/**
 * sinn-cleanup/lib/model3d-cleanup.js —— 3D 任务到期清理（SPEC-0002 §4 / D-4）。
 *
 * 规则：
 * - 3D 任务（taskType='3D_MODEL'）失败/超时/取消：purgeAt=创建+23h 到期 → 物理删除输入照片
 *   对象/记录 + 任务记录（模型不存在）；
 * - 3D 任务成功：模型与 sinn_models3d 记录**长期保留**；到期只清理 3D 输入照片，并把 purgeAt
 *   置 null（避免重复清理），模型资产不删；
 * - 人像资产在 sinn-model3d submit 时绑定 taskId（asset.taskId），因此按 taskId 就能收集；
 * - 供应商侧任务（Tripo）当前适配器 erase 返回 unsupported，cleanup 不做额外供应商删除。
 *
 * 与 P1 account.purgeExpiredTasks 分工：本模块只处理 3D 任务；调用方在 P1 清理前运行，
 * 并把 P1 清理的 store.listTasksDue 过滤掉 3D 任务，避免同一任务被重复处理。
 */
'use strict'

var util = require('../../sinn-task/lib/util')

var MODEL_TASK_TYPE = '3D_MODEL'

function is3dTask(task) {
  return !!task && task.taskType === MODEL_TASK_TYPE
}

function selectDue3d(tasks) {
  return (tasks || []).filter(is3dTask)
}

/** 删除任务关联的输入照片（对象 + 资产记录），返回计数；对象删除失败会抛出。 */
async function purgeTaskAssets(deps, task) {
  var store = deps.store
  var assets = (await store.listAssetsByTaskId(task.taskId)) || []
  var fileIDs = assets
    .filter(function (asset) { return asset && asset.fileID })
    .map(function (asset) { return asset.fileID })
  if (fileIDs.length > 0) await deps.storage.deleteFiles(fileIDs)
  for (var i = 0; i < assets.length; i += 1) {
    await store.deleteAsset(assets[i].assetId)
  }
  return { assetCount: assets.length, fileCount: fileIDs.length }
}

/**
 * @param {object} deps { store, storage }（P1 签名）
 * @param {number} nowMs
 * @param {number} batchSize
 * @returns {{scanned:number,deleted:number,failed:number,photosPurged:number,modelsKept:number,errors:Array}}
 */
async function run(deps, nowMs, batchSize) {
  if (!deps || !deps.store || !deps.storage) throw new Error('model3d-cleanup 需要 store 与 storage')
  var now = typeof nowMs === 'number' ? nowMs : Date.now()
  var limit = typeof batchSize === 'number' && batchSize > 0 ? batchSize : 100
  var dueTasks = await deps.store.listTasksDue(now, limit)
  var tasks = selectDue3d(dueTasks)
  var result = { scanned: tasks.length, deleted: 0, failed: 0, photosPurged: 0, modelsKept: 0, errors: [] }
  for (var i = 0; i < tasks.length; i += 1) {
    var task = tasks[i]
    try {
      var purged = await purgeTaskAssets(deps, task)
      result.photosPurged += purged.assetCount
      if (task.status === 'SUCCEEDED') {
        // 模型长期保留：只清照片，purgeAt 置 null 防止重复扫描。
        await deps.store.updateTask(task.taskId, {
          purgeAt: null,
          assetsPurgedAt: now,
          statusUpdatedAt: now
        })
        result.modelsKept += 1
      } else {
        await deps.store.deleteTask(task.taskId)
        result.deleted += 1
      }
    } catch (error) {
      result.failed += 1
      result.errors.push({
        taskId: task.taskId,
        message: error && error.message ? error.message : String(error)
      })
    }
  }
  return result
}

module.exports = {
  MODEL_TASK_TYPE: MODEL_TASK_TYPE,
  is3dTask: is3dTask,
  selectDue3d: selectDue3d,
  purgeTaskAssets: purgeTaskAssets,
  run: run,
  // 保持与其他清理模块一致：错误可被上层 normalize
  util: util
}
