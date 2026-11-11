/**
 * tests/unit/cloudfunctions/task/precheck-debug.test.js
 * task-36：受保护的 precheckDebug 诊断动作。
 *
 * 覆盖：
 * - 门禁关闭 → 1004/403 且零 store 调用；token / SINN_SELFTEST=1 两种放行方式；
 * - 全步骤通过 → 诊断 ok:true、步骤顺序正确、step6 写库后恢复原 precheck；
 * - step2（资产不存在）/step3（下载失败）/step6（写库失败）→ failedStep/error/stack/skipped；
 * - 不泄漏图片 buffer / base64（返回体只含长度等摘要）。
 */
'use strict'

var precheckDebug = require('../../../../cloudfunctions/sinn-task/lib/precheck-debug')
var GATE_TOKEN = require('../../../../cloudfunctions/sinn-task/lib/debug-gate').GATE_TOKEN

var OPENID = 'o_debug_user'
var ASSET_ID = 'a_0123456789abcdef01234567'
var IMAGE_BYTES = 100 * 1024

function createAsset(overrides) {
  return Object.assign(
    {
      assetId: ASSET_ID,
      openid: OPENID,
      kind: 'PERSON',
      fileID: 'cloud://mock-env.abc/sinn/person/20261110/photo.jpg',
      mime: 'image/jpeg',
      bytes: IMAGE_BYTES,
      width: 1080,
      height: 1920,
      createdAt: 1762740000000,
      purgeAt: 1762822800000,
      precheck: null
    },
    overrides || {}
  )
}

function createStore(options) {
  options = options || {}
  var state = {
    asset: createAsset(options.asset),
    updates: []
  }
  var store = {
    getConsent: jest.fn(function () {
      if (options.consentError) return Promise.reject(options.consentError)
      return Promise.resolve(options.noConsent ? null : { version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 1 })
    }),
    getAsset: jest.fn(function () {
      if (options.getAssetError) return Promise.reject(options.getAssetError)
      return Promise.resolve(options.missingAsset ? null : state.asset)
    }),
    updateAsset: jest.fn(function (assetId, patch) {
      if (options.updateAssetError) return Promise.reject(options.updateAssetError)
      state.updates.push(patch)
      state.asset = Object.assign({}, state.asset, patch)
      return Promise.resolve(state.asset)
    })
  }
  return { store: store, state: state }
}

function createStorage(options) {
  options = options || {}
  return {
    download: jest.fn(function () {
      if (options.downloadError) return Promise.reject(options.downloadError)
      return Promise.resolve(Buffer.alloc(IMAGE_BYTES, 0xab))
    })
  }
}

function createPrecheck(options) {
  options = options || {}
  return {
    validate: jest.fn(function () {
      if (options.validateError) return Promise.reject(options.validateError)
      return Promise.resolve(
        options.raw || { status: 'pass', checks: [{ code: 'single_person', status: 'pass' }], detail: null }
      )
    })
  }
}

function build(options) {
  options = options || {}
  var storeCtx = createStore(options)
  var deps = {
    store: storeCtx.store,
    storage: createStorage(options),
    precheck: createPrecheck(options),
    env: options.env || {},
    openid: options.openid === undefined ? OPENID : options.openid,
    requestId: 'req-precheck-debug-test'
  }
  var handler = precheckDebug.createPrecheckDebugHandler(deps)
  return { handler: handler, store: storeCtx.store, state: storeCtx.state, storage: deps.storage, precheck: deps.precheck }
}

