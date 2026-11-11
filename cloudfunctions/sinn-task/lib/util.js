/**
 * lib/util.js —— 云函数通用工具：ID、时间（Asia/Shanghai）、参数校验。
 *
 * 注意：本文件不依赖 wx-server-sdk，可被本地单测直接 require。
 */
'use strict'

var crypto = require('crypto')
var errors = require('./errors')

var HOUR_MS = 60 * 60 * 1000
var DAY_MS = 24 * HOUR_MS
var PURGE_TTL_MS = 23 * HOUR_MS // SPEC §4：purgeAt = 创建时间 + 23h（预留 1h 余量）
var TASK_TIMEOUT_MS = 96 * 1000 // SPEC v0.9 §2：96s 未成功判 TIMEOUT（AC-7）
var PRECHECK_CACHE_MS = 10 * 60 * 1000 // API-6：同 assetId 10min 缓存
var MAX_PHOTO_BYTES = 10 * 1024 * 1024
var MAX_LONG_SIDE = 4096
// SPEC v0.11 §B.2：供应商输入规格（JPG、<=5MB、长边 <=4096）。
var VENDOR_MAX_BYTES = 5 * 1024 * 1024
var VENDOR_MAX_LONG_SIDE = 4096
var VENDOR_MIME = 'image/jpeg'

var GENDERS = ['male', 'female', 'unspecified']

/** 24 位小写 hex（ID 后缀），crypto 不可用时退化为 Math.random。 */
function randomHex(length) {
  var size = length || 24
  var out = ''
  try {
    out = crypto.randomBytes(Math.ceil(size / 2)).toString('hex')
  } catch (e) {
    out = ''
    while (out.length < size) out += Math.floor(Math.random() * 16).toString(16)
  }
  return out.slice(0, size)
}

function newTaskId() {
  return 't_' + randomHex(24)
}

function newAssetId() {
  return 'a_' + randomHex(24)
}

function newRequestId() {
  try {
    return crypto.randomUUID()
  } catch (e) {
    var hex = randomHex(32)
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
  }
}

function isUuidV4(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isTaskId(value) {
  return typeof value === 'string' && /^t_[0-9a-f]{24}$/.test(value)
}

function isAssetId(value) {
  return typeof value === 'string' && /^a_[0-9a-f]{24}$/.test(value)
}

function isCloudFileId(value) {
  return typeof value === 'string' && /^cloud:\/\//.test(value) && value.length > 8
}

/** Asia/Shanghai 当日 dayKey（YYYY-MM-DD）。 */
function beijingDayKey(now) {
  return new Date(now + 8 * HOUR_MS).toISOString().slice(0, 10)
}

/** Asia/Shanghai 次日 00:00 的 epoch ms（数量重置时间）。 */
function beijingResetAt(now) {
  var shifted = now + 8 * HOUR_MS
  var nextDayStart = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS
  return nextDayStart - 8 * HOUR_MS
}

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

/** 把参数化为 1 位小数的 number；非法返回 NaN。 */
function toNumber(value) {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value)
  return NaN
}

function assert(condition, code, options) {
  if (!condition) throw errors.fail(code, options)
  return true
}

/**
 * 校验并规范化资产注册参数（API-5）。
 * @returns {{kind:string,fileID:string,mime:string,bytes:number,width:number,height:number}}
 */
function validateAssetPayload(payload) {
  payload = payload || {}
  var kind = payload.kind
  assert(kind === 'PERSON' || kind === 'GARMENT', 1001, { hint: 'kind 必须为 PERSON 或 GARMENT' })

  assert(isCloudFileId(payload.fileID), 1001, { hint: 'fileID 必须为云存储 fileID（cloud:// 开头）' })

  var mime = payload.mime
  assert(mime === 'image/jpeg' || mime === 'image/png', 1001, { hint: '仅支持 JPG/PNG 图片' })

  var bytes = toNumber(payload.bytes)
  assert(isFiniteNumber(bytes) && bytes > 0 && bytes <= MAX_PHOTO_BYTES, 1001, {
    hint: '图片大小需在 0–10MB 之间'
  })

  var width = toNumber(payload.width)
  var height = toNumber(payload.height)
  assert(isFiniteNumber(width) && width > 0 && isFiniteNumber(height) && height > 0, 1001, {
    hint: '图片宽高必须为正数'
  })
  assert(Math.max(width, height) <= MAX_LONG_SIDE, 1001, { hint: '图片长边不得超过 4096px' })

  return {
    kind: kind,
    fileID: payload.fileID,
    mime: mime,
    bytes: Math.round(bytes),
    width: Math.round(width),
    height: Math.round(height)
  }
}

/**
 * 校验并规范化 createTask 的 metrics（API-7 / SPEC §B.6）。
 * 返回传输单位（cm/kg 小数），落库转换由 handler 做。
 */
