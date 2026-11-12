/**
 * lib/vendor/index.js —— Model3dVendorAdapter 工厂（SPEC-0002 §B.4 / D-2）。
 *
 * `SINN_VENDOR_3D`：mock（默认）| tripo | tencenthunyuan | volcark | meshy | rpm。
 * - 默认 mock（确定性 fixture，不联网）；
 * - tripo 走阿里云百炼 Tripo 适配器骨架：缺凭证 → health.ok=false、submit/query 返回 6001，
 *   **绝不静默降级 mock**；
 * - 其余候选保留枚举：当前返回「不可用骨架」（6001 + health.ok=false），待 CP-02-01 开通后实现。
 */
'use strict'

var errors = require('../errors')
var contract = require('./model3d-contract')
var mock = require('./mock-model3d-vendor')
var tripo = require('./tripo-model3d-vendor')

var MODEL3D_PROVIDERS = ['mock', 'tripo', 'tencenthunyuan', 'volcark', 'meshy', 'rpm']

/** 未实现候选的不可用骨架：契约方法齐全，但调用一律 6001（不降级 mock）。 */
function createUnavailableModel3dVendorAdapter(provider, reason) {
  function unavailable() {
    return errors.fail(6001, { hint: '3D 供应商 ' + provider + ' 尚未接入' + (reason ? '（' + reason + '）' : '') })
  }
  return {
    provider: provider,
    configured: false,
    submit: function () { return Promise.reject(unavailable()) },
    query: function () { return Promise.reject(unavailable()) },
    fetchAsset: function () { return Promise.reject(unavailable()) },
    health: function () { return Promise.resolve({ ok: false, provider: provider, configured: false }) },
    cancel: function () { return Promise.resolve({ unsupported: true }) },
    erase: function () { return Promise.resolve({ unsupported: true }) }
  }
}

/**
 * @param {object} env 云函数环境变量
 * @param {object} [options] 测试注入：{now, requestFn, fetchFn, delayMs, fail, ...}
 */
function createModel3dVendorAdapter(env, options) {
  env = env || {}
  options = options || {}
  var provider = env.SINN_VENDOR_3D || 'mock'
  if (MODEL3D_PROVIDERS.indexOf(provider) < 0) {
    throw errors.fail(9000, { hint: '未知 SINN_VENDOR_3D: ' + provider })
  }

  if (provider === 'mock') {
    return contract.assertModel3dVendorContract(
      mock.createMockModel3dVendorAdapter(
        Object.assign({}, options, {
          env: env,
          now: options.now || function () { return Date.now() }
        })
      )
    )
  }

  if (provider === 'tripo') {
    return contract.assertModel3dVendorContract(tripo.createTripoModel3dVendorAdapter(env, options))
  }

  return contract.assertModel3dVendorContract(createUnavailableModel3dVendorAdapter(provider, '待 CP-02-01 开通'))
}

module.exports = {
  MODEL3D_PROVIDERS: MODEL3D_PROVIDERS,
  createModel3dVendorAdapter: createModel3dVendorAdapter,
  createUnavailableModel3dVendorAdapter: createUnavailableModel3dVendorAdapter
}
