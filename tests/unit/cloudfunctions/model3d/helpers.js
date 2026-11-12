/**
 * tests/unit/cloudfunctions/model3d/helpers.js —— sinn-model3d 单测夹具。
 *
 * 与 P1 测试一致：内存 store + fake storage + 注入时钟，不加载 wx-server-sdk、不联网。
 */
'use strict'

var util = require('../../../../cloudfunctions/sinn-model3d/lib/util')
var createMemoryStore = require('../../../../cloudfunctions/sinn-model3d/lib/store/memory-store').createMemoryStore
var createHandler = require('../../../../cloudfunctions/sinn-model3d/lib/handler').createHandler
var createMockVendor = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/mock-model3d-vendor').createMockModel3dVendorAdapter

var USER = 'o_user_3d'
var OTHER = 'o_other_3d'
var START = 1794444000000
var MB = 1024 * 1024

function makeClock(start) {
  var current = typeof start === 'number' ? start : START
  return {
    now: function () { return current },
    advance: function (ms) { current += ms; return current },
    set: function (ms) { current = ms; return current }
  }
}

function makeStorage(options) {
  options = options || {}
  var clock = options.clock || makeClock()
  var uploads = []
  var deletions = []
  var counter = 0
  var storage = {
    getTempFileURL: function (fileIDs) {
      if (options.urlError) return Promise.reject(options.urlError)
      var list = (fileIDs || []).filter(function (id) { return !!id })
      return Promise.resolve(
        list.map(function (fileID) {
          return { fileID: fileID, tempFileURL: (options.urlBase || 'https://fake.tcb/') + encodeURIComponent(fileID), status: 0 }
        })
      )
    },
    uploadModel: function (buffer, params) {
      if (options.uploadError) return Promise.reject(options.uploadError)
      counter += 1
      var fileID = 'cloud://fake/' + (params && params.openidHash) + '/' + (params && params.modelId) + '/model.glb' + counter
      uploads.push({ buffer: buffer, params: params, fileID: fileID })
      return Promise.resolve({
        fileID: fileID,
        cloudPath: 'sinn/model3d/' + (params && params.openidHash) + '/' + (params && params.modelId) + '/model.glb'
      })
    },
    uploadThumb: function (buffer, params) {
      counter += 1
      return Promise.resolve({ fileID: 'cloud://fake/thumb/' + counter, cloudPath: 'thumb', bytes: buffer.length })
    },
    deleteFiles: function (fileIDs) {
      if (options.deleteError) return Promise.reject(options.deleteError)
      deletions.push((fileIDs || []).slice())
      return Promise.resolve({ deleted: (fileIDs || []).map(function (fileID) { return { fileID: fileID, status: 0 } }), failed: [] })
    },
    download: function () { return Promise.resolve(Buffer.alloc(0)) },
    __uploads: function () { return uploads.slice() },
    __deletions: function () { return deletions.slice() },
    clock: clock
  }
  return storage
}

/** 预置已完成 3D 同意（consentVersion3d 预留给 DEV-0002-06）。 */
function seedConsentUser(store, openid, overrides) {
  var now = (overrides && overrides.now) || START
  return store.saveUser(
    Object.assign(
      {
        openid: openid,
        consentVersion: 'v1',
        consentAt: now - 1000,
        ageConfirmedAt: now - 1000,
        revokedAt: null,
        consentVersion3d: 'v3d-1',
        activeModel3dTaskId: null,
        model3dUsedDayKey: '',
        model3dUsedToday: 0
      },
      overrides || {}
    )
  )
}

function makeAssetId(index) {
  var suffix = String(index === undefined ? 1 : index)
  return 'a_' + (suffix + '0123456789abcdef0123456').slice(0, 24)
}

