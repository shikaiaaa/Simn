/**
 * tests/unit/cloudfunctions/task/diag.test.js
 * task-66：临时诊断动作 diag —— 门禁、脱敏（绝不回显 AK/SK）、vendor.health 观测与统一 envelope。
 */
'use strict'

var diagLib = require('../../../../cloudfunctions/sinn-task/lib/diag')

var GATE = { gate: 'sinn-selftest-2026-11-10' }
var AK_SENTINEL = 'AKLT_sentinel_access_key_0123456789'
var SK_SENTINEL = 'SK_sentinel_secret_key_9876543210'

function fakeAdapter(healthImpl) {
  return {
    validate: function () {},
    submit: function () {},
    query: function () {},
    cancel: function () {},
    erase: function () {},
    health: healthImpl || function () { return Promise.resolve({ ok: true, provider: 'fake', latencyMs: 7 }) }
  }
}

function envWithSecrets(extra) {
  return Object.assign(
    {
      SINN_VENDOR: 'volcengine',
      SINN_VOLC_AK: AK_SENTINEL,
      SINN_VOLC_SK: SK_SENTINEL,
      SINN_VOLC_REGION: 'cn-north-1'
    },
    extra || {}
  )
}

describe('diag：门禁（未启用 1004，且不构造/调用 vendor）', function () {
  test('无 SINN_SELFTEST、无 gate 令牌 → 1004 E_FORBIDDEN，createVendorAdapter 0 次', async function () {
    var create = jest.fn(function () {
      throw new Error('不应被调用')
    })
    var response = await diagLib.handleDiag({ action: 'diag' }, {}, {
      requestId: 'req-diag-off',
      now: function () { return 123 },
      createVendorAdapter: create
    })

    expect(create).not.toHaveBeenCalled()
    expect(response.ok).toBe(false)
    expect(response.data).toBeNull()
    expect(response.error.code).toBe(1004)
    expect(response.error.name).toBe('E_FORBIDDEN')
    expect(response.error.httpStatus).toBe(404)
    expect(response.requestId).toBe('req-diag-off')
    expect(response.serverTime).toBe(123)
  })

  test('gate 令牌错误 → 仍 1004，且零 vendor 调用', async function () {
    var create = jest.fn()
    var response = await diagLib.handleDiag({ action: 'diag', gate: 'wrong-token' }, {}, {
      createVendorAdapter: create
    })

    expect(create).not.toHaveBeenCalled()
    expect(response.error.code).toBe(1004)
  })

  test('SINN_SELFTEST 只认字符串 "1"（"0"/"true" 不开启）', async function () {
    var create = jest.fn()
    for (var value of ['0', 'true', '']) {
      var response = await diagLib.handleDiag({ action: 'diag' }, { SINN_SELFTEST: value }, {
        createVendorAdapter: create
      })
      expect(response.error.code).toBe(1004)
    }
    expect(create).not.toHaveBeenCalled()
  })
})

describe('diag：门禁开启（gate 令牌 / SINN_SELFTEST=1）', function () {
  test('gate 令牌开启 → 返回凭证长度视图与 vendor health（不含密钥字符）', async function () {
    var env = envWithSecrets()
    var create = jest.fn(function () {
      return fakeAdapter()
    })
    var response = await diagLib.handleDiag({ action: 'diag', gate: diagLib.GATE_TOKEN }, env, {
      requestId: 'req-diag-on',
      now: function () { return 456 },
      createVendorAdapter: create
    })

    expect(response.ok).toBe(true)
    expect(response.error).toBeNull()
    expect(response.requestId).toBe('req-diag-on')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toBe(env)

    var data = response.data
    expect(data.vendorProvider).toBe('volcengine')
    expect(typeof data.nodeVersion).toBe('string')
    expect(data.nodeVersion.charAt(0)).toBe('v')
    expect(data.credentials).toEqual({
      hasAk: true,
      akLen: AK_SENTINEL.length,
      hasSk: true,
      skLen: SK_SENTINEL.length,
      region: 'cn-north-1'
    })
    expect(data.vendorHealth).toEqual({ ok: true, provider: 'fake', latencyMs: 7 })
    expect(data.hint).toContain('不创建任务')
    expect(data.hint).toContain('不扣额度')
  })

  test('SINN_SELFTEST=1 开启（无 gate 参数）', async function () {
    var env = envWithSecrets({ SINN_SELFTEST: '1', SINN_VENDOR: 'mock', SINN_VOLC_AK: '', SINN_VOLC_SK: '' })
    var response = await diagLib.handleDiag({ action: 'diag' }, env, {
      createVendorAdapter: jest.fn(function () {
        return fakeAdapter()
      })
    })

    expect(response.ok).toBe(true)
    expect(response.data.vendorProvider).toBe('mock')
    expect(response.data.credentials).toEqual({
      hasAk: false,
      akLen: 0,
      hasSk: false,
      skLen: 0,
      region: 'cn-north-1'
    })
  })

  test('缺省 provider 为 mock、region 缺省为 null（不抛错）', async function () {
    var response = await diagLib.handleDiag({ action: 'diag', gate: diagLib.GATE_TOKEN }, {}, {
      createVendorAdapter: jest.fn(function () {
        return fakeAdapter()
      })
    })
    expect(response.ok).toBe(true)
    expect(response.data.vendorProvider).toBe('mock')
    expect(response.data.credentials.region).toBeNull()
  })
})

