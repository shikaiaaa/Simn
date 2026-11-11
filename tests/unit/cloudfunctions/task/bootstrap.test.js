/**
 * tests/unit/cloudfunctions/task/bootstrap.test.js
 * task-29：sinn-task 受保护 bootstrap action（自动建集合）+ 调试门禁的离线单测。
 */
'use strict'

var bootstrap = require('../../../../cloudfunctions/sinn-task/lib/bootstrap')
var debugGate = require('../../../../cloudfunctions/sinn-task/lib/debug-gate')

var FIXED_NOW = Date.UTC(2026, 10, 10, 4, 0, 0) // 2026-11-10 12:00 Asia/Shanghai
var REQ = 'req-bootstrap-0001'

function makeClock() {
  var t = FIXED_NOW
  return function () {
    t += 3
    return t
  }
}

/**
 * fake db：createCollection 行为可按集合名配置：
 *   'exists' → reject「已存在」错误（模拟真实云端文案）；
 *   'error'  → reject 其他错误。
 * 未配置则 resolve 成功。
 */
function createFakeDb(options) {
  options = options || {}
  var calls = []
  var db = {
    createCollection: function (name) {
      calls.push(name)
      var behavior = options.behavior && options.behavior[name]
      if (behavior === 'exists') {
        var error = new Error('collection already exists: ' + name)
        error.errCode = -502005
        return Promise.reject(error)
      }
      if (behavior === 'error') {
        return Promise.reject(new Error('internal error: permission denied for ' + name))
      }
      return Promise.resolve({})
    },
    __calls: calls
  }
  return db
}

function makeOptions(overrides) {
  overrides = overrides || {}
  var db = overrides.db || createFakeDb(overrides.dbOptions || {})
  var options = {
    db: db,
    env: overrides.env === undefined ? { SINN_SELFTEST: '1' } : overrides.env,
    requestId: REQ,
    now: makeClock()
  }
  return { options: options, db: db }
}

async function runWith(event, overrides) {
  var built = makeOptions(overrides)
  var result = await bootstrap.handleBootstrap(event, built.options)
  return { result: result, db: built.db }
}

