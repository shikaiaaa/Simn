// profile.js —— 我的页（DEV-0001-09 / SPEC-0001 §A、§B.2、§C、AC-11、AC-21）
//
// 职责：
// - 展示剩余次数、每日重置时间、VIP 标识（AC-11），额度缓存按 SPEC §C 的
//   `sinn_quota_cache_v1`（{used,limit,remaining,vip,dayKey,resetAt,upto}）做 60s TTL；
// - 删除全部数据：二次确认 → sinn-account/deleteAll（物理全删、无墓碑）→ 清本地缓存 → 回首页；
//   今日已用额度不重置（服务端 users.usedToday 不变）；
// - 撤回同意：二次确认 → sinn-account/revokeConsent（物理删全部 + 置撤回）→ 清本地同意与缓存 → 回首页重新同意；
//   同意审计记录保留在服务端，且不含照片/围度/性别；
// - 无分享/保存/购买/商家入口（AC-23），文案不含 BR-10 红线。
//
// 说明：本文件的纯函数在 require 阶段不访问 wx.*（wxRef/now 由调用方传入），便于 jest 直接加载。

'use strict'

var api = require('../../services/api')
var consent = require('../../services/consent')

var QUOTA_CACHE_KEY = api.STORAGE_KEYS.QUOTA
var QUOTA_TTL_MS = 60 * 1000
var INDEX_URL = '/pages/index/index'
var CONSENT_URL = '/pages/consent/consent'
var RESET_FALLBACK = '额度每日 00:00（北京时间）重置'
var CACHE_CLEAR_KEYS = [api.STORAGE_KEYS.ACTIVE_TASK, api.STORAGE_KEYS.QUOTA]

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function asNow(now) {
  return typeof now === 'number' && isFinite(now) ? now : Date.now()
}

/** 服务端 quota → 规范化对象；非法返回 null（不编造额度）。 */
function normalizeQuota(raw) {
  if (!raw || typeof raw !== 'object') return null
  var used = Number(raw.used)
  var limit = Number(raw.limit)
  if (!isFinite(used) || !isFinite(limit) || used < 0 || limit < 0) return null
  var remaining = Number(raw.remaining)
  if (!isFinite(remaining)) remaining = Math.max(0, limit - used)
  return {
    used: Math.floor(used),
    limit: Math.floor(limit),
    remaining: Math.max(0, Math.floor(remaining)),
    vip: !!raw.vip,
    dayKey: typeof raw.dayKey === 'string' ? raw.dayKey : '',
    resetAt: typeof raw.resetAt === 'number' && isFinite(raw.resetAt) ? raw.resetAt : 0
  }
}

/** 服务端 resetAt（epoch ms）→ 「每日 00:00 重置（北京时间）」，不依赖运行环境时区。 */
function formatResetAt(resetAt) {
  if (typeof resetAt !== 'number' || !isFinite(resetAt) || resetAt <= 0) return RESET_FALLBACK
  var beijing = new Date(resetAt + 8 * 3600 * 1000)
  var hh = pad2(beijing.getUTCHours())
  var mm = pad2(beijing.getUTCMinutes())
  return '每日 ' + hh + ':' + mm + ' 重置（北京时间）'
}

/** 额度展示模型（AC-11：剩余次数 + 每日重置时间 + VIP 标识）。 */
function buildQuotaView(quota) {
  var view = normalizeQuota(quota)
  if (!view) {
    return {
      available: false,
      used: 0,
      limit: 0,
      remaining: 0,
      vip: false,
      badgeText: '',
      quotaText: '额度加载中…',
      resetText: RESET_FALLBACK,
      vipText: ''
    }
  }
  return {
    available: true,
    used: view.used,
    limit: view.limit,
    remaining: view.remaining,
    vip: view.vip,
    badgeText: view.vip ? 'VIP' : '',
    quotaText: '今日剩余 ' + view.remaining + ' / ' + view.limit + ' 次',
    resetText: formatResetAt(view.resetAt),
    vipText: view.vip ? 'VIP 每日 ' + view.limit + ' 次' : '普通用户每日 ' + view.limit + ' 次'
  }
}

function formatAgreedAt(agreedAt) {
  if (typeof agreedAt !== 'number' || !isFinite(agreedAt) || agreedAt <= 0) return ''
  var beijing = new Date(agreedAt + 8 * 3600 * 1000)
  return beijing.getUTCFullYear() + '-' + pad2(beijing.getUTCMonth() + 1) + '-' + pad2(beijing.getUTCDate())
}

/** 同意状态展示模型（撤回后显示「未同意」，引导重新同意）。 */
function buildConsentView(record) {
  if (!record || !record.version) {
    return {
      consented: false,
      consentText: '未同意',
      consentDetail: '完成 18+ 确认与隐私单独同意后才能使用试穿生成功能。'
    }
  }
  var dateText = formatAgreedAt(record.agreedAt)
  return {
    consented: true,
    consentText: '已同意',
    consentDetail: '同意版本 ' + record.version + (dateText ? '（' + dateText + '）' : '')
  }
}

