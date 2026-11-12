/**
 * lib/util.js —— sinn-model3d 通用工具：ID、时间、参数校验与 3D 口径常量。
 *
 * 注意：本文件不依赖 wx-server-sdk，可被本地单测直接 require（SPEC-0002 §B.3/§B.6）。
 */
'use strict'

var crypto = require('crypto')
var errors = require('./errors')

var HOUR_MS = 60 * 60 * 1000
var DAY_MS = 24 * HOUR_MS
// SPEC-0002 §4：失败/超时任务的中间产物 purgeAt = 创建 + 23h（预留 1h 余量）。
var PURGE_TTL_MS = 23 * HOUR_MS
// SPEC-0002 D-5：服务端 3D 任务超时默认 300s。
var MODEL3D_TIMEOUT_MS = 300 * 1000
// SPEC-0002 D-3：单模型（glb + 纹理）≤45MB；纹理总 ≤15MB；缩略图 ≤100KB。
var MAX_MODEL_BYTES = 45 * 1024 * 1024
var MAX_TEXTURE_BYTES = 15 * 1024 * 1024
var MAX_THUMB_BYTES = 100 * 1024
var MAX_PERSON_ASSETS = 3
// 供应商输入规格（复用 SPEC-0001 v0.11 + SPEC-0002 §1 第 3 步）。
var VENDOR_MAX_BYTES = 5 * 1024 * 1024
var VENDOR_MAX_LONG_SIDE = 4096
var VENDOR_MIME = 'image/jpeg'
var MODEL_TASK_TYPE = '3D_MODEL'
var IN_PROGRESS = ['QUEUED', 'GENERATING', 'SAVING']
var TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED']
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

function newModelId() {
  return 'm_' + randomHex(24)
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

function isModelId(value) {
  return typeof value === 'string' && /^m_[0-9a-f]{24}$/.test(value)
}

function isCloudFileId(value) {
  return typeof value === 'string' && /^cloud:\/\//.test(value) && value.length > 8
}

/** openidHash = sha256(openid) 前 16 位十六进制（云存储路径不含 openid 明文）。 */
function openidHash(openid) {
  return crypto.createHash('sha256').update(String(openid || '')).digest('hex').slice(0, 16)
}

/** Asia/Shanghai 当日 dayKey（YYYY-MM-DD）。 */
function beijingDayKey(now) {
  return new Date(now + 8 * HOUR_MS).toISOString().slice(0, 10)
}

/** Asia/Shanghai 次日 00:00 的 epoch ms（日上限重置时间）。 */
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

function toNumber(value) {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value)
  return NaN
}

function assert(condition, code, options) {
  if (!condition) throw errors.fail(code, options)
  return true
}

function assertClientReqId(value) {
  return assert(isUuidV4(value), 1001, { hint: 'clientReqId 必须为 UUID v4' })
}

function assertTaskId(value) {
  return assert(isTaskId(value), 1001, { hint: 'taskId 格式不正确' })
}

function assertModelId(value) {
  return assert(isModelId(value), 1001, { hint: 'modelId 格式不正确' })
}

/**
 * 校验并规范化 3D 提交的 metrics（沿用 P1 §B.6：身高 100–250 整数、体重 25–250 一位小数、
 * 三围 40–200 一位小数、gender 枚举）。
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

  var result = { heightCm: heightCm, weightKg: round1(weightKg), gender: gender }
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

/** 落库单位转换：kg→g 整数、围度 cm→mm 整数（沿用 P1）。 */
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

/** 服务端 3D 超时：SINN_MODEL3D_TIMEOUT_MS 可覆写，非法/缺失回退 300000。 */
function resolveTimeoutMs(env) {
  var raw = env && env.SINN_MODEL3D_TIMEOUT_MS
  var value = Number(raw)
  if (isFinite(value) && value > 0) return Math.floor(value)
  return MODEL3D_TIMEOUT_MS
}

/** 3D 日上限：SINN_MODEL3D_DAILY_LIMIT 默认 0 = 不限；非法/负数回退 0。 */
function resolveDailyLimit(env) {
  var raw = env && env.SINN_MODEL3D_DAILY_LIMIT
  var value = Number(raw)
  if (isFinite(value) && value > 0) return Math.floor(value)
  return 0
}

/** 列表游标：`createdAt|modelId` → base64url；非法返回 null。 */
function encodeCursor(task) {
  var payload = JSON.stringify([task.createdAt, task.modelId])
  return Buffer.from(payload, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null
  var text
  try {
    var normalized = cursor.replace(/-/g, '+').replace(/_/g, '/')
    while (normalized.length % 4 !== 0) normalized += '='
    text = Buffer.from(normalized, 'base64').toString('utf8')
  } catch (e) {
    return null
  }
  try {
    var parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    if (!isFiniteNumber(parsed[0]) || !isModelId(parsed[1])) return null
    return { createdAt: parsed[0], modelId: parsed[1] }
  } catch (e) {
    return null
  }
}

module.exports = {
  HOUR_MS: HOUR_MS,
  DAY_MS: DAY_MS,
  PURGE_TTL_MS: PURGE_TTL_MS,
  MODEL3D_TIMEOUT_MS: MODEL3D_TIMEOUT_MS,
  MAX_MODEL_BYTES: MAX_MODEL_BYTES,
  MAX_TEXTURE_BYTES: MAX_TEXTURE_BYTES,
  MAX_THUMB_BYTES: MAX_THUMB_BYTES,
  MAX_PERSON_ASSETS: MAX_PERSON_ASSETS,
  VENDOR_MAX_BYTES: VENDOR_MAX_BYTES,
  VENDOR_MAX_LONG_SIDE: VENDOR_MAX_LONG_SIDE,
  VENDOR_MIME: VENDOR_MIME,
  MODEL_TASK_TYPE: MODEL_TASK_TYPE,
  IN_PROGRESS: IN_PROGRESS,
  TERMINAL: TERMINAL,
  GENDERS: GENDERS,
  randomHex: randomHex,
  newTaskId: newTaskId,
  newModelId: newModelId,
  newRequestId: newRequestId,
  isUuidV4: isUuidV4,
  isTaskId: isTaskId,
  isModelId: isModelId,
  isCloudFileId: isCloudFileId,
  openidHash: openidHash,
  beijingDayKey: beijingDayKey,
  beijingResetAt: beijingResetAt,
  isFiniteNumber: isFiniteNumber,
  round1: round1,
  toNumber: toNumber,
  assert: assert,
  assertClientReqId: assertClientReqId,
  assertTaskId: assertTaskId,
  assertModelId: assertModelId,
  validateMetrics: validateMetrics,
  toStoredMetrics: toStoredMetrics,
  resolveTimeoutMs: resolveTimeoutMs,
  resolveDailyLimit: resolveDailyLimit,
  encodeCursor: encodeCursor,
  decodeCursor: decodeCursor
}
