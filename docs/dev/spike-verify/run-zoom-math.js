// docs/dev/spike-verify/run-zoom-math.js
// SPIKE-0001 第 2 项：S1/S2 缩放数学层的纯函数验证（不涉及渲染与真机，真机项在报告中标阻塞）。
'use strict';

var harness = require('./lib/harness');
var zoomMath = require('../../../miniprogram/utils/zoom-math');

function run() {
  harness.group('zoom-math（S2 缩放数学，Node 纯函数）');

  harness.test('常量：1x-3x', function () {
    harness.equal(zoomMath.MIN_SCALE, 1);
    harness.equal(zoomMath.MAX_SCALE, 3);
  });

  harness.test('clamp', function () {
    harness.equal(zoomMath.clamp(5, 1, 3), 3);
    harness.equal(zoomMath.clamp(0, 1, 3), 1);
    harness.equal(zoomMath.clamp(2, 1, 3), 2);
  });

  harness.test('distance / midpoint', function () {
    harness.equal(zoomMath.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    harness.equal(zoomMath.midpoint({ x: 0, y: 0 }, { x: 10, y: 20 }), { x: 5, y: 10 });
  });

  harness.test('初始/复位状态：scale=1, x=0, y=0', function () {
    harness.equal(zoomMath.createState(), { scale: 1, x: 0, y: 0 });
    harness.equal(zoomMath.resetState(), { scale: 1, x: 0, y: 0 });
  });

  harness.test('fitSize：2000x3000 图片放入 375x500 视口 → 333.33x500', function () {
    var fit = zoomMath.fitSize(2000, 3000, 375, 500);
    harness.approx(fit.width, 333.333, 0.01);
    harness.approx(fit.height, 500, 0.01);
  });

  harness.test('maxTranslation：scale=2、内容 333.33x500、视口 375x500', function () {
    var limit = zoomMath.maxTranslation(2, { width: 375, height: 500 }, { width: 333.333, height: 500 });
    harness.approx(limit.x, (666.666 - 375) / 2, 0.01);
    harness.approx(limit.y, (1000 - 500) / 2, 0.01);
  });

  harness.test('zoomAt：focal 锚点在缩放前后指向同一内容坐标', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 375, height: 500 };
    var base = zoomMath.createState();
    var focal = { x: 100, y: 200 };
    var next = zoomMath.zoomAt(base, 2, focal, focal, viewport, content);
    harness.equal(next.scale, 2);
    // 锚点内容坐标（相对图片中心）
    var center = { x: 187.5, y: 250 };
    var before = (focal.x - center.x - base.x) / base.scale;
    var after = (focal.x - center.x - next.x) / next.scale;
    harness.approx(after, before, 1e-9, 'focal content point moved');
  });

  harness.test('zoomAt：scale 越界被夹到 [1,3]', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 375, height: 500 };
    var base = zoomMath.createState();
    harness.equal(zoomMath.zoomAt(base, 5, null, null, viewport, content).scale, 3);
    harness.equal(zoomMath.zoomAt(base, 0.2, null, null, viewport, content).scale, 1);
  });

  harness.test('panBy：未放大时不可拖出视口', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 375, height: 500 };
    var base = zoomMath.createState();
    harness.equal(zoomMath.panBy(base, 9999, -9999, viewport, content), { scale: 1, x: 0, y: 0 });
  });

  harness.test('panBy：放大 2x 后平移被限制在边界内', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 375, height: 500 };
    var zoomed = { scale: 2, x: 0, y: 0 };
    var limit = zoomMath.maxTranslation(2, viewport, content);
    harness.equal(zoomMath.panBy(zoomed, 9999, 9999, viewport, content), {
      scale: 2,
      x: limit.x,
      y: limit.y
    });
  });

  harness.test('transformOf：仅 translate + 等比 scale（不变形）', function () {
    var transform = zoomMath.transformOf({ scale: 2, x: 10, y: -20 });
    harness.equal(transform, 'translate(10px, -20px) scale(2)');
    harness.assert(!/scaleX|scaleY|matrix/.test(transform), 'transform 不应包含非等比项');
  });

  harness.test('模拟 60 帧双指捏合：scale 单调递增且始终在 [1,3]、不越界', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 333.333, height: 500 };
    var state = zoomMath.createState();
    var focal = { x: 150, y: 250 };
    var prevScale = state.scale;
    for (var i = 1; i <= 60; i += 1) {
      var target = 1 + (i / 60) * 2;
      state = zoomMath.zoomAt(state, target, focal, focal, viewport, content);
      harness.assert(state.scale >= 1 && state.scale <= 3, 'scale 越界: ' + state.scale);
      harness.assert(state.scale >= prevScale - 1e-9, 'scale 非单调');
      var limit = zoomMath.maxTranslation(state.scale, viewport, content);
      harness.assert(Math.abs(state.x) <= limit.x + 1e-9, 'x 越界');
      harness.assert(Math.abs(state.y) <= limit.y + 1e-9, 'y 越界');
      prevScale = state.scale;
    }
    harness.assert(state.scale > 2.9, '末帧未接近 3x');
    return 'finalScale=' + state.scale.toFixed(3);
  });

  harness.test('双指捏合后单指平移，复位回到初始状态', function () {
    var viewport = { width: 375, height: 500 };
    var content = { width: 375, height: 500 };
    var state = zoomMath.zoomAt(zoomMath.createState(), 2.5, { x: 180, y: 250 }, { x: 180, y: 250 }, viewport, content);
    state = zoomMath.panBy(state, 40, -30, viewport, content);
    harness.assert(state.scale === 2.5 && state.x !== 0, '平移未生效');
    harness.equal(zoomMath.resetState(), { scale: 1, x: 0, y: 0 });
  });
}

module.exports = { run: run };
