/**
 * tests/unit/cloudfunctions/task/cloud-store-undefined.test.js
 * task-35：微信云数据库 set/update 的 data 不允许包含 `undefined`（含嵌套）。
 *
 * 真实云现象：`sinn-task {action:'precheck'}` 返回 E_INTERNAL 9000。
 * 根因：handler.precheck 的 record 把 normalizeResult 的 code/name/message/hint/detail
 * （pass/unknown 分支为 undefined）一并写入 → cloud-store.updateDoc → doc.update 的 data
 * 含 undefined → 云数据库拒绝 → 未捕获 → 最外层包成 E_INTERNAL。
 *
 * 本文件用 fake db 模拟“data 含 undefined（深递归）→ reject”，断言：
 * - cloud-store 的 setDoc/updateDoc 会递归 sanitize（保留 null/false/0/''）；
 * - 空 patch 不再发 update；
 * - handler.precheck 的 pass/unknown/fail 三种真实写库路径都能成功（不再 9000）。
 */
'use strict'

var createCloudStore = require('../../../../cloudfunctions/sinn-task/lib/store/cloud-store').createCloudStore
var createHandler = require('../../../../cloudfunctions/sinn-task/lib/handler').createHandler

var FIXED_NOW = Date.UTC(2026, 10, 10, 4, 0, 0) // 2026-11-10 12:00 Asia/Shanghai
var OPENID = 'o_cloud_user'

/** 深度检测（含数组元素）：value（含嵌套）里是否存在 undefined。 */
function containsUndefined(value) {
  if (value === undefined) return true
  if (Array.isArray(value)) {
    return value.some(function (item) { return containsUndefined(item) })
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).some(function (key) { return containsUndefined(value[key]) })
  }
  return false
}

/**
 * fake db：模拟微信云数据库
 * - set/update 的 data 深度含 undefined → reject（-501001，与真实云端同类错误）；
 * - doc.get 返回 { data: { _id, ...store } }；
 * - 记录 stats.sets/updates/rejectsUndefined/lastSet/lastUpdate，便于断言。
 */
function createFakeDb() {
  var data = {}
  var stats = { sets: 0, updates: 0, rejectsUndefined: 0, lastSet: null, lastUpdate: null }

  function undefinedRejection(payload) {
    if (containsUndefined(payload)) {
      stats.rejectsUndefined += 1
      var error = new Error('-501001 resource system error. [InvalidParameter] undefined is not allowed in set/update data')
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
            var rejected = undefinedRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.sets += 1
            stats.lastSet = params.data
            data[name][id] = Object.assign({}, params.data)
            return Promise.resolve({ _id: id })
          },
          update: function (params) {
            var rejected = undefinedRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.updates += 1
            stats.lastUpdate = params.data
            data[name][id] = Object.assign({}, data[name][id] || {}, params.data)
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
            var rejected = undefinedRejection(params && params.data)
            if (rejected) return Promise.reject(rejected)
            stats.updates += 1
            stats.lastUpdate = params.data
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
      openid: OPENID,
      dayKey: '2026-11-10',
      usedToday: 0,
      dailyLimit: 1,
      vip: false,
      vipSource: null,
      activeTaskId: null,
      consentVersion: '2026-11-09-v1',
      consentAt: FIXED_NOW,
      ageConfirmedAt: FIXED_NOW,
      revokedAt: null
    },
    overrides || {}
  )
}

function taskFixture(overrides) {
  return Object.assign(
    {
      taskId: 't_0123456789abcdef01234567',
      openid: OPENID,
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
      openid: OPENID,
      kind: 'PERSON',
      fileID: 'cloud://mock-env/sinn/person/20261110/x.jpg',
      mime: 'image/jpeg',
      bytes: 1024,
      width: 1024,
      height: 1536,
      precheck: null,
      purgeAt: FIXED_NOW + 23 * 3600 * 1000
    },
    overrides || {}
  )
}

/** precheck record（模拟 handler.precheck 修复前的形状：可选字段值为 undefined）。 */
function passRecord() {
  return {
    pass: true,
    status: 'pass',
    checks: [{ code: 'single_person', status: 'pass', hint: undefined }],
    code: undefined,
    name: undefined,
    message: undefined,
    hint: undefined,
    detail: null,
    at: FIXED_NOW
  }
}

function unknownRecord() {
  return {
    pass: false,
    status: 'unknown',
    code: 3013,
    name: 'E_PRECHECK_UNKNOWN',
    message: '照片校验暂时无法完成',
    hint: '照片校验暂时无法完成，请换一张或稍后重试',
    checks: [{ code: '', status: 'unknown', hint: undefined }],
    detail: undefined,
    at: FIXED_NOW
  }
}

