/**
 * lib/handler.js —— sinn-task 云函数业务分发（SPEC-0001 v0.3 §B.2 / §B.4 / §4）。
 *
 * 设计要点：
 * - 不依赖 wx-server-sdk：store / vendor / precheck / storage 全部注入，本地单测可跑；
 * - 每次调用只创建一个 handler，统一响应包裹；
 * - 所有业务错误抛 AppError，最外层 catch 后包成 {ok:false,...}；
 * - 越权访问他人 task/asset 一律按「不存在」处理（404 / E_TASK_NOT_FOUND），不泄露存在性；
 * - 额度预扣与返还用 task.quotaRefunded 做幂等（返还至多一次）；
 * - 删除 = 物理全删（对象存储 → 资产记录 → 任务记录），无 tombstone（CP-08）。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var sizeLib = require('./size')
var precheckLib = require('./precheck')

var ACTIONS = ['assetRegister', 'precheck', 'createTask', 'taskGet', 'cancelTask', 'deleteTask', 'auditTask']
var IN_PROGRESS = ['QUEUED', 'GENERATING', 'SAVING']
var TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED']
// 服务端兜底（SPEC v0.8 §B.2）：客户端应已自动压缩到 1024–4096；
// 若资产尺寸仍越界（例如旧客户端/异常上传），precheck 直接返回 3014。
var MIN_PRECHECK_LONG_SIDE = 1024

var STAGE_OF_STATUS = {
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  SAVING: 'SAVING',
  SUCCEEDED: 'DONE',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED'
}

/** 供应商失败码 → 内部错误码（SPEC §B.4 映射表）。 */
var VENDOR_FAILURE_MAP = {
  content_blocked: 4001,
  error_apply_region_not_detected: 3002,
  precheck_vendor_limit: 3015
}

var VENDOR_LIMIT_HINT = '照片超出供应商规格（≤5MB、长边 ≤4096），请重新选择或由端上压缩后重试'

function mapVendorFailure(code) {
  return VENDOR_FAILURE_MAP[code] || 5001
}

/** SPEC v0.11 §B.2：登记/提交前校验资产是否满足供应商输入规格，不满足抛 3015。 */
function assertVendorSpecAsset(asset) {
  asset = asset || {}
  var bytes = Number(asset.bytes) || 0
  var longSide = Math.max(Number(asset.width) || 0, Number(asset.height) || 0)
  var mime = typeof asset.mime === 'string' ? asset.mime : ''
  if (bytes > util.VENDOR_MAX_BYTES || longSide > util.VENDOR_MAX_LONG_SIDE || mime !== util.VENDOR_MIME) {
    throw errors.fail(3015, { hint: VENDOR_LIMIT_HINT })
  }
}

/**
 * SPEC v0.11 §B.2：assetRegister 的参数在进入通用参数校验（1001）之前，先按供应商
 * 输入规格粗判，保证「超供应商规格」统一返回 3015，而不是被既有长边/体积校验抢先拦截。
 * 仅在 payload 显式给出有效数值/字符串时判断，保持缺字段仍由 validateAssetPayload → 1001。
 */
function assertVendorSpecPayload(payload) {
  payload = payload || {}
  var bytes = Number(payload.bytes)
  var width = Number(payload.width)
  var height = Number(payload.height)
  var mime = typeof payload.mime === 'string' ? payload.mime : ''
  var hasBytes = isFinite(bytes) && bytes > 0
  var hasDims = isFinite(width) && width > 0 && isFinite(height) && height > 0
  if (hasBytes && bytes > util.VENDOR_MAX_BYTES) throw errors.fail(3015, { hint: VENDOR_LIMIT_HINT })
  if (hasDims && Math.max(width, height) > util.VENDOR_MAX_LONG_SIDE) {
    throw errors.fail(3015, { hint: VENDOR_LIMIT_HINT })
  }
  if (mime && mime !== util.VENDOR_MIME) throw errors.fail(3015, { hint: VENDOR_LIMIT_HINT })
}

