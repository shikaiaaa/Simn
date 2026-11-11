/**
 * services/api.js —— 小程序端统一云函数调用层（SPEC-0001 §B.1 / §B.2）。
 *
 * 约定（DEV-0001-02）：
 * - 业务页面 **不得** 裸调 wx.cloud.callFunction，一律经本模块；
 * - 成功解析统一包裹 { ok, data, error, requestId, serverTime }，返回 { data, requestId, serverTime }；
 * - 失败统一抛 ApiError（带 code/name/httpStatus/requestId），由页面用 getUserMessage() 取用户文案；
 * - 写接口默认做「同意前置校验」：未同意（本地 sinn_consent_v1 缺失）时不发起云函数调用；
 * - 写接口按需自动生成幂等键 clientReqId（UUID v4），重试复用同一键由调用方传入；
 * - 客户端超时默认 8000ms（SPEC 云函数硬超时口径），超时映射 E_TIMEOUT；
 * - requestId 同时挂到最后一次调用记录（getLastRequestId），便于端上对账。
 *
 * 说明：本文件在 require 阶段不访问 wx.*，纯函数可被 jest 直接加载。
 */
'use strict'

var DEFAULT_TIMEOUT_MS = 8000
var NETWORK_TIMEOUT_NAME = 'E_TIMEOUT'

var STORAGE_KEYS = {
  CONSENT: 'sinn_consent_v1',
  ACTIVE_TASK: 'sinn_active_task_v1',
  QUOTA: 'sinn_quota_cache_v1',
  UI_PREFS: 'sinn_ui_prefs_v1'
}

/** SPEC §B 错误码表（code → 元信息）。 */
var ERROR_CODES = {
  1001: { name: 'E_PARAM', message: '填写信息有误，请检查后重试', httpStatus: 400 },
  1003: { name: 'E_CONSENT_REQUIRED', message: '请先阅读并同意隐私说明', httpStatus: 403 },
  1004: { name: 'E_FORBIDDEN', message: '无权访问该数据', httpStatus: 403 },
  2001: { name: 'E_QUOTA_EXHAUSTED', message: '今日额度已用完，明日 00:00 重置', httpStatus: 429 },
  2002: { name: 'E_ACTIVE_TASK_EXISTS', message: '已有进行中的生成任务', httpStatus: 409 },
  3000: { name: 'E_PRECHECK_NOT_PASSED', message: '照片预检未通过，请按提示重新拍摄或选择', httpStatus: 422 },
  3014: { name: 'E_PRECHECK_TOO_SMALL', message: '分辨率过低，请重拍', httpStatus: 200 },
  3015: { name: 'E_PRECHECK_VENDOR_LIMIT', message: '照片超出生成服务规格，请更换照片或重拍', httpStatus: 200 },
  4001: { name: 'E_CONTENT_BLOCKED', message: '照片未通过内容安全审核，请更换照片', httpStatus: 200 },
  5001: { name: 'E_VENDOR_UNAVAILABLE', message: '生成服务暂时不可用，请稍后重试', httpStatus: 502 },
  5002: { name: 'E_TIMEOUT', message: '生成超时，本次未扣除额度，请重试', httpStatus: 504 },
  5003: { name: 'E_NETWORK', message: '网络不稳定，请检查网络后重试', httpStatus: 0 },
  5004: { name: 'E_TASK_NOT_FOUND', message: '该记录不存在或已被删除', httpStatus: 404 },
  5005: { name: 'E_VENDOR_RESPONSE_INVALID', message: '生成服务返回异常，请重试', httpStatus: 502 },
  5006: { name: 'E_UPLOAD_FAILED', message: '照片上传失败，请重试', httpStatus: 0 },
  5007: { name: 'E_PHOTO_PROCESS_FAILED', message: '照片处理失败，请重试或更换照片', httpStatus: 0 },
  9000: { name: 'E_INTERNAL', message: '服务暂时不可用，请稍后重试', httpStatus: 500 }
}

/** 预检子码 3001–3012（SPEC §B 错误码表）：给出可行动的重拍建议。 */
var PRECHECK_MESSAGES = {
  3001: '照片需为单人，请重新拍摄',
  3002: '照片未拍到全身（含脚部），请重新拍摄',
  3003: '面部被遮挡，请露出完整面部后重拍',
  3004: '身体被遮挡，请重新拍摄',
  3005: '请上传直立正面照片',
  3006: '光线不足或逆光，请在光线均匀处重拍',
  3007: '未识别到服装，请让衣服完整入镜',
  3008: '仅支持单件服装，请只放一件',
  3009: '请上传自己的衣服照片，不要拍模特上身',
  3010: '请取下衣物吊牌后重拍',
  3011: '请勿上传电商商品图，请拍自己的衣服',
  3012: '图片无法识别，请更换照片',
  3013: '照片校验暂时无法完成，请换一张或稍后重试',
  3014: '分辨率过低，请重拍',
  3015: '照片超出生成服务规格，请更换照片或重拍'
}

