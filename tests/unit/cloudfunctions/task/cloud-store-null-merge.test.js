/**
 * tests/unit/cloudfunctions/task/cloud-store-null-merge.test.js
 * task-37：cloud 数据库 update 深合并进 null 导致 -502001 的回归测试。
 *
 * 真实云行为（QA precheckDebug 实测）：
 *   document.update:fail -502001 database request fail. [FailedOperation]
 *   multiple write errors: [{write errors: [{Cannot create field 'at' in element {precheck: null}}]}, {<nil>}]
 *
 * fake db 精确模拟三个真实约束：
 *  1) set/update 的 data 不允许 `_id`（task-30）；
 *  2) set/update 的 data 不允许 `undefined`（task-35）；
 *  3) update 对对象字段做深合并；父字段为 null 时写子字段 → 抛 -502001（task-37）。
 * 同时支持 `db.command.set(value)`：整字段替换，用于修复后的写通道。
 */
'use strict'

var createCloudStore = require('../../../../cloudfunctions/sinn-task/lib/store/cloud-store').createCloudStore
var fixtures = require('./fixtures')

var USER = fixtures.USER
var ASSET_ID = 'a_0123456789abcdef01234567'
var TASK_ID = 't_0123456789abcdef01234567'

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  var proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function hasUndefinedDeep(value) {
  if (Array.isArray(value)) return value.some(hasUndefinedDeep)
  if (isPlainObject(value)) {
    return Object.keys(value).some(function (key) {
      return value[key] === undefined || hasUndefinedDeep(value[key])
    })
  }
  return false
}

function createFakeDb() {
  var state = {}

  function bucket(name) {
    if (!state[name]) state[name] = { docs: {}, sets: [], updates: [] }
    return state[name]
  }

  function assertWritable(data, op) {
    if (Object.prototype.hasOwnProperty.call(data || {}, '_id')) {
      var idError = new Error('document.' + op + ':fail -501001 database request fail. [FailedOperation] _id is not allowed')
      idError.errCode = -501001
      throw idError
    }
    if (hasUndefinedDeep(data)) {
      var undefinedError = new Error('document.' + op + ':fail -501001 database request fail. [FailedOperation] undefined is not allowed')
      undefinedError.errCode = -501001
      throw undefinedError
    }
  }

  function updateDoc(bucketRef, id, data) {
    assertWritable(data, 'update')
    if (!bucketRef.docs[id]) return Promise.reject(new Error('document.update:fail document not exists'))
    bucketRef.updates.push(deepClone(data))
    var doc = bucketRef.docs[id]
    try {
      Object.keys(data).forEach(function (key) {
        var value = data[key]
        if (value && value.__setCommand === true) {
          // 整字段替换：等价于 db.command.set(value)
          doc[key] = deepClone(value.value)
          return
        }
        if (isPlainObject(value)) {
          if (doc[key] === null) {
            var field = Object.keys(value)[0] || 'field'
            var mergeError = new Error(
              'document.update:fail -502001 database request fail. [FailedOperation] multiple write errors: ' +
                "[{write errors: [{Cannot create field '" + field + "' in element {" + key + ': null}}]}, {<nil>}]'
            )
            mergeError.errCode = -502001
            throw mergeError
          }
          if (!isPlainObject(doc[key])) doc[key] = {}
          Object.keys(value).forEach(function (subKey) {
            doc[key][subKey] = deepClone(value[subKey])
          })
          return
        }
        doc[key] = value
      })
    } catch (error) {
      return Promise.reject(error)
    }
    return Promise.resolve({ stats: { updated: 1 } })
  }

  var db = {
    command: {
      set: function (value) {
        return { __setCommand: true, value: value }
      },
      inc: function (step) {
        return { __incCommand: step }
      },
      lt: function (value) {
        return { __lt: value }
      },
      lte: function (value) {
        return { __lte: value }
      },
      gt: function (value) {
        return { __gt: value }
      }
    },
    collection: function (name) {
      var ref = bucket(name)
      return {
        doc: function (id) {
          return {
            get: function () {
              if (!ref.docs[id]) {
                return Promise.reject(new Error('document.get:fail document not exists'))
              }
              return Promise.resolve({ data: Object.assign({ _id: id }, deepClone(ref.docs[id])) })
            },
            set: function (options) {
              try {
                assertWritable(options.data, 'set')
              } catch (error) {
                return Promise.reject(error)
              }
              ref.sets.push(deepClone(options.data))
              ref.docs[id] = deepClone(options.data)
              return Promise.resolve({ stats: { created: 1 } })
            },
            update: function (options) {
              return updateDoc(ref, id, options.data)
            }
          }
        }
      }
    },
    __seed: function (name, id, doc) {
      bucket(name).docs[id] = deepClone(doc)
    },
    __state: function (name) {
      return bucket(name)
    }
  }
  return db
}

