// app.js
// P1 采用微信云开发（SPEC-0001 D-1）：身份由云函数 wx.getWXContext().OPENID 提供，
// 端上只做采集/上传/轮询/展示，不在本地做推理或业务判定。
var env = require('./config/env')

App({
  onLaunch() {
    // 云开发环境 ID 的唯一出处在 config/env.js（CP-02）。
    // 环境未就绪时静默失败，不阻塞页面渲染，由各页面统一错误处理提示可行动文案。
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
    // 与 SPEC §B.4 对齐：默认 mock，真实供应商由云函数环境变量切换。
    vendor: 'mock',
    cloudReady: false
  }
})
