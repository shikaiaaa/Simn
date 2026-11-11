/**
 * sinn-task 云函数入口（SPEC-0001 §B.2）。
 *
 * 部署前提（CP-02 云开发环境开通后）：
 * - 本目录作为云函数上传，Node.js 运行时；
 * - 环境变量：SINN_VENDOR=mock（CP-04 未定前必须保持 mock）、
 *   SINN_MOCK_SCENARIO（可选）、SINN_DAILY_LIMIT_NORMAL/VIP、SINN_VIP_WHITELIST、
 *   ALLOW_DEBUG_AUDIT=true + QA_OPENID_WHITELIST（仅测试环境）、
 *   SINN_SELFTEST=1（仅自检/建集合时临时开启，跑完删除；见 lib/selftest.js、lib/bootstrap.js）、
 *   SINN_VENDOR_ENDPOINT/KEY/TIMEOUT_MS（CP-04 后）。
 * - demo 调试入口：action=selftest / bootstrap / precheckDebug / cleanupSeed / cleanupCheck /
 *   quotaReset，门禁见 lib/debug-gate.js（SINN_SELFTEST=1 或 event.gate token）；
 *   上线前必须连同 actions 一起移除，并登记到 SPEC §G 人工卡点/上线差异清单。
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
var selftest = require('./lib/selftest')
var bootstrap = require('./lib/bootstrap')
var createPrecheckDebugHandler = require('./lib/precheck-debug').createPrecheckDebugHandler
var createCleanupDebugHandler = require('./lib/debug-cleanup').createCleanupDebugHandler
var createQuotaDebugHandler = require('./lib/debug-quota').createQuotaDebugHandler
var errors = require('./lib/errors')
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

  // task-28：受保护的自检 action（仅 SINN_SELFTEST=1 时可用），
  // 在业务 handler 之前拦截，避免依赖 lib/handler 的 store 抽象。
  if (event && event.action === 'selftest') {
    return selftest.handleSelftest(event, {
      cloud: cloud,
      db: cloud.database(),
      openid: openid,
      env: env,
      requestId: util.newRequestId()
    })
  }

  // task-29：受保护的建集合 action（门禁同 selftest），每次建议只传 1 个集合。
  if (event && event.action === 'bootstrap') {
    return bootstrap.handleBootstrap(event, {
      db: cloud.database(),
      env: env,
      requestId: util.newRequestId()
    })
  }

  // task-36：受保护的 precheck 逐步诊断动作（门禁同 selftest/bootstrap）。
  // ⚠️ 临时诊断入口：定位真实云 precheck E_INTERNAL 的真实异常后移除，或至少保持 gate 保护。
  if (event && event.action === 'precheckDebug') {
    var debugRequestId = util.newRequestId()
    var debugNow = function () { return Date.now() }
    try {
      var handlePrecheckDebug = createPrecheckDebugHandler({
        store: createCloudStore({ db: cloud.database(), config: envConfig(env) }),
        storage: createCloudStorage({ cloud: cloud, now: debugNow }),
        precheck: createPrecheckAdapter(env),
        now: debugNow,
        openid: openid,
        env: env,
        requestId: debugRequestId
      })
      var diagnostics = await handlePrecheckDebug(event)
      return { ok: true, data: diagnostics, error: null, requestId: debugRequestId, serverTime: debugNow() }
    } catch (debugError) {
      var appError = errors.normalizeError(debugError)
      return {
        ok: false,
        data: null,
        error: {
          code: appError.code,
          name: appError.name,
          message: appError.message,
          hint: appError.hint,
          httpStatus: appError.httpStatus
        },
        requestId: debugRequestId,
        serverTime: debugNow()
      }
    }
  }

  // task-39：受保护的 cleanup 定时触发器诊断（cleanupSeed / cleanupCheck）。
  if (event && (event.action === 'cleanupSeed' || event.action === 'cleanupCheck')) {
    var cleanupDiagnostics = createCleanupDebugHandler({
      db: cloud.database(),
      env: env,
      now: Date.now,
      requestId: util.newRequestId()
    })
    return cleanupDiagnostics.handle(event)
  }

  // task-40：受保护的额度重置调试动作（仅重置调用者本人当日额度，供 QA 同一天复跑 L3-002）。
  // ⚠️ 测试夹具能力：上线前随其它 debug 入口一起移除。
  if (event && event.action === 'quotaReset') {
    var quotaDebugHandler = createQuotaDebugHandler({
      store: createCloudStore({ db: cloud.database(), config: envConfig(env) }),
      env: env,
      now: Date.now,
      openid: openid,
      requestId: util.newRequestId()
    })
    return quotaDebugHandler.handle(event)
  }

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
