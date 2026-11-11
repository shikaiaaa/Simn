/**
 * pages/garment/garment.js —— 衣服采集页（DEV-0001-06，SPEC §A / AC-6/24）。
 *
 * 链路：
 * 1) 进入页校验同意状态；从内存草稿（capture 页 globalData / eventChannel）取 personAssetIds + metrics，
 *    草稿缺失则回 capture 页（不允许直接进入）；
 * 2) 单张上装照片，端上 L0 同步预检；点「开始生成」上传 + assetRegister → 服务端 precheck；
 *    服务端拦截吊牌/多件/模特上身/电商图等，停留本页并提示重拍建议，**不调用 createTask**（AC-24）；
 * 3) 预检通过后调 createTask（同 clientReqId 可幂等重试，不重复扣额度），成功 navigateTo generating。
 *    性别/围度只从内存草稿随 createTask 提交，不写本地缓存（SPEC §C）。
 */
'use strict'

var api = require('../../services/api')
var consent = require('../../services/consent')
var precheck = require('../../services/precheck')
var upload = require('../../services/upload')

var CAPTURE_URL = '/pages/capture/capture'
var CONSENT_URL = '/pages/consent/consent'
var GENERATING_URL = '/pages/generating/generating'
var CREATE_TASK_TIMEOUT_MS = 15000

function getWx() {
  return typeof wx !== 'undefined' ? wx : null
}

function getAppRef() {
  return typeof getApp === 'function' ? getApp() : null
}

function assign(target) {
  var out = target || {}
  for (var i = 1; i < arguments.length; i += 1) {
    var src = arguments[i] || {}
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key]
    }
  }
  return out
}

