/**
 * lib/precheck-debug.js —— 受保护的 precheck 诊断动作（task-36）。
 *
 * 背景：task-35 修复了 precheck 写库 undefined 问题后，真实云 `precheck` 仍返回
 * E_INTERNAL 9000；现有 envelope 会把未知异常统一包成 9000，看不到原始 message/stack。
 * 本动作逐步执行 precheck 的每一步并逐步捕获，返回 failedStep + 原始错误摘要，
 * 用于定位真实原因；不返回图片 buffer / base64 / 任何密钥。
 *
 * 安全：复用 lib/debug-gate.js 门禁（SINN_SELFTEST=1 或 event.gate token）。
 * ⚠️ 临时诊断动作：定位后移除，或至少保持 gate 保护；上线前必须移除并登记 SPEC §G。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var precheckLib = require('./precheck')
var debugGate = require('./debug-gate')

var STACK_LINES = 20
var STEP_NAMES = [
  'step1_loadConsent',
  'step2_getAsset',
  'step3_download',
  'step4_validate',
  'step5_normalize',
  'step6_updateAsset'
]

/** 错误 → 可 JSON 序列化的诊断信息（不含敏感内容）。 */
function errorInfo(error) {
  var info = {
    name: (error && error.name) || 'Error',
    message: (error && error.message) || String(error),
    code: error && error.code,
    errCode: error && error.errCode,
    stack: []
  }
  if (error && error.isAppError) {
    info.isAppError = true
    info.appCode = error.code
    info.httpStatus = error.httpStatus
    if (error.hint) info.hint = error.hint
  }
  var stack = error && error.stack ? String(error.stack) : ''
  if (stack) info.stack = stack.split('\n').slice(0, STACK_LINES)
  return info
}

function msSince(startedAt) {
  return Date.now() - startedAt
}

function failAt(result, stepName, startedAt, error) {
  result.ok = false
  result.failedStep = stepName
  result.error = errorInfo(error)
  result.steps.push({ name: stepName, ok: false, skipped: false, ms: msSince(startedAt), summary: null })
  var index = STEP_NAMES.indexOf(stepName)
  for (var i = index + 1; i < STEP_NAMES.length; i += 1) {
    result.steps.push({ name: STEP_NAMES[i], ok: false, skipped: true, ms: 0, summary: null })
  }
  return result
}

/** 图片 buffer 只回长度/类型，绝不回内容。 */
function bufferSummary(buffer) {
  var isBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)
  var length = -1
  if (isBuffer) length = buffer.length
  else if (buffer && typeof buffer.length === 'number') length = buffer.length
  else if (buffer && buffer.fileContent) length = buffer.fileContent.length
  var detectedMime = null
  if (isBuffer && buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) detectedMime = 'image/jpeg'
    else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) detectedMime = 'image/png'
  }
  return { isBuffer: isBuffer, length: length, type: typeof buffer, detectedMime: detectedMime }
}

/** 资产非敏感摘要：不返回完整 openid / fileID。 */
function assetSummary(asset, openid) {
  var fileID = (asset && asset.fileID) || ''
  var parts = String(fileID).split('/')
  return {
    assetId: asset.assetId || null,
    kind: asset.kind || null,
    ownerMatches: asset.openid === openid,
    openidTail: asset.openid ? String(asset.openid).slice(-6) : null,
    fileIDScheme: String(fileID).indexOf('cloud://') === 0 ? 'cloud://' : 'other',
    fileIDEnvSegmentPresent: parts.length > 2 && !!parts[2],
    mime: asset.mime || null,
    bytes: typeof asset.bytes === 'number' ? asset.bytes : null,
    width: asset.width || null,
    height: asset.height || null,
    purgeAt: asset.purgeAt || null,
    hasPrecheck: !!asset.precheck,
    precheckStatus: asset.precheck ? asset.precheck.status || null : null,
    precheckAt: asset.precheck ? asset.precheck.at || null : null
  }
}

/** precheck 适配器原始返回摘要（只保留契约关键字段，不做大字段透传）。 */
function rawSummary(raw) {
  raw = raw || {}
  var checks = Array.isArray(raw.checks) ? raw.checks : []
  return {
    status: raw.status === undefined ? null : raw.status,
    checksCount: checks.length,
    checkStates: checks.slice(0, 12).map(function (item) {
      return {
        code: item && item.code ? String(item.code).slice(0, 32) : '',
        status: item && item.status ? item.status : null
      }
    }),
    failed: Array.isArray(raw.failed) ? raw.failed.slice(0, 12) : null,
    unknown: Array.isArray(raw.unknown) ? raw.unknown.slice(0, 12) : null,
    detailType: raw.detail === null || raw.detail === undefined ? 'null' : typeof raw.detail,
    detailKeys: raw.detail && typeof raw.detail === 'object' ? Object.keys(raw.detail).slice(0, 12) : []
  }
}

