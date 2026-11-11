/**
 * sinn-account 云函数入口（SPEC §B.2 API-1..API-4）。
 *
 * 说明：
 * - 账户/额度/物理删除逻辑复用 sinn-task/lib 的单一实现（account.js / store / storage）；
 * - 本地单测不加载本文件（依赖 wx-server-sdk）；生产部署前需把跨目录依赖
 *   `../sinn-task/lib/**` 一并复制到本函数目录（或抽公共层），见 docs/dev/DEV-0001.md；
 * - 集合与索引创建属部署步骤，CP-02 云开发环境开通后执行。
 */
'use strict'

var cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

var createHandler = require('./lib/handler').createHandler
var createCloudConsentStore = require('./lib/consent-store').createCloudConsentStore
var createCloudStore = require('../sinn-task/lib/store/cloud-store').createCloudStore
var createCloudStorage = require('../sinn-task/lib/storage').createCloudStorage
var createVendorAdapter = require('../sinn-task/lib/vendor').createVendorAdapter

var db = cloud.database()
var store = createCloudStore({ db: db })
var handler = createHandler({
  store: store,
  storage: createCloudStorage({ cloud: cloud, now: Date.now }),
  vendor: createVendorAdapter(process.env, {}),
  consentStore: createCloudConsentStore(db),
  env: process.env,
  now: Date.now
})

exports.main = async function (event) {
  var wxContext = cloud.getWXContext()
  return handler.handle(event || {}, { openid: wxContext.OPENID })
}