function makeFakeCloudStore(seedFn) {
  var db = createFakeDb()
  if (seedFn) seedFn(db)
  var store = createCloudStore({ db: db })
  return { db: db, store: store }
}

describe('task-37：update 深合并进 null（真实云 -502001）复现与修复', function () {
  test('fake db 能复现真实错误：父字段 null 时普通 object 写 update 抛 Cannot create field', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_assets', ASSET_ID, { assetId: ASSET_ID, precheck: null })
    })
    await expect(
      helper.db.collection('sinn_assets').doc(ASSET_ID).update({ data: { precheck: { pass: true } } })
    ).rejects.toThrow(/Cannot create field 'pass' in element \{precheck: null\}/)
  })

  test('updateAsset 在存量 precheck=null 文档上成功，并整字段替换、读回完整', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_assets', ASSET_ID, {
        assetId: ASSET_ID,
        openid: USER,
        kind: 'PERSON',
        precheck: null,
        fileID: 'cloud://mock/sinn/person/photo.jpg'
      })
    })
    var record = {
      pass: true,
      status: 'pass',
      checks: [{ code: 'single_person', status: 'pass' }],
      at: 1762740000000
    }

    var updated = await helper.store.updateAsset(ASSET_ID, { precheck: record })
    expect(updated).not.toBeNull()
    expect(updated.precheck).toEqual(record)
    expect(updated.precheck.checks[0].code).toBe('single_person')

    // 发给云端的 update data：precheck 是 command.set 包装的整字段替换，不再是裸对象
    var sent = helper.db.__state('sinn_assets').updates[0]
    expect(sent.precheck.__setCommand).toBe(true)
    expect(sent.precheck.value).toEqual(record)
    // 读回文档不再含命令包装，只是完整 precheck 对象
    expect(helper.db.__state('sinn_assets').docs[ASSET_ID].precheck).toEqual(record)
  })

  test('新资产文档没有 precheck 字段时也能写入（不需要 null 站点）', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_assets', ASSET_ID, { assetId: ASSET_ID, openid: USER })
    })
    var updated = await helper.store.updateAsset(ASSET_ID, { precheck: { pass: false, status: 'unknown', at: 1 } })
    expect(updated.precheck).toEqual({ pass: false, status: 'unknown', at: 1 })
  })

  test('assetRegister 新文档不再写 precheck:null（owner 读回无该字段）', async function () {
    var ctx = fixtures.makeContext({ env: { SINN_VENDOR: 'mock' } })
    await fixtures.seedConsentUser(ctx.store, USER)
    var res = await ctx.call('assetRegister', {
      clientReqId: '11111111-1111-4111-8111-111111111111',
      kind: 'PERSON',
      fileID: 'cloud://mock/sinn/person/photo.jpg',
      mime: 'image/jpeg',
      bytes: 44191,
      width: 800,
      height: 1200
    })
    expect(res.ok).toBe(true)
    var asset = await ctx.store.getAsset(res.data.assetId)
    expect(asset).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(asset, 'precheck')).toBe(false)
  })

  test('同类风险字段：sizeResult 从 null 整字段替换（updateTask 通道）', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_users', USER, { openid: USER, activeTaskId: null })
      db.__seed('sinn_tasks', TASK_ID, { taskId: TASK_ID, openid: USER, status: 'SUCCEEDED', sizeResult: null })
    })
    var updated = await helper.store.updateTask(TASK_ID, {
      sizeResult: { rangeMin: 'L', rangeMax: 'XL', standard: 'GB/T 1335.1', disclaimer: '参考尺码，不构成合身承诺' }
    })
    expect(updated.sizeResult.rangeMin).toBe('L')
    expect(helper.db.__state('sinn_tasks').docs[TASK_ID].sizeResult.rangeMax).toBe('XL')
  })

  test('task-35 不回归：patch 内 undefined 仍被剔除后再下发（不会因 undefined 被拒）', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_assets', ASSET_ID, { assetId: ASSET_ID, precheck: null })
    })
    var patch = {
      precheck: { pass: true, status: 'pass', code: undefined, name: undefined, checks: [] },
      bytes: undefined
    }
    var updated = await helper.store.updateAsset(ASSET_ID, patch)
    expect(updated.precheck).toEqual({ pass: true, status: 'pass', checks: [] })
    var sent = helper.db.__state('sinn_assets').updates[0]
    expect(sent.precheck.value.code).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(sent, 'bytes')).toBe(false)
  })

  test('空 patch 不触发 update（updateAsset 仍返回当前文档）', async function () {
    var helper = makeFakeCloudStore(function (db) {
      db.__seed('sinn_assets', ASSET_ID, { assetId: ASSET_ID, precheck: null })
    })
    var res = await helper.store.updateAsset(ASSET_ID, {})
    expect(helper.db.__state('sinn_assets').updates.length).toBe(0)
    expect(res).toEqual(expect.objectContaining({ assetId: ASSET_ID, precheck: null }))
  })
})
