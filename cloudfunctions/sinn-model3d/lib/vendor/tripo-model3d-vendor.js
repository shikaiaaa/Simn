/**
 * lib/vendor/tripo-model3d-vendor.js —— 阿里云百炼 Tripo 3D 适配器骨架（SPEC-0002 §B.4.3 候选 A）。
 *
 * 契约（§B.4.1）：submit / query / fetchAsset / health（cancel/erase → unsupported）。
 * 真实接口事实来自 SPIKE-0002 实测：submit → output.task_id；query → task_status +
 * results[0].pbr_model_url（GLB，URL 2h 有效）；结果 URL 过期时重新 query 换取新 URL。
 *
 * 本任务（DEV-0002-03）红线：**不发真实 Tripo 调用**。因此：
 * - 凭证只从 env 读（SINN_TRIPO_API_KEY，兼容 SINN_3D_AK），缺凭证 → 6001 且不降级 mock；
 * - HTTP 传输可注入（requestFn/fetchFn），单测全程离线；
 * - 任何异常/网络错误映射为 6001（供应商不可用），响应不可解析/缺字段映射 6002；
 * - 绝不打印/落盘 API Key；错误 hint 不包含凭证。
 */
'use strict'

var errors = require('../errors')
var util = require('../util')

var DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/3d-generation'
var DEFAULT_TASKS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/tasks'
var DEFAULT_MODEL = 'Tripo/Tripo-H3.1'
var DEFAULT_TIMEOUT_MS = 8000
var STATUS_MAP = {
  PENDING: 'PENDING',
  QUEUED: 'PENDING',
  SUBMITTED: 'PENDING',
  RUNNING: 'BUILDING',
  BUILDING: 'BUILDING',
  TEXTURING: 'TEXTURING',
  FINALIZING: 'TEXTURING',
  SUCCEEDED: 'SUCCEEDED',
  SUCCESS: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELLED',
  CANCELLED: 'CANCELLED'
}

function parseJson(text) {
  if (typeof text === 'object' && text !== null) return text
  try {
    return JSON.parse(String(text))
  } catch (e) {
    throw errors.fail(6002, { hint: '供应商响应不是合法 JSON' })
  }
}

/** 默认 HTTPS 请求（云函数 Node 运行时；不引入第三方依赖）。 */
function defaultRequestFn(params) {
  var https = require('https')
  var url = require('url')
  return new Promise(function (resolve, reject) {
    var parsed = url.parse(params.url)
    var body = params.body ? Buffer.from(params.body, 'utf8') : null
    var headers = Object.assign({}, params.headers || {})
    if (body) headers['Content-Length'] = body.length
    var timeoutMs = params.timeoutMs || DEFAULT_TIMEOUT_MS
    var req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.path,
        method: params.method || 'GET',
        headers: headers,
        timeout: timeoutMs
      },
      function (res) {
        var chunks = []
        res.on('data', function (chunk) { chunks.push(chunk) })
        res.on('end', function () {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      }
    )
    req.on('timeout', function () {
      req.destroy(errors.fail(6001, { hint: '供应商请求超时' }))
    })
    req.on('error', function (err) {
      reject(err && err.isAppError ? err : errors.fail(6001, { hint: '供应商网络请求失败' }))
    })
    if (body) req.write(body)
    req.end()
  })
}

/** 默认 HTTPS 下载（结果资产）。 */
function defaultFetchFn(params) {
  var https = require('https')
  var url = require('url')
  return new Promise(function (resolve, reject) {
    var parsed = url.parse(params.url)
    var req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.path,
        method: 'GET',
        timeout: params.timeoutMs || 30000
      },
      function (res) {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          var next = new URL(res.headers.location, params.url).toString()
          resolve(defaultFetchFn({ url: next, timeoutMs: params.timeoutMs }))
          return
        }
        var chunks = []
        res.on('data', function (chunk) { chunks.push(chunk) })
        res.on('end', function () {
          resolve({ statusCode: res.statusCode, buffer: Buffer.concat(chunks) })
        })
      }
    )
    req.on('timeout', function () {
      req.destroy(errors.fail(6001, { hint: '模型下载超时' }))
    })
    req.on('error', function () {
      reject(errors.fail(6001, { hint: '模型下载失败' }))
    })
    req.end()
  })
}