/**
 * 需要「同意前置」的写接口（对照 SPEC §B.2：所有写接口要求有效同意记录）。
 * profile / recordConsent 例外。
 */
var CONSENT_REQUIRED_ACTIONS = {
  assetRegister: true,
  precheck: true,
  createTask: true,
  cancelTask: true,
  deleteTask: true,
  deleteAll: true,
  revokeConsent: true,
  upload: true
}

/** 需要幂等键的写接口（SPEC §B.2：assetRegister / createTask / deleteAll / revokeConsent）。 */
var IDEMPOTENT_ACTIONS = {
  assetRegister: true,
  createTask: true,
  deleteAll: true,
  revokeConsent: true
}

var lastRequestId = ''

/** 统一错误对象：字段与 SPEC §B.1 error 包裹一致，另加 requestId / cause。 */
function ApiError(meta) {
  meta = meta || {}
  this.name = meta.name || (ERROR_CODES[meta.code] ? ERROR_CODES[meta.code].name : 'E_INTERNAL')
  this.code = typeof meta.code === 'number' ? meta.code : 9000
  this.httpStatus = typeof meta.httpStatus === 'number' ? meta.httpStatus : 500
  this.message = meta.message || getUserMessage({ code: this.code, name: this.name })
  this.hint = meta.hint || ''
  this.requestId = meta.requestId || ''
  this.serverTime = typeof meta.serverTime === 'number' ? meta.serverTime : 0
  this.cause = meta.cause || null
  this.isApiError = true
}
ApiError.prototype = Object.create(Error.prototype)
ApiError.prototype.constructor = ApiError

function codeMeta(code, name) {
  if (ERROR_CODES[code]) return ERROR_CODES[code]
  for (var key in ERROR_CODES) {
    if (ERROR_CODES[key].name === name) return ERROR_CODES[key]
  }
  return null
}

/**
 * 错误码/错误名 → 用户可读文案。
 * 预检子码 3001–3012 使用具体的重拍建议；未知错误给兜底文案。
 */
function getUserMessage(errorOrCode) {
  if (errorOrCode === null || errorOrCode === undefined) return ERROR_CODES[9000].message
  var code = typeof errorOrCode === 'number' ? errorOrCode : errorOrCode.code
  var name = typeof errorOrCode === 'object' ? errorOrCode.name : ''
  if (PRECHECK_MESSAGES[code]) return PRECHECK_MESSAGES[code]
  var meta = codeMeta(code, name)
  if (meta) return meta.message
  return ERROR_CODES[9000].message
}

/** 生成本地 UUID v4（小端随机；小程序无 crypto.getRandomValues 时同样可用）。 */
function createClientReqId() {
  var template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  return template.replace(/[xy]/g, function (ch) {
    var r = (Math.random() * 16) | 0
    var v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function isClientReqId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** 读取本地同意记录（sinn_consent_v1），兼容对象与 JSON 字符串两种写入形态。 */
function readConsent() {
  try {
    var raw = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(STORAGE_KEYS.CONSENT) : ''
    if (!raw) return null
    var value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || !value.version) return null
    if (!value.agreedAt) return null
    return value
  } catch (e) {
    return null
  }
}

/** 是否已有有效同意（同意页 DEV-0001-05 写入，本层只读）。 */
function isConsented() {
  return readConsent() !== null
}

/** 读取本地「进行中任务」缓存（sinn_active_task_v1），非法值按无缓存处理。 */
function getCachedActiveTask() {
  try {
    var raw = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(STORAGE_KEYS.ACTIVE_TASK) : ''
    if (!raw) return null
    var value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || !value.taskId) return null
    return value
  } catch (e) {
    return null
  }
}

function setLastRequestId(requestId) {
  lastRequestId = requestId || ''
  return lastRequestId
}

function getLastRequestId() {
  return lastRequestId
}

function toApiError(error, fallbackRequestId) {
  if (error && error.isApiError) {
    if (!error.requestId) error.requestId = fallbackRequestId || ''
    return error
  }
  var name = error && (error.name || error.errMsg) ? String(error.name || error.errMsg) : ''
  if (name.indexOf('E_') === 0) {
    return new ApiError({ name: name, message: getUserMessage({ name: name }), requestId: fallbackRequestId })
  }
  // wx.cloud.callFunction 失败（网络/环境未就绪/客户端异常）统一归为 E_NETWORK。
  return new ApiError({
    code: 5003,
    name: 'E_NETWORK',
    message: ERROR_CODES[5003].message,
    httpStatus: 0,
    requestId: fallbackRequestId,
    cause: error || null
  })
}

/**
 * 解析云函数统一响应包裹。
 * @param {object} res wx.cloud.callFunction 的 resolve 值（{ result, errMsg, requestID }）
 * @returns {{data:*, requestId:string, serverTime:number}}
 */
function parseEnvelope(res) {
  var payload = res && res.result
  if (!payload || typeof payload !== 'object') {
    throw new ApiError({ code: 9000, name: 'E_INTERNAL', message: '服务返回异常，请稍后重试' })
  }
  setLastRequestId(payload.requestId || (res && res.requestID) || '')
  if (payload.ok === false) {
    var info = payload.error || {}
    throw new ApiError({
      code: typeof info.code === 'number' ? info.code : 9000,
      name: info.name || '',
      message: info.message || '',
      hint: info.hint || '',
      httpStatus: typeof info.httpStatus === 'number' ? info.httpStatus : 500,
      requestId: payload.requestId || '',
      serverTime: payload.serverTime
    })
  }
  if (payload.ok !== true) {
    throw new ApiError({ code: 9000, name: 'E_INTERNAL', message: '服务返回异常，请稍后重试', requestId: payload.requestId || '' })
  }
  return {
    data: payload.data === undefined ? null : payload.data,
    requestId: payload.requestId || '',
    serverTime: typeof payload.serverTime === 'number' ? payload.serverTime : 0
  }
}

function callWithTimeout(invoke, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var settled = false
    var timer = setTimeout(function () {
      if (settled) return
      settled = true
      reject(new ApiError({ code: 5002, name: NETWORK_TIMEOUT_NAME, message: '请求超时，请重试', httpStatus: 504 }))
    }, timeoutMs)
    invoke.then(
      function (res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      },
      function (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(toApiError(error))
      }
    )
  })
}

