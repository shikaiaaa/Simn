/**
 * tests/unit/pages/consent/consent-page.test.js
 * L1：同意页交互与进入/拒绝分支（DEV-0001-05，AC-21 / AC-25）。
 * 用 global.Page 捕获页面配置，直接驱动页面方法（不依赖开发者工具）。
 */
'use strict'

const consent = require('../../../../miniprogram/services/consent')

const PAGE_PATH = require.resolve('../../../../miniprogram/pages/consent/consent.js')

// 只在模块加载时捕获一次页面配置（jest 模块注册表不会因删除 require.cache 重跑 Page）。
let capturedConfig = null
global.Page = (config) => {
  capturedConfig = config
}
require(PAGE_PATH)
const PAGE_CONFIG = capturedConfig

function makeInstance(config) {
  const inst = {
    data: JSON.parse(JSON.stringify(config.data || {})),
    setData(patch) {
      Object.keys(patch || {}).forEach((key) => {
        this.data[key] = patch[key]
      })
    }
  }
  Object.keys(config).forEach((key) => {
    if (typeof config[key] === 'function') inst[key] = config[key]
  })
  return inst
}

function flush(times) {
  let chain = Promise.resolve()
  for (let i = 0; i < (times || 3); i += 1) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)))
  }
  return chain
}

function storageMock(initial) {
  let stored = initial === undefined ? '' : initial
  const set = jest.fn((key, value) => {
    if (key === 'sinn_consent_v1') stored = value
  })
  wx.__setMock('getStorageSync', jest.fn(() => stored))
  wx.__setMock('setStorageSync', set)
  wx.__setMock('removeStorageSync', jest.fn(() => {
    stored = ''
  }))
  return { set, value: () => stored }
}

function serverSuccess(payload) {
  const spy = jest.fn(() => Promise.resolve(wx.__success(payload || { recordId: 'c_mock', recordedAt: 1 })))
  wx.__setMock('cloud.callFunction', spy)
  return spy
}

beforeEach(() => {
  wx.__reset()
  storageMock('')
})

test('页面默认态：两步、三项均不默认勾选、8 项披露与 draft 文本', () => {
  const inst = makeInstance(PAGE_CONFIG)
  expect(inst.data.step).toBe(1)
  expect(inst.data.ageConfirmed).toBe(false)
  expect(inst.data.termsAccepted).toBe(false)
  expect(inst.data.privacyAgreed).toBe(false)
  expect(inst.data.disclosures.length).toBe(8)
  expect(inst.data.genderNote).toContain('性别')
  expect(inst.data.draftNotice).toContain('CP-10')
  expect(inst.data.errorText).toBe('')
})

test('勾选交互：独立切换、不联动（不捆绑）', () => {
  const inst = makeInstance(PAGE_CONFIG)
  inst.onToggleAge()
  expect(inst.data.ageConfirmed).toBe(true)
  expect(inst.data.termsAccepted).toBe(false)
  expect(inst.data.privacyAgreed).toBe(false)
  inst.onToggleAge()
  expect(inst.data.ageConfirmed).toBe(false)
  inst.onTogglePrivacy()
  expect(inst.data.privacyAgreed).toBe(true)
})

test('AC-25：18+ 与条款未都确认时无法进入第二步', () => {
  const inst = makeInstance(PAGE_CONFIG)
  inst.onStep1Next()
  expect(inst.data.step).toBe(1)
  expect(inst.data.errorText).toContain('18')

  inst.onToggleAge()
  inst.onStep1Next()
  expect(inst.data.step).toBe(1)
  expect(inst.data.errorText).toContain('禁止条款')

  inst.onToggleTerms()
  inst.onStep1Next()
  expect(inst.data.step).toBe(2)
  expect(inst.data.errorText).toBe('')
})

test('AC-21：未勾选隐私单独同意时，同意动作不调隐私接口、不写本地、不跳转', async () => {
  const store = storageMock('')
  const privacy = jest.fn((options) => options.success && options.success())
  wx.__setMock('requirePrivacyAuthorize', privacy)
  const server = serverSuccess()
  const redirect = jest.fn()
  wx.__setMock('redirectTo', redirect)

  const inst = makeInstance(PAGE_CONFIG)
  inst.data.ageConfirmed = true
  inst.data.termsAccepted = true
  inst.data.step = 2
  await inst.onAgree()

  expect(inst.data.errorText).toContain('单独同意')
  expect(privacy).not.toHaveBeenCalled()
  expect(server).not.toHaveBeenCalled()
  expect(store.set).not.toHaveBeenCalled()
  expect(redirect).not.toHaveBeenCalled()
  expect(wx.chooseMedia).not.toHaveBeenCalled()
})