function failRecord() {
  return {
    pass: false,
    status: 'fail',
    code: 3001,
    name: 'E_PRECHECK_NOT_SINGLE_PERSON',
    message: '照片需为单人',
    hint: '照片需为单人，请重新拍摄',
    checks: [{ code: '3001', status: 'fail', hint: '' }],
    detail: { reason: undefined, retryable: false, attempts: 0, note: '' },
    at: FIXED_NOW
  }
}

describe('sanitizeWriteData：云端 data 不允许 undefined（task-35）', function () {
  test('setDoc 递归剔除 undefined（嵌套对象/数组），保留 null/false/0/空串', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveAsset(
      assetFixture({
        precheck: {
          pass: true,
          status: 'pass',
          checks: [{ code: 'single_person', status: 'pass', hint: undefined }],
          code: undefined,
          detail: { reason: undefined, retryable: false, attempts: 0, note: '', nil: null }
        }
      })
    )
    expect(db.__stats.rejectsUndefined).toBe(0)
    expect(db.__stats.sets).toBe(1)
    var stored = db.__data.sinn_assets.a_0123456789abcdef01234567
    expect(stored.precheck).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(stored.precheck, 'code')).toBe(false)
    expect(stored.precheck.detail).toEqual({ retryable: false, attempts: 0, note: '', nil: null })
    expect(stored.precheck.checks[0]).toEqual({ code: 'single_person', status: 'pass' })
  })

  test('数组内 undefined 元素归一为 null（保序、不改长度）', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveAsset(
      assetFixture({
        precheck: { status: 'unknown', checks: [undefined, { code: 'single_person', status: 'unknown', hint: undefined }] }
      })
    )
    expect(db.__stats.rejectsUndefined).toBe(0)
    var stored = db.__data.sinn_assets.a_0123456789abcdef01234567
    expect(stored.precheck.checks.length).toBe(2)
    expect(stored.precheck.checks[0]).toBeNull()
    expect(stored.precheck.checks[1]).toEqual({ code: 'single_person', status: 'unknown' })
  })

  test('updateAsset：pass 记录（无 code/name/message/hint）写库成功且不含 undefined 键', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveAsset(assetFixture())
    await expect(store.updateAsset('a_0123456789abcdef01234567', { precheck: passRecord() })).resolves.toBeTruthy()
    expect(db.__stats.rejectsUndefined).toBe(0)
    var stored = db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('pass')
    expect(stored.pass).toBe(true)
    expect(stored.detail).toBeNull()
    expect('code' in stored).toBe(false)
    expect('name' in stored).toBe(false)
    expect('message' in stored).toBe(false)
    expect('hint' in stored).toBe(false)
  })

  test('updateAsset：unknown 记录（code 3013）写库成功，checks 内 undefined hint 被剔除', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveAsset(assetFixture())
    await expect(store.updateAsset('a_0123456789abcdef01234567', { precheck: unknownRecord() })).resolves.toBeTruthy()
    expect(db.__stats.rejectsUndefined).toBe(0)
    var stored = db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('unknown')
    expect(stored.code).toBe(3013)
    expect('detail' in stored).toBe(false)
    expect(stored.checks[0]).toEqual({ code: '', status: 'unknown' })
  })

  test('updateAsset：fail 记录（含 code/hint）写库成功，detail 内 undefined 被剔除', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveAsset(assetFixture())
    await expect(store.updateAsset('a_0123456789abcdef01234567', { precheck: failRecord() })).resolves.toBeTruthy()
    expect(db.__stats.rejectsUndefined).toBe(0)
    var stored = db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('fail')
    expect(stored.code).toBe(3001)
    expect(stored.hint).toBe('照片需为单人，请重新拍摄')
    expect(stored.detail).toEqual({ retryable: false, attempts: 0, note: '' })
  })

  test('updateTask：可选字段 undefined 被剥离；显式 null 保留', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveUser(userFixture())
    await store.saveTask(taskFixture())
    await store.updateTask('t_0123456789abcdef01234567', {
      status: 'FAILED',
      failureCode: undefined,
      failureMessage: undefined,
      resultFileID: undefined,
      successAt: undefined
    })
    expect(db.__stats.rejectsUndefined).toBe(0)
    var stored = db.__data.sinn_tasks.t_0123456789abcdef01234567
    expect(stored.status).toBe('FAILED')
    expect('failureCode' in stored).toBe(false)
    expect('failureMessage' in stored).toBe(false)

    await store.updateTask('t_0123456789abcdef01234567', { failureCode: null, failureMessage: 'x' })
    expect(db.__stats.rejectsUndefined).toBe(0)
    var after = db.__data.sinn_tasks.t_0123456789abcdef01234567
    expect(after.failureCode).toBeNull()
    expect(after.failureMessage).toBe('x')
  })

  test('空 patch / 全 undefined patch 不触发 update', async function () {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    await store.saveUser(userFixture())
    // 用终态任务，避免 updateTask 内部的 syncActive 幂等写 users.activeTaskId 干扰计数。
    await store.saveTask(taskFixture({ status: 'FAILED' }))
    await store.saveAsset(assetFixture())
    var before = db.__stats.updates

    var asset = await store.updateAsset('a_0123456789abcdef01234567', {})
    expect(asset).toBeTruthy()
    await store.updateAsset('a_0123456789abcdef01234567', { precheck: undefined, taskId: undefined })
    await store.updateTask('t_0123456789abcdef01234567', { failureCode: undefined })
    expect(db.__stats.updates).toBe(before)
    expect(db.__stats.rejectsUndefined).toBe(0)
  })
})