/**
 * 统一调用入口。
 * @param {string} name 云函数名：sinn-account / sinn-task
 * @param {string} action 动作名，见 SPEC §B.2
 * @param {object} payload 业务参数（不含 action）
 * @param {object} [options]
 *   - timeoutMs: 客户端超时，默认 8000
 *   - requireConsent: 覆盖默认的同意前置校验
 *   - idempotent: 强制生成 clientReqId（写接口默认生成）
 * @returns {Promise<{data:*, requestId:string, serverTime:number}>}
 */
function call(name, action, payload, options) {
  var opts = options || {}
  var data = {}
  var key
  for (key in payload || {}) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) data[key] = payload[key]
  }
  data.action = action

  if (!name || !action) {
    return Promise.reject(new ApiError({ code: 1001, name: 'E_PARAM', message: '调用参数缺失', httpStatus: 400 }))
  }

  var needConsent = opts.requireConsent === undefined ? !!CONSENT_REQUIRED_ACTIONS[action] : !!opts.requireConsent
  if (needConsent && !isConsented()) {
    return Promise.reject(
      new ApiError({
        code: 1003,
        name: 'E_CONSENT_REQUIRED',
        message: ERROR_CODES[1003].message,
        httpStatus: 403,
        hint: '请先完成 18+ 声明与隐私单独同意'
      })
    )
  }

  var needIdempotent = opts.idempotent === undefined ? !!IDEMPOTENT_ACTIONS[action] : !!opts.idempotent
  if (needIdempotent && !data.clientReqId) data.clientReqId = createClientReqId()

  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    return Promise.reject(toApiError({ errMsg: 'wx.cloud 不可用' }))
  }

  var timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  var invoke = wx.cloud.callFunction({ name: name, data: data })
  return callWithTimeout(invoke, timeoutMs).then(parseEnvelope)
}

/**
 * 首页恢复入口的纯函数决策（便于单测，不依赖页面实例）：
 * - 服务端 profile.activeTaskId 优先，其次本地 sinn_active_task_v1；
 * - 同意状态取本地缓存或显式传入的布尔值。
 * @param {{profileData?:object, localActiveTask?:object, consent?:boolean}} input
 * @returns {{hasActiveTask:boolean, activeTaskId:string, consented:boolean}}
 */
function resolveHomeState(input) {
  input = input || {}
  var profile = input.profileData || null
  var localTask = input.localActiveTask || null
  var activeTaskId = ''
  if (profile && profile.activeTaskId) activeTaskId = String(profile.activeTaskId)
  else if (localTask && localTask.taskId) activeTaskId = String(localTask.taskId)
  var consented = input.consent === undefined ? isConsented() : !!input.consent
  return {
    hasActiveTask: !!activeTaskId,
    activeTaskId: activeTaskId,
    consented: consented
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  STORAGE_KEYS: STORAGE_KEYS,
  ERROR_CODES: ERROR_CODES,
  PRECHECK_MESSAGES: PRECHECK_MESSAGES,
  ApiError: ApiError,
  getUserMessage: getUserMessage,
  createClientReqId: createClientReqId,
  isClientReqId: isClientReqId,
  readConsent: readConsent,
  isConsented: isConsented,
  getCachedActiveTask: getCachedActiveTask,
  getLastRequestId: getLastRequestId,
  parseEnvelope: parseEnvelope,
  call: call,
  resolveHomeState: resolveHomeState
}
