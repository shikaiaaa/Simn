/**
 * services/photo-adapt.js —— 上传照片自动适配（DEV-0001-52）。
 *
 * 上传前压到供应商规格（SPEC v0.11 §B.2 / AC-29）：JPG、长边 <= 4096px、<= 5MB。
 * EXIF 归一后尺寸档 [4096,3072,2048,1024] 外层 × 质量档
 * [0.92,0.85,0.78,0.7,0.62,0.55,0.5] 内层，先降质量再降尺寸、达标即停；
 * 全档用尽仍不达标 -> 5007，绝不降级上传原图。旧两级策略（AC-27）导出保留。
 * 纯规划函数 + 可注入 deps（renderJpeg/sizeOf/now），require 阶段不访问 wx。
 */
'use strict'

var imagePrep = require('../utils/image-prep')

var MAX_BYTES = imagePrep.MAX_BYTES
var MIN_LONG_SIDE = 1024
var LEVEL1_LONG_SIDE = imagePrep.MAX_LONG_SIDE
var LEVEL2_LONG_SIDE = 3072
var LEVEL1_QUALITY = imagePrep.JPEG_QUALITY
var LEVEL2_QUALITY = 78
var MAX_STAGES = 2
var MB = 1024 * 1024

/* 供应商规格（SPEC v0.11 §B.2 / AC-29）：JPG、长边 <= 4096、<= 5MB。 */
var VENDOR_MAX_BYTES = 5 * MB
var VENDOR_MAX_LONG_SIDE = 4096
var VENDOR_SIZE_TIERS = [4096, 3072, 2048, 1024]
var VENDOR_QUALITY_TIERS = [0.92, 0.85, 0.78, 0.7, 0.62, 0.55, 0.5]

/** 端上照片错误码（与 SPEC v0.8 错误码表对齐：3014 / 5007）。 */
var PHOTO_ERRORS = {
  PHOTO_TOO_SMALL: {
    code: 'PHOTO_TOO_SMALL',
    apiCode: 3014,
    name: 'E_PRECHECK_TOO_SMALL',
    message: '分辨率过低，请重拍',
    hint: '照片长边需不小于 1024 像素，且不支持放大低分辨率图片'
  },
  PHOTO_PROCESS_FAILED: {
    code: 'PHOTO_PROCESS_FAILED',
    apiCode: 5007,
    name: 'E_PHOTO_PROCESS_FAILED',
    message: '照片处理失败，请重试或更换照片',
    hint: '可尝试更换照片，或稍微裁剪/重新拍摄后重试'
  },
  PHOTO_TOO_LARGE: {
    code: 'PHOTO_TOO_LARGE',
    apiCode: 5007,
    name: 'E_PHOTO_PROCESS_FAILED',
    message: '照片体积过大，请更换照片或重新拍摄',
    hint: '自动压缩后仍超过 10MB，请换一张照片'
  },
  PHOTO_VENDOR_SPEC: {
    code: 'PHOTO_VENDOR_SPEC',
    apiCode: 5007,
    name: 'E_PHOTO_PROCESS_FAILED',
    message: '照片压缩后仍不符合生成服务要求，请更换照片或重拍',
    hint: '生成服务要求 JPG 格式、≤5MB、长边 ≤4096 像素'
  }
}

function photoFail(code, reason) {
  var meta = PHOTO_ERRORS[code] || PHOTO_ERRORS.PHOTO_PROCESS_FAILED
  return {
    ok: false,
    code: meta.code,
    apiCode: meta.apiCode,
    name: meta.name,
    message: meta.message,
    hint: meta.hint,
    reason: reason || ''
  }
}

function getPhotoErrorMeta(code) {
  return PHOTO_ERRORS[code] || PHOTO_ERRORS.PHOTO_PROCESS_FAILED
}

function formatMb(bytes) {
  var n = Number(bytes) || 0
  return (n / MB).toFixed(1)
}

function toNumber(value) {
  var n = Number(value)
  return isFinite(n) ? n : 0
}

/** 计算某一级压缩的目标尺寸（保持长宽比，不放大）。 */
function computeStageTarget(width, height, maxLongSide) {
  return imagePrep.computeResize(width, height, maxLongSide)
}

/**
 * 规划：判断是否需要压缩、是否需要先修 EXIF / 转 JPEG，并给出第一级目标。
 * 返回 {ok, needsCompression, reasons, oriented:{width,height}, longSide, stage1}
 * 或 {ok:false, code, apiCode, message, hint, reason}。
 */
