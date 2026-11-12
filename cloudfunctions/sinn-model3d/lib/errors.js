/**
 * lib/errors.js —— sinn-model3d 统一错误码与错误对象（SPEC-0002 §B.1 / 错误码表）。
 *
 * 约定（沿用 SPEC-0001 §B.1）：
 * - 业务代码只抛 AppError；未知异常在 handler 最外层兜底为 E_INTERNAL。
 * - 云函数始终返回 HTTP 200，语义由 error.httpStatus / error.code 表达。
 * - 与 P1 错误码兼容（1001/1003/1004/2002/3000/3014/3015/4001/5002/5004/5007/9000），
 *   3D 专项新增 6001..6006（SPEC-0002 错误码表）。
 */
'use strict'

var ERROR_CODES = {
  1001: { name: 'E_PARAM', message: '填写信息有误，请检查后重试', httpStatus: 400 },
  1003: { name: 'E_CONSENT_REQUIRED', message: '请先阅读并同意隐私说明', httpStatus: 403 },
  1004: { name: 'E_FORBIDDEN', message: '无权访问该数据', httpStatus: 404 },
  1005: { name: 'E_CLIENT_TOO_OLD', message: '当前微信版本过低，请升级后再使用', httpStatus: 0 },
  2002: { name: 'E_ACTIVE_TASK_EXISTS', message: '已有进行中的 3D 生成任务', httpStatus: 409 },
  3000: { name: 'E_PRECHECK_NOT_PASSED', message: '照片预检未通过，请按提示重新拍摄或选择', httpStatus: 422 },
  3014: { name: 'E_PRECHECK_TOO_SMALL', message: '分辨率过低，请重拍', httpStatus: 422 },
  3015: { name: 'E_PRECHECK_VENDOR_LIMIT', message: '照片超出生成服务规格，请更换照片或重拍', httpStatus: 422 },
  4001: { name: 'E_CONTENT_BLOCKED', message: '照片未通过内容安全审核，请更换照片', httpStatus: 422 },
  5002: { name: 'E_TIMEOUT', message: '生成超时，请重试', httpStatus: 504 },
  5004: { name: 'E_TASK_NOT_FOUND', message: '该记录不存在或已被删除', httpStatus: 404 },
  5007: { name: 'E_PHOTO_PROCESS_FAILED', message: '照片处理失败，请重试或更换照片', httpStatus: 422 },
  6001: { name: 'E_MODEL3D_UNAVAILABLE', message: '3D 生成服务暂时不可用，请稍后重试', httpStatus: 503 },
  6002: { name: 'E_MODEL3D_PARSE_FAILED', message: '3D 模型解析失败，请重试', httpStatus: 502 },
  6003: { name: 'E_MODEL3D_TOO_LARGE', message: '3D 模型超出体积限制，请重试', httpStatus: 413 },
  6004: { name: 'E_RENDER_UNSUPPORTED', message: '当前设备不支持 3D 查看，请升级微信或使用 2D 试穿', httpStatus: 0 },
  6005: { name: 'E_MODEL3D_GENERATING', message: '模型生成中，暂不可执行该操作', httpStatus: 409 },
  6006: { name: 'E_MODEL3D_DAILY_LIMIT', message: '今日 3D 生成次数已用完', httpStatus: 429 },
  9000: { name: 'E_INTERNAL', message: '服务暂时不可用，请稍后重试', httpStatus: 500 }
}

/** AppError —— 可安全返回给客户端的业务错误。 */
function AppError(code, options) {
  var meta = ERROR_CODES[code] || ERROR_CODES[9000]
  options = options || {}
  this.code = ERROR_CODES[code] ? code : 9000
  this.name = options.name || meta.name
  this.message = options.message || meta.message
  this.hint = options.hint || ''
  this.httpStatus = options.httpStatus === undefined ? meta.httpStatus : options.httpStatus
  this.detail = options.detail || null
  this.cause = options.cause || null
  this.isAppError = true
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, AppError)
  } else {
    this.stack = new Error(this.message).stack
  }
}
AppError.prototype = Object.create(Error.prototype)
AppError.prototype.constructor = AppError

function fail(code, options) {
  return new AppError(code, options)
}

/** 把任意异常规范化为 AppError（未知异常 → E_INTERNAL，不向客户端泄露堆栈）。 */
function normalizeError(error) {
  if (error && error.isAppError) return error
  return new AppError(9000, {
    message: '服务暂时不可用，请稍后重试',
    hint: '',
    cause: error || null
  })
}

function getMeta(code) {
  return ERROR_CODES[code] || ERROR_CODES[9000]
}

module.exports = {
  ERROR_CODES: ERROR_CODES,
  AppError: AppError,
  fail: fail,
  normalizeError: normalizeError,
  getMeta: getMeta
}