/** 生成 SPEC §C 的额度缓存对象。 */
function createQuotaCache(quota, now) {
  var view = normalizeQuota(quota)
  if (!view) return null
  return {
    used: view.used,
    limit: view.limit,
    remaining: view.remaining,
    vip: view.vip,
    dayKey: view.dayKey,
    resetAt: view.resetAt,
    upto: asNow(now)
  }
}

/** 缓存是否仍在 60s TTL 内（时钟回拨视为过期，不信任）。 */
function isQuotaCacheFresh(cache, now) {
  if (!cache || typeof cache.upto !== 'number' || !isFinite(cache.upto)) return false
  var delta = asNow(now) - cache.upto
  return delta >= 0 && delta < QUOTA_TTL_MS
}

/** 读取额度缓存：返回 { quota, upto, fresh } 或 null（非法/损坏一律按无缓存）。 */
function readQuotaCache(wxRef, now) {
  try {
    var raw = wxRef && typeof wxRef.getStorageSync === 'function' ? wxRef.getStorageSync(QUOTA_CACHE_KEY) : ''
    if (!raw) return null
    var value = typeof raw === 'string' ? JSON.parse(raw) : raw
    var quota = normalizeQuota(value)
    if (!quota || typeof value.upto !== 'number') return null
    return { quota: quota, upto: value.upto, fresh: isQuotaCacheFresh(value, now) }
  } catch (error) {
    return null
  }
}

/** 写入额度缓存（SPEC §C schema，60s TTL 由 upto 计算）。 */
function writeQuotaCache(wxRef, quota, now) {
  var cache = createQuotaCache(quota, now)
  if (!cache) return null
  try {
    if (wxRef && typeof wxRef.setStorageSync === 'function') {
      wxRef.setStorageSync(QUOTA_CACHE_KEY, JSON.stringify(cache))
    }
  } catch (error) {
    // 缓存写失败不影响主流程（下一次进入重新拉取）。
  }
  return cache
}

function clearQuotaCache(wxRef) {
  try {
    if (wxRef && typeof wxRef.removeStorageSync === 'function') wxRef.removeStorageSync(QUOTA_CACHE_KEY)
    return true
  } catch (error) {
    return false
  }
}

/**
 * 清本地用户缓存（删除全部 / 撤回同意后统一调用）。
 * - 始终清：sinn_active_task_v1、sinn_quota_cache_v1；
 * - clearConsent=true 时额外清 sinn_consent_v1（仅撤回同意场景；deleteAll 保留同意状态）。
 */
function clearUserCaches(wxRef, options) {
  var opts = options || {}
  var removed = []
  for (var i = 0; i < CACHE_CLEAR_KEYS.length; i += 1) {
    try {
      if (wxRef && typeof wxRef.removeStorageSync === 'function') {
        wxRef.removeStorageSync(CACHE_CLEAR_KEYS[i])
        removed.push(CACHE_CLEAR_KEYS[i])
      }
    } catch (error) {
      // 单个 key 清理失败不阻塞其它 key。
    }
  }
  if (opts.clearConsent) {
    try {
      consent.clearLocalConsent(wxRef)
      removed.push(api.STORAGE_KEYS.CONSENT)
    } catch (error) {
      // ignore
    }
  }
  return removed
}