function planAdaptive(info) {
  info = info || {}
  var width = toNumber(info.width)
  var height = toNumber(info.height)
  var size = toNumber(info.size !== undefined ? info.size : info.bytes)
  var orientation = info.orientation ? String(info.orientation) : 'up'

  if (!(width > 0) || !(height > 0)) {
    return photoFail('PHOTO_PROCESS_FAILED', 'invalid_dimensions')
  }

  var oriented = imagePrep.orientedSize({ width: width, height: height, orientation: orientation })
  var longSide = Math.max(oriented.width, oriented.height)
  if (longSide < MIN_LONG_SIDE) {
    return photoFail('PHOTO_TOO_SMALL', 'too_small')
  }

  var transform = imagePrep.orientationTransform(orientation)
  var jpeg = imagePrep.isJpegLike(info.path || info.type || info.mime)
  var reasons = []
  if (transform.rotate !== 0 || transform.flipX) reasons.push('exif_orientation')
  if (longSide > LEVEL1_LONG_SIDE) reasons.push('oversized_pixels')
  if (!jpeg) reasons.push('not_jpeg')
  if (size > MAX_BYTES) reasons.push('oversized_bytes')

  var target = computeStageTarget(oriented.width, oriented.height, LEVEL1_LONG_SIDE)
  return {
    ok: true,
    needsCompression: reasons.length > 0,
    reasons: reasons,
    oriented: { width: oriented.width, height: oriented.height },
    longSide: longSide,
    stage1: {
      maxLongSide: LEVEL1_LONG_SIDE,
      quality: LEVEL1_QUALITY,
      width: target.width,
      height: target.height,
      resized: target.resized
    }
  }
}

/** 单级结果判定：体积达标则完成；仍超 10MB 则允许再降一级。 */
function evaluateProduced(produced) {
  var width = toNumber(produced && produced.width)
  var height = toNumber(produced && produced.height)
  var bytes = toNumber(produced && produced.bytes)
  var longSide = Math.max(width, height)
  if (longSide > LEVEL1_LONG_SIDE) {
    return photoFail('PHOTO_PROCESS_FAILED', 'render_oversize')
  }
  if (bytes > MAX_BYTES) {
    return { ok: false, needNextStage: true, bytes: bytes, longSide: longSide }
  }
  return { ok: true, bytes: bytes, longSide: longSide }
}

function formatCompressionNote(result) {
  if (!result || !result.processed) return ''
  var longSide = toNumber(result.longSide) || Math.max(toNumber(result.width), toNumber(result.height))
  var bytes = toNumber(result.bytes)
  return '已自动压缩（长边 ' + longSide + 'px / ' + formatMb(bytes) + 'MB）'
}

/* ------------------------ 供应商规格压缩（SPEC v0.11） ------------------------ */

/** 规划是否需要按供应商规格压缩；返回 {ok,needsCompression,reasons,oriented,longSide,bytes,reason} 或端上错误。 */
function planVendorSpec(info) {
  info = info || {}
  var width = toNumber(info.width)
  var height = toNumber(info.height)
  var bytes = toNumber(info.size !== undefined ? info.size : info.bytes)
  var orientation = info.orientation ? String(info.orientation) : 'up'

  if (!(width > 0) || !(height > 0)) {
    return photoFail('PHOTO_PROCESS_FAILED', 'invalid_dimensions')
  }

  var oriented = imagePrep.orientedSize({ width: width, height: height, orientation: orientation })
  var longSide = Math.max(oriented.width, oriented.height)
  if (longSide < MIN_LONG_SIDE) {
    return photoFail('PHOTO_TOO_SMALL', 'too_small')
  }

  var transform = imagePrep.orientationTransform(orientation)
  var jpeg = imagePrep.isJpegLike(info.path || info.type || info.mime)
  var reasons = []
  if (transform.rotate !== 0 || transform.flipX) reasons.push('exif_orientation')
  if (longSide > VENDOR_MAX_LONG_SIDE) reasons.push('oversized_pixels')
  if (!jpeg) reasons.push('not_jpeg')
  if (bytes > VENDOR_MAX_BYTES) reasons.push('oversized_bytes')

  var reason = null
  if (reasons.length) {
    // 超出我方上传限制（>10MB 或 >4096px）算 upload_limit；仅超供应商规格算 vendor_limit。
    reason = bytes > MAX_BYTES || longSide > LEVEL1_LONG_SIDE ? 'upload_limit' : 'vendor_limit'
  }

  return {
    ok: true,
    needsCompression: reasons.length > 0,
    reasons: reasons,
    oriented: { width: oriented.width, height: oriented.height },
    longSide: longSide,
    bytes: bytes,
    reason: reason
  }
}