function normalizedSummary(normalized) {
  normalized = normalized || {}
  return {
    pass: !!normalized.pass,
    status: normalized.status || null,
    code: normalized.code === undefined ? null : normalized.code,
    name: normalized.name || null,
    messageLength: normalized.message ? String(normalized.message).length : 0,
    hintLength: normalized.hint ? String(normalized.hint).length : 0,
    checksCount: Array.isArray(normalized.checks) ? normalized.checks.length : 0,
    hasDetail: normalized.detail !== undefined && normalized.detail !== null
  }
}

/** 与 handler.precheck 相同的 record 构造：可选字段仅在存在时写入。 */
function buildRecord(normalized, at) {
  var record = {
    pass: normalized.pass,
    status: normalized.status,
    checks: normalized.checks || [],
    at: at
  }
  if (normalized.code !== undefined) record.code = normalized.code
  if (normalized.name !== undefined) record.name = normalized.name
  if (normalized.message !== undefined) record.message = normalized.message
  if (normalized.hint !== undefined) record.hint = normalized.hint
  if (normalized.detail !== undefined) record.detail = normalized.detail
  return record
}

function envSummary(env) {
  env = env || {}
  return {
    PRECHECK_PROVIDER: env.PRECHECK_PROVIDER || null,
    SINN_VENDOR: env.SINN_VENDOR || null,
    NODE_ENV: env.NODE_ENV || null,
    nodeVersion: typeof process !== 'undefined' && process.version ? process.version : null
  }
}

/**
 * 逐步执行 precheck 诊断。不抛异常（门禁/参数错误由 createPrecheckDebugHandler 抛）。
 * @param {object} options {store, storage, precheck, now, openid, assetId, requestId, env, updateProbe}
 */
