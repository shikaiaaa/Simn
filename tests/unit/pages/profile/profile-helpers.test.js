// profile-helpers.test.js —— 我的页纯函数与本地缓存（DEV-0001-09 / AC-11、AC-21）
// 覆盖：额度规范化与展示、VIP 标识、重置时间、SPEC §C 额度缓存 60s TTL、
// deleteAll/revokeConsent 的本地缓存清理边界。

'use strict';

var pageConfig = null;
global.Page = function (config) {
  pageConfig = config;
};

var profile = require('../../../../miniprogram/pages/profile/profile.js');
var api = require('../../../../miniprogram/services/api');
var consent = require('../../../../miniprogram/services/consent');

var BEIJING_MIDNIGHT = Date.UTC(2026, 10, 9, 16, 0, 0); // 2026-11-10 00:00 +08:00
var CONSENT_RECORD = { version: '2026-11-09-v1', agreedAt: Date.UTC(2026, 10, 9, 2, 0, 0), ageConfirmedAt: Date.UTC(2026, 10, 9, 2, 0, 0) };

function makeWxStorage() {
  var store = {};
  return {
    store: store,
    getStorageSync: function (key) {
      return store[key] === undefined ? '' : store[key];
    },
    setStorageSync: function (key, value) {
      store[key] = value;
    },
    removeStorageSync: function (key) {
      delete store[key];
    }
  };
}

describe('profile 纯函数：额度展示（AC-11）', function () {
  test('normalizeQuota 规范化合法额度并计算 remaining', function () {
    expect(profile.normalizeQuota({ used: 0, limit: 1, vip: false, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT })).toEqual({
      used: 0,
      limit: 1,
      remaining: 1,
      vip: false,
      dayKey: '2026-11-09',
      resetAt: BEIJING_MIDNIGHT
    });
    expect(profile.normalizeQuota({ used: 2, limit: 10, remaining: 7, vip: true }).remaining).toBe(7);
    expect(profile.normalizeQuota({ used: 5, limit: 3 }).remaining).toBe(0);
  });

  test('normalizeQuota 对缺失/非法额度返回 null（不编造额度）', function () {
    expect(profile.normalizeQuota(null)).toBeNull();
    expect(profile.normalizeQuota({})).toBeNull();
    expect(profile.normalizeQuota({ used: 0 })).toBeNull();
    expect(profile.normalizeQuota({ used: -1, limit: 1 })).toBeNull();
    expect(profile.normalizeQuota({ used: 'x', limit: 'y' })).toBeNull();
  });

  test('普通用户额度展示：剩余次数 + 每日重置 + 无 VIP 标识', function () {
    var view = profile.buildQuotaView({ used: 0, limit: 1, remaining: 1, vip: false, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT });
    expect(view.available).toBe(true);
    expect(view.quotaText).toBe('今日剩余 1 / 1 次');
    expect(view.badgeText).toBe('');
    expect(view.vipText).toBe('普通用户每日 1 次');
    expect(view.resetText).toBe('每日 00:00 重置（北京时间）');
  });

  test('VIP 额度展示：VIP 标识 + 10 次/日', function () {
    var view = profile.buildQuotaView({ used: 3, limit: 10, remaining: 7, vip: true, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT });
    expect(view.quotaText).toBe('今日剩余 7 / 10 次');
    expect(view.badgeText).toBe('VIP');
    expect(view.vipText).toBe('VIP 每日 10 次');
  });

  test('额度缺失时展示加载态而非 0 次', function () {
    var view = profile.buildQuotaView(null);
    expect(view.available).toBe(false);
    expect(view.quotaText).toContain('加载中');
    expect(view.resetText).toBe(profile.RESET_FALLBACK);
  });

  test('formatResetAt 以北京时间解释服务端 resetAt，不依赖运行环境时区', function () {
    expect(profile.formatResetAt(BEIJING_MIDNIGHT)).toBe('每日 00:00 重置（北京时间）');
    expect(profile.formatResetAt(0)).toBe(profile.RESET_FALLBACK);
    expect(profile.formatResetAt(undefined)).toBe(profile.RESET_FALLBACK);
  });
});

describe('profile 纯函数：同意状态展示（AC-21）', function () {
  test('无同意记录显示未同意与引导文案', function () {
    var view = profile.buildConsentView(null);
    expect(view.consented).toBe(false);
    expect(view.consentText).toBe('未同意');
    expect(view.consentDetail).toContain('18+');
  });

  test('有同意记录显示版本与同意日期', function () {
    var view = profile.buildConsentView(CONSENT_RECORD);
    expect(view.consented).toBe(true);
    expect(view.consentText).toBe('已同意');
    expect(view.consentDetail).toContain('2026-11-09-v1');
    expect(view.consentDetail).toContain('2026-11-09');
  });
});