/** 按 go 原因生成压缩提示（AC-29 ③）：upload_limit 显示前后对比，vendor_limit 只说明原因。 */
function formatVendorCompressionNote(result) {
  if (!result || !result.processed) return ''
  var longSide = toNumber(result.longSide) || Math.max(toNumber(result.width), toNumber(result.height))
  if (result.reason === 'upload_limit') {
    var fromLong = toNumber(result.originalLongSide) || longSide
    var fromBytes = toNumber(result.originalBytes)
    return '已自动压缩照片（长边 ' + fromLong + '→' + longSide + '，大小 ' + formatMb(fromBytes) + '→' + formatMb(result.bytes) + 'MB）'
  }
  return '已自动优化照片（供应商限制）'
}

/**
 * 执行供应商规格压缩（尺寸档外层、质量档内层，达标即停）。
 * deps: {renderJpeg(src,info,target,opts), sizeOf(path), now?}；返回压缩结果或端上错误。
 */
function compressToVendorSpec(deps, info) {
  deps = deps || {}
  var plan = planVendorSpec(info)
  if (!plan.ok) return Promise.resolve(plan)

  if (!plan.needsCompression) {
    return Promise.resolve({
      ok: true,
      processed: false,
      compressed: false,
      path: info.path,
      filePath: info.path,
      bytes: plan.bytes,
      width: plan.oriented.width,
      height: plan.oriented.height,
      longSide: plan.longSide,
      mime: 'image/jpeg',
      quality: null,
      sizeStep: null,
      sizeTier: null,
      elapsedMs: 0,
      reason: null,
      compressedReason: null,
      originalBytes: plan.bytes,
      originalLongSide: plan.longSide,
      attempts: []
    })
  }

  if (typeof deps.renderJpeg !== 'function') {
    return Promise.resolve(photoFail('PHOTO_PROCESS_FAILED', 'renderer_unavailable'))
  }
  if (typeof deps.sizeOf !== 'function') {
    return Promise.resolve(photoFail('PHOTO_PROCESS_FAILED', 'size_probe_unavailable'))
  }

  var started = deps.now ? deps.now() : Date.now()
  var attempts = []
  var tierIndex = 0
  var qualityIndex = 0
  var sourceInfo = {
    width: toNumber(info.width),
    height: toNumber(info.height),
    orientation: info.orientation ? String(info.orientation) : 'up'
  }

  function attempt() {
    if (tierIndex >= VENDOR_SIZE_TIERS.length) {
      return Promise.resolve(photoFail('PHOTO_VENDOR_SPEC', 'vendor_spec_exhausted'))
    }
    var sizeStep = VENDOR_SIZE_TIERS[tierIndex]
    var quality = VENDOR_QUALITY_TIERS[qualityIndex]
    var target = imagePrep.computeResize(plan.oriented.width, plan.oriented.height, sizeStep)
    return Promise.resolve()
      .then(function () {
        return deps.renderJpeg(info.path, sourceInfo, { width: target.width, height: target.height }, { quality: quality })
      })
      .then(function (rendered) {
        if (!rendered || !rendered.path) {
          throw photoFail('PHOTO_PROCESS_FAILED', 'render_empty')
        }
        return Promise.resolve(deps.sizeOf(rendered.path)).then(function (bytes) {
          var produced = {
            path: rendered.path,
            width: toNumber(rendered.width || target.width),
            height: toNumber(rendered.height || target.height),
            bytes: toNumber(bytes)
          }
          var longSide = Math.max(produced.width, produced.height)
          attempts.push({
            sizeStep: sizeStep,
            quality: quality,
            width: produced.width,
            height: produced.height,
            longSide: longSide,
            bytes: produced.bytes
          })
          if (longSide <= VENDOR_MAX_LONG_SIDE && produced.bytes > 0 && produced.bytes <= VENDOR_MAX_BYTES) {
            return {
              ok: true,
              processed: true,
              compressed: true,
              path: produced.path,
              filePath: produced.path,
              bytes: produced.bytes,
              width: produced.width,
              height: produced.height,
              longSide: longSide,
              mime: 'image/jpeg',
              quality: quality,
              sizeStep: sizeStep,
              sizeTier: sizeStep,
              elapsedMs: (deps.now ? deps.now() : Date.now()) - started,
              reason: plan.reason,
              compressedReason: plan.reason,
              originalBytes: plan.bytes,
              originalLongSide: plan.longSide,
              attempts: attempts
            }
          }
          // 先降质量、再降尺寸（SPEC v0.11 §B.2）。
          qualityIndex += 1
          if (qualityIndex >= VENDOR_QUALITY_TIERS.length) {
            qualityIndex = 0
            tierIndex += 1
          }
          return attempt()
        })
      })
  }

  return attempt().catch(function (error) {
    if (error && error.ok === false && error.apiCode !== undefined) {
      return error
    }
    return photoFail('PHOTO_PROCESS_FAILED', (error && (error.message || error.errMsg)) || 'render_failed')
  })
}

