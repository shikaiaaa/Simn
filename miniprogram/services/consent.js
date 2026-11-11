/**
 * services/consent.js —— 合规门禁服务（SPEC-0001 §6 / §C / §F，AC-21 / AC-25）。
 *
 * 职责（DEV-0001-05）：
 * - 定义「18+ 声明 + 禁止条款」与「隐私单独同意」两步显式确认的文案与校验；
 * - 8 项个人信息披露（收集项 / 用途 / 保存期限 / 境外接收方 / 处理目的 / 数据类别 / 删除方式 / 拒绝后果），
 *   含「性别（选填）」与「性别不填不影响生成与参考尺码」说明；
 * - 同意成功后：先走微信隐私授权（requirePrivacyAuthorize / onNeedPrivacyAuthorization 合并），
 *   再写服务端 recordConsent（用户 / 版本 / 时间 / 文本 hash），最后写本地 sinn_consent_v1；
 * - 拒绝或任一步失败：不写本地、不调用任何隐私接口，页面停留功能说明；
 * - 二次进入：本地或服务端已有同意记录时免重复同意。
 *
 * 本文件在 require 阶段不访问 wx.*，纯函数可被 jest 直接加载；wx 由调用方注入，便于单测。
 */
'use strict'

var api = require('./api')

var CONSENT_VERSION = '2026-11-09-v1'
var CONSENT_STORAGE_KEY = api.STORAGE_KEYS.CONSENT
var CAPTURE_URL = '/pages/capture/capture'
var INDEX_URL = '/pages/index/index'

var AGE_TEXT = '我已年满 18 周岁，并已阅读禁止条款'
var TERMS_TEXT = '我承诺不生成违法、侵权、色情或他人肖像内容，不上传非本人照片'
var PRIVACY_TEXT = '我已阅读上述 8 项个人信息处理说明，并单独同意 Sinn 处理我的信息'
var GENDER_NOTE = '性别为选填项；不填写不影响生成与参考尺码。'
var DRAFT_NOTICE = '当前为 draft 文本（CP-10，正式文本待需求方提供）'

/**
 * 8 项披露（顺序固定，与 SPEC §6 / AC-21 对应）。
 * 境外接收方：CP-04 采购结论未定，先披露候选服务商与处理地，最终以采购结论与正式文本为准。
 */
var DISCLOSURES = [
  {
    key: 'collected',
    label: '收集项',
    text: '收集：你主动上传的 1–3 张人像照片、1 张衣服照片；身高、体重；可选的三围；性别（选填）；微信 openid（仅用于区分账号与额度）。'
  },
  {
    key: 'purpose',
    label: '用途',
    text: '用途：仅用于生成你的试穿效果图与展示参考尺码，不用于广告、用户画像或对外销售。'
  },
  {
    key: 'retention',
    label: '保存期限',
    text: '保存期限：任务数据在创建后 23 小时内由系统自动物理删除；同意审计记录保留至你撤回同意或删除数据。'
  },
  {
    key: 'overseas',
    label: '境外接收方名称/所在地',
    text: '境外接收方：试穿生成可能由境外服务商处理（候选含 Perfect Corp，服务位于境外/AWS）；最终供应商与所在地以采购结论为准，正式文本将在上线前确认。'
  },
  {
    key: 'processingPurpose',
    label: '处理目的',
    text: '处理目的：完成人像与服装的合成、输出试穿结果图并计算参考尺码。'
  },
  {
    key: 'dataCategories',
    label: '数据类别',
    text: '数据类别：人像照片、服装照片、身高体重（可选三围、选填性别）、生成结果图。'
  },
  {
    key: 'deletion',
    label: '删除方式',
    text: '删除方式：结果页可删除本次，我的页可删除全部或撤回同意；删除为物理删除，删除后不可恢复。'
  },
  {
    key: 'refusal',
    label: '拒绝后果',
    text: '拒绝后果：不提供上述信息将无法使用试穿生成功能；你仍可浏览功能说明，但不会调用相册、摄像头等隐私接口。'
  }
]

function normalizeText(value) {
  return typeof value === 'string' ? value : ''
}

/** 8 项披露全文（用于文本 hash 与页面展示）。 */
function buildDisclosureText(disclosures) {
  var list = Array.isArray(disclosures) ? disclosures : DISCLOSURES
  return list
    .map(function (item) {
      return normalizeText(item && item.label) + '：' + normalizeText(item && item.text)
    })
    .join('\n')
}

function getConsentText() {
  return buildDisclosureText(DISCLOSURES)
}

/**
 * FNV-1a 32 位文本 hash（小程序无 crypto，纯函数足够标记文本版本）。
 * @param {string} text
 * @returns {string} 形如 fnv1a-1a2b3c4d
 */
