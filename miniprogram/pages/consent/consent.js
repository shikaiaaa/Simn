// consent.js —— 合规门禁页：18+ 声明 + 隐私单独同意（SPEC-0001 §6 / §F，AC-21 / AC-25）。
// 两步显式确认：第一步 18+ 与禁止条款；第二步 8 项个人信息披露 + 单独同意。
// 同意成功：微信隐私授权 → 服务端 recordConsent → 本地 sinn_consent_v1 → redirectTo capture。
// 拒绝：不写本地、不调用任何隐私接口，reLaunch 回首页只保留功能说明。
const api = require('../../services/api')
const consent = require('../../services/consent')
const clientCompat = require('../../utils/client-compat')

Page({
  data: {
    step: 1,
    ageConfirmed: false,
    termsAccepted: false,
    privacyAgreed: false,
    submitting: false,
    errorText: '',
    privacyPrompt: false,
    ageText: consent.AGE_TEXT,
    termsText: consent.TERMS_TEXT,
    privacyText: consent.PRIVACY_TEXT,
    genderNote: consent.GENDER_NOTE,
    draftNotice: consent.DRAFT_NOTICE,
    disclosures: consent.DISCLOSURES
  },

  onLoad() {
    // 低版本微信兜底（AC-28）：App.onLaunch 已提示升级，这里不进入业务/不调隐私接口。
    if (clientCompat.isClientTooOld()) return
    this._wx = wx
    // 与 wx.requirePrivacyAuthorize 合并：平台隐私请求时回到同意流程。
    this._privacyHandler = consent.installPrivacyHandler(wx, {
      onRequest: () => {
        this.setData({ step: 1, privacyPrompt: true })
      }
    })

    // 已同意（本地）→ 免重复同意，直接进入拍摄。
    const local = consent.readLocalConsent(wx)
    if (consent.ensureUploadAllowed({ consented: true, record: local })) {
      this.redirectCapture()
      return
    }
    this.refreshServerConsent()
  },

  onUnload() {
    if (typeof wx.offNeedPrivacyAuthorization === 'function') {
      try {
        wx.offNeedPrivacyAuthorization()
      } catch (e) {
        // 小程序基础库差异：忽略即可，不影响同意流程。
      }
    }
  },

  /** 本地无记录时用服务端 profile.consent 兜底（二次进入免重复同意）。 */
  refreshServerConsent() {
    api
      .call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
      .then(({ data }) => {
        const state = consent.resolveEntryState({
          localConsent: consent.readLocalConsent(wx),
          profileConsent: data && data.consent
        })
        if (state.consented) {
          consent.writeLocalConsent(wx, state.record)
          this.redirectCapture()
          return
        }
        this.setData({ privacyPrompt: false })
      })
      .catch(() => {
        // 网络失败：停留同意页，用户可继续阅读；不静默跳过同意。
        this.setData({ privacyPrompt: false })
      })
  },

  redirectCapture() {
    wx.redirectTo({ url: consent.CAPTURE_URL })
  },

  onToggleAge() {
    this.setData({ ageConfirmed: !this.data.ageConfirmed, errorText: '' })
  },

  onToggleTerms() {
    this.setData({ termsAccepted: !this.data.termsAccepted, errorText: '' })
  },

  onTogglePrivacy() {
    this.setData({ privacyAgreed: !this.data.privacyAgreed, errorText: '' })
  },

  /** 第一步 → 第二步；未显式勾选 18+ 与条款时不得继续（AC-25）。 */
  onStep1Next() {
    const check = consent.validateAgeStep({
      ageConfirmed: this.data.ageConfirmed,
      termsAccepted: this.data.termsAccepted
    })
    if (!check.ok) {
      this.setData({ errorText: check.message })
      return
    }
    this.setData({ step: 2, errorText: '' })
  },

  onStep2Back() {
    this.setData({ step: 1, errorText: '' })
  },

  /** 同意并继续：校验 → 隐私授权 → recordConsent → 本地缓存 → capture。 */
  onAgree() {
    if (this.data.submitting) return
    const consentCheck = consent.validateConsentStep({ privacyAgreed: this.data.privacyAgreed })
    if (!consentCheck.ok) {
      this.setData({ errorText: consentCheck.message })
      return
    }
    const ageCheck = consent.validateAgeStep({
      ageConfirmed: this.data.ageConfirmed,
      termsAccepted: this.data.termsAccepted
    })
    if (!ageCheck.ok) {
      this.setData({ step: 1, errorText: ageCheck.message })
      return
    }

    this.setData({ submitting: true, errorText: '' })
    return consent
      .submitConsent({
        wxRef: wx,
        now: Date.now(),
        ageConfirmed: true,
        termsAccepted: true,
        privacyAgreed: true,
        disclosures: consent.DISCLOSURES
      })
      .then((result) => {
        if (!result.ok) {
          this.setData({
            submitting: false,
            errorText: result.message || api.getUserMessage(result.error || result.code)
          })
          return
        }
        const handler = this._privacyHandler
        if (handler && typeof handler.resolve === 'function') handler.resolve('agree')
        this.redirectCapture()
      })
  },

  /** 拒绝：不触达任何隐私接口，回到首页功能说明。 */
  onReject() {
    const handler = this._privacyHandler
    if (handler && typeof handler.resolve === 'function') handler.resolve('disagree')
    wx.reLaunch({ url: consent.INDEX_URL })
  }
})