function compressToVendorSpecFromWx(wxRef, info) {
  return compressToVendorSpec(createWxDeps(wxRef), info)
}

/**
 * uploadFile 前二次断言（AC-29 ③）：仍超供应商规格 -> 5007 且不得上传。
 * @returns {{ok:true}|{ok:false,code,apiCode,name,message,hint,reasons}}
 */
function assertVendorSpec(meta) {
  meta = meta || {}
  var bytes = toNumber(meta.bytes !== undefined ? meta.bytes : meta.size)
  var width = toNumber(meta.width)
  var height = toNumber(meta.height)
  var jpeg = imagePrep.isJpegLike(meta.path || meta.mime || meta.type)
  var reasons = []
  if (!jpeg) reasons.push('not_jpeg')
  if (width > 0 && height > 0 && Math.max(width, height) > VENDOR_MAX_LONG_SIDE) reasons.push('oversized_pixels')
  if (bytes > VENDOR_MAX_BYTES) reasons.push('oversized_bytes')
  if (!reasons.length) return { ok: true }
  var failed = photoFail('PHOTO_VENDOR_SPEC', 'vendor_spec')
  failed.reasons = reasons
  return failed
}

/**
 * 执行两级自适应压缩。
 * @param {object} deps - {renderJpeg(src, info, target, opts) -> Promise<{path,width,height}>, sizeOf(path) -> Promise<number>, now?}
 * @param {object} info - {path,size,width,height,orientation,type}
 * @returns {Promise<object>} 成功 {ok:true, processed, path, bytes, width, height, mime:'image/jpeg', longSide, attempts, compressMs}
 */
function adaptPhoto(deps, info) {
  deps = deps || {}
  var plan = planAdaptive(info)
  if (!plan.ok) return Promise.resolve(plan)

  if (!plan.needsCompression) {
    return Promise.resolve({
      ok: true,
      processed: false,
      path: info.path,
      bytes: toNumber(info.size),
      width: plan.oriented.width,
      height: plan.oriented.height,
      mime: imagePrep.isJpegLike(info.path || info.type || info.mime) ? 'image/jpeg' : 'image/png',
      longSide: plan.longSide,
      attempts: []
    })
  }

  if (typeof deps.renderJpeg !== 'function') {
    return Promise.resolve(photoFail('PHOTO_PROCESS_FAILED', 'renderer_unavailable'))
  }
  if (typeof deps.sizeOf !== 'function') {
    return Promise.resolve(photoFail('PHOTO_PROCESS_FAILED', 'size_probe_unavailable'))
  }

  var started = deps.now ? deps.now() : Date.now()
  var attempts = []
  var stageNo = 1
  var src = info.path
  var sourceInfo = {
    width: toNumber(info.width),
    height: toNumber(info.height),
    orientation: info.orientation ? String(info.orientation) : 'up'
  }
  var target = { width: plan.stage1.width, height: plan.stage1.height }
  var quality = plan.stage1.quality

  function runStage() {
    return Promise.resolve()
      .then(function () {
        return deps.renderJpeg(src, sourceInfo, target, { quality: quality })
      })
      .then(function (rendered) {
        if (!rendered || !rendered.path) {
          throw photoFail('PHOTO_PROCESS_FAILED', 'render_empty')
        }
        return Promise.resolve(deps.sizeOf(rendered.path)).then(function (bytes) {
          var produced = {
            path: rendered.path,
            width: toNumber(rendered.width || target.width),
            height: toNumber(rendered.height || target.height),
            bytes: toNumber(bytes)
          }
          var verdict = evaluateProduced(produced)
          attempts.push({
            stage: stageNo,
            quality: quality,
            width: produced.width,
            height: produced.height,
            longSide: verdict.longSide,
            bytes: produced.bytes
          })
          if (verdict.ok) {
            return {
              ok: true,
              processed: true,
              path: produced.path,
              bytes: produced.bytes,
              width: produced.width,
              height: produced.height,
              mime: 'image/jpeg',
              longSide: verdict.longSide,
              attempts: attempts,
              compressMs: (deps.now ? deps.now() : Date.now()) - started
            }
          }
          if (!verdict.needNextStage || stageNo >= MAX_STAGES) {
            return photoFail('PHOTO_TOO_LARGE', 'still_oversized')
          }
          // 第二级：以第一级输出为源（方向已归一为 up），长边压到 3072。
          stageNo += 1
          var next = computeStageTarget(produced.width, produced.height, LEVEL2_LONG_SIDE)
          src = produced.path
          sourceInfo = { width: produced.width, height: produced.height, orientation: 'up' }
          target = { width: next.width, height: next.height }
          quality = LEVEL2_QUALITY
          return runStage()
        })
      })
  }

  return runStage().catch(function (error) {
    if (error && error.code && error.apiCode !== undefined && error.ok === false) {
      return error
    }
    return photoFail('PHOTO_PROCESS_FAILED', (error && (error.message || error.errMsg)) || 'render_failed')
  })
}

