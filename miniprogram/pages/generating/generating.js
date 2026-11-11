// generating.js —— 生成中页（DEV-0001-07 / DEV-0001-07）。
// 轮询 taskGet（2s，网络失败指数退避 ≤10s），展示服务端 stage 与已等待秒数，
// 60–65s 内进入明确超时态；失败六类文案；离开再进入恢复同一任务；可取消并返还额度。
'use strict'

var api = require('../../services/api')
var polling = require('../../services/polling')
var consent = require('../../services/consent')

var RESULT_URL = '/pages/result/result'
var INDEX_URL = '/pages/index/index'
var CONSENT_URL = '/pages/consent/consent'
var ACTIVE_TASK_KEY = 'sinn_active_task_v1'

function readActiveTask() {
  var raw = ''
  try {
    raw = wx.getStorageSync(ACTIVE_TASK_KEY)
  } catch (error) {
    return null
  }
  if (!raw) return null
  var value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (error) {
      return null
    }
  }
  if (!value || typeof value !== 'object' || !value.taskId) return null
  return { taskId: String(value.taskId), createdAt: Number(value.createdAt) || 0 }
}

function writeActiveTask(taskId) {
  try {
    wx.setStorageSync(ACTIVE_TASK_KEY, JSON.stringify({ taskId: taskId, createdAt: Date.now(), statusHint: 'GENERATING' }))
  } catch (error) {
    // 缓存写入失败不阻塞主流程
  }
}

function clearActiveTask() {
  try {
    wx.removeStorageSync(ACTIVE_TASK_KEY)
  } catch (error) {
    // ignore
  }
}