describe('diag：vendor.health 异常收敛为 threw（不向上抛）', function () {
  test('health 同步抛错 → {threw:true,name,message}', async function () {
    var response = await diagLib.handleDiag(GATE, {}, {
      createVendorAdapter: function () {
        return fakeAdapter(function () {
          throw new Error('health sync boom')
        })
      }
    })

    expect(response.ok).toBe(true)
    expect(response.data.vendorHealth).toEqual({
      threw: true,
      name: 'Error',
      message: 'health sync boom'
    })
  })

  test('health Promise reject → threw 分支', async function () {
    var response = await diagLib.handleDiag(GATE, {}, {
      createVendorAdapter: function () {
        return fakeAdapter(function () {
          return Promise.reject(new Error('health async boom'))
        })
      }
    })

    expect(response.data.vendorHealth.threw).toBe(true)
    expect(response.data.vendorHealth.message).toBe('health async boom')
  })

  test('createVendorAdapter 抛错 → threw 分支（E_INTERNAL 等不阻断诊断）', async function () {
    var response = await diagLib.handleDiag(GATE, {}, {
      createVendorAdapter: function () {
        var error = new Error('未知 SINN_VENDOR: bogus')
        error.name = 'Error'
        throw error
      }
    })

    expect(response.ok).toBe(true)
    expect(response.data.vendorHealth.threw).toBe(true)
    expect(response.data.vendorHealth.message).toContain('未知 SINN_VENDOR')
  })

  test('adapter 缺 health() → threw 分支', async function () {
    var response = await diagLib.handleDiag(GATE, {}, {
      createVendorAdapter: function () {
        return { validate: function () {} }
      }
    })

    expect(response.data.vendorHealth.threw).toBe(true)
    expect(response.data.vendorHealth.message).toContain('health')
  })

  test('默认工厂（真实 createVendorAdapter）mock provider 可用且不发起网络请求', async function () {
    var response = await diagLib.handleDiag(GATE, {}, {})
    expect(response.ok).toBe(true)
    expect(response.data.vendorProvider).toBe('mock')
    expect(response.data.vendorHealth.ok).toBe(true)
  })
})

describe('diag：脱敏哨兵（响应任何位置不得出现 AK/SK 原文）', function () {
  test('health 异常 message 含密钥原文时被替换为 ***，整个响应不含哨兵', async function () {
    var env = envWithSecrets()
    var response = await diagLib.handleDiag(GATE, env, {
      createVendorAdapter: function () {
        return fakeAdapter(function () {
          throw new Error('bad credentials ' + AK_SENTINEL + ' / ' + SK_SENTINEL)
        })
      }
    })

    var serialized = JSON.stringify(response)
    expect(serialized).not.toContain(AK_SENTINEL)
    expect(serialized).not.toContain(SK_SENTINEL)
    expect(response.data.vendorHealth.message).toContain('***')
    expect(response.data.credentials.akLen).toBe(AK_SENTINEL.length)
    expect(response.data.credentials.skLen).toBe(SK_SENTINEL.length)
  })

  test('createVendorAdapter 抛错 message 含密钥原文时同样被脱敏', async function () {
    var env = envWithSecrets()
    var response = await diagLib.handleDiag(GATE, env, {
      createVendorAdapter: function () {
        throw new Error('provider config invalid: ' + AK_SENTINEL)
      }
    })

    expect(JSON.stringify(response)).not.toContain(AK_SENTINEL)
    expect(response.data.vendorHealth.message).toContain('***')
  })
})

describe('diag：credentialsView 边界', function () {
  test('undefined/非字符串值安全处理为不存在（长度 0）', function () {
    var view = diagLib.credentialsView({ SINN_VOLC_AK: undefined, SINN_VOLC_SK: 12345 })
    expect(view.hasAk).toBe(false)
    expect(view.akLen).toBe(0)
    expect(view.hasSk).toBe(false)
    expect(view.skLen).toBe(0)
  })

  test('isGateEnabled 边界', function () {
    expect(diagLib.isGateEnabled({}, {})).toBe(false)
    expect(diagLib.isGateEnabled({ SINN_SELFTEST: '1' }, null)).toBe(true)
    expect(diagLib.isGateEnabled({}, { gate: diagLib.GATE_TOKEN })).toBe(true)
  })
})
