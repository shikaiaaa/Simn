/**
 * lib/vendor/mock-vendor.js —— MockVendorAdapter 确定性契约桩（SPEC-0001 §B.4）。
 *
 * task-38（E2E-B10）起为**无状态、跨云函数 invocation 可重建**的实现：
 * - `submit` 返回可解码的 vendorTaskId：`vt_<base36(submittedAt)>_<seq>`（seq 仅保证同毫秒内唯一）；
 * - `query` 直接解码 vendorTaskId 得到 submittedAt，用 `now() - submittedAt` 推导状态，
 *   **不依赖实例内存 map**；因此 createTask 的 invocation 与后续 taskGet 的另一个 invocation
 *   即使 adapter 实例不同，也能正确推进状态（真实云 SINN_VENDOR=mock 的异步链路依赖此性质）。
 * - 无法解析/明显伪造（未来时间、非 base36、空串等）的 id 仍 reject，保持原有 unknown 语义；
 *   跨实例无法查询「已删除」状态，故 cancel / erase 保持 no-op 类型语义（不假装有墓碑）。
 *
 * 场景由 options.scenario 决定，时间相关判定基于注入的 now()：
 * - success          ：PENDING → RUNNING → SUCCEEDED（默认）
 * - queue            ：始终 PENDING（用于验证排队阶段展示；handler 60s 判 TIMEOUT）
 * - failed           ：PENDING → RUNNING → FAILED（通用失败）
 * - content_blocked  ：FAILED + failureCode=content_blocked（映射 4001）
 * - precheck_failed  ：FAILED + failureCode=error_apply_region_not_detected（映射 3002）
 * - timeout          ：始终 PENDING/RUNNING（由 handler 60s 判 TIMEOUT）
 * - invalid_response ：query 返回无法识别的 state（验证 E_VENDOR_RESPONSE_INVALID 5005）
 * - submit_error     ：submit 抛错（验证 createTask 失败退款）
 *
 * 结果图：**合法 PNG 占位图**（与返回的 width/height 完全一致，默认 2048×3072 纯色）。
 * 该占位图仅供 mock 链路走通与结果页加载，不代表真实换装效果；AC-13/14/15 仍阻塞于真实
 * 供应商与真实素材（见 docs/dev/DEV-0001.md §DEV-0001-38）。
 *
 * validate 独立配置：options.validateResult = {status, failed, unknown}；
 * 默认三态为 unknown（与真实供应商一致：无独立预检端点）。
 */
'use strict'

var zlib = require('zlib')

var VENDOR_TASK_ID_RE = /^vt_([0-9a-z]+)_([0-9]+)$/
var MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
var PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
var DEFAULT_PLACEHOLDER_RGB = [0xf3, 0xf4, 0xf6]