function createTripoModel3dVendorAdapter(env, options) {
  env = env || {}
  options = options || {}
  var apiKey = env.SINN_TRIPO_API_KEY || env.SINN_3D_AK || ''
  var configured = !!apiKey
  var endpoint = options.endpoint || env.SINN_TRIPO_ENDPOINT || DEFAULT_ENDPOINT
  var tasksEndpoint = options.tasksEndpoint || env.SINN_TRIPO_TASKS_ENDPOINT || DEFAULT_TASKS_ENDPOINT
  var model = options.model || env.SINN_TRIPO_MODEL || DEFAULT_MODEL
  var requestFn = options.requestFn || defaultRequestFn
  var fetchFn = options.fetchFn || defaultFetchFn
  var now = options.now || function () { return Date.now() }
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  var calls = { submit: 0, query: 0, fetchAsset: 0, health: 0 }

  function notConfigured() {
    return errors.fail(6001, { hint: '未配置 3D 供应商凭证（SINN_TRIPO_API_KEY）' })
  }

  function authHeaders(extra) {
    return Object.assign(
      {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      extra || {}
    )
  }

  async function submit(input) {
    calls.submit += 1
    if (!configured) throw notConfigured()
    input = input || {}
    var imageUrl = (input.personUrls && input.personUrls[0]) || input.imageUrl
    if (!imageUrl) throw errors.fail(6002, { hint: '缺少人像图片公网 URL' })
    var payload = {
      model: model,
      input: { image: imageUrl },
      parameters: { texture_quality: input.textureQuality || 'standard' }
    }
    var res = await requestFn({
      method: 'POST',
      url: endpoint,
      headers: authHeaders(),
      body: JSON.stringify(payload),
      timeoutMs: timeoutMs
    })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      throw errors.fail(6001, { hint: '3D 供应商提交失败' })
    }
    var body = parseJson(res.body)
    var taskId = body && body.output && body.output.task_id
    if (!taskId) throw errors.fail(6002, { hint: '供应商提交响应缺少 task_id' })
    return { vendorJobId: String(taskId), provider: 'tripo', submittedAt: now() }
  }

  async function requestTask(vendorJobId) {
    var res = await requestFn({
      method: 'GET',
      url: tasksEndpoint + '/' + encodeURIComponent(vendorJobId),
      headers: { Authorization: 'Bearer ' + apiKey },
      timeoutMs: timeoutMs
    })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      throw errors.fail(6001, { hint: '3D 供应商查询失败' })
    }
    return parseJson(res.body)
  }

  async function query(params) {
    calls.query += 1
    if (!configured) throw notConfigured()
    var vendorJobId = params && params.vendorJobId
    if (!vendorJobId) throw errors.fail(6002, { hint: '缺少 vendorJobId' })
    var body = await requestTask(vendorJobId)
    var output = (body && body.output) || {}
    var rawStatus = String(output.task_status || '').toUpperCase()
    var mapped = STATUS_MAP[rawStatus]
    if (mapped === 'FAILED') {
      return {
        status: 'FAILED',
        failureCode: (output.code || 'vendor_generation_failed'),
        failureMessage: output.message || '3D 生成失败'
      }
    }
    if (mapped === 'CANCELLED') return { status: 'CANCELLED' }
    if (mapped === 'SUCCEEDED') {
      var results = Array.isArray(output.results) ? output.results : []
      var first = results[0] || {}
      var assetUrl = first.pbr_model_url || first.base_model_url || first.model_url || null
      if (!assetUrl) throw errors.fail(6002, { hint: '供应商成功响应缺少模型 URL' })
      return { status: 'SUCCEEDED', stage: 'SAVING', assetUrl: assetUrl }
    }
    if (mapped === 'BUILDING' || mapped === 'TEXTURING') return { status: mapped, stage: mapped }
    if (mapped === 'PENDING') return { status: 'PENDING' }
    // UNKNOWN / 无法识别：不得当成功；保持未完成由服务端 300s 超时兜底。
    return { status: 'PENDING', rawStatus: rawStatus || null }
  }

  async function downloadOnce(url) {
    var res = await fetchFn({ url: url, timeoutMs: timeoutMs * 4 })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      var error = errors.fail(6001, { hint: '模型下载失败' })
      error.detail = { statusCode: res && res.statusCode }
      throw error
    }
    return res.buffer
  }

  async function fetchAsset(params) {
    calls.fetchAsset += 1
    if (!configured) throw notConfigured()
    var vendorJobId = params && params.vendorJobId
    if (!vendorJobId) throw errors.fail(6002, { hint: '缺少 vendorJobId' })
    // SPEC §B.4.1：先 query 取最新 URL（结果 URL 2h 过期），再下载；403/404 时重查一次。
    var state = await query({ vendorJobId: vendorJobId })
    if (state.status !== 'SUCCEEDED' || !state.assetUrl) {
      throw errors.fail(6002, { hint: '供应商尚未产出可下载模型' })
    }
    var buffer
    try {
      buffer = await downloadOnce(state.assetUrl)
    } catch (firstError) {
      var code = firstError && firstError.detail && firstError.detail.statusCode
      if (code !== 403 && code !== 404) throw firstError
      var refreshed = await query({ vendorJobId: vendorJobId })
      if (refreshed.status !== 'SUCCEEDED' || !refreshed.assetUrl) {
        throw errors.fail(6001, { hint: '模型 URL 已过期且无法刷新' })
      }
      buffer = await downloadOnce(refreshed.assetUrl)
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw errors.fail(6002, { hint: '模型下载内容为空' })
    }
    if (buffer.length > util.MAX_MODEL_BYTES) {
      throw errors.fail(6003, { hint: '模型体积超过 45MB 限制' })
    }
    return { format: 'glb', bytes: buffer.length, buffer: buffer }
  }

  async function health() {
    calls.health += 1
    if (!configured) {
      return { ok: false, provider: 'tripo', configured: false, checkedAt: now() }
    }
    try {
      var res = await requestFn({
        method: 'GET',
        url: tasksEndpoint + '/0',
        headers: { Authorization: 'Bearer ' + apiKey },
        timeoutMs: timeoutMs
      })
      return { ok: !!(res && res.statusCode >= 200 && res.statusCode < 300), provider: 'tripo', configured: true, checkedAt: now() }
    } catch (error) {
      return { ok: false, provider: 'tripo', configured: true, checkedAt: now() }
    }
  }

  function cancel() {
    return Promise.resolve({ unsupported: true })
  }

  function erase() {
    return Promise.resolve({ unsupported: true })
  }

  return {
    provider: 'tripo',
    configured: configured,
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
  createTripoModel3dVendorAdapter: createTripoModel3dVendorAdapter,
  defaultRequestFn: defaultRequestFn,
  defaultFetchFn: defaultFetchFn,
  DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
  DEFAULT_TASKS_ENDPOINT: DEFAULT_TASKS_ENDPOINT,
  DEFAULT_MODEL: DEFAULT_MODEL
}
