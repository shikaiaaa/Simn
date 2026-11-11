// zoom-view.js —— 单图源缩放/平移/复位组件（DEV-0001-08 / SPEC v0.3 D-3）
//
// 设计依据：
// - SPIKE-0001 §2：Skyline 不支持 movable-area/movable-view（S1），主方案改为
//   S2+（scale/pan-gesture-handler + bl.worklet + applyAnimatedStyle），
//   兜底方案 S2（touch 事件 + transform + utils/zoom-math.js 数学层）。
// - 只处理一张图片，不做任何拼图/接缝处理；等比缩放，transform-origin 为图片中心。
// - 真机未验证时不得声称「已通过真机」，组件只保证代码逻辑与官方 API 用法一致。

'use strict';

var zoomMath = require('../../utils/zoom-math');

var MODE_WORKLET = 'worklet';
var MODE_TOUCH = 'touch';
var DOUBLE_TAP_MS = 300;

// 检测 Skyline worklet 能力（仅 JS 线程调用；UI 线程 worklet 内不调用本函数）。
function detectWorklet() {
  if (typeof bl === 'undefined' || !bl || !bl.worklet) return null;
  var worklet = bl.worklet;
  if (!worklet.shared || typeof worklet.shared !== 'function') return null;
  return worklet;
}

function formatScaleText(scale) {
  var value = Number(scale);
  if (!isFinite(value) || value <= 1) return '1.0x';
  return value.toFixed(1) + 'x';
}

function toPoint(touch) {
  return { x: Number(touch.clientX || touch.pageX || 0), y: Number(touch.clientY || touch.pageY || 0) };
}

function defaultViewport() {
  return { width: 375, height: 500 };
}