function hashText(text) {
  var value = normalizeText(text)
  var hash = 0x811c9dc5
  for (var i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return 'fnv1a-' + ('00000000' + hash.toString(16)).slice(-8)
}

/** 第一步校验：18+ 声明与禁止条款必须显式勾选（不默认勾选）。 */
function validateAgeStep(input) {
  input = input || {}
  if (input.ageConfirmed !== true) {
    return { ok: false, code: 'AGE_REQUIRED', message: '请先确认你已年满 18 周岁' }
  }
  if (input.termsAccepted !== true) {
    return { ok: false, code: 'TERMS_REQUIRED', message: '请先阅读并同意禁止条款' }
  }
  return { ok: true }
}

/** 第二步校验：隐私说明必须单独同意（不捆绑第一步）。 */
function validateConsentStep(input) {
  input = input || {}
  if (input.privacyAgreed !== true) {
    return { ok: false, code: 'PRIVACY_REQUIRED', message: '请阅读并单独同意 8 项个人信息处理说明' }
  }
  return { ok: true }
}

function createConsentRecord(options) {
  options = options || {}
  var now = typeof options.now === 'number' ? options.now : Date.now()
  return {
    version: normalizeText(options.version) || CONSENT_VERSION,
    agreedAt: now,
    ageConfirmedAt: now
  }
}

/** 校验并归一化本地同意记录（sinn_consent_v1）。 */
function normalizeConsentRecord(value) {
  if (!value) return null
  var record = value
  if (typeof value === 'string') {
    try {
      record = JSON.parse(value)
    } catch (e) {
      return null
    }
  }
  if (!record || typeof record !== 'object') return null
  if (!normalizeText(record.version) || !record.agreedAt) return null
  var hasAgeFlag = record.ageConfirmedAt !== undefined && record.ageConfirmedAt !== null
  return {
    version: String(record.version),
    agreedAt: Number(record.agreedAt) || 0,
    // 显式写入的 0 必须保留（18+ 未确认，AC-25 门禁）；旧记录缺该字段时才回退 agreedAt。
    ageConfirmedAt: hasAgeFlag ? Number(record.ageConfirmedAt) || 0 : Number(record.agreedAt) || 0
  }
}

function getWx(wxRef) {
  if (wxRef) return wxRef
  return typeof wx !== 'undefined' ? wx : null
}

/** 读取本地同意记录；无记录/损坏时返回 null。 */
function readLocalConsent(wxRef) {
  var w = getWx(wxRef)
  if (!w || typeof w.getStorageSync !== 'function') return null
  try {
    return normalizeConsentRecord(w.getStorageSync(CONSENT_STORAGE_KEY))
  } catch (e) {
    return null
  }
}

/** 写入本地同意记录（SPEC §C：{version, agreedAt, ageConfirmedAt}）。 */
function writeLocalConsent(wxRef, record) {
  var w = getWx(wxRef)
  var normalized = normalizeConsentRecord(record)
  if (!w || typeof w.setStorageSync !== 'function' || !normalized) return false
  try {
    w.setStorageSync(CONSENT_STORAGE_KEY, JSON.stringify(normalized))
    return true
  } catch (e) {
    return false
  }
}

/** 清除本地同意记录（撤回同意/删除全部时由 profile 页调用）。 */
function clearLocalConsent(wxRef) {
  var w = getWx(wxRef)
  if (!w || typeof w.removeStorageSync !== 'function') return false
  try {
    w.removeStorageSync(CONSENT_STORAGE_KEY)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 进入页判定：本地同意优先；本地缺失但服务端 profile 有同意记录时视为已同意。
 * @param {{localConsent?:*, profileConsent?:object}} input
 * @returns {{consented:boolean, record:object|null, source:'local'|'server'|'none'}}
 */
function resolveEntryState(input) {
  input = input || {}
  var local = normalizeConsentRecord(input.localConsent)
  if (local) return { consented: true, record: local, source: 'local' }

  var profile = input.profileConsent
  if (profile && typeof profile === 'object' && (profile.version || profile.agreedAt)) {
    var profileHourFlag = profile.ageConfirmedAt !== undefined && profile.ageConfirmedAt !== null
    var record = normalizeConsentRecord({
      version: profile.version || CONSENT_VERSION,
      agreedAt: profile.agreedAt || 0,
      ageConfirmedAt: profileHourFlag ? profile.ageConfirmedAt : profile.agreedAt || 0
    })
    if (record) return { consented: true, record: record, source: 'server' }
  }
  return { consented: false, record: null, source: 'none' }
}

/** 18+ 与同意都满足才允许进入上传页（AC-25）。 */
function ensureUploadAllowed(state) {
  return !!(state && state.consented === true && state.record && state.record.ageConfirmedAt > 0)
}

/**
 * 微信隐私授权（自定义同意页合并方案）。
 * 缺失 API 不算通过（SPEC §E：关键能力缺失必须显式报错，不静默降级）。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function requestPrivacyAuthorize(wxRef) {
  return new Promise(function (resolve) {
    var w = getWx(wxRef)
    if (!w || typeof w.requirePrivacyAuthorize !== 'function') {
      resolve({ ok: false, reason: 'unsupported' })
      return
    }
    var settled = false
    function finish(result) {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      w.requirePrivacyAuthorize({
        success: function () {
          finish({ ok: true })
        },
        fail: function (error) {
          finish({ ok: false, reason: (error && (error.errMsg || error.errno)) || 'denied' })
        }
      })
    } catch (e) {
      finish({ ok: false, reason: 'exception' })
    }
  })
}

/**
 * 注册 wx.onNeedPrivacyAuthorization，把平台隐私弹窗与自定义同意页合并。
 * handlers.onRequest() 在平台请求时回调（页面切到同意流程）；
 * 页面同意后调用 resolve('agree')，拒绝调用 resolve('disagree')。
 */
function installPrivacyHandler(wxRef, handlers) {
  var w = getWx(wxRef)
  var state = { installed: false, pending: null }
  if (!w || typeof w.onNeedPrivacyAuthorization !== 'function') {
    return {
      installed: false,
      resolve: function () {
        return false
      },
      hasPending: function () {
        return false
      }
    }
  }
  w.onNeedPrivacyAuthorization(function (resolve) {
    state.pending = typeof resolve === 'function' ? resolve : null
    if (handlers && typeof handlers.onRequest === 'function') handlers.onRequest()
  })
  state.installed = true
  return {
    installed: true,
    hasPending: function () {
      return !!state.pending
    },
    resolve: function (event) {
      if (!state.pending) return false
      var fn = state.pending
      state.pending = null
      try {
        fn({ event: event === 'agree' ? 'agree' : 'disagree' })
      } catch (e) {
        return false
      }
      return true
    }
  }
}

/**
 * 同意提交编排：步骤校验 → 微信隐私授权 → 服务端 recordConsent → 写本地。
 * 任一步失败都不写本地；不调用任何媒体/隐私采集接口（AC-21）。
 * @param {object} options { wxRef, now, ageConfirmed, termsAccepted, privacyAgreed,
 *                           disclosures?, consentText?, timeoutMs? }
 * @returns {Promise<{ok:boolean, record?:object, requestId?:string, step?:string, code?:string, message?:string, error?:object}>}
 */
function submitConsent(options) {
  options = options || {}

  var ageCheck = validateAgeStep(options)
  if (!ageCheck.ok) {
    return Promise.resolve({ ok: false, step: 'age', code: ageCheck.code, message: ageCheck.message })
  }

  var consentCheck = validateConsentStep(options)
  if (!consentCheck.ok) {
    return Promise.resolve({ ok: false, step: 'privacy', code: consentCheck.code, message: consentCheck.message })
  }

  var now = typeof options.now === 'number' ? options.now : Date.now()
  var record = createConsentRecord({ now: now })
  var textHash = hashText(options.consentText || buildDisclosureText(options.disclosures))

  return requestPrivacyAuthorize(options.wxRef).then(function (privacy) {
    if (!privacy.ok) {
      return {
        ok: false,
        step: 'privacy',
        code: 'PRIVACY_UNAUTHORIZED',
        reason: privacy.reason,
        message: '需要先同意微信隐私授权，才能使用试穿生成功能'
      }
    }
    return api
      .call(
        'sinn-account',
        'recordConsent',
        { version: record.version, textHash: textHash, ageConfirmed: true },
        { requireConsent: false, timeoutMs: options.timeoutMs || api.DEFAULT_TIMEOUT_MS }
      )
      .then(function (res) {
        writeLocalConsent(options.wxRef, record)
        return { ok: true, record: record, requestId: (res && res.requestId) || '' }
      })
      .catch(function (error) {
        return {
          ok: false,
          step: 'record',
          code: error && error.code,
          message: (error && error.message) || '同意记录提交失败，请重试',
          error: error
        }
      })
  })
}

module.exports = {
  CONSENT_VERSION: CONSENT_VERSION,
  CONSENT_STORAGE_KEY: CONSENT_STORAGE_KEY,
  CAPTURE_URL: CAPTURE_URL,
  INDEX_URL: INDEX_URL,
  DISCLOSURES: DISCLOSURES,
  GENDER_NOTE: GENDER_NOTE,
  DRAFT_NOTICE: DRAFT_NOTICE,
  AGE_TEXT: AGE_TEXT,
  TERMS_TEXT: TERMS_TEXT,
  PRIVACY_TEXT: PRIVACY_TEXT,
  buildDisclosureText: buildDisclosureText,
  getConsentText: getConsentText,
  hashText: hashText,
  validateAgeStep: validateAgeStep,
  validateConsentStep: validateConsentStep,
  createConsentRecord: createConsentRecord,
  normalizeConsentRecord: normalizeConsentRecord,
  readLocalConsent: readLocalConsent,
  writeLocalConsent: writeLocalConsent,
  clearLocalConsent: clearLocalConsent,
  resolveEntryState: resolveEntryState,
  ensureUploadAllowed: ensureUploadAllowed,
  requestPrivacyAuthorize: requestPrivacyAuthorize,
  installPrivacyHandler: installPrivacyHandler,
  submitConsent: submitConsent
}
