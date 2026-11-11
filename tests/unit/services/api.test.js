/**
 * tests/unit/services/api.test.js —— DEV-0001-02 services/api.js 单元测试（L1）。
 *
 * 覆盖 TASKS-0001.json DEV-0001-02 acceptance 第 4 条：
 * 成功 / 业务失败 / 网络失败 / 超时 / 未同意 / 首页恢复入口分支。
 * 仅依赖 tests/mocks/wx.js（Lead 维护），不需要开发者工具。
 */
'use strict'

const api = require('../../../miniprogram/services/api')
const wx = require('../../mocks/wx')

const CONSENT = { version: '2026-11-09-v1', agreedAt: 1700000000000, ageConfirmedAt: 1700000000000 }

/** 让本地存储返回指定同意记录，其余键保持空。 */
function withConsent(consent) {
  wx.__setMock('getStorageSync', jest.fn(function (key) {
    if (key === api.STORAGE_KEYS.CONSENT) return consent
    return ''
  }))
}

beforeEach(() => {
  wx.__reset()
  wx.__setMock('getStorageSync', jest.fn(function () { return '' }))
})

describe('createClientReqId / isClientReqId', () => {
  test('生成 UUID v4 且通过校验', () => {
    const id = api.createClientReqId()
    expect(api.isClientReqId(id)).toBe(true)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('100 次生成互不重复', () => {
    const seen = new Set()
    for (let i = 0; i < 100; i += 1) seen.add(api.createClientReqId())
    expect(seen.size).toBe(100)
  })

  test('非法值不通过校验', () => {
    expect(api.isClientReqId('')).toBe(false)
    expect(api.isClientReqId('not-a-uuid')).toBe(false)
    expect(api.isClientReqId(null)).toBe(false)
  })
})

describe('getUserMessage 错误文案', () => {
  test('预检子码给出具体重拍建议', () => {
    expect(api.getUserMessage(3002)).toBe('照片未拍到全身（含脚部），请重新拍摄')
    expect(api.getUserMessage({ code: 3010 })).toBe('请取下衣物吊牌后重拍')
  })

  test('业务错误码映射统一文案', () => {
    expect(api.getUserMessage(2001)).toBe(api.ERROR_CODES[2001].message)
    expect(api.getUserMessage({ name: 'E_CONSENT_REQUIRED' })).toBe(api.ERROR_CODES[1003].message)
  })

  test('未知错误给兜底文案，不抛异常', () => {
    expect(api.getUserMessage(424242)).toBe(api.ERROR_CODES[9000].message)
    expect(api.getUserMessage(null)).toBe(api.ERROR_CODES[9000].message)
  })
})

describe('parseEnvelope 响应包裹解析', () => {
  test('成功包裹返回 data/requestId/serverTime', () => {
    const res = api.parseEnvelope(wx.__success({ quota: { remaining: 2 } }))
    expect(res.data.quota.remaining).toBe(2)
    expect(res.requestId).toBe('mock-request-id')
    expect(typeof res.serverTime).toBe('number')
    expect(api.getLastRequestId()).toBe('mock-request-id')
  })

  test('业务失败抛 ApiError（code/name/httpStatus/requestId 原样保留）', () => {
    expect.assertions(5)
    try {
      api.parseEnvelope(wx.__failure(2001, 'E_QUOTA_EXHAUSTED', '今日额度已用完', 429))
    } catch (error) {
      expect(error instanceof api.ApiError).toBe(true)
      expect(error.code).toBe(2001)
      expect(error.name).toBe('E_QUOTA_EXHAUSTED')
      expect(error.httpStatus).toBe(429)
      expect(error.requestId).toBe('mock-request-id')
    }
  })

  test('缺少 result / ok 非法视为内部错误', () => {
    expect(() => api.parseEnvelope({})).toThrow(api.ApiError)
    expect(() => api.parseEnvelope({ result: null })).toThrow(/服务返回异常/)
    expect(() => api.parseEnvelope({ result: { requestId: 'r' } })).toThrow(/服务返回异常/)
  })
})

describe('call 统一调用', () => {
  test('成功调用：函数名/action 透传，返回解析后的 data', async () => {
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__success({ quota: { remaining: 1 } })))
    const res = await api.call('sinn-account', 'profile', {}, { requireConsent: false })
    expect(res.data.quota.remaining).toBe(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledWith({ name: 'sinn-account', data: { action: 'profile' } })
  })

  test('业务失败：拒绝为 ApiError，不做静默降级', async () => {
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__failure(5004, 'E_TASK_NOT_FOUND', '不存在', 404)))
    await expect(api.call('sinn-task', 'taskGet', { taskId: 't_x' })).rejects.toMatchObject({
      code: 5004,
      name: 'E_TASK_NOT_FOUND',
      httpStatus: 404
    })
  })

  test('网络失败：映射为 E_NETWORK(5003)', async () => {
    wx.__setMock('cloud.callFunction', jest.fn().mockRejectedValue({ errMsg: 'cloud.callFunction:fail network' }))
    await expect(api.call('sinn-account', 'profile', {}, { requireConsent: false })).rejects.toMatchObject({
      code: 5003,
      name: 'E_NETWORK',
      httpStatus: 0
    })
  })

  test('客户端超时：映射为 E_TIMEOUT(5002)', async () => {
    wx.__setMock('cloud.callFunction', jest.fn(function () { return new Promise(function () {}) }))
    await expect(
      api.call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 5002, name: 'E_TIMEOUT' })
  })
})