/** 从 AppError.detail 中安全提取 vendorCode/httpStatus（脱敏，仅用于 failure 持久化）。 */
function vendorDetailOf(error) {
  var detail = (error && error.detail) || {}
  var vendorCode = detail.vendorCode
  var httpStatus = detail.httpStatus !== undefined ? detail.httpStatus : error && error.httpStatus
  return {
    vendorCode: vendorCode === undefined || vendorCode === null ? null : String(vendorCode),
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null
  }
}

function withTimeout(promise, timeoutMs, code, hint) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(errors.fail(code, { hint: hint }))
    }, timeoutMs)
    Promise.resolve(promise).then(
      function (value) {
        clearTimeout(timer)
        resolve(value)
      },
      function (error) {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function createHandler(deps) {
  deps = deps || {}
  if (!deps.store) throw new Error('createHandler 需要 deps.store')

  var store = deps.store
  var vendor = deps.vendor
  var precheckAdapter = deps.precheck
  var storage = deps.storage || {}
  var env = deps.env || {}
  var now = deps.now || function () { return Date.now() }
  var taskTimeoutMs = deps.taskTimeoutMs || util.TASK_TIMEOUT_MS
  var precheckTimeoutMs = deps.precheckTimeoutMs || 8000

  var requestId = deps.requestId || util.newRequestId()

  function envelopeOk(data) {
    return {
      ok: true,
      data: data === undefined ? null : data,
      error: null,
      requestId: requestId,
      serverTime: now()
    }
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
    if (appError.detail) payload.detail = appError.detail
    return { ok: false, data: null, error: payload, requestId: requestId, serverTime: now() }
  }

  function assert(condition, code, options) {
    if (!condition) throw errors.fail(code || 1001, options)
  }

  async function assertConsent(openid) {
    var consent = await store.getConsent(openid)
    if (!consent) throw errors.fail(1003, { hint: '请先完成 18+ 确认与隐私单独同意' })
    return consent
  }

  async function loadOwnedTask(openid, taskId) {
    assert(util.isTaskId(taskId), 1001, { hint: 'taskId 不合法' })
    var task = await store.getTask(taskId)
    if (!task || task.openid !== openid) throw errors.fail(5004, { hint: '任务不存在或已被删除' })
    return task
  }

  async function loadOwnedAsset(openid, assetId, expectedKind) {
    assert(util.isAssetId(assetId), 1001, { hint: 'assetId 不合法' })
    var asset = await store.getAsset(assetId)
    if (!asset) throw errors.fail(1001, { hint: '资产不存在或已过期，请重新上传' })
    if (asset.openid !== openid) throw errors.fail(1004, { hint: '无权访问该资产' })
    if (expectedKind && asset.kind !== expectedKind) {
      throw errors.fail(1001, { hint: '资产类型不匹配：需要 ' + expectedKind })
    }
    return asset
  }

  async function quotaView(openid) {
    var user = await store.getUser(openid)
    var config = await store.getConfig()
    var dayKey = util.beijingDayKey(now())
    var vip = !!(user && user.vip)
    var limit = vip ? config.dailyLimitVip : config.dailyLimitNormal
    var used = user && user.dayKey === dayKey ? user.usedToday : 0
    return {
      used: used,
      limit: limit,
      remaining: Math.max(0, limit - used),
      vip: vip,
      dayKey: dayKey,
      resetAt: util.beijingResetAt(now())
    }
  }

  function quotaFromConsumed(consumed) {
    if (consumed && consumed.quota) return consumed.quota
    return { used: 0, limit: 0, remaining: 0, vip: false, dayKey: util.beijingDayKey(now()), resetAt: util.beijingResetAt(now()) }
  }

  /**
   * 任务失败/超时统一处理：置终态 + 幂等返还额度 + 尽力清理供应商侧。
   * @param {object} task 当前任务快照
   * @param {number} code 内部错误码（5002 → TIMEOUT，其余 → FAILED）
   * @param {object} [extra] 额外字段
   */
  async function failTask(task, code, extra) {
    var meta = errors.getMeta(code)
    var status = code === 5002 ? 'TIMEOUT' : 'FAILED'
    var vendorDetail = vendorDetailOf(extra && extra.cause)
    var failure = {
      code: code,
      name: meta.name,
      hint: (extra && extra.hint) || (code === 3015 ? VENDOR_LIMIT_HINT : ''),
      vendorCode: vendorDetail.vendorCode,
      httpStatus: vendorDetail.httpStatus,
      at: now()
    }
    if (extra && extra.failure) {
      Object.assign(failure, extra.failure)
    }
    var patch = {
      status: status,
      stage: status,
      failureCode: code,
      failureName: meta.name,
      failureMessage: meta.message,
      failure: failure,
      statusUpdatedAt: now()
    }
    if (!task.quotaRefunded) {
      patch.quotaRefunded = true
    }
    var updated = await store.updateTask(task.taskId, patch)
    if (patch.quotaRefunded) {
      await store.refundQuota(updated.openid)
    }
    if (updated.vendorTaskId && vendor) {
      try {
        if (typeof vendor.cancel === 'function') await vendor.cancel({ vendorTaskId: updated.vendorTaskId })
      } catch (cancelError) {
        // 尽力而为，不阻断错误返回
      }
      try {
        if (typeof vendor.erase === 'function') await vendor.erase({ vendorTaskId: updated.vendorTaskId })
      } catch (eraseError) {
        // 尽力而为
      }
    }
    return updated
  }

  async function saveSuccess(task, queryResult) {
    if (!queryResult || !queryResult.imageBuffer) {
      return failTask(task, 5005)
    }
    var width = queryResult.width
    var height = queryResult.height
    if (!(width > 0) || !(height > 0)) {
      return failTask(task, 5005)
    }
    var saved
    try {
      saved = await storage.saveResult({
        taskId: task.taskId,
        buffer: queryResult.imageBuffer,
        width: width,
        height: height
      })
    } catch (saveError) {
      return failTask(task, 9000)
    }
    var updated = await store.updateTask(task.taskId, {
      status: 'SUCCEEDED',
      stage: 'DONE',
      successAt: now(),
      statusUpdatedAt: now(),
      resultFileID: saved.fileID,
      resultWidth: width,
      resultHeight: height,
      failureCode: null,
      failureName: null,
      failureMessage: null,
      failure: null
    })
    if (updated.vendorTaskId && vendor && typeof vendor.erase === 'function') {
      try {
        await vendor.erase({ vendorTaskId: updated.vendorTaskId })
      } catch (eraseError) {
        // 结果已转存，供应商侧删除失败不阻断（cloud 侧有 cleanup 兜底）
      }
    }
    return updated
  }

  async function buildTaskView(task) {
    var view = {
      taskId: task.taskId,
      status: task.status,
      stage: task.stage || STAGE_OF_STATUS[task.status] || task.status,
      waitedSec: Math.max(0, Math.floor((now() - task.createdAt) / 1000)),
      createdAt: task.createdAt,
      purgeAt: task.purgeAt
    }
    var quota = await quotaView(task.openid)
    view.quota = { remaining: quota.remaining }
    if (task.status === 'SUCCEEDED' && task.resultFileID) {
      view.result = {
        fileID: task.resultFileID,
        width: task.resultWidth,
        height: task.resultHeight,
        sizeResult: task.sizeResult === undefined ? null : task.sizeResult
      }
      var longSide = Math.max(task.resultWidth || 0, task.resultHeight || 0)
      if (longSide > 0 && longSide < 2048) {
        view.result.sizeFallback = {
          degraded: true,
          longSide: longSide,
          expected: 2048,
          requiresReview: true
        }
      }
    }
    if (task.failureCode) {
      var meta = errors.getMeta(task.failureCode)
      view.failure = {
        code: task.failureCode,
        name: task.failureName || meta.name,
        message: task.failureMessage || meta.message,
        hint: meta.message
      }
      // SPEC v0.11 §B.4：透出脱敏后的供应商错误码/状态，便于客户端与排障区分参数类错误。
      if (task.failure && task.failure.vendorCode !== undefined && task.failure.vendorCode !== null) {
        view.failure.vendorCode = task.failure.vendorCode
      }
      if (task.failure && typeof task.failure.httpStatus === 'number') {
        view.failure.httpStatus = task.failure.httpStatus
      }
    }
    return view
  }

  async function reconcileActive(openid) {
    var active = await store.getActiveTask(openid)
    if (!active) return null
    if (now() - active.createdAt >= taskTimeoutMs) {
      return failTask(active, 5002)
    }
    return active
  }

  // ---------------------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------------------

  /** API-5 assetRegister */
  async function assetRegister(payload, ctx) {
    await assertConsent(ctx.openid)
    util.assertClientReqId(payload.clientReqId)
    // SPEC v0.11 §B.2：登记即拒不合规资产（不登记、不预检、不提交供应商）。
    // 先按原始 payload 做供应商规格粗判（超规格 → 3015，而非 1001），再走通用参数校验。
    assertVendorSpecPayload(payload)
    var normalized = util.validateAssetPayload(payload)
    assertVendorSpecAsset(normalized)

    var existing = await store.findAssetByClientReqId(ctx.openid, payload.clientReqId)
    if (existing) {
      return { assetId: existing.assetId, kind: existing.kind, purgeAt: existing.purgeAt }
    }

    var createdAt = now()
    var asset = {
      assetId: util.newAssetId(),
      openid: ctx.openid,
      clientReqId: payload.clientReqId,
      kind: normalized.kind,
      fileID: normalized.fileID,
      cloudPath: payload.cloudPath || '',
      mime: normalized.mime,
      bytes: normalized.bytes,
      width: normalized.width,
      height: normalized.height,
      createdAt: createdAt,
      purgeAt: createdAt + util.PURGE_TTL_MS
      // task-37：不再初始化 `precheck: null`（真实云 update 深合并进 null 会报 -502001；
      // 存量 null 文档由 cloud-store 的 command.set 写通道兼容）。
    }
    await store.saveAsset(asset)
    return { assetId: asset.assetId, kind: asset.kind, purgeAt: asset.purgeAt }
  }

  function precheckPublic(record, cached) {
    var data = {
      pass: !!record.pass,
      status: record.status,
      checks: record.checks || []
    }
    if (record.code) data.code = record.code
    if (record.name) data.name = record.name
    if (record.message) data.message = record.message
    if (record.hint) data.hint = record.hint
    if (record.detail) data.detail = record.detail
    if (cached) data.cached = true
    return data
  }

  /** API-6 precheck：三态；unknown 不得当 pass；同 assetId 10min 缓存。 */
  async function precheck(payload, ctx) {
    await assertConsent(ctx.openid)
    var asset = await loadOwnedAsset(ctx.openid, payload.assetId)

    if (asset.precheck && asset.precheck.at && now() - asset.precheck.at < util.PRECHECK_CACHE_MS) {
      return precheckPublic(asset.precheck, true)
    }

    // 服务端兜底（SPEC v0.8 F-17 / 3014）：长边 <1024 或 >4096 的资产不进入供应商预检。
    var assetLongSide = Math.max(Number(asset.width) || 0, Number(asset.height) || 0)
    if (assetLongSide > 0 && (assetLongSide < MIN_PRECHECK_LONG_SIDE || assetLongSide > util.MAX_LONG_SIDE)) {
      var sizeRecord = {
        pass: false,
        status: 'fail',
        code: 3014,
        name: 'E_PRECHECK_TOO_SMALL',
        message: errors.getMeta(3014).message,
        hint:
          assetLongSide < MIN_PRECHECK_LONG_SIDE
            ? '照片分辨率过低，请重新拍摄（长边至少 1024 像素）'
            : '压缩后照片仍超过 4096 像素，请更换照片',
        checks: [],
        at: now()
      }
      await store.updateAsset(asset.assetId, { precheck: sizeRecord })
      return precheckPublic(sizeRecord, false)
    }

    var buffer
    try {
      buffer = await withTimeout(storage.download(asset.fileID), precheckTimeoutMs, 5002, '预检超时，请重试')
    } catch (downloadError) {
      if (downloadError && downloadError.isAppError) throw downloadError
      throw errors.fail(5001, { hint: '图片下载失败，请重试' })
    }

    var raw
    try {
      raw = await withTimeout(
        precheckAdapter.validate({ buffer: buffer, mime: asset.mime, kind: asset.kind }),
        precheckTimeoutMs,
        5002,
        '预检超时，请重试'
      )
    } catch (checkError) {
      if (checkError && checkError.isAppError) throw checkError
      throw errors.fail(5001, { hint: '预检服务暂时不可用，请稍后重试' })
    }

    var normalizedResult = precheckLib.normalizeResult(raw)
    var record = {
      pass: normalizedResult.pass,
      status: normalizedResult.status,
      checks: normalizedResult.checks || [],
      at: now()
    }
    // task-35：云数据库写 data 不允许 undefined（precheck pass/unknown 分支的
    // code/name/message/hint/detail 可能为 undefined），只写确实存在的可选字段。
    if (normalizedResult.code !== undefined) record.code = normalizedResult.code
    if (normalizedResult.name !== undefined) record.name = normalizedResult.name
    if (normalizedResult.message !== undefined) record.message = normalizedResult.message
    if (normalizedResult.hint !== undefined) record.hint = normalizedResult.hint
    if (normalizedResult.detail !== undefined) record.detail = normalizedResult.detail
    await store.updateAsset(asset.assetId, { precheck: record })
    return precheckPublic(record, false)
  }

  /** API-7 createTask */
  async function createTask(payload, ctx) {
    await assertConsent(ctx.openid)
    util.assertClientReqId(payload.clientReqId)
    var personAssetIds = util.unique(util.normalizeArray(payload.personAssetIds))
    assert(personAssetIds.length >= 1 && personAssetIds.length <= 3, 1001, {
      hint: '人像照片需为 1–3 张'
    })
    assert(util.isAssetId(payload.garmentAssetId), 1001, { hint: 'garmentAssetId 不合法' })
    var metrics = util.validateMetrics(payload.metrics)

    // 幂等：同一 clientReqId 直接返回已创建任务，不重复扣额度
    var existing = await store.getTaskByClientReqId(ctx.openid, payload.clientReqId)
    if (existing) {
      return {
        taskId: existing.taskId,
        status: existing.status,
        quota: await quotaView(ctx.openid),
        createdAt: existing.createdAt,
        purgeAt: existing.purgeAt
      }
    }

    // 资产归属与类型校验（越权按不存在处理）
    var personAssets = []
    for (var i = 0; i < personAssetIds.length; i += 1) {
      personAssets.push(await loadOwnedAsset(ctx.openid, personAssetIds[i], 'PERSON'))
    }
    var garmentAsset = await loadOwnedAsset(ctx.openid, payload.garmentAssetId, 'GARMENT')

    // SPEC v0.11 §B.2：提交前再校验供应商规格，不合规不建任务、不扣额度、不提交供应商。
    var allAssets = personAssets.concat([garmentAsset])
    allAssets.forEach(function (asset) {
      assertVendorSpecAsset(asset)
    })

    // 预检必须为 pass；unknown/fail 均拒绝创建且不扣额度
    allAssets.forEach(function (asset) {
      var status = asset.precheck && asset.precheck.status
      if (status !== 'pass') {
        throw errors.fail(3000, {
          hint: status === 'unknown' ? '照片校验暂时无法完成，请换一张后重试' : '照片预检未通过，请重新拍摄或更换照片'
        })
      }
    })

    // 单活跃任务：先处理已超时的活跃任务（置 TIMEOUT 并返还额度）
    var active = await reconcileActive(ctx.openid)
    if (active && IN_PROGRESS.indexOf(active.status) >= 0) {
      throw errors.fail(2002, {
        hint: '已有进行中的生成任务，请等待完成或取消后再试',
        detail: { existingTaskId: active.taskId }
      })
    }

    var config = await store.getConfig()
    var consumed = await store.consumeQuota({ openid: ctx.openid, now: now(), config: config })
    if (!consumed || !consumed.ok) {
      throw errors.fail(2001, { hint: '今日额度已用完，明日 00:00 重置' })
    }

    var createdAt = now()
    var taskId = util.newTaskId()
    var sizeResult = null
    try {
      sizeResult = sizeLib.computeSize(metrics)
    } catch (sizeError) {
      sizeResult = null
    }
    var task = {
      taskId: taskId,
      openid: ctx.openid,
      clientReqId: payload.clientReqId,
      status: 'QUEUED',
      stage: 'QUEUED',
      personAssetIds: personAssetIds,
      garmentAssetId: payload.garmentAssetId,
      metrics: util.toStoredMetrics(metrics),
      sizeResult: sizeResult,
      resultFileID: null,
      resultWidth: null,
      resultHeight: null,
      vendorProvider: (vendor && vendor.provider) || config.vendorProvider || 'mock',
      vendorTaskId: null,
      submittedAt: null,
      successAt: null,
      statusUpdatedAt: createdAt,
      createdAt: createdAt,
      purgeAt: createdAt + util.PURGE_TTL_MS,
      quotaRefunded: false,
      failureCode: null,
      failureName: null,
      failureMessage: null
    }

    try {
      await store.saveTask(task)
      // 资源与任务绑定
      for (var j = 0; j < allAssets.length; j += 1) {
        await store.updateAsset(allAssets[j].assetId, { taskId: taskId })
      }
      // 读取图片并提交供应商
      var personBuffers = await Promise.all(
        personAssets.map(function (asset) { return storage.download(asset.fileID) })
      )
      var garmentBuffer = await storage.download(garmentAsset.fileID)
      var submission = await vendor.submit({
        personBuffers: personBuffers,
        garmentBuffer: garmentBuffer,
        metrics: metrics
      })
      if (!submission || !submission.vendorTaskId) {
        throw errors.fail(5005, { hint: '供应商未返回任务号' })
      }
      var updated = await store.updateTask(taskId, {
        vendorTaskId: submission.vendorTaskId,
        submittedAt: now(),
        statusUpdatedAt: now()
      })
      return {
        taskId: taskId,
        status: updated.status,
        quota: quotaFromConsumed(consumed),
        createdAt: createdAt,
        purgeAt: task.purgeAt
      }
    } catch (createError) {
      // 供应商提交失败/内部异常：任务置 FAILED、额度幂等返还，然后把错误抛给客户端
      var appError = createError && createError.isAppError ? createError : null
      var current = await store.getTask(taskId)
      if (current && IN_PROGRESS.indexOf(current.status) >= 0) {
        await failTask(current, appError ? appError.code : 5001, appError ? { cause: appError } : {})
      } else if (current) {
        // 任务已存在但未进入 SUCCEEDED：兜底返还一次
        if (!current.quotaRefunded) {
          await store.updateTask(taskId, { quotaRefunded: true })
          await store.refundQuota(ctx.openid)
        }
      } else {
        await store.refundQuota(ctx.openid)
      }
      throw createError && createError.isAppError
        ? createError
        : errors.fail(5001, { hint: '生成服务暂时不可用，请稍后重试' })
    }
  }

  /** API-8 taskGet */
  async function taskGet(payload, ctx) {
    await assertConsent(ctx.openid)
    var task = await loadOwnedTask(ctx.openid, payload.taskId)

    if (TERMINAL.indexOf(task.status) >= 0) {
      return buildTaskView(task)
    }

    if (now() - task.createdAt >= taskTimeoutMs) {
      var timedOut = await failTask(task, 5002)
      return buildTaskView(timedOut)
    }

    var queryResult
    try {
      queryResult = await vendor.query({ vendorTaskId: task.vendorTaskId })
    } catch (queryError) {
      var failed = await failTask(task, 5001, {
        cause: queryError && queryError.isAppError ? queryError : null
      })
      return buildTaskView(failed)
    }

    var state = queryResult && queryResult.state
    if (state === 'PENDING') {
      if (task.status !== 'QUEUED') {
        task = await store.updateTask(task.taskId, { status: 'QUEUED', stage: 'QUEUED', statusUpdatedAt: now() })
      }
      return buildTaskView(task)
    }
    if (state === 'RUNNING') {
      if (task.status !== 'GENERATING') {
        task = await store.updateTask(task.taskId, {
          status: 'GENERATING',
          stage: 'GENERATING',
          statusUpdatedAt: now()
        })
      }
      return buildTaskView(task)
    }
    if (state === 'SUCCEEDED') {
      var succeeded = await saveSuccess(task, queryResult)
      return buildTaskView(succeeded)
    }
    if (state === 'FAILED') {
      var mapped = mapVendorFailure(queryResult.failureCode)
      var failedTask = await failTask(task, mapped, {
        cause: {
          detail: {
            vendorCode: queryResult.vendorCode,
            httpStatus: queryResult.httpStatus
          }
        }
      })
      return buildTaskView(failedTask)
    }
    var invalid = await failTask(task, 5005)
    return buildTaskView(invalid)
  }

  /** API-9 cancelTask */
  async function cancelTask(payload, ctx) {
    await assertConsent(ctx.openid)
    var task = await loadOwnedTask(ctx.openid, payload.taskId)
    if (task.status === 'CANCELLED') {
      var quotaCached = await quotaView(ctx.openid)
      return { status: 'CANCELLED', quota: { remaining: quotaCached.remaining } }
    }
    if (TERMINAL.indexOf(task.status) >= 0) {
      throw errors.fail(1001, { hint: '任务已结束，无法取消' })
    }
    var patch = {
      status: 'CANCELLED',
      stage: 'CANCELLED',
      statusUpdatedAt: now()
    }
    if (!task.quotaRefunded) patch.quotaRefunded = true
    var updated = await store.updateTask(task.taskId, patch)
    if (patch.quotaRefunded) await store.refundQuota(updated.openid)
    if (updated.vendorTaskId && vendor && typeof vendor.cancel === 'function') {
      try {
        await vendor.cancel({ vendorTaskId: updated.vendorTaskId })
      } catch (cancelError) {
        // 尽力而为
      }
    }
    var quota = await quotaView(ctx.openid)
    return { status: 'CANCELLED', quota: { remaining: quota.remaining } }
  }

  /** API-10 deleteTask：同一调用内物理删对象 → 资产记录 → 任务记录。 */
  async function deleteTask(payload, ctx) {
    await assertConsent(ctx.openid)
    var task = await loadOwnedTask(ctx.openid, payload.taskId)

    // 进行中任务删除等价取消：先返还额度（幂等一次）
    if (!task.quotaRefunded && IN_PROGRESS.indexOf(task.status) >= 0) {
      await store.updateTask(task.taskId, { quotaRefunded: true })
      await store.refundQuota(task.openid)
    }

    var assetIds = (task.personAssetIds || []).concat(task.garmentAssetId ? [task.garmentAssetId] : [])
    var assets = []
    for (var i = 0; i < assetIds.length; i += 1) {
      var asset = await store.getAsset(assetIds[i])
      if (asset) assets.push(asset)
    }
    var fileIDs = assets
      .map(function (item) { return item.fileID })
      .filter(function (id) { return !!id })
    if (task.resultFileID) fileIDs.push(task.resultFileID)

    // 对象删除失败则整体失败，不删数据库记录（保证不出现"记录没图"的中间态）
    try {
      if (fileIDs.length && typeof storage.deleteFiles === 'function') {
        await storage.deleteFiles(fileIDs)
      }
    } catch (deleteError) {
      throw errors.fail(9000, { hint: '删除失败，请稍后重试' })
    }

    if (task.vendorTaskId && vendor && typeof vendor.erase === 'function') {
      try {
        await vendor.erase({ vendorTaskId: task.vendorTaskId })
      } catch (eraseError) {
        // 尽力而为：云侧对象与记录已删，供应商侧由合同清理
      }
    }

    for (var j = 0; j < assets.length; j += 1) {
      await store.deleteAsset(assets[j].assetId)
    }
    await store.deleteTask(task.taskId)

    return { deletedAt: now() }
  }

  /** API-11 auditTask（仅测试环境 + QA openid 白名单）。 */
  async function auditTask(payload, ctx) {
    var allowDebug = String(env.ALLOW_DEBUG_AUDIT || '').toLowerCase() === 'true'
    var whitelist = String(env.QA_OPENID_WHITELIST || '')
      .split(',')
      .map(function (item) { return item.trim() })
      .filter(function (item) { return !!item })
    if (!allowDebug || whitelist.indexOf(ctx.openid) < 0) {
      throw errors.fail(1004, { hint: '审计接口仅在测试环境对 QA 白名单开放' })
    }
    assert(util.isTaskId(payload.taskId), 1001, { hint: 'taskId 不合法' })
    var task = await store.getTask(payload.taskId)
    if (!task || task.openid !== ctx.openid) {
      return { exists: false }
    }
    var assetIds = (task.personAssetIds || []).concat(task.garmentAssetId ? [task.garmentAssetId] : [])
    var assets = []
    for (var i = 0; i < assetIds.length; i += 1) {
      var asset = await store.getAsset(assetIds[i])
      assets.push({
        assetId: assetIds[i],
        kind: asset ? asset.kind : null,
        exists: !!asset
      })
    }
    return {
      exists: true,
      task: { status: task.status, createdAt: task.createdAt, purgeAt: task.purgeAt },
      assets: assets,
      result: { exists: !!task.resultFileID }
    }
  }

  var actions = {
    assetRegister: assetRegister,
    precheck: precheck,
    createTask: createTask,
    taskGet: taskGet,
    cancelTask: cancelTask,
    deleteTask: deleteTask,
    auditTask: auditTask
  }

  async function handle(event, ctx) {
    ctx = ctx || {}
    try {
      if (!ctx.openid) throw errors.fail(1004, { hint: '无法获取用户身份' })
      var action = event && event.action
      if (typeof action !== 'string' || !actions[action]) {
        throw errors.fail(1001, { hint: '未知 action: ' + String(action) })
      }
      var data = await actions[action](event || {}, { openid: ctx.openid })
      return envelopeOk(data)
    } catch (error) {
      return envelopeFail(error)
    }
  }

  return { handle: handle, actions: actions, requestId: requestId }
}

module.exports = {
  createHandler: createHandler,
  ACTIONS: ACTIONS,
  IN_PROGRESS: IN_PROGRESS,
  TERMINAL: TERMINAL,
  STAGE_OF_STATUS: STAGE_OF_STATUS,
  mapVendorFailure: mapVendorFailure
}
