/**
 * lib/vendor/index.js —— VendorAdapter 工厂（SPEC-0001 v0.5 §B.4）。
 *
 * `SINN_VENDOR`：mock（默认）| volcengine（P1 指定真实供应商）| tencentmps | perfectcorp | aliyun。
 * - 默认保持 mock；只有显式配置 `SINN_VENDOR=volcengine` 且提供 `SINN_VOLC_AK/SK` 才启用火山适配器，
 *   未配置凭证时 health 未就绪、submit/query 返回 E_VENDOR_UNAVAILABLE（不假装可用）。
 * - volcengine 适配器见 volcengine-vendor.js；真实 HTTP/签名/字段待 CP-04b/04d 凭证实测。
 * - 其余 provider 仅保留枚举，落到 http-vendor.js 骨架（未接入方法返回 5001）。
 */
'use strict'

var mock = require('./mock-vendor')
var http = require('./http-vendor')
var volcengine = require('./volcengine-vendor')
var errors = require('../errors')

var VENDOR_METHODS = ['validate', 'submit', 'query', 'cancel', 'erase', 'health']
var PROVIDERS = ['mock', 'tencentmps', 'perfectcorp', 'volcengine', 'aliyun']

function assertVendorContract(adapter) {
  VENDOR_METHODS.forEach(function (method) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw errors.fail(9000, { hint: 'VendorAdapter 缺少方法: ' + method })
    }
  })
  return adapter
}

/**
 * @param {object} env 云函数环境变量
 * @param {object} [options] 测试注入：{now, scenario, generateMs, transport, timeoutMs, logger, ...}
 */
function createVendorAdapter(env, options) {
  env = env || {}
  options = options || {}
  var provider = env.SINN_VENDOR || 'mock'
  if (PROVIDERS.indexOf(provider) < 0) {
    throw errors.fail(9000, { hint: '未知 SINN_VENDOR: ' + provider })
  }

  if (provider === 'mock') {
    var mockOptions = Object.assign({}, options, {
      scenario: options.scenario || env.SINN_MOCK_SCENARIO || 'success',
      generateMs: options.generateMs === undefined ? Number(env.SINN_MOCK_GENERATE_MS) || undefined : options.generateMs,
      now: options.now || function () { return Date.now() }
    })
    if (mockOptions.generateMs === undefined) delete mockOptions.generateMs
    return assertVendorContract(mock.createMockVendorAdapter(mockOptions))
  }

  if (provider === 'volcengine') {
    return assertVendorContract(volcengine.createVolcengineVendorAdapter(env, options))
  }

  return assertVendorContract(http.createHttpVendorAdapter(env, provider))
}

module.exports = {
  VENDOR_METHODS: VENDOR_METHODS,
  PROVIDERS: PROVIDERS,
  createVendorAdapter: createVendorAdapter,
  assertVendorContract: assertVendorContract
}
