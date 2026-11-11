/**
 * sinn-cleanup/lib/handler.js —— 到期数据物理清理（SPEC §4 / API-13）。
 *
 * 定时触发器每 10 分钟执行一次：
 * - 按 purgeAt <= now 批量物理删除任务与资产记录、云存储对象（无墓碑/中间状态）；
 * - 单条失败不阻塞批次，结果计数进日志 {scanned,deleted,failed}；
 * - 逻辑复用 sinn-task/lib/account.js，不复制删除规则。
 */
'use strict'

var errors = require('../../sinn-task/lib/errors')
var util = require('../../sinn-task/lib/util')
var account = require('../../sinn-task/lib/account')

function createHandler(deps) {
  deps = deps || {}
  var now = deps.now || Date.now
  var batchSize = deps.batchSize || 100
  var logger = deps.logger || console

  async function handle() {
    var requestId = util.newRequestId()
    var startedAt = now()
    try {
      var result = await account.purgeExpiredTasks(deps, startedAt, batchSize)
      var log = {
        action: 'sinn-cleanup',
        requestId: requestId,
        startedAt: startedAt,
        finishedAt: now(),
        scanned: result.scanned,
        deleted: result.deleted,
        failed: result.failed
      }
      if (result.errors && result.errors.length > 0) log.errors = result.errors
      logger.log(JSON.stringify(log))
      return {
        ok: true,
        data: {
          scanned: result.scanned,
          deleted: result.deleted,
          failed: result.failed
        },
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
