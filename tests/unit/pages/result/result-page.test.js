// result-page.test.js —— 试穿结果页（DEV-0001-08 / AC-13/16/17/18/19/20/23/26）
// 覆盖：加载 taskGet、失败与 404、降级提示、三围全缺、删除二次确认与物理删除后的跳转、
// 复位入口、AI 标识与无导购入口的静态契约。

'use strict';

var fs = require('fs');
var path = require('path');

var pageConfig = null;
global.Page = function (config) {
  pageConfig = config;
};
require('../../../../miniprogram/pages/result/result.js');

var api = require('../../../../miniprogram/services/api');
var sizeService = require('../../../../miniprogram/services/size');

var RESULT_DIR = path.join(__dirname, '../../../../miniprogram/pages/result');

function readPageFile(name) {
  return fs.readFileSync(path.join(RESULT_DIR, name), 'utf8');
}

function createPage() {
  var page = {
    data: JSON.parse(JSON.stringify(pageConfig.data))
  };
  Object.keys(pageConfig).forEach(function (key) {
    if (typeof pageConfig[key] === 'function' && key !== 'data') page[key] = pageConfig[key];
  });
  page.setData = function (patch) {
    Object.keys(patch).forEach(function (key) {
      page.data[key] = patch[key];
    });
  };
  page.selectComponent = jest.fn(function () {
    return null;
  });
  return page;
}

function flush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

function setConsentStorage() {
  wx.__setMock('getStorageSync', function (key) {
    if (key === api.STORAGE_KEYS.CONSENT) {
      return JSON.stringify({ version: '2026-11-09-v1', agreedAt: 1, ageConfirmedAt: 2 });
    }
    return '';
  });
}

function successResult(overrides) {
  return Object.assign(
    {
      taskId: 't_1',
      status: 'SUCCEEDED',
      result: {
        fileID: 'cloud://mock-env/sinn/result/20261109/t_1.png',
        width: 2048,
        height: 2731,
        sizeResult: {
          rangeMin: 'L',
          rangeMax: 'XL',
          standard: 'GB/T 1335.1',
          basis: { heightCm: 175, weightKg: 70 },
          disclaimer: '参考尺码，不构成合身承诺'
        },
        sizeFallback: null
      }
    },
    overrides || {}
  );
}

function mockCloud(handler) {
  wx.__setMock('cloud.callFunction', function (opts) {
    return Promise.resolve(handler(opts));
  });
}