Page({
  data: {
    taskId: '',
    loading: true,
    status: 'QUEUED',
    stage: 'QUEUED',
    stageText: '排队中',
    waitedSec: 0,
    waitedText: '已等待 0 秒',
    netNotice: '',
    terminal: false,
    errorKind: '',
    errorTitle: '',
    errorMessage: '',
    canRetry: false,
    canCancel: false
  },

  onLoad: function (options) {
    this._options = options || {}
    this._stopped = false
    this._inFlight = false
    this._netAttempt = 0
    this._timer = null
    this._tickTimer = null
    this._startedAt = Date.now()
    this._serverBase = null
    this._bootstrap()
  },

  onUnload: function () {
    this._finish()
  },

  // 可注入的定时器封装：单测里替换为空实现，避免真实等待。
  _setTimeout: function (fn, ms) {
    return setTimeout(fn, ms)
  },
  _clearTimeout: function (id) {
    if (id) clearTimeout(id)
  },
  _setInterval: function (fn, ms) {
    return setInterval(fn, ms)
  },
  _clearInterval: function (id) {
    if (id) clearInterval(id)
  },

  _hasConsent: function () {
    try {
      var state = consent.resolveEntryState({ localConsent: consent.readLocalConsent(wx) })
      return consent.ensureUploadAllowed(state)
    } catch (error) {
      return false
    }
  },

  _bootstrap: function () {
    var self = this
    if (!this._hasConsent()) {
      wx.redirectTo({ url: CONSENT_URL })
      return
    }
    var fromOptions = this._options.taskId ? String(this._options.taskId) : ''
    if (fromOptions) {
      this._start(fromOptions)
      return
    }
    var cached = readActiveTask()
    if (cached && cached.taskId) {
      this._start(cached.taskId)
      return
    }
    return api
      .call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
      .then(function (res) {
        var profile = res && res.data ? res.data : res
        if (profile && profile.activeTaskId) {
          self._start(String(profile.activeTaskId))
          return
        }
        self._showFailure({
          kind: 'no_task',
          title: '没有进行中的任务',
          message: '未找到可恢复的任务，请返回首页重新开始。',
          canRetry: false
        })
      })
      .catch(function () {
        self._showFailure({
          kind: 'no_task',
          title: '没有进行中的任务',
          message: '未找到可恢复的任务，请返回首页重新开始。',
          canRetry: false
        })
      })
  },

  _start: function (taskId) {
    this._stopTimers()
    this._stopped = false
    this._inFlight = false
    this._netAttempt = 0
    this._startedAt = Date.now()
    this._serverBase = null
    this.setData({
      taskId: taskId,
      loading: true,
      terminal: false,
      errorKind: '',
      errorTitle: '',
      errorMessage: '',
      canRetry: false,
      canCancel: false,
      netNotice: ''
    })
    writeActiveTask(taskId)
    this._tickTimer = this._setInterval(this._tick.bind(this), 1000)
    return this._pollOnce()
  },

  _stopTimers: function () {
    this._clearTimeout(this._timer)
    this._timer = null
    this._clearInterval(this._tickTimer)
    this._tickTimer = null
  },

  _finish: function () {
    this._stopped = true
    this._stopTimers()
  },

  _schedulePoll: function (delayMs) {
    var self = this
    this._clearTimeout(this._timer)
    this._timer = this._setTimeout(function () {
      self._pollOnce()
    }, delayMs)
  },

  _now: function () {
    return Date.now()
  },

  _pollOnce: function () {
    var self = this
    if (this._stopped || this._inFlight || !this.data.taskId) return Promise.resolve(null)
    this._inFlight = true
    return api
      .call('sinn-task', 'taskGet', { taskId: this.data.taskId }, { requireConsent: true, timeoutMs: 8000 })
      .then(function (res) {
        self._inFlight = false
        if (self._stopped) return null
        self._netAttempt = 0
        var task = res && res.data ? res.data : res || {}
        var serverTime = res && res.serverTime ? res.serverTime : 0
        self._applyTask(task, serverTime)
        return task
      })
      .catch(function (error) {
        self._inFlight = false
        if (self._stopped) return null
        if (error && error.code === 5004) {
          self._showFailure(polling.classifyFailure({ status: 'FAILED', code: 5004 }))
          return null
        }
        if (error && error.code === 5003) {
          self._netAttempt += 1
          if (self._netAttempt > polling.MAX_NETWORK_ATTEMPTS) {
            self._showFailure(polling.classifyFailure({ status: 'FAILED', code: 5003 }))
            return null
          }
          var delay = polling.nextDelayMs(self._netAttempt)
          self.setData({ netNotice: '网络波动，' + Math.round(delay / 1000) + ' 秒后重试…' })
          self._schedulePoll(delay)
          return null
        }
        self._showFailure(polling.classifyFailure({ status: 'FAILED', code: error && error.code }))
        return null
      })
  },

  _applyTask: function (task, serverTime) {
    var status = task.status || 'QUEUED'
    var stage = task.stage || status
    var waitedSec = polling.computeWaitedSec({
      waitedSec: task.waitedSec,
      serverTime: serverTime,
      createdAt: task.createdAt,
      startedAt: this._startedAt,
      now: this._now()
    })
    this._serverBase = { waitedSec: waitedSec, at: this._now() }
    this.setData({
      loading: false,
      status: status,
      stage: stage,
      stageText: polling.stageText(stage, status),
      waitedSec: waitedSec,
      waitedText: polling.formatWaited(waitedSec),
      netNotice: ''
    })

    if (status === 'SUCCEEDED') {
      this._finish()
      clearActiveTask()
      wx.redirectTo({ url: RESULT_URL + '?taskId=' + encodeURIComponent(this.data.taskId) })
      return
    }
    if (polling.isTerminal(status)) {
      this._showFailure(polling.classifyFailure({ status: status, failure: task.failure || null }))
      return
    }
    if (polling.shouldHardTimeout(this._now() - this._startedAt)) {
      this._showFailure(polling.classifyFailure({ status: 'TIMEOUT' }))
      return
    }
    this._schedulePoll(polling.POLL_INTERVAL_MS)
  },

  _tick: function () {
    if (this._stopped || this.data.terminal) return
    var nowMs = this._now()
    if (polling.shouldHardTimeout(nowMs - this._startedAt)) {
      this._showFailure(polling.classifyFailure({ status: 'TIMEOUT' }))
      return
    }
    var waitedSec = this._serverBase
      ? this._serverBase.waitedSec + Math.floor((nowMs - this._serverBase.at) / 1000)
      : Math.floor((nowMs - this._startedAt) / 1000)
    this.setData({ waitedSec: waitedSec, waitedText: polling.formatWaited(waitedSec) })
  },

  _showFailure: function (info) {
    var failure = info || {}
    this._finish()
    clearActiveTask()
    this.setData({
      loading: false,
      terminal: true,
      netNotice: '',
      errorKind: failure.kind || 'service',
      errorTitle: failure.title || '生成失败',
      errorMessage: failure.message || '请稍后重试。',
      canRetry: !!failure.canRetry,
      canCancel: !!failure.canCancel
    })
  },

  onRetry: function () {
    if (!this.data.taskId) {
      wx.reLaunch({ url: INDEX_URL })
      return
    }
    this._start(this.data.taskId)
  },

  onCancel: function () {
    var self = this
    if (this.data.terminal && this.data.errorKind === 'cancelled') {
      wx.reLaunch({ url: INDEX_URL })
      return
    }
    wx.showModal({
      title: '取消生成',
      content: '取消后本次将返还额度，确定取消吗？',
      success: function (res) {
        if (!res.confirm) return
        self._doCancel()
      }
    })
  },

  _doCancel: function () {
    var self = this
    this._finish()
    return api
      .call('sinn-task', 'cancelTask', { taskId: this.data.taskId }, { requireConsent: true, timeoutMs: 8000 })
      .then(function () {
        clearActiveTask()
        self.setData({
          loading: false,
          terminal: true,
          errorKind: 'cancelled',
          errorTitle: '任务已取消',
          errorMessage: '本次生成已取消，额度已返还。',
          canRetry: false,
          canCancel: false
        })
        wx.reLaunch({ url: INDEX_URL })
      })
      .catch(function (error) {
        self.setData({ netNotice: api.getUserMessage(error) })
        wx.reLaunch({ url: INDEX_URL })
      })
  },

  onBackHome: function () {
    this._finish()
    clearActiveTask()
    wx.reLaunch({ url: INDEX_URL })
  }
})

module.exports = {
  RESULT_URL: RESULT_URL,
  INDEX_URL: INDEX_URL,
  CONSENT_URL: CONSENT_URL,
  ACTIVE_TASK_KEY: ACTIVE_TASK_KEY
}
