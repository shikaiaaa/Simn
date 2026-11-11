'use strict';
/**
 * tests/e2e/lib/harness.js
 *
 * QA-0001-02 · L3 e2e 公共驱动（miniprogram-automator 0.12.x）。
 *
 * 说明：
 * - 本文件只在 `node tests/e2e/run-e2e.js` 中 require；文件名不命中 jest 的 `*.test.js`，
 *   不会进入 L1 单元测试套件（jest.config.js 由 Lead 维护，QA 不改）。
 * - 页面选择器对齐 DEV-0001 客户端实现（各页面 wxml/class 名）。
 * - 所有断言失败抛 Error；环境/素材缺失抛 CaseBlocked（由 runner 记为「阻塞」而非「失败」）。
 */

const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

class CaseBlocked extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CaseBlocked';
    this.blocked = true;
  }
}

function blocked(reason) {
  throw new CaseBlocked(reason);
}

function assert(condition, message) {
  if (!condition) throw new Error(`[assert] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

/** 固定素材是否存在（路径口径见 docs/qa/TC-0001.md §5 MAT-01..MAT-15）。 */
function requireFixtures(names) {
  const missing = [];
  for (const name of names) {
    const p = fixturePath(name);
    if (!fs.existsSync(p)) missing.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
  if (missing.length) {
    blocked(`缺少固定素材：${missing.join('、')}（TC-0001 §5 素材清单，CP-11 未闭合，素材未提供）`);
  }
  return names.map((n) => fixturePath(n));
}

async function waitFor(fn, timeoutMs, intervalMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs || 200);
  }
  throw new Error(`[timeout] 等待 ${label || 'condition'} 超时（${timeoutMs}ms）${lastError ? `；最后错误：${lastError.message}` : ''}`);
}

function normalizeRoute(routePath) {
  if (!routePath) return '';
  const clean = String(routePath).split('?')[0];
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/**
 * 连接开发者工具自动化端口。
 *
 * 两种模式（见 tests/e2e/README.md）：
 * - connect（默认，SINN_E2E_WS 设置时）：由 shell 先 `cli.bat auto --auto-port 9420`，
 *   本函数用 `automator.connect({ wsEndpoint })` 连接。沙箱禁止管道 spawn，launch() 永久 EPERM。
 * - launch（回退）：未设置 SINN_E2E_WS 时保留旧实现，失败原样抛出（E2E-B1）。
 * 返回 { mp, info }，info.mode = 'connect' | 'launch'。
 */
async function launch({ cliPath, wsEndpoint, timeoutMs = 120000, resultsDir, logDir }) {
  ensureDir(resultsDir);
  ensureDir(logDir);
  const mode = wsEndpoint ? 'connect' : 'launch';
  const logFile = path.join(logDir, `automator-${mode}.log`);
  const started = Date.now();
  let mp;
  try {
    if (mode === 'connect') {
      mp = await automator.connect({ wsEndpoint });
    } else {
      mp = await automator.launch({
        cliPath,
        projectPath: ROOT,
        timeout: timeoutMs,
        trustProject: true,
      });
    }
  } catch (e) {
    try {
      fs.writeFileSync(
        logFile,
        `automator.${mode} failed at ${new Date().toISOString()}\n${mode === 'connect' ? `wsEndpoint=${wsEndpoint}` : `cliPath=${cliPath}`}\n${e && (e.stack || e.message || e)}\n`,
        'utf8'
      );
    } catch (ignore) {
      /* ignore */
    }
    const err = new Error(`automator.${mode} 失败：${e && (e.message || e)}`);
    err.launchLogFile = path.relative(ROOT, logFile).replace(/\\/g, '/');
    throw err;
  }

  const logs = [];
  const attach = (event) => {
    try {
      mp.on(event, (payload) => logs.push({ at: new Date().toISOString(), event, payload }));
    } catch (e) {
      /* ignore */
    }
  };
  ['console', 'exception'].forEach(attach);

  const info = {
    mode,
    launchedAt: new Date().toISOString(),
    launchMs: Date.now() - started,
    wsEndpoint: mode === 'connect' ? wsEndpoint : null,
    systemInfo: null,
    logs,
  };
  try {
    info.systemInfo = await mp.systemInfo();
  } catch (e) {
    /* ignore */
  }
  return { mp, info };
}

async function close(mp, info) {
  if (!mp) return;
  // connect 模式：断开 ws 即可；调用 close() 会关闭 IDE 自动化窗口（下次需重起 cli.bat auto）。
  if (info && info.mode === 'connect' && typeof mp.disconnect === 'function') {
    try {
      mp.disconnect();
      return;
    } catch (e) {
      /* fall through to close */
    }
  }
  try {
    await mp.close();
  } catch (e) {
    /* ignore */
  }
}

async function currentPage(mp) {
  const page = await mp.currentPage();
  if (!page) throw new Error('[assert] 当前没有页面');
  return page;
}

/** 等待当前页路由命中 expected（如 `/pages/capture/capture`）。 */
async function waitRoute(mp, expected, timeoutMs = 20000) {
  const target = normalizeRoute(expected);
  return waitFor(
    async () => {
      const page = await mp.currentPage();
      if (!page) return null;
      return normalizeRoute(page.path) === target ? page : null;
    },
    timeoutMs,
    250,
    `路由 ${target}`
  );
}

async function pageStackPaths(mp) {
  const stack = await mp.pageStack();
  return stack.map((p) => normalizeRoute(p.path));
}

async function inputAt(page, selector, index, value) {
  const elements = await page.$$(selector);
  if (!elements || !elements[index]) throw new Error(`[assert] 未找到 ${selector}[${index}]`);
  await elements[index].input(String(value));
}

async function tap(page, selector, options) {
  const element = await page.$(selector);
  if (!element) throw new Error(`[assert] 未找到元素 ${selector}`);
  await element.tap();
  if (options && options.waitMs) await sleep(options.waitMs);
  return element;
}

async function text(page, selector) {
  const element = await page.$(selector);
  return element ? element.text() : null;
}

async function screenshot(mp, dir, name) {
  ensureDir(dir);
  const file = path.join(dir, `${name}.png`);
  try {
    await mp.screenshot({ path: file });
    return path.relative(ROOT, file).replace(/\\/g, '/');
  } catch (e) {
    return null;
  }
}

async function evaluate(mp, fn, ...args) {
  return mp.evaluate(fn, ...args);
}

/** 调云函数并统一成 {ok,result} / {ok:false,error}，便于断言业务码。 */
async function cloudCall(mp, name, data) {
  return evaluate(
    mp,
    function (name, data) {
      return new Promise((resolve) => {
        if (!wx.cloud || !wx.cloud.callFunction) {
          resolve({ ok: false, error: 'wx.cloud.callFunction 不可用（云开发未初始化/未勾选）' });
          return;
        }
        wx.cloud.callFunction({
          name,
          data,
          success: (res) => resolve({ ok: true, result: res.result }),
          fail: (err) => resolve({ ok: false, error: (err && (err.errMsg || err.message)) || 'callFunction fail' }),
        });
      });
    },
    name,
    data
  );
}

async function getStorage(mp, key) {
  // 小程序侧绝大多数缓存写入的是 JSON 字符串（sinn_consent_v1 / sinn_active_task_v1 /
  // sinn_quota_cache_v1），这里统一解析，避免调用方再判断类型。
  const raw = await mp.callWxMethod('getStorageSync', key);
  if (typeof raw === 'string' && raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }
  return raw;
}

async function setStorage(mp, key, value) {
  return mp.callWxMethod('setStorageSync', key, value);
}

async function removeStorage(mp, key) {
  return mp.callWxMethod('removeStorageSync', key);
}

/** mock wx.chooseMedia 返回本地固定素材（素材路径不得打进小程序包：tests/fixtures 在 miniprogramRoot 外）。 */
async function mockChooseMedia(mp, files) {
  const tempFiles = files.map((file) => ({
    tempFilePath: file,
    size: fs.existsSync(file) ? fs.statSync(file).size : 0,
    fileType: 'image',
    tempFileType: 'image',
  }));
  await mp.mockWxMethod('chooseMedia', { tempFiles, type: 'image' });
}

/**
 * 将磁盘上的图片写入小程序 USER_DATA_PATH 后再 mock chooseMedia。
 * 真实开发者工具里 wx.getImageInfo/uploadFile 只接受小程序可访问路径（wxfile://），
 * 直接传宿主绝对路径会失败，故由 Node 读文件→base64→小程序侧 writeFile。
 */
async function mockChooseMediaFromDisk(mp, files) {
  const payload = files.map((file) => {
    if (!fs.existsSync(file)) throw new Error(`素材文件不存在：${file}`);
    return {
      name: path.basename(file),
      size: fs.statSync(file).size,
      base64: fs.readFileSync(file).toString('base64'),
    };
  });
  const saved = await evaluate(
    mp,
    function (items) {
      var fsm = wx.getFileSystemManager();
      var dir = wx.env.USER_DATA_PATH;
      var out = [];
      for (var i = 0; i < items.length; i += 1) {
        var p = dir + '/e2e-' + Date.now() + '-' + i + '-' + items[i].name;
        fsm.writeFileSync(p, items[i].base64, 'base64');
        out.push({ tempFilePath: p, size: items[i].size, fileType: 'image', tempFileType: 'image' });
      }
      return out;
    },
    payload
  );
  await mp.mockWxMethod('chooseMedia', { tempFiles: saved, type: 'image' });
  return saved;
}

async function restoreChooseMedia(mp) {
  try {
    await mp.restoreWxMethod('chooseMedia');
  } catch (e) {
    /* ignore */
  }
}

/**
 * 在 app 上下文给 wx[method] 装调用计数（用于 AC-21 拒绝后 chooseMedia=0 等断言）。
 * mockWxMethod 无法计数，因此用 evaluate 包一层。
 */
async function installCallCounter(mp, method) {
  return evaluate(
    mp,
    function (method) {
      const app = getApp();
      app.globalData = app.globalData || {};
      app.globalData.__e2eCalls = app.globalData.__e2eCalls || {};
      app.globalData.__e2eCalls[method] = 0;
      const original = wx[method];
      if (typeof original !== 'function') return { installed: false, reason: 'wx.' + method + ' 不存在' };
      // 同一个开发者工具 app 实例会跨多次 connect 运行存活；若已包装过则只重置计数，
      // 避免多层包装把一次调用计成多次。
      if (original.__e2eWrapped) return { installed: true, reused: true };
      const wrapped = function () {
        app.globalData.__e2eCalls[method] += 1;
        return original.apply(wx, arguments);
      };
      wrapped.__e2eWrapped = true;
      wx[method] = wrapped;
      return { installed: true };
    },
    method
  );
}

async function callCount(mp, method) {
  return evaluate(
    mp,
    function (method) {
      const app = getApp();
      return (app.globalData && app.globalData.__e2eCalls && app.globalData.__e2eCalls[method]) || 0;
    },
    method
  );
}

/**
 * 包装 wx.cloud.callFunction，记录每次云函数调用的 name/action/requestId/耗时/是否成功。
 * 用途（task-71）：真实供应商回归时留存 createTask 的 requestId 供成本/链路追溯。
 * 注意：同一 app 实例跨 connect 复用。若检测到旧包装（含 __e2eOriginal）会先恢复原函数再重装，
 * 避免多层包装；Promise 风格调用必须继续返回 Promise（services/api.js 依赖返回值 .then），
 * 回调风格保持原 success/fail 并记录，不改变调用行为。
 */
async function installCloudCallLogger(mp) {
  return evaluate(
    mp,
    function () {
      const app = getApp();
      app.globalData = app.globalData || {};
      app.globalData.__e2eCloudCalls = [];
      if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
        return { installed: false, reason: 'wx.cloud.callFunction 不可用' };
      }
      // 兼容重装：旧包装若保存了原函数则恢复，再重新包装（用于修正历史包装缺陷）。
      const current = wx.cloud.callFunction;
      if (current.__e2eCloudWrapped && typeof current.__e2eOriginal === 'function') {
        wx.cloud.callFunction = current.__e2eOriginal;
      }
      const original = wx.cloud.callFunction;
      if (original.__e2eCloudWrapped) return { installed: true, reused: true };
      const wrapped = function (options) {
        if (!options || typeof options !== 'object') return original.apply(wx.cloud, arguments);
        const name = options.name || null;
        const action = options.data && options.data.action ? options.data.action : null;
        const startedAt = Date.now();
        const record = function (ok, payload) {
          app.globalData.__e2eCloudCalls.push({
            name: name,
            action: action,
            ok: ok,
            requestId: (payload && payload.requestId) || null,
            error: ok ? null : (payload && (payload.errMsg || payload.message)) || null,
            durationMs: Date.now() - startedAt,
            at: Date.now(),
          });
        };
        // 回调风格：保留原 success/fail 并记录。
        if (typeof options.success === 'function' || typeof options.fail === 'function') {
          const success = options.success;
          const fail = options.fail;
          const next = Object.assign({}, options);
          next.success = function (res) {
            try {
              record(true, (res && res.result) || null);
            } catch (e) {
              /* 记录失败不影响原回调 */
            }
            if (typeof success === 'function') success(res);
          };
          next.fail = function (err) {
            try {
              record(false, err || null);
            } catch (e) {
              /* ignore */
            }
            if (typeof fail === 'function') fail(err);
          };
          return original.call(wx.cloud, next);
        }
        // Promise 风格：必须继续返回 Promise（services/api.js 依赖 .then）。
        const p = original.call(wx.cloud, options);
        if (p && typeof p.then === 'function') {
          return p.then(
            function (res) {
              try {
                record(true, (res && res.result) || null);
              } catch (e) {
                /* ignore */
              }
              return res;
            },
            function (err) {
              try {
                record(false, err || null);
              } catch (e) {
                /* ignore */
              }
              throw err;
            }
          );
        }
        return p;
      };
      wrapped.__e2eCloudWrapped = true;
      wrapped.__e2eOriginal = original;
      wx.cloud.callFunction = wrapped;
      return { installed: true };
    },
    null
  );
}

/** 读取 installCloudCallLogger 记录的调用日志（副本）。 */
async function cloudCallLog(mp) {
  return evaluate(
    mp,
    function () {
      const app = getApp();
      return (app.globalData && app.globalData.__e2eCloudCalls ? app.globalData.__e2eCloudCalls : []).slice();
    },
    null
  );
}

/** wx.getPrivacySetting（CP-05 是否配置隐私指引的真实探针）。 */
async function privacySetting(mp) {
  return evaluate(
    mp,
    function () {
      return new Promise((resolve) => {
        if (typeof wx.getPrivacySetting !== 'function') {
          resolve({ available: false, error: 'wx.getPrivacySetting 不可用（基础库过低）' });
          return;
        }
        wx.getPrivacySetting({
          success: (res) => resolve({ available: true, ...res }),
          fail: (err) => resolve({ available: true, error: (err && err.errMsg) || 'getPrivacySetting fail' }),
        });
      });
    },
    null
  );
}

/* ------------------------------------------------------------------ *
 * 业务流程助手（选择器对齐各页面 wxml）
 * ------------------------------------------------------------------ */

/**
 * 在小程序运行环境内调用 wx.reLaunch（而非 automator 的 mp.reLaunch）。
 *
 * 实测本机开发者工具在 connect 模式下 `mp.reLaunch` 偶发 10s 协议超时
 * （"timeout waiting for automator response"），但小程序内 wx.reLaunch 稳定；
 * 这里用 evaluate 走小程序 API，只等待导航 success，不再依赖 automator 的页面就绪握手。
 */
async function appReLaunch(mp, url) {
  const res = await evaluate(
    mp,
    function (target) {
      return new Promise(function (resolve) {
        wx.reLaunch({
          url: target,
          success: function () { resolve({ ok: true }); },
          fail: function (err) { resolve({ ok: false, error: (err && (err.errMsg || err.message)) || 'reLaunch fail' }); },
        });
      });
    },
    url
  );
  if (!res || res.ok !== true) throw new Error(`[nav] wx.reLaunch ${url} 失败：${res && res.error}`);
  await sleep(1200);
  return res;
}

async function goIndex(mp) {
  await appReLaunch(mp, '/pages/index/index');
  return currentPage(mp);
}

/** 在已经打开的同意页上完成两步（step1 勾选 18+ 与条款 → step2 单独同意）。 */
async function completeConsentOnPage(mp, page) {
  const rows = await page.$$('.check-row');
  assert(rows && rows.length >= 2, '同意页第一步应有 2 个勾选项');
  await rows[0].tap(); // 18+
  await rows[1].tap(); // 条款
  await tap(page, '.btn-primary');
  await sleep(300);
  const step2Rows = await page.$$('.check-row');
  assert(step2Rows && step2Rows.length >= 1, '同意页第二步应有隐私单独同意勾选项');
  await step2Rows[0].tap();
  await tap(page, '.btn-primary');
  // 同意提交包含隐私授权 + recordConsent + redirectTo；真实开发者工具下可能秒级到十秒级，
  // 这里给 30s，避免把环境慢误判为业务失败。
  await waitRoute(mp, '/pages/capture/capture', 30000);
  return currentPage(mp);
}

/** 完成同意页两步（18+ + 条款 → 8 项披露 + 单独同意），结束后应到 capture。 */
async function completeConsent(mp) {
  let page = await goIndex(mp);
  const start = await page.$('.btn-primary');
  assert(start, '首页缺少「开始试穿」按钮');
  await start.tap();
  page = await waitRoute(mp, '/pages/consent/consent');
  return completeConsentOnPage(mp, page);
}

/**
 * 从首页进入 capture：若本地/服务端已同意则 index 直接进 capture，
 * 否则走 consent 两步。用于需要在同一账号上重复跑多轮的 L3 用例。
 */
async function enterCapture(mp) {
  const indexPage = await goIndex(mp);
  await sleep(400);
  const start = await indexPage.$('.btn-primary');
  assert(start, '首页缺少「开始试穿」按钮');
  await start.tap();
  const capture = await waitFor(
    async () => {
      const page = await mp.currentPage();
      if (!page) return null;
      const route = normalizeRoute(page.path);
      if (route === '/pages/capture/capture') return { page, route };
      if (route === '/pages/consent/consent') return { page, route };
      return null;
    },
    8000,
    250,
    '首页 → consent/capture'
  );
  if (capture.route === '/pages/consent/consent') {
    return completeConsentOnPage(mp, capture.page);
  }
  return capture.page;
}

async function fillMetrics(page, metrics) {
  const fieldOrder = ['heightCm', 'weightKg', 'chestCm', 'waistCm', 'hipCm'];
  for (let i = 0; i < fieldOrder.length; i += 1) {
    const key = fieldOrder[i];
    if (metrics[key] === undefined || metrics[key] === null) continue;
    await inputAt(page, '.field-input', i, metrics[key]);
    await sleep(80);
  }
  if (metrics.gender) {
    const chips = await page.$$('.chip');
    assert(chips && chips.length >= 3, '性别选择 chip 不足 3 个');
    const labels = { male: '男', female: '女', unspecified: '不填' };
    const target = labels[metrics.gender] || metrics.gender;
    for (const chip of chips) {
      const t = await chip.text();
      if (t && t.indexOf(target) >= 0) {
        await chip.tap();
        break;
      }
    }
    await sleep(120);
  }
}

/** 添加人像照片（依赖 mock 后的 chooseMedia；调用方需先 requireFixtures + mockChooseMedia）。 */
async function addPersonPhotos(page, count) {
  for (let i = 0; i < count; i += 1) {
    const add = await page.$('.photo-add');
    assert(add, '人像添加按钮不存在（照片已达上限？）');
    await add.tap();
    await sleep(1500); // 等待 L0 + 上传 + 服务端预检（真实环境）
  }
}

async function addGarmentPhoto(page) {
  const add = await page.$('.garment-add');
  assert(add, '衣服添加按钮不存在');
  await add.tap();
  await sleep(1500);
}

async function tapStart(page) {
  const button = await page.$('.btn-primary');
  assert(button, '缺少主操作按钮');
  await button.tap();
}

/** 等待结果页并返回 {page, onloadMs}；startMs 由调用方在点击「开始生成」时记录。 */
async function waitResult(mp, startMs, timeoutMs = 90000) {
  const page = await waitRoute(mp, '/pages/result/result', timeoutMs);
  return { page, elapsedMs: Date.now() - startMs };
}

module.exports = {
  ROOT,
  FIXTURES_DIR,
  CaseBlocked,
  blocked,
  assert,
  sleep,
  ensureDir,
  fixturePath,
  requireFixtures,
  waitFor,
  normalizeRoute,
  launch,
  close,
  currentPage,
  waitRoute,
  pageStackPaths,
  inputAt,
  tap,
  text,
  screenshot,
  evaluate,
  cloudCall,
  getStorage,
  setStorage,
  removeStorage,
  mockChooseMedia,
  mockChooseMediaFromDisk,
  restoreChooseMedia,
  installCallCounter,
  callCount,
  installCloudCallLogger,
  cloudCallLog,
  privacySetting,
  goIndex,
  appReLaunch,
  completeConsent,
  completeConsentOnPage,
  enterCapture,
  fillMetrics,
  addPersonPhotos,
  addGarmentPhoto,
  tapStart,
  waitResult,
};
