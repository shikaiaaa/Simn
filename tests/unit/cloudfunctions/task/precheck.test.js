/**
 * tests/unit/cloudfunctions/task/precheck.test.js
 * 预检三态：pass / fail / unknown；unknown 不得当 pass；3013 映射（L1）。
 */
'use strict'

var precheckLib = require('../../../../cloudfunctions/sinn-task/lib/precheck')
var createMemoryStore = require('../../../../cloudfunctions/sinn-task/lib/store/memory-store').createMemoryStore
var createMockPrecheckAdapter = precheckLib.createMockPrecheckAdapter

describe('DEV-0001-03 PrecheckAdapter（三态）', function () {
  test('pass → pass:true；checks 全 pass', function () {
    var result = precheckLib.normalizeResult({
      status: 'pass',
      checks: [{ code: 'single_person', status: 'pass' }]
    })
    expect(result.pass).toBe(true)
    expect(result.status).toBe('pass')
    expect(result.code).toBeUndefined()
  })

  test('fail → pass:false 且映射到 3001–3012 子码', function () {
    var cases = [
      ['single_person', 3001],
      ['full_body', 3002],
      ['face_occlusion', 3003],
      ['body_occlusion', 3004],
      ['upright', 3005],
      ['lighting', 3006],
      ['no_garment', 3007],
      ['single_garment', 3008],
      ['on_model', 3009],
      ['tag_visible', 3010],
      ['mall_image', 3011],
      ['image_valid', 3012]
    ]
    cases.forEach(function (item) {
      var result = precheckLib.normalizeResult({ status: 'fail', failed: [item[0]] })
      expect(result.pass).toBe(false)
      expect(result.status).toBe('fail')
      expect(result.code).toBe(item[1])
      expect(result.hint).toBeTruthy()
    })
  })

  test('unknown → pass:false + E_PRECHECK_UNKNOWN(3013)，绝不放行', function () {
    var result = precheckLib.normalizeResult({ status: 'unknown', unknown: ['model_unavailable'] })
    expect(result.pass).toBe(false)
    expect(result.status).toBe('unknown')
    expect(result.code).toBe(3013)
    expect(result.name).toBe('E_PRECHECK_UNKNOWN')
  })

  test('不可识别状态 / 空返回 → unknown；pass 与 failed 矛盾 → 不放行', function () {
    expect(precheckLib.normalizeResult({}).status).toBe('unknown')
    expect(precheckLib.normalizeResult(null).code).toBe(3013)
    expect(precheckLib.normalizeResult({ status: 'PASS' }).status).toBe('unknown')
    expect(precheckLib.normalizeResult({ status: 'pass', failed: ['single_person'] }).status).toBe('fail')
    expect(precheckLib.normalizeResult({ status: 'pass', unknown: ['x'] }).status).toBe('unknown')
  })

  test('mock 预检适配器默认 pass，可注入 fail/unknown', async function () {
    var passing = createMockPrecheckAdapter()
    var passResult = await passing.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(passResult.status).toBe('pass')

    var failing = createMockPrecheckAdapter({ result: { status: 'fail', failed: ['full_body'] } })
    var failResult = await failing.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(failResult.status).toBe('fail')

    var unknown = createMockPrecheckAdapter({ result: { status: 'unknown', unknown: ['visual_model_offline'] } })
    var unknownResult = await unknown.validate({ buffer: Buffer.from('x'), mime: 'image/jpeg', kind: 'PERSON' })
    expect(unknownResult.status).toBe('unknown')
  })

  test('createPrecheckAdapter 默认 mock；未选型 provider 抛错不静默放行', function () {
    expect(precheckLib.createPrecheckAdapter({}).provider).toBe('mock-precheck')
    expect(function () {
      precheckLib.createPrecheckAdapter({ PRECHECK_PROVIDER: 'some-visual-model' })
    }).toThrow(/未接入/)
  })

  test('memory store 可独立构造（预检缓存依赖）', function () {
    var store = createMemoryStore()
    expect(typeof store.updateAsset).toBe('function')
    expect(typeof store.getAsset).toBe('function')
  })
})