function seedPersonAsset(store, openid, overrides) {
  var asset = Object.assign(
    {
      assetId: makeAssetId((overrides && overrides.index) || 1),
      openid: openid,
      kind: 'person',
      clientReqId: null,
      fileID: 'cloud://person/photo-' + ((overrides && overrides.index) || 1) + '.jpg',
      cloudPath: 'person/photo-' + ((overrides && overrides.index) || 1) + '.jpg',
      mime: 'image/jpeg',
      bytes: 2 * MB,
      width: 2048,
      height: 3072,
      orientation: 'up',
      createdAt: START,
      purgeAt: START + util.PURGE_TTL_MS,
      precheck: { pass: true, code: 0 }
    },
    overrides || {}
  )
  // model3d store 对 assets 只读，测试通过 __seedAsset 注入（cloud-store 无该 helper）。
  var seeder = typeof store.__seedAsset === 'function' ? store.__seedAsset : store.saveAsset
  return Promise.resolve(seeder.call(store, asset)).then(function () { return asset })
}

function makeContext(overrides) {
  overrides = overrides || {}
  var clock = overrides.clock || makeClock(overrides.start)
  var store = createMemoryStore({ config: { vendorProvider3d: overrides.provider || 'mock', model3dDailyLimit: overrides.dailyLimit || 0 } })
  var storage = makeStorage({ clock: clock, urlBase: overrides.urlBase, urlError: overrides.urlError, uploadError: overrides.uploadError, deleteError: overrides.deleteError })
  var vendor =
    overrides.vendor ||
    createMockVendor({
      now: clock.now,
      delayMs: overrides.delayMs === undefined ? 3000 : overrides.delayMs,
      fail: overrides.fail,
      env: overrides.env || {}
    })
  var env = Object.assign(
    { SINN_VENDOR_3D: overrides.provider || 'mock', SINN_MODEL3D_TIMEOUT_MS: String(overrides.timeoutMs || 300000) },
    overrides.env || {}
  )
  var handler = createHandler({
    store: store,
    storage: storage,
    vendor: vendor,
    env: env,
    now: clock.now,
    requestId: overrides.requestId || function () { return 'req-test' },
    timeoutMs: overrides.timeoutMs,
    model3dDailyLimit: overrides.dailyLimit
  })
  function call(action, payload, openid) {
    return handler.handle({ action: action, payload: payload }, { openid: openid || USER })
  }
  return { clock: clock, store: store, storage: storage, vendor: vendor, env: env, handler: handler, call: call }
}

function makeUuid(n) {
  var tail = String(n === undefined ? 1 : n).padStart(12, '0')
  return '11111111-1111-4111-8111-' + tail
}

function personPayload(overrides) {
  overrides = overrides || {}
  return Object.assign(
    {
      clientReqId: overrides.clientReqId || makeUuid(1),
      personAssetIds: overrides.personAssetIds || [makeAssetId(1)],
      metrics: overrides.metrics || { heightCm: 170, weightKg: 60.5, gender: 'female' }
    },
    overrides
  )
}

/** 建立一个已完成提交（QUEUED/GENERATING）的 3D 上下文，返回 task。 */
async function withSubmittedTask(ctx, openid, options) {
  options = options || {}
  var owner = openid || USER
  if (!options.skipConsent) await seedConsentUser(ctx.store, owner)
  var asset = await seedPersonAsset(ctx.store, owner, options.asset)
  var res = await ctx.call('model3dSubmit', personPayload({ clientReqId: options.clientReqId || makeUuid(10), personAssetIds: [asset.assetId] }), owner)
  return { res: res, asset: asset, taskId: res && res.data && res.data.taskId }
}

module.exports = {
  USER: USER,
  OTHER: OTHER,
  START: START,
  MB: MB,
  makeClock: makeClock,
  makeStorage: makeStorage,
  seedConsentUser: seedConsentUser,
  seedPersonAsset: seedPersonAsset,
  makeAssetId: makeAssetId,
  makeContext: makeContext,
  makeUuid: makeUuid,
  personPayload: personPayload,
  withSubmittedTask: withSubmittedTask
}
