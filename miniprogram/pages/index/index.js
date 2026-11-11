// index.js —— 首页/功能说明（SPEC-0001 §A）
// 入口：开始试穿、继续上次生成、我的；只做导航与状态展示，不调用任何隐私接口。
const api = require('../../services/api')
const clientCompat = require('../../utils/client-compat')

Page({
  data: {
    loading: false,
    consented: false,
    hasActiveTask: false,
    activeTaskId: '',
    clientBlocked: false
  },

  onLoad() {
    this._applyClientCompat()
  },

  onShow() {
    if (this._applyClientCompat()) return
    this.refreshHomeState()
  },

  // 低版本微信（App.onLaunch 已判）时阻止渲染与请求。
  _applyClientCompat() {
    if (this.data.clientBlocked) return true
    if (!clientCompat.isClientTooOld()) return false
    this.setData({ clientBlocked: true })
    return true
  },

  /**
   * 首页状态：服务端 profile 优先，网络失败时用本地缓存兜底。
   * 不做推理、不调用隐私 API；未同意时开始入口仍可进入同意页（不触达隐私接口）。
   */
  refreshHomeState() {
    const localTask = api.getCachedActiveTask()
    const localState = api.resolveHomeState({ localActiveTask: localTask })
    this.setData({ loading: true, hasActiveTask: localState.hasActiveTask, activeTaskId: localState.activeTaskId, consented: localState.consented })

    api
      .call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
      .then(({ data }) => {
        const state = api.resolveHomeState({
          profileData: data,
          localActiveTask: localTask,
          consent: !!(data && data.consent)
        })
        this.setData({
          loading: false,
          consented: state.consented,
          hasActiveTask: state.hasActiveTask,
          activeTaskId: state.activeTaskId
        })
      })
      .catch(() => {
        // 网络/环境未就绪：保持本地缓存判断，页面仍可进入同意页或功能说明。
        this.setData({ loading: false })
      })
  },

  onStart() {
    if (this._applyClientCompat()) return
    const url = this.data.consented ? '/pages/capture/capture' : '/pages/consent/consent'
    wx.navigateTo({ url })
  },

  onResume() {
    if (this._applyClientCompat()) return
    if (!this.data.activeTaskId) return
    wx.navigateTo({ url: '/pages/generating/generating?taskId=' + encodeURIComponent(this.data.activeTaskId) })
  },

  onProfile() {
    if (this._applyClientCompat()) return
    wx.navigateTo({ url: '/pages/profile/profile' })
  }
})
