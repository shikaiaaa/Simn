/**
 * lib/vendor/volcengine-vendor.js —— 火山引擎「图片换装 V2」VendorAdapter（SPEC-0001 v0.5 §B.4，P1 指定供应商）。
 *
 * 设计边界（重要）：
 * - 本文件实现的是 **VendorAdapter 六方法语义**：入参/出参、三态 validate、状态映射、
 *   供应商失败码 → 内部错误码映射、结果图拉取、密钥安全与超时兜底。
 * - **真实 HTTP 请求、签名（v4 风格）、Endpoint 字段、任务状态字段名/结果 URL 有效期等
 *   均标为「待凭证实测」（CP-04b/04d）**，官方文档正文不可抓取，本文件不凭猜测编造真实报文。
 *   因此 HTTP 传输层通过 `options.transport` 注入：
 *     transport.submit({ personCount, hasGarment, metrics }) -> { taskId } | { errorCode, httpStatus }
 *     transport.query({ vendorTaskId }) -> { status, resultUrl?, width?, height?, errorCode?, httpStatus? }
 *     transport.fetchResult({ url }) -> Buffer | { buffer }
 *     transport.ping?() -> { ok, latencyMs }
 *   凭证实测后只需补全 transport（真实签名/字段映射），本适配器与业务层无需改动。
 * - 未注入 transport 时**不发起任何网络请求**，明确返回 E_VENDOR_UNAVAILABLE，不假装可用。
 * - 凭证只从 env（生产= process.env）的 SINN_VOLC_AK / SINN_VOLC_SK / SINN_VOLC_REGION 读取；
 *   不落库、不下发端上、不写日志，错误信息与异常栈中不出现明文。
 */
'use strict'

var errors = require('../errors')

var PROVIDER = 'volcengine'
var DEFAULT_TIMEOUT_MS = 8000
var PING_TIMEOUT_MS = 3000
var REGION_FALLBACK = 'cn-north-1'

/** 火山传输层状态（归一化后）→ VendorAdapter 状态。待凭证实测补充真实枚举值。 */
var STATE_MAP = {
  queued: 'PENDING',
  queueing: 'PENDING',
  pending: 'PENDING',
  waiting: 'PENDING',
  submitted: 'PENDING',
  accepted: 'PENDING',
  processing: 'RUNNING',
  running: 'RUNNING',
  generating: 'RUNNING',
  inprogress: 'RUNNING',
  'in-progress': 'RUNNING',
  success: 'SUCCEEDED',
  succeeded: 'SUCCEEDED',
  done: 'SUCCEEDED',
  completed: 'SUCCEEDED',
  finished: 'SUCCEEDED',
  failed: 'FAILED',
  failure: 'FAILED',
  error: 'FAILED',
  rejected: 'FAILED',
  cancelled: 'FAILED',
  canceled: 'FAILED'
}

/**
 * 火山错误码/关键词 → 内部错误码（SPEC §B.4 映射表）。
 * 真实错误码待 CP-04d 凭证实测后替换/补充；当前按类别关键词匹配，未识别一律 5001 并保留 vendorCode。
 */
