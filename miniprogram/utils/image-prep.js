// image-prep.js
// SPIKE-0001 第 7 项：端上图片预处理可行性验证。
// 纯函数（可在 Node 中验证）+ wx 适配层（只能真机/开发者工具跑）。
// 目标（SPEC §B / REQ）：JPG、长边 <= 4096、<= 10MB、EXIF 方向正确、可压缩/缩放。

'use strict';

var MAX_LONG_SIDE = 4096;
var MAX_BYTES = 10 * 1024 * 1024;
var JPEG_QUALITY = 90;

// EXIF orientation -> 画布纠正参数（顺时针 rotate 角度 + 水平镜像）。
// wx.getImageInfo 的 orientation 语义：left/right 表示图片内容相对正立被旋转过，
// 画布需反向旋转才能正立，因此 left -> 顺时针 90，right -> 顺时针 270。
function orientationTransform(orientation) {
  var table = {
    up: { rotate: 0, flipX: false },
    down: { rotate: 180, flipX: false },
    left: { rotate: 90, flipX: false },
    right: { rotate: 270, flipX: false },
    'up-mirrored': { rotate: 0, flipX: true },
    'down-mirrored': { rotate: 180, flipX: true },
    'left-mirrored': { rotate: 90, flipX: true },
    'right-mirrored': { rotate: 270, flipX: true }
  };
  return table[orientation] || table.up;
}

function isJpegLike(pathOrType) {
  return /jpe?g/i.test(String(pathOrType || ''));
}

function computeResize(width, height, maxLongSide) {
  var limit = maxLongSide || MAX_LONG_SIDE;
  var longSide = Math.max(width, height);
  if (!width || !height || longSide <= limit) {
    return { width: width, height: height, scale: 1, resized: false };
  }
  var scale = limit / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale: scale,
    resized: true
  };
}

function orientedSize(info) {
  var transform = orientationTransform(info.orientation);
  var swapped = transform.rotate === 90 || transform.rotate === 270;
  return {
    width: swapped ? info.height : info.width,
    height: swapped ? info.width : info.height
  };
}

// 生成处理计划：顺序 = EXIF 方向 -> 缩放 -> 转 JPG -> 二次压缩
function planPhotoProcessing(info) {
  var transform = orientationTransform(info.orientation);
  var oriented = orientedSize(info);
  var resize = computeResize(oriented.width, oriented.height, MAX_LONG_SIDE);
  var jpeg = isJpegLike(info.type || info.path);
  var problems = [];
  var steps = [];

  if (transform.rotate !== 0 || transform.flipX) {
    problems.push('exif_orientation');
    steps.push('apply-exif-orientation');
  }
  if (resize.resized) {
    problems.push('oversized_pixels');
    steps.push('resize-long-side');
  }
  if (!jpeg) {
    problems.push('not_jpeg');
    steps.push('convert-to-jpeg');
  }
  if (info.size > MAX_BYTES) {
    problems.push('oversized_bytes');
  }
  if (info.size > MAX_BYTES || !jpeg || steps.length > 0) {
    steps.push('compress-to-jpeg');
  }

  return {
    ok: steps.length === 0,
    problems: problems,
    steps: steps,
    oriented: oriented,
    target: { width: resize.width, height: resize.height, resized: resize.resized },
    exceedsHardLimits: resize.resized || info.size > MAX_BYTES
  };
}

// 判断一张待上传图能否直接进供应商链路。
function validateForUpload(info) {
  var plan = planPhotoProcessing(info);
  var reasons = [];
  if (!info.width || !info.height) reasons.push('invalid_dimensions');
  if (plan.oriented.width < 512 || plan.oriented.height < 512) reasons.push('too_small');
  return {
    ok: reasons.length === 0,
    reasons: reasons,
    plan: plan
  };
}

/* ------------------------- wx 适配层（仅真机/开发者工具） ------------------------- */

function promisify(fn, options) {
  return new Promise(function (resolve, reject) {
    fn(
      Object.assign({}, options, {
        success: function (res) {
          resolve(res);
        },
        fail: function (err) {
          reject(err);
        }
      })
    );
  });
}

