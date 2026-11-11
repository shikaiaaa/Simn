/**
 * tests/unit/cloudfunctions/task/env-config.test.js
 *
 * task-57（DEV-0001-47）：环境变量 -> sinn-task 运行时配置。
 * 重点验证 SINN_TASK_TIMEOUT_MS 超时覆写：
 * - 合法正整数生效（用于真实供应商时延验证）；
 * - 未配置 / 非法值（非数字、空串、0、负数、Infinity）→ 回退 util.TASK_TIMEOUT_MS=96000；
 * - 其他既有字段语义不变（额度、VIP 白名单、供应商 provider）。
 * 全离线，不加载 wx-server-sdk、不访问网络。
 */
'use strict'

var envConfig = require('../../../../cloudfunctions/sinn-task/lib/env-config')
var util = require('../../../../cloudfunctions/sinn-task/lib/util')

var createEnvConfig = envConfig.createEnvConfig

describe('task-57 env-config：SINN_TASK_TIMEOUT_MS 覆写', function () {
  test('未配置 → taskTimeoutMs 回退 96000（生产默认，SPEC §2）', function () {
    var config = createEnvConfig({})
    expect(config.taskTimeoutMs).toBe(util.TASK_TIMEOUT_MS)
    expect(config.taskTimeoutMs).toBe(96000)
  })

  test('SINN_TASK_TIMEOUT_MS=300000 → 生效（真实供应商时延验证场景）', function () {
    var config = createEnvConfig({ SINN_TASK_TIMEOUT_MS: '300000' })
    expect(config.taskTimeoutMs).toBe(300000)
  })

  test('非法值（非数字/空串/0/负数/Infinity）→ 一律回退 96000', function () {
    var dirtyValues = ['abc', '', '0', '-5', 'NaN', 'Infinity', undefined]
    dirtyValues.forEach(function (dirty) {
      var config = createEnvConfig({ SINN_TASK_TIMEOUT_MS: dirty })
      expect(config.taskTimeoutMs).toBe(96000)
    })
  })

  test('既有字段语义不变：额度/白名单/provider', function () {
    var config = createEnvConfig({
      SINN_DAILY_LIMIT_NORMAL: '3',
      SINN_DAILY_LIMIT_VIP: '20',
      SINN_VIP_WHITELIST: ' o_vip_1 , o_vip_2 ,, ',
      SINN_VENDOR: 'volcengine',
      SINN_TASK_TIMEOUT_MS: '120000'
    })
    expect(config.dailyLimitNormal).toBe(3)
    expect(config.dailyLimitVip).toBe(20)
    expect(config.vipWhitelist).toEqual(['o_vip_1', 'o_vip_2'])
    expect(config.vendorProvider).toBe('volcengine')
    expect(config.taskTimeoutMs).toBe(120000)
  })

  test('空对象入参安全（默认值）', function () {
    var config = createEnvConfig(undefined)
    expect(config.dailyLimitNormal).toBe(1)
    expect(config.dailyLimitVip).toBe(10)
    expect(config.vipWhitelist).toEqual([])
    expect(config.vendorProvider).toBe('mock')
    expect(config.taskTimeoutMs).toBe(96000)
  })
})
