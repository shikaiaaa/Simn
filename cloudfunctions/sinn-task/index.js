/**
 * sinn-task 云函数入口（SPEC-0001 §B.2）。
 *
 * 部署前提：
 * - 本目录作为云函数上传，Node.js 运行时；
 * - 环境变量：SINN_VENDOR=mock（真实供应商采购前必须保持 mock；切换 volcengine 时配置
 *   SINN_VOLC_AK/SK/REGION，见 lib/vendor/volcengine-vendor.js）、
 *   SINN_MOCK_SCENARIO（可选）、SINN_DAILY_LIMIT_NORMAL/VIP、SINN_VIP_WHITELIST、
 *   ALLOW_DEBUG_AUDIT=true + QA_OPENID_WHITELIST（仅测试环境用于 auditTask 断言）、
 *   SINN_VENDOR_ENDPOINT/KEY/TIMEOUT_MS（CP-04 后）。
 * - 业务 actions（统一 envelope）：assetRegister / precheck / createTask / taskGet /
 *   cancelTask / deleteTask / auditTask，实现在 lib/handler.js。
 * - 依赖安装：在云函数目录执行 npm install --production（开发机需在沙箱外执行）。
 *
 * 本地单测不加载本文件（wx-server-sdk 只在云端存在），handler/store/vendor 均可注入。
 */
'use strict'

var cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

var createHandler = require('./lib/handler').createHandler
var createCloudStore = require('./lib/store/cloud-store').createCloudStore
var createCloudStorage = require('./lib/storage').createCloudStorage
var createVendorAdapter = require('./lib/vendor').createVendorAdapter
var createPrecheckAdapter = require('./lib/precheck').createPrecheckAdapter
var util = require('./lib/util')

function envConfig(env) {
  function num(key, fallback) {
    var value = Number(env[key])
    return isFinite(value) && value > 0 ? value : fallback
  }
  return {
    dailyLimitNormal: num('SINN_DAILY_LIMIT_NORMAL', 1),
    dailyLimitVip: num('SINN_DAILY_LIMIT_VIP', 10),
    vipWhitelist: String(env.SINN_VIP_WHITELIST || '')
      .split(',')
      .map(function (item) { return item.trim() })
      .filter(function (item) { return !!item }),
    vendorProvider: env.SINN_VENDOR || 'mock'
  }
}

exports.main = async function main(event, context) {
  var env = process.env
  var wxContext = cloud.getWXContext()
  var openid = wxContext && wxContext.OPENID

  var handler = createHandler({
    store: createCloudStore({ db: cloud.database(), config: envConfig(env) }),
    storage: createCloudStorage({ cloud: cloud }),
    vendor: createVendorAdapter(env),
    precheck: createPrecheckAdapter(env),
    env: env,
    requestId: util.newRequestId()
  })

  return handler.handle(event || {}, { openid: openid })
}
