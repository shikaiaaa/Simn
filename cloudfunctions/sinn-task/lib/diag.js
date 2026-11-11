/**
 * lib/diag.js —— 临时诊断动作 `diag`（task-66，定位真实调用 5001，上线前移除）。
 *
 * 背景：真实云出现 FAILED 5001 E_VENDOR_UNAVAILABLE（vendorProvider=volcengine、
 * vendorTaskId=null、submittedAt=null），但控制台可见环境变量；需要在不回显密钥的前提下
 * 拿到「服务端进程实际看到的 env + vendor.health()」，区分：①AK/SK 未注入 ②实例旧配置
 * ③凭证/签名错误 ④transport 其他错误。
 *
 * 安全约束：
 * - 绝不返回 AK/SK 任何字符（只返回 has/长度）与 region；异常 message 也要过脱敏；
 * - 本动作只读诊断：不创建任务、不扣额度、不写库/存储、不发起真实生成调用；
 * - 门禁复用 SINN_SELFTEST=1 或 gate 令牌；未启用返回 1004，且不构造 vendor（零读写）。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')

var GATE_TOKEN = 'sinn-selftest-2026-11-10'

/** 门禁：与控制台临时开关一致（task-44 移除 selftest 时保留的判定口径）。 */
function isGateEnabled(env, event) {
  env = env || {}
  return env.SINN_SELFTEST === '1' || !!(event && event.gate === GATE_TOKEN)
}

/** 把 env 中的密钥原文从任意文本里替换掉（兜底防止异常 message 回显密钥）。 */
function redact(text, env) {
  var result = typeof text === 'string' ? text : String(text === undefined ? '' : text)
  ;['SINN_VOLC_AK', 'SINN_VOLC_SK'].forEach(function (key) {
    var value = env && env[key]
    if (typeof value === 'string' && value.length > 0) {
      result = result.split(value).join('***')
    }
  })
  return result
}

/** 凭证存在性视图：只给布尔与长度，绝不含密钥字符。 */
function credentialsView(env) {
  env = env || {}
  var ak = typeof env.SINN_VOLC_AK === 'string' ? env.SINN_VOLC_AK : ''
  var sk = typeof env.SINN_VOLC_SK === 'string' ? env.SINN_VOLC_SK : ''
  return {
    hasAk: !!ak,
    akLen: ak.length,
    hasSk: !!sk,
    skLen: sk.length,
    region: env.SINN_VOLC_REGION || null
  }
}

/** vendor.health() 观测：同步抛错/异步拒绝/缺方法都收敛为 {threw:true,...}，不向上抛。 */
function healthView(createVendorAdapter, env) {
  if (typeof createVendorAdapter !== 'function') {
    return Promise.resolve({ threw: true, name: 'TypeError', message: 'createVendorAdapter 不可用' })
  }
  var adapter
  try {
    adapter = createVendorAdapter(env)
  } catch (error) {
    return Promise.resolve({
      threw: true,
      name: (error && error.name) || 'Error',
      message: redact(error && error.message, env)
    })
  }
  if (!adapter || typeof adapter.health !== 'function') {
    return Promise.resolve({ threw: true, name: 'TypeError', message: 'VendorAdapter 缺少 health()' })
  }
  var pending
  try {
    pending = adapter.health()
  } catch (error) {
    return Promise.resolve({
      threw: true,
      name: (error && error.name) || 'Error',
      message: redact(error && error.message, env)
    })
  }
  return Promise.resolve(pending).then(
    function (result) {
      return result
    },
    function (error) {
      return {
        threw: true,
        name: (error && error.name) || 'Error',
        message: redact(error && error.message, env)
      }
    }
  )
}

/**
 * 创建诊断器；`options.createVendorAdapter` 仅供单测注入（默认使用 lib/vendor 工厂）。
 * @returns {{collect: function(): Promise<object>}}
 */
function createDiag(env, options) {
  env = env || {}
  options = options || {}
  var vendorFactory = require('./vendor')
  var createVendorAdapter = options.createVendorAdapter || vendorFactory.createVendorAdapter

  return {
    collect: function () {
      return healthView(createVendorAdapter, env).then(function (vendorHealth) {
        return {
          vendorProvider: env.SINN_VENDOR || 'mock',
          nodeVersion: process.version,
          credentials: credentialsView(env),
          vendorHealth: vendorHealth,
          hint: '本动作仅诊断：不创建任务、不扣额度、不写库/存储、不发起真实生成'
        }
      })
    }
  }
}

function envelopeFail(error, requestId, serverTime) {
  var appError = errors.normalizeError(error)
  return {
    ok: false,
    data: null,
    error: {
      code: appError.code,
      name: appError.name,
      message: appError.message,
      hint: appError.hint,
      httpStatus: appError.httpStatus
    },
    requestId: requestId,
    serverTime: serverTime
  }
}

/**
 * diag 动作入口（index.js 在业务 handler 之前调用）。
 * @param {object} event 云函数事件
 * @param {object} env   process.env
 * @param {object} [options] { requestId, now, createVendorAdapter }
 */
async function handleDiag(event, env, options) {
  options = options || {}
  var requestId = options.requestId || util.newRequestId()
  var now = options.now || function () { return Date.now() }
  var serverTime = now()
  if (!isGateEnabled(env, event)) {
    return envelopeFail(
      errors.fail(1004, { hint: '诊断动作未启用：需 SINN_SELFTEST=1 或 gate 令牌；本动作无任何读写' }),
      requestId,
      serverTime
    )
  }
  try {
    var data = await createDiag(env, { createVendorAdapter: options.createVendorAdapter }).collect()
    return { ok: true, data: data, error: null, requestId: requestId, serverTime: serverTime }
  } catch (error) {
    return envelopeFail(error, requestId, serverTime)
  }
}

module.exports = {
  GATE_TOKEN: GATE_TOKEN,
  isGateEnabled: isGateEnabled,
  credentialsView: credentialsView,
  createDiag: createDiag,
  handleDiag: handleDiag
}