describe('precheckDebug 门禁', function () {
  test('无 gate token 且未开 SINN_SELFTEST → 1004/403，且零 store 调用', async function () {
    var ctx = build()
    await expect(ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID })).rejects.toMatchObject({
      isAppError: true,
      code: 1004,
      httpStatus: 403
    })
    expect(ctx.store.getConsent).toHaveBeenCalledTimes(0)
    expect(ctx.store.getAsset).toHaveBeenCalledTimes(0)
    expect(ctx.store.updateAsset).toHaveBeenCalledTimes(0)
  })

  test('gate token 放行：诊断 ok:true，步骤顺序完整且 step6 后恢复原 precheck', async function () {
    var ctx = build()
    var result = await ctx.handler({
      action: 'precheckDebug',
      assetId: ASSET_ID,
      gate: GATE_TOKEN
    })
    expect(result.ok).toBe(true)
    expect(result.failedStep).toBeNull()
    expect(result.error).toBeNull()
    expect(result.requestId).toBe('req-precheck-debug-test')
    expect(result.steps.map(function (item) { return item.name })).toEqual([
      'step1_loadConsent',
      'step2_getAsset',
      'step3_download',
      'step4_validate',
      'step5_normalize',
      'step6_updateAsset',
      'step6b_restorePrecheck'
    ])
    expect(result.steps[0].summary.hasConsent).toBe(true)
    expect(result.steps[1].summary.ownerMatches).toBe(true)
    expect(result.steps[1].summary.fileIDEnvSegmentPresent).toBe(true)
    expect(result.steps[2].summary.length).toBe(IMAGE_BYTES)
    expect(result.steps[3].summary.raw.status).toBe('pass')
    expect(result.steps[4].summary.pass).toBe(true)
    expect(result.steps[5].summary.writtenKeys).toEqual(expect.arrayContaining(['pass', 'status', 'checks', 'at']))
    expect(result.steps[6].summary.restored).toBe(true)
    // 写库 + 恢复各一次；原 precheck 为 null，最后恢复为 null
    expect(ctx.store.updateAsset).toHaveBeenCalledTimes(2)
    expect(ctx.store.updateAsset.mock.calls[1][1]).toEqual({ precheck: null })
  })

  test('SINN_SELFTEST=1 也可放行', async function () {
    var ctx = build({ env: { SINN_SELFTEST: '1' } })
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID })
    expect(result.ok).toBe(true)
  })

  test('openid 缺失 → 1004/403；assetId 非法 → 1001', async function () {
    var withoutOpenid = build({ openid: null, env: { SINN_SELFTEST: '1' } })
    await expect(withoutOpenid.handler({ assetId: ASSET_ID })).rejects.toMatchObject({ code: 1004, httpStatus: 403 })

    var withBadAsset = build()
    await expect(withBadAsset.handler({ assetId: 'bad-asset-id', gate: GATE_TOKEN })).rejects.toMatchObject({
      isAppError: true,
      code: 1001
    })
    expect(withBadAsset.store.getConsent).toHaveBeenCalledTimes(0)
  })
})

describe('precheckDebug 逐步失败诊断', function () {
  test('step1 无同意 → failedStep=step1_loadConsent，后续 skipped', async function () {
    var ctx = build({ noConsent: true })
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID, gate: GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('step1_loadConsent')
    expect(result.error.code).toBe(1003)
    expect(result.steps.filter(function (item) { return item.skipped }).map(function (item) { return item.name })).toEqual([
      'step2_getAsset',
      'step3_download',
      'step4_validate',
      'step5_normalize',
      'step6_updateAsset'
    ])
    expect(ctx.storage.download).toHaveBeenCalledTimes(0)
  })

  test('step2 资产不存在 → failedStep=step2_getAsset，error.message 保留', async function () {
    var ctx = build({ missingAsset: true })
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID, gate: GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('step2_getAsset')
    expect(result.error.message).toBeTruthy()
    expect(ctx.storage.download).toHaveBeenCalledTimes(0)
  })

  test('step3 下载失败 → failedStep=step3_download，error.message/stack 保留', async function () {
    var ctx = build({ downloadError: new Error('download boom') })
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID, gate: GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('step3_download')
    expect(result.error.name).toBe('Error')
    expect(result.error.message).toBe('download boom')
    expect(Array.isArray(result.error.stack)).toBe(true)
    expect(result.error.stack.length).toBeGreaterThan(0)
    expect(result.error.stack.length).toBeLessThanOrEqual(20)
    expect(ctx.precheck.validate).toHaveBeenCalledTimes(0)
    expect(ctx.store.updateAsset).toHaveBeenCalledTimes(0)
  })

  test('step6 写库失败 → failedStep=step6_updateAsset + 保留 message/stack，并附最小写探针结果', async function () {
    var writeError = new Error('write rejected by cloud db')
    var ctx = build({ updateAssetError: writeError })
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID, gate: GATE_TOKEN })
    expect(result.ok).toBe(false)
    expect(result.failedStep).toBe('step6_updateAsset')
    expect(result.error.message).toBe('write rejected by cloud db')
    expect(result.error.stack.length).toBeGreaterThan(0)
    var probe = result.steps.filter(function (item) { return item.name === 'step6b_updateProbe' })
    expect(probe.length).toBe(1)
    expect(probe[0].ok).toBe(false)
    expect(result.probeError.message).toBe('write rejected by cloud db')
  })
})

describe('precheckDebug 不泄漏图片内容', function () {
  test('返回体不包含 buffer/base64/大字段', async function () {
    var ctx = build()
    var result = await ctx.handler({ action: 'precheckDebug', assetId: ASSET_ID, gate: GATE_TOKEN })
    var json = JSON.stringify(result)
    expect(json.length).toBeLessThan(20000)
    expect(json.indexOf('base64')).toBe(-1)
    expect(json.indexOf(Buffer.alloc(64, 0xab).toString('base64'))).toBe(-1)
    expect(result.steps[2].summary).toEqual({
      isBuffer: true,
      length: IMAGE_BYTES,
      type: 'object',
      detectedMime: null
    })
    // 步骤摘要里不能有原始 buffer 引用
    result.steps.forEach(function (item) {
      if (item.summary && typeof item.summary === 'object') {
        expect(Buffer.isBuffer(item.summary)).toBe(false)
      }
    })
  })
})
