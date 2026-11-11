/**
 * pages/capture/capture.js —— 人像采集页（DEV-0001-06，SPEC §A / AC-1/2/3/4/5/25/26）。
 *
 * 链路：
 * 1) 进入页先校验同意状态（services/consent.js），未同意回 consent 页；
 * 2) 人像 1–3 张，可逐张重拍/删除；数值与性别本地校验，「下一步」不通过时禁用；
 * 3) 每张照片端上 L0 同步预检（services/precheck.js），拦截格式/体积/尺寸/比例/EXIF；
 * 4) 点「下一步」：逐张上传 + assetRegister（同一 clientReqId 幂等重试）→ 服务端 precheck；
 *    任一张未过即停留本页并给重拍建议，不进入 garment、不创建任务；
 * 5) 全部通过：把 { personAssetIds, metrics } 暂存内存（globalData / eventChannel），navigateTo garment。
 *    性别/围度等敏感值不写本地缓存（SPEC §C）。
 */
'use strict'

var api = require('../../services/api')
var consent = require('../../services/consent')
var precheck = require('../../services/precheck')
var upload = require('../../services/upload')

var MAX_PHOTOS = precheck.MAX_PHOTOS
var CAPTURE_URL = '/pages/capture/capture'
var CONSENT_URL = '/pages/consent/consent'
var GARMENT_URL = '/pages/garment/garment'
var PRECHECK_TARGET_MS = 5000

var GENDER_OPTIONS = [
  { value: 'unspecified', label: '不填' },
  { value: 'male', label: '男' },
  { value: 'female', label: '女' }
]

function getWx() {
  return typeof wx !== 'undefined' ? wx : null
}

function getAppRef() {
  return typeof getApp === 'function' ? getApp() : null
}

