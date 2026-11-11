/**
 * lib/errors.js —— 云函数统一错误码与错误对象（SPEC-0001 §B.1 + 错误码表）。
 *
 * 约定：
 * - 业务代码只抛 AppError；未知异常在 handler 最外层兜底为 E_INTERNAL。
 * - 云函数始终返回 HTTP 200，语义由 error.httpStatus / error.code 表达（AC-20 断言口径）。
 */
'use strict'

var ERROR_CODES = {
  1001: { name: 'E_PARAM', message: '填写信息有误，请检查后重试', httpStatus: 400 },
  1003: { name: 'E_CONSENT_REQUIRED', message: '请先阅读并同意隐私说明', httpStatus: 403 },
  1004: { name: 'E_FORBIDDEN', message: '无权访问该数据', httpStatus: 404 },
  2001: { name: 'E_QUOTA_EXHAUSTED', message: '今日额度已用完，明日 00:00 重置', httpStatus: 429 },
  2002: { name: 'E_ACTIVE_TASK_EXISTS', message: '已有进行中的生成任务', httpStatus: 409 },
  3000: { name: 'E_PRECHECK_NOT_PASSED', message: '照片预检未通过，请按提示重新拍摄或选择', httpStatus: 422 },
  3001: { name: 'E_PRECHECK_NOT_SINGLE_PERSON', message: '照片需为单人，请重新拍摄', httpStatus: 200 },
  3002: { name: 'E_PRECHECK_NOT_FULL_BODY', message: '照片未拍到全身（含脚部），请重新拍摄', httpStatus: 200 },
  3003: { name: 'E_PRECHECK_FACE_OCCLUDED', message: '面部被遮挡，请露出完整面部后重拍', httpStatus: 200 },
  3004: { name: 'E_PRECHECK_BODY_OCCLUDED', message: '身体被遮挡，请重新拍摄', httpStatus: 200 },
  3005: { name: 'E_PRECHECK_NOT_UPRIGHT', message: '请上传直立正面照片', httpStatus: 200 },
  3006: { name: 'E_PRECHECK_BAD_LIGHTING', message: '光线不足或逆光，请在光线均匀处重拍', httpStatus: 200 },
  3007: { name: 'E_PRECHECK_NO_GARMENT', message: '未识别到服装，请让衣服完整入镜', httpStatus: 200 },
  3008: { name: 'E_PRECHECK_MULTIPLE_GARMENTS', message: '仅支持单件服装，请只放一件', httpStatus: 200 },
  3009: { name: 'E_PRECHECK_ON_MODEL', message: '请上传自己的衣服照片，不要拍模特上身', httpStatus: 200 },
  3010: { name: 'E_PRECHECK_TAG_VISIBLE', message: '请取下衣物吊牌后重拍', httpStatus: 200 },
  3011: { name: 'E_PRECHECK_MALL_IMAGE', message: '请勿上传电商商品图，请拍自己的衣服', httpStatus: 200 },
  3012: { name: 'E_PRECHECK_INVALID_IMAGE', message: '图片无法识别，请更换照片', httpStatus: 200 },
  3013: { name: 'E_PRECHECK_UNKNOWN', message: '照片校验暂时无法完成，请换一张或稍后重试', httpStatus: 200 },
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
  5010: { name: 'E_TASK_GONE', message: '该记录已不可用', httpStatus: 410 },
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
