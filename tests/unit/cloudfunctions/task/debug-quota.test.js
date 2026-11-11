'use strict'

/**
 * task-40：quotaReset 调试动作单测（离线，不依赖 wx-server-sdk / 真实云）。
 *
 * 覆盖：门禁关闭/错误 token 零读写、gate token 放行、SINN_SELFTEST 放行、
 * 只改调用者文档、before→after 口径、VIP 限额保留、缺失用户分支、
 * 错误透传（getUser/saveUser）、缺 openid、未知 action、完整 openid/密钥不泄漏。
 */

var debugQuota = require('../../../../cloudfunctions/sinn-task/lib/debug-quota')
var debugGate = require('../../../../cloudfunctions/sinn-task/lib/debug-gate')

var CALLER = 'o_caller_openid_1234567890' // 末 6 位 567890
var OTHER = 'o_other_openid_0987654321' // 末 6 位 543210
var GATE = debugGate.GATE_TOKEN
// 2026-11-11 00:20 +08 = 2026-11-10T16:20:00Z
var NOW_MS = Date.UTC(2026, 10, 10, 16, 20, 0)
var TODAY = '2026-11-11'
var YESTERDAY = '2026-11-10'
var REQ_ID = 'req-quota-test'

function makeUser(openid, overrides) {
  return Object.assign({
    _id: openid,
    openid: openid,
    dayKey: YESTERDAY,
    usedToday: 1,
    dailyLimit: 1,
    vip: false,
    activeTaskId: null,
    consentVersion: '2026-11-09-v1'
  }, overrides || {})
}

function makeStore(users, options) {
  var opts = options || {}
  var state = {}
  Object.keys(users || {}).forEach(function (openid) {
    state[openid] = Object.assign({}, users[openid])
  })
  var calls = { getUser: [], saveUser: [] }
  return {
    state: state,
    calls: calls,
    getUser: async function (openid) {
      calls.getUser.push(openid)
      if (opts.failGet) throw new Error('db get failed (mock)')
      return state[openid] ? Object.assign({}, state[openid]) : null
    },
    saveUser: async function (user) {
      calls.saveUser.push(Object.assign({}, user))
      if (opts.failSave) throw new Error('disk full (mock)')
      state[user.openid] = Object.assign({}, user)
      return user
    }
  }
}

function makeHandler(overrides) {
  var options = Object.assign({
    store: makeStore({ [CALLER]: makeUser(CALLER) }),
    env: {},
    now: function () { return NOW_MS },
    openid: CALLER,
    requestId: REQ_ID
  }, overrides || {})
  return { handler: debugQuota.createQuotaDebugHandler(options), options: options }
}

describe('debug-quota：门禁', function () {
  test('门禁关闭：1004/403，且零数据库读写', async function () {
    var built = makeHandler({ env: {} })
    var res = await built.handler.handle({ action: 'quotaReset' })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1004)
    expect(res.error.name).toBe('E_FORBIDDEN')
    expect(res.error.httpStatus).toBe(403)
    expect(res.requestId).toBe(REQ_ID)
    expect(built.options.store.calls.getUser.length).toBe(0)
    expect(built.options.store.calls.saveUser.length).toBe(0)
  })

  test('错误 gate token：1004/403，且零读写', async function () {
    var built = makeHandler({ env: {} })
    var res = await built.handler.handle({ action: 'quotaReset', gate: 'wrong-token' })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1004)
    expect(built.options.store.calls.getUser.length).toBe(0)
    expect(built.options.store.calls.saveUser.length).toBe(0)
  })
})

