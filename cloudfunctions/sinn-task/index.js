/**
 * sinn-task 云函数入口（SPEC-0001 §B.2）。
 *
 * 部署前提：
 * - 本目录作为云函数上传，Node.js 运行时；
 * - 环境变量：SINN_VENDOR=mock（真实供应商采购前必须保持 mock；切换 volcengine 时配置
 *   SINN_VOLC_AK/SK/REGION，见 lib/vendor/volcengine-vendor.js）、
 *   SINN_MOCK_SCENARIO（可选）、SINN_DAILY_LIMIT_NORMAL/VIP、SINN_VIP_WHITELIST、
 *   SINN_TASK_TIMEOUT_MS（可选，正整数毫秒，默认 util.TASK_TIMEOUT_MS=96000；
 *   仅用于延长等待以验证真实供应商时延，生产保持缺省）、
 *   ALLOW_DEBUG_AUDIT=true + QA_OPENID_WHITELIST（仅测试环境用于 auditTask 断言）、
 *   SINN_VENDOR_ENDPOINT/KEY/TIMEOUT_MS（CP-04 后）。
 * - 业务 actions（统一 envelope）：assetRegister / precheck / createTask / taskGet /
 *   cancelTask / deleteTask / auditTask，实现在 lib/handler.js。
 * - 临时诊断动作 diag（task-66，上线前移除）：在业务 handler 之前处理，门禁复用
 *   SINN_SELFTEST=1 或 event.gate='sinn-selftest-2026-11-10'；只读诊断、不创建任务/不扣额度。
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
var createEnvConfig = require('./lib/env-config').createEnvConfig
var handleDiag = require('./lib/diag').handleDiag
var util = require('./lib/util')

exports.main = async function main(event, context) {
  var env = process.env

  // 临时诊断动作（task-66）：放在业务 handler 之前；未启用门禁时 1004/403 且不构造/不调用 vendor。
  if (event && event.action === 'diag') {
    return handleDiag(event, env, { requestId: util.newRequestId() })
  }

  var wxContext = cloud.getWXContext()
  var openid = wxContext && wxContext.OPENID
  var config = createEnvConfig(env)

  var handler = createHandler({
    store: createCloudStore({ db: cloud.database(), config: config }),
    storage: createCloudStorage({ cloud: cloud }),
    vendor: createVendorAdapter(env),
    precheck: createPrecheckAdapter(env),
    env: env,
    requestId: util.newRequestId(),
    taskTimeoutMs: config.taskTimeoutMs
  })

  return handler.handle(event || {}, { openid: openid })
}
