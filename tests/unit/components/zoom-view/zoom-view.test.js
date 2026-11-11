// zoom-view.test.js —— 单图源缩放组件（DEV-0001-08 / AC-13）
// S2+ 主路径（worklet 手势数学）与 S2 兜底（touch + transform）均在此验证；
// 真机手势行为不可自动化，真机验证仍属 CP-12 阻塞，见 docs/dev/DEV-0001.md。

'use strict';

var fs = require('fs');
var path = require('path');

var zoomMath = require('../../../../miniprogram/utils/zoom-math');

var componentConfig = null;
global.Component = function (config) {
  componentConfig = config;
};
require('../../../../miniprogram/components/zoom-view/zoom-view.js');

var COMPONENT_DIR = path.join(__dirname, '../../../../miniprogram/components/zoom-view');

function readComponentFile(name) {
  return fs.readFileSync(path.join(COMPONENT_DIR, name), 'utf8');
}

function createInstance() {
  var inst = {
    data: JSON.parse(JSON.stringify(componentConfig.data))
  };
  Object.keys(componentConfig.properties || {}).forEach(function (key) {
    var property = componentConfig.properties[key];
    inst.data[key] = property && property.value !== undefined ? property.value : '';
  });
  Object.keys(componentConfig.methods || {}).forEach(function (name) {
    inst[name] = componentConfig.methods[name];
  });
  inst.setData = function (patch) {
    Object.keys(patch).forEach(function (key) {
      inst.data[key] = patch[key];
    });
  };
  return inst;
}

function mount(stageRect) {
  var inst = createInstance();
  componentConfig.lifetimes.attached.call(inst);
  componentConfig.lifetimes.ready.call(inst);
  inst._setStageRect(stageRect || { left: 0, top: 0, width: 375, height: 500 });
  inst.onImageLoad({ detail: { width: 1024, height: 1536 } });
  return inst;
}

function pinch(inst, fromDistance, toDistance) {
  inst.onTouchStart({
    touches: [
      { clientX: 100, clientY: 300 },
      { clientX: 100 + fromDistance, clientY: 300 }
    ]
  });
  inst.onTouchMove({
    touches: [
      { clientX: 100, clientY: 300 },
      { clientX: 100 + toDistance, clientY: 300 }
    ]
  });
}

function workletFakes(inst) {
  inst.data.mode = 'worklet';
  inst._workletReady = true;
  inst._scaleSV = { value: 1 };
  inst._xSV = { value: 0 };
  inst._ySV = { value: 0 };
}

describe('zoom-view 组件：静态契约', () => {
  test('组件四件套存在且 json 声明 component', () => {
    ['zoom-view.js', 'zoom-view.json', 'zoom-view.wxml', 'zoom-view.wxss'].forEach(function (name) {
      expect(fs.existsSync(path.join(COMPONENT_DIR, name))).toBe(true);
    });
    expect(JSON.parse(readComponentFile('zoom-view.json'))).toEqual({ component: true });
  });

  test('wxml 使用 Skyline 手势组件 + worklet 回调，且不使用 S1 movable', () => {
    var wxml = readComponentFile('zoom-view.wxml');
    expect(wxml).toContain('scale-gesture-handler');
    expect(wxml).toContain('pan-gesture-handler');
    expect(wxml).toContain('worklet:ongesture="onScaleGesture"');
    expect(wxml).toContain('worklet:ongesture="onPanGesture"');
    expect(wxml).not.toContain('movable-area');
    expect(wxml).not.toContain('movable-view');
    expect(wxml).toContain('src="{{src}}"');
    expect(wxml).toContain('show-menu-by-longpress="{{false}}"');
  });

  test('组件暴露缩放/平移/复位方法与两种模式', () => {
    expect(typeof componentConfig.methods.onScaleGesture).toBe('function');
    expect(typeof componentConfig.methods.onPanGesture).toBe('function');
    expect(typeof componentConfig.methods.reset).toBe('function');
    expect(typeof componentConfig.methods.toggleZoom).toBe('function');
    expect(componentConfig.properties.minScale.value).toBe(1);
    expect(componentConfig.properties.maxScale.value).toBe(3);
  });
});