describe('同意前置与幂等键', () => {
  test('未同意时写接口直接拒绝，且不调用云函数', async () => {
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__success({})))
    await expect(
      api.call('sinn-task', 'createTask', { personAssetIds: ['a_1'], garmentAssetId: 'a_2', metrics: { heightCm: 170, weightKg: 60 } })
    ).rejects.toMatchObject({ code: 1003, name: 'E_CONSENT_REQUIRED', httpStatus: 403 })
    expect(wx.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('已同意时写接口自动生成 clientReqId（UUID v4）', async () => {
    withConsent(CONSENT)
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__success({ assetId: 'a_1' })))
    await api.call('sinn-task', 'assetRegister', { kind: 'PERSON', fileID: 'cloud://x', mime: 'image/jpeg', bytes: 100, width: 100, height: 100 })
    const payload = wx.cloud.callFunction.mock.calls[0][0].data
    expect(api.isClientReqId(payload.clientReqId)).toBe(true)
    expect(payload.action).toBe('assetRegister')
  })

  test('调用方传入的 clientReqId 重试时原样复用', async () => {
    withConsent(CONSENT)
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__success({ taskId: 't_1' })))
    const clientReqId = api.createClientReqId()
    await api.call('sinn-task', 'createTask', { clientReqId, personAssetIds: ['a_1'], garmentAssetId: 'a_2', metrics: { heightCm: 170, weightKg: 60 } })
    expect(wx.cloud.callFunction.mock.calls[0][0].data.clientReqId).toBe(clientReqId)
  })

  test('读接口（profile）不要求同意', async () => {
    wx.__setMock('cloud.callFunction', jest.fn().mockResolvedValue(wx.__success({ quota: { remaining: 1 } })))
    const res = await api.call('sinn-account', 'profile', {})
    expect(res.data.quota.remaining).toBe(1)
    expect(wx.cloud.callFunction).toHaveBeenCalledTimes(1)
  })
})

describe('本地缓存读取与首页恢复分支', () => {
  test('同意记录：合法对象/JSON 字符串均可读，非法值返回 null', () => {
    withConsent(CONSENT)
    expect(api.isConsented()).toBe(true)
    withConsent(JSON.stringify(CONSENT))
    expect(api.isConsented()).toBe(true)
    withConsent('not-json')
    expect(api.isConsented()).toBe(false)
    withConsent({ agreedAt: 1 })
    expect(api.isConsented()).toBe(false)
  })

  test('进行中任务缓存：合法值可读，非法值按无缓存处理', () => {
    wx.__setMock('getStorageSync', jest.fn(function (key) {
      if (key === api.STORAGE_KEYS.ACTIVE_TASK) return { taskId: 't_abc', createdAt: 1, statusHint: 'GENERATING' }
      return ''
    }))
    expect(api.getCachedActiveTask().taskId).toBe('t_abc')

    wx.__setMock('getStorageSync', jest.fn(function () { return '{}' }))
    expect(api.getCachedActiveTask()).toBe(null)
  })

  test('恢复入口：服务端 activeTaskId 优先于本地缓存', () => {
    expect(api.resolveHomeState({ profileData: { activeTaskId: 't_server' }, localActiveTask: { taskId: 't_local' }, consent: true })).toEqual({
      hasActiveTask: true,
      activeTaskId: 't_server',
      consented: true
    })
  })

  test('恢复入口：无服务端任务时用本地缓存；都没有时 hasActiveTask=false', () => {
    expect(api.resolveHomeState({ localActiveTask: { taskId: 't_local' }, consent: false })).toEqual({
      hasActiveTask: true,
      activeTaskId: 't_local',
      consented: false
    })
    expect(api.resolveHomeState({ consent: false })).toEqual({ hasActiveTask: false, activeTaskId: '', consented: false })
  })

  test('恢复入口：consented 显式传入优先于本地缓存', () => {
    withConsent(CONSENT)
    expect(api.resolveHomeState({ consent: false }).consented).toBe(false)
    expect(api.resolveHomeState({}).consented).toBe(true)
  })
})
