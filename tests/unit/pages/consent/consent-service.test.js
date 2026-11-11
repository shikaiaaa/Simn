/**
 * tests/unit/pages/consent/consent-service.test.js
 * L1：合规门禁服务（DEV-0001-05）——8 项披露、两步校验、隐私授权、recordConsent、本地缓存。
 * 覆盖 AC-21 / AC-25 关键断言。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const consent = require('../../../../miniprogram/services/consent')
const api = require('../../../../miniprogram/services/api')

const STORAGE_KEY = api.STORAGE_KEYS.CONSENT

function storageMock(initial) {
  let stored = initial === undefined ? '' : initial
  const get = jest.fn(() => stored)
  const set = jest.fn((key, value) => {
    if (key === STORAGE_KEY) stored = value
  })
  const remove = jest.fn(() => {
    stored = ''
  })
  wx.__setMock('getStorageSync', get)
  wx.__setMock('setStorageSync', set)
  wx.__setMock('removeStorageSync', remove)
  return { get, set, remove, value: () => stored }
}

function privacySuccess() {
  const spy = jest.fn((options) => options.success && options.success())
  wx.__setMock('requirePrivacyAuthorize', spy)
  return spy
}

function consentServerSuccess() {
  const spy = jest.fn(() => Promise.resolve(wx.__success({ recordId: 'c_mock', recordedAt: 1 })))
  wx.__setMock('cloud.callFunction', spy)
  return spy
}

beforeEach(() => {
  wx.__reset()
})

test('同意版本与本地缓存 schema 对齐 SPEC §C', () => {
  expect(consent.CONSENT_VERSION).toBe('2026-11-09-v1')
  expect(STORAGE_KEY).toBe('sinn_consent_v1')
  expect(consent.CAPTURE_URL).toBe('/pages/capture/capture')
})

test('8 项披露齐全、顺序固定且包含性别（选填）与境外接收方', () => {
  expect(Array.isArray(consent.DISCLOSURES)).toBe(true)
  expect(consent.DISCLOSURES.length).toBe(8)
  expect(consent.DISCLOSURES.map((item) => item.label)).toEqual([
    '收集项',
    '用途',
    '保存期限',
    '境外接收方名称/所在地',
    '处理目的',
    '数据类别',
    '删除方式',
    '拒绝后果'
  ])
  consent.DISCLOSURES.forEach((item) => {
    expect(typeof item.key).toBe('string')
    expect(item.text.length).toBeGreaterThan(10)
  })
  const collected = consent.DISCLOSURES[0].text
  expect(collected).toContain('性别（选填）')
  expect(consent.DISCLOSURES[3].text).toContain('境外')
  expect(consent.GENDER_NOTE).toContain('性别')
  expect(consent.GENDER_NOTE).toContain('不影响生成与参考尺码')
  expect(consent.DRAFT_NOTICE).toContain('CP-10')
})

test('披露全文包含 8 项 label，hashText 稳定且随文本变化', () => {
  const text = consent.getConsentText()
  expect(text).toBe(consent.buildDisclosureText(consent.DISCLOSURES))
  consent.DISCLOSURES.forEach((item) => {
    expect(text).toContain(item.label)
    expect(text).toContain(item.text)
  })

  const hash = consent.hashText(text)
  expect(hash).toMatch(/^fnv1a-[0-9a-f]{8}$/)
  expect(consent.hashText(text)).toBe(hash)
  expect(consent.hashText(text + ' ')).not.toBe(hash)
  expect(consent.hashText('')).toBe('fnv1a-811c9dc5')
})

test('第一步校验：18+ 与禁止条款必须显式确认（不默认勾选）', () => {
  expect(consent.validateAgeStep({})).toEqual({ ok: false, code: 'AGE_REQUIRED', message: expect.any(String) })
  expect(consent.validateAgeStep({ ageConfirmed: true })).toEqual({
    ok: false,
    code: 'TERMS_REQUIRED',
    message: expect.any(String)
  })
  expect(consent.validateAgeStep({ ageConfirmed: false, termsAccepted: true }).code).toBe('AGE_REQUIRED')
  expect(consent.validateAgeStep({ ageConfirmed: true, termsAccepted: true })).toEqual({ ok: true })
})

test('第二步校验：隐私说明单独同意', () => {
  expect(consent.validateConsentStep({})).toEqual({ ok: false, code: 'PRIVACY_REQUIRED', message: expect.any(String) })
  expect(consent.validateConsentStep({ privacyAgreed: false }).ok).toBe(false)
  expect(consent.validateConsentStep({ privacyAgreed: true })).toEqual({ ok: true })
})

test('本地同意记录写读清 + 非法值归一化', () => {
  const store = storageMock('')
  expect(consent.readLocalConsent(wx)).toBeNull()

  const record = consent.createConsentRecord({ now: 1700000000000 })
  expect(record).toEqual({ version: '2026-11-09-v1', agreedAt: 1700000000000, ageConfirmedAt: 1700000000000 })
  expect(consent.writeLocalConsent(wx, record)).toBe(true)
  expect(store.set).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(record))
  expect(consent.readLocalConsent(wx)).toEqual(record)

  expect(consent.normalizeConsentRecord('not-json')).toBeNull()
  expect(consent.normalizeConsentRecord({ version: 'v1' })).toBeNull()
  expect(consent.normalizeConsentRecord(JSON.stringify({ version: 'v1', agreedAt: 1 }))).toEqual({
    version: 'v1',
    agreedAt: 1,
    ageConfirmedAt: 1
  })

  expect(consent.clearLocalConsent(wx)).toBe(true)
  expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY)
  expect(consent.readLocalConsent(wx)).toBeNull()
})

test('进入页判定：本地优先、服务端兜底、都没有则未同意', () => {
  const local = { version: '2026-11-09-v1', agreedAt: 11, ageConfirmedAt: 11 }
  expect(consent.resolveEntryState({ localConsent: local })).toEqual({
    consented: true,
    record: local,
    source: 'local'
  })

  const fromServer = consent.resolveEntryState({
    profileConsent: { version: '2026-11-09-v1', agreedAt: 22, ageConfirmedAt: 22 }
  })
  expect(fromServer.consented).toBe(true)
  expect(fromServer.source).toBe('server')
  expect(fromServer.record.ageConfirmedAt).toBe(22)

  expect(consent.resolveEntryState({})).toEqual({ consented: false, record: null, source: 'none' })
})

test('AC-25：18+ 未确认时 ensureUploadAllowed 为 false', () => {
  const record = { version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 0 }
  expect(consent.ensureUploadAllowed({ consented: true, record })).toBe(false)
  expect(consent.ensureUploadAllowed({ consented: true, record: null })).toBe(false)
  expect(consent.ensureUploadAllowed({ consented: false, record: { ageConfirmedAt: 1 } })).toBe(false)
  expect(consent.ensureUploadAllowed({ consented: true, record: { ageConfirmedAt: 1 } })).toBe(true)
})

test('requestPrivacyAuthorize：成功 / 拒绝 / API 缺失（不静默降级）', async () => {
  privacySuccess()
  await expect(consent.requestPrivacyAuthorize(wx)).resolves.toEqual({ ok: true })

  const deny = jest.fn((options) => options.fail && options.fail({ errMsg: 'deny' }))
  wx.__setMock('requirePrivacyAuthorize', deny)
  await expect(consent.requestPrivacyAuthorize(wx)).resolves.toEqual({ ok: false, reason: 'deny' })

  wx.requirePrivacyAuthorize = null
  await expect(consent.requestPrivacyAuthorize(wx)).resolves.toEqual({ ok: false, reason: 'unsupported' })
})

test('installPrivacyHandler：注册平台请求并回写 agree/disagree', () => {
  let registered = null
  wx.__setMock('onNeedPrivacyAuthorization', jest.fn((fn) => {
    registered = fn
  }))

  const onRequest = jest.fn()
  const handler = consent.installPrivacyHandler(wx, { onRequest })
  expect(handler.installed).toBe(true)

  // 平台调用已注册回调，并传入平台侧 resolve。
  const platformResolve = jest.fn()
  registered(platformResolve)
  expect(onRequest).toHaveBeenCalledTimes(1)
  expect(handler.hasPending()).toBe(true)

  expect(handler.resolve('agree')).toBe(true)
  expect(platformResolve).toHaveBeenCalledWith({ event: 'agree' })
  expect(handler.hasPending()).toBe(false)
  expect(handler.resolve('agree')).toBe(false)
})

test('AC-21：未勾选同意时 submitConsent 不调隐私接口、不写本地', async () => {
  const storage = storageMock('')
  const privacy = privacySuccess()
  const server = consentServerSuccess()

  const result = await consent.submitConsent({ wxRef: wx, ageConfirmed: false, termsAccepted: false, privacyAgreed: false })
  expect(result.ok).toBe(false)
  expect(result.step).toBe('age')

  const result2 = await consent.submitConsent({ wxRef: wx, ageConfirmed: true, termsAccepted: true, privacyAgreed: false })
  expect(result2.ok).toBe(false)
  expect(result2.step).toBe('privacy')

  expect(privacy).not.toHaveBeenCalled()
  expect(server).not.toHaveBeenCalled()
  expect(storage.set).not.toHaveBeenCalled()
  expect(wx.chooseMedia).not.toHaveBeenCalled()
})

test('隐私授权拒绝：不写服务端记录、不写本地', async () => {
  const storage = storageMock('')
  const privacy = jest.fn((options) => options.fail && options.fail({ errMsg: 'deny' }))
  wx.__setMock('requirePrivacyAuthorize', privacy)
  const server = consentServerSuccess()

  const result = await consent.submitConsent({ wxRef: wx, ageConfirmed: true, termsAccepted: true, privacyAgreed: true })
  expect(result.ok).toBe(false)
  expect(result.step).toBe('privacy')
  expect(privacy).toHaveBeenCalledTimes(1)
  expect(server).not.toHaveBeenCalled()
  expect(storage.set).not.toHaveBeenCalled()
})

test('同意成功：先隐私授权 → recordConsent（版本/hash/18+）→ 写本地 sinn_consent_v1', async () => {
  const storage = storageMock('')
  const privacy = privacySuccess()
  const server = consentServerSuccess()

  const result = await consent.submitConsent({ wxRef: wx, now: 1700000000123, ageConfirmed: true, termsAccepted: true, privacyAgreed: true })
  expect(result.ok).toBe(true)
  expect(result.record).toEqual({
    version: '2026-11-09-v1',
    agreedAt: 1700000000123,
    ageConfirmedAt: 1700000000123
  })

  expect(privacy).toHaveBeenCalledTimes(1)
  expect(server).toHaveBeenCalledTimes(1)
  const arg = server.mock.calls[0][0]
  expect(arg.name).toBe('sinn-account')
  expect(arg.data.action).toBe('recordConsent')
  expect(arg.data.version).toBe('2026-11-09-v1')
  expect(arg.data.ageConfirmed).toBe(true)
  expect(arg.data.textHash).toBe(consent.hashText(consent.getConsentText()))
  expect(storage.set).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(result.record))
  expect(wx.chooseMedia).not.toHaveBeenCalled()
})

test('recordConsent 失败：不写本地，返回可重试错误', async () => {
  const storage = storageMock('')
  privacySuccess()
  wx.__setMock('cloud.callFunction', () => Promise.resolve(wx.__failure(9000, 'E_INTERNAL', '服务暂时不可用，请稍后重试', 500)))

  const result = await consent.submitConsent({ wxRef: wx, ageConfirmed: true, termsAccepted: true, privacyAgreed: true })
  expect(result.ok).toBe(false)
  expect(result.step).toBe('record')
  expect(result.code).toBe(9000)
  expect(result.message).toContain('服务暂时不可用')
  expect(storage.set).not.toHaveBeenCalled()
})

test('页面静态合规：8 项文案齐全、无禁词、四件套与组件声明', () => {
  const root = path.join(process.cwd(), 'miniprogram', 'pages', 'consent')
  const wxml = fs.readFileSync(path.join(root, 'consent.wxml'), 'utf8')
  const json = JSON.parse(fs.readFileSync(path.join(root, 'consent.json'), 'utf8'))
  const js = fs.readFileSync(path.join(root, 'consent.js'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'consent.wxss'), 'utf8')
  const serviceSource = fs.readFileSync(
    path.join(process.cwd(), 'miniprogram', 'services', 'consent.js'),
    'utf8'
  )

  expect(json.usingComponents['navigation-bar']).toBe('/components/navigation-bar/navigation-bar')
  expect(js).toContain('Page({')
  expect(js).toContain("require('../../services/consent')")
  expect(wxss.length).toBeGreaterThan(100)

  // 8 项披露由服务层提供，页面通过 wx:for 渲染（避免页面文案与服务层漂移）。
  const labels = ['收集项', '用途', '保存期限', '境外接收方名称/所在地', '处理目的', '数据类别', '删除方式', '拒绝后果']
  labels.forEach((label) => expect(serviceSource).toContain(label))
  expect(wxml).toContain('wx:for="{{disclosures}}"')
  expect(wxml).toContain('{{item.label}}')
  expect(wxml).toContain('{{item.text}}')
  expect(wxml).toContain('{{genderNote}}')
  expect(wxml).toContain('18')
  expect(wxml).toContain('同意并继续')

  const forbidden = /保证合身|精准|准确|适合你|分享|保存相册|价格|购买|下单|商家|3D 旋转|形象库/
  expect(forbidden.test(wxml)).toBe(false)
  expect(forbidden.test(js)).toBe(false)
  expect(forbidden.test(serviceSource)).toBe(false)
})