var CODE_RULES = [
  { re: /content|safety|risk|policy|illegal|sensitive|moderation/i, code: 4001, hint: '内容安全校验未通过，请更换照片或服装图' },
  { re: /auth|signature|sign|credential|access.?denied|unauthor|forbidden|token|apikey|aksk/i, code: 5001, hint: '供应商鉴权失败/凭证无效' },
  { re: /balance|arrear|insufficient|payment|billing|not.?open|unopened|unsubscribe|service.?closed/i, code: 5001, hint: '供应商服务未开通或余额不足' },
  { re: /rate|throttl|too.?many|frequency|concurrency|limit/i, code: 5001, hint: '供应商限流，请稍后重试' },
  { re: /timeout|deadline|etimedout|temporar|busy/i, code: 5002, hint: '供应商响应超时，请稍后重试' },
  { re: /multiple.*(garment|cloth)|more.?than.?one.*(garment|cloth)/i, code: 3008, hint: '仅支持单件服装' },
  { re: /person.*(not|no).?(detected|found)|no.?person|person.?missing/i, code: 3001, hint: '照片需为单人照片' },
  { re: /multi|multiple|more.?than.?one|person.?count|two.?person/i, code: 3001, hint: '照片需为单人照片' },
  { re: /full.?body|whole.?body|feet|ankle|body.?region|region.?not.?detect/i, code: 3002, hint: '照片需为全身照（含脚）' },
  { re: /face.*(occlu|block|cover|missing|hidden)|occlu.*face/i, code: 3003, hint: '面部被遮挡，请露出完整面部' },
  { re: /body.*(occlu|block|cover)|occlu.*body/i, code: 3004, hint: '身体被遮挡，请更换照片' },
  { re: /upright|posture|stand|frontal|front.?facing/i, code: 3005, hint: '请站立正面拍摄' },
  { re: /light|dark|backlight|exposure|shadow/i, code: 3006, hint: '光线不足或逆光，请更换照片' },
  { re: /garment.*(not|no|missing|undetected)|clothes.*(not|no|missing)/i, code: 3007, hint: '未识别到服装' },
  { re: /model|mannequin|worn|on.?body.*already|on.?model/i, code: 3009, hint: '请上传衣服平铺/挂拍图，而非模特上身图' },
  { re: /tag|label|hangtag|price.?tag/i, code: 3010, hint: '请移除衣服吊牌' },
  { re: /e.?commerce|mall|product.?image|white.?background|catalog/i, code: 3011, hint: '请上传自家拍摄的衣服图，而非电商图' },
  { re: /invalid.*image|image.*invalid|decode|corrupt|format/i, code: 3012, hint: '图片无效，请更换 JPG/PNG 图片' },
  { re: /internal|server|unavailable|system.?error|5\d\d/i, code: 5001, hint: '供应商服务暂时不可用' }
]

function envValue(env, key) {
  var value = env && env[key]
  return value === undefined || value === null ? '' : String(value).trim()
}

function classifyVendorCode(vendorCode, httpStatus) {
  var code = vendorCode === undefined || vendorCode === null ? '' : String(vendorCode)
  for (var i = 0; i < CODE_RULES.length; i += 1) {
    if (code && CODE_RULES[i].re.test(code)) {
      return { code: CODE_RULES[i].code, hint: CODE_RULES[i].hint }
    }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { code: 5001, hint: '供应商鉴权失败/凭证无效' }
  }
  if (httpStatus === 408 || httpStatus === 504) {
    return { code: 5002, hint: '供应商响应超时，请稍后重试' }
  }
  if (httpStatus === 429) {
    return { code: 5001, hint: '供应商限流，请稍后重试' }
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { code: 5001, hint: '供应商服务暂时不可用' }
  }
  return { code: 5001, hint: '供应商返回未识别的错误' }
}

/** 供应商标记 FAILED 时给 handler 的 failureCode（handler 目前识别 content_blocked / region 两类）。 */
function mapFailedStateCode(vendorCode, httpStatus) {
  var classified = classifyVendorCode(vendorCode, httpStatus)
  if (classified.code === 4001) return 'content_blocked'
  if (classified.code === 3002) return 'error_apply_region_not_detected'
  return 'vendor_generation_failed'
}

function safeLog(logger, record) {
  // 只记录可安全暴露的字段（provider/operation/vendorCode/httpStatus），绝不记录密钥、报文体或原始错误 message。
  try {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[sinn/vendor] ' + JSON.stringify(record))
    }
  } catch (ignored) {
    // 日志失败不影响主流程
  }
}