// 必须在上游已获得相册/摄像头隐私授权后调用（SPEC §F / CP-05）。
function choosePhoto() {
  return promisify(wx.chooseMedia, {
    count: 1,
    mediaType: ['image'],
    sourceType: ['album', 'camera'],
    sizeType: ['original', 'compressed']
  }).then(function (res) {
    var file = (res.tempFiles && res.tempFiles[0]) || null;
    if (!file) throw new Error('E_NO_FILE');
    return {
      path: file.tempFilePath,
      size: file.size,
      type: file.fileType || '',
      width: file.width || 0,
      height: file.height || 0
    };
  });
}

function inspectPhoto(file) {
  return promisify(wx.getImageInfo, { src: file.path }).then(function (info) {
    return {
      path: file.path,
      size: file.size,
      type: file.type,
      width: info.width,
      height: info.height,
      orientation: info.orientation,
      format: info.type || ''
    };
  });
}

function loadImage(canvas, src) {
  return new Promise(function (resolve, reject) {
    var image = canvas.createImage();
    image.onload = function () {
      resolve(image);
    };
    image.onerror = function (err) {
      reject(err);
    };
    image.src = src;
  });
}

// 用离屏 canvas 一次性完成 EXIF 纠正 + 长边缩放 + JPG 输出。
// 可选 options.quality：两级自适应压缩时按级别调低质量（默认 JPEG_QUALITY）。
function renderNormalized(src, info, target, options) {
  var quality = options && options.quality ? Number(options.quality) : JPEG_QUALITY;
  var transform = orientationTransform(info.orientation);
  var rotate = transform.rotate;
  var outWidth = target.width;
  var outHeight = target.height;
  var canvas = wx.createOffscreenCanvas({ type: '2d', width: outWidth, height: outHeight });
  var ctx = canvas.getContext('2d');
  return loadImage(canvas, src).then(function (image) {
    ctx.save();
    ctx.translate(outWidth / 2, outHeight / 2);
    if (transform.flipX) ctx.scale(-1, 1);
    ctx.rotate((rotate * Math.PI) / 180);
    if (rotate === 90 || rotate === 270) {
      ctx.drawImage(image, -outHeight / 2, -outWidth / 2, outHeight, outWidth);
    } else {
      ctx.drawImage(image, -outWidth / 2, -outHeight / 2, outWidth, outHeight);
    }
    ctx.restore();
    return promisify(wx.canvasToTempFilePath, {
      canvas: canvas,
      x: 0,
      y: 0,
      width: outWidth,
      height: outHeight,
      destWidth: outWidth,
      destHeight: outHeight,
      fileType: 'jpg',
      quality: quality
    });
  }).then(function (res) {
    return {
      path: res.tempFilePath,
      width: outWidth,
      height: outHeight,
      processingPlan: planPhotoProcessing(
        Object.assign({}, info, { orientation: 'up' })
      )
    };
  });
}

// 端上完整预处理：选择 -> 读取 -> 计划 -> 归一化输出。
function chooseAndPrepare() {
  return choosePhoto()
    .then(function (file) {
      return inspectPhoto(file);
    })
    .then(function (info) {
      var plan = planPhotoProcessing(info);
      if (!plan.exceedsHardLimits) {
        return {
          path: info.path,
          width: plan.oriented.width,
          height: plan.oriented.height,
          plan: plan,
          processed: false
        };
      }
      return renderNormalized(info.path, info, plan.target).then(function (out) {
        return {
          path: out.path,
          width: out.width,
          height: out.height,
          plan: plan,
          processed: true
        };
      });
    });
}

module.exports = {
  MAX_LONG_SIDE: MAX_LONG_SIDE,
  MAX_BYTES: MAX_BYTES,
  JPEG_QUALITY: JPEG_QUALITY,
  orientationTransform: orientationTransform,
  isJpegLike: isJpegLike,
  computeResize: computeResize,
  orientedSize: orientedSize,
  planPhotoProcessing: planPhotoProcessing,
  validateForUpload: validateForUpload,
  choosePhoto: choosePhoto,
  inspectPhoto: inspectPhoto,
  renderNormalized: renderNormalized,
  chooseAndPrepare: chooseAndPrepare
};
