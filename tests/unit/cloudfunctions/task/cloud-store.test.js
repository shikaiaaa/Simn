/**
 * tests/unit/cloudfunctions/task/cloud-store.test.js
 * task-30：云端 doc(id).set()/update() 的 data 不允许包含 _id。
 *
 * 本地 memory-store 不校验 _id，导致 350 例单测漏掉真实云端写失败；
 * 本文件用 fake db 模拟微信云数据库行为：set/update 的 data 含 `_id` 直接拒绝
 * （-501001），断言 cloud-store / consent-store 的所有写入路径都已被 stripId 处理。
 */
'use strict'

var cloudStoreModule = require('../../../../cloudfunctions/sinn-task/lib/store/cloud-store')
var createCloudStore = cloudStoreModule.createCloudStore
var createCloudConsentStore = require('../../../../cloudfunctions/sinn-account/lib/consent-store').createCloudConsentStore

var FIXED_NOW = Date.UTC(2026, 10, 10, 4, 0, 0) // 2026-11-10 12:00 Asia/Shanghai

/**
 * fake db：模拟微信云数据库
 * - doc(id).set({data}) / update({data}) 的 data 若含 `_id` → reject -501001；
 * - doc(id).get() 返回 data 中自带 `_id`（与真实云端读一致）；
 * - 记录 stats.sets/updates/rejectsId，便于断言写入次数与未触发 _id 拒绝。
 */
function createFakeDb() {
  var data = {}
  var stats = { sets: 0, updates: 0, rejectsId: 0 }

  function idRejection(payload) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, '_id')) {
      stats.rejectsId += 1
      var error = new Error('-501001 resource system error. [InvalidParameter] _id is not allowed in set/update data')
      error.errCode = -501001
      return error
    }
    return null
  }

  function collection(name) {
    if (!data[name]) data[name] = {}
    return {
      doc: function (id) {
        return {
          get: function () {
            if (!data[name][id]) {
              var missing = new Error('document does not exist')
              missing.errCode = -502004
              return Promise.reject(missing)
            }
            return Promise.resolve({ data: Object.assign({ _id: id }, data[name][id]) })
          },
          set: function (params) {
            var rejected = idRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.sets += 1
            data[name][id] = Object.assign({}, params && params.data)
            return Promise.resolve({ _id: id })
          },
          update: function (params) {
            var rejected = idRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.updates += 1
            data[name][id] = Object.assign({}, data[name][id] || {}, params && params.data)
            return Promise.resolve({ stats: { updated: 1 } })
          },
          remove: function () {
            delete data[name][id]
            return Promise.resolve({ stats: { removed: 1 } })
          }
        }
      },
      where: function () {
        return {
          limit: function () { return this },
          orderBy: function () { return this },
          get: function () {
            var list = Object.keys(data[name]).map(function (id) {
              return Object.assign({ _id: id }, data[name][id])
            })
            return Promise.resolve({ data: list })
          },
          update: function (params) {
            var rejected = idRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.updates += 1
            return Promise.resolve({ stats: { updated: 1 } })
          }
        }
      }
    }
  }

  return {
    command: {
      lt: function (value) { return { op: 'lt', value: value } },
      lte: function (value) { return { op: 'lte', value: value } },
      gt: function (value) { return { op: 'gt', value: value } },
      inc: function (value) { return { op: 'inc', value: value } }
    },
    collection: collection,
    __data: data,
    __stats: stats
  }
}

function userFixture(overrides) {
  return Object.assign(
    {
      openid: 'o_cloud_user',
      dayKey: '2026-11-10',
      usedToday: 0,
      dailyLimit: 1,
      vip: false,
      vipSource: null,
      activeTaskId: null,
      consentVersion: null,
      consentAt: null,
      ageConfirmedAt: null,
      revokedAt: null
    },
    overrides || {}
  )
}

function taskFixture(overrides) {
  return Object.assign(
    {
      taskId: 't_0123456789abcdef01234567',
      openid: 'o_cloud_user',
      clientReqId: '11111111-2222-4333-8444-555555555555',
      status: 'QUEUED',
      stage: 'QUEUED',
      createdAt: FIXED_NOW,
      purgeAt: FIXED_NOW + 23 * 3600 * 1000
    },
    overrides || {}
  )
}

