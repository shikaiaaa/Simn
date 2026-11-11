/**
 * DEV-0001-04：sinn-account 单测（SPEC §B.2 API-1..4 / §3 / §4 / §B.3）。
 * 覆盖：profile 额度视图、跨天惰性重置、VIP 白名单、同意审计字段、撤回同意、删除全部、幂等、无墓碑。
 */
'use strict'

var fx = require('./fixtures')
var util = require('../../../../cloudfunctions/sinn-task/lib/util')

function expectOk(res) {
  expect(res.ok).toBe(true)
  expect(res.error).toBeNull()
  expect(res.requestId).toBe('req-test')
  expect(typeof res.serverTime).toBe('number')
  return res.data
}

describe('DEV-0001-04 sinn-account', function () {
  test('profile：未同意/无数据时返回默认额度，读接口不要求同意', async function () {
    var ctx = fx.makeContext()
    var data = expectOk(await ctx.call('profile'))
    expect(data.consent).toBeNull()
    expect(data.activeTaskId).toBeNull()
    expect(data.hasData).toBe(false)
    expect(data.quota).toMatchObject({ used: 0, limit: 1, remaining: 1, vip: false })
    expect(data.quota.dayKey).toBe(util.beijingDayKey(ctx.clock.now()))
    expect(typeof data.quota.resetAt).toBe('number')
  })

  test('profile：有同意与进行中任务时返回 consent/activeTaskId/hasData', async function () {
    var ctx = fx.makeContext()
    await fx.seedConsentUser(ctx.store, fx.USER)
    var task = await fx.seedTask(ctx.store, { status: 'QUEUED' })
    var data = expectOk(await ctx.call('profile'))
    expect(data.consent.version).toBe(fx.CONSENT_VERSION)
    expect(data.consent.agreedAt).toBe(1762699000000)
    expect(data.activeTaskId).toBe(task.taskId)
    expect(data.hasData).toBe(true)
  })

  test('额度跨天惰性重置（Asia/Shanghai 00:00）', async function () {
    var clock = fx.makeClock(Date.UTC(2026, 10, 9, 16, 0, 0)) // 北京时间 2026-11-10 00:00
    var ctx = fx.makeContext({ clock: clock })
    await fx.seedConsentUser(ctx.store, fx.USER, { dayKey: '2026-11-09', usedToday: 1 })
    var data = expectOk(await ctx.call('profile'))
    expect(data.quota.dayKey).toBe('2026-11-10')
    expect(data.quota.used).toBe(0)
    expect(data.quota.remaining).toBe(1)
  })

  test('VIP 白名单：额度 10', async function () {
    var ctx = fx.makeContext({ config: { vipWhitelist: [fx.USER] } })
    await fx.seedConsentUser(ctx.store, fx.USER)
    var data = expectOk(await ctx.call('profile'))
    expect(data.quota).toMatchObject({ limit: 10, remaining: 10, vip: true })
  })

  test('recordConsent：写入同意审计，且不含照片/围度/性别', async function () {
    var ctx = fx.makeContext()
    var data = expectOk(await ctx.call('recordConsent', { version: fx.CONSENT_VERSION, textHash: 'sha256:abc' }))
    expect(data.recordId).toMatch(/^c_[0-9a-f]{24}$/)
    expect(data.recordedAt).toBe(ctx.clock.now())

    var records = ctx.consentStore.__records()
    expect(records).toHaveLength(1)
    var record = records[0]
    expect(record.openid).toBe(fx.USER)
    expect(record.version).toBe(fx.CONSENT_VERSION)
    expect(record.textHash).toBe('sha256:abc')
    expect(record.agreedAt).toBe(ctx.clock.now())
    expect(record.ageConfirmedAt).toBe(ctx.clock.now())
    var auditText = JSON.stringify(record)
    ;['gender', 'chestCm', 'waistCm', 'hipCm', 'cloud://', 'photo'].forEach(function (key) {
      expect(auditText).not.toContain(key)
    })

    var profile = expectOk(await ctx.call('profile'))
    expect(profile.consent.version).toBe(fx.CONSENT_VERSION)
  })

  test('recordConsent：version 非法/18+ 未确认被拒', async function () {
    var ctx = fx.makeContext()
    var badVersion = await ctx.call('recordConsent', { version: '' })
    expect(badVersion.ok).toBe(false)
    expect(badVersion.error.code).toBe(1001)
    expect(ctx.consentStore.__records()).toHaveLength(0)

    var noAge = await ctx.call('recordConsent', { version: fx.CONSENT_VERSION, ageConfirmed: false })
    expect(noAge.ok).toBe(false)
    expect(noAge.error.code).toBe(1001)
    expect(ctx.consentStore.__records()).toHaveLength(0)
  })

  test('revokeConsent：无同意时 1003', async function () {
    var ctx = fx.makeContext()
    var res = await ctx.call('revokeConsent')
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1003)
  })

  test('revokeConsent：物理删除全部数据、取消进行中任务并退款、清同意、审计保留', async function () {
    var ctx = fx.makeContext()
    await fx.seedConsentUser(ctx.store, fx.USER, { usedToday: 1 })
    var task = await fx.seedTask(ctx.store, { status: 'QUEUED' })
    var asset = await fx.seedTaskAsset(ctx.store, task)
    await ctx.call('recordConsent', { version: fx.CONSENT_VERSION, textHash: 'h1' })

    var data = expectOk(await ctx.call('revokeConsent'))
    expect(data.deletedTasks).toBe(1)
    expect(data.deletedAssets).toBe(1)
    expect(data.consentRevokedAt).toBe(ctx.clock.now())
    expect(ctx.store.__countTasks()).toBe(0)
    expect(ctx.store.__countAssets()).toBe(0)
    expect(ctx.storage.__deleted()).toEqual([asset.fileID])

    var user = await ctx.store.getUser(fx.USER)
    expect(user.consentVersion).toBeNull()
    expect(user.consentAt).toBeNull()
    expect(user.ageConfirmedAt).toBeNull()
    expect(user.revokedAt).toBe(ctx.clock.now())
    expect(user.usedToday).toBe(0)
    expect(user.activeTaskId).toBeNull()
    // 同意审计 append-only，不随撤回删除
    expect(ctx.consentStore.__records()).toHaveLength(1)

    var profile = expectOk(await ctx.call('profile'))
    expect(profile.consent).toBeNull()
  })

  test('deleteAll：无同意时 1003（写接口同意前置）', async function () {
    var ctx = fx.makeContext()
    var res = await ctx.call('deleteAll')
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(1003)
  })

  test('deleteAll：物理删除全部、进行中退款一次、成功任务不退款、保留同意与额度', async function () {
    var ctx = fx.makeContext()
    await fx.seedConsentUser(ctx.store, fx.USER, { usedToday: 1 })
    var running = await fx.seedTask(ctx.store, { status: 'QUEUED' })
    var runningAsset = await fx.seedTaskAsset(ctx.store, running)
    var done = await fx.seedTask(ctx.store, {
      status: 'SUCCEEDED',
      resultFileID: 'cloud://test/result/done.png'
    })
    var doneAsset = await fx.seedTaskAsset(ctx.store, done)

    var data = expectOk(await ctx.call('deleteAll'))
    expect(data.deletedTasks).toBe(2)
    expect(data.deletedAssets).toBe(2)
    expect(typeof data.deletedAt).toBe('number')
    expect(ctx.store.__countTasks()).toBe(0)
    expect(ctx.store.__countAssets()).toBe(0)
    var deletedFiles = ctx.storage.__deleted()
    expect(deletedFiles).toContain(runningAsset.fileID)
    expect(deletedFiles).toContain(doneAsset.fileID)
    expect(deletedFiles).toContain('cloud://test/result/done.png')

    var user = await ctx.store.getUser(fx.USER)
    expect(user.usedToday).toBe(0) // 进行中任务取消退还 1
    expect(user.consentVersion).toBe(fx.CONSENT_VERSION)
    expect(user.activeTaskId).toBeNull()

    // 无墓碑：任务/资产记录物理消失
    expect(ctx.store.__snapshot().tasks).toEqual({})
    expect(ctx.store.__snapshot().assets).toEqual({})
    // 二次调用幂等
    var again = expectOk(await ctx.call('deleteAll'))
    expect(again.deletedTasks).toBe(0)
    expect(again.deletedAssets).toBe(0)
  })

  test('deleteAll：云存储删除失败时整体失败且记录保留', async function () {
    var ctx = fx.makeContext({ storageOptions: { failDelete: true } })
    await fx.seedConsentUser(ctx.store, fx.USER)
    var task = await fx.seedTask(ctx.store, { status: 'SUCCEEDED' })
    await fx.seedTaskAsset(ctx.store, task)

    var res = await ctx.call('deleteAll')
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe(9000)
    expect(ctx.store.__countTasks()).toBe(1)
    expect(ctx.store.__countAssets()).toBe(1)
    expect(await ctx.store.getConsent(fx.USER)).not.toBeNull()
  })

  test('deleteAll：跨用户隔离（只删本人数据）', async function () {
    var ctx = fx.makeContext()
    await fx.seedConsentUser(ctx.store, fx.USER)
    var mine = await fx.seedTask(ctx.store, { openid: fx.USER, status: 'SUCCEEDED' })
    await fx.seedTaskAsset(ctx.store, mine)
    var other = await fx.seedTask(ctx.store, { openid: fx.OTHER, status: 'SUCCEEDED' })
    await fx.seedTaskAsset(ctx.store, other)

    var data = expectOk(await ctx.call('deleteAll'))
    expect(data.deletedTasks).toBe(1)
    expect(data.deletedAssets).toBe(1)
    expect(ctx.store.__countTasks()).toBe(1)
    expect((await ctx.store.getTask(other.taskId)).openid).toBe(fx.OTHER)
  })

  test('未知 action / 缺 openid 的错误码', async function () {
    var ctx = fx.makeContext()
    var unknown = await ctx.call('nope')
    expect(unknown.ok).toBe(false)
    expect(unknown.error.code).toBe(1001)
    var noOpenid = await ctx.accountHandler.handle({ action: 'profile' }, {})
    expect(noOpenid.ok).toBe(false)
    expect(noOpenid.error.code).toBe(1004)
  })
})