test('同意成功：隐私授权 + recordConsent + 本地缓存 + redirectTo capture', async () => {
  const store = storageMock('')
  const privacy = jest.fn((options) => options.success && options.success())
  wx.__setMock('requirePrivacyAuthorize', privacy)
  const server = serverSuccess()
  const redirect = jest.fn()
  wx.__setMock('redirectTo', redirect)

  const inst = makeInstance(PAGE_CONFIG)
  inst.data.ageConfirmed = true
  inst.data.termsAccepted = true
  inst.data.privacyAgreed = true
  inst.data.step = 2
  await inst.onAgree()
  await flush(2)

  expect(privacy).toHaveBeenCalledTimes(1)
  expect(server).toHaveBeenCalledTimes(1)
  expect(server.mock.calls[0][0].data.action).toBe('recordConsent')
  expect(store.set).toHaveBeenCalledTimes(1)
  expect(store.value()).toContain('2026-11-09-v1')
  expect(redirect).toHaveBeenCalledWith({ url: consent.CAPTURE_URL })
  expect(wx.chooseMedia).not.toHaveBeenCalled()
})

test('拒绝：不调隐私接口，回首页功能说明', () => {
  let registered = null
  wx.__setMock('onNeedPrivacyAuthorization', jest.fn((fn) => {
    registered = fn
  }))
  const privacy = jest.fn()
  wx.__setMock('requirePrivacyAuthorize', privacy)
  const reLaunch = jest.fn()
  wx.__setMock('reLaunch', reLaunch)

  const inst = makeInstance(PAGE_CONFIG)
  inst._privacyHandler = consent.installPrivacyHandler(wx, {})
  registered(jest.fn())
  expect(inst._privacyHandler.hasPending()).toBe(true)

  inst.onReject()
  expect(reLaunch).toHaveBeenCalledWith({ url: consent.INDEX_URL })
  expect(privacy).not.toHaveBeenCalled()
  expect(wx.chooseMedia).not.toHaveBeenCalled()
})

test('二次进入（本地已同意）：免重复同意，直接 redirectTo capture', () => {
  const record = { version: '2026-11-09-v1', agreedAt: 1700000000000, ageConfirmedAt: 1700000000000 }
  storageMock(JSON.stringify(record))
  const server = serverSuccess()
  const redirect = jest.fn()
  wx.__setMock('redirectTo', redirect)

  const inst = makeInstance(PAGE_CONFIG)
  inst.onLoad()

  expect(redirect).toHaveBeenCalledWith({ url: consent.CAPTURE_URL })
  expect(server).not.toHaveBeenCalled()
})

test('二次进入（本地缺失、服务端已同意）：回写本地并 redirectTo capture', async () => {
  const store = storageMock('')
  serverSuccess({
    quota: { used: 0, limit: 1, remaining: 1, vip: false, dayKey: '2026-11-09', resetAt: 0 },
    consent: { version: '2026-11-09-v1', agreedAt: 1700000001000, ageConfirmedAt: 1700000001000 },
    activeTaskId: '',
    hasData: false
  })
  const redirect = jest.fn()
  wx.__setMock('redirectTo', redirect)

  const inst = makeInstance(PAGE_CONFIG)
  inst.onLoad()
  await flush(3)

  expect(store.set).toHaveBeenCalledTimes(1)
  expect(store.value()).toContain('2026-11-09-v1')
  expect(redirect).toHaveBeenCalledWith({ url: consent.CAPTURE_URL })
})

test('二次进入（未同意且 profile 失败）：停留同意页第一步', async () => {
  storageMock('')
  wx.__setMock('cloud.callFunction', () => Promise.reject({ errMsg: 'cloud.callFunction:fail' }))
  const redirect = jest.fn()
  wx.__setMock('redirectTo', redirect)

  const inst = makeInstance(PAGE_CONFIG)
  inst.onLoad()
  await flush(3)

  expect(redirect).not.toHaveBeenCalled()
  expect(inst.data.step).toBe(1)
  expect(inst.data.privacyPrompt).toBe(false)
})