Page({
  data: {
    quota: buildQuotaView(null),
    consentView: buildConsentView(null),
    hasData: false,
    activeTaskId: '',
    loading: true,
    busy: false,
    errorText: '',
    noticeText: '删除全部数据会物理删除所有试穿记录与照片，且不会重置今日已用额度。',
    deleteAllText: '删除全部数据',
    revokeText: '撤回同意'
  },

  onLoad: function () {
    this._wx = typeof wx !== 'undefined' ? wx : null
  },

  onShow: function () {
    this.refreshProfile({ now: Date.now() })
  },

  onPullDownRefresh: function () {
    this.refreshProfile({ now: Date.now(), force: true, stopPullDown: true })
  },

  /**
   * 刷新额度与账户状态。
   * @param {{now?:number, force?:boolean, stopPullDown?:boolean}} options
   */
  refreshProfile: function (options) {
    var opts = options || {}
    var self = this
    var wxRef = typeof wx !== 'undefined' ? wx : null
    var now = asNow(opts.now)
    var cached = readQuotaCache(wxRef, now)

    if (cached) {
      this.applyQuota(cached.quota)
      if (cached.fresh && !opts.force) {
        this.setData({ loading: false })
        if (opts.stopPullDown) this._stopPullDown(wxRef)
        return
      }
    }

    this.setData({ loading: !cached })

    return api
      .call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
      .then(function (res) {
        var data = (res && res.data) || {}
        var quota = normalizeQuota(data.quota)
        if (quota) {
          writeQuotaCache(wxRef, quota, now)
          self.applyQuota(quota)
        }
        self.setData({
          consentView: buildConsentView(data.consent),
          hasData: !!data.hasData,
          activeTaskId: data.activeTaskId || '',
          loading: false,
          errorText: ''
        })
      })
      .catch(function (error) {
        self.setData({
          loading: false,
          errorText: cached ? '' : '额度加载失败，请下拉刷新重试（' + api.getUserMessage(error) + '）'
        })
      })
      .then(function () {
        if (opts.stopPullDown) self._stopPullDown(wxRef)
      })
  },

  applyQuota: function (quota) {
    this.setData({ quota: buildQuotaView(quota) })
  },

  _stopPullDown: function (wxRef) {
    try {
      if (wxRef && typeof wxRef.stopPullDownRefresh === 'function') wxRef.stopPullDownRefresh()
    } catch (error) {
      // ignore
    }
  },

  /** 删除全部数据：二次确认 → deleteAll（物理全删）→ 清本地缓存（保留同意）→ 回首页。 */
  onDeleteAll: function () {
    var self = this
    if (this.data.busy) return
    var wxRef = typeof wx !== 'undefined' ? wx : null
    wxRef.showModal({
      title: '删除全部数据？',
      content: '将物理删除所有试穿记录、照片与结果图，删除后不可恢复；今日已用额度不会重置。',
      confirmText: '删除',
      cancelText: '取消',
      confirmColor: '#d93026',
      success: function (res) {
        if (!res || !res.confirm) return
        self.setData({ busy: true, errorText: '' })
        api
          .call('sinn-account', 'deleteAll', {}, { timeoutMs: 15000 })
          .then(function () {
            clearUserCaches(wxRef, { clearConsent: false })
            self.setData({ busy: false, hasData: false, activeTaskId: '' })
            wxRef.showToast({ title: '已删除全部数据', icon: 'success' })
            wxRef.reLaunch({ url: INDEX_URL })
          })
          .catch(function (error) {
            var message = api.getUserMessage(error)
            self.setData({ busy: false, errorText: message })
            wxRef.showToast({ title: message, icon: 'none' })
          })
      }
    })
  },

  /** 撤回同意：二次确认 → revokeConsent（物理删全部 + 置撤回）→ 清同意与本地缓存 → 回首页重新同意。 */
  onRevokeConsent: function () {
    var self = this
    if (this.data.busy) return
    var wxRef = typeof wx !== 'undefined' ? wx : null
    wxRef.showModal({
      title: '撤回同意？',
      content: '撤回后将物理删除全部试穿数据，并清除本机同意记录；再次使用需重新完成 18+ 确认与隐私单独同意。',
      confirmText: '撤回',
      cancelText: '取消',
      confirmColor: '#d93026',
      success: function (res) {
        if (!res || !res.confirm) return
        self.setData({ busy: true, errorText: '' })
        api
          .call('sinn-account', 'revokeConsent', {}, { timeoutMs: 15000 })
          .then(function () {
            clearUserCaches(wxRef, { clearConsent: true })
            self.setData({
              busy: false,
              hasData: false,
              activeTaskId: '',
              consentView: buildConsentView(null)
            })
            wxRef.showToast({ title: '已撤回同意', icon: 'success' })
            wxRef.reLaunch({ url: INDEX_URL })
          })
          .catch(function (error) {
            var message = api.getUserMessage(error)
            self.setData({ busy: false, errorText: message })
            wxRef.showToast({ title: message, icon: 'none' })
          })
      }
    })
  },

  onGoConsent: function () {
    var wxRef = typeof wx !== 'undefined' ? wx : null
    wxRef.navigateTo({ url: CONSENT_URL })
  },

  onBackHome: function () {
    var wxRef = typeof wx !== 'undefined' ? wx : null
    wxRef.reLaunch({ url: INDEX_URL })
  }
})

module.exports = {
  QUOTA_CACHE_KEY: QUOTA_CACHE_KEY,
  QUOTA_TTL_MS: QUOTA_TTL_MS,
  INDEX_URL: INDEX_URL,
  CONSENT_URL: CONSENT_URL,
  RESET_FALLBACK: RESET_FALLBACK,
  normalizeQuota: normalizeQuota,
  formatResetAt: formatResetAt,
  buildQuotaView: buildQuotaView,
  buildConsentView: buildConsentView,
  createQuotaCache: createQuotaCache,
  isQuotaCacheFresh: isQuotaCacheFresh,
  readQuotaCache: readQuotaCache,
  writeQuotaCache: writeQuotaCache,
  clearQuotaCache: clearQuotaCache,
  clearUserCaches: clearUserCaches
}
