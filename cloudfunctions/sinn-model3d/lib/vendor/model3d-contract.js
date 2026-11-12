/**
 * lib/vendor/model3d-contract.js —— Model3dVendorAdapter 契约（SPEC-0002 §B.4.1）。
 *
 * 必需方法：submit / query / fetchAsset / health
 * 可选方法：cancel / erase（供应商不支持时允许返回 { unsupported: true }）
 */
'use strict'

var errors = require('../errors')

var MODEL3D_VENDOR_METHODS = ['submit', 'query', 'fetchAsset', 'health']

var MODEL3D_STATUSES = ['PENDING', 'BUILDING', 'TEXTURING', 'SUCCEEDED', 'FAILED', 'CANCELLED']

/** 契约形状断言：缺方法 → E_INTERNAL(9000)，避免静默降级。 */
function assertModel3dVendorContract(adapter) {
  MODEL3D_VENDOR_METHODS.forEach(function (method) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw errors.fail(9000, { hint: 'Model3dVendorAdapter 缺少方法: ' + method })
    }
  })
  return adapter
}

module.exports = {
  MODEL3D_VENDOR_METHODS: MODEL3D_VENDOR_METHODS,
  MODEL3D_STATUSES: MODEL3D_STATUSES,
  assertModel3dVendorContract: assertModel3dVendorContract
}
