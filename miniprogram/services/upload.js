/**
 * services/upload.js —— 采集链路上传 + 资产登记（DEV-0001-06，SPEC §B.2 API-5 / API-12）。
 *
 * 约定：
 * - 先 wx.cloud.uploadFile 直传云存储，再 assetRegister 绑定 openid（云函数侧校验归属）；
 * - cloudPath 用 clientReqId 作文件名：重试同一 clientReqId 会覆盖同一对象，
 *   服务端 assetRegister 按 (openid, clientReqId) 幂等，因此重试不产生重复资产、不扣额度；
 * - 本模块不读本地同意缓存；同意前置由 services/api.js 的 call() 统一处理；
 * - 返回值统一 {ok, ...} 结构，页面不感知底层异常类型。
 *
 * require 阶段不访问 wx.*，wx 由调用方注入，便于单测。
 */
'use strict'

var api = require('./api')

var PERSON_DIR = 'person'
var GARMENT_DIR = 'garment'
var UPLOAD_TIMEOUT_MS = 8000

function assign(target) {
  var out = target || {}
  for (var i = 1; i < arguments.length; i += 1) {
    var src = arguments[i] || {}
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key]
    }
  }
  return out
}

/** 北京时间的日期目录 yyyyMMdd（与云函数 purgeAt/dayKey 口径一致）。 */
function datePath(nowMs) {
  var base = typeof nowMs === 'number' ? nowMs : Date.now()
  var d = new Date(base + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/** SPEC §B.5：sinn/person|garment/{yyyyMMdd}/{uuid}.jpg（路径不含 openid）。 */
function buildCloudPath(kind, clientReqId, nowMs) {
  var dir = kind === 'GARMENT' ? GARMENT_DIR : PERSON_DIR
  return 'sinn/' + dir + '/' + datePath(nowMs) + '/' + clientReqId + '.jpg'
}

function ensureClientReqId(clientReqId) {
  if (api.isClientReqId(clientReqId)) return clientReqId
  return api.createClientReqId()
}

function getWx(wxRef) {
  if (wxRef) return wxRef
  return typeof wx !== 'undefined' ? wx : null
}

function failResult(error, extra) {
  var result = {
    ok: false,
    code: (error && error.code) || 5006,
    name: (error && error.name) || 'E_UPLOAD_FAILED',
    message: (error && error.message) || api.getUserMessage(5006),
    hint: (error && error.hint) || ''
  }
  return assign(result, extra || {})
}

/**
 * 上传一张照片并登记资产。
 * @param {object} options
 *   {wxRef?, kind:'PERSON'|'GARMENT', clientReqId, filePath, mime, bytes, width, height,
 *    cloudPath?, now?, timeoutMs?}
 * @returns {Promise<{ok:boolean, assetId?:string, fileID?:string, clientReqId:string,
 *                    cloudPath?:string, kind?:string, purgeAt?:number, requestId?:string,
 *                    code?:number, name?:string, message?:string, hint?:string}>}
 */
function uploadAndRegister(options) {
  options = options || {}
  var kind = options.kind === 'GARMENT' ? 'GARMENT' : 'PERSON'
  var w = getWx(options.wxRef)
  var clientReqId = ensureClientReqId(options.clientReqId)
  var nowMs = typeof options.now === 'function' ? options.now() : options.now
  var cloudPath = options.cloudPath || buildCloudPath(kind, clientReqId, nowMs)
  var base = { clientReqId: clientReqId, cloudPath: cloudPath, kind: kind }

  if (!options.filePath) {
    return Promise.resolve(failResult({ code: 1001, name: 'E_PARAM', message: '缺少照片路径' }, base))
  }
  if (!w || !w.cloud || typeof w.cloud.uploadFile !== 'function') {
    return Promise.resolve(failResult({ code: 5006, name: 'E_UPLOAD_FAILED', message: '上传能力不可用，请重试' }, base))
  }

  return Promise.resolve(
    w.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: options.filePath
    })
  )
    .then(function (res) {
      var fileID = res && (res.fileID || (res.result && res.result.fileID))
      if (!fileID) {
        throw { code: 5006, name: 'E_UPLOAD_FAILED', message: api.getUserMessage(5006) }
      }
      return fileID
    })
    .then(function (fileID) {
      return api
        .call(
          'sinn-task',
          'assetRegister',
          {
            clientReqId: clientReqId,
            kind: kind,
            fileID: fileID,
            mime: options.mime || 'image/jpeg',
            bytes: options.bytes,
            width: options.width,
            height: options.height
          },
          {
            requireConsent: true,
            idempotent: false,
            timeoutMs: options.timeoutMs || UPLOAD_TIMEOUT_MS
          }
        )
        .then(function (res) {
          var data = (res && res.data) || {}
          return assign(base, {
            ok: true,
            fileID: fileID,
            assetId: data.assetId || '',
            purgeAt: data.purgeAt || 0,
            requestId: (res && res.requestId) || ''
          })
        })
    })
    .catch(function (error) {
      return failResult(error, base)
    })
}

function uploadPersonPhoto(options) {
  return uploadAndRegister(assign({}, options, { kind: 'PERSON' }))
}

function uploadGarmentPhoto(options) {
  return uploadAndRegister(assign({}, options, { kind: 'GARMENT' }))
}

module.exports = {
  PERSON_DIR: PERSON_DIR,
  GARMENT_DIR: GARMENT_DIR,
  UPLOAD_TIMEOUT_MS: UPLOAD_TIMEOUT_MS,
  datePath: datePath,
  buildCloudPath: buildCloudPath,
  ensureClientReqId: ensureClientReqId,
  uploadAndRegister: uploadAndRegister,
  uploadPersonPhoto: uploadPersonPhoto,
  uploadGarmentPhoto: uploadGarmentPhoto
}