describe('zoom-view 组件：S2 兜底（touch + transform）', () => {
  test('无 worklet 能力时进入 touch 模式（S2 兜底）', () => {
    var inst = mount();
    expect(inst.data.mode).toBe('touch');
    expect(inst.data.scaleText).toBe('1.0x');
    expect(inst.getState().mode).toBe('touch');
  });

  test('contain 布局计算显示尺寸', () => {
    var inst = mount({ left: 10, top: 20, width: 375, height: 500 });
    expect(inst._stageLeft).toBe(10);
    expect(inst._stageTop).toBe(20);
    expect(inst._contentWidth).toBeCloseTo(333.33, 1);
    expect(inst._contentHeight).toBeCloseTo(500, 1);
  });

  test('双指放大：以 focal 为锚点缩放且不越界', () => {
    var inst = mount();
    pinch(inst, 100, 200);
    var state = inst.getState();
    expect(state.scale).toBeCloseTo(2, 1);
    expect(Math.abs(state.x)).toBeLessThanOrEqual(145.84);
    expect(inst.data.transform).toContain('scale(2');
    expect(inst.data.scaleText).toBe('2.0x');
  });

  test('缩放上限为 3x', () => {
    var inst = mount();
    pinch(inst, 100, 1000);
    expect(inst.getState().scale).toBe(3);
    expect(inst.data.transform).toContain('scale(3');
  });

  test('1x 时无溢出不产生平移（边界收敛）', () => {
    var inst = mount();
    inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
    inst.onTouchMove({ touches: [{ clientX: 160, clientY: 340 }] });
    var state = inst.getState();
    expect(state.scale).toBe(1);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  test('放大后单指平移受边界约束', () => {
    var inst = mount();
    pinch(inst, 100, 200);
    inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
    inst.onTouchMove({ touches: [{ clientX: 120, clientY: 310 }] });
    var state = inst.getState();
    expect(state.x).toBeGreaterThan(0);
    expect(state.x).toBeLessThanOrEqual(145.84);
    expect(state.y).toBeLessThanOrEqual(250);
  });

  test('大幅拖动不会拖出边界', () => {
    var inst = mount();
    pinch(inst, 100, 300);
    var limit = zoomMath.maxTranslation(inst.getState().scale, inst._viewport, inst._content);
    inst.onTouchStart({ touches: [{ clientX: 100, clientY: 300 }] });
    inst.onTouchMove({ touches: [{ clientX: 2000, clientY: 3000 }] });
    var state = inst.getState();
    expect(state.x).toBeLessThanOrEqual(limit.x + 0.01);
    expect(state.y).toBeLessThanOrEqual(limit.y + 0.01);
    expect(state.x).toBeGreaterThanOrEqual(-limit.x - 0.01);
    expect(state.y).toBeGreaterThanOrEqual(-limit.y - 0.01);
  });

  test('双击在 1x 与 2x 间切换，再次双击复位', () => {
    var inst = mount();
    inst.onTap();
    inst.onTap();
    expect(inst.getState().scale).toBeCloseTo(2, 1);
    inst._lastTapAt = Date.now() - 100;
    inst.onTap();
    expect(inst.getState().scale).toBe(1);
  });

  test('reset() 复位到 1x 且 transform 归零', () => {
    var inst = mount();
    pinch(inst, 100, 200);
    inst.reset();
    var state = inst.getState();
    expect(state.scale).toBe(1);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
    expect(inst.data.transform).toBe('translate(0px, 0px) scale(1)');
  });

  test('图片加载失败显示错误提示（不留白屏）', () => {
    var inst = mount();
    inst.onImageError();
    expect(inst.data.error).toContain('图片加载失败');
  });
});

describe('zoom-view 组件：S2+ 主路径（worklet 手势数学）', () => {
  test('worklet 缩放回调按 focal 锚定并夹取 1x–3x', () => {
    var inst = mount();
    workletFakes(inst);

    inst.onScaleGesture({ state: 1, focalX: 187.5, focalY: 250, pointerCount: 2 });
    inst.onScaleGesture({ state: 2, focalX: 187.5, focalY: 250, scale: 2, pointerCount: 2 });

    expect(inst._scaleSV.value).toBeCloseTo(2, 2);
    expect(inst._xSV.value).toBeCloseTo(0, 2);
    expect(inst._ySV.value).toBeCloseTo(0, 2);

    inst.onScaleGesture({ state: 2, focalX: 187.5, focalY: 250, scale: 10, pointerCount: 2 });
    expect(inst._scaleSV.value).toBe(3);
  });

  test('worklet 手势结束回 JS 线程更新倍率文本（非 setData 动画帧）', () => {
    var inst = mount();
    workletFakes(inst);
    inst.onScaleGesture({ state: 1, focalX: 187.5, focalY: 250, pointerCount: 2 });
    inst.onScaleGesture({ state: 2, focalX: 187.5, focalY: 250, scale: 2, pointerCount: 2 });
    inst.onScaleGesture({ state: 3, focalX: 187.5, focalY: 250, pointerCount: 2 });
    expect(inst.data.scaleText).toBe('2.0x');
    expect(inst._state.scale).toBeCloseTo(2, 2);
  });

  test('worklet 单指平移按绝对值差计算并夹取边界', () => {
    var inst = mount();
    workletFakes(inst);
    inst._scaleSV.value = 2;

    inst.onPanGesture({ state: 1, absoluteX: 100, absoluteY: 200, pointerCount: 1 });
    inst.onPanGesture({ state: 2, absoluteX: 160, absoluteY: 240, pointerCount: 1 });

    expect(inst._xSV.value).toBeCloseTo(60, 1);
    expect(inst._ySV.value).toBeCloseTo(40, 1);

    inst.onPanGesture({ state: 1, absoluteX: 100, absoluteY: 200, pointerCount: 1 });
    inst.onPanGesture({ state: 2, absoluteX: 3000, absoluteY: 3000, pointerCount: 1 });
    expect(inst._xSV.value).toBeLessThanOrEqual(145.84);
    expect(inst._ySV.value).toBeLessThanOrEqual(250);
  });

  test('双指时 pan 回调不接管（避免与 scale 冲突）', () => {
    var inst = mount();
    workletFakes(inst);
    inst._scaleSV.value = 2;
    inst._xSV.value = 10;
    inst.onPanGesture({ state: 1, absoluteX: 100, absoluteY: 200, pointerCount: 2 });
    inst.onPanGesture({ state: 2, absoluteX: 400, absoluteY: 400, pointerCount: 2 });
    expect(inst._xSV.value).toBe(10);
    expect(inst._ySV.value).toBe(0);
  });
});