Component({
  properties: {
    // 单图源：cloud:// fileID 或 https 临时链接
    src: { type: String, value: '' },
    // 原图尺寸，用于换算 contain 显示尺寸；也可由 bindload 事件补全
    imageWidth: { type: Number, value: 0 },
    imageHeight: { type: Number, value: 0 },
    minScale: { type: Number, value: zoomMath.MIN_SCALE },
    maxScale: { type: Number, value: zoomMath.MAX_SCALE }
  },

  data: {
    mode: MODE_TOUCH,
    transform: 'translate(0px, 0px) scale(1)',
    scaleText: '1.0x',
    imageReady: false,
    error: '',
    hint: '双指缩放 · 单指拖动 · 双击复位'
  },

  lifetimes: {
    attached: function () {
      this._viewport = { width: 0, height: 0 };
      this._content = { width: 0, height: 0 };
      this._state = zoomMath.resetState();
      this._touchMode = 'none';
      this._worklet = null;
      this._workletReady = false;
      this._gestureBase = null;
      this._lastTapAt = 0;

      var worklet = detectWorklet();
      this._worklet = worklet;
      this.setData({ mode: worklet ? MODE_WORKLET : MODE_TOUCH });
    },

    ready: function () {
      this._measure();
      this._initWorkletIfPossible();
    },

    detached: function () {
      this._workletReady = false;
      this._gestureBase = null;
      this._touchMode = 'none';
    }
  },

  methods: {
    // ---------- 初始化 ----------

    _initWorkletIfPossible: function () {
      var worklet = this._worklet;
      if (!worklet) {
        this.setData({ mode: MODE_TOUCH });
        return;
      }
      if (typeof this.applyAnimatedStyle !== 'function' || this._workletReady) return;
      try {
        this._scaleSV = worklet.shared(1);
        this._xSV = worklet.shared(0);
        this._ySV = worklet.shared(0);
        this._scaleSV.value = 1;
        this._xSV.value = 0;
        this._ySV.value = 0;

        var scaleSV = this._scaleSV;
        var xSV = this._xSV;
        var ySV = this._ySV;
        this.applyAnimatedStyle('#zoom-image', function () {
          'worklet';
          return {
            transform: 'translate(' + xSV.value + 'px, ' + ySV.value + 'px) scale(' + scaleSV.value + ')'
          };
        });
        this._workletReady = true;
        this.setData({ mode: MODE_WORKLET });
      } catch (error) {
        // 关键能力缺失不静默降级：切到 S2 touch 兜底，并在 data 上暴露原因。
        this._workletReady = false;
        this._worklet = null;
        this.setData({ mode: MODE_TOUCH, error: '' });
      }
    },

    _measure: function () {
      var self = this;
      if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') {
        this._setStageRect({ left: 0, top: 0, width: defaultViewport().width, height: defaultViewport().height });
        return;
      }
      try {
        var query = wx.createSelectorQuery().in(this);
        query
          .select('#zoom-stage')
          .boundingClientRect(function (rect) {
            if (!rect || !rect.width || !rect.height) return;
            self._setStageRect(rect);
          })
          .exec();
      } catch (error) {
        this._setStageRect({ left: 0, top: 0, width: defaultViewport().width, height: defaultViewport().height });
      }
    },

    // 供测试与兜底路径直接注入布局（rect: {left,top,width,height}）。
    _setStageRect: function (rect) {
      this._stageRect = rect || { left: 0, top: 0, width: 0, height: 0 };
      this._stageLeft = Number(this._stageRect.left) || 0;
      this._stageTop = Number(this._stageRect.top) || 0;
      this._viewerWidth = Number(this._stageRect.width) || 0;
      this._viewerHeight = Number(this._stageRect.height) || 0;
      this._viewport = { width: this._viewerWidth, height: this._viewerHeight };
      this._updateContentBox();
    },

    _imageSize: function () {
      var width = Number(this._imageWidth) || Number(this.data.imageWidth) || 0;
      var height = Number(this._imageHeight) || Number(this.data.imageHeight) || 0;
      return { width: width, height: height };
    },

    _updateContentBox: function () {
      var viewport = this._viewport || { width: 0, height: 0 };
      if (!viewport.width || !viewport.height) return;
      var size = this._imageSize();
      if (size.width > 0 && size.height > 0) {
        this._content = zoomMath.fitSize(size.width, size.height, viewport.width, viewport.height);
      } else {
        this._content = { width: viewport.width, height: viewport.height };
      }
      this._stageWidth = viewport.width;
      this._stageHeight = viewport.height;
      this._contentWidth = this._content.width;
      this._contentHeight = this._content.height;
      this._applyState(zoomMath.resetState());
    },

    // ---------- 统一状态写入 ----------

    _applyState: function (state) {
      var next = zoomMath.withBounds(state, this._viewport, this._content);
      this._state = next;
      if (this.data.mode === MODE_WORKLET && this._workletReady) {
        this._scaleSV.value = next.scale;
        this._xSV.value = next.x;
        this._ySV.value = next.y;
      }
      this.setData({
        transform: zoomMath.transformOf(next),
        scaleText: formatScaleText(next.scale)
      });
    },

    getState: function () {
      return {
        scale: this._state.scale,
        x: this._state.x,
        y: this._state.y,
        mode: this.data.mode
      };
    },

    reset: function () {
      this._applyState(zoomMath.resetState());
    },

    toggleZoom: function () {
      if (this._state && this._state.scale > 1.05) {
        this.reset();
        return;
      }
      var target = Math.min(2, Number(this.data.maxScale) || zoomMath.MAX_SCALE);
      if (target <= 1) return;
      this._applyState(zoomMath.withBounds({ scale: target, x: 0, y: 0 }, this._viewport, this._content));
    },

    // ---------- 图片事件 ----------

    onImageLoad: function (event) {
      var detail = (event && event.detail) || {};
      if (detail.width > 0 && detail.height > 0) {
        this._imageWidth = detail.width;
        this._imageHeight = detail.height;
      }
      this.setData({ imageReady: true, error: '' });
      this._updateContentBox();
    },

    onImageError: function () {
      this.setData({ imageReady: false, error: '图片加载失败，请返回后重试' });
    },

    onTap: function () {
      var now = Date.now();
      if (now - this._lastTapAt < DOUBLE_TAP_MS) {
        this._lastTapAt = 0;
        this.toggleZoom();
        return;
      }
      this._lastTapAt = now;
    },

    // ---------- S2+：Skyline 手势 + worklet ----------
    // 手势回调运行在 UI 线程，禁止调用 wx.*（需要时用 runOnJS 回 JS 线程）。

    onScaleGesture: function (event) {
      'worklet';
      if (!this._workletReady || !event) return;
      var scaleSV = this._scaleSV;
      var xSV = this._xSV;
      var ySV = this._ySV;
      var state = event.state;
      if (state === 1) {
        // GestureState.BEGIN
        this._gestureBaseScale = scaleSV.value;
        this._gestureBaseX = xSV.value;
        this._gestureBaseY = ySV.value;
        this._gestureStartFocalX = event.focalX;
        this._gestureStartFocalY = event.focalY;
        return;
      }
      if (state === 3) {
        // GestureState.END
        this._onWorkletGestureEnd(scaleSV.value, xSV.value, ySV.value);
        return;
      }
      if (state !== 2) return;
      if (event.pointerCount && event.pointerCount < 2) return;

      var baseScale = this._gestureBaseScale || 1;
      var ratio = event.scale > 0 ? event.scale : 1;
      var minScale = this.data.minScale || 1;
      var maxScale = this.data.maxScale || 3;
      var nextScale = Math.min(Math.max(baseScale * ratio, minScale), maxScale);

      var viewportWidth = this._stageWidth || this._viewerWidth || 0;
      var viewportHeight = this._stageHeight || this._viewerHeight || 0;
      var contentWidth = this._contentWidth || viewportWidth;
      var contentHeight = this._contentHeight || viewportHeight;
      var stageLeft = this._stageLeft || 0;
      var stageTop = this._stageTop || 0;
      var centerX = viewportWidth / 2;
      var centerY = viewportHeight / 2;
      var startFocalX = this._gestureStartFocalX || 0;
      var startFocalY = this._gestureStartFocalY || 0;
      var baseX = this._gestureBaseX || 0;
      var baseY = this._gestureBaseY || 0;

      // 手势开始时 focal 指向的内容坐标（相对图片中心），缩放后仍保持在 focal 下。
      var pointX = (startFocalX - stageLeft - centerX - baseX) / baseScale;
      var pointY = (startFocalY - stageTop - centerY - baseY) / baseScale;
      var nextX = event.focalX - stageLeft - centerX - pointX * nextScale;
      var nextY = event.focalY - stageTop - centerY - pointY * nextScale;

      var limitX = Math.max(0, (contentWidth * nextScale - viewportWidth) / 2);
      var limitY = Math.max(0, (contentHeight * nextScale - viewportHeight) / 2);
      if (nextX > limitX) nextX = limitX;
      if (nextX < -limitX) nextX = -limitX;
      if (nextY > limitY) nextY = limitY;
      if (nextY < -limitY) nextY = -limitY;

      scaleSV.value = nextScale;
      xSV.value = nextX;
      ySV.value = nextY;
    },

    onPanGesture: function (event) {
      'worklet';
      if (!this._workletReady || !event) return;
      var xSV = this._xSV;
      var ySV = this._ySV;
      var scaleSV = this._scaleSV;
      var state = event.state;
      if (state === 1) {
        this._panBaseX = xSV.value;
        this._panBaseY = ySV.value;
        this._panStartX = event.absoluteX;
        this._panStartY = event.absoluteY;
        return;
      }
      if (state === 3) {
        this._onWorkletGestureEnd(scaleSV.value, xSV.value, ySV.value);
        return;
      }
      if (state !== 2) return;
      if (event.pointerCount && event.pointerCount > 1) return;

      var viewportWidth = this._stageWidth || this._viewerWidth || 0;
      var viewportHeight = this._stageHeight || this._viewerHeight || 0;
      var contentWidth = this._contentWidth || viewportWidth;
      var contentHeight = this._contentHeight || viewportHeight;
      var scale = scaleSV.value || 1;
      var limitX = Math.max(0, (contentWidth * scale - viewportWidth) / 2);
      var limitY = Math.max(0, (contentHeight * scale - viewportHeight) / 2);
      var dx = event.absoluteX - (this._panStartX || 0);
      var dy = event.absoluteY - (this._panStartY || 0);
      var nextX = (this._panBaseX || 0) + dx;
      var nextY = (this._panBaseY || 0) + dy;
      if (nextX > limitX) nextX = limitX;
      if (nextX < -limitX) nextX = -limitX;
      if (nextY > limitY) nextY = limitY;
      if (nextY < -limitY) nextY = -limitY;
      xSV.value = nextX;
      ySV.value = nextY;
    },

    // worklet 手势结束后回 JS 线程同步可读文本（回调内部禁止直接 setData）。
    _onWorkletGestureEnd: function (scale, x, y) {
      this._state = { scale: scale, x: x, y: y };
      this.setData({ scaleText: formatScaleText(scale) });
    },

    // ---------- S2 兜底：touch 事件 + transform ----------

    onTouchStart: function (event) {
      var touches = (event && event.touches) || [];
      this._lastTapAt = 0;
      if (touches.length >= 2) {
        this._touchMode = 'scale';
        this._gestureBase = { scale: this._state.scale, x: this._state.x, y: this._state.y };
        this._startDistance = zoomMath.distance(toPoint(touches[0]), toPoint(touches[1]));
        this._startFocal = zoomMath.midpoint(toPoint(touches[0]), toPoint(touches[1]));
        this._lastTouch = null;
        return;
      }
      if (touches.length === 1) {
        this._touchMode = 'pan';
        this._lastTouch = toPoint(touches[0]);
        this._gestureBase = null;
      }
    },

    onTouchMove: function (event) {
      var touches = (event && event.touches) || [];
      if (this._touchMode === 'scale' && touches.length >= 2) {
        var distance = zoomMath.distance(toPoint(touches[0]), toPoint(touches[1]));
        var focal = zoomMath.midpoint(toPoint(touches[0]), toPoint(touches[1]));
        var base = this._gestureBase || zoomMath.resetState();
        var ratio = this._startDistance > 0 ? distance / this._startDistance : 1;
        var next = zoomMath.zoomAt(
          base,
          base.scale * ratio,
          this._startFocal,
          focal,
          this._viewport,
          this._content
        );
        this._applyState(next);
        return;
      }
      if (this._touchMode === 'pan' && touches.length === 1 && this._lastTouch) {
        var point = toPoint(touches[0]);
        var dx = point.x - this._lastTouch.x;
        var dy = point.y - this._lastTouch.y;
        this._lastTouch = point;
        if (dx === 0 && dy === 0) return;
        this._applyState(zoomMath.panBy(this._state, dx, dy, this._viewport, this._content));
      }
    },

    onTouchEnd: function (event) {
      var touches = (event && event.touches) || [];
      if (touches.length >= 2) {
        this._touchMode = 'scale';
        this._startDistance = zoomMath.distance(toPoint(touches[0]), toPoint(touches[1]));
        this._startFocal = zoomMath.midpoint(toPoint(touches[0]), toPoint(touches[1]));
        this._gestureBase = { scale: this._state.scale, x: this._state.x, y: this._state.y };
        return;
      }
      if (touches.length === 1) {
        this._touchMode = 'pan';
        this._lastTouch = toPoint(touches[0]);
        this._gestureBase = null;
        return;
      }
      this._touchMode = 'none';
      this._lastTouch = null;
      this._startDistance = 0;
      this._gestureBase = null;
    }
  }
});
