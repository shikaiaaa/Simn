/**
 * sinn-cleanup/lib/handler.js —— 到期数据物理清理（SPEC §4 / API-13，含 SPEC-0002 §4 的 3D 分支）。
 *
 * 定时触发器每 10 分钟执行一次：
 * - 先跑 3D 清理（model3d-cleanup）：失败/超时任务全删；成功任务只清输入照片、保留模型；
 * - 再跑 P1 2D 清理（account.purgeExpiredTasks），store.listTasksDue 过滤掉 3D 任务，避免重复处理；
 * - 单条失败不阻塞批次，结果计数进日志 {scanned,deleted,failed,photosPurged,modelsKept}；
 * - 逻辑复用 sinn-task/lib/account.js 与 model3d-cleanup，不复制删除规则。
 */
'use strict'

var errors = require('../../sinn-task/lib/errors')
var util = require('../../sinn-task/lib/util')
var account = require('../../sinn-task/lib/account')
var model3dCleanup = require('./model3d-cleanup')

function createHandler(deps) {
  deps = deps || {}
  var now = deps.now || Date.now
  var batchSize = deps.batchSize || 100
  var logger = deps.logger || console

  /** 包一层 store：P1 清理只看到非 3D 任务（3D 已由 model3d-cleanup 处理）。 */
  function create2dOnlyStore(store) {
    if (!store || typeof store.listTasksDue !== 'function') return store
    var wrapped = Object.assign({}, store)
    wrapped.listTasksDue = function (nowMs, limit) {
      return Promise.resolve(store.listTasksDue(nowMs, limit)).then(function (tasks) {
        return (tasks || []).filter(function (task) { return !model3dCleanup.is3dTask(task) })
      })
    }
    return wrapped
  }

  async function handle() {
    var requestId = util.newRequestId()
    var startedAt = now()
    try {
      var threeD = await model3dCleanup.run(deps, startedAt, batchSize)
      var twoDDeps = Object.assign({}, deps, { store: create2dOnlyStore(deps.store) })
      var twoD = await account.purgeExpiredTasks(twoDDeps, startedAt, batchSize)
      var combinedErrors = []
        .concat(threeD.errors || [])
        .concat(twoD.errors || [])
      var result = {
        scanned: threeD.scanned + twoD.scanned,
        deleted: threeD.deleted + twoD.deleted,
        failed: threeD.failed + twoD.failed,
        photosPurged: threeD.photosPurged,
        modelsKept: threeD.modelsKept
      }
      var log = {
        action: 'sinn-cleanup',
        requestId: requestId,
        startedAt: startedAt,
        finishedAt: now(),
        scanned: result.scanned,
        deleted: result.deleted,
        failed: result.failed,
        photosPurged: result.photosPurged,
        modelsKept: result.modelsKept
      }
      if (combinedErrors.length > 0) log.errors = combinedErrors
      logger.log(JSON.stringify(log))
      return {
        ok: true,
        data: result,
        error: null,
        requestId: requestId,
        serverTime: now()
      }
    } catch (rawError) {
      var error = errors.normalizeError(rawError)
      logger.error(
        JSON.stringify({
          action: 'sinn-cleanup',
          requestId: requestId,
          ok: false,
          code: error.code,
          name: error.name,
          message: error.message
        })
      )
      return {
        ok: false,
        data: null,
        error: {
          code: error.code,
          name: error.name,
          message: error.message,
          hint: error.hint,
          httpStatus: error.httpStatus
        },
        requestId: requestId,
        serverTime: now()
      }
    }
  }

  return { handle: handle }
}

module.exports = {
  createHandler: createHandler
}
