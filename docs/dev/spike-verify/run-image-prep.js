// docs/dev/spike-verify/run-image-prep.js
// SPIKE-0001 第 7 项：端上图片预处理纯函数验证。
// 注意：canvas 实际绘制（createOffscreenCanvas / canvasToTempFilePath）无法在 Node 验证，
// 只能真机/开发者工具人工验证，报告中标「阻塞 + 解锁条件」。
'use strict';

var harness = require('./lib/harness');
var imagePrep = require('../../../miniprogram/utils/image-prep');

var MB = 1024 * 1024;

function run() {
  harness.group('image-prep（端上预处理纯函数，Node）');

  harness.test('模块加载不依赖 wx（纯函数可在 Node 运行）', function () {
    harness.assert(typeof wx === 'undefined', 'Node 环境不应存在全局 wx');
    harness.assert(typeof imagePrep.planPhotoProcessing === 'function', '缺少 planPhotoProcessing');
    harness.assert(typeof imagePrep.chooseAndPrepare === 'function', '缺少 chooseAndPrepare');
  });

  harness.test('常量：长边 4096 / 10MB / JPEG 质量 90', function () {
    harness.equal(imagePrep.MAX_LONG_SIDE, 4096);
    harness.equal(imagePrep.MAX_BYTES, 10 * MB);
    harness.equal(imagePrep.JPEG_QUALITY, 90);
  });

  harness.test('EXIF orientation 映射（8 种）', function () {
    harness.equal(imagePrep.orientationTransform('up'), { rotate: 0, flipX: false });
    harness.equal(imagePrep.orientationTransform('down'), { rotate: 180, flipX: false });
    harness.equal(imagePrep.orientationTransform('left'), { rotate: 90, flipX: false });
    harness.equal(imagePrep.orientationTransform('right'), { rotate: 270, flipX: false });
    harness.equal(imagePrep.orientationTransform('up-mirrored'), { rotate: 0, flipX: true });
    harness.equal(imagePrep.orientationTransform('down-mirrored'), { rotate: 180, flipX: true });
    harness.equal(imagePrep.orientationTransform('left-mirrored'), { rotate: 90, flipX: true });
    harness.equal(imagePrep.orientationTransform('right-mirrored'), { rotate: 270, flipX: true });
    harness.equal(imagePrep.orientationTransform('unknown'), { rotate: 0, flipX: false });
  });

  harness.test('isJpegLike：jpg/JPEG 为真，png/heic 为假', function () {
    harness.assert(imagePrep.isJpegLike('a.jpg'), 'jpg 应为真');
    harness.assert(imagePrep.isJpegLike('a.JPEG'), 'JPEG 应为真');
    harness.assert(!imagePrep.isJpegLike('a.png'), 'png 应为假');
    harness.assert(!imagePrep.isJpegLike('a.heic'), 'heic 应为假');
  });

  harness.test('computeResize：8000x6000 → 4096x3072', function () {
    var resize = imagePrep.computeResize(8000, 6000);
    harness.equal(resize.width, 4096);
    harness.equal(resize.height, 3072);
    harness.assert(resize.resized, '应标记 resized');
  });

  harness.test('computeResize：4000x2000 不缩放', function () {
    var resize = imagePrep.computeResize(4000, 2000);
    harness.equal(resize, { width: 4000, height: 2000, scale: 1, resized: false });
  });

  harness.test('orientedSize：EXIF left 交换宽高（4000x3000 → 3000x4000）', function () {
    harness.equal(imagePrep.orientedSize({ width: 4000, height: 3000, orientation: 'left' }), {
      width: 3000,
      height: 4000
    });
  });

  harness.test('planPhotoProcessing：干净 JPG（1200x1600, 2MB, up）无需处理', function () {
    var plan = imagePrep.planPhotoProcessing({
      width: 1200,
      height: 1600,
      type: 'jpg',
      size: 2 * MB,
      orientation: 'up'
    });
    harness.equal(plan.ok, true);
    harness.equal(plan.steps, []);
    harness.equal(plan.problems, []);
    harness.equal(plan.exceedsHardLimits, false);
  });

  harness.test('planPhotoProcessing：PNG 5000x7000 + EXIF left + 11MB → 四类问题齐全', function () {
    var plan = imagePrep.planPhotoProcessing({
      width: 5000,
      height: 7000,
      type: 'png',
      size: 11 * MB,
      orientation: 'left'
    });
    harness.equal(plan.problems, [
      'exif_orientation',
      'oversized_pixels',
      'not_jpeg',
      'oversized_bytes'
    ]);
    harness.equal(plan.steps, [
      'apply-exif-orientation',
      'resize-long-side',
      'convert-to-jpeg',
      'compress-to-jpeg'
    ]);
    harness.equal(plan.oriented, { width: 7000, height: 5000 });
    harness.equal(plan.target.width, 4096);
    harness.equal(plan.target.height, 2926);
    harness.equal(plan.exceedsHardLimits, true);
  });

  harness.test('planPhotoProcessing：EXIF left 后长边方向正确（3000x4000 无需缩放）', function () {
    var plan = imagePrep.planPhotoProcessing({
      width: 3000,
      height: 4000,
      type: 'jpg',
      size: 3 * MB,
      orientation: 'left'
    });
    harness.equal(plan.problems, ['exif_orientation']);
    harness.equal(plan.target, { width: 4000, height: 3000, resized: false });
  });

  harness.test('validateForUpload：过小图片判 too_small', function () {
    var result = imagePrep.validateForUpload({
      width: 300,
      height: 400,
      type: 'jpg',
      size: 0.1 * MB,
      orientation: 'up'
    });
    harness.equal(result.ok, false);
    harness.equal(result.reasons, ['too_small']);
  });

  harness.test('validateForUpload：缺尺寸判 invalid_dimensions（同时命中 too_small）', function () {
    var result = imagePrep.validateForUpload({ width: 0, height: 0, type: 'jpg', size: 1 });
    harness.equal(result.reasons, ['invalid_dimensions', 'too_small']);
  });

  harness.test('validateForUpload：12MB JPG 可上传，但计划强制压缩', function () {
    var result = imagePrep.validateForUpload({
      width: 3000,
      height: 3000,
      type: 'jpg',
      size: 12 * MB,
      orientation: 'up'
    });
    harness.equal(result.ok, true);
    harness.equal(result.plan.problems, ['oversized_bytes']);
    harness.assert(result.plan.steps.indexOf('compress-to-jpeg') >= 0, '缺少压缩步骤');
    harness.equal(result.plan.exceedsHardLimits, true);
  });
}

module.exports = { run: run };
