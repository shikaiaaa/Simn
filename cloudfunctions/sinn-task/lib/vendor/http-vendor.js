/**
 * lib/vendor/http-vendor.js —— HttpVendorAdapter 骨架（SPEC-0001 §B.4，CP-04 未定）。
 *
 * 只读环境变量，不实现任何供应商私有协议：
 * - SINN_VENDOR_ENDPOINT：供应商服务地址
 * - SINN_VENDOR_KEY：API Key（只存云函数环境变量，不落库、不下发客户端）
 * - SINN_VENDOR_TIMEOUT_MS：单次 HTTP 超时（默认 8000）
 *
 * CP-04 采购/试用结论出来后，在此文件按腾讯云 MPS / Perfect Corp 文档补全：
 * submit → 异步 task_id；query → 轮询；失败码映射到内部错误码（见 SPEC §B.4 映射表）。
 * 在此之前所有调用抛 E_VENDOR_UNAVAILABLE，避免"假装能跑"。
 */
'use strict'

var errors = require('../errors')

function envOf(env, key) {
  var value = env && env[key]
  return value === undefined || value === null ? '' : String(value)
}

function createHttpVendorAdapter(env, provider) {
  env = env || {}
  var endpoint = envOf(env, 'SINN_VENDOR_ENDPOINT')
  var apiKey = envOf(env, 'SINN_VENDOR_KEY')
  var timeoutMs = Number(envOf(env, 'SINN_VENDOR_TIMEOUT_MS')) || 8000
  var configured = !!(endpoint && apiKey)

  function notImplemented(method) {
    return errors.fail(5001, {
      hint: '供应商适配器（' + (provider || 'http') + '）尚未接入：' + method + '（CP-04 采购/试用后补全）'
    })
  }

  return {
    provider: provider || 'http',
    endpoint: endpoint,
    timeoutMs: timeoutMs,
    validate: function () {
      return Promise.reject(notImplemented('validate'))
    },
    submit: function () {
      return Promise.reject(notImplemented('submit'))
    },
    query: function () {
      return Promise.reject(notImplemented('query'))
    },
    cancel: function () {
      return Promise.reject(notImplemented('cancel'))
    },
    erase: function () {
      return Promise.resolve() // 尽力删除：未接入时不阻塞主流程
    },
    health: function () {
      return Promise.resolve({ ok: configured, latencyMs: 0 })
    }
  }
}

module.exports = { createHttpVendorAdapter: createHttpVendorAdapter }