function toIndex(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

Page({
  data: {
    photos: [],
    heightCm: '',
    weightKg: '',
    gender: precheck.DEFAULT_GENDER,
    genderOptions: GENDER_OPTIONS,
    chestCm: '',
    waistCm: '',
    hipCm: '',
    maxPhotos: MAX_PHOTOS,
    canSubmit: false,
    formErrors: [],
    errorText: '',
    submitting: false,
    precheckNote: ''
  },

  onLoad: function () {
    this._wx = getWx()
    this._deleted = false
    if (!this._ensureConsent()) return
    this._refreshCanSubmit()
  },

  onUnload: function () {
    this._deleted = true
  },

  /** 同意门禁：未完成 18+ 与隐私单独同意时回 consent 页（AC-25）。 */
  _ensureConsent: function () {
    var state = consent.resolveEntryState({ localConsent: consent.readLocalConsent(this._wx) })
    if (!consent.ensureUploadAllowed(state)) {
      this._wx.redirectTo({ url: CONSENT_URL })
      return false
    }
    return true
  },

  _formValue: function () {
    return {
      photos: this.data.photos,
      heightCm: this.data.heightCm,
      weightKg: this.data.weightKg,
      gender: this.data.gender,
      chestCm: this.data.chestCm,
      waistCm: this.data.waistCm,
      hipCm: this.data.hipCm
    }
  },

  _refreshCanSubmit: function () {
    var check = precheck.validateCaptureForm(this._formValue())
    var patch = {
      canSubmit: check.ok && !this.data.submitting,
      formErrors: check.errors,
      normalizedForm: check.normalized
    }
    this.setData(patch)
    return check
  },

  /** 数值/性别输入。 */
  onInputField: function (event) {
    var field = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.field : ''
    var value = event && event.detail ? event.detail.value : ''
    if (!field) return
    var patch = {}
    patch[field] = value
    this.setData(patch)
    this._refreshCanSubmit()
  },

  onSelectGender: function (event) {
    var value = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.value : ''
    if (precheck.GENDERS.indexOf(value) < 0) return
    this.setData({ gender: value })
    this._refreshCanSubmit()
  },

  /** 选择/重拍一张照片。data-index 为空或 -1 表示追加，否则替换该张。 */
  onPickPhoto: function (event) {
    var self = this
    var index = toIndex(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.index : -1, -1)
    if (index < 0 && this.data.photos.length >= MAX_PHOTOS) {
      this.setData({ errorText: '最多上传 ' + MAX_PHOTOS + ' 张人像照片' })
      return Promise.resolve(null)
    }
    return this._choosePhoto().then(
      function (file) {
        if (!file) return null
        return self._buildPhoto(file).then(function (built) {
          if (!built.ok) {
            self.setData({ errorText: built.message })
            return built
          }
          var photos = self.data.photos.slice()
          if (index >= 0 && index < photos.length) photos[index] = built.photo
          else photos.push(built.photo)
          self.setData({ photos: photos, errorText: '' })
          self._refreshCanSubmit()
          return built
        })
      },
      function () {
        return null
      }
    )
  },

  onRemovePhoto: function (event) {
    var index = toIndex(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.index : -1, -1)
    if (index < 0 || index >= this.data.photos.length) return
    var photos = this.data.photos.slice()
    photos.splice(index, 1)
    this.setData({ photos: photos, errorText: '' })
    this._refreshCanSubmit()
  },

  onRetryPhoto: function (event) {
    return this.onPickPhoto(event)
  },

  /** wx.chooseMedia 包装：只取第一张，失败返回 null。 */
  _choosePhoto: function () {
    var self = this
    return new Promise(function (resolve) {
      var w = self._wx
      if (!w || typeof w.chooseMedia !== 'function') {
        resolve(null)
        return
      }
      w.chooseMedia({
        count: MAX_PHOTOS,
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

  /** 读取图片尺寸/方向并做 L0 同步预检；返回 {ok, message, photo}。 */
  _buildPhoto: function (file) {
    var self = this
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
      self._lastL0Ms = Date.now() - started
      if (!l0.ok) {
        return { ok: false, code: l0.code, message: l0.message, photo: null }
      }
      return {
        ok: true,
        message: '',
        photo: {
          path: meta.path,
          size: meta.size,
          width: meta.width,
          height: meta.height,
          mime: meta.mime,
          orientation: meta.orientation,
          assetId: '',
          status: 'ready',
          l0Ms: self._lastL0Ms,
          precheck: null
        }
      }
    })
  },

  /** wx.getImageInfo 包装；API 不可用时按信息缺失处理（L0 会拦截）。 */
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

  /** 点击「下一步」：上传 + 服务端预检，全部通过才跳 garment。 */
  onNext: function () {
    var self = this
    if (this.data.submitting) return Promise.resolve(null)
    var check = this._refreshCanSubmit()
    if (!check.ok) {
      this.setData({ errorText: precheck.buildFormErrorText(check.errors) })
      return Promise.resolve(null)
    }

    this.setData({ submitting: true, errorText: '', precheckNote: '' })
    var photos = this.data.photos.slice()
    var progress = { passed: 0, total: photos.length }

    var chain = Promise.resolve()
    photos.forEach(function (photo, index) {
      chain = chain.then(function () {
        return self._ensurePhotoAsset(photos, index).then(function () {
          progress.passed += 1
          self.setData({ precheckNote: '预检通过 ' + progress.passed + '/' + progress.total })
        })
      })
    })

    return chain
      .then(function () {
        if (self._deleted) return null
        var normalized = check.normalized || {}
        var draft = {
          personAssetIds: photos.map(function (p) {
            return p.assetId
          }),
          metrics: normalized.metrics || null,
          createdAt: Date.now()
        }
        self._draft = draft
        var app = getAppRef()
        if (app && app.globalData) app.globalData.captureDraft = draft
        self.setData({ photos: photos.slice(), submitting: false, canSubmit: true })
        self._navigateToGarment(draft)
        return draft
      })
      .catch(function (error) {
        if (self._deleted) return null
        self.setData({
          photos: photos.slice(),
          submitting: false,
          canSubmit: true,
          errorText: (error && error.message) || '处理失败，请重试'
        })
        return null
      })
  },

  /** 单张照片：上传失败可重试（同 clientReqId）→ 服务端 precheck 未过则抛错停留。 */
  _ensurePhotoAsset: function (photos, index) {
    var self = this
    var photo = photos[index]
    if (photo.assetId && photo.precheck && photo.precheck.status === 'pass') {
      return Promise.resolve(photo.assetId)
    }
    var clientReqId = photo.clientReqId || api.createClientReqId()
    photos[index].clientReqId = clientReqId
    return upload
      .uploadPersonPhoto({
        wxRef: this._wx,
        clientReqId: clientReqId,
        filePath: photo.path,
        mime: photo.mime,
        bytes: photo.size,
        width: photo.width,
        height: photo.height
      })
      .then(function (up) {
        if (!up.ok) {
          photos[index].status = 'upload_failed'
          throw { code: up.code, name: up.name, message: up.message, hint: up.hint }
        }
        photos[index].assetId = up.assetId
        photos[index].status = 'uploaded'
        self.setData({ photos: photos.slice() })
        return precheck.runServerPrecheck(up.assetId, { timeoutMs: 8000 }).then(function (pc) {
          self._lastPrecheckMs = pc.elapsedMs
          self._lastPrecheckWithinTarget = precheck.isPrecheckWithinTarget(pc.elapsedMs, PRECHECK_TARGET_MS)
          photos[index].precheck = {
            status: pc.pass ? 'pass' : pc.status || 'fail',
            code: pc.code,
            message: pc.message,
            hint: pc.hint,
            checks: pc.checks,
            elapsedMs: pc.elapsedMs
          }
          photos[index].status = pc.pass ? 'prechecked' : 'precheck_failed'
          self.setData({
            photos: photos.slice(),
            precheckNote: (PC_NOTE(pc) || '') + ''
          })
          if (!pc.pass) {
            throw {
              code: pc.code,
              name: pc.name,
              message: pc.message || precheck.getPrecheckAdvice(pc.code),
              hint: pc.hint
            }
          }
          return up.assetId
        })
      })
  },

  /** 跳 garment 页：优先 eventChannel 传内存草稿，同时写 globalData 兜底。 */
  _navigateToGarment: function (draft) {
    var self = this
    this._wx.navigateTo({
      url: GARMENT_URL,
      success: function (res) {
        if (res && res.eventChannel && typeof res.eventChannel.emit === 'function') {
          res.eventChannel.emit('capture-draft', draft)
        }
      },
      fail: function () {
        self.setData({ errorText: '页面跳转失败，请重试' })
      }
    })
  }
})

/** 预检耗时的用户可见提示（AC-2 证据）。 */
function PC_NOTE(pc) {
  var elapsed = pc && typeof pc.elapsedMs === 'number' ? pc.elapsedMs : 0
  return '预检耗时 ' + elapsed + 'ms'
}

module.exports = {
  CAPTURE_URL: CAPTURE_URL,
  GARMENT_URL: GARMENT_URL,
  GENDER_OPTIONS: GENDER_OPTIONS
}
