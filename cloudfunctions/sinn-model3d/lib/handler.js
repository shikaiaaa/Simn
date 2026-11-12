/**
 * lib/handler.js —— sinn-model3d 业务入口（SPEC-0002 §B.1/§B.2，API-02-01..05）。
 *
 * 设计约束：
 * - 统一信封 `{ ok, data, error, requestId, serverTime }`（与 P1 完全一致）；
 * - openid 只来自 `cloud.getWXContext()`（index.js 注入 auth），请求体里的 openid 一律忽略；
 * - 3D 任务不扣 2D 额度；日上限走 SINN_MODEL3D_DAILY_LIMIT（默认 0=不限）；
 * - 状态机 QUEUED→GENERATING→SAVING→SUCCEEDED/FAILED/TIMEOUT/CANCELLED；
 * - 供应商成功但模型不可用（node/mesh=0、非 glb、损坏、>45MB）→ FAILED 6002/6003，不写正式记录；
 * - 供应商异常（网络/鉴权/额度）→ 6001；查询期间失败落库后由 get 返回 failure（与 P1 taskGet 一致）；
 * - 成功模型长期保留（purgeAt=null），失败/超时中间产物由 sinn-cleanup 24h 清理。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var glb = require('./glb')

var ASSET_ID_RE = /^a_[0-9a-f]{24}$/
var ACTIONS = ['model3dSubmit', 'model3dGet', 'model3dList', 'model3dDelete', 'model3dDeleteAll']

function envelopeOk(data, requestId, serverTime) {
  return { ok: true, data: data, error: null, requestId: requestId, serverTime: serverTime }
}

function envelopeFail(error, requestId, serverTime) {
  var normalized = errors.normalizeError(error)
  return {
    ok: false,
    data: null,
    error: {
      code: normalized.code,
      name: normalized.name,
      message: normalized.message,
      hint: normalized.hint || '',
      httpStatus: normalized.httpStatus
    },
    requestId: requestId,
    serverTime: serverTime
  }
}

function createHandler(deps) {
  deps = deps || {}
  var store = deps.store
  var storage = deps.storage
  var vendor = deps.vendor
  var env = deps.env || {}
  if (!store) throw new Error('createHandler 需要 store')
  if (!storage) throw new Error('createHandler 需要 storage')
  if (!vendor) throw new Error('createHandler 需要 vendor')

  var now = typeof deps.now === 'function' ? deps.now : function () { return Date.now() }
  var nextRequestId = typeof deps.requestId === 'function' ? deps.requestId : util.newRequestId
  var timeoutMs = util.isFiniteNumber(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : util.resolveTimeoutMs(env)
  var dailyLimit = util.isFiniteNumber(deps.model3dDailyLimit) ? deps.model3dDailyLimit : util.resolveDailyLimit(env)
  var provider = deps.provider || env.SINN_VENDOR_3D || vendor.provider || 'mock'

  // ---------- 小工具 ----------

  function purgeAtFor(createdAt) {
    return createdAt + util.PURGE_TTL_MS
  }

  function assertOpenid(openid) {
    if (!openid) throw errors.fail(1001, { hint: '缺少用户标识' })
    return openid
  }

  function assertPersonAssetIds(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > util.MAX_PERSON_ASSETS) {
      throw errors.fail(1001, { hint: 'personAssetIds 需为 1–3 个资产 ID' })
    }
    var seen = {}
    value.forEach(function (id) {
      if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) {
        throw errors.fail(1001, { hint: 'personAssetIds 含非法资产 ID' })
      }
      if (seen[id]) throw errors.fail(1001, { hint: 'personAssetIds 不能重复' })
      seen[id] = true
    })
    return value.slice()
  }

  function modelView(model, withUrl) {
    if (!model) return null
    var view = {
      modelId: model.modelId,
      format: model.format || 'glb',
      modelFileID: model.modelFileID || null,
      bytes: util.isFiniteNumber(model.bytes) ? model.bytes : null,
      textureCount: util.isFiniteNumber(model.textureCount) ? model.textureCount : null,
      triangleCount: util.isFiniteNumber(model.triangleCount) ? model.triangleCount : null,
      createdAt: model.createdAt,
      modelUrl: null
    }
    if (!withUrl || !model.modelFileID) return Promise.resolve(view)
    return storage
      .getTempFileURL([model.modelFileID])
      .then(function (fileList) {
        var item = (fileList || [])[0]
        if (item && item.tempFileURL) view.modelUrl = item.tempFileURL
        return view
      })
      .catch(function () { return view })
  }

  function stageOfTask(task) {
    if (task.status === 'QUEUED') return 'QUEUED'
    if (task.status === 'GENERATING') return task.stage === 'TEXTURING' ? 'TEXTURING' : 'MODELING'
    if (task.status === 'SAVING') return 'SAVING'
    if (task.status === 'SUCCEEDED') return 'DONE'
    return task.stage || task.status
  }

  function failureOf(task) {
    if (task.failure && typeof task.failure === 'object') return task.failure
    if (!task.failureCode) return null
    var meta = errors.getMeta(task.failureCode)
    return {
      code: task.failureCode,
      name: meta.name,
      message: task.failureMessage || meta.message,
      hint: task.failureHint || meta.hint || '',
      at: task.statusUpdatedAt || task.finishedAt || null
    }
  }

  function buildTaskView(task, options) {
    options = options || {}
    var startedAt = util.isFiniteNumber(task.startedAt) ? task.startedAt : task.createdAt
    var elapsedMs = Math.max(0, now() - (util.isFiniteNumber(startedAt) ? startedAt : now()))
    var view = {
      taskId: task.taskId,
      status: task.status,
      stage: stageOfTask(task),
      progress: { stage: stageOfTask(task), etaSec: null, elapsedMs: elapsedMs },
      startedAt: startedAt,
      timeoutAt: util.isFiniteNumber(startedAt) ? startedAt + timeoutMs : null,
      modelId: task.modelId || null,
      model: null,
      failure: failureOf(task)
    }
    if (!task.modelId) return Promise.resolve(view)
    return store.getModel(task.modelId).then(function (model) {
      if (!model) return view
      return modelView(model, !!options.withModelUrl).then(function (modelData) {
        view.model = modelData
        return view
      })
    })
  }

  function withUrls(personUrls, env2) {
    return personUrls
  }

  // ---------- 任务状态迁移 ----------

  async function failTask(task, code, options) {
    options = options || {}
    var meta = errors.getMeta(code)
    var cause = options.cause
    var detail = (cause && cause.detail) || options.detail || {}
    var hint = options.hint || (cause && cause.hint) || meta.hint || ''
    var failure = {
      code: code,
      name: meta.name,
      message: options.message || (cause && cause.message) || meta.message,
      hint: hint,
      vendorCode: detail.vendorCode === undefined ? null : String(detail.vendorCode),
      httpStatus: util.isFiniteNumber(detail.httpStatus) ? detail.httpStatus : null,
      at: now()
    }
    var status = code === 5002 ? 'TIMEOUT' : 'FAILED'
    var patch = {
      status: status,
      stage: 'FAILED',
      failureCode: code,
      failureName: meta.name,
      failureMessage: failure.message,
      failureHint: hint,
      failure: failure,
      finishedAt: now(),
      statusUpdatedAt: now(),
      purgeAt: purgeAtFor(util.isFiniteNumber(task.createdAt) ? task.createdAt : now())
    }
    return store.updateTask(task.taskId, patch)
  }

  async function markGenerating(task, patch) {
    var merged = {
      status: 'GENERATING',
      stage: patch && patch.stage ? patch.stage : task.stage || 'MODELING',
      statusUpdatedAt: now(),
      stageUpdatedAt: now()
    }
    return store.updateTask(task.taskId, merged)
  }

  async function processSuccess(task, openid) {
    if (task.status === 'SUCCEEDED' && task.modelId) {
      var existingModel = await store.getModel(task.modelId)
      if (existingModel) return task
    }
    if (task.status !== 'SAVING') {
      await store.updateTask(task.taskId, {
        status: 'SAVING',
        stage: 'SAVING',
        statusUpdatedAt: now(),
        stageUpdatedAt: now()
      })
    }
    var asset = await vendor.fetchAsset({ vendorJobId: task.vendorJobId, openid: openid })
    if (!asset || !Buffer.isBuffer(asset.buffer)) {
      throw errors.fail(6002, { hint: '供应商模型数据为空' })
    }
    var meta = glb.validateModelBuffer(asset.buffer)
    var modelId = util.newModelId()
    var hash = util.openidHash(openid)
    var uploaded = await storage.uploadModel(asset.buffer, { openidHash: hash, modelId: modelId })
    var createdAt = now()
    var model = {
      modelId: modelId,
      openid: openid,
      taskId: task.taskId,
      format: 'glb',
      modelFileID: uploaded.fileID,
      cloudPath: uploaded.cloudPath,
      bytes: meta.bytes,
      textureCount: meta.textureCount,
      textureBytes: meta.textureBytes,
      nodeCount: meta.nodeCount,
      meshCount: meta.meshCount,
      primitiveCount: meta.primitiveCount,
      triangleCount: meta.triangleCount,
      thumbnailFileID: null,
      cloudThumbPath: null,
      vendorProvider: task.vendorProvider || provider,
      vendorJobId: task.vendorJobId || null,
      status: 'READY',
      createdAt: createdAt,
      updatedAt: createdAt
    }
    await store.saveModel(model)
    return store.updateTask(task.taskId, {
      status: 'SUCCEEDED',
      stage: 'DONE',
      modelId: modelId,
      // 成功后模型长期保留，但 3D 输入照片按 SPEC §4 在创建 +23h 由 cleanup 物理删除：
      // cleanup 对 SUCCEEDED 的 3D 任务只清照片、把 purgeAt 置 null，模型记录不动。
      purgeAt: purgeAtFor(util.isFiniteNumber(task.createdAt) ? task.createdAt : now()),
      finishedAt: now(),
      statusUpdatedAt: now(),
      modelCreatedAt: createdAt
    })
  }

  async function advanceTask(task, openid) {
    if (!task.vendorJobId) {
      return failTask(task, 6002, { hint: '任务缺少供应商任务标识' })
    }
    var state
    try {
      state = await vendor.query({ vendorJobId: task.vendorJobId, openid: openid })
    } catch (error) {
      // 供应商不可用/网络/鉴权：任务落 FAILED(6001)，客户端可重试（不静默吞错）。
      return failTask(task, error && error.isAppError ? error.code : 6001, { cause: error })
    }
    var status = state && state.status
    if (status === 'PENDING') return task
    if (status === 'BUILDING') return markGenerating(task, { stage: 'MODELING' })
    if (status === 'TEXTURING') return markGenerating(task, { stage: 'TEXTURING' })
    if (status === 'FAILED') {
      return failTask(task, 6002, {
        hint: '3D 生成失败，请重试',
        detail: { vendorCode: state.failureCode, httpStatus: state.httpStatus }
      })
    }
    if (status === 'CANCELLED') return failTask(task, 5002, { hint: '3D 生成已取消，请重试' })
    if (status === 'SUCCEEDED') {
      try {
        return await processSuccess(task, openid)
      } catch (error) {
        return failTask(task, error && error.isAppError ? error.code : 6002, { cause: error })
      }
    }
    throw errors.fail(6002, { hint: '供应商返回未知任务状态' })
  }

  // ---------- 校验 ----------

  function validateVendorSpecAsset(asset) {
    if (!asset) throw errors.fail(5007, { hint: '人像资产不存在，请重新上传' })
    var bytes = asset.bytes
    var width = asset.width
    var height = asset.height
    var mime = asset.mime
    if (!util.isFiniteNumber(bytes) || bytes <= 0 || !util.isFiniteNumber(width) || !util.isFiniteNumber(height) || width <= 0 || height <= 0) {
      throw errors.fail(5007, { hint: '人像资产信息不完整，请重新上传' })
    }
    var longSide = Math.max(width, height)
    if (bytes > util.VENDOR_MAX_BYTES || longSide > util.VENDOR_MAX_LONG_SIDE || mime !== util.VENDOR_MIME) {
      throw errors.fail(3015, {
        hint: '照片超出供应商规格（≤5MB、长边 ≤4096、JPG），请重新选择或由端上压缩后重试'
      })
    }
    return asset
  }

  async function loadOwnedPersonAssets(openid, assetIds) {
    var assets = []
    for (var i = 0; i < assetIds.length; i += 1) {
      var asset = await store.getAsset(assetIds[i])
      if (!asset || asset.openid !== openid || asset.kind !== 'person') {
        throw errors.fail(1001, { hint: 'personAssetIds 含不属于当前用户的人像资产' })
      }
      assets.push(validateVendorSpecAsset(asset))
    }
    return assets
  }

  async function resolvePersonUrls(assets) {
    var fileIDs = assets.map(function (asset) { return asset.fileID })
    var fileList = await storage.getTempFileURL(fileIDs)
    var byId = {}
    ;(fileList || []).forEach(function (item) {
      if (item && item.fileID) byId[item.fileID] = item.tempFileURL || ''
    })
    return assets.map(function (asset) {
      var url = byId[asset.fileID]
      if (!url) throw errors.fail(5007, { hint: '人像图片链接获取失败，请重新上传' })
      return url
    })
  }

  async function assertConsent(openid) {
    var consent = await store.getConsent(openid)
    if (!consent) {
      throw errors.fail(1003, { hint: '需同意隐私政策（含 3D 形象生成披露）后再使用该功能' })
    }
    return consent
  }

  // ---------- actions ----------

  async function submit(payload, ctx) {
    var openid = assertOpenid(ctx.openid)
    await assertConsent(openid)
    payload = payload || {}
    util.assertClientReqId(payload.clientReqId)
    var personAssetIds = assertPersonAssetIds(payload.personAssetIds)
    var metrics = util.validateMetrics(payload.metrics)

    var existing = await store.getTaskByClientReqId(openid, payload.clientReqId)
    if (existing) {
      return {
        taskId: existing.taskId,
        status: existing.status === 'QUEUED' ? 'QUEUED' : existing.status,
        createdAt: existing.createdAt,
        vendorProvider: existing.vendorProvider || provider
      }
    }

    var active = await store.getActiveModel3dTask(openid)
    if (active) {
      throw errors.fail(2002, {
        hint: '已有进行中的 3D 形象任务，请等待完成后再提交',
        detail: { existingTaskId: active.taskId }
      })
    }

    var assets = await loadOwnedPersonAssets(openid, personAssetIds)
    var personUrls = await resolvePersonUrls(assets)

    var createdAt = now()
    var quota = await store.consumeModel3dDaily({ openid: openid, now: createdAt, limit: dailyLimit })
    if (!quota.ok) {
      throw errors.fail(6006, {
        hint: '今日 3D 生成次数已用完（每日 ' + quota.limit + ' 次）',
        detail: { resetAt: quota.resetAt }
      })
    }

    var task = {
      _id: util.newTaskId(),
      taskId: util.newTaskId(),
      taskType: util.MODEL_TASK_TYPE,
      openid: openid,
      clientReqId: payload.clientReqId,
      status: 'QUEUED',
      stage: 'QUEUED',
      vendorProvider: provider,
      vendorJobId: null,
      personAssetIds: personAssetIds,
      metrics: util.toStoredMetrics(metrics),
      modelId: null,
      createdAt: createdAt,
      startedAt: createdAt,
      statusUpdatedAt: createdAt,
      finishedAt: null,
      purgeAt: purgeAtFor(createdAt),
      failureCode: null,
      failureName: null,
      failureMessage: null,
      failureHint: null,
      failure: null
    }
    delete task._id
    await store.saveTask(task)

    // 把人像资产绑定到 3D 任务：失败/超时任务由 sinn-cleanup 24h 物理删除照片（SPEC §4）。
    for (var a = 0; a < assets.length; a += 1) {
      try {
        await store.updateAsset(assets[a].assetId, { taskId: task.taskId })
      } catch (bindError) {
        // 绑定失败不影响生成；cleanup 兜底能力降级（记录在任务文档中不额外暴露）
      }
    }

    try {
      var submission = await vendor.submit({
        openid: openid,
        personUrls: personUrls,
        personAssetIds: personAssetIds,
        metrics: metrics
      })
      if (!submission || !submission.vendorJobId) {
        throw errors.fail(6002, { hint: '供应商未返回 3D 任务标识' })
      }
      await store.updateTask(task.taskId, {
        status: 'GENERATING',
        stage: 'MODELING',
        vendorJobId: String(submission.vendorJobId),
        vendorProvider: submission.provider || provider,
        vendorSubmittedAt: util.isFiniteNumber(submission.submittedAt) ? submission.submittedAt : now(),
        statusUpdatedAt: now(),
        stageUpdatedAt: now()
      })
      return {
        taskId: task.taskId,
        status: 'QUEUED',
        createdAt: createdAt,
        vendorProvider: submission.provider || provider
      }
    } catch (error) {
      // 提交失败：退还 3D 日额度（P1 一致的失败语义），任务落 FAILED。
      try { await store.refundModel3dDaily(openid) } catch (refundError) { /* 尽力而为 */ }
      await failTask(task, error && error.isAppError ? error.code : 6001, { cause: error })
      throw error
    }
  }

  async function get(payload, ctx) {
    var openid = assertOpenid(ctx.openid)
    payload = payload || {}
    util.assertTaskId(payload.taskId)
    var task = await store.getTask(payload.taskId)
    if (!task || task.openid !== openid || task.taskType !== util.MODEL_TASK_TYPE) {
      throw errors.fail(5004, { hint: '3D 任务不存在或无权访问' })
    }
    if (util.TERMINAL.indexOf(task.status) >= 0) {
      return buildTaskView(task, { withModelUrl: true })
    }
    var startedAt = util.isFiniteNumber(task.startedAt) ? task.startedAt : task.createdAt
    if (util.isFiniteNumber(startedAt) && now() - startedAt >= timeoutMs) {
      var timedOut = await failTask(task, 5002, {
        hint: '3D 生成超过 ' + Math.round(timeoutMs / 1000) + ' 秒未完成，已超时'
      })
      return buildTaskView(timedOut, { withModelUrl: true })
    }
    var advanced = await advanceTask(task, openid)
    return buildTaskView(advanced, { withModelUrl: true })
  }

  async function list(payload, ctx) {
    var openid = assertOpenid(ctx.openid)
    payload = payload || {}
    var limit = payload.limit === undefined ? 20 : util.toNumber(payload.limit)
    if (!util.isFiniteNumber(limit) || limit < 1 || limit > 20 || Math.floor(limit) !== limit) {
      throw errors.fail(1001, { hint: 'limit 需为 1–20 的整数' })
    }
    var cursor = null
    if (payload.cursor !== undefined && payload.cursor !== null && payload.cursor !== '') {
      cursor = util.decodeCursor(payload.cursor)
      if (!cursor) throw errors.fail(1001, { hint: 'cursor 不合法' })
    }
    var result = await store.listModels(openid, { limit: limit, cursor: cursor })
    return {
      items: (result.items || []).map(function (model) {
        return {
          modelId: model.modelId,
          thumbnailFileID: model.thumbnailFileID || null,
          createdAt: model.createdAt,
          status: 'READY',
          modelBytes: util.isFiniteNumber(model.bytes) ? model.bytes : null,
          modelVersion: model.vendorProvider || null,
          faceCount: util.isFiniteNumber(model.triangleCount) ? model.triangleCount : null
        }
      }),
      nextCursor: result.nextCursor || null
    }
  }

  async function deleteOne(payload, ctx) {
    var openid = assertOpenid(ctx.openid)
    payload = payload || {}
    util.assertModelId(payload.modelId)
    var model = await store.getModel(payload.modelId)
    if (!model || model.openid !== openid) {
      throw errors.fail(5004, { hint: '模型不存在或无权访问' })
    }
    var fileIDs = [model.modelFileID, model.thumbnailFileID].filter(function (id) { return !!id })
    if (fileIDs.length) {
      try { await storage.deleteFiles(fileIDs) } catch (error) { /* 对象删除失败不阻塞记录删除，cleanup 兜底 */ }
    }
    await store.deleteModel(model.modelId)
    // 同步物理删除关联任务（无墓碑，SPEC §4）
    var tasks = await store.listTasksByOpenid(openid)
    for (var i = 0; i < tasks.length; i += 1) {
      if (tasks[i].taskId === model.taskId || tasks[i].modelId === model.modelId) {
        await store.deleteTask(tasks[i].taskId)
      }
    }
    return { deletedAt: now() }
  }

  async function deleteAll(payload, ctx) {
    var openid = assertOpenid(ctx.openid)
    var deletedModels = 0
    var deletedTasks = 0
    var modelIds = []
    var cursor = null
    for (var page = 0; page < 5; page += 1) {
      var result = await store.listModels(openid, { limit: 20, cursor: cursor })
      ;(result.items || []).forEach(function (model) { modelIds.push(model.modelId) })
      cursor = result.nextCursor
      if (!cursor) break
    }
    for (var i = 0; i < modelIds.length; i += 1) {
      var model = await store.getModel(modelIds[i])
      if (!model || model.openid !== openid) continue
      var fileIDs = [model.modelFileID, model.thumbnailFileID].filter(function (id) { return !!id })
      if (fileIDs.length) {
        try { await storage.deleteFiles(fileIDs) } catch (error) { /* cleanup 兜底 */ }
      }
      await store.deleteModel(model.modelId)
      deletedModels += 1
    }
    var tasks = await store.listTasksByOpenid(openid)
    for (var j = 0; j < tasks.length; j += 1) {
      if (tasks[j].taskType === util.MODEL_TASK_TYPE) {
        await store.deleteTask(tasks[j].taskId)
        deletedTasks += 1
      }
    }
    await store.updateUser(openid, { activeModel3dTaskId: null })
    return { deletedModels: deletedModels, deletedTasks: deletedTasks, deletedAt: now() }
  }

  async function handle(event, auth) {
    var requestId = nextRequestId()
    var t0 = now()
    try {
      auth = auth || {}
      event = event || {}
      var action = event.action
      if (ACTIONS.indexOf(action) < 0) {
        throw errors.fail(1001, { hint: '未知的 action: ' + String(action) })
      }
      var payload = event.payload || {}
      var data
      if (action === 'model3dSubmit') data = await submit(payload, auth)
      else if (action === 'model3dGet') data = await get(payload, auth)
      else if (action === 'model3dList') data = await list(payload, auth)
      else if (action === 'model3dDelete') data = await deleteOne(payload, auth)
      else data = await deleteAll(payload, auth)
      return envelopeOk(data, requestId, now())
    } catch (error) {
      return envelopeFail(error, requestId, now())
    }
  }

  return {
    handle: handle,
    __options: function () {
      return { timeoutMs: timeoutMs, dailyLimit: dailyLimit, provider: provider, now: t0Safe(now) }
    }
  }

  function t0Safe(fn) {
    try { return fn() } catch (e) { return null }
  }
}

module.exports = {
  createHandler: createHandler,
  envelopeOk: envelopeOk,
  envelopeFail: envelopeFail,
  ACTIONS: ACTIONS
}
