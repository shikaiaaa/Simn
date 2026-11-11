/**
 * services/precheck.js —— 采集链路的端上 L0 预检与表单校验（DEV-0001-06）。
 *
 * 职责（SPEC-0001 AC-1/2/3/4/5/24/26）：
 * - L0（纯函数、同步、<=300ms 量级）：JPG/PNG、<=10MB、长边 1024-4096、长宽比、EXIF 方向；
 *   L0 不通过时不发起任何网络请求（不上传、不调用 precheck）；
 * - capture 表单校验：人像 1-3 张、身高/体重必填、三围选填、性别选填（默认 unspecified）；
 * - garment 表单校验：单张上装；
 * - 服务端 precheck 调用封装：统一把业务三态 {pass|fail|unknown} 转成页面可用的结构，
 *   失败时给出可行动的重拍建议；未知错误按 E_NETWORK/E_INTERNAL 兜底。
 *
 * 本文件 reserve 阶段不访问 wx.*，纯函数可被 jest 直接加载。
 */
'use strict'

var api = require('./api')

var MAX_BYTES = 10 * 1024 * 1024
var MIN_LONG_SIDE = 1024
var MAX_LONG_SIDE = 4096
var MAX_ASPECT_RATIO = 3
var MIN_PHOTOS = 1
var MAX_PHOTOS = 3
var GENDERS = ['male', 'female', 'unspecified']
var DEFAULT_GENDER = 'unspecified'
var ALLOWED_MIMES = ['image/jpeg', 'image/png']
var KNOWN_ORIENTATIONS = [
  'up',
  'down',
  'left',
  'right',
  'up-mirrored',
  'down-mirrored',
  'left-mirrored',
  'right-mirrored'
]
var GARMENT_ACCEPT_HINT = '仅接受自家衣服平铺/挂拍、单件完整展示。'

var L0_MESSAGES = {
  L0_DIMENSIONS: '无法读取图片尺寸，请重新选择照片',
  L0_FORMAT: '仅支持 JPG / PNG 图片，请重新选择',
  L0_BYTES: '图片不能超过 10MB，请压缩后重试',
  L0_SIZE_MIN: '照片长边需不小于 1024 像素，请重新拍摄',
  L0_SIZE_MAX: '照片长边不能超过 4096 像素，请压缩后重试',
  L0_ASPECT: '照片长宽比异常，请使用竖版全身照',
  L0_EXIF: '照片方向信息异常，请重新拍摄'
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  var n = Number(value)
  if (!isFinite(n)) return null
  return n
}

function isOneDecimal(value) {
  var text = String(value).trim()
  return /^-?\d+(\.\d)?$/.test(text)
}

/** 从路径/类型推断 MIME；无法识别时返回 ''。 */
function inferMime(input) {
  if (!input) return ''
  var type = typeof input === 'string' ? input : input.type || input.mime || ''
  var path = typeof input === 'string' ? input : input.path || input.tempFilePath || ''
  type = String(type || '').toLowerCase()
  if (type.indexOf('jpeg') >= 0 || type.indexOf('jpg') >= 0) return 'image/jpeg'
  if (type.indexOf('png') >= 0) return 'image/png'
  var p = String(path || '').toLowerCase()
  if (/\.jpe?g($|\?)/.test(p)) return 'image/jpeg'
  if (/\.png($|\?)/.test(p)) return 'image/png'
  return ''
}

function normalizePhotoMeta(input) {
  input = input || {}
  var size = toNumberOrNull(input.size !== undefined ? input.size : input.bytes)
  return {
    path: input.path || input.tempFilePath || '',
    size: size === null ? 0 : size,
    width: toNumberOrNull(input.width) || 0,
    height: toNumberOrNull(input.height) || 0,
    mime: inferMime(input),
    orientation: input.orientation ? String(input.orientation) : 'up'
  }
}

/**
 * 端上 L0 预检（同步、不发起网络）。返回第一条失败作为 code/message，同时给出全部原因。
 */