async function runPrecheckDebug(options) {
  options = options || {}
  var store = options.store
  var storage = options.storage
  var precheck = options.precheck
  var now = options.now || function () { return Date.now() }
  var openid = options.openid
  var assetId = options.assetId
  var env = options.env || {}

  var result = {
    action: 'precheckDebug',
    ok: true,
    requestId: options.requestId || null,
    assetId: assetId || null,
    failedStep: null,
    error: null,
    steps: [],
    env: envSummary(env)
  }
  var startedAt = Date.now()
  var buffer = null
  var raw = null
  var normalized = null
  var asset = null
  var originalPrecheck
  var stepStarted

  // step1：同意
  stepStarted = Date.now()
  try {
    var consent = await store.getConsent(openid)
    if (!consent) throw errors.fail(1003, { hint: '请先完成 18+ 确认与隐私单独同意' })
    result.steps.push({
      name: 'step1_loadConsent',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: {
        hasConsent: true,
        version: consent.version || null,
        ageConfirmed: !!consent.ageConfirmedAt
      }
    })
  } catch (consentError) {
    return failAt(result, 'step1_loadConsent', stepStarted, consentError)
  }

  // step2：读资产
  stepStarted = Date.now()
  try {
    asset = await store.getAsset(assetId)
    if (!asset) throw errors.fail(1001, { hint: '资产不存在或已过期，请重新上传' })
    originalPrecheck = asset.precheck === undefined ? null : asset.precheck
    var summary2 = assetSummary(asset, openid)
    if (!summary2.ownerMatches) throw errors.fail(1004, { httpStatus: 404, hint: '无权访问该资产' })
    result.steps.push({
      name: 'step2_getAsset',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: summary2
    })
  } catch (assetError) {
    return failAt(result, 'step2_getAsset', stepStarted, assetError)
  }

  // step3：下载（只回长度）
  stepStarted = Date.now()
  try {
    buffer = await storage.download(asset.fileID)
    result.steps.push({
      name: 'step3_download',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: bufferSummary(buffer)
    })
  } catch (downloadError) {
    return failAt(result, 'step3_download', stepStarted, downloadError)
  }

  // step4：precheck 适配器（只回契约摘要）
  stepStarted = Date.now()
  try {
    raw = await precheck.validate({ buffer: buffer, mime: asset.mime, kind: asset.kind })
    result.steps.push({
      name: 'step4_validate',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: { raw: rawSummary(raw) }
    })
  } catch (validateError) {
    return failAt(result, 'step4_validate', stepStarted, validateError)
  }

  // step5：normalizeResult
  stepStarted = Date.now()
  try {
    normalized = precheckLib.normalizeResult(raw)
    result.steps.push({
      name: 'step5_normalize',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: normalizedSummary(normalized)
    })
  } catch (normalizeError) {
    return failAt(result, 'step5_normalize', stepStarted, normalizeError)
  }

  // step6：写回 asset.precheck（与 handler 同款 record）
  var record = buildRecord(normalized, now())
  var updated = null
  var updateOk = false
  stepStarted = Date.now()
  try {
    updated = await store.updateAsset(assetId, { precheck: record })
    updateOk = true
    result.steps.push({
      name: 'step6_updateAsset',
      ok: true,
      skipped: false,
      ms: msSince(stepStarted),
      summary: {
        updated: !!updated,
        updatedAt: record.at,
        hasPrecheck: !!(updated && updated.precheck),
        writtenKeys: Object.keys(record)
      }
    })
  } catch (updateError) {
    failAt(result, 'step6_updateAsset', stepStarted, updateError)
  }

  // 6b：恢复/探针（避免诊断本身污染 10min precheck 缓存）
  stepStarted = Date.now()
  if (updateOk) {
    try {
      await store.updateAsset(assetId, { precheck: originalPrecheck })
      result.steps.push({
        name: 'step6b_restorePrecheck',
        ok: true,
        skipped: false,
        ms: msSince(stepStarted),
        summary: { restored: true, restoredPrecheck: originalPrecheck === null ? null : 'object' }
      })
    } catch (restoreError) {
      result.steps.push({
        name: 'step6b_restorePrecheck',
        ok: false,
        skipped: false,
        ms: msSince(stepStarted),
        summary: { restored: false }
      })
      result.error = result.error || errorInfo(restoreError)
    }
  } else {
    // 写库失败时，再用最小 patch 探一次写路径，区分「record 内容问题」与「写库通道问题」
    try {
      await store.updateAsset(assetId, {
        precheck: { pass: true, status: 'pass', checks: [], at: now() }
      })
      result.steps.push({
        name: 'step6b_updateProbe',
        ok: true,
        skipped: false,
        ms: msSince(stepStarted),
        summary: { probeWriteOk: true, probe: 'minimal-pass-record' }
      })
    } catch (probeError) {
      result.steps.push({
        name: 'step6b_updateProbe',
        ok: false,
        skipped: false,
        ms: msSince(stepStarted),
        summary: null
      })
      result.probeError = errorInfo(probeError)
    }
    // 探针可能写入了 pass 记录，尽力恢复原值
    try {
      await store.updateAsset(assetId, { precheck: originalPrecheck })
    } catch (restoreAfterProbeError) {
      // 尽力而为：恢复失败不覆盖主错误
    }
  }

  result.elapsedMs = msSince(startedAt)
  return result
}

/**
 * 生成受门禁保护的 precheckDebug 处理器（供 index.js 与单测使用）。
 * 门禁/参数错误抛 AppError，由调用方套统一 envelope。
 * @param {object} deps {store, storage, precheck, now, openid, env, requestId}
 */
function createPrecheckDebugHandler(deps) {
  deps = deps || {}
  return async function handlePrecheckDebug(event) {
    event = event || {}
    debugGate.assertDebugActionEnabled(event, deps.env || {}, 'precheckDebug')
    if (!deps.openid) throw errors.fail(1004, { httpStatus: 403, hint: '无法获取用户身份' })
    if (!util.isAssetId(event.assetId)) throw errors.fail(1001, { hint: 'assetId 不合法' })
    return runPrecheckDebug({
      store: deps.store,
      storage: deps.storage,
      precheck: deps.precheck,
      now: deps.now,
      openid: deps.openid,
      assetId: event.assetId,
      env: deps.env,
      requestId: deps.requestId,
      updateProbe: event.updateProbe !== false
    })
  }
}

module.exports = {
  STEP_NAMES: STEP_NAMES,
  STACK_LINES: STACK_LINES,
  errorInfo: errorInfo,
  bufferSummary: bufferSummary,
  assetSummary: assetSummary,
  rawSummary: rawSummary,
  normalizedSummary: normalizedSummary,
  buildRecord: buildRecord,
  runPrecheckDebug: runPrecheckDebug,
  createPrecheckDebugHandler: createPrecheckDebugHandler
}
