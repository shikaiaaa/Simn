/**
 * lib/selftest.js —— sinn-task 受保护的自检 action（task-28）。
 *
 * 用途：在云开发控制台「云函数 → sinn-task → 测试」里传 {"action":"selftest"}，
 * 一次跑完数据库 5 集合读写删、云存储上传/链接/下载/删除、sinn_config 读取、
 * 当日额度读取，返回逐项 {name, ok, detail, ms} + allPassed + cleanup。
 *
 * 安全门（task-29 起与 bootstrap 共用 lib/debug-gate.js）：
 *   env.SINN_SELFTEST === '1'，或 event.gate === 'sinn-selftest-2026-11-10'
 *   （demo 专用 token，供 automator 在无控制台环境变量时触发）；否则返回统一
 *   错误包裹（E_FORBIDDEN，httpStatus 403），不做任何读写。
 *   ⚠️ demo 调试门禁：上线前必须连同 bootstrap/selftest action 一起移除。
 *
 * 设计：
 * - 不依赖 wx-server-sdk：db / cloud 通过 options 注入，本地单测可用 fake；
 * - 单项失败不中断整体（每项内部 try/catch），finally 统一清理 __selftest__ 文档与对象；
 * - 不打印/不返回任何密钥；env 只回显 vendor 与 dbPrefix 两个非敏感项。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var debugGate = require('./debug-gate')

var FLAG = debugGate.FLAG
var COLLECTIONS = ['sinn_users', 'sinn_tasks', 'sinn_assets', 'sinn_consents', 'sinn_config']
var STORAGE_PREFIX = 'sinn/selftest/'
var MAX_DETAIL = 200

function truncate(value) {
  var text = value === undefined || value === null ? '' : String(value)
  if (text.length > MAX_DETAIL) return text.slice(0, MAX_DETAIL) + '…'
  return text
}

function errorDetail(error) {
  if (!error) return 'unknown error'
  var message = error.errMsg || error.message || error.code || String(error)
  return truncate(message)
}

function createSelftestRunner(options) {
  options = options || {}
  var cloud = options.cloud
  var db = options.db || (cloud && typeof cloud.database === 'function' ? cloud.database() : null)
  var openid = options.openid || ''
  var env = options.env || {}
  var event = options.event || null
  var now = options.now || function () { return Date.now() }
  var requestId = options.requestId || util.newRequestId()

  var createdDocs = []
  var createdFiles = []
  var items = []

  function isEnabled() {
    return debugGate.isDebugActionEnabled(event, env)
  }

  async function runStep(name, fn) {
    var started = now()
    try {
      var result = await fn()
      var item = { name: name, ok: true, detail: truncate(result && result.detail), ms: Math.max(0, now() - started) }
      if (result && result.optional) item.optional = true
      items.push(item)
      return item
    } catch (error) {
      var failed = { name: name, ok: false, detail: truncate(errorDetail(error)), ms: Math.max(0, now() - started) }
      if (error && error.optional) {
        failed.optional = true
        failed.ok = false
      }
      items.push(failed)
      return failed
    }
  }

  function trackDoc(collection, id) {
    createdDocs.push({ collection: collection, id: id })
  }

  function untrackDoc(collection, id) {
    createdDocs = createdDocs.filter(function (entry) {
      return !(entry.collection === collection && entry.id === id)
    })
  }

  function trackFile(fileID) {
    if (fileID) createdFiles.push(fileID)
  }

  function untrackFile(fileID) {
    createdFiles = createdFiles.filter(function (id) { return id !== fileID })
  }

  async function removeTrackedDocs() {
    var leftover = []
    for (var i = 0; i < createdDocs.length; i += 1) {
      var entry = createdDocs[i]
      try {
        await db.collection(entry.collection).doc(entry.id).remove()
      } catch (error) {
        leftover.push('doc:' + entry.collection + '/' + entry.id)
      }
    }
    createdDocs = []
    return leftover
  }

  async function deleteTrackedFiles() {
    var leftover = []
    for (var i = 0; i < createdFiles.length; i += 1) {
      var fileID = createdFiles[i]
      try {
        await deleteFile(fileID)
      } catch (error) {
        leftover.push('file:' + fileID)
      }
    }
    createdFiles = []
    return leftover
  }

  function deleteFile(fileID) {
    return cloud.deleteFile({ fileList: [fileID] }).then(function (res) {
      var list = (res && res.fileList) || []
      var entry = list[0]
      if (!entry || (typeof entry.status === 'number' && entry.status !== 0)) {
        throw new Error('deleteFile 未成功：' + (entry && entry.errMsg ? entry.errMsg : 'unknown'))
      }
      return res
    })
  }

  function tempFileInfo(fileID) {
    return cloud.getTempFileURL({ fileList: [fileID] }).then(function (res) {
      var list = (res && res.fileList) || []
      return list[0] || null
    })
  }

  async function checkCollection(name) {
    var id = '__selftest__' + requestId + '_' + name
    var doc = {
      _id: id,
      __selftest__: true,
      requestId: requestId,
      openid: openid,
      collection: name,
      createdAt: now()
    }
    await db.collection(name).add({ data: doc })
    trackDoc(name, id)
    var got = await db.collection(name).doc(id).get()
    if (!got || !got.data || got.data._id !== id) throw new Error('读回失败：_id 不一致')
    var hit = await db.collection(name).where({ __selftest__: true, requestId: requestId }).count()
    if (!hit || hit.total !== 1) throw new Error('where 查询命中数=' + (hit && hit.total))
    var removed = await db.collection(name).doc(id).remove()
    var removedCount = removed && removed.stats ? Number(removed.stats.removed) : NaN
    if (!removed || (isFinite(removedCount) && removedCount <= 0)) throw new Error('remove 未删除记录')
    untrackDoc(name, id)
    var after = await db.collection(name).where({ __selftest__: true, requestId: requestId }).count()
    if (!after || after.total !== 0) throw new Error('删除后仍有 ' + (after && after.total) + ' 条残留')
    return { detail: '写入/读回/where=1/删除/where=0 全部通过' }
  }

  async function checkStorage() {
    var fileID = null
    var body = 'sinn-selftest ' + requestId
    var cloudPath = STORAGE_PREFIX + requestId + '.txt'

    await runStep('storage:upload', async function () {
      var res = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: Buffer.from(body, 'utf8') })
      fileID = res && res.fileID
      if (!fileID) throw new Error('uploadFile 未返回 fileID')
      trackFile(fileID)
      return { detail: 'cloudPath=' + cloudPath }
    })

    if (fileID) {
      await runStep('storage:download', async function () {
        var info = await tempFileInfo(fileID)
        if (!info || !info.tempFileURL) throw new Error('getTempFileURL 未返回链接')
        var downloaded = await cloud.downloadFile({ fileID: fileID })
        var content = downloaded && downloaded.fileContent
        var text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
        if (text !== body) throw new Error('下载内容与写入不一致')
        return { detail: 'getTempFileURL + downloadFile 内容一致' }
      })
    } else {
      items.push({ name: 'storage:download', ok: false, detail: 'upload 失败，跳过', ms: 0 })
    }

    if (fileID) {
      await runStep('storage:delete', async function () {
        await deleteFile(fileID)
        untrackFile(fileID)
        var still = null
        try {
          still = await tempFileInfo(fileID)
        } catch (error) {
          still = null
        }
        if (still && still.tempFileURL && (still.status === undefined || still.status === 0)) {
          // 云存储删除后 getTempFileURL 仍可能返回旧 URL，再尝试下载确认不可用
          var unavailable = false
          try {
            await cloud.downloadFile({ fileID: fileID })
          } catch (error) {
            unavailable = true
          }
          if (!unavailable) throw new Error('deleteFile 后仍可下载')
        }
        return { detail: 'deleteFile 成功，删除后不可下载' }
      })
    } else {
      items.push({ name: 'storage:delete', ok: false, detail: 'upload 失败，跳过', ms: 0 })
    }
  }

  async function checkConfig() {
    await runStep('config', async function () {
      var res = null
      try {
        res = await db.collection('sinn_config').doc('env').get()
      } catch (error) {
        res = null
      }
      var data = res && res.data
      if (!data) {
        var optionalError = new Error('config doc missing（可接受，代码有默认值）')
        optionalError.optional = true
        throw optionalError
      }
      var keys = Object.keys(data).filter(function (key) { return key !== '_id' })
      return { detail: '_id=env；字段=' + keys.slice(0, 12).join(',') }
    })
  }

  async function checkQuota() {
    await runStep('quota', async function () {
      var dayKey = util.beijingDayKey(now())
      var vip = false
      var limitNormal = env.SINN_DAILY_LIMIT_NORMAL ? Number(env.SINN_DAILY_LIMIT_NORMAL) : 1
      var limitVip = env.SINN_DAILY_LIMIT_VIP ? Number(env.SINN_DAILY_LIMIT_VIP) : 10
      var limit = isFinite(limitNormal) && limitNormal > 0 ? limitNormal : 1
      var used = 0
      var userFound = false
      if (openid) {
        try {
          var res = await db.collection('sinn_users').doc(openid).get()
          var user = res && res.data
          if (user) {
            userFound = true
            vip = !!user.vip
            var vipLimit = Number(user.dailyLimit)
            limit = isFinite(vipLimit) && vipLimit > 0 ? vipLimit : (vip ? (isFinite(limitVip) && limitVip > 0 ? limitVip : 10) : limit)
            if (user.dayKey === dayKey) {
              var todayUsed = Number(user.usedToday)
              used = isFinite(todayUsed) && todayUsed > 0 ? todayUsed : 0
            }
          }
        } catch (error) {
          // 用户文档不存在是正常状态（首次使用前），按默认额度展示
          userFound = false
        }
      }
      return {
        detail: 'dayKey=' + dayKey + ' limit=' + limit + ' used=' + used + ' userDoc=' + (userFound ? 'found' : 'missing') + '（只读，不扣额度）'
      }
    })
  }

  async function cleanupNow() {
    var leftover = []
    try {
      leftover = leftover.concat(await removeTrackedDocs())
    } catch (error) {
      leftover.push('cleanup:doc-error')
    }
    try {
      leftover = leftover.concat(await deleteTrackedFiles())
    } catch (error) {
      leftover.push('cleanup:file-error')
    }
    return {
      ok: leftover.length === 0,
      leftover: leftover
    }
  }

  function envelopeOk(data) {
    return { ok: true, data: data, error: null, requestId: requestId, serverTime: now() }
  }

  function envelopeFail(error) {
    var appError = errors.normalizeError(error)
    var payload = {
      code: appError.code,
      name: appError.name,
      message: appError.message,
      hint: appError.hint,
      httpStatus: appError.httpStatus
    }
    if (appError.detail) payload.detail = appError.detail
    return { ok: false, data: null, error: payload, requestId: requestId, serverTime: now() }
  }

  async function run() {
    var started = now()
    try {
      if (!isEnabled()) {
        throw errors.fail(1004, {
          httpStatus: 403,
          message: 'selftest 未启用',
          hint: 'demo 调试门禁：设置 SINN_SELFTEST=1 或传入受控 gate token 后可用；上线前必须移除该调试入口'
        })
      }
      if (!openid) throw errors.fail(1004, { httpStatus: 403, hint: '无法获取用户身份' })
      if (!db) throw errors.fail(9000, { hint: 'selftest 缺少 db 依赖（请通过 wx-server-sdk 注入）' })
      if (!cloud) throw errors.fail(9000, { hint: 'selftest 缺少 cloud 依赖（请通过 wx-server-sdk 注入）' })

      for (var i = 0; i < COLLECTIONS.length; i += 1) {
        var name = COLLECTIONS[i]
        await runStep(name, function () { return checkCollection(name) })
      }
      await checkStorage()
      await checkConfig()
      await checkQuota()
    } catch (error) {
      var failedEnvelope = envelopeFail(error)
      failedEnvelope.data = { requestId: requestId, items: items, cleanup: await cleanupNow() }
      return failedEnvelope
    }

    var cleanup = await cleanupNow()
    var allPassed = items.every(function (item) { return item.ok || item.optional === true })
    return envelopeOk({
      requestId: requestId,
      items: items,
      allPassed: allPassed,
      cleanup: cleanup,
      env: { vendor: env.SINN_VENDOR || 'mock', dbPrefix: env.SINN_DB_PREFIX || '' },
      elapsedMs: Math.max(0, now() - started)
    })
  }

  return { run: run, requestId: requestId }
}

function handleSelftest(event, options) {
  var merged = Object.assign({}, options || {}, { event: event || null })
  return createSelftestRunner(merged).run()
}

module.exports = {
  FLAG: FLAG,
  GATE_TOKEN: debugGate.GATE_TOKEN,
  COLLECTIONS: COLLECTIONS,
  isDebugActionEnabled: debugGate.isDebugActionEnabled,
  createSelftestRunner: createSelftestRunner,
  handleSelftest: handleSelftest
}
