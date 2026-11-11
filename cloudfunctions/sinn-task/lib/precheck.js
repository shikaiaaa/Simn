/**
 * lib/precheck.js —— 服务端 L1 预检适配器（SPEC-0001 v0.3 §B.4）。
 *
 * 背景（SPIKE-0001 §6）：供应商没有独立预检端点，服务端二次校验由 PrecheckAdapter
 * （视觉模型或规则，选型待 CP-04）完成；`validate` 三态 pass/fail/unknown，
 * **unknown 不得当 pass**（precheck 返回 pass=false + E_PRECHECK_UNKNOWN 3013）。
 *
 * 本文件提供：
 * - CHECK_DEFS：10+ 维检查项编码 → 预检子码 3001–3012 的映射；
 * - normalizeResult：把适配器原始返回规范化为 handler 使用的结构；
 * - createMockPrecheckAdapter：确定性契约桩（贴 fixture 驱动 AC-2/3/4/5/24）；
 * - createPrecheckAdapter(env)：按环境变量选择适配器（默认 mock）。
 */
'use strict'

var errors = require('./errors')

/** 检查项编码 → SPEC 错误码（3001–3012）。 */
var CHECK_DEFS = {
  single_person: { code: 3001, kind: 'PERSON', hint: '照片需为单人，请重新拍摄' },
  full_body: { code: 3002, kind: 'PERSON', hint: '照片未拍到全身（含脚部），请重新拍摄' },
  face_occlusion: { code: 3003, kind: 'PERSON', hint: '面部被遮挡，请露出完整面部后重拍' },
  body_occlusion: { code: 3004, kind: 'PERSON', hint: '身体被遮挡，请重新拍摄' },
  upright: { code: 3005, kind: 'PERSON', hint: '请上传直立正面照片' },
  lighting: { code: 3006, kind: 'PERSON', hint: '光线不足或逆光，请在光线均匀处重拍' },
  no_garment: { code: 3007, kind: 'GARMENT', hint: '未识别到服装，请让衣服完整入镜' },
  single_garment: { code: 3008, kind: 'GARMENT', hint: '仅支持单件服装，请只放一件' },
  on_model: { code: 3009, kind: 'GARMENT', hint: '请上传自己的衣服照片，不要拍模特上身' },
  tag_visible: { code: 3010, kind: 'GARMENT', hint: '请取下衣物吊牌后重拍' },
  mall_image: { code: 3011, kind: 'GARMENT', hint: '请勿上传电商商品图，请拍自己的衣服' },
  image_valid: { code: 3012, kind: 'GARMENT', hint: '图片无法识别，请更换照片' }
}

var CHECK_CODES = Object.keys(CHECK_DEFS)

function primaryFailed(checkCodes) {
  for (var i = 0; i < checkCodes.length; i += 1) {
    var def = CHECK_DEFS[checkCodes[i]]
    if (def) return def
  }
  return null
}

/**
 * 规范化适配器返回。返回给 handler 的数据结构：
 * { pass, status, code?, name?, message?, hint?, checks?, detail? }
 */
function normalizeResult(raw) {
  raw = raw || {}
  var status = raw.status
  if (['pass', 'fail', 'unknown'].indexOf(status) < 0) {
    // 契约兜底：适配器返回不可识别状态一律按 unknown，绝不放行。
    status = 'unknown'
  }

  var checks = Array.isArray(raw.checks)
    ? raw.checks.map(function (item) {
        return {
          code: String(item.code || ''),
          status: ['pass', 'fail', 'unknown'].indexOf(item.status) >= 0 ? item.status : 'unknown',
          hint: item.hint || (CHECK_DEFS[item.code] ? CHECK_DEFS[item.code].hint : '')
        }
      })
    : []

  var failed = Array.isArray(raw.failed)
    ? raw.failed
    : checks.filter(function (item) { return item.status === 'fail' }).map(function (item) { return item.code })
  var unknown = Array.isArray(raw.unknown)
    ? raw.unknown
    : checks.filter(function (item) { return item.status === 'unknown' }).map(function (item) { return item.code })

  if (status === 'pass' && (failed.length > 0 || unknown.length > 0)) {
    // 自相矛盾的返回不放行：有 fail → fail；否则 unknown。
    status = failed.length > 0 ? 'fail' : 'unknown'
  }

  if (status === 'pass') {
    return { pass: true, status: 'pass', checks: checks, detail: raw.detail || null }
  }

  if (status === 'fail') {
    var def = primaryFailed(failed)
    var code = def ? def.code : 3000
    var meta = errors.getMeta(code)
    return {
      pass: false,
      status: 'fail',
      code: code,
      name: meta.name,
      message: meta.message,
      hint: def ? def.hint : meta.message,
      checks: checks,
      detail: raw.detail || null
    }
  }

  return {
    pass: false,
    status: 'unknown',
    code: 3013,
    name: 'E_PRECHECK_UNKNOWN',
    message: errors.getMeta(3013).message,
    hint: '照片校验暂时无法完成，请换一张或稍后重试',
    checks: checks,
    detail: raw.detail || null
  }
}

/**
 * MockPrecheckAdapter —— 确定性契约桩。
 * @param {object} [options]
 *   - result: {status:'pass'|'fail'|'unknown', failed?:string[], unknown?:string[], checks?:[]}
 *   - error: 传入对象则 reject（模拟服务异常/超时由调用方控制）
 *   - delayMs: 注入延迟（默认 0）
 */
function createMockPrecheckAdapter(options) {
  options = options || {}
  var maxDelayMs = options.delayMs || 0
  var calls = 0

  function validate(params) {
    calls += 1
    var work = Promise.resolve().then(function () {
      if (options.error) throw options.error
      var result = options.result || { status: 'pass' }
      var checks = result.checks
      if (!checks) {
        checks = CHECK_CODES.map(function (code) {
          var status = 'pass'
          if (result.failed && result.failed.indexOf(code) >= 0) status = 'fail'
          if (result.unknown && result.unknown.indexOf(code) >= 0) status = 'unknown'
          return { code: code, status: status }
        })
      }
      return {
        status: result.status || (result.failed && result.failed.length ? 'fail' : 'pass'),
        checks: checks,
        failed: result.failed,
        unknown: result.unknown,
        detail: result.detail || null
      }
    })
    if (!maxDelayMs) return work
    return work.then(function (result) {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(result) }, maxDelayMs)
      })
    })
  }

  return {
    provider: 'mock-precheck',
    validate: validate,
    __calls: function () { return calls }
  }
}

/** 按环境变量选择预检适配器。真实视觉模型/规则方案待 CP-04 选型后接入。 */
function createPrecheckAdapter(env) {
  env = env || {}
  var provider = env.PRECHECK_PROVIDER || 'mock'
  if (provider === 'mock') {
    return createMockPrecheckAdapter({ delayMs: Number(env.PRECHECK_MOCK_DELAY_MS) || 0 })
  }
  // 视觉模型/规则适配器尚未选型：生产环境若误配，直接抛错而不是静默返回 pass。
  throw new Error('PrecheckAdapter 未接入: ' + provider + '（方案待 CP-04 选型）')
}

module.exports = {
  CHECK_DEFS: CHECK_DEFS,
  CHECK_CODES: CHECK_CODES,
  normalizeResult: normalizeResult,
  createMockPrecheckAdapter: createMockPrecheckAdapter,
  createPrecheckAdapter: createPrecheckAdapter
}
