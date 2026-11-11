#!/usr/bin/env node
/**
 * task-69 离线压缩档位测量（DEV 侧证据脚本，不入小程序包）
 *
 * 目的：用桌面真机测试照片包里的人像照 02/03/04/05/06，走与端上相同的
 * `compressToVendorSpec` 规划/档位逻辑，记录「原图 → 压缩后」的字节、长边、
 * 档位与耗时。
 *
 * 边界（如实标注，不冒充真机）：
 * - 渲染编码用 node_modules 内已有的 jimp（纯 Node），仅用于近似微信
 *   `wx.createOffscreenCanvas` + `canvasToTempFilePath` 的编码体积。
 * - 因此“压缩后字节/耗时”是离线近似值；真实端上 canvas 的最终体积与耗时
 *   仍需真机 CP-12 验证（§DEV-0001-52 已标注）。
 * - 档位选择（4096→3072→2048→1024 × 0.92→…→0.5、达标即停）与 prompt/reason
 *   完全复用 `miniprogram/services/photo-adapt.js` 的真实实现，不是复刻。
 *
 * 用法（仓库根目录）：
 *   node docs/dev/task69-photo-compress-measure.js
 * 输出：
 *   docs/dev/task69-photo-compress-evidence/measure-result.json
 *   docs/dev/task69-photo-compress-evidence/measure-table.txt
 */

'use strict'

var fs = require('fs')
var path = require('path')
var Jimp = require('jimp')

var photoAdapt = require('../../miniprogram/services/photo-adapt')

var PHOTO_DIR = 'C:\\Users\\admin\\Desktop\\Sinn-真机测试照片'
var CASES = [
  { id: '02', file: '人像照\\02-人像-超大-6000px.jpg' },
  { id: '03', file: '人像照\\03-人像-压后仍超10MB.jpg' },
  { id: '04', file: '人像照\\04-人像-低分辨率-800px.jpg' },
  { id: '05', file: '人像照\\05-人像-EXIF竖拍-5184px.jpg' },
  { id: '06', file: '人像照\\06-人像-PNG格式-2400px.png' }
]
var OUT_DIR = path.join(__dirname, 'task69-photo-compress-evidence')

/** 读取 JPEG APP1 里的 EXIF Orientation（1..8），非 JPEG / 无 EXIF 返回 1。 */
function readExifOrientation(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1
  var offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    var marker = buffer[offset + 1]
    if (marker === 0xda || marker === 0xd9) break
    var size = buffer.readUInt16BE(offset + 2)
    if (marker === 0xe1 && offset + 10 <= buffer.length) {
      var head = buffer.toString('ascii', offset + 4, offset + 10)
      if (head === 'Exif\u0000\u0000') {
        var tiff = offset + 10
        var little = buffer.toString('ascii', tiff, tiff + 2) === 'II'
        function readU16(p) {
          return little ? buffer.readUInt16LE(p) : buffer.readUInt16BE(p)
        }
        function readU32(p) {
          return little ? buffer.readUInt32LE(p) : buffer.readUInt32BE(p)
        }
        var ifd = tiff + readU32(tiff + 4)
        var count = readU16(ifd)
        for (var i = 0; i < count; i += 1) {
          var entry = ifd + 2 + i * 12
          if (readU16(entry) === 0x0112) return readU16(entry + 8) || 1
        }
      }
    }
    offset += 2 + size
  }
  return 1
}

/** EXIF Orientation 数值 → 微信 wx.getImageInfo 的 orientation 字符串。 */
function exifToWxOrientation(exifNumber) {
  switch (exifNumber) {
    case 2:
      return 'up-mirrored'
    case 3:
      return 'down'
    case 4:
      return 'down-mirrored'
    case 5:
      return 'left-mirrored'
    case 6:
      return 'right'
    case 7:
      return 'right-mirrored'
    case 8:
      return 'left'
    default:
      return 'up'
  }
}

/**
 * 与 image-prep.orientationTransform 对齐的 jimp 近似旋转/镜像。
 * orientation 使用微信字符串口径（up/down/left/right 及 mirrored）。
 */
function applyWxOrientation(image, orientation) {
  switch (orientation) {
    case 'up-mirrored':
      return image.flip(true, false)
    case 'down':
      return image.rotate(180)
    case 'down-mirrored':
      return image.flip(false, true)
    case 'left':
      return image.rotate(90)
    case 'left-mirrored':
      return image.rotate(90).flip(true, false)
    case 'right':
      return image.rotate(270)
    case 'right-mirrored':
      return image.rotate(270).flip(true, false)
    default:
      return image
  }
}

function makeDeps(rawImage, orientation, log) {
  var seq = 0
  var bytesMap = {}
  return {
    now: function () {
      return Date.now()
    },
    renderJpeg: function (srcPath, info, target, options) {
      seq += 1
      var quality = options && options.quality ? options.quality : 0.9
      return Promise.resolve()
        .then(function () {
          var img = applyWxOrientation(rawImage.clone(), orientation)
          img = img.resize(target.width, target.height)
          img.quality(Math.round(quality * 100))
          return img.getBufferAsync(Jimp.MIME_JPEG)
        })
        .then(function (buf) {
          var outPath = '/offline/approx-' + seq + '.jpg'
          bytesMap[outPath] = buf.length
          var entry = {
            seq: seq,
            target: target,
            quality: quality,
            bytes: buf.length
          }
          log.renders.push(entry)
          return { path: outPath, width: target.width, height: target.height }
        })
    },
    sizeOf: function (outPath) {
      return Promise.resolve(bytesMap[outPath] || 0)
    }
  }
}