function validateMetrics(metrics) {
  metrics = metrics || {}
  var heightCm = toNumber(metrics.heightCm)
  assert(isFiniteNumber(heightCm) && heightCm >= 100 && heightCm <= 250 && Math.round(heightCm) === heightCm, 1001, {
    hint: '身高需为 100–250 的整数（cm）'
  })

  var weightKg = toNumber(metrics.weightKg)
  assert(isFiniteNumber(weightKg) && weightKg >= 25 && weightKg <= 250, 1001, {
    hint: '体重需在 25.0–250.0kg 之间'
  })
  assert(Math.abs(weightKg * 10 - Math.round(weightKg * 10)) < 1e-9, 1001, { hint: '体重最多 1 位小数' })

  var gender = metrics.gender
  if (gender === undefined || gender === null || gender === '') gender = 'unspecified'
  assert(GENDERS.indexOf(gender) >= 0, 1001, { hint: 'gender 仅支持 male/female/unspecified' })

  var result = {
    heightCm: heightCm,
    weightKg: round1(weightKg),
    gender: gender
  }

  var circumferenceKeys = [
    ['chestCm', '胸围'],
    ['waistCm', '腰围'],
    ['hipCm', '臀围']
  ]
  circumferenceKeys.forEach(function (item) {
    var key = item[0]
    var label = item[1]
    if (metrics[key] === undefined || metrics[key] === null || metrics[key] === '') return
    var value = toNumber(metrics[key])
    assert(isFiniteNumber(value) && value >= 40 && value <= 200, 1001, { hint: label + '需在 40.0–200.0cm 之间' })
    assert(Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, 1001, { hint: label + '最多 1 位小数' })
    result[key] = round1(value)
  })

  return result
}

/** 落库单位转换：cm→mm 整数、kg→g 整数（SPEC §B.6）。 */
function toStoredMetrics(metrics) {
  var stored = {
    heightCm: metrics.heightCm,
    weightKg: Math.round(metrics.weightKg * 1000),
    gender: metrics.gender
  }
  if (metrics.chestCm !== undefined) stored.chestCm = Math.round(metrics.chestCm * 10)
  if (metrics.waistCm !== undefined) stored.waistCm = Math.round(metrics.waistCm * 10)
  if (metrics.hipCm !== undefined) stored.hipCm = Math.round(metrics.hipCm * 10)
  return stored
}

/** 落库单位还原为传输单位（供测试/后续接口使用）。 */
function fromStoredMetrics(stored) {
  var out = {
    heightCm: stored.heightCm,
    weightKg: Math.round(stored.weightKg / 100) / 10,
    gender: stored.gender || 'unspecified'
  }
  if (stored.chestCm !== undefined) out.chestCm = stored.chestCm / 10
  if (stored.waistCm !== undefined) out.waistCm = stored.waistCm / 10
  if (stored.hipCm !== undefined) out.hipCm = stored.hipCm / 10
  return out
}

function assertClientReqId(value) {
  return assert(isUuidV4(value), 1001, { hint: 'clientReqId 必须为 UUID v4' })
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return []
  return value
}

function unique(values) {
  var seen = {}
  var out = []
  values.forEach(function (value) {
    var key = String(value)
    if (seen[key]) return
    seen[key] = true
    out.push(value)
  })
  return out
}

module.exports = {
  HOUR_MS: HOUR_MS,
  DAY_MS: DAY_MS,
  PURGE_TTL_MS: PURGE_TTL_MS,
  TASK_TIMEOUT_MS: TASK_TIMEOUT_MS,
  PRECHECK_CACHE_MS: PRECHECK_CACHE_MS,
  MAX_PHOTO_BYTES: MAX_PHOTO_BYTES,
  MAX_LONG_SIDE: MAX_LONG_SIDE,
  VENDOR_MAX_BYTES: VENDOR_MAX_BYTES,
  VENDOR_MAX_LONG_SIDE: VENDOR_MAX_LONG_SIDE,
  VENDOR_MIME: VENDOR_MIME,
  GENDERS: GENDERS,
  randomHex: randomHex,
  newTaskId: newTaskId,
  newAssetId: newAssetId,
  newRequestId: newRequestId,
  isUuidV4: isUuidV4,
  isTaskId: isTaskId,
  isAssetId: isAssetId,
  isCloudFileId: isCloudFileId,
  beijingDayKey: beijingDayKey,
  beijingResetAt: beijingResetAt,
  isFiniteNumber: isFiniteNumber,
  round1: round1,
  toNumber: toNumber,
  assert: assert,
  validateAssetPayload: validateAssetPayload,
  validateMetrics: validateMetrics,
  toStoredMetrics: toStoredMetrics,
  fromStoredMetrics: fromStoredMetrics,
  assertClientReqId: assertClientReqId,
  normalizeArray: normalizeArray,
  unique: unique
}