describe('profile 纯函数：额度缓存 60s TTL（SPEC §C）', function () {
  test('createQuotaCache 生成 SPEC §C schema（含 upto）', function () {
    var cache = profile.createQuotaCache({ used: 1, limit: 1, remaining: 0, vip: false, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT }, 1000);
    expect(Object.keys(cache).sort()).toEqual(['dayKey', 'limit', 'remaining', 'resetAt', 'upto', 'used', 'vip']);
    expect(cache.upto).toBe(1000);
    expect(profile.createQuotaCache(null, 1000)).toBeNull();
  });

  test('isQuotaCacheFresh：30s 内新鲜、60s 整过期、时钟回拨不信任', function () {
    var cache = { upto: 100000 };
    expect(profile.isQuotaCacheFresh(cache, 100000 + 30000)).toBe(true);
    expect(profile.isQuotaCacheFresh(cache, 100000 + 59999)).toBe(true);
    expect(profile.isQuotaCacheFresh(cache, 100000 + 60000)).toBe(false);
    expect(profile.isQuotaCacheFresh(cache, 99999)).toBe(false);
    expect(profile.isQuotaCacheFresh(null, 1)).toBe(false);
    expect(profile.isQuotaCacheFresh({}, 1)).toBe(false);
  });

  test('writeQuotaCache / readQuotaCache 往返，且 fresh 按 now 计算', function () {
    var wxStorage = makeWxStorage();
    profile.writeQuotaCache(wxStorage, { used: 2, limit: 10, remaining: 8, vip: true, dayKey: '2026-11-09', resetAt: BEIJING_MIDNIGHT }, 5000);
    var raw = wxStorage.store[profile.QUOTA_CACHE_KEY];
    expect(typeof raw).toBe('string');

    var cached = profile.readQuotaCache(wxStorage, 5000 + 30000);
    expect(cached).not.toBeNull();
    expect(cached.fresh).toBe(true);
    expect(cached.quota.remaining).toBe(8);
    expect(cached.quota.vip).toBe(true);

    expect(profile.readQuotaCache(wxStorage, 5000 + 60000).fresh).toBe(false);
  });

  test('缓存损坏/缺 upto 时按无缓存处理', function () {
    var wxStorage = makeWxStorage();
    wxStorage.store[profile.QUOTA_CACHE_KEY] = '{not json';
    expect(profile.readQuotaCache(wxStorage, 1)).toBeNull();

    wxStorage.store[profile.QUOTA_CACHE_KEY] = JSON.stringify({ used: 0, limit: 1, remaining: 1 });
    expect(profile.readQuotaCache(wxStorage, 1)).toBeNull();
  });
});

describe('profile 纯函数：本地缓存清理边界（AC-21）', function () {
  test('clearUserCaches 清活动任务与额度缓存，但保留同意记录；clearConsent=true 才清同意', function () {
    var wxStorage = makeWxStorage();
    wxStorage.store[api.STORAGE_KEYS.ACTIVE_TASK] = JSON.stringify({ taskId: 't_1' });
    wxStorage.store[api.STORAGE_KEYS.QUOTA] = JSON.stringify({ used: 0, limit: 1, remaining: 1, upto: 1 });
    wxStorage.store[api.STORAGE_KEYS.CONSENT] = JSON.stringify(CONSENT_RECORD);

    var removed = profile.clearUserCaches(wxStorage, { clearConsent: false });
    expect(removed).toEqual([api.STORAGE_KEYS.ACTIVE_TASK, api.STORAGE_KEYS.QUOTA]);
    expect(wxStorage.store[api.STORAGE_KEYS.CONSENT]).toBeDefined();
    expect(consent.readLocalConsent(wxStorage)).not.toBeNull();
  });

  test('撤回同意场景同时清 sinn_consent_v1', function () {
    var wxStorage = makeWxStorage();
    wxStorage.store[api.STORAGE_KEYS.CONSENT] = JSON.stringify(CONSENT_RECORD);
    wxStorage.store[api.STORAGE_KEYS.ACTIVE_TASK] = 'x';
    wxStorage.store[api.STORAGE_KEYS.QUOTA] = 'y';

    var removed = profile.clearUserCaches(wxStorage, { clearConsent: true });
    expect(removed).toContain(api.STORAGE_KEYS.CONSENT);
    expect(consent.readLocalConsent(wxStorage)).toBeNull();
  });
});