function assetFixture(overrides) {
  return Object.assign(
    {
      assetId: 'a_0123456789abcdef01234567',
      openid: 'o_cloud_user',
      kind: 'PERSON',
      fileID: 'cloud://mock-env/sinn/person/20261110/x.jpg',
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1024,
      height: 1536,
      purgeAt: FIXED_NOW + 23 * 3600 * 1000
    },
    overrides || {}
  )
}

describe('云端 doc.set/update 不允许 data._id（task-30）', function () {
  test('saveUser：写库 data 不含 _id，读回补 _id，fake db 不触发 -501001', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await expect(store.saveUser(userFixture())).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    expect(db.__stats.sets).toBe(1)
    expect(db.__data.sinn_users.o_cloud_user).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(db.__data.sinn_users.o_cloud_user, '_id')).toBe(false)
    var user = await store.getUser('o_cloud_user')
    expect(user._id).toBe('o_cloud_user')
    expect(user.openid).toBe('o_cloud_user')
    expect(user.dailyLimit).toBe(1)
  })

  test('saveTask：写库 data 不含 _id（文档 id 即 taskId），syncActive 的 update 也不带 _id', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveUser(userFixture())
    await expect(store.saveTask(taskFixture())).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(db.__data.sinn_tasks.t_0123456789abcdef01234567, '_id')).toBe(false)
    var task = await store.getTask('t_0123456789abcdef01234567')
    expect(task._id).toBe('t_0123456789abcdef01234567')
    expect(task.status).toBe('QUEUED')
    // syncActive 把 activeTaskId 写回用户文档（update 的 data 不含 _id）
    expect(db.__data.sinn_users.o_cloud_user.activeTaskId).toBe('t_0123456789abcdef01234567')
  })

  test('saveAsset：写库 data 不含 _id（文档 id 即 assetId）', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await expect(store.saveAsset(assetFixture())).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(db.__data.sinn_assets.a_0123456789abcdef01234567, '_id')).toBe(false)
    var asset = await store.getAsset('a_0123456789abcdef01234567')
    expect(asset._id).toBe('a_0123456789abcdef01234567')
    expect(asset.kind).toBe('PERSON')
  })

  test('updateTask/updateAsset：patch 里即使带 _id 也会被剥离（防御）', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveUser(userFixture())
    await store.saveTask(taskFixture({ status: 'SUCCEEDED' }))
    await expect(
      store.updateTask('t_0123456789abcdef01234567', { _id: 't_0123456789abcdef01234567', status: 'FAILED', failureCode: 5001 })
    ).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    await store.saveAsset(assetFixture())
    await expect(
      store.updateAsset('a_0123456789abcdef01234567', { _id: 'a_0123456789abcdef01234567', taskId: 't_0123456789abcdef01234567' })
    ).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    var asset = await store.getAsset('a_0123456789abcdef01234567')
    expect(asset.taskId).toBe('t_0123456789abcdef01234567')
  })

  test('consent-store.append：写库 data 不含 _id（文档 id 即 recordId）', async function () {
    var db = createFakeDb()
    var store = createCloudConsentStore(db)
    var record = {
      recordId: 'c_0123456789abcdef01234567',
      openid: 'o_cloud_user',
      version: '2026-11-09-v1',
      agreedAt: FIXED_NOW,
      ageConfirmedAt: FIXED_NOW,
      textHash: 'fnv1a-12345678',
      requestId: 'req-1',
      createdAt: FIXED_NOW
    }
    await expect(store.append(record)).resolves.toBeTruthy()
    expect(db.__stats.rejectsId).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(db.__data.sinn_consents.c_0123456789abcdef01234567, '_id')).toBe(false)
    var list = await store.listByOpenid('o_cloud_user')
    expect(list.length).toBe(1)
    expect(list[0]._id).toBe('c_0123456789abcdef01234567')
    expect(list[0].version).toBe('2026-11-09-v1')
  })

  test('consumeQuota：首次建用户走 set 且 data 不含 _id；首次 profile 不再 E_INTERNAL', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    var result = await store.consumeQuota({ openid: 'o_cloud_user', now: FIXED_NOW })
    expect(db.__stats.rejectsId).toBe(0)
    expect(db.__stats.sets).toBe(1)
    expect(Object.prototype.hasOwnProperty.call(db.__data.sinn_users.o_cloud_user, '_id')).toBe(false)
    expect(result.quota.limit).toBe(1)
    expect(result.quota.dayKey).toBe('2026-11-10')
    expect(result.quota.remaining).toBeGreaterThanOrEqual(0)
  })
})