describe('debug-quota：quotaReset 语义', function () {
  test('gate token 放行：before used=1 → after used=0，dayKey=北京今天，保留 limit/vip', async function () {
    var built = makeHandler({ env: {} })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(true)
    expect(res.data.action).toBe('quotaReset')
    expect(res.data.reset).toBe(true)
    expect(res.data.reason).toBe(null)
    expect(res.data.openidTail).toBe('567890')
    expect(res.data.dayKey).toBe(TODAY)
    expect(res.data.now).toBe(NOW_MS)
    expect(res.data.before).toEqual({ dayKey: YESTERDAY, used: 1, limit: 1, remaining: 0, vip: false })
    expect(res.data.after).toEqual({ dayKey: TODAY, used: 0, limit: 1, remaining: 1, vip: false })

    expect(built.options.store.calls.getUser).toEqual([CALLER])
    expect(built.options.store.calls.saveUser.length).toBe(1)
    var saved = built.options.store.calls.saveUser[0]
    expect(saved.openid).toBe(CALLER)
    expect(saved.dayKey).toBe(TODAY)
    expect(saved.usedToday).toBe(0)
    expect(saved.dailyLimit).toBe(1)
    expect(saved.activeTaskId).toBe(null) // 其它字段保留
    expect(built.options.store.state[CALLER].usedToday).toBe(0)
  })

  test('SINN_SELFTEST=1 同样放行并重置', async function () {
    var built = makeHandler({ env: { SINN_SELFTEST: '1' } })
    var res = await built.handler.handle({ action: 'quotaReset' })
    expect(res.ok).toBe(true)
    expect(res.data.reset).toBe(true)
    expect(res.data.after.used).toBe(0)
  })

  test('VIP 用户：limit=10 保留、vip=true、used 7 → 0、remaining 10', async function () {
    var store = makeStore({
      [CALLER]: makeUser(CALLER, { usedToday: 7, dailyLimit: 10, vip: true })
    })
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(true)
    expect(res.data.before).toEqual({ dayKey: YESTERDAY, used: 7, limit: 10, remaining: 3, vip: true })
    expect(res.data.after).toEqual({ dayKey: TODAY, used: 0, limit: 10, remaining: 10, vip: true })
    expect(store.state[CALLER].vip).toBe(true)
    expect(store.state[CALLER].dailyLimit).toBe(10)
  })

  test('只改调用者文档：other 用户额度不变，且只读写调用者', async function () {
    var store = makeStore({
      [CALLER]: makeUser(CALLER),
      [OTHER]: makeUser(OTHER, { usedToday: 3, dailyLimit: 10 })
    })
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(true)
    expect(store.state[OTHER].usedToday).toBe(3)
    expect(store.state[OTHER].dayKey).toBe(YESTERDAY)
    expect(store.calls.getUser).toEqual([CALLER])
    expect(store.calls.saveUser.length).toBe(1)
    expect(store.calls.saveUser[0].openid).toBe(CALLER)
    expect(JSON.stringify(res)).not.toContain(OTHER)
  })

  test('用户文档不存在：reset=false、reason=user_missing、不创建文档', async function () {
    var store = makeStore({})
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(true)
    expect(res.data.reset).toBe(false)
    expect(res.data.reason).toBe('user_missing')
    expect(res.data.before).toBe(null)
    expect(res.data.after).toBe(null)
    expect(res.data.openidTail).toBe('567890')
    expect(store.calls.saveUser.length).toBe(0)
    expect(store.calls.getUser).toEqual([CALLER])
  })

  test('用户存在但无额度字段：before 归零口径，重置后补 dayKey/used=0', async function () {
    var store = makeStore({ [CALLER]: { _id: CALLER, openid: CALLER } })
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(true)
    expect(res.data.before).toEqual({ dayKey: null, used: 0, limit: 0, remaining: 0, vip: false })
    expect(res.data.after).toEqual({ dayKey: TODAY, used: 0, limit: 0, remaining: 0, vip: false })
    expect(store.state[CALLER].dayKey).toBe(TODAY)
    expect(store.state[CALLER].usedToday).toBe(0)
  })

  test('重复调用幂等：第二次 before.used=0，仍 reset=true', async function () {
    var built = makeHandler({ env: {} })
    await built.handler.handle({ action: 'quotaReset', gate: GATE })
    var second = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(second.ok).toBe(true)
    expect(second.data.before.used).toBe(0)
    expect(second.data.after.used).toBe(0)
    expect(built.options.store.calls.saveUser.length).toBe(2)
  })
})

describe('debug-quota：错误与安全', function () {
  test('saveUser 失败：9000，hint 带原始错误原文', async function () {
    var store = makeStore({ [CALLER]: makeUser(CALLER) }, { failSave: true })
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(9000)
    expect(res.error.httpStatus).toBe(500)
    expect(res.error.hint).toContain('原始错误：')
    expect(res.error.hint).toContain('disk full (mock)')
    expect(store.calls.saveUser.length).toBe(1)
  })

  test('getUser 失败：9000，hint 带原始错误原文', async function () {
    var store = makeStore({ [CALLER]: makeUser(CALLER) }, { failGet: true })
    var built = makeHandler({ store: store })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(9000)
    expect(res.error.hint).toContain('db get failed (mock)')
    expect(store.calls.saveUser.length).toBe(0)
  })

  test('缺少调用者 openid：1004/403，且零数据库读写', async function () {
    var built = makeHandler({ openid: null })
    var res = await built.handler.handle({ action: 'quotaReset', gate: GATE })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1004)
    expect(res.error.httpStatus).toBe(403)
    expect(built.options.store.calls.getUser.length).toBe(0)
    expect(built.options.store.calls.saveUser.length).toBe(0)
  })

  test('未知 action（如 cleanupCheck）：1001，零数据库读写（与其他 debug action 不冲突）', async function () {
    var built = makeHandler({ env: {} })
    var res = await built.handler.handle({ action: 'cleanupCheck', gate: GATE })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1001)
    expect(built.options.store.calls.getUser.length).toBe(0)
    expect(built.options.store.calls.saveUser.length).toBe(0)
  })

  test('不泄漏完整 openid 与密钥：只回 openidTail，env 中的 AK/SK 不出现在响应', async function () {
    var built = makeHandler({
      env: { SINN_SELFTEST: '1', SINN_VOLC_AK: 'AK-SECRET-VALUE', SINN_VOLC_SK: 'SK-SECRET-VALUE' }
    })
    var res = await built.handler.handle({ action: 'quotaReset' })
    expect(res.ok).toBe(true)
    var text = JSON.stringify(res)
    expect(text).not.toContain(CALLER)
    expect(text).toContain('567890')
    expect(text).not.toContain('AK-SECRET-VALUE')
    expect(text).not.toContain('SK-SECRET-VALUE')
  })
})
