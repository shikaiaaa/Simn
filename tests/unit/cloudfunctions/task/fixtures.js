/**
 * tests/unit/cloudfunctions/task/fixtures.js
 * sinn-task 云函数单测公用夹具：内存 store、假时钟、假存储、Mock 供应商/预检、handler 工厂。
 * （本文件不是 *.test.js，不会被 jest 当作测试套件执行。）
 */
'use strict'

var createMemoryStore = require('../../../../cloudfunctions/sinn-task/lib/store/memory-store').createMemoryStore
var createHandler = require('../../../../cloudfunctions/sinn-task/lib/handler').createHandler
var createVendorAdapter = require('../../../../cloudfunctions/sinn-task/lib/vendor').createVendorAdapter
var createMockPrecheckAdapter = require('../../../../cloudfunctions/sinn-task/lib/precheck').createMockPrecheckAdapter
var util = require('../../../../cloudfunctions/sinn-task/lib/util')

var CONSENT_VERSION = '2026-11-09-v1'
var USER = 'o_user'
var QA = 'o_qa'
var OTHER = 'o_other'

var IDS = {
  person1: 'cloud://test/person/p1.jpg',
  person2: 'cloud://test/person/p2.jpg',
  garment: 'cloud://test/garment/g1.jpg',
  otherPerson: 'cloud://test/person/other.jpg'
}

function makeClock(start) {
  var t = typeof start === 'number' ? start : 1762700000000
  return {
    now: function () { return t },
    advance: function (ms) { t += ms; return t },
    set: function (value) { t = value; return t }
  }
}

function makeStorage(options) {
  options = options || {}
  var deleted = []
  var resultUploads = []
  var deletedThrows = !!options.failDelete
  return {
    download: function (fileID) {
      return Promise.resolve(Buffer.from('image:' + fileID))
    },
    saveResult: function (params) {
      var record = {
        taskId: params.taskId,
        width: params.width,
        height: params.height,
        fileID: 'cloud://test/result/' + params.taskId + '.png'
      }
      resultUploads.push(record)
      return Promise.resolve({ fileID: record.fileID, width: record.width, height: record.height })
    },
    deleteFiles: function (fileIDs) {
      if (deletedThrows) return Promise.reject(new Error('mock storage: delete failed'))
      deleted = deleted.concat(fileIDs)
      return Promise.resolve({ deleted: fileIDs, failed: [] })
    },
    __deleted: function () { return deleted.slice() },
    __resultUploads: function () { return resultUploads.slice() }
  }
}

function seedConsentUser(store, openid, options) {
  options = options || {}
  return store.saveUser({
    openid: openid,
    dayKey: options.dayKey || '',
    usedToday: options.usedToday || 0,
    dailyLimit: 0,
    vip: !!options.vip,
    vipSource: options.vip ? 'test' : null,
    activeTaskId: null,
    consentVersion: options.revoked ? null : CONSENT_VERSION,
    consentAt: options.revoked ? null : 1762699000000,
    ageConfirmedAt: options.revoked ? null : 1762699000000,
    revokedAt: options.revoked ? 1762699900000 : null
  })
}

var assetSeq = 0

/** 直接种一个预检已通过的资产（绕过 precheck 动作，用于 createTask 用例）。 */
function seedAsset(store, options) {
  options = options || {}
  assetSeq += 1
  var createdAt = options.now === undefined ? 1762700000000 : options.now
  var precheckStatus = options.precheckStatus === undefined ? 'pass' : options.precheckStatus
  var asset = {
    assetId: util.newAssetId(),
    openid: options.openid || USER,
    clientReqId: options.clientReqId || util.newRequestId(),
    kind: options.kind || 'PERSON',
    fileID: options.fileID || (options.kind === 'GARMENT' ? IDS.garment : IDS.person1),
    cloudPath: '',
    mime: 'image/jpeg',
    bytes: 1024 * 200,
    width: 1000,
    height: 1500 + assetSeq,
    createdAt: createdAt,
    purgeAt: createdAt + util.PURGE_TTL_MS,
    precheck: precheckStatus
      ? {
          pass: precheckStatus === 'pass',
          status: precheckStatus,
          checks: [],
          at: createdAt
        }
      : null
  }
  return store.saveAsset(asset).then(function () { return asset })
}

function makeContext(overrides) {
  overrides = overrides || {}
  var clock = overrides.clock || makeClock()
  var store = overrides.store || createMemoryStore({ config: overrides.config })
  var storage = overrides.storage || makeStorage()
  var env = Object.assign(
    { SINN_VENDOR: 'mock', ALLOW_DEBUG_AUDIT: 'true', QA_OPENID_WHITELIST: QA },
    overrides.env || {}
  )
  var vendor =
    overrides.vendor ||
    createVendorAdapter(env, {
      now: clock.now,
      scenario: overrides.scenario || 'success',
      queueMs: overrides.queueMs,
      generateMs: overrides.generateMs,
      width: overrides.width,
      height: overrides.height
    })
  var precheck =
    overrides.precheck ||
    createMockPrecheckAdapter(overrides.precheckResult ? { result: overrides.precheckResult } : {})
  var handler = createHandler({
    store: store,
    storage: storage,
    vendor: vendor,
    precheck: precheck,
    env: env,
    now: clock.now,
    requestId: 'req-test',
    precheckTimeoutMs: overrides.precheckTimeoutMs,
    taskTimeoutMs: overrides.taskTimeoutMs
  })
  function call(action, payload, openid) {
    return handler.handle(Object.assign({ action: action }, payload || {}), { openid: openid || USER })
  }
  return {
    clock: clock,
    store: store,
    storage: storage,
    vendor: vendor,
    precheck: precheck,
    env: env,
    handler: handler,
    call: call
  }
}

module.exports = {
  CONSENT_VERSION: CONSENT_VERSION,
  USER: USER,
  QA: QA,
  OTHER: OTHER,
  IDS: IDS,
  makeClock: makeClock,
  makeStorage: makeStorage,
  seedConsentUser: seedConsentUser,
  seedAsset: seedAsset,
  makeContext: makeContext
}
