// profile-page.test.js —— 我的页（DEV-0001-09 / AC-11、AC-21、AC-23）
// 覆盖：额度展示与 60s 缓存命中/过期、下拉刷新、删除全部与撤回同意的二次确认/取消/成功/失败、
// 本地同意与缓存清理边界、路由跳转，以及无导购/分享入口的静态契约。

'use strict';

var fs = require('fs');
var path = require('path');

var pageConfig = null;
global.Page = function (config) {
  pageConfig = config;
};
require('../../../../miniprogram/pages/profile/profile.js');

var api = require('../../../../miniprogram/services/api');

var PROFILE_DIR = path.join(__dirname, '../../../../miniprogram/pages/profile');
var INDEX_URL = '/pages/index/index';
var CONSENT_URL = '/pages/consent/consent';
var BEIJING_MIDNIGHT = Date.UTC(2026, 10, 9, 16, 0, 0); // 2026-11-10 00:00 +08:00
var CONSENT_RECORD = JSON.stringify({ version: '2026-11-09-v1', agreedAt: Date.UTC(2026, 10, 9, 2, 0, 0), ageConfirmedAt: Date.UTC(2026, 10, 9, 2, 0, 0) });

var storage = {};
var calls = [];
var page = null;

function flush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

async function settle() {
  await flush();
  await flush();
  await flush();
}

function profilePayload(overrides) {
  return Object.assign(
    {
      quota: { used: 0, limit: 1, remaining: 1, vip: false, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT },
      consent: { version: '2026-11-09-v1', agreedAt: Date.UTC(2026, 10, 9, 2, 0, 0), ageConfirmedAt: Date.UTC(2026, 10, 9, 2, 0, 0) },
      activeTaskId: null,
      hasData: false
    },
    overrides || {}
  );
}

function installCloud(handlers) {
  wx.__setMock('cloud.callFunction', function (options) {
    calls.push(options);
    var action = options && options.data ? options.data.action : '';
    var handler = handlers ? handlers[action] : null;
    if (typeof handler === 'function') return handler(options);
    return Promise.resolve(wx.__success(profilePayload()));
  });
}

function chooseModal(confirmed) {
  wx.showModal = jest.fn(function (options) {
    if (options && options.success) options.success({ confirm: !!confirmed, cancel: !confirmed });
  });
}

function createPage() {
  var instance = {
    data: JSON.parse(JSON.stringify(pageConfig.data))
  };
  Object.keys(pageConfig).forEach(function (key) {
    if (typeof pageConfig[key] === 'function' && key !== 'data') instance[key] = pageConfig[key];
  });
  instance.setData = function (patch) {
    Object.keys(patch).forEach(function (key) {
      instance.data[key] = patch[key];
    });
  };
  return instance;
}

function readPageFile(name) {
  return fs.readFileSync(path.join(PROFILE_DIR, name), 'utf8');
}

beforeEach(function () {
  wx.__reset();
  storage = {};
  calls = [];
  wx.__setMock('getStorageSync', function (key) {
    return storage[key] === undefined ? '' : storage[key];
  });
  wx.__setMock('setStorageSync', function (key, value) {
    storage[key] = value;
  });
  wx.__setMock('removeStorageSync', function (key) {
    delete storage[key];
  });
  wx.showToast = jest.fn();
  chooseModal(true);
  wx.reLaunch = jest.fn();
  wx.navigateTo = jest.fn();
  wx.stopPullDownRefresh = jest.fn();
  installCloud(null);
  page = createPage();
  page.onLoad();
});

