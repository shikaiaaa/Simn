/**
 * lib/debug-gate.js —— demo 调试门禁（task-29）。
 *
 * 用途：bootstrap / selftest 属于联调期调试入口，默认关闭；满足任一条件才放行：
 *   1) 云函数环境变量 SINN_SELFTEST === '1'（临时开启，跑完删除）；
 *   2) 调用方传入受控 gate token：event.gate === 'sinn-selftest-2026-11-10'
 *      （供 Lead/QA 用 automator 在无控制台环境变量时触发，demo 专用）。
 *
 * ⚠️ demo 调试门禁：上线前必须连同 bootstrap / selftest action 一起移除，
 * 并登记到 SPEC §G 人工卡点 / 上线差异清单（不能带进提交版本）。
 */
'use strict'

var errors = require('./errors')

var FLAG = 'SINN_SELFTEST'
var GATE_TOKEN = 'sinn-selftest-2026-11-10'

function isDebugActionEnabled(event, env) {
  env = env || {}
  var flag = env[FLAG]
  var text = flag === undefined || flag === null ? '' : String(flag)
  if (text === '1') return true
  return !!(event && typeof event.gate === 'string' && event.gate === GATE_TOKEN)
}

function assertDebugActionEnabled(event, env, action) {
  if (isDebugActionEnabled(event, env)) return
  var name = action || 'debug action'
  throw errors.fail(1004, {
    httpStatus: 403,
    message: name + ' 未启用',
    hint: 'demo 调试门禁：仅测试环境设置 SINN_SELFTEST=1，或传入受控 gate token；上线前必须移除 bootstrap/selftest 调试入口'
  })
}

module.exports = {
  FLAG: FLAG,
  GATE_TOKEN: GATE_TOKEN,
  isDebugActionEnabled: isDebugActionEnabled,
  assertDebugActionEnabled: assertDebugActionEnabled
}
