// app.js
// P1 采用微信云开发（SPEC-0001 D-1）：身份由 wx.getWXContext().OPENID 提供，端上不做推理。
var env = require('./config/env')
var clientCompat = require('./utils/client-compat')

App({
  onLaunch() {
    // 低版本微信兜底（SPEC v0.10 §D-6/§E，AC-28）：最先执行，先于云初始化/请求/Storage/隐私 API；
    // 旧版只走原生 wx.showModal + wx.exitMiniProgram，不新增页面、不进入业务。
    if (!clientCompat.isSkylineSupported()) {
      this.globalData.clientTooOld = true
      wx.showModal({
        title: '需要升级微信',
        content: '当前微信版本过低（需 8.0.30 及以上）才能使用试穿功能，请在应用商店升级后重试。',
        showCancel: false,
        confirmText: '知道了',
        success: function () {
          wx.exitMiniProgram()
        }
      })
      return
    }
    // 云开发环境 ID 唯一出处 config/env.js（CP-02）；环境未就绪静默失败，由各页统一提示。
    if (wx.cloud && typeof wx.cloud.init === 'function') {
      try {
        wx.cloud.init({ env: env.ENV_ID, traceUser: true })
        this._setCloudReady(true)
      } catch (e) {
        this._setCloudReady(false)
      }
    }
  },

  _setCloudReady(ready) {
    if (this.globalData) {
      this.globalData.cloudReady = ready
    }
  },

  globalData: {
    // SPEC §B.4：默认 mock，真实供应商由云函数环境变量切换；clientTooOld 由 onLaunch 置位。
    vendor: 'mock',
    cloudReady: false,
    clientTooOld: false
  }
})
