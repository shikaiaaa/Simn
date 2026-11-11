/**
 * lib/bootstrap.js —— sinn-task 受保护的 bootstrap action（task-29）。
 *
 * 用途：在云开发控制台 / automator 里调用 {"action":"bootstrap","names":["sinn_users"]}，
 * 由云函数自行创建缺失的数据库集合（wx-server-sdk 2.6.3 支持 db.createCollection，
 * 但**无 createIndex**，索引仍需控制台或后续方案）。
 *
 * 安全门（与 selftest 共用 lib/debug-gate.js）：
 *   - env.SINN_SELFTEST === '1'，或 event.gate === 'sinn-selftest-2026-11-10'；
 *   - 关闭时返回 E_FORBIDDEN(1004)/httpStatus 403，且零 DB 读写。
 *
 * 用法要点：
 *   - event.names 缺省为 5 个标准集合；也可只传 1 个集合名（3s 超时下建议逐个建）；
 *   - 只允许白名单集合名，防止被用来创建任意集合；
 *   - 集合已存在识别为 status:'exists'（matches exist/already/已存在），其他错误
 *     status:'error' 且不中断后续集合；返回 {results, allCreatedOrExists}。
 *
 * ⚠️ demo 调试入口：上线前必须连同 bootstrap/selftest action 一起移除，
 * 并登记到 SPEC §G 人工卡点 / 上线差异清单。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')
var debugGate = require('./debug-gate')

var DEFAULT_COLLECTIONS = ['sinn_users', 'sinn_tasks', 'sinn_assets', 'sinn_consents', 'sinn_config']
var MAX_NAMES = DEFAULT_COLLECTIONS.length
var NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
var EXIST_PATTERN = /already|exist|已存在|已经存在|duplicate/i
var MAX_DETAIL = 200

function truncate(value) {
  var text = value === undefined || value === null ? '' : String(value)
  if (text.length > MAX_DETAIL) return text.slice(0, MAX_DETAIL) + '…'
  return text
}

function errorText(error) {
  if (!error) return 'unknown error'
  var parts = []
  ;['errCode', 'code', 'errMsg', 'message'].forEach(function (key) {
    if (error[key] !== undefined && error[key] !== null && String(error[key]) !== '') {
      parts.push(String(error[key]))
    }
  })
  return truncate(parts.length ? parts.join(' ') : String(error))
}

function errorCode(error) {
  if (!error) return undefined
  if (error.errCode !== undefined) return error.errCode
  if (error.code !== undefined) return error.code
  return undefined
}

/** 集合已存在（按真实返回校准：message 关键字 + errCode 含 EXIST）。 */
function isExistsError(error) {
  var text = errorText(error)
  if (EXIST_PATTERN.test(text)) return true
  var code = errorCode(error)
  if (code !== undefined && code !== null && /EXIST/i.test(String(code))) return true
  return false
}

/** 校验 event.names；返回去空格后的集合名数组（缺省 5 个标准集合）。 */
function normalizeNames(input) {
  if (input === undefined || input === null) return DEFAULT_COLLECTIONS.slice()

  var list
  if (typeof input === 'string') {
    list = [input]
  } else if (Array.isArray(input)) {
    list = input.slice()
  } else {
    throw errors.fail(1001, { field: 'names', hint: 'names 必须是集合名字符串或字符串数组' })
  }

  if (list.length === 0) throw errors.fail(1001, { field: 'names', hint: 'names 不能为空数组' })
  if (list.length > MAX_NAMES) {
    throw errors.fail(1001, { field: 'names', hint: '一次最多处理 ' + MAX_NAMES + ' 个集合（建议逐个传，避免 3s 超时）' })
  }

  var seen = {}
  var names = []
  for (var i = 0; i < list.length; i += 1) {
    var raw = list[i]
    if (typeof raw !== 'string') throw errors.fail(1001, { field: 'names[' + i + ']', hint: '集合名必须是字符串' })
    var name = raw.trim()
    if (!name) throw errors.fail(1001, { field: 'names[' + i + ']', hint: '集合名不能为空' })
    if (!NAME_PATTERN.test(name)) {
      throw errors.fail(1001, { field: 'names[' + i + ']', hint: '集合名必须是 1–64 位小写字母/数字/下划线且以字母开头：' + name })
    }
    if (DEFAULT_COLLECTIONS.indexOf(name) < 0) {
      throw errors.fail(1001, { field: 'names[' + i + ']', hint: '不允许创建白名单外的集合：' + name })
    }
    if (seen[name]) throw errors.fail(1001, { field: 'names[' + i + ']', hint: '重复的集合名：' + name })
    seen[name] = true
    names.push(name)
  }
  return names
}

/** 逐个创建集合：已存在→exists，其他错误→error，均不中断后续。 */
async function ensureCollections(db, names) {
  var results = []
  for (var i = 0; i < names.length; i += 1) {
    var name = names[i]
    try {
      await db.createCollection(name)
      results.push({ name: name, status: 'created' })
    } catch (error) {
      var code = errorCode(error)
      var message = errorText(error)
      var entry = { name: name, status: isExistsError(error) ? 'exists' : 'error' }
      if (code !== undefined) entry.code = code
      if (message) entry.message = message
      results.push(entry)
    }
  }
  var allCreatedOrExists = results.every(function (item) {
    return item.status === 'created' || item.status === 'exists'
  })
  return { results: results, allCreatedOrExists: allCreatedOrExists }
}

function envelopeFail(error, requestId, now, data) {
  var appError = errors.normalizeError(error)
  var payload = {
    code: appError.code,
    name: appError.name,
    message: appError.message,
    hint: appError.hint,
    httpStatus: appError.httpStatus
  }
  if (appError.detail) payload.detail = appError.detail
  var envelope = { ok: false, data: data || null, error: payload, requestId: requestId, serverTime: now() }
  return envelope
}

function createBootstrapRunner(options) {
  options = options || {}
  var db = options.db
  var env = options.env || {}
  var event = options.event || null
  var now = options.now || function () { return Date.now() }
  var requestId = options.requestId || util.newRequestId()

  async function run() {
    var started = now()
    try {
      debugGate.assertDebugActionEnabled(event, env, 'bootstrap')
      var names = normalizeNames(event && event.names)
      if (!db || typeof db.createCollection !== 'function') {
        throw errors.fail(9000, { hint: 'bootstrap 缺少 db.createCollection 依赖（请通过 wx-server-sdk 注入）' })
      }
      var outcome = await ensureCollections(db, names)
      return {
        ok: true,
        data: {
          requestId: requestId,
          names: names,
          results: outcome.results,
          allCreatedOrExists: outcome.allCreatedOrExists,
          elapsedMs: Math.max(0, now() - started)
        },
        error: null,
        requestId: requestId,
        serverTime: now()
      }
    } catch (error) {
      return envelopeFail(error, requestId, now)
    }
  }

  return { run: run, requestId: requestId }
}

function handleBootstrap(event, options) {
  var merged = Object.assign({}, options || {}, { event: event || null })
  return createBootstrapRunner(merged).run()
}

module.exports = {
  DEFAULT_COLLECTIONS: DEFAULT_COLLECTIONS,
  MAX_NAMES: MAX_NAMES,
  normalizeNames: normalizeNames,
  isExistsError: isExistsError,
  ensureCollections: ensureCollections,
  createBootstrapRunner: createBootstrapRunner,
  handleBootstrap: handleBootstrap
}