function validateImageL0(input) {
  var meta = normalizePhotoMeta(input)
  var reasons = []

  if (!(meta.width > 0) || !(meta.height > 0)) {
    reasons.push({ code: 'L0_DIMENSIONS', message: L0_MESSAGES.L0_DIMENSIONS })
  }
  if (ALLOWED_MIMES.indexOf(meta.mime) < 0) {
    reasons.push({ code: 'L0_FORMAT', message: L0_MESSAGES.L0_FORMAT })
  }
  if (!(meta.size > 0) || meta.size > MAX_BYTES) {
    reasons.push({ code: 'L0_BYTES', message: L0_MESSAGES.L0_BYTES })
  }
  if (meta.width > 0 && meta.height > 0) {
    var longSide = Math.max(meta.width, meta.height)
    var shortSide = Math.min(meta.width, meta.height)
    if (longSide < MIN_LONG_SIDE) {
      reasons.push({ code: 'L0_SIZE_MIN', message: L0_MESSAGES.L0_SIZE_MIN })
    }
    if (longSide > MAX_LONG_SIDE) {
      reasons.push({ code: 'L0_SIZE_MAX', message: L0_MESSAGES.L0_SIZE_MAX })
    }
    if (shortSide > 0 && longSide / shortSide > MAX_ASPECT_RATIO) {
      reasons.push({ code: 'L0_ASPECT', message: L0_MESSAGES.L0_ASPECT })
    }
  }
  if (KNOWN_ORIENTATIONS.indexOf(meta.orientation) < 0) {
    reasons.push({ code: 'L0_EXIF', message: L0_MESSAGES.L0_EXIF })
  }

  if (reasons.length) {
    return {
      ok: false,
      code: reasons[0].code,
      message: reasons[0].message,
      reasons: reasons,
      meta: meta
    }
  }
  return { ok: true, code: '', message: '', reasons: [], meta: meta }
}

function photosError(errors, field, code, message) {
  errors.push({ field: field, code: code, message: message })
}

function validateHeight(value, errors) {
  if (value === null || value === undefined || value === '') {
    photosError(errors, 'heightCm', 'HEIGHT_REQUIRED', '请填写身高（100–250 cm）')
    return null
  }
  var n = toNumberOrNull(value)
  var isInt = String(value).trim().indexOf('.') < 0 && n !== null && Math.floor(n) === n
  if (!isInt || n < 100 || n > 250) {
    photosError(errors, 'heightCm', 'HEIGHT_RANGE', '身高需为 100–250 的整数（cm）')
    return null
  }
  return n
}

function validateWeight(value, errors) {
  if (value === null || value === undefined || value === '') {
    photosError(errors, 'weightKg', 'WEIGHT_REQUIRED', '请填写体重（25–250 kg，最多 1 位小数）')
    return null
  }
  var n = toNumberOrNull(value)
  if (!isOneDecimal(value) || n < 25 || n > 250) {
    photosError(errors, 'weightKg', 'WEIGHT_RANGE', '体重需为 25–250 kg，最多 1 位小数')
    return null
  }
  return n
}

function validateCircumference(value, field, label, errors) {
  if (value === null || value === undefined || value === '') return undefined
  var n = toNumberOrNull(value)
  if (!isOneDecimal(value) || n < 40 || n > 200) {
    photosError(errors, field, 'CIRCUMFERENCE_RANGE', label + '需为 40–200 cm，最多 1 位小数')
    return undefined
  }
  return n
}

function normalizeGender(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_GENDER
  var text = String(value)
  return GENDERS.indexOf(text) >= 0 ? text : ''
}

/**
 * capture 表单校验（纯函数）。
 * @param {{photos?:Array, heightCm?:*, weightKg?:*, gender?:*, chestCm?:*, waistCm?:*, hipCm?:*}} form
 * @returns {{ok:boolean, errors:Array, missingFields:Array, normalized:object}}
 */
function validateCaptureForm(form) {
  form = form || {}
  var errors = []
  var missingFields = []
  var photos = Array.isArray(form.photos) ? form.photos : []

  if (photos.length < MIN_PHOTOS) {
    photosError(errors, 'photos', 'PHOTOS_REQUIRED', '请至少添加 1 张人像照片')
    missingFields.push('photos')
  }
  if (photos.length > MAX_PHOTOS) {
    photosError(errors, 'photos', 'PHOTOS_LIMIT', '人像照片最多 3 张')
    missingFields.push('photos')
  }
  for (var i = 0; i < photos.length; i += 1) {
    if (!photos[i] || !photos[i].path) {
      photosError(errors, 'photos', 'PHOTO_INVALID', '第 ' + (i + 1) + ' 张照片无效，请重新选择')
      break
    }
  }

  var heightCm = validateHeight(form.heightCm, errors)
  var weightKg = validateWeight(form.weightKg, errors)
  if (heightCm === null) missingFields.push('heightCm')
  if (weightKg === null) missingFields.push('weightKg')

  var chestCm = validateCircumference(form.chestCm, 'chestCm', '胸围', errors)
  var waistCm = validateCircumference(form.waistCm, 'waistCm', '腰围', errors)
  var hipCm = validateCircumference(form.hipCm, 'hipCm', '臀围', errors)

  var gender = normalizeGender(form.gender)
  if (!gender) {
    photosError(errors, 'gender', 'GENDER_INVALID', '性别仅支持 male / female / unspecified')
    missingFields.push('gender')
  }

  var metrics = {
    heightCm: heightCm,
    weightKg: weightKg,
    gender: gender || DEFAULT_GENDER
  }
  if (chestCm !== undefined) metrics.chestCm = chestCm
  if (waistCm !== undefined) metrics.waistCm = waistCm
  if (hipCm !== undefined) metrics.hipCm = hipCm

  return {
    ok: errors.length === 0,
    errors: errors,
    missingFields: missingFields,
    normalized: { metrics: metrics }
  }
}

