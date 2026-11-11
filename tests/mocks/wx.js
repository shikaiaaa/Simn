/**
 * wx.* 共享 mock（由 Lead 维护，AGENTS.md 小程序专项门禁 §4）。
 *
 * 用法：
 * - jest 的 setupFiles 会加载本文件，并把它挂到 global.wx；
 * - 单测里可直接 require('../../tests/mocks/wx.js') 拿同一实例做断言；
 * - 需要改行为时用 wx.__setMock('cloud.callFunction', impl) 或直接覆盖 wx.cloud.callFunction；
 * - 每个用例前调用 wx.__reset() 清空调用记录。
 *
 * 注意：这里只 mock 接口形状，不模拟业务；契约以 docs/se/SPEC-0001.md §B 为准。
 */
'use strict';

// 在 jest 环境下用 jest.fn 记录调用，否则退化为普通函数（便于脚本里 require）。
function mockFn(impl) {
  if (typeof jest !== 'undefined') return jest.fn(impl);
  return impl || function noop() {};
}

function ok(value) {
  return Promise.resolve(value);
}

// SPEC §B 统一响应形状：{ ok, data, error, requestId, serverTime }
function success(data) {
  return {
    result: {
      ok: true,
      data: data === undefined ? null : data,
      error: null,
      requestId: 'mock-request-id',
      serverTime: Date.now()
    }
  };
}

function failure(code, name, message, httpStatus) {
  return {
    result: {
      ok: false,
      data: null,
      error: {
        code: code,
        name: name,
        message: message || 'mock error',
        hint: '',
        httpStatus: httpStatus || 500
      },
      requestId: 'mock-request-id',
      serverTime: Date.now()
    }
  };
}

const wx = {};

wx.__success = success;
wx.__failure = failure;

wx.cloud = {
  init: mockFn(function () {}),
  callFunction: mockFn(function () {
    return ok(failure(9000, 'E_INTERNAL', 'wx mock: cloud.callFunction 未配置返回值，请在用例里覆盖'));
  }),
  uploadFile: mockFn(function () {
    return ok({ fileID: 'cloud://mock-env/sinn/person/mock.jpg', statusCode: 200 });
  }),
  getTempFileURL: mockFn(function (opts) {
    return ok({ fileList: [{ fileID: opts && opts.fileList ? opts.fileList[0] : '', tempFileURL: 'https://mock.example.com/temp.jpg' }] });
  })
};

wx.chooseMedia = mockFn(function (opts) {
  if (opts && typeof opts.fail === 'function') {
    opts.fail({ errMsg: 'chooseMedia:fail mock: 未配置返回素材' });
  }
  return ok({ tempFiles: [] });
});

wx.requirePrivacyAuthorize = mockFn(function (opts) {
  if (opts && typeof opts.success === 'function') opts.success();
  return ok(null);
});

wx.onNeedPrivacyAuthorization = mockFn(function () {});
wx.offNeedPrivacyAuthorization = mockFn(function () {});

wx.getStorageSync = mockFn(function () { return ''; });
wx.setStorageSync = mockFn(function () {});
wx.removeStorageSync = mockFn(function () {});
wx.clearStorageSync = mockFn(function () {});
wx.getStorageInfoSync = mockFn(function () { return { keys: [], currentSize: 0, limitSize: 10240 }; });

wx.getWindowInfo = mockFn(function () {
  return { pixelRatio: 2, screenWidth: 375, screenHeight: 812, windowWidth: 375, windowHeight: 812, statusBarHeight: 44, safeArea: { top: 44, bottom: 778, left: 0, right: 375, width: 375, height: 734 } };
});
wx.getDeviceInfo = mockFn(function () { return { brand: 'mock', model: 'MockPhone', system: 'iOS 17.0', platform: 'ios' }; });
wx.getAppBaseInfo = mockFn(function () { return { SDKVersion: '3.18.0', language: 'zh_CN', version: '0.1.0' }; });
wx.getSystemInfoSync = mockFn(function () {
  return Object.assign({}, wx.getWindowInfo(), wx.getDeviceInfo(), wx.getAppBaseInfo());
});

wx.canIUse = mockFn(function () { return true; });
wx.getAccountInfoSync = mockFn(function () { return { miniProgram: { appId: 'wxbbdcd1c49ad1259a', envVersion: 'develop' } }; });

wx.showToast = mockFn(function () {});
wx.showLoading = mockFn(function () {});
wx.hideLoading = mockFn(function () {});
wx.showModal = mockFn(function (opts) {
  if (opts && typeof opts.success === 'function') opts.success({ confirm: true, cancel: false });
});
wx.showActionSheet = mockFn(function (opts) {
  if (opts && typeof opts.success === 'function') opts.success({ tapIndex: 0 });
});

wx.navigateTo = mockFn(function (opts) { if (opts && opts.success) opts.success(); });
wx.redirectTo = mockFn(function (opts) { if (opts && opts.success) opts.success(); });
wx.reLaunch = mockFn(function (opts) { if (opts && opts.success) opts.success(); });
wx.navigateBack = mockFn(function (opts) { if (opts && opts.success) opts.success(); });

wx.nextTick = mockFn(function (cb) { if (typeof cb === 'function') cb(); });

/** 覆盖某个 mock 的实现，path 形如 'cloud.callFunction'。 */
wx.__setMock = function (path, impl) {
  const parts = String(path).split('.');
  let node = wx;
  for (let i = 0; i < parts.length - 1; i += 1) node = node[parts[i]];
  node[parts[parts.length - 1]] = mockFn(impl);
  return wx;
};

/** 清空所有 mock 的调用记录（jest.fn 才有）。 */
wx.__reset = function () {
  Object.keys(wx).forEach(function (key) {
    const value = wx[key];
    if (typeof value !== 'function') return;
    if (typeof value.mockClear === 'function') value.mockClear();
  });
  Object.keys(wx.cloud).forEach(function (key) {
    if (typeof wx.cloud[key].mockClear === 'function') wx.cloud[key].mockClear();
  });
  return wx;
};

global.wx = wx;

module.exports = wx;
