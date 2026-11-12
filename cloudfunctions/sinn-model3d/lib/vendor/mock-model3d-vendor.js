/**
 * lib/vendor/mock-model3d-vendor.js —— MockModel3dVendorAdapter（SPEC-0002 §B.4.2 默认实现）。
 *
 * 设计同 P1 mock-vendor（task-38 教训）：**无状态、跨云函数 invocation 可重建**：
 * - submit 返回可解码的 vendorJobId：`mock3d_<base36(submittedAt)>_<seq>`；
 * - query 解码 submittedAt，用 `now() - submittedAt` 推导 PENDING/BUILDING/SUCCEEDED，
 *   不依赖实例内存，createTask 与后续 model3dGet 分属不同 invocation 也能正确推进；
 * - 结果资产为确定性生成的**最小合法 GLB**（单节点/单网格，无外部资源），
 *   fetchAsset 返回 {format:'glb', bytes, buffer}，供 3D 服务端校验与转存链路跑通。
 *
 * 场景（options 优先，其次 env）：
 * - SINN_MOCK_3D_DELAY_MS  ：生成耗时，默认 3000ms；
 * - SINN_MOCK_3D_FAIL      ：''（成功）| 'fail'（FAILED）| 'timeout'（永不完成）| 'corrupt'（返回非法模型）。
 */
'use strict'

var errors = require('../errors')

var MOCK_VENDOR_JOB_RE = /^mock3d_([0-9a-z]+)_([0-9]+)$/
var MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
var DEFAULT_DELAY_MS = 3000

/** 生成最小合法 GLB（magic/version/长度/JSON chunk 均合法，nodeCount=1、meshCount=1）。 */
function buildMockGlb() {
  var json = JSON.stringify({
    asset: { version: '2.0', generator: 'sinn-mock-3d' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'mock-model', mesh: 0 }],
    meshes: [{ name: 'mock-mesh', primitives: [{ attributes: {}, mode: 4 }] }]
  })
  var jsonBuffer = Buffer.from(json, 'utf8')
  var paddedLength = Math.ceil(jsonBuffer.length / 4) * 4
  var padded = Buffer.alloc(paddedLength, 0x20) // JSON chunk 用空格补齐
  jsonBuffer.copy(padded, 0)
  var header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedLength, 8)
  var chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(paddedLength, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([header, chunkHeader, padded])
}

function parseMockVendorJobId(vendorJobId, nowMs) {
  if (typeof vendorJobId !== 'string') return null
  var match = MOCK_VENDOR_JOB_RE.exec(vendorJobId)
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

function createMockModel3dVendorAdapter(options) {
  options = options || {}
  var now = options.now || function () { return Date.now() }
  var delayMs = options.delayMs
  if (delayMs === undefined) {
    var rawDelay = Number(options.env && options.env.SINN_MOCK_3D_DELAY_MS)
    delayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : DEFAULT_DELAY_MS
  }
  var failMode = options.fail
  if (failMode === undefined) failMode = (options.env && options.env.SINN_MOCK_3D_FAIL) || ''
  var calls = { submit: 0, query: 0, fetchAsset: 0, health: 0, cancel: 0, erase: 0 }
  var seq = 0
  var glbCache = null

  function getGlb() {
    if (!glbCache) glbCache = buildMockGlb()
    return glbCache
  }

  function submit(params) {
    calls.submit += 1
    params = params || {}
    if (!params.personUrls || !params.personUrls.length) {
      return Promise.reject(errors.fail(6001, { hint: 'mock: 缺少人像图片 URL' }))
    }
    seq += 1
    var submittedAt = Math.floor(now())
    return Promise.resolve({
      vendorJobId: 'mock3d_' + submittedAt.toString(36) + '_' + seq,
      provider: 'mock',
      submittedAt: submittedAt
    })
  }

  function query(params) {
    calls.query += 1
    var parsed = parseMockVendorJobId(params && params.vendorJobId, now())
    if (!parsed) return Promise.reject(errors.fail(6002, { hint: 'mock: 无法识别的 vendorJobId' }))
    var elapsed = now() - parsed.submittedAt
    if (failMode === 'timeout') {
      return Promise.resolve({ status: elapsed < delayMs / 2 ? 'PENDING' : 'BUILDING', stage: 'MODELING' })
    }
    if (elapsed < delayMs * 0.35) return Promise.resolve({ status: 'PENDING' })
    if (elapsed < delayMs) return Promise.resolve({ status: 'BUILDING', stage: 'MODELING' })
    if (failMode === 'fail') {
      return Promise.resolve({ status: 'FAILED', failureCode: 'vendor_generation_failed', failureMessage: 'mock generation failed' })
    }
    return Promise.resolve({
      status: 'SUCCEEDED',
      stage: 'SAVING',
      assetUrl: 'mock://model3d/' + params.vendorJobId
    })
  }

  function fetchAsset(params) {
    calls.fetchAsset += 1
    var parsed = parseMockVendorJobId(params && params.vendorJobId, now())
    if (!parsed) return Promise.reject(errors.fail(6002, { hint: 'mock: 无法识别的 vendorJobId' }))
    var buffer = failMode === 'corrupt' ? Buffer.from('not-a-glb-file', 'utf8') : getGlb()
    return Promise.resolve({ format: 'glb', bytes: buffer.length, buffer: buffer })
  }

  function health() {
    calls.health += 1
    return Promise.resolve({ ok: true, provider: 'mock', checkedAt: now() })
  }

  function cancel() {
    calls.cancel += 1
    return Promise.resolve({ unsupported: true })
  }

  function erase() {
    calls.erase += 1
    return Promise.resolve({ unsupported: true })
  }

  return {
    provider: 'mock',
    submit: submit,
    query: query,
    fetchAsset: fetchAsset,
    health: health,
    cancel: cancel,
    erase: erase,
    __calls: function () { return Object.assign({}, calls) }
  }
}

module.exports = {
  createMockModel3dVendorAdapter: createMockModel3dVendorAdapter,
  buildMockGlb: buildMockGlb,
  parseMockVendorJobId: parseMockVendorJobId,
  MOCK_VENDOR_JOB_RE: MOCK_VENDOR_JOB_RE
}