var CRC_TABLE = (function () {
  var table = new Array(256)
  for (var n = 0; n < 256; n += 1) {
    var c = n
    for (var k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  var crc = 0xffffffff
  for (var i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  var typeBuffer = Buffer.from(type, 'ascii')
  var out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  typeBuffer.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return out
}

/**
 * 生成 width×height 的合法 RGB PNG 占位图（纯色，filter 0）。
 * 仅 mock 使用，避免引入外部图片资源；宽高写入 IHDR，与返回的 width/height 一致。
 */
function buildPlaceholderPng(width, height, rgb) {
  width = Math.max(1, Math.floor(width) || 1)
  height = Math.max(1, Math.floor(height) || 1)
  var color = rgb || DEFAULT_PLACEHOLDER_RGB
  var rowBytes = 1 + width * 3
  var row = Buffer.alloc(rowBytes)
  for (var x = 0; x < width; x += 1) {
    row[1 + x * 3] = color[0]
    row[2 + x * 3] = color[1]
    row[3 + x * 3] = color[2]
  }
  var raw = Buffer.alloc(rowBytes * height)
  for (var y = 0; y < height; y += 1) {
    row.copy(raw, y * rowBytes)
  }
  var ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 解析 vendorTaskId。返回 {submittedAt, seq} 或 null（畸形/伪造）。
 * 拒绝未来时间（> now + 5min 时钟漂移容忍），避免伪造 id 让任务误判为“刚提交”。
 */
function parseVendorTaskId(vendorTaskId, nowMs) {
  if (typeof vendorTaskId !== 'string') return null
  var match = VENDOR_TASK_ID_RE.exec(vendorTaskId)
  if (!match) return null
  var submittedAt = parseInt(match[1], 36)
  var seq = parseInt(match[2], 10)
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) return null
  if (!Number.isFinite(seq) || seq <= 0) return null
  var referenceNow = Number(nowMs)
  if (!Number.isFinite(referenceNow)) referenceNow = Date.now()
  if (submittedAt > referenceNow + MAX_FUTURE_SKEW_MS) return null
  return { submittedAt: submittedAt, seq: seq }
}

function createMockVendorAdapter(options) {
  options = options || {}
  var now = options.now || function () { return Date.now() }
  var scenario = options.scenario || 'success'
  var queueMs = options.queueMs === undefined ? 800 : options.queueMs
  var generateMs = options.generateMs === undefined ? 8000 : options.generateMs
  var resultWidth = options.width || 2048
  var resultHeight = options.height || 3072
  var validateResult = options.validateResult || { status: 'unknown' }
  // 仅用于 __pending() 观测与测试：不参与 query 语义（query 完全由 id 解码）。
  var knownIds = {}
  var calls = { validate: 0, submit: 0, query: 0, cancel: 0, erase: 0, health: 0 }
  var seq = 0
  var placeholderCache = null

  function getPlaceholderBuffer() {
    if (!placeholderCache) {
      placeholderCache = buildPlaceholderPng(resultWidth, resultHeight, options.placeholderRgb)
    }
    return placeholderCache
  }

  function validate(params) {
    calls.validate += 1
    return Promise.resolve({
      status: validateResult.status || 'unknown',
      checks: (validateResult.failed || []).map(function (code) {
        return { code: code, status: 'fail' }
      }),
      failed: validateResult.failed || [],
      unknown: validateResult.unknown || [],
      detail: validateResult.detail || null
    })
  }

  function submit(params) {
    calls.submit += 1
    if (scenario === 'submit_error') {
      return Promise.reject(new Error('mock vendor: submit failed'))
    }
    seq += 1
    var submittedAt = Math.floor(now())
    var vendorTaskId = 'vt_' + submittedAt.toString(36) + '_' + seq
    knownIds[vendorTaskId] = true
    return Promise.resolve({ vendorTaskId: vendorTaskId })
  }

  function markTerminal(vendorTaskId) {
    if (knownIds[vendorTaskId]) delete knownIds[vendorTaskId]
  }

  function query(params) {
    calls.query += 1
    var vendorTaskId = params && params.vendorTaskId
    var parsed = parseVendorTaskId(vendorTaskId, now())
    if (!parsed) {
      return Promise.reject(new Error('mock vendor: unknown vendorTaskId ' + vendorTaskId))
    }
    var elapsed = now() - parsed.submittedAt

    if (scenario === 'invalid_response') {
      return Promise.resolve({ state: 'SOMETHING_ELSE' })
    }
    if (scenario === 'queue') {
      return Promise.resolve({ state: 'PENDING' })
    }
    if (scenario === 'timeout') {
      return Promise.resolve({ state: elapsed < queueMs ? 'PENDING' : 'RUNNING' })
    }
    if (scenario === 'content_blocked' && elapsed >= queueMs) {
      markTerminal(vendorTaskId)
      return Promise.resolve({ state: 'FAILED', failureCode: 'content_blocked' })
    }
    if (scenario === 'precheck_failed' && elapsed >= queueMs) {
      markTerminal(vendorTaskId)
      return Promise.resolve({ state: 'FAILED', failureCode: 'error_apply_region_not_detected' })
    }
    if (scenario === 'failed' && elapsed >= queueMs + generateMs) {
      markTerminal(vendorTaskId)
      return Promise.resolve({ state: 'FAILED', failureCode: 'vendor_generation_failed' })
    }
    if (elapsed < queueMs) return Promise.resolve({ state: 'PENDING' })
    if (elapsed < queueMs + generateMs) return Promise.resolve({ state: 'RUNNING' })
    markTerminal(vendorTaskId)
    return Promise.resolve({
      state: 'SUCCEEDED',
      imageBuffer: getPlaceholderBuffer(),
      width: resultWidth,
      height: resultHeight
    })
  }

  function cancel(params) {
    calls.cancel += 1
    markTerminal(params && params.vendorTaskId)
    return Promise.resolve()
  }

  function erase(params) {
    calls.erase += 1
    // 无状态语义：无法跨实例真正删除，仅清理本实例观测记录（不假装有墓碑）。
    markTerminal(params && params.vendorTaskId)
    return Promise.resolve()
  }

  function health() {
    calls.health += 1
    return Promise.resolve({ ok: true, latencyMs: 5 })
  }

  return {
    provider: 'mock',
    validate: validate,
    submit: submit,
    query: query,
    cancel: cancel,
    erase: erase,
    health: health,
    __calls: function () { return Object.assign({}, calls) },
    __pending: function () { return Object.keys(knownIds).length }
  }
}

module.exports = {
  createMockVendorAdapter: createMockVendorAdapter,
  parseVendorTaskId: parseVendorTaskId,
  buildPlaceholderPng: buildPlaceholderPng,
  VENDOR_TASK_ID_RE: VENDOR_TASK_ID_RE
}