describe('handler.precheck 真实写库路径（cloud-store + fake db 拒绝 undefined）', function () {
  function buildRuntime(adapterResult) {
    var db = createFakeDb()
    var store = createCloudStore({ db: db })
    var handler = createHandler({
      store: store,
      precheck: {
        validate: function () {
          return Promise.resolve(adapterResult)
        }
      },
      storage: {
        download: function () {
          return Promise.resolve(Buffer.from('fake-image'))
        }
      },
      now: function () { return FIXED_NOW },
      requestId: 'req-cloud-store-undefined-test'
    })
    return { db: db, store: store, handler: handler }
  }

  async function seed(runtime) {
    await runtime.store.saveUser(userFixture())
    await runtime.store.saveAsset(assetFixture())
  }

  test('pass：handler.precheck 返回 ok:true、status=pass，写库无 undefined 拒绝', async function () {
    var runtime = buildRuntime({ status: 'pass', checks: [] })
    await seed(runtime)
    var res = await runtime.handler.handle(
      { action: 'precheck', assetId: 'a_0123456789abcdef01234567' },
      { openid: OPENID }
    )
    expect(res.ok).toBe(true)
    expect(res.data.status).toBe('pass')
    expect(res.data.pass).toBe(true)
    expect(res.requestId).toBe('req-cloud-store-undefined-test')
    expect(runtime.db.__stats.rejectsUndefined).toBe(0)
    var stored = runtime.db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('pass')
    expect(stored.at).toBe(FIXED_NOW)
    expect('code' in stored).toBe(false)
    expect('hint' in stored).toBe(false)
  })

  test('unknown：handler.precheck 返回 ok:true（业务结果）、status=unknown、code=3013，不再 9000', async function () {
    var runtime = buildRuntime({ status: 'unknown', unknown: ['vendor_validate_unavailable'] })
    await seed(runtime)
    var res = await runtime.handler.handle(
      { action: 'precheck', assetId: 'a_0123456789abcdef01234567' },
      { openid: OPENID }
    )
    expect(res.ok).toBe(true)
    expect(res.data.status).toBe('unknown')
    expect(res.data.pass).toBe(false)
    expect(res.data.code).toBe(3013)
    expect(runtime.db.__stats.rejectsUndefined).toBe(0)
    var stored = runtime.db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('unknown')
    expect(stored.code).toBe(3013)
  })

  test('fail：handler.precheck 返回 ok:true（业务结果）、status=fail、code=3001，写库无 undefined 拒绝', async function () {
    var runtime = buildRuntime({ status: 'fail', failed: ['single_person'] })
    await seed(runtime)
    var res = await runtime.handler.handle(
      { action: 'precheck', assetId: 'a_0123456789abcdef01234567' },
      { openid: OPENID }
    )
    expect(res.ok).toBe(true)
    expect(res.data.status).toBe('fail')
    expect(res.data.pass).toBe(false)
    expect(res.data.code).toBe(3001)
    expect(runtime.db.__stats.rejectsUndefined).toBe(0)
    var stored = runtime.db.__data.sinn_assets.a_0123456789abcdef01234567.precheck
    expect(stored.status).toBe('fail')
    expect(stored.code).toBe(3001)
  })
})