describe('profile 页：额度展示与缓存（AC-11）', function () {
  test('无缓存时拉取 profile 一次，展示剩余次数/重置时间并写入 60s 缓存', async function () {
    page.onShow();
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('sinn-account');
    expect(calls[0].data.action).toBe('profile');
    expect(page.data.quota.quotaText).toBe('今日剩余 1 / 1 次');
    expect(page.data.quota.resetText).toBe('每日 00:00 重置（北京时间）');
    expect(page.data.consentView.consented).toBe(true);
    expect(page.data.loading).toBe(false);

    var cached = JSON.parse(storage[api.STORAGE_KEYS.QUOTA]);
    expect(cached.remaining).toBe(1);
    expect(cached.limit).toBe(1);
    expect(typeof cached.upto).toBe('number');
  });

  test('60s 内缓存命中：不发云调用，直接展示缓存额度与 VIP 标识', async function () {
    storage[api.STORAGE_KEYS.QUOTA] = JSON.stringify({
      used: 3,
      limit: 10,
      remaining: 7,
      vip: true,
      dayKey: '2026-11-09',
      resetAt: BEIJING_MIDNIGHT,
      upto: Date.now()
    });

    page.onShow();
    await settle();

    expect(calls.length).toBe(0);
    expect(page.data.quota.quotaText).toBe('今日剩余 7 / 10 次');
    expect(page.data.quota.badgeText).toBe('VIP');
    expect(page.data.loading).toBe(false);
  });

  test('缓存超过 60s 后重新拉取并覆盖缓存', async function () {
    storage[api.STORAGE_KEYS.QUOTA] = JSON.stringify({
      used: 3,
      limit: 10,
      remaining: 7,
      vip: true,
      dayKey: '2026-11-09',
      resetAt: BEIJING_MIDNIGHT,
      upto: Date.now() - 61 * 1000
    });

    page.onShow();
    await settle();

    expect(calls.length).toBe(1);
    expect(page.data.quota.quotaText).toBe('今日剩余 1 / 1 次');
    expect(page.data.quota.badgeText).toBe('');
  });

  test('profile 失败且无缓存时展示加载失败文案，不显示假额度', async function () {
    installCloud({
      profile: function () {
        return Promise.reject({ errMsg: 'cloud.callFunction:fail' });
      }
    });

    page.onShow();
    await settle();

    expect(page.data.loading).toBe(false);
    expect(page.data.quota.available).toBe(false);
    expect(page.data.errorText).toContain('额度加载失败');
  });

  test('下拉刷新强制拉取（即使缓存新鲜），并停止下拉动画', async function () {
    storage[api.STORAGE_KEYS.QUOTA] = JSON.stringify({
      used: 0,
      limit: 1,
      remaining: 1,
      vip: false,
      dayKey: '2026-11-09',
      resetAt: BEIJING_MIDNIGHT,
      upto: Date.now()
    });

    page.onPullDownRefresh();
    await settle();

    expect(calls.length).toBe(1);
    expect(wx.stopPullDownRefresh).toHaveBeenCalled();
  });
});

describe('profile 页：删除全部数据（AC-11 / AC-19 / AC-20）', function () {
  test('取消确认：不调用云函数、不清缓存、不跳转', async function () {
    storage[api.STORAGE_KEYS.CONSENT] = CONSENT_RECORD;
    storage[api.STORAGE_KEYS.ACTIVE_TASK] = JSON.stringify({ taskId: 't_1' });
    chooseModal(false);

    page.onDeleteAll();
    await settle();

    expect(calls.length).toBe(0);
    expect(storage[api.STORAGE_KEYS.ACTIVE_TASK]).toBeDefined();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });

  test('确认后调用 deleteAll，清活动任务与额度缓存但保留同意，回首页', async function () {
    storage[api.STORAGE_KEYS.CONSENT] = CONSENT_RECORD;
    storage[api.STORAGE_KEYS.ACTIVE_TASK] = JSON.stringify({ taskId: 't_1' });
    storage[api.STORAGE_KEYS.QUOTA] = JSON.stringify({ used: 1, limit: 1, remaining: 0, upto: Date.now() });
    installCloud({
      deleteAll: function () {
        return Promise.resolve(wx.__success({ deletedTasks: 1, deletedAssets: 2, deletedAt: 123 }));
      }
    });

    page.onDeleteAll();
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0].data.action).toBe('deleteAll');
    expect(storage[api.STORAGE_KEYS.ACTIVE_TASK]).toBeUndefined();
    expect(storage[api.STORAGE_KEYS.QUOTA]).toBeUndefined();
    expect(storage[api.STORAGE_KEYS.CONSENT]).toBeDefined();
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: INDEX_URL });
    expect(wx.showToast).toHaveBeenCalled();
  });

  test('deleteAll 失败：显示错误、保留本地缓存、不跳转', async function () {
    storage[api.STORAGE_KEYS.ACTIVE_TASK] = JSON.stringify({ taskId: 't_1' });
    installCloud({
      deleteAll: function () {
        return Promise.reject({ errMsg: 'cloud.callFunction:fail' });
      }
    });

    page.onDeleteAll();
    await settle();

    expect(storage[api.STORAGE_KEYS.ACTIVE_TASK]).toBeDefined();
    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page.data.errorText).not.toBe('');
    expect(page.data.busy).toBe(false);
  });
});

