/**
 * tests/unit/cloudfunctions/account/fixtures.js
 * task-9（sinn-account / sinn-cleanup）单测夹具：内存 store、假时钟、假存储、内存同意审计、handler 工厂。
 * （本文件不是 *.test.js，不会被 jest 当作测试套件执行。）
 */
'use strict'

var base = require('../task/fixtures')
var createMemoryStore = require('../../../../cloudfunctions/sinn-task/lib/store/memory-store').createMemoryStore
var createAccountHandler = require('../../../../cloudfunctions/sinn-account/lib/handler').createHandler
var createCleanupHandler = require('../../../../cloudfunctions/sinn-cleanup/lib/handler').createHandler
var util = require('../../../../cloudfunctions/sinn-task/lib/util')

var USER = 'o_user'
var OTHER = 'o_other'
var QA = 'o_qa'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 内存版同意审计（append-only），与 cloud 实现同签名。 */
function makeConsentStore() {
  var records = []
  return {
    append: function (record) {
      records.push(clone(record))
      return Promise.resolve(clone(record))
    },
    listByOpenid: function (openid) {
      return Promise.resolve(records.filter(function (record) { return record.openid === openid }).map(clone))
    },
    __records: function () { return clone(records) }
  }
}

function seedUser(store, openid, patch) {
  var user = Object.assign(
    {
      openid: openid,
      dayKey: '',
      usedToday: 0,
      dailyLimit: 0,
      vip: false,
      vipSource: null,
      activeTaskId: null,
      consentVersion: null,
      consentAt: null,
      ageConfirmedAt: null,
      revokedAt: null
    },
    patch || {}
  )
  return store.saveUser(user)
}

function seedConsentUser(store, openid, options) {
  options = options || {}
  return seedUser(store, openid, {
    dayKey: options.dayKey || '',
    usedToday: options.usedToday || 0,
    vip: !!options.vip,
    consentVersion: base.CONSENT_VERSION,
    consentAt: 1762699000000,
    ageConfirmedAt: 1762699000000
  })
}

function seedTask(store, options) {
  options = options || {}
  var createdAt = options.createdAt === undefined ? 1762700000000 : options.createdAt
  var task = {
    taskId: options.taskId || util.newTaskId(),
    openid: options.openid || USER,
    clientReqId: options.clientReqId || util.newRequestId(),
    status: options.status || 'QUEUED',
    stage: options.stage || options.status || 'QUEUED',
    personAssetIds: [],
    garmentAssetId: null,
    metrics: { heightCm: 170, weightKg: 60 },
    sizeResult: null,
    resultFileID: options.resultFileID || null,
    resultWidth: options.resultWidth || null,
    resultHeight: options.resultHeight || null,
    vendorProvider: 'mock',
    vendorTaskId: options.vendorTaskId || null,
    submittedAt: createdAt,
    successAt: options.status === 'SUCCEEDED' ? createdAt : null,
    statusUpdatedAt: createdAt,
    purgeAt: options.purgeAt === undefined ? createdAt + util.PURGE_TTL_MS : options.purgeAt,
    quotaRefunded: !!options.quotaRefunded,
    failureCode: null,
    failureMessage: null
  }
  return store.saveTask(task).then(function () { return task })
}

function seedTaskAsset(store, task, options) {
  options = options || {}
  var createdAt = task.createdAt || 1762700000000
  var asset = {
    assetId: options.assetId || util.newAssetId(),
    openid: task.openid,
    clientReqId: util.newRequestId(),
    taskId: task.taskId,
    kind: options.kind || 'PERSON',
    fileID: options.fileID || 'cloud://test/person/' + task.taskId + '-' + util.randomHex(6) + '.jpg',
    cloudPath: '',
    mime: 'image/jpeg',
    bytes: 1000,
    width: 1000,
    height: 1500,
    createdAt: createdAt,
    purgeAt: task.purgeAt
  }
  return store.saveAsset(asset).then(function () { return asset })
}

function makeContext(overrides) {
  overrides = overrides || {}
  var clock = overrides.clock || base.makeClock()
  var store = overrides.store || createMemoryStore(overrides.config ? { config: overrides.config } : undefined)
  var storage = overrides.storage || base.makeStorage(overrides.storageOptions)
  var consentStore = overrides.consentStore || makeConsentStore()
  var vendor = overrides.vendor || null
  var env = Object.assign(
    { SINN_VENDOR: 'mock', ALLOW_DEBUG_AUDIT: 'true', QA_OPENID_WHITELIST: QA },
    overrides.env || {}
  )
  var logs = []
  var logger =
    overrides.logger ||
    {
      log: function (line) { logs.push(line) },
      error: function (line) { logs.push(line) }
    }
  var accountHandler = createAccountHandler({
    store: store,
    storage: storage,
    vendor: vendor,
    consentStore: consentStore,
    env: env,
    now: clock.now,
    requestId: 'req-test'
  })
  var cleanupHandler = createCleanupHandler({
    store: store,
    storage: storage,
    vendor: vendor,
    env: env,
    now: clock.now,
    batchSize: overrides.batchSize,
    logger: logger
  })
  function call(action, payload, openid) {
    return accountHandler.handle(Object.assign({ action: action }, payload || {}), { openid: openid || USER })
  }
  return {
    clock: clock,
    store: store,
    storage: storage,
    consentStore: consentStore,
    vendor: vendor,
    env: env,
    logs: logs,
    accountHandler: accountHandler,
    cleanupHandler: cleanupHandler,
    call: call
  }
}

module.exports = {
  USER: USER,
  OTHER: OTHER,
  QA: QA,
  CONSENT_VERSION: base.CONSENT_VERSION,
  makeClock: base.makeClock,
  makeStorage: base.makeStorage,
  makeConsentStore: makeConsentStore,
  seedUser: seedUser,
  seedConsentUser: seedConsentUser,
  seedTask: seedTask,
  seedTaskAsset: seedTaskAsset,
  makeContext: makeContext
}