module.exports = { run: run }

async function run() {
  if (!fs.existsSync(PHOTO_DIR)) {
    throw new Error('测试照片目录不存在：' + PHOTO_DIR)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  var results = []
  for (var i = 0; i < CASES.length; i += 1) {
    var item = CASES[i]
    var filePath = path.join(PHOTO_DIR, item.file)
    var buffer = fs.readFileSync(filePath)
    var stat = fs.statSync(filePath)
    var exifNumber = readExifOrientation(buffer)
    var orientation = exifToWxOrientation(exifNumber)
    var image = await Jimp.read(filePath)
    var info = {
      path: filePath,
      size: stat.size,
      width: image.bitmap.width,
      height: image.bitmap.height,
      orientation: orientation,
      type: path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
    }
    // 原图（按 EXIF 方向修正后）的长边
    var rawPlan = photoAdapt.planVendorSpec({
      path: info.path,
      size: info.size,
      width: image.bitmap.width,
      height: image.bitmap.height,
      orientation: orientation,
      type: info.type
    })
    var log = { renders: [] }
    var outcome
    if (!rawPlan.ok) {
      // 低分辨率等：记录拒绝原因，不进入压缩
      outcome = { ok: false, code: rawPlan.code, message: rawPlan.message, reason: rawPlan.reason }
    } else if (!rawPlan.needsCompression) {
      outcome = { ok: true, processed: false, bytes: info.size, longSide: rawPlan.longSide }
    } else {
      var deps = makeDeps(image, orientation, log)
      deps.now = function () {
        return Date.now()
      }
      outcome = await photoAdapt.compressToVendorSpec(deps, info)
    }
    results.push({
      id: item.id,
      file: item.file,
      original: {
        bytes: info.size,
        width: image.bitmap.width,
        height: image.bitmap.height,
        exifOrientation: exifNumber,
        orientation: orientation,
        type: info.type
      },
      plan: {
        ok: rawPlan.ok,
        needsCompression: rawPlan.needsCompression,
        reasons: rawPlan.reasons,
        reason: rawPlan.reason || null,
        longSide: rawPlan.longSide
      },
      renders: log.renders,
      outcome: outcome
    })
  }

  var payload = {
    generatedAt: new Date().toISOString(),
    method: 'offline-approx(jimp 0.6.8 canvas emulation)',
    note: '档位/提示文案来自真实 photo-adapt.js；编码体积与耗时是 jimp 离线近似，真机 canvas 结果需 CP-12 验证。',
    cases: results
  }
  fs.writeFileSync(path.join(OUT_DIR, 'measure-result.json'), JSON.stringify(payload, null, 2), 'utf8')

  var lines = []
  lines.push('task-69 离线压缩档位测量（jimp 近似；真机 canvas 待 CP-12）')
  lines.push('')
  results.forEach(function (r) {
    var o = r.original
    var oc = r.outcome || {}
    lines.push('#' + r.id + ' ' + r.file)
    lines.push(
      '  原图: ' + o.width + 'x' + o.height + ' / ' + o.bytes + 'B / type=' + o.type +
        ' / EXIF Orientation=' + o.exifOrientation + '（wx=' + o.orientation + '）'
    )
    lines.push(
      '  规划: ok=' + r.plan.ok + ' needsCompression=' + r.plan.needsCompression + ' reason=' + r.plan.reason +
        ' reasons=' + JSON.stringify(r.plan.reasons) + ' orientedLongSide=' + r.plan.longSide
    )
    if (oc.ok === false) {
      lines.push('  结果: 拒绝 code=' + oc.code + ' reason=' + oc.reason + ' message=' + oc.message)
    } else {
      lines.push(
        '  结果: processed=' + oc.processed + ' longSide=' + (oc.longSide || '') + ' bytes=' + (oc.bytes || '') +
          ' quality=' + (oc.quality || '') + ' sizeStep=' + (oc.sizeStep || '') +
          ' elapsedMs=' + (oc.elapsedMs || 0) + ' reason=' + (oc.reason || oc.compressedReason || '')
      )
      if (r.renders.length) {
        lines.push('  档位尝试(' + r.renders.length + ' 次):')
        r.renders.forEach(function (render) {
          lines.push(
            '    #' + render.seq + ' ' + render.target.width + 'x' + render.target.height +
              ' q=' + render.quality + ' -> ' + render.bytes + 'B'
          )
        })
      }
    }
    lines.push('')
  })
  fs.writeFileSync(path.join(OUT_DIR, 'measure-table.txt'), lines.join('\n'), 'utf8')
  return payload
}

if (require.main === module) {
  run()
    .then(function (payload) {
      console.log('OK cases=' + payload.cases.length)
      payload.cases.forEach(function (r) {
        var oc = r.outcome || {}
        console.log(
          '#' + r.id + ' orig=' + r.original.bytes + 'B ' + r.original.width + 'x' + r.original.height +
            ' -> ' + (oc.ok === false ? 'REJECT code=' + oc.code : 'bytes=' + (oc.bytes || 0) + 'B longSide=' + (oc.longSide || 0)) +
            ' renders=' + (r.renders || []).length
        )
      })
    })
    .catch(function (err) {
      console.error('MEASURE_FAILED:', err && err.stack ? err.stack : err)
      process.exitCode = 1
    })
}
