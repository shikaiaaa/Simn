// zoom-math.js
// SPIKE-0001 S2 兜底方案的纯计算层（不依赖 wx / 页面实例），可在 Node 中直接单测。
// 约定：state = { scale, x, y }，transform-origin 为图片中心；x/y 为相对视口中心的像素平移。
// 约束来自 SPEC-0001 D-3 / 结果页 AC：1x-3x、等比、不可拖出视口、可复位。

'use strict';

var MIN_SCALE = 1;
var MAX_SCALE = 3;

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function distance(a, b) {
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function createState() {
  return { scale: MIN_SCALE, x: 0, y: 0 };
}

function resetState() {
  return createState();
}

// 等比缩放模式（contain）下图片在视口中的实际显示尺寸。
function fitSize(contentWidth, contentHeight, viewportWidth, viewportHeight) {
  if (!contentWidth || !contentHeight) {
    return { width: viewportWidth, height: viewportHeight };
  }
  var ratio = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
  return {
    width: contentWidth * ratio,
    height: contentHeight * ratio
  };
}

// 当前缩放级别下允许的最大平移量（保证图片边缘不进入视口内部）。
function maxTranslation(scale, viewport, content) {
  var scaledWidth = content.width * scale;
  var scaledHeight = content.height * scale;
  return {
    x: Math.max(0, (scaledWidth - viewport.width) / 2),
    y: Math.max(0, (scaledHeight - viewport.height) / 2)
  };
}

// 把任意 state 收敛到合法范围（scale 1-3，平移不越界）。
function withBounds(state, viewport, content) {
  var scale = clamp(state.scale, MIN_SCALE, MAX_SCALE);
  var limit = maxTranslation(scale, viewport, content);
  return {
    scale: scale,
    x: clamp(state.x, -limit.x, limit.x),
    y: clamp(state.y, -limit.y, limit.y)
  };
}

// 双指缩放：以 focalStart（手势开始时的双指中点）为锚点计算新平移，
// 使该锚点下的图片内容在缩放后仍位于 focalCurrent 下（focalCurrent 缺省=不移动）。
function zoomAt(base, targetScale, focalStart, focalCurrent, viewport, content) {
  var scale = clamp(targetScale, MIN_SCALE, MAX_SCALE);
  var next = { scale: scale, x: base.x, y: base.y };
  if (!focalStart) {
    return withBounds(next, viewport, content);
  }
  var center = { x: viewport.width / 2, y: viewport.height / 2 };
  var current = focalCurrent || focalStart;
  var startDx = focalStart.x - center.x;
  var startDy = focalStart.y - center.y;
  var currentDx = current.x - center.x;
  var currentDy = current.y - center.y;
  // 手势开始时 focal 指向的内容坐标（相对图片中心）。
  var pointX = (startDx - base.x) / base.scale;
  var pointY = (startDy - base.y) / base.scale;
  next.x = currentDx - pointX * scale;
  next.y = currentDy - pointY * scale;
  return withBounds(next, viewport, content);
}

function panBy(base, dx, dy, viewport, content) {
  return withBounds(
    { scale: base.scale, x: base.x + dx, y: base.y + dy },
    viewport,
    content
  );
}

function transformOf(state) {
  return 'translate(' + state.x + 'px, ' + state.y + 'px) scale(' + state.scale + ')';
}

module.exports = {
  MIN_SCALE: MIN_SCALE,
  MAX_SCALE: MAX_SCALE,
  clamp: clamp,
  distance: distance,
  midpoint: midpoint,
  createState: createState,
  resetState: resetState,
  fitSize: fitSize,
  maxTranslation: maxTranslation,
  withBounds: withBounds,
  zoomAt: zoomAt,
  panBy: panBy,
  transformOf: transformOf
};