describe('sinn-task bootstrap（task-29）', function () {
  test('门禁关闭：未设置 SINN_SELFTEST 且无 gate token 时拒绝，createCollection 调用 0 次', async function () {
    var built = await runWith({ action: 'bootstrap' }, { env: {} })
    expect(built.result.ok).toBe(false)
    expect(built.result.error.code).toBe(1004)
    expect(built.result.error.name).toBe('E_FORBIDDEN')
    expect(built.result.error.httpStatus).toBe(403)
    expect(built.db.__calls.length).toBe(0)
  })

  test('gate token 放行：无环境变量时 event.gate 正确即可建集合', async function () {
    var built = await runWith(
      { action: 'bootstrap', names: ['sinn_users'], gate: debugGate.GATE_TOKEN },
      { env: {} }
    )
    expect(built.result.ok).toBe(true)
    expect(built.result.data.names).toEqual(['sinn_users'])
    expect(built.result.data.results).toEqual([{ name: 'sinn_users', status: 'created' }])
    expect(built.result.data.allCreatedOrExists).toBe(true)
    expect(built.db.__calls).toEqual(['sinn_users'])
  })

  test('gate token 错误：拒绝且零 DB 调用', async function () {
    var built = await runWith({ action: 'bootstrap', gate: 'wrong-token' }, { env: {} })
    expect(built.result.ok).toBe(false)
    expect(built.result.error.httpStatus).toBe(403)
    expect(built.db.__calls.length).toBe(0)
  })

  test('names 缺省：默认处理 5 个标准集合，全部 created', async function () {
    var built = await runWith({ action: 'bootstrap' })
    expect(built.result.ok).toBe(true)
    expect(built.db.__calls).toEqual([
      'sinn_users', 'sinn_tasks', 'sinn_assets', 'sinn_consents', 'sinn_config'
    ])
    expect(built.result.data.names).toEqual(bootstrap.DEFAULT_COLLECTIONS)
    expect(built.result.data.results.every(function (item) { return item.status === 'created' })).toBe(true)
    expect(built.result.data.allCreatedOrExists).toBe(true)
  })

  test('names 只传 1 个：只处理该集合（便于 3s 超时内逐个建）', async function () {
    var built = await runWith({ action: 'bootstrap', names: ['sinn_consents'] })
    expect(built.result.ok).toBe(true)
    expect(built.db.__calls).toEqual(['sinn_consents'])
    expect(built.result.data.results).toEqual([{ name: 'sinn_consents', status: 'created' }])
  })

  test('集合已存在：识别为 exists 且不视为失败（message 含 already exists）', async function () {
    var built = await runWith(
      { action: 'bootstrap', names: ['sinn_users', 'sinn_config'] },
      { dbOptions: { behavior: { sinn_users: 'exists' } } }
    )
    expect(built.result.ok).toBe(true)
    var users = built.result.data.results[0]
    var config = built.result.data.results[1]
    expect(users.status).toBe('exists')
    expect(String(users.message)).toContain('already exists')
    expect(config.status).toBe('created')
    expect(built.result.data.allCreatedOrExists).toBe(true)
  })

  test('部分失败不中断后续：前一个 error、后一个继续创建，allCreatedOrExists=false', async function () {
    var built = await runWith(
      { action: 'bootstrap', names: ['sinn_users', 'sinn_tasks'] },
      { dbOptions: { behavior: { sinn_users: 'error' } } }
    )
    expect(built.result.ok).toBe(true)
    expect(built.result.data.results[0].status).toBe('error')
    expect(String(built.result.data.results[0].message)).toContain('internal error')
    expect(built.result.data.results[1]).toEqual({ name: 'sinn_tasks', status: 'created' })
    expect(built.result.data.allCreatedOrExists).toBe(false)
    expect(built.db.__calls).toEqual(['sinn_users', 'sinn_tasks'])
  })

  test('非法 names 返回 1001 且零 DB 调用', async function () {
    var cases = [
      { names: 'sinn_not_allowed' },
      { names: [] },
      { names: { name: 'sinn_users' } },
      { names: ['sinn_users', 'sinn_users'] },
      { names: ['sinn_users', 'sinn_tasks', 'sinn_assets', 'sinn_consents', 'sinn_config', 'sinn_users'] },
      { names: ['Sinn_Users'] }
    ]
    for (var i = 0; i < cases.length; i += 1) {
      var built = await runWith({ action: 'bootstrap', names: cases[i].names })
      expect(built.result.ok).toBe(false)
      expect(built.result.error.code).toBe(1001)
      expect(built.result.error.name).toBe('E_PARAM')
      expect(built.db.__calls.length).toBe(0)
    }
  })

  test('响应沿用统一包裹：ok/data/error/requestId/serverTime', async function () {
    var built = await runWith({ action: 'bootstrap', names: ['sinn_users'] })
    var result = built.result
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.requestId).toBe(REQ)
    expect(result.data.requestId).toBe(REQ)
    expect(typeof result.serverTime).toBe('number')
    expect(typeof result.data.elapsedMs).toBe('number')
    expect(result.data.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test('不泄漏密钥：env 中的 AK/SK 不出现在响应 JSON 中', async function () {
    var built = await runWith(
      { action: 'bootstrap', names: ['sinn_users'] },
      { env: { SINN_SELFTEST: '1', SINN_VOLC_AK: 'AK_SENTINEL_123', SINN_VOLC_SK: 'SK_SENTINEL_456' } }
    )
    var serialized = JSON.stringify(built.result)
    expect(serialized).not.toContain('AK_SENTINEL_123')
    expect(serialized).not.toContain('SK_SENTINEL_456')
  })
})
