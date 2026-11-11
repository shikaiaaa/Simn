/**
 * tests/unit/cloudfunctions/task/selftest.test.js
 * task-28：sinn-task 受保护 selftest action 的离线单测（fake db / fake cloud storage）。
 */
'use strict'

var selftest = require('../../../../cloudfunctions/sinn-task/lib/selftest')
var util = require('../../../../cloudfunctions/sinn-task/lib/util')

var FIXED_NOW = Date.UTC(2026, 10, 10, 4, 0, 0) // 2026-11-10 12:00 Asia/Shanghai
var OPENID = 'o_selftest_user'
var REQ = 'req-selftest-0001'

function makeClock(start) {
  var t = start === undefined ? FIXED_NOW : start
  return function () {
    t += 3
    return t
  }
}

function matches(doc, cond) {
  return Object.keys(cond).every(function (key) { return doc[key] === cond[key] })
}

function createFakeCloud(options) {
  options = options || {}
  var collections = {}
  var files = {}
  var stats = { adds: 0, removes: 0, uploads: 0, downloads: 0, deletes: 0, tempUrls: 0 }

  if (options.configDoc) collections.sinn_config = [Object.assign({}, options.configDoc)]
  if (options.userDoc) collections.sinn_users = [Object.assign({}, options.userDoc)]

  function getCollection(name) {
    if (options.missingCollection === name) throw new Error('collection not exists: ' + name)
    if (!collections[name]) collections[name] = []
    return collections[name]
  }

  function makeCollection(name) {
    return {
      add: function (params) {
        stats.adds += 1
        if (options.failAddFor === name) return Promise.reject(new Error('add failed: ' + name))
        var list = getCollection(name)
        var doc = Object.assign({}, params && params.data)
        if (list.some(function (item) { return item._id === doc._id })) {
          return Promise.reject(new Error('duplicate key'))
        }
        list.push(doc)
        return Promise.resolve({ _id: doc._id })
      },
      doc: function (id) {
        return {
          get: function () {
            var list = getCollection(name)
            if (options.failDocGetFor === name) return Promise.reject(new Error('doc get failed: ' + name))
            var found = list.filter(function (item) { return item._id === id })[0]
            if (!found) {
              var error = new Error('document does not exist')
              error.errCode = -502004
              return Promise.reject(error)
            }
            return Promise.resolve({ data: Object.assign({}, found) })
          },
          remove: function () {
            stats.removes += 1
            var list = getCollection(name)
            var index = -1
            for (var i = 0; i < list.length; i += 1) {
              if (list[i]._id === id) { index = i; break }
            }
            if (index < 0) return Promise.reject(new Error('document does not exist'))
            list.splice(index, 1)
            return Promise.resolve({ stats: { removed: 1 } })
          }
        }
      },
      where: function (cond) {
        return {
          count: function () {
            var list = getCollection(name)
            return Promise.resolve({
              total: list.filter(function (doc) { return matches(doc, cond) }).length
            })
          }
        }
      }
    }
  }

  var db = {
    collection: function (name) {
      return makeCollection(name)
    }
  }

  function uploadFile(params) {
    stats.uploads += 1
    if (options.failUpload) return Promise.reject(new Error('upload failed'))
    var fileID = 'cloud://mock-env/' + params.cloudPath
    files[fileID] = Buffer.from(params.fileContent)
    return Promise.resolve({ fileID: fileID })
  }

  function getTempFileURL(params) {
    stats.tempUrls += 1
    return Promise.resolve({
      fileList: (params.fileList || []).map(function (fileID) {
        if (files[fileID]) {
          return { fileID: fileID, tempFileURL: 'https://mock.example.com/' + encodeURIComponent(fileID), status: 0 }
        }
        return { fileID: fileID, tempFileURL: '', status: -1, errMsg: 'storage file not exist' }
      })
    })
  }

  function downloadFile(params) {
    stats.downloads += 1
    if (!files[params.fileID]) return Promise.reject(new Error('download failed: file not exist'))
    return Promise.resolve({ fileContent: Buffer.from(files[params.fileID]) })
  }

  function deleteFile(params) {
    stats.deletes += 1
    if (options.failDeleteEvery) return Promise.reject(new Error('deleteFile failed'))
    return Promise.resolve({
      fileList: (params.fileList || []).map(function (fileID) {
        if (options.failDeleteFor === fileID) {
          return { fileID: fileID, status: -1, errMsg: 'delete failed' }
        }
        var existed = !!files[fileID]
        delete files[fileID]
        return { fileID: fileID, status: existed ? 0 : -1, errMsg: existed ? '' : 'file not exist' }
      })
    })
  }

  return {
    database: function () { return db },
    uploadFile: uploadFile,
    getTempFileURL: getTempFileURL,
    downloadFile: downloadFile,
    deleteFile: deleteFile,
    __stats: stats,
    __collections: collections,
    __files: files
  }
}