/** garment 表单校验：单张上装照片。 */
function validateGarmentForm(form) {
  form = form || {}
  var errors = []
  var photo = form.photo || null
  if (!photo || !photo.path) {
    photosError(errors, 'photo', 'GARMENT_REQUIRED', '请添加 1 张衣服照片（单件上装）')
    return { ok: false, errors: errors, normalized: { photo: null } }
  }
  return { ok: true, errors: errors, normalized: { photo: photo } }
}

/** 表单错误汇总成一句用户文案。 */
function buildFormErrorText(errors) {
  var list = Array.isArray(errors) ? errors : []
  if (!list.length) return ''
  var seen = {}
  var messages = []
  for (var i = 0; i < list.length; i += 1) {
    var message = list[i] && list[i].message
    if (!message || seen[message]) continue
    seen[message] = true
    messages.push(message)
  }
  return messages.join('；')
}

/** 预检子码对应的重拍建议（与 SPEC 错误码表一致，服务端 hint 优先）。 */
function getPrecheckAdvice(code) {
  if (api.PRECHECK_MESSAGES[code]) return api.PRECHECK_MESSAGES[code]
  if (code === 3013) return '无法确认照片是否合格，请重新拍摄或更换照片'
  var advice = api.getUserMessage(typeof code === 'number' ? code : 3000)
  return advice || '照片预检未通过，请按提示重新拍摄'
}

/**
 * 调服务端 precheck（SPEC §B.2 API-6，目标 p95<=5s、硬超时 8s）。
 * @param {string} assetId
 * @param {{timeoutMs?:number, now?:function}} [options]
 * @returns {Promise<{ok:boolean,pass:boolean,status:string,code:number,name:string,message:string,hint:string,checks:Array,elapsedMs:number,requestId:string}>}
 */
function runServerPrecheck(assetId, options) {
  options = options || {}
  var clock = typeof options.now === 'function' ? options.now : Date.now
  var started = clock()
  var timeoutMs = options.timeoutMs || 8000
  return api
    .call('sinn-task', 'precheck', { assetId: assetId }, { requireConsent: false, timeoutMs: timeoutMs })
    .then(function (res) {
      var data = (res && res.data) || {}
      var pass = data.pass === true
      var status = data.status || (pass ? 'pass' : 'fail')
      return {
        ok: true,
        pass: pass,
        status: status,
        code: typeof data.code === 'number' ? data.code : 0,
        name: data.name || '',
        message: data.message || (pass ? '' : getPrecheckAdvice(data.code)),
        hint: data.hint || (pass ? '' : GARMENT_ACCEPT_HINT),
        checks: Array.isArray(data.checks) ? data.checks : [],
        elapsedMs: clock() - started,
        requestId: (res && res.requestId) || ''
      }
    })
    .catch(function (error) {
      return {
        ok: false,
        pass: false,
        status: 'unknown',
        code: (error && error.code) || 9000,
        name: (error && error.name) || 'E_INTERNAL',
        message: api.getUserMessage(error),
        hint: (error && error.hint) || '',
        checks: [],
        elapsedMs: clock() - started,
        requestId: (error && error.requestId) || ''
      }
    })
}

/** AC-2 口径：服务端预检耗时是否在目标内（<=5000ms）。 */
function isPrecheckWithinTarget(elapsedMs, targetMs) {
  var target = typeof targetMs === 'number' ? targetMs : 5000
  return typeof elapsedMs === 'number' && elapsedMs >= 0 && elapsedMs <= target
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  MIN_LONG_SIDE: MIN_LONG_SIDE,
  MAX_LONG_SIDE: MAX_LONG_SIDE,
  MAX_ASPECT_RATIO: MAX_ASPECT_RATIO,
  MIN_PHOTOS: MIN_PHOTOS,
  MAX_PHOTOS: MAX_PHOTOS,
  GENDERS: GENDERS,
  DEFAULT_GENDER: DEFAULT_GENDER,
  GARMENT_ACCEPT_HINT: GARMENT_ACCEPT_HINT,
  L0_MESSAGES: L0_MESSAGES,
  inferMime: inferMime,
  normalizePhotoMeta: normalizePhotoMeta,
  validateImageL0: validateImageL0,
  validateCaptureForm: validateCaptureForm,
  validateGarmentForm: validateGarmentForm,
  buildFormErrorText: buildFormErrorText,
  getPrecheckAdvice: getPrecheckAdvice,
  runServerPrecheck: runServerPrecheck,
  isPrecheckWithinTarget: isPrecheckWithinTarget
}
