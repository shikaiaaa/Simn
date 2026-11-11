/**
 * tests/unit/pages/generating/generating-page.test.js
 * 覆盖 AC-6/8/9/10/12：轮询与等待秒数、60–65s 超时态、失败六类、恢复同一任务、
 * 404 转失败态、取消回首页、成功跳 result、失败页不出现结果图。
 */
'use strict'

var CAPTURED = null
global.Page = function (config) {
  CAPTURED = config
}
require('../../../../miniprogram/pages/generating/generating.js')

var fs = require('fs')
var path = require('path')
var CONSENT = JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 1 })
var ACTIVE_KEY = 'sinn_active_task_v1'

var taskGetImpl = null
var profileImpl = null
var cancelImpl = null

function envelope(data, serverTime) {
  return {
    result: {
      ok: true,
      data: data,
      error: null,
      requestId: 'req-' + (data && data.taskId ? data.taskId : 'none'),
      serverTime: serverTime || 0
    }
  }
}

function errorEnvelope(code, name, message, httpStatus) {
  return {
    result: {
      ok: false,
      data: null,
      error: { code: code, name: name || 'E', message: message || 'error', hint: '', httpStatus: httpStatus || 500 },
      requestId: 'req-err',
      serverTime: 1
    }
  }
}

function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve)
  })
}

async function settle() {
  for (var i = 0; i < 8; i += 1) {
    await flush()
  }
}

function createPage() {
  var page = {
    data: JSON.parse(JSON.stringify(CAPTURED.data)),
    setData: function (patch) {
      Object.assign(this.data, patch)
    }
  }
  Object.keys(CAPTURED).forEach(function (key) {
    if (typeof CAPTURED[key] === 'function') page[key] = CAPTURED[key].bind(page)
  })
  page._setTimeout = jest.fn(function () {
    return 1
  })
  page._clearTimeout = jest.fn()
  page._setInterval = jest.fn(function () {
    return 2
  })
  page._clearInterval = jest.fn()
  return page
}

function startPage(options) {
  var page = createPage()
  page.onLoad(options || {})
  return page
}

function taskGetCalls() {
  return wx.cloud.callFunction.mock.calls
    .map(function (call) {
      return call[0].data
    })
    .filter(function (data) {
      return data.action === 'taskGet'
    })
}

function callsOfAction(action) {
  return wx.cloud.callFunction.mock.calls
    .map(function (call) {
      return call[0].data
    })
    .filter(function (data) {
      return data.action === action
    })
}

beforeEach(function () {
  wx.__reset()
  wx.getStorageSync = jest.fn(function (key) {
    if (key === 'sinn_consent_v1') return CONSENT
    return ''
  })
  wx.setStorageSync = jest.fn()
  wx.removeStorageSync = jest.fn()
  wx.redirectTo = jest.fn()
  wx.reLaunch = jest.fn()
  wx.navigateTo = jest.fn()
  wx.showModal = jest.fn(function (options) {
    options.success({ confirm: true, cancel: false })
  })

  taskGetImpl = function () {
    return Promise.resolve(
      envelope({ taskId: 't_1', status: 'QUEUED', stage: 'QUEUED', waitedSec: 2, createdAt: 1, purgeAt: 2 }, 1000)
    )
  }
  profileImpl = function () {
    return Promise.resolve(envelope({ activeTaskId: null, quota: {}, consent: null, hasData: false }, 1))
  }
  cancelImpl = function () {
    return Promise.resolve(envelope({ status: 'CANCELLED', quota: { remaining: 1 } }, 1))
  }

  wx.cloud.callFunction = jest.fn(function (options) {
    var data = options.data || {}
    if (data.action === 'taskGet') return taskGetImpl(data)
    if (data.action === 'profile') return profileImpl(data)
    if (data.action === 'cancelTask') return cancelImpl(data)
    return Promise.resolve(envelope({}))
  })
})

describe('generating 页：AC-8 轮询与进度展示', function () {
  test('展示服务端 stage 与 waitedSec，无百分比', async function () {
    taskGetImpl = function () {
      return Promise.resolve(
        envelope({ taskId: 't_1', status: 'GENERATING', stage: 'GENERATING', waitedSec: 12, createdAt: 1 }, 2000)
      )
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.loading).toBe(false)
    expect(page.data.stageText).toBe('生成中')
    expect(page.data.waitedText).toBe('已等待 12 秒')
    expect(page.data.percent).toBeUndefined()
    expect(page.data).not.toHaveProperty('progress')
    var delays = page._setTimeout.mock.calls.map(function (call) {
      return call[1]
    })
    expect(delays).toContain(2000)
  })

  test('无 waitedSec 时按 serverTime - createdAt 计算等待秒数', async function () {
    taskGetImpl = function () {
      return Promise.resolve(envelope({ taskId: 't_1', status: 'GENERATING', stage: 'GENERATING', createdAt: 1000000 }, 1012000))
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.waitedText).toBe('已等待 12 秒')
  })
})