function makeOptions(overrides) {
  var clock = makeClock()
  var fake = (overrides && overrides.cloud) || createFakeCloud((overrides && overrides.cloudOptions) || {})
  var options = {
    cloud: fake,
    env: { SINN_SELFTEST: '1', SINN_VENDOR: 'mock' },
    openid: OPENID,
    requestId: REQ,
    now: clock
  }
  Object.keys(overrides || {}).forEach(function (key) {
    if (key !== 'cloud' && key !== 'cloudOptions') options[key] = overrides[key]
  })
  return { options: options, fake: fake }
}

async function runWith(overrides) {
  var built = makeOptions(overrides)
  var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
  return { result: result, fake: built.fake }
}

function names(result) {
  return (result.data && result.data.items ? result.data.items : []).map(function (item) { return item.name })
}

describe('sinn-task selftest（task-28）', function () {
  test('门禁关闭：未设置 SINN_SELFTEST 时拒绝且不执行任何读写', async function () {
    var built = makeOptions({ env: { SINN_VENDOR: 'mock' } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(1004)
    expect(result.error.name).toBe('E_FORBIDDEN')
    expect(result.error.httpStatus).toBe(403)
    expect(built.fake.__stats.adds).toBe(0)
    expect(built.fake.__stats.uploads).toBe(0)
    expect(built.fake.__stats.removes).toBe(0)
  })

  test('门禁关闭：SINN_SELFTEST=0 同样拒绝', async function () {
    var built = makeOptions({ env: { SINN_SELFTEST: '0' } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(false)
    expect(result.error.httpStatus).toBe(403)
    expect(built.fake.__stats.adds).toBe(0)
  })

  test('全部通过：5 集合 + 存储 + config + quota 逐项 ok，allPassed=true，无残留', async function () {
    var built = makeOptions({
      cloudOptions: {
        configDoc: { _id: 'env', dailyLimitNormal: 1 },
        userDoc: { _id: OPENID, dayKey: util.beijingDayKey(FIXED_NOW), usedToday: 2, dailyLimit: 10, vip: true }
      }
    })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.requestId).toBe(REQ)
    expect(typeof result.serverTime).toBe('number')
    expect(result.data.allPassed).toBe(true)
    expect(result.data.cleanup).toEqual({ ok: true, leftover: [] })
    expect(result.data.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.data.env).toEqual({ vendor: 'mock', dbPrefix: '' })
    expect(names(result)).toEqual(expect.arrayContaining([
      'sinn_users', 'sinn_tasks', 'sinn_assets', 'sinn_consents', 'sinn_config',
      'storage:upload', 'storage:download', 'storage:delete', 'config', 'quota'
    ]))
    result.data.items.forEach(function (item) {
      expect(typeof item.name).toBe('string')
      expect(typeof item.ok).toBe('boolean')
      expect(typeof item.detail).toBe('string')
      expect(typeof item.ms).toBe('number')
    })
    // 5 个集合无 __selftest__ 残留
    selftest.COLLECTIONS.forEach(function (name) {
      var list = built.fake.__collections[name] || []
      expect(list.filter(function (doc) { return doc.__selftest__ === true }).length).toBe(0)
    })
    expect(Object.keys(built.fake.__files).length).toBe(0)
  })

  test('config 文档缺失：记 optional 且不影响 allPassed', async function () {
    var built = makeOptions({ cloudOptions: {} })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(true)
    var configItem = result.data.items.filter(function (item) { return item.name === 'config' })[0]
    expect(configItem.ok).toBe(false)
    expect(configItem.optional).toBe(true)
    expect(result.data.allPassed).toBe(true)
  })

  test('config 文档存在：ok 且不带 optional', async function () {
    var built = makeOptions({ cloudOptions: { configDoc: { _id: 'env', dailyLimitNormal: 1, vendorProvider: 'mock' } } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    var configItem = result.data.items.filter(function (item) { return item.name === 'config' })[0]
    expect(configItem.ok).toBe(true)
    expect(configItem.optional).toBeUndefined()
    expect(configItem.detail).toContain('_id=env')
    expect(configItem.detail).toContain('vendorProvider')
  })

  test('单个集合失败：该项 ok=false，其它项继续，allPassed=false', async function () {
    var built = makeOptions({ cloudOptions: { failAddFor: 'sinn_assets' } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(true)
    var failedItem = result.data.items.filter(function (item) { return item.name === 'sinn_assets' })[0]
    expect(failedItem.ok).toBe(false)
    expect(failedItem.detail).toContain('add failed')
    expect(result.data.allPassed).toBe(false)
    // 其它集合仍执行
    var okNames = result.data.items.filter(function (item) { return item.ok }).map(function (item) { return item.name })
    expect(okNames).toEqual(expect.arrayContaining(['sinn_users', 'sinn_tasks', 'sinn_consents', 'sinn_config']))
  })

  test('集合读到一半失败：finally 清理已创建的文档，cleanup.ok=true', async function () {
    var built = makeOptions({ cloudOptions: { failDocGetFor: 'sinn_tasks' } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(true)
    var failedItem = result.data.items.filter(function (item) { return item.name === 'sinn_tasks' })[0]
    expect(failedItem.ok).toBe(false)
    expect(result.data.cleanup.ok).toBe(true)
    expect(result.data.cleanup.leftover).toEqual([])
    var tasks = built.fake.__collections.sinn_tasks || []
    expect(tasks.length).toBe(0)
  })

  test('存储删除失败：cleanup 报告 leftover，allPassed=false', async function () {
    var built = makeOptions({ cloudOptions: { failDeleteEvery: true } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(true)
    var deleteItem = result.data.items.filter(function (item) { return item.name === 'storage:delete' })[0]
    expect(deleteItem.ok).toBe(false)
    expect(result.data.allPassed).toBe(false)
    expect(result.data.cleanup.ok).toBe(false)
    expect(result.data.cleanup.leftover.length).toBe(1)
    expect(result.data.cleanup.leftover[0]).toContain('file:cloud://mock-env/sinn/selftest/')
  })

  test('quota 只读：报告 dayKey/limit/used 且不扣额度', async function () {
    var dayKey = util.beijingDayKey(FIXED_NOW)
    var built = makeOptions({ cloudOptions: { userDoc: { _id: OPENID, dayKey: dayKey, usedToday: 3, dailyLimit: 7, vip: false } } })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    var quotaItem = result.data.items.filter(function (item) { return item.name === 'quota' })[0]
    expect(quotaItem.ok).toBe(true)
    expect(quotaItem.detail).toContain('dayKey=' + dayKey)
    expect(quotaItem.detail).toContain('limit=7')
    expect(quotaItem.detail).toContain('used=3')
    expect(quotaItem.detail).toContain('只读')
    var users = built.fake.__collections.sinn_users || []
    var userDoc = users.filter(function (doc) { return doc._id === OPENID })[0]
    expect(userDoc.usedToday).toBe(3)
  })

  test('无 openid 时返回统一错误包裹（403 语义）', async function () {
    var built = makeOptions({ openid: '' })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    expect(result.ok).toBe(false)
    expect(result.error.httpStatus).toBe(403)
    expect(built.fake.__stats.adds).toBe(0)
  })

  test('不泄漏密钥：env 中的 AK/SK 不出现在响应 JSON 中', async function () {
    var built = makeOptions({
      env: { SINN_SELFTEST: '1', SINN_VENDOR: 'volcengine', SINN_VOLC_AK: 'AK_SENTINEL_123', SINN_VOLC_SK: 'SK_SENTINEL_456' },
      cloudOptions: { configDoc: { _id: 'env' } }
    })
    var result = await selftest.handleSelftest({ action: 'selftest' }, built.options)
    var serialized = JSON.stringify(result)
    expect(serialized).not.toContain('AK_SENTINEL_123')
    expect(serialized).not.toContain('SK_SENTINEL_456')
    expect(result.data.env).toEqual({ vendor: 'volcengine', dbPrefix: '' })
  })

  test('event 缺失/异常参数不崩溃（门禁开放时正常执行）', async function () {
    var built = makeOptions({ cloudOptions: { configDoc: { _id: 'env' } } })
    var result = await selftest.handleSelftest(null, built.options)
    expect(result.ok).toBe(true)
    expect(result.data.allPassed).toBe(true)
  })

  test('token gate 放行：无 SINN_SELFTEST 时 event.gate 正确即可执行', async function () {
    var built = makeOptions({ env: {}, cloudOptions: { configDoc: { _id: 'env' } } })
    var result = await selftest.handleSelftest(
      { action: 'selftest', gate: selftest.GATE_TOKEN },
      built.options
    )
    expect(result.ok).toBe(true)
    expect(result.data.allPassed).toBe(true)
    expect(built.fake.__stats.adds).toBeGreaterThan(0)
  })

  test('token gate 错误：无环境变量时拒绝且零读写', async function () {
    var built = makeOptions({ env: {} })
    var result = await selftest.handleSelftest(
      { action: 'selftest', gate: 'sinn-selftest-wrong' },
      built.options
    )
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(1004)
    expect(result.error.httpStatus).toBe(403)
    expect(built.fake.__stats.adds).toBe(0)
    expect(built.fake.__stats.uploads).toBe(0)
  })
})
