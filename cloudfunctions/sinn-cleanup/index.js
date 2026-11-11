/**
 * sinn-cleanup 云函数入口（SPEC §4 / API-13 定时清理）。
 *
 * 定时触发器配置见同目录 config.json：每 10 分钟执行一次。
 * 部署前置：CP-02 云开发环境（envId）开通；部署步骤见 docs/dev/DEV-0001.md。
 * 跨目录依赖 `../sinn-task/lib/**` 在部署时需一并复制进本函数目录（或抽公共层）。
 */
'use strict'

var cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

var createHandler = require('./lib/handler').createHandler
var createCloudStore = require('../sinn-task/lib/store/cloud-store').createCloudStore
var createCloudStorage = require('../sinn-task/lib/storage').createCloudStorage
var createVendorAdapter = require('../sinn-task/lib/vendor').createVendorAdapter

var db = cloud.database()
var handler = createHandler({
  store: createCloudStore({ db: db }),
  storage: createCloudStorage({ cloud: cloud, now: Date.now }),
  vendor: createVendorAdapter(process.env, {}),
  env: process.env,
  now: Date.now,
  batchSize: 100
})

exports.main = async function () {
  return handler.handle()
}
