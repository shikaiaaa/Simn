/**
 * 环境变量 -> sinn-task 运行时配置（DEV-0001-47 / task-57）。
 *
 * 抽成纯函数便于单测直接 require（index.js 依赖 wx-server-sdk，单测不加载它）。
 *
 * 环境变量登记（与 index.js 文件头注释保持一致）：
 * - SINN_TASK_TIMEOUT_MS：任务判超时阈值（正整数，单位 ms）。
 *   默认取 util.TASK_TIMEOUT_MS = 96000（SPEC v0.9 §2：96s 未成功判 TIMEOUT）。
 *   真实供应商（火山引擎图片换装 V2）排队+生成可能超过 96s，运维/测试可临时
 *   覆写该变量延长等待以验证真实时延；生产环境保持不配置（默认 96s）。
 *   未配置、非数字、<=0 时回退默认值，不会因脏值导致任务永不超时。
 *
 * 其余字段沿用 task-22 起的既有语义（dailyLimitNormal/Vip、vipWhitelist、vendorProvider）。
 */
'use strict'

var util = require('./util')

function num(env, key, fallback) {
  var value = Number(env[key])
  return isFinite(value) && value > 0 ? value : fallback
}

function createEnvConfig(env) {
  env = env || {}
  return {
    dailyLimitNormal: num(env, 'SINN_DAILY_LIMIT_NORMAL', 1),
    dailyLimitVip: num(env, 'SINN_DAILY_LIMIT_VIP', 10),
    vipWhitelist: String(env.SINN_VIP_WHITELIST || '')
      .split(',')
      .map(function (item) { return item.trim() })
      .filter(function (item) { return !!item }),
    vendorProvider: env.SINN_VENDOR || 'mock',
    taskTimeoutMs: num(env, 'SINN_TASK_TIMEOUT_MS', util.TASK_TIMEOUT_MS)
  }
}

module.exports = {
  createEnvConfig: createEnvConfig
}