describe('profile 页：撤回同意（AC-21）', function () {
  test('取消确认：不调用 revokeConsent、保留同意记录', async function () {
    storage[api.STORAGE_KEYS.CONSENT] = CONSENT_RECORD;
    chooseModal(false);

    page.onRevokeConsent();
    await settle();

    expect(calls.length).toBe(0);
    expect(storage[api.STORAGE_KEYS.CONSENT]).toBeDefined();
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });

  test('确认后调用 revokeConsent，清同意与所有本地缓存，回首页重新同意', async function () {
    storage[api.STORAGE_KEYS.CONSENT] = CONSENT_RECORD;
    storage[api.STORAGE_KEYS.ACTIVE_TASK] = JSON.stringify({ taskId: 't_1' });
    storage[api.STORAGE_KEYS.QUOTA] = JSON.stringify({ used: 1, limit: 1, remaining: 0, upto: Date.now() });
    installCloud({
      revokeConsent: function () {
        return Promise.resolve(wx.__success({ deletedTasks: 1, deletedAssets: 2, consentRevokedAt: 456 }));
      }
    });

    page.onRevokeConsent();
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0].data.action).toBe('revokeConsent');
    expect(storage[api.STORAGE_KEYS.CONSENT]).toBeUndefined();
    expect(storage[api.STORAGE_KEYS.ACTIVE_TASK]).toBeUndefined();
    expect(storage[api.STORAGE_KEYS.QUOTA]).toBeUndefined();
    expect(page.data.consentView.consented).toBe(false);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: INDEX_URL });
  });
});

describe('profile 页：路由与静态契约（AC-21 / AC-23）', function () {
  test('未同意时提供「去完成同意」入口，回首页用 reLaunch', function () {
    page.onGoConsent();
    page.onBackHome();

    expect(wx.navigateTo).toHaveBeenCalledWith({ url: CONSENT_URL });
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: INDEX_URL });
  });

  test('四件套齐全且 json 开启下拉刷新、注册 navigation-bar', function () {
    ['profile.js', 'profile.wxml', 'profile.wxss', 'profile.json'].forEach(function (name) {
      expect(fs.existsSync(path.join(PROFILE_DIR, name))).toBe(true);
    });
    var config = JSON.parse(readPageFile('profile.json'));
    expect(config.enablePullDownRefresh).toBe(true);
    expect(config.usingComponents['navigation-bar']).toBe('/components/navigation-bar/navigation-bar');
  });

  test('wxml 展示额度/同意/删除全部/撤回同意，且无导购与分享入口', function () {
    var wxml = readPageFile('profile.wxml');
    expect(wxml).toContain('今日额度');
    expect(wxml).toContain('{{quota.quotaText}}');
    expect(wxml).toContain('{{quota.resetText}}');
    expect(wxml).toContain('{{quota.badgeText}}');
    expect(wxml).toContain('{{deleteAllText}}');
    expect(wxml).toContain('{{revokeText}}');
    expect(wxml).toContain('{{noticeText}}');
    expect(wxml).toContain('返回首页');

    // 只扫描用户可见文案（wxml + js 中的字符串常量），去掉注释里对 AC-23 的说明。
    var script = readPageFile('profile.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    var combined = wxml + script;
    expect(combined).not.toMatch(/分享|保存相册|价格|购买|下单|商家|3D|形象库|保证合身|精准|准确|适合你/);
  });

  test('页面未定义分享回调（AC-23）', function () {
    expect(pageConfig.onShareAppMessage).toBeUndefined();
    expect(pageConfig.onShareTimeline).toBeUndefined();
  });
});