describe('result 页：静态契约（AC-18 / AC-23 / AC-26）', () => {
  test('四件套存在，wxml 含缩放、AI 标识、尺码、删除本次', () => {
    ['result.js', 'result.wxml', 'result.wxss', 'result.json'].forEach(function (name) {
      expect(fs.existsSync(path.join(RESULT_DIR, name))).toBe(true);
    });
    var wxml = readPageFile('result.wxml');
    expect(wxml).toContain('zoom-view');
    expect(wxml).toContain('{{aiLabel}}');
    expect(wxml).toContain('参考尺码');
    expect(wxml).toContain('复位');
    expect(wxml).toContain('删除本次结果');
    expect(wxml).toContain('{{sizeView.disclaimer}}');
    expect(wxml).toContain('{{sizeView.insufficientText}}');
    expect(sizeService.SIZE_DISCLAIMER).toBe('参考尺码，不构成合身承诺');
    expect(sizeService.SIZE_INSUFFICIENT_TEXT).toBe('信息不足，无法给出参考尺码');
  });

  test('AI 标识在 zoom-view 之外（不随图片缩放）', () => {
    var wxml = readPageFile('result.wxml');
    var zoomIndex = wxml.indexOf('</zoom-view>');
    var badgeIndex = wxml.indexOf('result-ai-badge');
    expect(zoomIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(zoomIndex);
    expect(wxml).toContain('{{aiLabel}}');
    expect(pageConfig.data.aiLabel).toBe('AI 生成');
  });

  test('无分享/保存相册/价格购买/商家/3D/形象库入口', () => {
    var wxml = readPageFile('result.wxml');
    ['分享', '保存相册', '价格', '购买', '下单', '商家', '3D', '形象库'].forEach(function (word) {
      expect(wxml).not.toContain(word);
    });
    expect(readPageFile('result.js')).not.toContain('onShareAppMessage');
  });

  test('注册 zoom-view 组件', () => {
    var config = JSON.parse(readPageFile('result.json'));
    expect(config.usingComponents['zoom-view']).toBe('/components/zoom-view/zoom-view');
  });
});

describe('result 页：加载与渲染', () => {
  beforeEach(function () {
    wx.__reset();
    wx.__setMock('getStorageSync', function () {
      return '';
    });
  });

  test('缺少 taskId 直接报错，不发网络请求', function () {
    var page = createPage();
    page.onLoad({});
    expect(page.data.loading).toBe(false);
    expect(page.data.errorText).toContain('缺少任务信息');
    expect(wx.cloud.callFunction).not.toHaveBeenCalled();
  });

  test('加载成功：taskGet → 临时链接 + 尺码展示', async function () {
    mockCloud(function () {
      return wx.__success(successResult());
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.loading).toBe(false);
    expect(page.data.errorText).toBe('');
    expect(page.data.imageUrl).toBe('https://mock.example.com/temp.jpg');
    expect(page.data.sizeView.available).toBe(true);
    expect(page.data.sizeView.rangeText).toBe('L–XL');
    expect(page.data.sizeView.standardText).toBe('标准：GB/T 1335.1');
    expect(page.data.sizeView.disclaimer).toBe('参考尺码，不构成合身承诺');
    expect(page.data.degradedNotice).toBe('');
  });

  test('降级结果提示长边与人工复核', async function () {
    var task = successResult();
    task.result.sizeFallback = { degraded: true, longSide: 1536, expected: 2048, requiresReview: true };
    mockCloud(function () {
      return wx.__success(task);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.degradedNotice).toContain('1536');
    expect(page.data.degradedNotice).toContain('放大检查');
  });

  test('三围全缺（sizeResult=null）显示信息不足文案', async function () {
    var task = successResult();
    task.result.sizeResult = null;
    mockCloud(function () {
      return wx.__success(task);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.sizeView.available).toBe(false);
    expect(page.data.sizeView.insufficientText).toBe('信息不足，无法给出参考尺码');
  });

  test('任务未成功不展示结果页内容', async function () {
    var task = successResult({ status: 'FAILED' });
    delete task.result;
    mockCloud(function () {
      return wx.__success(task);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.errorText).toContain('未成功完成');
  });

  test('404：任务已被删除时给出「不存在或已删除」', async function () {
    mockCloud(function () {
      return wx.__failure(5004, 'E_TASK_NOT_FOUND', '任务不存在', 404);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.loading).toBe(false);
    expect(page.data.errorText).toContain('不存在或已删除');
  });

  test('网络异常映射为网络提示', async function () {
    wx.__setMock('cloud.callFunction', function () {
      return Promise.reject({ errMsg: 'cloud.callFunction:fail network' });
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    expect(page.data.errorText).toContain('网络异常');
  });
});

describe('result 页：缩放复位与删除本次', () => {
  beforeEach(function () {
    wx.__reset();
    setConsentStorage();
    wx.__setMock('showModal', function (opts) {
      if (opts && typeof opts.success === 'function') opts.success({ confirm: true, cancel: false });
    });
  });

  test('复位按钮调用 zoom-view.reset()', function () {
    var page = createPage();
    var reset = jest.fn();
    page.selectComponent = jest.fn(function () {
      return { reset: reset };
    });
    page.onResetZoom();
    expect(page.selectComponent).toHaveBeenCalledWith('#zoom-view');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test('删除本次：二次确认 → deleteTask → 清本地 active → 回首页', async function () {
    var calls = [];
    mockCloud(function (opts) {
      calls.push(opts.data.action);
      if (opts.data.action === 'taskGet') return wx.__success(successResult());
      if (opts.data.action === 'deleteTask') return wx.__success({ deletedAt: Date.now() });
      return wx.__failure(9000, 'E_INTERNAL', 'unexpected', 500);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    page.onDeleteTap();
    expect(wx.showModal).toHaveBeenCalledTimes(1);
    await flush();
    expect(calls).toContain('deleteTask');
    expect(wx.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/index/index' }));
    expect(wx.removeStorageSync).toHaveBeenCalledWith(api.STORAGE_KEYS.ACTIVE_TASK);
  });

  test('删除确认框取消则不删除', async function () {
    var calls = [];
    mockCloud(function (opts) {
      calls.push(opts.data.action);
      return wx.__success(successResult());
    });
    wx.__setMock('showModal', function (opts) {
      opts.success({ confirm: false, cancel: true });
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    calls.length = 0;
    page.onDeleteTap();
    await flush();
    expect(calls).not.toContain('deleteTask');
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });

  test('删除返回 404（已被清理）仍按成功回首页', async function () {
    mockCloud(function (opts) {
      if (opts.data.action === 'taskGet') return wx.__success(successResult());
      return wx.__failure(5004, 'E_TASK_NOT_FOUND', '任务不存在', 404);
    });
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    await flush();
    page.onDeleteTap();
    await flush();
    expect(wx.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/index/index' }));
  });
});

describe('result 页：AC-7 端到端计时埋点（SPEC v0.9）', function () {
  var appMock;

  beforeEach(function () {
    wx.__reset();
    wx.__setMock('getStorageSync', function () {
      return '';
    });
    mockCloud(function () {
      return wx.__success(successResult());
    });
    appMock = { globalData: {} };
    global.getApp = function () {
      return appMock;
    };
  });

  afterEach(function () {
    delete global.getApp;
    jest.restoreAllMocks();
  });

  test('结果页 onload 记录 createdAt/resultReadyAt/elapsedMs，结构化日志且不写 Storage', function () {
    var info = jest.spyOn(console, 'info').mockImplementation(function () {});
    var createdAt = Date.now() - 5000;
    appMock.globalData.ac7Timing = { requestId: 'req-createTask', taskId: 't_1', createdAt: createdAt };
    var page = createPage();
    page.onLoad({ taskId: 't_1' });

    var record = appMock.globalData.ac7Last;
    expect(record.requestId).toBe('req-createTask');
    expect(record.taskId).toBe('t_1');
    expect(record.createdAt).toBe(createdAt);
    expect(record.resultReadyAt).toBeGreaterThanOrEqual(createdAt + 5000);
    expect(record.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(record.elapsedMs).toBeLessThanOrEqual(96000);
    expect(appMock.globalData.ac7Timing).toBeNull();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe('[sinn/ac7]');
    var payload = JSON.parse(info.mock.calls[0][1]);
    expect(Object.keys(payload).sort()).toEqual(['createdAt', 'elapsedMs', 'requestId', 'resultReadyAt', 'taskId']);
    expect(payload).not.toHaveProperty('fileID');
    expect(payload).not.toHaveProperty('imageUrl');
    expect(JSON.stringify(payload)).not.toContain('base64');
    expect(wx.setStorageSync).not.toHaveBeenCalled();
  });

  test('无 ac7Timing 或 taskId 不匹配时不记录、不打印', function () {
    var info = jest.spyOn(console, 'info').mockImplementation(function () {});
    var page = createPage();
    page.onLoad({ taskId: 't_1' });
    expect(appMock.globalData.ac7Last).toBeUndefined();
    expect(info).not.toHaveBeenCalled();

    appMock.globalData.ac7Timing = { requestId: 'req-other', taskId: 't_other', createdAt: 123 };
    page = createPage();
    page.onLoad({ taskId: 't_1' });
    expect(appMock.globalData.ac7Last).toBeUndefined();
    expect(appMock.globalData.ac7Timing.taskId).toBe('t_other');
    expect(info).not.toHaveBeenCalled();
  });
});