/** 从 wx 能力组装默认 deps（仅真机/开发者工具可用）。 */
function createWxDeps(wxRef) {
  function renderJpeg(src, info, target, opts) {
    if (!wxRef || typeof wxRef.createOffscreenCanvas !== 'function') {
      return Promise.reject(new Error('E_CANVAS_UNAVAILABLE'))
    }
    return imagePrep.renderNormalized(
      src,
      { width: info.width, height: info.height, orientation: info.orientation || 'up' },
      { width: target.width, height: target.height },
      opts
    )
  }

  function sizeOf(path) {
    return new Promise(function (resolve, reject) {
      if (!wxRef) {
        reject(new Error('E_NO_WX'))
        return
      }
      if (typeof wxRef.getFileInfo === 'function') {
        wxRef.getFileInfo({
          filePath: path,
          success: function (res) {
            resolve(res && res.size)
          },
          fail: reject
        })
        return
      }
      if (typeof wxRef.getFileSystemManager === 'function') {
        var fs = wxRef.getFileSystemManager()
        if (fs && typeof fs.stat === 'function') {
          fs.stat({
            path: path,
            success: function (res) {
              resolve(res && res.stats && res.stats.size)
            },
            fail: reject
          })
          return
        }
      }
      reject(new Error('E_SIZE_UNAVAILABLE'))
    })
  }

  return { renderJpeg: renderJpeg, sizeOf: sizeOf, now: Date.now }
}

function adaptPhotoFromWx(wxRef, info) {
  return adaptPhoto(createWxDeps(wxRef), info)
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  MIN_LONG_SIDE: MIN_LONG_SIDE,
  LEVEL1_LONG_SIDE: LEVEL1_LONG_SIDE,
  LEVEL2_LONG_SIDE: LEVEL2_LONG_SIDE,
  LEVEL1_QUALITY: LEVEL1_QUALITY,
  LEVEL2_QUALITY: LEVEL2_QUALITY,
  VENDOR_MAX_BYTES: VENDOR_MAX_BYTES,
  VENDOR_MAX_LONG_SIDE: VENDOR_MAX_LONG_SIDE,
  VENDOR_SIZE_TIERS: VENDOR_SIZE_TIERS,
  VENDOR_QUALITY_TIERS: VENDOR_QUALITY_TIERS,
  PHOTO_ERRORS: PHOTO_ERRORS,
  getPhotoErrorMeta: getPhotoErrorMeta,
  formatMb: formatMb,
  planAdaptive: planAdaptive,
  planVendorSpec: planVendorSpec,
  formatVendorCompressionNote: formatVendorCompressionNote,
  computeStageTarget: computeStageTarget,
  evaluateProduced: evaluateProduced,
  formatCompressionNote: formatCompressionNote,
  compressToVendorSpec: compressToVendorSpec,
  compressToVendorSpecFromWx: compressToVendorSpecFromWx,
  assertVendorSpec: assertVendorSpec,
  adaptPhoto: adaptPhoto,
  createWxDeps: createWxDeps,
  adaptPhotoFromWx: adaptPhotoFromWx
}