Page({
  data: {
    photo: null,
    draft: null,
    canSubmit: false,
    submitting: false,
    errorText: '',
    acceptHint: precheck.GARMENT_ACCEPT_HINT
  },

  onLoad: function (options) {
    this._wx = getWx()
    this._deleted = false
    if (!this._ensureConsent()) return
    var draft = this._readDraft(options)
    if (!draft || !Array.isArray(draft.personAssetIds) || !draft.personAssetIds.length || !draft.metrics) {
      this._wx.redirectTo({ url: CAPTURE_URL })
      return
    }
    this.setData({ draft: draft })
  },

  onUnload: function () {
    this._deleted = true
  },

  _ensureConsent: function () {
    var state = consent.resolveEntryState({ localConsent: consent.readLocalConsent(this._wx) })
    if (!consent.ensureUploadAllowed(state)) {
      this._wx.redirectTo({ url: CONSENT_URL })
      return false
    }
    return true
  },

  /** 读取 capture 页内存草稿：globalData 优先，eventChannel 兜底。 */
  _readDraft: function (options) {
    var app = getAppRef()
    if (app && app.globalData && app.globalData.captureDraft) {
      var draft = app.globalData.captureDraft
      if (draft && Array.isArray(draft.personAssetIds) && draft.personAssetIds.length) return draft
    }
    try {
      var channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
      if (channel && typeof channel.on === 'function') {
        var received = null
        channel.on('capture-draft', function (value) {
          received = value
        })
        if (received) return received
      }
    } catch (e) {
      // ignore
    }
    return null
  },

  _refreshCanSubmit: function () {
    var check = precheck.validateGarmentForm({ photo: this.data.photo })
    this.setData({ canSubmit: check.ok && !this.data.submitting })
    return check
  },

  onPickPhoto: function () {
    var self = this
    return this._choosePhoto().then(function (file) {
      if (!file) return null
      return self._buildPhoto(file).then(function (built) {
        if (!built.ok) {
          self.setData({ errorText: built.message })
          return built
        }
        self.setData({ photo: built.photo, errorText: '' })
        self._refreshCanSubmit()
        return built
      })
    })
  },

  onRemovePhoto: function () {
    this.setData({ photo: null, errorText: '' })
    this._refreshCanSubmit()
  },

  _choosePhoto: function () {
    var self = this
    return new Promise(function (resolve) {
      var w = self._wx
      if (!w || typeof w.chooseMedia !== 'function') {
        resolve(null)
        return
      }
      w.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['original', 'compressed'],
        success: function (res) {
          var files = (res && res.tempFiles) || []
          resolve(files[0] || null)
        },
        fail: function () {
          resolve(null)
        }
      })
    })
  },

  _readImageInfo: function (file) {
    var self = this
    var src = (file && (file.tempFilePath || file.path)) || ''
    return new Promise(function (resolve) {
      var w = self._wx
      if (!src || !w || typeof w.getImageInfo !== 'function') {
        resolve(null)
        return
      }
      w.getImageInfo({
        src: src,
        success: function (info) {
          resolve(info || null)
        },
        fail: function () {
          resolve(null)
        }
      })
    })
  },

  _buildPhoto: function (file) {
    var started = Date.now()
    return this._readImageInfo(file).then(function (info) {
      var meta = precheck.normalizePhotoMeta({
        path: (file && (file.tempFilePath || file.path)) || '',
        size: file && file.size,
        width: info && info.width,
        height: info && info.height,
        orientation: (info && info.orientation) || 'up',
        type: (file && file.fileType) || ''
      })
      var l0 = precheck.validateImageL0(meta)
      if (!l0.ok) return { ok: false, code: l0.code, message: l0.message, photo: null }
      return {
        ok: true,
        photo: {
          path: meta.path,
          size: meta.size,
          width: meta.width,
          height: meta.height,
          mime: meta.mime,
          orientation: meta.orientation,
          assetId: '',
          status: 'ready',
          l0Ms: Date.now() - started
        }
      }
    })
  },

  /** 「开始生成」：上传 + 端上登记 → 服务端预检 → createTask → generating。 */
  onStart: function () {
    var self = this
    if (this.data.submitting) return Promise.resolve(null)
    var check = precheck.validateGarmentForm({ photo: this.data.photo })
    if (!check.ok) {
      this.setData({ errorText: precheck.buildFormErrorText(check.errors) })
      return Promise.resolve(null)
    }

    this.setData({ submitting: true, errorText: '' })
    var photo = this.data.photo
    var garmentReqId = this._garmentReqId || api.createClientReqId()
    this._garmentReqId = garmentReqId
    var garmentAssetId = ''

    return upload
      .uploadGarmentPhoto({
        wxRef: this._wx,
        clientReqId: garmentReqId,
        filePath: photo.path,
        mime: photo.mime,
        bytes: photo.size,
        width: photo.width,
        height: photo.height
      })
      .then(function (up) {
        if (!up.ok) {
          throw { code: up.code, name: up.name, message: up.message, hint: up.hint }
        }
        garmentAssetId = up.assetId
        self.setData({ photo: assign({}, photo, { assetId: up.assetId, status: 'uploaded' }) })
        return precheck.runServerPrecheck(up.assetId, { timeoutMs: 8000 })
      })
      .then(function (pc) {
        if (!pc.pass) {
          var advice = pc.message || precheck.getPrecheckAdvice(pc.code)
          self.setData({
            photo: assign({}, self.data.photo, {
              status: 'precheck_failed',
              precheck: { status: pc.status, code: pc.code, message: pc.message, hint: pc.hint }
            }),
            errorText: advice + ' ' + precheck.GARMENT_ACCEPT_HINT
          })
          throw { handled: true }
        }
        self.setData({
          photo: assign({}, self.data.photo, {
            status: 'prechecked',
            precheck: { status: 'pass', code: 0, message: '', hint: pc.hint }
          })
        })
        var taskReqId = self._taskReqId || api.createClientReqId()
        self._taskReqId = taskReqId
        return api.call(
          'sinn-task',
          'createTask',
          {
            clientReqId: taskReqId,
            personAssetIds: self.data.draft.personAssetIds,
            garmentAssetId: garmentAssetId,
            metrics: self.data.draft.metrics
          },
          { requireConsent: true, idempotent: false, timeoutMs: CREATE_TASK_TIMEOUT_MS }
        )
      })
      .then(function (res) {
        var data = (res && res.data) || {}
        var app = getAppRef()
        if (app && app.globalData) app.globalData.captureDraft = null
        self.setData({ submitting: false, canSubmit: true })
        if (self._deleted) return null
        if (!data.taskId) {
          self.setData({ errorText: '任务创建失败，请重试' })
          return null
        }
        self._wx.navigateTo({ url: GENERATING_URL + '?taskId=' + encodeURIComponent(data.taskId) })
        return data
      })
      .catch(function (error) {
        if (self._deleted) return null
        self.setData({ submitting: false, canSubmit: true })
        if (error && error.handled) return null
        var message = (error && (error.message || api.getUserMessage(error))) || '生成失败，请重试'
        self.setData({ errorText: message })
        if (error && error.code === 2002) self._resumeActiveTask()
        return null
      })
  },

  /** E_ACTIVE_TASK_EXISTS 时用 profile 主动恢复进行中任务。 */
  _resumeActiveTask: function () {
    var self = this
    return api
      .call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
      .then(function (res) {
        var data = (res && res.data) || {}
        if (!data.activeTaskId) return null
        self._wx.navigateTo({ url: GENERATING_URL + '?taskId=' + encodeURIComponent(data.activeTaskId) })
        return data.activeTaskId
      })
      .catch(function () {
        return null
      })
  }
})

module.exports = {
  CAPTURE_URL: CAPTURE_URL,
  GENERATING_URL: GENERATING_URL
}