function withTimeout(promise, timeoutMs, hint) {
  return new Promise(function (resolve, reject) {
    var settled = false
    var timer = setTimeout(function () {
      if (settled) return
      settled = true
      reject(errors.fail(5002, { hint: hint }))
    }, timeoutMs)
    Promise.resolve(promise).then(
      function (value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      function (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function pickTaskId(response) {
  response = response || {}
  var candidates = [response.taskId, response.vendorTaskId, response.task_id, response.data && response.data.taskId]
  for (var i = 0; i < candidates.length; i += 1) {
    if (candidates[i] !== undefined && candidates[i] !== null && String(candidates[i]).length > 0) {
      return String(candidates[i])
    }
  }
  return ''
}

function normalizeState(raw) {
  if (raw === undefined || raw === null) return ''
  var key = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '')
  if (STATE_MAP[key]) return STATE_MAP[key]
  var compact = key.replace(/-/g, '')
  return STATE_MAP[compact] || ''
}

/**
 * @param {object} [env] 环境变量；省略时读 process.env（生产由 index.js 传入 process.env）
 * @param {object} [options] 测试注入：{transport, now, timeoutMs, logger}
 */
function createVolcengineVendorAdapter(env, options) {
  var source = env || process.env || {}
  options = options || {}
  var ak = envValue(source, 'SINN_VOLC_AK')
  var sk = envValue(source, 'SINN_VOLC_SK')
  var region = envValue(source, 'SINN_VOLC_REGION') || REGION_FALLBACK
  var configured = !!(ak && sk)
  var timeoutMs = Number(envValue(source, 'SINN_VOLC_TIMEOUT_MS')) || Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS
  var transport = options.transport || null
  var logger = options.logger || console
  var calls = { validate: 0, submit: 0, query: 0, fetchResult: 0, cancel: 0, erase: 0, health: 0 }

  function notConfigured(method) {
    return errors.fail(5001, {
      hint: '火山引擎未配置 SINN_VOLC_AK/SINN_VOLC_SK（CP-04b）：' + method + ' 不可用'
    })
  }

  function transportOf(method, payload) {
    if (!transport || typeof transport[method] !== 'function') {
      return Promise.reject(
        errors.fail(5001, {
          hint: '火山引擎 HTTP 传输层未实现（签名/Endpoint 待 CP-04b/04d 凭证实测），不发起真实网络请求'
        })
      )
    }
    return withTimeout(
      Promise.resolve().then(function () {
        return transport[method](payload)
      }),
      timeoutMs,
      '火山引擎请求超时（' + method + '）'
    ).catch(function (error) {
      throw mapTransportError(error, method)
    })
  }

  function mapTransportError(error, operation) {
    if (error && error.isAppError) return error
    var vendorCode = error && (error.vendorCode || error.errorCode || error.code)
    var httpStatus = error && (error.httpStatus || error.statusCode)
    var classified = classifyVendorCode(vendorCode, httpStatus)
    safeLog(logger, {
      provider: PROVIDER,
      operation: operation,
      vendorCode: vendorCode === undefined || vendorCode === null ? null : String(vendorCode),
      httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
      mappedCode: classified.code
    })
    return errors.fail(classified.code, {
      hint: classified.hint,
      detail: { vendorCode: vendorCode === undefined || vendorCode === null ? null : String(vendorCode) }
    })
  }

  function validate() {
    calls.validate += 1
    // 火山无独立预检端点（SPEC §B.4，待凭证实测确认）：三态固定 unknown，由服务端 PrecheckAdapter 兜底。
    return Promise.resolve({
      status: 'unknown',
      checks: [],
      failed: [],
      unknown: ['vendor_validate_unavailable'],
      detail: { reason: 'volcengine_no_validate_endpoint', configured: configured }
    })
  }

  function submit(params) {
    calls.submit += 1
    if (!configured) return Promise.reject(notConfigured('submit'))
    params = params || {}
    // 只传语义化最小信息，不上传缓冲内容到日志/异常。
    var payload = {
      personCount: Array.isArray(params.personBuffers) ? params.personBuffers.length : 0,
      hasGarment: !!params.garmentBuffer,
      metrics: params.metrics || null
    }
    return transportOf('submit', payload).then(function (response) {
      if (response && response.errorCode) {
        throw mapTransportError({ vendorCode: response.errorCode, httpStatus: response.httpStatus }, 'submit')
      }
      if (typeof response === 'string' && response.length > 0) {
        return { vendorTaskId: response }
      }
      var taskId = pickTaskId(response)
      if (!taskId) {
        throw errors.fail(5005, { hint: '火山引擎提交响应缺少任务 ID（字段待凭证实测）' })
      }
      return { vendorTaskId: taskId }
    })
  }

  function query(params) {
    calls.query += 1
    if (!configured) return Promise.reject(notConfigured('query'))
    var vendorTaskId = params && params.vendorTaskId ? String(params.vendorTaskId) : ''
    if (!vendorTaskId) {
      return Promise.reject(errors.fail(5005, { hint: 'query 缺少 vendorTaskId' }))
    }
    return transportOf('query', { vendorTaskId: vendorTaskId }).then(function (response) {
      response = response || {}
      var state = normalizeState(response.status || response.state || response.taskStatus)
      if (!state) {
        if (response.errorCode) {
          throw mapTransportError({ vendorCode: response.errorCode, httpStatus: response.httpStatus }, 'query')
        }
        throw errors.fail(5005, {
          hint: '火山引擎返回未知任务状态（字段待凭证实测）',
          detail: { vendorCode: response.status === undefined ? null : String(response.status) }
        })
      }
      if (state === 'FAILED') {
        // 供应商已给出终态失败：返回 failureCode 由 handler 决定对外错误码；
        // 完整 E_PRECHECK_* 区分待 CP-04d 真实错误码实测后补齐（当前 handler 识别 content/region 两类）。
        return {
          state: 'FAILED',
          failureCode: mapFailedStateCode(response.errorCode || response.failureCode, response.httpStatus)
        }
      }
      if (state !== 'SUCCEEDED') {
        return { state: state }
      }
      return fetchResult(response).then(function (image) {
        return {
          state: 'SUCCEEDED',
          imageBuffer: image,
          width: numberOrUndefined(response.width || response.resultWidth),
          height: numberOrUndefined(response.height || response.resultHeight)
        }
      })
    })
  }

  function fetchResult(response) {
    var inline = response.imageBuffer || (response.result && response.result.buffer)
    if (Buffer.isBuffer(inline)) return Promise.resolve(inline)
    var url = response.resultUrl || (response.result && (response.result.url || response.result.resultUrl)) || response.url
    if (!url) {
      return Promise.reject(errors.fail(5005, { hint: '火山引擎成功响应缺少结果图 URL' }))
    }
    calls.fetchResult += 1
    return transportOf('fetchResult', { url: String(url) }).then(function (result) {
      var buffer = Buffer.isBuffer(result) ? result : result && result.buffer
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw errors.fail(5005, { hint: '火山引擎结果图下载失败' })
      }
      return buffer
    })
  }

  function numberOrUndefined(value) {
    var num = Number(value)
    return Number.isFinite(num) && num > 0 ? num : undefined
  }

  function cancel() {
    calls.cancel += 1
    // 供应商是否支持取消待实测：不支持则不假装成功，由服务端 60s 超时/额度退款兜底（SPEC §B.4）。
    return Promise.resolve('unsupported')
  }

  function erase() {
    calls.erase += 1
    // 供应商侧删除能力待实测：返回 unsupported，仅由调用方删除我方云存储副本；留存策略见同意页披露。
    return Promise.resolve('unsupported')
  }

  function health() {
    calls.health += 1
    if (!configured) {
      return Promise.resolve({ ok: false, latencyMs: 0, provider: PROVIDER, configured: false, reason: 'missing_credentials' })
    }
    if (!transport || typeof transport.ping !== 'function') {
      return Promise.resolve({
        ok: false,
        latencyMs: 0,
        provider: PROVIDER,
        configured: true,
        region: region,
        reason: 'health_pending_cp04b'
      })
    }
    var startedAt = Date.now()
    return withTimeout(transport.ping(), PING_TIMEOUT_MS, '火山引擎健康检查超时')
      .then(function (result) {
        return {
          ok: !!(result && result.ok),
          latencyMs: Date.now() - startedAt,
          provider: PROVIDER,
          configured: true,
          region: region
        }
      })
      .catch(function (error) {
        var mapped = mapTransportError(error, 'health')
        safeLog(logger, { provider: PROVIDER, operation: 'health', vendorCode: mapped.detail ? mapped.detail.vendorCode : null, mappedCode: mapped.code })
        return { ok: false, latencyMs: Date.now() - startedAt, provider: PROVIDER, configured: true, region: region, reason: 'ping_failed' }
      })
  }

  return {
    provider: PROVIDER,
    configured: configured,
    region: region,
    validate: validate,
    submit: submit,
    query: query,
    cancel: cancel,
    erase: erase,
    health: health,
    __calls: function () {
      return Object.assign({}, calls)
    }
  }
}

module.exports = {
  PROVIDER: PROVIDER,
  STATE_MAP: STATE_MAP,
  classifyVendorCode: classifyVendorCode,
  mapFailedStateCode: mapFailedStateCode,
  normalizeState: normalizeState,
  createVolcengineVendorAdapter: createVolcengineVendorAdapter
}