describe('generating 页：AC-9 60–65s 超时', function () {
  test('服务端返回 TIMEOUT 时进入明确超时态并可重试', async function () {
    taskGetImpl = function () {
      return Promise.resolve(envelope({ taskId: 't_1', status: 'TIMEOUT', stage: 'TIMEOUT', createdAt: 1 }, 2000))
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.terminal).toBe(true)
    expect(page.data.errorKind).toBe('timeout')
    expect(page.data.errorTitle).toBe('生成超时')
    expect(page.data.canRetry).toBe(true)
    expect(page.data.loading).toBe(false)
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  test('本地硬超时 65s 兜底：停止轮询、不出图、可重试', async function () {
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.terminal).toBe(false)
    page._startedAt = Date.now() - 66000
    page._tick()
    expect(page.data.terminal).toBe(true)
    expect(page.data.errorKind).toBe('timeout')
    expect(page._clearInterval).toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  test('59s 时仍在生成态，不提前超时', async function () {
    var page = startPage({ taskId: 't_1' })
    await settle()
    page._startedAt = Date.now() - 59000
    page._serverBase = { waitedSec: 2, at: Date.now() - 57000 }
    page._tick()
    expect(page.data.terminal).toBe(false)
    expect(page.data.waitedText).toMatch(/已等待 5[89] 秒/)
  })
})

describe('generating 页：AC-10 失败六类文案与无图', function () {
  test('六类失败进入独立失败态且不展示任何结果图', function () {
    var cases = [
      { payload: { status: 'TIMEOUT', stage: 'TIMEOUT' }, kind: 'timeout', title: '生成超时' },
      { payload: { status: 'FAILED', failure: { code: 3002, message: '照片不合格' } }, kind: 'photo', title: '照片未通过预检' },
      { payload: { status: 'FAILED', failure: { code: 2001 } }, kind: 'quota', title: '今日次数已用完' },
      { payload: { status: 'FAILED', failure: { code: 4001 } }, kind: 'content', title: '内容校验未通过' },
      { payload: { status: 'FAILED', failure: { code: 5003 } }, kind: 'network', title: '网络异常' },
      { payload: { status: 'FAILED', failure: { code: 5001 } }, kind: 'service', title: '服务暂时不可用' }
    ]
    cases.forEach(function (item) {
      var page = createPage()
      page._startedAt = Date.now()
      page.data.taskId = 't_1'
      page._applyTask(item.payload, 1000)
      expect(page.data.terminal).toBe(true)
      expect(page.data.errorKind).toBe(item.kind)
      expect(page.data.errorTitle).toBe(item.title)
      expect(page.data.result).toBeUndefined()
      expect(page.data.imageUrl).toBeUndefined()
      expect(wx.redirectTo).not.toHaveBeenCalled()
    })
  })

  test('失败页 WXML 没有任何图片标签（AC-6/10）', function () {
    var wxml = fs.readFileSync(path.join(__dirname, '../../../../miniprogram/pages/generating/generating.wxml'), 'utf8')
    expect(wxml).not.toContain('<image')
    expect(wxml).toContain('{{stageText}}')
    expect(wxml).toContain('{{waitedText}}')
    expect(wxml).toContain('取消生成')
    expect(wxml).toContain('重试')
    expect(wxml).toContain('返回首页')
  })
})

describe('generating 页：AC-12 恢复同一任务', function () {
  test('无 taskId 参数时用 profile.activeTaskId 恢复，且不重复创建', async function () {
    profileImpl = function () {
      return Promise.resolve(envelope({ activeTaskId: 't_9', quota: {}, consent: null, hasData: true }, 1))
    }
    var page = startPage({})
    await settle()
    expect(taskGetCalls().length).toBe(1)
    expect(taskGetCalls()[0].taskId).toBe('t_9')
    expect(callsOfAction('createTask').length).toBe(0)
    expect(page.data.taskId).toBe('t_9')
    expect(wx.setStorageSync).toHaveBeenCalledWith(ACTIVE_KEY, expect.any(String))
  })

  test('无参数时优先读本地 sinn_active_task_v1，且不再调 profile', async function () {
    wx.getStorageSync = jest.fn(function (key) {
      if (key === 'sinn_consent_v1') return CONSENT
      if (key === ACTIVE_KEY) return JSON.stringify({ taskId: 't_7', createdAt: 1 })
      return ''
    })
    var page = startPage({})
    await settle()
    expect(taskGetCalls()[0].taskId).toBe('t_7')
    expect(callsOfAction('profile').length).toBe(0)
  })

  test('没有进行中任务时显示「没有进行中的任务」并可回首页', async function () {
    var page = startPage({})
    await settle()
    expect(page.data.terminal).toBe(true)
    expect(page.data.errorKind).toBe('no_task')
    expect(page.data.errorTitle).toBe('没有进行中的任务')
  })
})

describe('generating 页：成功 / 404 / 取消', function () {
  test('SUCCEEDED 时 redirectTo result 并清理 active 缓存', async function () {
    taskGetImpl = function () {
      return Promise.resolve(envelope({ taskId: 't_1', status: 'SUCCEEDED', stage: 'DONE', result: { fileID: 'cloud://r' } }, 2000))
    }
    startPage({ taskId: 't_1' })
    await settle()
    expect(wx.redirectTo).toHaveBeenCalledTimes(1)
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/result/result?taskId=t_1')
    expect(wx.removeStorageSync).toHaveBeenCalledWith(ACTIVE_KEY)
  })

  test('taskGet 404（被删除/清理）转失败态，不跳转、不出图', async function () {
    taskGetImpl = function () {
      return Promise.resolve(errorEnvelope(5004, 'E_TASK_NOT_FOUND', 'task not found', 404))
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.terminal).toBe(true)
    expect(page.data.errorKind).toBe('gone')
    expect(page.data.errorTitle).toBe('任务不存在')
    expect(wx.redirectTo).not.toHaveBeenCalled()
  })

  test('取消：二次确认后 cancelTask，回首页', async function () {
    var page = startPage({ taskId: 't_1' })
    await settle()
    await page.onCancel()
    await settle()
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(callsOfAction('cancelTask').length).toBe(1)
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/index/index' })
  })

  test('取消确认框点取消时不调 cancelTask', async function () {
    wx.showModal = jest.fn(function (options) {
      options.success({ confirm: false, cancel: true })
    })
    var page = startPage({ taskId: 't_1' })
    await settle()
    await page.onCancel()
    await settle()
    expect(callsOfAction('cancelTask').length).toBe(0)
  })
})

describe('generating 页：网络退避与重试', function () {
  test('网络失败按 2s→4s→8s 退避，连续失败超过 3 次转网络失败态', async function () {
    taskGetImpl = function () {
      return Promise.reject(new Error('network down'))
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.netNotice).toContain('2 秒后重试')
    expect(page.data.terminal).toBe(false)
    await page._pollOnce()
    await settle()
    expect(page.data.netNotice).toContain('4 秒后重试')
    await page._pollOnce()
    await settle()
    expect(page.data.netNotice).toContain('8 秒后重试')
    await page._pollOnce()
    await settle()
    expect(page.data.terminal).toBe(true)
    expect(page.data.errorKind).toBe('network')
    expect(page.data.canRetry).toBe(true)
  })

  test('超时后点「重试」恢复轮询同一任务，不重复创建', async function () {
    var responses = [
      envelope({ taskId: 't_1', status: 'TIMEOUT', stage: 'TIMEOUT', createdAt: 1 }, 2000),
      envelope({ taskId: 't_1', status: 'GENERATING', stage: 'GENERATING', waitedSec: 3, createdAt: 1 }, 3000)
    ]
    taskGetImpl = function () {
      var next = responses.length > 1 ? responses.shift() : responses[0]
      return Promise.resolve(next)
    }
    var page = startPage({ taskId: 't_1' })
    await settle()
    expect(page.data.errorKind).toBe('timeout')
    page.onRetry()
    await settle()
    expect(page.data.terminal).toBe(false)
    expect(page.data.stageText).toBe('生成中')
    expect(taskGetCalls().length).toBe(2)
    expect(callsOfAction('createTask').length).toBe(0)
  })
})

describe('generating 页：静态与同意门禁', function () {
  test('四件套存在且 wxml 使用全局卡片/按钮样式', function () {
    var dir = path.join(__dirname, '../../../../miniprogram/pages/generating/')
    ;['generating.js', 'generating.wxml', 'generating.wxss', 'generating.json'].forEach(function (file) {
      expect(fs.existsSync(path.join(dir, file))).toBe(true)
    })
    var json = JSON.parse(fs.readFileSync(path.join(dir, 'generating.json'), 'utf8'))
    expect(json.usingComponents['navigation-bar']).toBeTruthy()
    var wxss = fs.readFileSync(path.join(dir, 'generating.wxss'), 'utf8')
    expect(wxss).not.toContain('占位')
    expect(wxss).toContain('.generating-stage')
  })

  test('未同意时不轮询、回 consent 页', async function () {
    wx.getStorageSync = jest.fn(function () {
      return ''
    })
    startPage({ taskId: 't_1' })
    await settle()
    expect(wx.redirectTo.mock.calls[0][0].url).toBe('/pages/consent/consent')
    expect(taskGetCalls().length).toBe(0)
  })
})
