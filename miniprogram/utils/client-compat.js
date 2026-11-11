// client-compat.js —— 低版本微信兜底（SPEC-0001 v0.10 §D-6/§E，AC-28）
// 方案 A：skyline 基线不变；旧版（约微信 <8.0.30 / 基础库 <3.0.0）只做原生升级提示。
'use strict'

// API 缺失即低版本（不调用不存在的 API）；isSupported 明确 false 或异常均判不支持。
function isSkylineSupported() {
  if (typeof wx === 'undefined' || typeof wx.getSkylineInfo !== 'function') return false
  try {
    var info = wx.getSkylineInfo()
    return !(info && info.isSupported === false)
  } catch (e) {
    return false
  }
}

// 业务页兜底：App.onLaunch 已判定低版本时，页面 onLoad/onShow 直接 return。
function isClientTooOld() {
  try {
    var app = typeof getApp === 'function' ? getApp() : null
    return !!(app && app.globalData && app.globalData.clientTooOld === true)
  } catch (e) {
    return false
  }
}

module.exports = { isSkylineSupported: isSkylineSupported, isClientTooOld: isClientTooOld }
