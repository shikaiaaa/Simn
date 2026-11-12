/**
 * sinn-model3d 云函数入口（SPEC-0002 §B.1/§B.2，API-02-01..05）。
 *
 * 运行时：Node.js 20s 超时 / 256MB（部署后以 tcb fn info 回读为准）。
 * 环境变量（密钥只允许放这里，不进代码/日志）：
 * - SINN_VENDOR_3D        ：mock（默认）| tripo | tencenthunyuan | volcark | meshy | rpm
 * - SINN_TRIPO_API_KEY    ：阿里云百炼 DashScope API Key（tripo 供应商必需；缺失 → 6001，不降级 mock）
 * - SINN_MODEL3D_TIMEOUT_MS：服务端 3D 任务超时，正整数毫秒，默认 300000（SPEC D-5）
 * - SINN_MODEL3D_DAILY_LIMIT：3D 每日次数上限，0/缺省=不限（SPEC §3）
 * - SINN_MOCK_3D_DELAY_MS ：mock 生成耗时，默认 3000ms（测试用）
 * - SINN_MOCK_3D_FAIL     ：mock 失败场景 ''|fail|timeout|corrupt（测试用）
 *
 * 数据集合：sinn_users / sinn_tasks / sinn_assets（P1 已建）+ sinn_models3d（冷启动尽力创建）。
 */
'use strict'

var cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

var util = require('./lib/util')
var createHandler = require('./lib/handler').createHandler
var createCloudStore = require('./lib/store/cloud-store').createCloudStore
var createModel3dStorage = require('./lib/storage').createModel3dStorage
var createModel3dVendorAdapter = require('./lib/vendor').createModel3dVendorAdapter

var env = process.env
var db = cloud.database()
var store = createCloudStore({ db: db, config: { vendorProvider3d: env.SINN_VENDOR_3D || 'mock' } })
var storage = createModel3dStorage({ cloud: cloud })
var vendor = createModel3dVendorAdapter(env, {})

var handler = createHandler({
  store: store,
  storage: storage,
  vendor: vendor,
  env: env,
  now: Date.now,
  requestId: util.newRequestId
})

var modelsCollectionReady = null

/** 冷启动尽力创建 sinn_models3d（索引由部署文档记录为人工步骤；失败不阻塞业务）。 */
function ensureModelsCollection() {
  if (modelsCollectionReady) return modelsCollectionReady
  modelsCollectionReady = Promise.resolve()
    .then(function () {
      if (typeof db.createCollection !== 'function') return null
      return db.createCollection('sinn_models3d').catch(function (error) {
        // 已存在（-501001 Table exist / ResourceExist）或权限不足均视为可继续
        return { skipped: true, message: error && error.message }
      })
    })
    .catch(function () { return null })
  return modelsCollectionReady
}

exports.main = async function (event) {
  var startedAt = Date.now()
  await ensureModelsCollection()
  var wxContext = cloud.getWXContext() || {}
  var result = await handler.handle(event || {}, { openid: wxContext.OPENID })
  if (result && typeof result === 'object' && result.requestId) {
    // 运行日志（不含图片/密钥/公网 URL）
    console.log(
      JSON.stringify({
        action: 'sinn-model3d',
        requestId: result.requestId,
        actionName: (event && event.action) || '',
        ok: result.ok,
        code: result.error ? result.error.code : null,
        elapsedMs: Date.now() - startedAt
      })
    )
  }
  return result
}
