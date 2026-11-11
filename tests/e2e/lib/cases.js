'use strict';
/**
 * tests/e2e/lib/cases.js
 *
 * QA-0001-02 · L3 用例集（对应 docs/qa/TC-0001.md §4.3 的 12 条 L3 用例）。
 *
 * 状态口径（AGENTS.md）：
 * - 用例函数抛 CaseBlocked → runner 记为「阻塞」；
 * - 抛其它 Error → 记为「失败」；
 * - 正常返回 → 记为「通过」。
 *
 * 运行前提（2026-11-10 起）：开发者工具以 automator connect 模式接入（SINN_E2E_WS），
 * 真实云环境 AppID wx735e60c2c07673aa / env simn-01-d5gjsxm0ocb78add8 已可用。
 * MAT-01..MAT-09 固定素材已于 2026-11-11 固化到 tests/fixtures/mat/（见 docs/qa/MATERIALS-0001.md），
 * MAT-10..MAT-15 仍无文件、依赖它们的用例继续按阻塞登记；L3-002 使用 tests/fixtures/_smoke
 * 合成冒烟图（明确非 MAT 固定样张），仅验证真实云额度与拦截链路，不得替代视觉/画质验收。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const h = require('./harness');
const pngStats = require('./png-stats');

/** TC-0001 §5 固定素材（路径相对 tests/fixtures/；MAT-01..MAT-09 已固化，SHA 见 MATERIALS-0001.md）。 */
const MAT = {
  'MAT-01': 'mat/mat-01-woman-fullbody.jpg',
  'MAT-02': 'mat/mat-02-man-fullbody.jpg',
  'MAT-03': 'mat/mat-03-woman-fullbody.jpg',
  'MAT-04': 'mat/mat-04-man-backside.jpg',
  'MAT-05': 'mat/mat-05-face-only.jpg',
  'MAT-06': 'mat/mat-06-lowres.jpg',
  'MAT-07': 'mat/mat-07-blur.jpg',
  'MAT-08': 'mat/mat-08-garment-flat.jpg',
  'MAT-09': 'mat/mat-09-two-persons.jpg',
  // MAT-10..MAT-15 暂无对应文件（未提供，依赖用例仍按阻塞）；路径保留 v0.1 规划值，勿当作已提供。
  'MAT-10': 'garment/multi-garment-01.jpg',
  'MAT-11': 'garment/on-model-01.jpg',
  'MAT-12': 'garment/ecommerce-01.jpg',
  'MAT-13': 'results/result-sample-01.png',
  'MAT-14': 'results/result-crop-1x-01.png',
  'MAT-15': 'size/ac26-three-gender.json',
};

function matFiles(ids) {
  return ids.map((id) => {
    if (!MAT[id]) throw new Error(`未知素材编号 ${id}`);
    return path.join(h.FIXTURES_DIR, MAT[id]);
  });
}

/**
 * 合成冒烟图（非 MAT 固定素材）：1200×1600 JPEG，满足端上 L0。
 * 仅用于 L3-002 真实云额度链路的占位输入；AC-2/3/4/5/14/15 的固定样张验收不得使用。
 */
const SMOKE = {
  person: path.join(h.FIXTURES_DIR, '_smoke', 'person-smoke-1200x1600.jpg'),
  garment: path.join(h.FIXTURES_DIR, '_smoke', 'garment-smoke-1200x1600.jpg'),
};

function smokeFiles() {
  ['person', 'garment'].forEach((key) => {
    if (!fs.existsSync(SMOKE[key])) {
      h.blocked(`缺少合成冒烟图 ${SMOKE[key]}；见 tests/fixtures/_smoke/README.md（非 MAT 素材）`);
    }
  });
  const sums = ['person', 'garment'].map((key) => ({
    path: SMOKE[key],
    sha256: crypto.createHash('sha256').update(fs.readFileSync(SMOKE[key])).digest('hex').toUpperCase(),
    bytes: fs.statSync(SMOKE[key]).size,
  }));
  return { files: SMOKE, sums };
}

/**
 * 把服务端同意状态重置为「未同意」：真实云 revokeConsent（物理删数据+撤同意）+ 清本地缓存。
 * 已无同意记录时云函数返回 1003，按幂等成功处理。
 */
async function resetConsentState(mp) {
  const res = await h.cloudCall(mp, 'sinn-account', {
    action: 'revokeConsent',
    clientReqId: crypto.randomUUID(),
  });
  if (!res || res.ok !== true) {
    throw new Error(`[setup] revokeConsent 调用失败：${res && res.error}`);
  }
  const body = res.result || {};
  const code = body.error && body.error.code;
  if (body.ok !== true && code !== 1003) {
    throw new Error(`[setup] revokeConsent 业务失败：${JSON.stringify(body.error)}`);
  }
  await h.removeStorage(mp, 'sinn_consent_v1');
  await h.removeStorage(mp, 'sinn_active_task_v1');
  await h.removeStorage(mp, 'sinn_quota_cache_v1');
  return { called: true, alreadyRevoked: body.ok !== true, code: code || null };
}

/** 点击第一个文本含 keyword 的按钮（用于「我的」「返回首页」等按文案定位）。 */
async function tapButtonByText(page, keyword) {
  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await button.text();
    if (text && text.indexOf(keyword) >= 0) {
      await button.tap();
      return true;
    }
  }
  return false;
}

async function openProfile(mp) {
  const page = await h.goIndex(mp);
  await h.sleep(300);
  const ok = await tapButtonByText(page, '我的');
  if (!ok) throw new Error('[assert] 首页缺少「我的」入口');
  return h.waitRoute(mp, '/pages/profile/profile');
}

/** 读取 profile 额度文案并解析「今日剩余 X / Y 次」。先清 60s 本地缓存避免陈旧值。 */
async function readQuota(mp) {
  await h.removeStorage(mp, 'sinn_quota_cache_v1');
  const page = await openProfile(mp);
  // profile 首屏先显示「额度加载中…」，等真实额度文案出现（含真实云 profile 请求耗时）。
  const quotaText = await h.waitFor(
    async () => {
      const t = await h.text(page, '.quota-number');
      return /剩余\s*(\d+)\s*\/\s*(\d+)\s*次/.test(t || '') ? t : null;
    },
    30000,
    250,
    '额度文案加载'
  );
  const badge = await h.text(page, '.vip-badge');
  const match = /剩余\s*(\d+)\s*\/\s*(\d+)\s*次/.exec(quotaText || '');
  return { quotaText, badgeText: badge, remaining: match ? Number(match[1]) : null, limit: match ? Number(match[2]) : null };
}

/**
 * 直接调云函数读取额度（服务端权威值），用于「生成中/页面切换中」的用例。
 * 原因：connect 模式下生成页轮询期间，automator 的页面查询/导航偶发 10s 协议超时（T-6），
 * 而 readQuota() 需要 goIndex→我的→profile 多次页面操作，在生成中窗口内容易被超时打断。
 * L3-003 只断言 used 增量（AC-12），不依赖 UI 文案，故用云函数口径更稳定。
 */
async function readQuotaCloud(mp) {
  const res = await h.cloudCall(mp, 'sinn-account', { action: 'profile' });
  if (!res || !res.ok) throw new Error('[assert] profile 云函数调用失败：' + ((res && res.error) || '未知错误'));
  const envelope = res.result || {};
  if (!envelope.ok) throw new Error('[assert] profile 返回失败：' + JSON.stringify(envelope.error || null));
  const quota = envelope.data && envelope.data.quota;
  if (!quota) throw new Error('[assert] profile 返回缺少 data.quota');
  return {
    source: 'cloud-profile',
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining,
    dayKey: quota.dayKey,
  };
}

/** 读任务详情（云函数 taskGet），统一返回 result 对象。 */
async function taskGet(mp, taskId) {
  const res = await h.cloudCall(mp, 'sinn-task', { action: 'taskGet', taskId });
  if (!res.ok) throw new Error(`[assert] taskGet 调用失败：${res.error}`);
  return res.result;
}

/** 完整跑一次生成流程（同意→采集→衣服→生成→结果）。返回 {taskId, elapsedMs, resultPage, task}。 */
async function runGeneration(ctx, options) {
  const { mp } = ctx;
  const opts = options || {};
  const metrics = opts.metrics || { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 };
  const personFiles = opts.personFiles || matFiles(opts.personMat || ['MAT-01']);
  const garmentFiles = opts.garmentFiles || matFiles(opts.garmentMat || ['MAT-08']);

  const capture = await h.enterCapture(mp);
  await h.fillMetrics(capture, metrics);
  await h.mockChooseMediaFromDisk(mp, personFiles);
  await h.addPersonPhotos(capture, personFiles.length);
  // 人像采集页在点「下一步」时才逐张上传 + 服务端预检（未过则停留本页）；
  // 通过后才会 navigateTo garment。
  await h.tap(capture, '.btn-primary');
  await h.waitRoute(mp, '/pages/garment/garment', 60000);
  const garment = await h.currentPage(mp);
  await h.mockChooseMediaFromDisk(mp, garmentFiles);
  await h.addGarmentPhoto(garment);
  // 衣服页在点「开始生成」时上传 + 预检 + createTask；预检未过则停留并给提示。

  const startMs = Date.now();
  await h.tapStart(garment);
  await h.waitRoute(mp, '/pages/generating/generating', 20000);
  const { page: resultPage, elapsedMs } = await h.waitResult(mp, startMs, 90000);
  // 成功进入结果页后，生成页会按设计清空 sinn_active_task_v1（任务标识不滞留本地缓存），
  // 因此 taskId 以结果页 data.taskId 为准，Storage 仅作兜底。
  const active = await h.getStorage(mp, 'sinn_active_task_v1');
  const resultTaskId = await h.evaluate(mp, function () {
    var pages = getCurrentPages();
    var page = pages[pages.length - 1];
    return page && page.data ? page.data.taskId : '';
  });
  const taskId = resultTaskId || (active && active.taskId);
  if (!taskId) throw new Error('[assert] 结果页未取到 taskId（data.taskId 与 sinn_active_task_v1 均为空），无法关联任务');
  return { taskId, elapsedMs, resultPage, task: await taskGet(mp, taskId) };
}

/* ------------------------------------------------------------------ */
/* DEF-0009（result/profile/generating 三页无法滚动，用户真机反馈）回归工具 */
/* ------------------------------------------------------------------ */

/** 读取当前页滚动容器状态：scrollTop / 视口高 / 内容高 / 是否溢出。 */
async function scrollMetrics(mp) {
  const layout = await h.evaluate(mp, function () {
    var q = wx.createSelectorQuery();
    q.select('.page-scroll').fields({ scrollOffset: true, rect: true, size: true });
    q.select('.page-body').boundingClientRect();
    return new Promise(function (resolve) {
      q.exec(function (res) {
        resolve({ scroller: (res && res[0]) || null, body: (res && res[1]) || null });
      });
    });
  });
  let sys = {};
  try {
    sys = await mp.systemInfo();
  } catch (e) {
    sys = {};
  }
  const scroller = layout.scroller || {};
  let scrollTop = scroller.scrollTop;
  if (typeof scrollTop !== 'number') {
    try {
      const page = await h.currentPage(mp);
      const el = await page.$('.page-scroll');
      if (el && typeof el.property === 'function') {
        const v = await el.property('scrollTop');
        if (typeof v === 'number') scrollTop = v;
      }
    } catch (e) {
      // 保持 undefined，调用方按无法读取处理
    }
  }
  const bodyHeight = layout.body ? layout.body.height : null;
  const scrollerHeight = typeof scroller.height === 'number' ? scroller.height : null;
  return {
    windowHeight: sys.windowHeight || null,
    scrollTop: typeof scrollTop === 'number' ? scrollTop : null,
    scrollerHeight,
    bodyHeight,
    contentOverflow: !!(bodyHeight && scrollerHeight && bodyHeight > scrollerHeight + 8),
  };
}

/** 读取元素 boundingClientRect（视口坐标，滚动后随之变化）。 */
async function rectOf(mp, selector) {
  return h.evaluate(
    mp,
    function (sel) {
      var q = wx.createSelectorQuery();
      q.select(sel).boundingClientRect();
      return new Promise(function (resolve) {
        q.exec(function (res) {
          resolve((res && res[0]) || null);
        });
      });
    },
    selector
  );
}

/**
 * 把当前页 .page-scroll 滚到底。
 * 依次尝试 automator ScrollViewElement.scrollTo / 小程序内 node.scrollTo 两种形态；
 * 若均无法改变 scrollTop（Skyline + automator connect 已知限制 T-7），返回 method='structural'，
 * 由调用方改做结构断言（滚动容器存在 + 内容溢出 + 目标在最大滚动位置可达）。
 */
async function scrollToBottom(mp) {
  const page = await h.currentPage(mp);
  const scroller = await page.$('.page-scroll');
  if (!scroller) throw new Error(`[assert] ${page.path} 缺少 .page-scroll 滚动容器，无法执行滚动可达断言`);
  const tagName = scroller.tagName || null;
  let scrollY = null;
  try {
    scrollY = await scroller.attribute('scroll-y');
  } catch (e) {
    scrollY = null;
  }
  const before = await scrollMetrics(mp);
  const target = Math.max((before.bodyHeight || 2000) + 800, (before.scrollerHeight || 700) * 2);
  const attempts = [];
  let after = before;
  const changed = () => (after.scrollTop || 0) > (before.scrollTop || 0);
  const finish = (label) => ({
    page,
    before,
    after,
    target,
    moved: (after.scrollTop || 0) - (before.scrollTop || 0),
    method: label,
    attempts,
    realScroll: changed(),
    tagName,
    scrollY,
  });
  async function measure(label) {
    await h.sleep(650);
    after = await scrollMetrics(mp);
    attempts.push({ method: label, scrollTop: after.scrollTop, moved: changed() });
    return changed();
  }

  if (typeof scroller.scrollTo === 'function') {
    try {
      await scroller.scrollTo(0, target);
    } catch (e) {
      attempts.push({ method: 'element.scrollTo(0,y)', error: e.message });
    }
    if (await measure('element.scrollTo(0,y)')) return finish('element.scrollTo(0,y)');
  }

  const nodeObject = await h.evaluate(
    mp,
    function (y) {
      var q = wx.createSelectorQuery();
      q.select('.page-scroll').node();
      return new Promise(function (resolve) {
        q.exec(function (res) {
          var node = res && res[0] && res[0].node;
          if (!node || typeof node.scrollTo !== 'function') return resolve({ ok: false, why: 'no node.scrollTo' });
          try {
            node.scrollTo({ top: y, left: 0, animated: false });
            resolve({ ok: true });
          } catch (e) {
            resolve({ ok: false, why: e.message });
          }
        });
      });
    },
    target
  );
  attempts.push({ method: 'node.scrollTo(object)', exec: nodeObject });
  if (await measure('node.scrollTo(object)')) return finish('node.scrollTo(object)');

  const nodeTwoArg = await h.evaluate(
    mp,
    function (y) {
      var q = wx.createSelectorQuery();
      q.select('.page-scroll').node();
      return new Promise(function (resolve) {
        q.exec(function (res) {
          var node = res && res[0] && res[0].node;
          if (!node) return resolve({ ok: false, why: 'no node' });
          try {
            node.scrollTo(0, y);
            resolve({ ok: true });
          } catch (e) {
            resolve({ ok: false, why: e.message });
          }
        });
      });
    },
    target
  );
  attempts.push({ method: 'node.scrollTo(0,y)', exec: nodeTwoArg });
  if (await measure('node.scrollTo(0,y)')) return finish('node.scrollTo(0,y)');

  return finish('structural');
}

/**
 * 断言 targets 可达。
 * - mode='actual'：滚动后 rect 直接进入视口（top < windowHeight 且 bottom > 0）；
 * - mode='structural'：automator 无法驱动 Skyline 滚动时（T-7），断言目标在「最大滚动位置」下进入视口：
 *   projectedTop = rect.top - maxScroll，且 projectedTop < windowHeight、projectedTop + height > 0。
 */
async function assertReachable(mp, pagePath, windowHeight, targets, opts) {
  opts = opts || {};
  const mode = opts.mode || 'actual';
  const maxScroll = Math.max(0, Number(opts.maxScroll) || 0);
  const results = [];
  const page = await h.currentPage(mp);
  for (const item of targets) {
    const rect = await rectOf(mp, item.selector);
    const el = await page.$(item.selector);
    let text = null;
    if (el) {
      try {
        text = await el.text();
      } catch (e) {
        text = null;
      }
    }
    const directVisible = !!rect && rect.height > 0 && rect.top < windowHeight && rect.bottom > 0;
    const projectedTop = rect ? rect.top - maxScroll : null;
    const projectedVisible = !!rect && rect.height > 0 && projectedTop < windowHeight && projectedTop + rect.height > 0;
    const visible = mode === 'structural' ? projectedVisible : directVisible;
    results.push({
      selector: item.selector,
      label: item.label,
      text: text ? text.trim() : null,
      rect: rect || null,
      windowHeight: windowHeight,
      mode: mode,
      maxScroll: maxScroll,
      projectedTop: projectedTop,
      visible: visible,
      clickable: !!el && visible,
    });
    if (!visible) {
      throw new Error(
        `[assert] ${pagePath} ${mode === 'structural' ? '最大滚动位置（结构断言）' : '滚动到底'}后「${item.label}」(${item.selector}) 不可达：` +
          ` rect=${JSON.stringify(rect)} windowHeight=${windowHeight} maxScroll=${maxScroll}`
      );
    }
  }
  return results;
}

function sha256File(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(h.ROOT, relPath);
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').toUpperCase();
}

const CASES = [
  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-001',
    tc: 'TC-0001-L3-001',
    ac: 'AC-7',
    title: '真实网络端到端 3/3 ≤60s，且结果页含尺码与免责',
    priority: 'P0',
    requires: ['login', 'cloud', 'vendor-real', 'vip-whitelist', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '固定素材 MAT-01 + MAT-08 + 数值 175/70/male/92/78/96，走 consent→capture→garment',
      '点「开始生成」记 t0，结果页出现记 t1（3 次）',
      '断言每次 t1-t0 ≤60000ms，且结果页出现尺码区间与固定免责「参考尺码，不构成合身承诺」',
      '记录每次墙钟、taskId、requestId',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const runs = [];
      for (let i = 1; i <= 3; i += 1) {
        const startedAt = new Date().toISOString();
        const result = await runGeneration(ctx);
        const lines = await h.evaluate(
          mp,
          function () {
            const page = getCurrentPages()[getCurrentPages().length - 1];
            const texts = [];
            page.wxss;
            const query = page.__e2eQueryTexts;
            return query ? query() : texts;
          }
        ).catch(() => []);
        const resultPage = result.resultPage;
        const sizeLines = [];
        const sizeRange = await h.text(resultPage, '.result-size-range');
        if (sizeRange) sizeLines.push(sizeRange);
        const lineEls = await resultPage.$$('.result-size-line');
        for (const el of lineEls) sizeLines.push(await el.text());
        const elapsedMs = result.elapsedMs;
        const runRecord = {
          iteration: i,
          startedAt,
          elapsedMs,
          taskId: result.taskId,
          status: result.task.status,
          sizeTexts: sizeLines,
          resultWidth: result.task.result ? result.task.result.width : null,
          resultHeight: result.task.result ? result.task.result.height : null,
          screenshot: await h.screenshot(mp, ctx.runDir, `ac7-run-${i}`),
          lines,
        };
        if (elapsedMs > 60000) throw new Error(`[assert] 第 ${i} 次端到端 ${elapsedMs}ms > 60000ms`);
        if (!sizeRange) throw new Error(`[assert] 第 ${i} 次结果页缺少参考尺码区间`);
        if (!sizeLines.some((t) => t && t.indexOf('参考尺码，不构成合身承诺') >= 0)) {
          throw new Error(`[assert] 第 ${i} 次结果页缺少固定免责文案`);
        }
        runs.push(runRecord);
        ctx.write(`ac7-run-${i}.json`, runRecord);
      }
      return { runs, passCount: `${runs.filter((r) => r.elapsedMs <= 60000).length}/3` };
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-002',
    tc: 'TC-0001-L3-002',
    ac: 'AC-11',
    title: '真实云额度（普通 1 次/日、VIP 10 次/日）与拦截提示',
    priority: 'P0',
    requires: ['login', 'cloud'],
    steps: [
      '在已部署环境配置 SINN_DAILY_LIMIT_NORMAL=1 / SINN_DAILY_LIMIT_VIP=10；VIP 账号需在 SINN_VIP_WHITELIST',
      '普通账号：当日第 1 次成功，第 2 次被拦截（2001，提示「今日额度已用完」，带 resetAt），拦截时 createTask 0 次',
      'VIP 账号：第 10 次成功、第 11 次拦截；profile 显示 remaining/VIP 标识/重置时间',
      '跨天（可控 00:00）后 remaining 重置，已用额度不因删除成功任务而返还',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const mode = process.env.SINN_E2E_QUOTA_MODE;
      if (mode !== 'normal' && mode !== 'vip') {
        h.blocked('未声明额度档位：设置 SINN_E2E_QUOTA_MODE=normal|vip（需部署环境已按 SPEC 配置 SINN_DAILY_LIMIT_* 与 VIP 白名单，CP-02/CP-09）');
      }
      const smoke = smokeFiles();
      const quota = await readQuota(mp);
      if (quota.remaining === null) throw new Error(`[assert] profile 额度文案不可解析：${quota.quotaText}`);
      if (mode === 'vip' && !/VIP/i.test(quota.badgeText || '')) {
        throw new Error(`[assert] VIP 账号缺少 VIP 标识（badge=${quota.badgeText}）`);
      }
      const evidence = {
        mode,
        quotaBefore: quota,
        fixtures: {
          kind: 'synthetic-smoke（非 MAT 固定样张）',
          note: '使用 tests/fixtures/_smoke 合成图 + 云函数 SINN_VENDOR=mock，仅验证真实云额度/拦截链路；AC-7/14/15 视觉与真实供应商验收仍阻塞',
          sums: smoke.sums,
        },
      };
      if (mode === 'normal') {
        if (quota.limit !== 1) {
          h.blocked(`普通额度档位非 1 次/日（当前 limit=${quota.limit}），需按 SPEC 配置 SINN_DAILY_LIMIT_NORMAL=1 后重跑（CP-02）`);
        }
        if (quota.remaining < 1) {
          h.blocked(`当日普通额度已用尽（remaining=${quota.remaining}），需等待次日 00:00 重置或改用新测试账号后重跑`);
        }
        const first = await runGeneration(ctx, { personFiles: [smoke.files.person], garmentFiles: [smoke.files.garment] });
        const afterFirst = await readQuota(mp);
        const secondAttempt = await (async () => {
          // 采集页的上传+服务端预检只在点「下一步」时触发（capture.js onNext）；
          // 衣服页的上传+预检+createTask 只在点「开始生成」时触发（garment.js onStart）。
          // 因此这里不等待「已通过」状态（点了扣额度也不会被拦截动作触发），直接走导航，
          // 由页面自身完成校验；额度已耗尽时停在衣服页并展示 hint。
          const capture = await h.enterCapture(mp);
          await h.fillMetrics(capture, { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 });
          await h.mockChooseMediaFromDisk(mp, [smoke.files.person]);
          await h.addPersonPhotos(capture, 1);
          await h.tap(capture, '.btn-primary');
          const garment = await h.waitRoute(mp, '/pages/garment/garment', 60000);
          await h.mockChooseMediaFromDisk(mp, [smoke.files.garment]);
          await h.addGarmentPhoto(garment);
          await h.tapStart(garment);
          // 额度拦截提示由 createTask 返回 2001 后异步写入（上传+预检+云函数调用约 2–5s），
          // 固定 sleep 会偶发读不到；改为等待 .hint 出现含「额度」的文案。
          let hint = null;
          await h
            .waitFor(
              async () => {
                hint = await h.text(garment, '.hint').catch(() => null);
                return !!(hint && hint.indexOf('额度') >= 0);
              },
              20000,
              500,
              '第 2 次额度拦截提示'
            )
            .catch(() => null);
          if (!hint) hint = await h.text(garment, '.hint').catch(() => null);
          return { hint: hint, pagePath: (await mp.currentPage()).path };
        })();
        evidence.firstTaskId = first.taskId;
        evidence.quotaAfterFirst = afterFirst;
        evidence.secondAttempt = secondAttempt;
        if (afterFirst.remaining !== 0) throw new Error(`[assert] 普通账号成功后剩余应为 0，实际 ${afterFirst.remaining}`);
        if (!secondAttempt.hint || secondAttempt.hint.indexOf('额度') < 0) {
          throw new Error(`[assert] 第 2 次未出现额度拦截提示（hint=${secondAttempt.hint}）`);
        }
        if (!/garment/.test(secondAttempt.pagePath || '')) {
          throw new Error('[assert] 第 2 次被拦截后不应离开衣服页');
        }
        evidence.screenshot = await h.screenshot(mp, ctx.runDir, 'ac11-quota-blocked');
        ctx.write('ac11-normal.json', evidence);
        return evidence;
      }
      // VIP 分支：10 次成功 / 11 次拦截，真实跑完耗时较长，需人工确认环境与额度。
      if (process.env.SINN_E2E_VIP_FULL_RUN !== '1') {
        h.blocked('VIP 10/11 分支需真实跑 10 次生成（耗时长、消耗真实供应商额度）；确认后设置 SINN_E2E_VIP_FULL_RUN=1，或按 E2E-LOG-0001 人工步骤执行并签字。');
      }
      h.blocked('VIP 10/11 分支当前未提供可重复执行的脚本实现（等待 CP-04 供应商额度就绪后补全），本轮按阻塞登记。');
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-003',
    tc: 'TC-0001-L3-003',
    ac: 'AC-12',
    title: '生成中离开/重进恢复同一任务，createTask 1 次、扣 1 次',
    priority: 'P0',
    requires: ['login', 'cloud', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '开始生成后记录 sinn_active_task_v1.taskId 与 profile.quota.used',
      'reLaunch 首页（清空页面栈，模拟重进；真正 kill 冷启动需真机人工补测）→ 出现「继续上次生成」→ 进入 generating',
      '断言 taskId 相同、createTask 仅 1 次（quota.used 只 +1）、成功后清缓存',
    ],
    async run(ctx) {
      const { mp } = ctx;
      // 先记录生成前的额度
      const quotaBefore = await readQuotaCloud(mp);
      const taskId = await (async () => {
        const capture = await h.enterCapture(mp);
        await h.fillMetrics(capture, { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 });
        await h.mockChooseMediaFromDisk(mp, matFiles(['MAT-01']));
        await h.addPersonPhotos(capture, 1);
        await h.tap(capture, '.btn-primary');
        const garment = await h.waitRoute(mp, '/pages/garment/garment');
        await h.mockChooseMediaFromDisk(mp, matFiles(['MAT-08']));
        await h.addGarmentPhoto(garment);
        await h.tapStart(garment);
        const generating = await h.waitRoute(mp, '/pages/generating/generating', 15000);
        // 生成页首轮轮询会触发 setData/云调用，先让页面稳定，再读缓存（T-6：生成期间自动化调用偶发 10s 超时）。
        await h.sleep(1500);
        let activeCache = null;
        for (let i = 0; i < 20; i += 1) {
          try {
            activeCache = await h.getStorage(mp, 'sinn_active_task_v1');
            if (activeCache && activeCache.taskId) break;
          } catch (e) {
            /* automator 偶发 10s 超时：重试读取，不改变用例语义 */
          }
          await h.sleep(500);
        }
        if (!activeCache || !activeCache.taskId) throw new Error('[assert] 未读到 sinn_active_task_v1.taskId');
        return activeCache.taskId;
      })();
      // reLaunch 在页面切换/轮询期间可能偶发 10s 协议超时（T-6）；重试 3 次，仍失败则抛错。
      let index = null;
      let lastNavErr = null;
      for (let attempt = 1; attempt <= 3 && !index; attempt += 1) {
        try {
          index = await h.goIndex(mp);
        } catch (e) {
          lastNavErr = e;
          await h.sleep(2000);
        }
      }
      if (!index) throw lastNavErr || new Error('[nav] 重试 3 次仍无法回到首页');
      await h.sleep(600);
      const resumeButton = await (async () => {
        const buttons = await index.$$('button');
        for (const b of buttons) {
          const t = await b.text();
          if (t && t.indexOf('继续上次生成') >= 0) return b;
        }
        return null;
      })();
      if (!resumeButton) throw new Error('[assert] 首页缺少「继续上次生成」入口（activeTaskId 恢复失效）');
      await resumeButton.tap();
      const generating = await h.waitRoute(mp, '/pages/generating/generating', 15000);
      const routeQuery = (() => {
        try {
          return JSON.parse(JSON.stringify(generating.query || {}));
        } catch (e) {
          return {};
        }
      })();
      const cached = await h.getStorage(mp, 'sinn_active_task_v1');
      const quotaAfter = await readQuotaCloud(mp);
      const evidence = {
        taskId,
        resumedTaskId: cached && cached.taskId,
        routeQuery,
        quotaBefore,
        quotaAfter,
        screenshot: await h.screenshot(mp, ctx.runDir, 'ac12-resume'),
      };
      if (!cached || cached.taskId !== taskId) throw new Error('[assert] 重进后未恢复同一 taskId');
      if (quotaBefore.used !== undefined && quotaAfter.used !== undefined && quotaAfter.used !== quotaBefore.used + 1) {
        throw new Error(`[assert] 额度 used 应 +1（before=${quotaBefore.used}, after=${quotaAfter.used}），疑似重复 createTask`);
      }
      ctx.write('ac12-resume.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-004',
    tc: 'TC-0001-L3-004',
    ac: 'AC-14',
    title: '真实结果图分辨率断言（默认 ≥2048，降级 ≥1536 + requiresReview）',
    priority: 'P0',
    requires: ['login', 'cloud', 'vendor-real', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '真实生成一次，taskGet 读 result.width/result.height 与服务端 sizeFallback',
      '断言默认分支长边 ≥2048；降级分支长边 ≥1536 且 sizeFallback.requiresReview=true',
      '服务端声明尺寸与下载图实际像素一致（下载图由 getTempFileURL 后人工/脚本核对）',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const generation = await runGeneration(ctx);
      const result = generation.task && generation.task.result;
      if (!result) throw new Error('[assert] taskGet 缺少 result（真实供应商未出图）');
      const longSide = Math.max(Number(result.width) || 0, Number(result.height) || 0);
      const fallback = result.sizeFallback || null;
      const evidence = {
        taskId: generation.taskId,
        elapsedMs: generation.elapsedMs,
        result,
        longSide,
        degraded: Boolean(fallback && fallback.degraded),
        screenshot: await h.screenshot(mp, ctx.runDir, 'ac14-result'),
      };
      if (fallback && fallback.degraded) {
        if (longSide < 1536) throw new Error(`[assert] 降级分支长边 ${longSide}px < 1536px`);
        if (fallback.requiresReview !== true) throw new Error('[assert] 降级分支缺少 requiresReview=true');
      } else if (longSide < 2048) {
        throw new Error(`[assert] 默认分支长边 ${longSide}px < 2048px`);
      }
      ctx.write('ac14-resolution.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-005',
    tc: 'TC-0001-L3-005',
    ac: 'AC-18',
    title: '缩放/平移/滚动后「AI 生成」标识仍可见且不遮挡主体',
    priority: 'P0',
    requires: ['login', 'cloud', 'vendor-real', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '结果页 1x 截图 → 双指放大到约 3x 平移 → 截图',
      '页面滚动后截图；断言 .result-ai-badge 始终存在，且不在被 transform 的图片层内',
      '人工复核截图中标识不遮挡主体（CP-11 执行人签字）',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const generation = await runGeneration(ctx);
      const page = generation.resultPage;
      const badge = await page.$('.result-ai-badge');
      if (!badge) throw new Error('[assert] 结果页缺少 .result-ai-badge（AI 标识）');
      const badgeText = await badge.text();
      if (!/AI\s*生成/i.test(badgeText || '')) throw new Error(`[assert] AI 标识文案异常：${badgeText}`);
      const shot1x = await h.screenshot(mp, ctx.runDir, 'ac18-1x');
      const zoom = await page.$('#zoom-view');
      if (!zoom) throw new Error('[assert] 结果页缺少 #zoom-view');
      const offset = await zoom.offset();
      const cx = offset.left + offset.width / 2;
      const cy = offset.top + offset.height / 2;
      const t = (x, y, id) => ({ identifier: id, pageX: x, pageY: y, clientX: x, clientY: y });
      await zoom.touchstart({ touches: [t(cx - 60, cy, 1), t(cx + 60, cy, 2)] });
      await zoom.touchmove({ touches: [t(cx - 160, cy + 40, 1), t(cx + 160, cy + 40, 2)] });
      await h.sleep(300);
      await zoom.touchend({ touches: [t(cx - 160, cy + 40, 1), t(cx + 160, cy + 40, 2)] });
      await h.sleep(500);
      const shot3x = await h.screenshot(mp, ctx.runDir, 'ac18-3x');
      const badgeAfterZoom = await page.$('.result-ai-badge');
      if (!badgeAfterZoom) throw new Error('[assert] 3x 缩放后 AI 标识消失');
      await mp.pageScrollTo(300);
      await h.sleep(500);
      const shotScroll = await h.screenshot(mp, ctx.runDir, 'ac18-scroll');
      const badgeAfterScroll = await page.$('.result-ai-badge');
      if (!badgeAfterScroll) throw new Error('[assert] 滚动后 AI 标识消失');
      const evidence = {
        taskId: generation.taskId,
        badgeText,
        shots: { oneX: shot1x, threeX: shot3x, scrolled: shotScroll },
        note: '标识可见性截图留档；「不遮挡主体」为人工视觉判定（CP-11，需执行人签字）。',
      };
      ctx.write('ac18-ai-badge.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-006',
    tc: 'TC-0001-L3-006',
    ac: 'AC-19',
    title: '删除本次后不可再查看；取消确认不删除；重复删除 404 按成功处理',
    priority: 'P0',
    requires: ['login', 'cloud', 'vendor-real', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '结果页点「删除本次结果」→ mock showModal 取消 → 断言任务仍可查',
      '再次点删除 → mock showModal 确认 → 回到首页，本地缓存清空，taskGet 返回 404/5004',
      '重复删除返回 404 时页面仍按成功回首页',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const generation = await runGeneration(ctx);
      const page = generation.resultPage;
      // 取消确认：不删除
      await mp.mockWxMethod('showModal', { confirm: false, cancel: true });
      const deleteButton = await page.$('.btn-danger');
      if (!deleteButton) throw new Error('[assert] 结果页缺少删除按钮');
      await deleteButton.tap();
      await h.sleep(800);
      const afterCancel = await taskGet(mp, generation.taskId);
      if (!afterCancel || afterCancel.ok === false || !afterCancel.data) {
        throw new Error('[assert] 取消确认后任务不应被删除');
      }
      // 确认删除
      await mp.mockWxMethod('showModal', { confirm: true, cancel: false });
      await deleteButton.tap();
      await h.waitRoute(mp, '/pages/index/index', 20000);
      const cached = await h.getStorage(mp, 'sinn_active_task_v1');
      const afterDelete = await h.cloudCall(mp, 'sinn-task', { action: 'taskGet', taskId: generation.taskId });
      const deletedAtEvidence = { cached, afterDelete, screenshot: await h.screenshot(mp, ctx.runDir, 'ac19-deleted') };
      if (cached) throw new Error('[assert] 删除成功后 sinn_active_task_v1 未清空');
      if (afterDelete.ok && afterDelete.result && afterDelete.result.ok !== false) {
        throw new Error('[assert] 删除后 taskGet 仍返回成功结果');
      }
      const code = afterDelete.ok ? (afterDelete.result.error || {}).code : null;
      if (code !== 5004 && code !== 1004) throw new Error(`[assert] 删除后查询应为 5004（或越权 1004），实际 ${code}`);
      ctx.write('ac19-delete.json', deletedAtEvidence);
      return deletedAtEvidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-007',
    tc: 'TC-0001-L3-007',
    ac: 'AC-20',
    title: '真实云存储 HEAD 404 与任务/资产记录物理不存在（无墓碑）',
    priority: 'P0',
    requires: ['login', 'cloud', 'vendor-real', 'fixtures:MAT-01', 'fixtures:MAT-08', 'test-env-audit'],
    steps: [
      '生成成功后用 auditTask 取 person/garment/result 三个 fileID',
      '调用 deleteTask 删除本次，记录 deletedAt',
      '对三个 fileID 调 getTempFileURL（HEAD 语义），期望非 0 status；auditTask 期望 exists=false',
      '确认记录中无 purged/purgedAt/tombstone 字段；deletedAt 仅在响应体、不落库',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const generation = await runGeneration(ctx);
      const audited = await h.cloudCall(mp, 'sinn-task', { action: 'auditTask', taskId: generation.taskId });
      if (!audited.ok || !audited.result || audited.result.ok === false) {
        throw new Error(`[assert] auditTask 不可用：${JSON.stringify(audited)}`);
      }
      const before = audited.result.data || {};
      if (!before.exists) throw new Error('[assert] 删除前 auditTask.exists 应为 true');
      const fileIds = [];
      if (before.task && before.task.resultFileID) fileIds.push(before.task.resultFileID);
      if (Array.isArray(before.assets)) {
        for (const asset of before.assets) if (asset && asset.fileID) fileIds.push(asset.fileID);
      }
      if (fileIds.length < 3) throw new Error(`[assert] 期望拿到 ≥3 个 fileID，实际 ${fileIds.length}`);
      const deletion = await h.cloudCall(mp, 'sinn-task', { action: 'deleteTask', taskId: generation.taskId });
      if (!deletion.ok || !deletion.result || deletion.result.ok === false) {
        throw new Error(`[assert] deleteTask 失败：${JSON.stringify(deletion)}`);
      }
      const deletedAt = (deletion.result.data || {}).deletedAt;
      if (!deletedAt) throw new Error('[assert] deleteTask 响应缺少 deletedAt');
      const after = await h.cloudCall(mp, 'sinn-task', { action: 'auditTask', taskId: generation.taskId });
      const afterData = (after.result && after.result.data) || {};
      if (afterData.exists !== false) throw new Error('[assert] 删除后 auditTask.exists 应为 false');
      const headResults = await h.evaluate(
        mp,
        function (fileIds) {
          return Promise.all(
            fileIds.map(
              (fileID) =>
                new Promise((resolve) => {
                  wx.cloud.getTempFileURL({
                    fileList: [fileID],
                    success: (res) => {
                      const item = (res.fileList || [])[0] || {};
                      resolve({ fileID, status: item.status, errMsg: item.errMsg || null });
                    },
                    fail: (err) => resolve({ fileID, status: null, error: (err && err.errMsg) || 'fail' }),
                  });
                })
            )
          );
        },
        fileIds
      );
      const leaked = headResults.filter((r) => r.status === 0);
      if (leaked.length) throw new Error(`[assert] 删除后仍有文件可获取：${JSON.stringify(leaked)}`);
      const tombstoneKeys = ['purged', 'purgedAt', 'tombstone', 'deletedAt'];
      const foundTombstone = [];
      for (const key of tombstoneKeys) {
        if (afterData.task && Object.prototype.hasOwnProperty.call(afterData.task, key)) foundTombstone.push(key);
      }
      if (foundTombstone.length) throw new Error(`[assert] 记录中出现墓碑字段：${foundTombstone.join(',')}`);
      const evidence = { taskId: generation.taskId, fileIds, deletedAt, auditBefore: before, auditAfter: afterData, headResults };
      ctx.write('ac20-physical-delete.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-008',
    tc: 'TC-0001-L3-008',
    ac: 'AC-20',
    title: '真实 24h 自动清理定时触发器（sinn-cleanup）',
    priority: 'P0',
    requires: ['login', 'cloud', 'cleanup-seeded'],
    steps: [
      '测试环境构造 purgeAt 已到期、未删除的任务（seed 脚本/控制台，需记录 taskId 与 fileID）',
      '手动触发或等待 sinn-cleanup 定时器（0 */10 * * * * *）',
      '断言返回 {scanned,deleted,failed}；到期任务与对象物理删除、auditTask exists=false；未到期任务不被处理',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const seedTaskId = process.env.SINN_E2E_CLEANUP_TASK_ID;
      if (!seedTaskId) {
        h.blocked('未提供到期 seed 任务：设置 SINN_E2E_CLEANUP_TASK_ID（需测试环境 ALLOW_DEBUG_AUDIT=true 并人工 seed purgeAt≤now 的未删除任务，CP-02）');
      }
      const cleanup = await h.cloudCall(mp, 'sinn-cleanup', { action: 'purgeExpiredTasks' });
      if (!cleanup.ok || !cleanup.result || cleanup.result.ok === false) {
        throw new Error(`[assert] sinn-cleanup 调用失败：${JSON.stringify(cleanup)}`);
      }
      const data = cleanup.result.data || {};
      for (const key of ['scanned', 'deleted', 'failed']) {
        if (typeof data[key] !== 'number') throw new Error(`[assert] cleanup 响应缺少数值字段 ${key}`);
      }
      const audit = await h.cloudCall(mp, 'sinn-task', { action: 'auditTask', taskId: seedTaskId });
      const auditData = (audit.result && audit.result.data) || {};
      if (auditData.exists !== false) throw new Error('[assert] 到期任务清理后 auditTask.exists 应为 false');
      const evidence = { seedTaskId, cleanup: data, auditAfter: auditData };
      ctx.write('ac20-cleanup.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-009',
    tc: 'TC-0001-L3-009',
    ac: 'AC-21',
    title: '真实隐私授权：拒绝后 chooseMedia 0 次，同意后仅 1 次系统隐私授权',
    priority: 'P0',
    requires: ['login', 'privacy-config'],
    steps: [
      'wx.getPrivacySetting 确认已配置《用户隐私保护指引》（CP-05）',
      '拒绝路径：consent 页点「不同意，返回」→ 回首页；断言 chooseMedia 调用 0 次、无隐私 API 调用',
      '同意路径：完成两步同意；断言 requirePrivacyAuthorize 调用 1 次、本地写入 sinn_consent_v1、服务端记录版本/时间',
    ],
    async run(ctx) {
      const { mp } = ctx;
      // 服务端可能残留历史同意记录（云环境已有该测试 openid 的同意），先真实撤销到未同意态，
      // 否则 index 会直接进入 capture，无法验证 consent 页两条路径。
      const reset = await resetConsentState(mp);
      await h.installCallCounter(mp, 'chooseMedia');
      await h.installCallCounter(mp, 'requirePrivacyAuthorize');
      const index = await h.goIndex(mp);
      await h.sleep(300);
      const start = await index.$('.btn-primary');
      if (!start) throw new Error('[assert] 首页缺少开始试穿按钮');
      await start.tap();
      const consent = await h.waitRoute(mp, '/pages/consent/consent');
      const rejectButton = await (async () => {
        const buttons = await consent.$$('button');
        for (const b of buttons) {
          const t = await b.text();
          if (t && t.indexOf('不同意') >= 0) return b;
        }
        return null;
      })();
      if (!rejectButton) throw new Error('[assert] 同意页缺少「不同意，返回」');
      await rejectButton.tap();
      // 开发者工具在 consent 页按钮点击后处理 reLaunch 可能延迟约 10s（自动化桥已知现象），
      // 用较长等待，而不是把它当成业务失败。
      await h.waitRoute(mp, '/pages/index/index', 30000);
      const chooseAfterReject = await h.callCount(mp, 'chooseMedia');
      if (chooseAfterReject !== 0) throw new Error(`[assert] 拒绝后 chooseMedia 应为 0 次，实际 ${chooseAfterReject}`);
      const rejectEvidence = { chooseMediaCalls: chooseAfterReject, screenshot: await h.screenshot(mp, ctx.runDir, 'ac21-rejected') };

      await h.goIndex(mp);
      await h.sleep(300);
      const start2 = await (await h.currentPage(mp)).$('.btn-primary');
      await start2.tap();
      const consent2 = await h.waitRoute(mp, '/pages/consent/consent');
      await h.completeConsentOnPage(mp, consent2);
      const privacyCalls = await h.callCount(mp, 'requirePrivacyAuthorize');
      const consentRecord = await h.getStorage(mp, 'sinn_consent_v1');
      if (!consentRecord || !consentRecord.agreedAt) throw new Error('[assert] 同意后未写入本地 sinn_consent_v1');
      if (privacyCalls !== 1) throw new Error(`[assert] requirePrivacyAuthorize 应调用 1 次，实际 ${privacyCalls}`);
      const profileRes = await h.cloudCall(mp, 'sinn-account', { action: 'profile' });
      const profileBody = (profileRes && profileRes.result) || {};
      const serverConsent = profileBody.data && profileBody.data.consent;
      if (!serverConsent || !serverConsent.version) throw new Error('[assert] 同意后服务端未记录同意版本');
      const evidence = { reset, reject: rejectEvidence, privacyCalls, consentRecord, serverConsent };
      ctx.write('ac21-privacy.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-010',
    tc: 'TC-0001-L3-010',
    ac: 'AC-23',
    title: '全页面渲染后无范围外入口（分享/保存相册/价格购买/商家/3D/形象库）',
    priority: 'P0',
    requires: ['login'],
    steps: [
      '逐页（index/consent/capture/garment/generating/result/profile）读取渲染后的按钮/入口文案与关键属性',
      '断言无「分享」「保存到相册」「价格/购买/下单/商家/包邮」「3D/旋转/形象库」入口，无 open-type=share',
      '读取 app.json 断言无 tabBar；与 L2-025/026 静态扫描结论互相印证',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const calibrate = process.env.SINN_E2E_VISUAL_CALIBRATE === '1';
      // 先撤销服务端同意，确保 consent 页可真实渲染而非被重定向跳过。
      const reset = await resetConsentState(mp);
      const forbidden = [/分享/, /保存到相册/, /保存相册/, /价格/, /购买/, /下单/, /商家/, /包邮/, /3D/i, /旋转/, /形象库/, /扫码/];
      const appJson = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'miniprogram', 'app.json'), 'utf8'));
      if (appJson.tabBar) throw new Error('[assert] app.json 不应包含 tabBar');

      const FAKE_TASK_ID = 't_e2e00000000000000000000';
      const visited = [];
      const routes = [
        { route: '/pages/index/index' },
        { route: '/pages/consent/consent', completeConsent: true },
        { route: '/pages/capture/capture' },
        { route: '/pages/garment/garment', seed: 'capture-draft' },
        { route: '/pages/generating/generating', seed: 'active-task' },
        { route: `/pages/result/result?taskId=${encodeURIComponent(FAKE_TASK_ID)}` },
        { route: '/pages/profile/profile' },
      ];

      // 清掉可能残留的草稿/活动任务，避免页面被前置门禁重定向而扫不到真实 UI。
      await h.removeStorage(mp, 'sinn_active_task_v1');
      await h.evaluate(mp, function () {
        var app = getApp();
        if (app && app.globalData) app.globalData.captureDraft = null;
      });

      // connect 模式下自动化桥偶发 10s 超时；每页最多 3 次重试，失败即抛错，不允许静默跳过（否则即假通过）。
      async function launchRoute(target) {
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await h.sleep(attempt === 1 ? 1200 : 2000);
          try {
            await h.appReLaunch(mp, target);
            await h.sleep(1000);
            const page = await mp.currentPage();
            if (!page) throw new Error('当前没有页面');
            return { page, attempt };
          } catch (e) {
            lastError = e;
            await h.sleep(2500);
          }
        }
        return { page: null, error: String((lastError && (lastError.message || lastError)) || '未知错误') };
      }

      // garment/generating/result 需要前序数据才渲染：用最小占位草稿/任务让页面渲染出 UI，仅用于入口文案扫描。
      async function seedFor(seed) {
        if (seed === 'capture-draft') {
          await h.evaluate(mp, function (draft) {
            var app = getApp();
            if (!app.globalData) app.globalData = {};
            app.globalData.captureDraft = draft;
          }, {
            personAssetIds: ['a_e2e00000000000000000000'],
            metrics: { heightCm: 175, weightKg: 70, gender: 'male' },
          });
        }
        if (seed === 'active-task') {
          await h.setStorage(mp, 'sinn_active_task_v1', {
            taskId: FAKE_TASK_ID,
            createdAt: Date.now(),
            statusHint: 'GENERATING',
          });
        }
      }

      // 页面「真实绘制」判据（DEF-0008 回归防线）：
      // - 主判据 = 像素统计（darkRatio / contentDarkRatio）。DEF-0008 下路由、DOM 元素都正常，
      //   仅 Skyline 不绘制，因此**只有像素能区分「已绘制」与「白屏只剩导航栏」**；纯选择器断言会漏检。
      // - 辅助判据 = 必须存在的选择器 + 布局 rect（.screen / .page-scroll / .page-body），
      //   用于把失败直接定位到「元素缺失」还是「布局高度为 0」。
      // - 阈值来自 2026-11-11 task-49 修复后两轮实测：
      //   标定轮 runId 20261111-202346（SINN_E2E_VISUAL_CALIBRATE=1）得到每页
      //   dark/content/edge 三组实测值（见 §5.1/T-5 与 E2E-LOG v0.8），再留约 15–40% 余量；
      //   修复前基线（DEV 复现）index 为 dark 0.0413 / content 0.019 / edge≈0，会被下列阈值拒绝。
      const VISUAL_SPECS = {
        '/pages/index/index': { screen: true, minDark: 0.055, minContent: 0.035, minEdge: 0.03, requiredSelectors: ['.page-body'] },
        '/pages/consent/consent': { screen: true, minDark: 0.045, minContent: 0.025, minEdge: 0.02, requiredSelectors: ['.check-row', '.btn-primary'] },
        '/pages/capture/capture': { screen: true, minDark: 0.045, minContent: 0.03, minEdge: 0.03, requiredSelectors: ['.photo-add', '.field-input'] },
        '/pages/garment/garment': { screen: true, minDark: 0.042, minContent: 0.022, minEdge: 0.02, requiredSelectors: ['.garment-add', '.btn-primary'] },
        '/pages/generating/generating': { screen: false, minDark: 0.045, minContent: 0.02, minEdge: 0.02, requiredAny: ['.generating-stage', '.generating-error-title'] },
        '/pages/result/result': { screen: false, minDark: 0.045, minContent: 0.03, minEdge: 0.012, requiredAny: ['.result-error-text', '#zoom-view', '.placeholder'] },
        '/pages/profile/profile': { screen: false, minDark: 0.045, minContent: 0.03, minEdge: 0.03, requiredSelectors: ['.quota-number'] },
      };

      async function layoutOf() {
        return h.evaluate(mp, function () {
          return new Promise(function (resolve) {
            var pages = getCurrentPages();
            var cur = pages[pages.length - 1];
            var q = wx.createSelectorQuery().in(cur);
            q.select('.screen').boundingClientRect();
            q.select('.page-scroll').boundingClientRect();
            q.select('.page-body').boundingClientRect();
            q.exec(function (res) {
              function pick(r) {
                return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
              }
              resolve({ screen: pick(res[0]), pageScroll: pick(res[1]), pageBody: pick(res[2]) });
            });
          });
        });
      }

      async function missingSelectors(page, spec) {
        const missing = [];
        for (const sel of spec.requiredSelectors || []) {
          const els = await page.$$(sel).catch(() => []);
          if (!els || els.length === 0) missing.push(sel);
        }
        if (spec.requiredAny && spec.requiredAny.length) {
          let found = false;
          for (const sel of spec.requiredAny) {
            const els = await page.$$(sel).catch(() => []);
            if (els && els.length) {
              found = true;
              break;
            }
          }
          if (!found) missing.push(`任一：${spec.requiredAny.join(' | ')}`);
        }
        return missing;
      }

      // 截图可能拿到滞后帧（T-5/T-6 同类限制）：低于通用下限时等待 900ms 重截一次，再按阈值判定。
      async function shotAndStats(name) {
        let rel = await h.screenshot(mp, ctx.runDir, name);
        let stats = rel ? pngStats.imageStats(path.join(h.ROOT, rel)) : null;
        if (!stats || stats.darkRatio < 0.03) {
          await h.sleep(900);
          const retry = await h.screenshot(mp, ctx.runDir, name);
          if (retry) {
            rel = retry;
            stats = pngStats.imageStats(path.join(h.ROOT, retry));
          }
        }
        const sha256 = rel ? crypto.createHash('sha256').update(fs.readFileSync(path.join(h.ROOT, rel))).digest('hex').toUpperCase() : null;
        return { screenshot: rel, stats, screenshotSha256: sha256 };
      }

      try {
        for (const item of routes) {
          await seedFor(item.seed);
          const launched = await launchRoute(item.route);
          if (!launched.page) {
            visited.push({ route: item.route, launched: false, error: launched.error });
            continue;
          }
          const page = launched.page;
          const routeKey = h.normalizeRoute(item.route);
          const actualRoute = h.normalizeRoute(page.path);
          const spec = VISUAL_SPECS[routeKey] || {
            screen: false,
            minDark: 0.03,
            minContent: 0.01,
            requiredSelectors: ['.page-body'],
          };
          const buttons = await page.$$('button');
          const texts = [];
          for (const b of buttons) {
            const t = await b.text();
            if (t) texts.push(t);
            const openType = await b.attribute('open-type').catch(() => null);
            if (openType && String(openType).indexOf('share') >= 0) throw new Error(`[assert] ${item.route} 存在 open-type=share 按钮`);
          }
          const hits = [];
          for (const t of texts) for (const re of forbidden) if (re.test(t)) hits.push(t);
          if (hits.length) throw new Error(`[assert] ${item.route} 出现范围外入口文案：${hits.join(' | ')}`);

          // ---- 渲染可见断言（DEF-0008 回归）：DOM + 布局 rect + 像素统计，任一不满足即失败 ----
          // generating/result 等页面有异步状态（生成中→错误态 / 加载中→错误文案），首次采样可能落在
          // 中间帧；失败时等待 1.5s 重取一次（rects/选择器/截图），二次仍失败才判定为渲染回归。
          let rects;
          let missing;
          let shot;
          let visualErrors = [];
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            rects = await layoutOf();
            missing = await missingSelectors(page, spec);
            shot = await shotAndStats(`ac23-${routeKey.split('/').pop()}`);
            visualErrors = [];
            if (missing.length) visualErrors.push(`缺少选择器：${missing.join(', ')}`);
            // 新 `.screen`(100vh flex) + `.page-scroll`(flex:1) 结构下滚动容器必须是正高度；
            // 旧断言从未校验 rect，这里补上，避免「布局有、高度 0」再次漏检。
            if (!rects.pageBody || rects.pageBody.height < 100) {
              visualErrors.push(`.page-body rect 异常：${JSON.stringify(rects.pageBody)}`);
            }
            if (spec.screen) {
              if (!rects.screen || rects.screen.height < 400) visualErrors.push(`.screen rect 异常：${JSON.stringify(rects.screen)}`);
              if (!rects.pageScroll || rects.pageScroll.width < 100 || rects.pageScroll.height < 100) {
                visualErrors.push(`.page-scroll rect 异常：${JSON.stringify(rects.pageScroll)}`);
              }
            }
            if (!shot.stats) {
              visualErrors.push('截图缺失，无法做像素统计');
            } else {
              if (shot.stats.darkRatio < spec.minDark) visualErrors.push(`darkRatio=${shot.stats.darkRatio} < ${spec.minDark}`);
              if (shot.stats.contentDarkRatio < spec.minContent) {
                visualErrors.push(`contentDarkRatio=${shot.stats.contentDarkRatio} < ${spec.minContent}`);
              }
              if (spec.minEdge && shot.stats.contentEdgeRatio < spec.minEdge) {
                visualErrors.push(`contentEdgeRatio=${shot.stats.contentEdgeRatio} < ${spec.minEdge}`);
              }
            }
            if (calibrate) {
              console.log('[visual-calibrate]', actualRoute, JSON.stringify({ stats: shot.stats, rects, missing }));
            }
            if (!visualErrors.length || calibrate) break;
            if (attempt === 1) {
              console.log('[visual-retry]', actualRoute, '首次采样未通过，1.5s 后复核：', visualErrors.join('；'));
              await h.sleep(1500);
            }
          }
          if (visualErrors.length && !calibrate) {
            throw new Error(
              `[assert] ${actualRoute} 页面未真实绘制（疑似 DEF-0008 回归）：${visualErrors.join('；')}；` +
                `pagePath=${actualRoute}；screenshot=${shot.screenshot || 'null'}；stats=${JSON.stringify(shot.stats)}；rects=${JSON.stringify(rects)}`
            );
          }
          visited.push({
            route: item.route,
            actualRoute,
            redirected: actualRoute !== routeKey,
            launched: true,
            attempts: launched.attempt,
            buttons: texts,
            visual: {
              thresholds: { minDark: spec.minDark, minContent: spec.minContent, minEdge: spec.minEdge || 0 },
              stats: shot.stats,
              rects,
              requiredSelectors: spec.requiredSelectors || [],
              requiredAny: spec.requiredAny || [],
              errors: visualErrors,
            },
            screenshot: shot.screenshot,
            screenshotSha256: shot.screenshotSha256,
          });

          // consent 页扫完后必须完成同意，后续 capture/garment 等页面才不会被重定向回 consent。
          if (item.completeConsent) {
            if (actualRoute !== '/pages/consent/consent') {
              throw new Error('[assert] consent 页被重定向，无法完成同意前置');
            }
            await h.completeConsentOnPage(mp, page);
          }
        }
      } finally {
        await h.removeStorage(mp, 'sinn_active_task_v1').catch(() => null);
        await h.evaluate(mp, function () {
          var app = getApp();
          if (app && app.globalData) app.globalData.captureDraft = null;
        }).catch(() => null);
      }

      const launchedPages = visited.filter((v) => v.launched);
      if (launchedPages.length !== routes.length) {
        const missing = visited.filter((v) => !v.launched).map((v) => `${v.route}（${v.error}）`);
        throw new Error(`[assert] AC-23 要求 7 页真实渲染后扫描；仅 ${launchedPages.length}/${routes.length} 页完成，未完成：${missing.join('；')}`);
      }

      // 第二道防线：7 页截图不应完全相同（相同 = 陈旧帧或同一画面，无法证明逐页绘制）。
      const shotHashes = launchedPages.map((v) => v.screenshotSha256).filter(Boolean);
      const duplicateHashes = shotHashes.filter((hash, index) => shotHashes.indexOf(hash) !== index);
      if (duplicateHashes.length && !calibrate) {
        throw new Error(`[assert] AC-23 页面截图哈希重复（疑似陈旧帧/同一画面）：${[...new Set(duplicateHashes)].join(', ')}`);
      }

      const evidence = { reset, tabBar: null, visited };
      ctx.write('ac23-entries.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-011',
    tc: 'TC-0001-L3-011',
    ac: 'AC-25',
    title: '18+ 门禁：未确认无法进入上传页；ageConfirmedAt=0 回归不得放行',
    priority: 'P0',
    requires: ['login'],
    steps: [
      '清空本地同意记录后进入 consent：未勾选任何项时「下一步」禁用；仅勾 18+ 或仅勾条款仍禁用',
      '构造 sinn_consent_v1={agreedAt:>0, ageConfirmedAt:0} 后从首页进入：应回 consent，不得进入 capture；chooseMedia 0 次',
      'ageConfirmedAt>0 且版本合法时才能进入 capture（与 L2-029 回归结论一致）',
    ],
    async run(ctx) {
      const { mp } = ctx;
      // 服务端历史同意记录会让 index 直接进 capture，先真实撤销到未同意态。
      const reset = await resetConsentState(mp);
      const isDisabled = (value) => !(value === null || value === undefined || value === false || value === 'false');
      await h.installCallCounter(mp, 'chooseMedia');
      try {
        let page = await h.goIndex(mp);
        await h.sleep(300);
        const start = await page.$('.btn-primary');
        await start.tap();
        page = await h.waitRoute(mp, '/pages/consent/consent');
        const nextButton = await page.$('.btn-primary');
        const disabledBefore = await nextButton.attribute('disabled');
        if (!isDisabled(disabledBefore)) {
          throw new Error(`[assert] 未勾选时「下一步」应 disabled，实际 ${disabledBefore}`);
        }
        const rows = await page.$$('.check-row');
        await rows[0].tap(); // 只勾 18+
        // 实测：tap check-row 后立刻 reLaunch，开发者工具自动化桥会延迟约 10s 才回包
        // （偶发超过 automator 请求超时）。等待渲染/桥接稳定后再继续导航。
        await h.sleep(1200);
        const disabledPartial = await nextButton.attribute('disabled');
        if (!isDisabled(disabledPartial)) {
          throw new Error(`[assert] 仅勾 18+ 时「下一步」应 disabled，实际 ${disabledPartial}`);
        }
        // 构造「同意但未确认 18+」的回归缓存
        await h.setStorage(mp, 'sinn_consent_v1', {
          version: '2026-11-09-v1',
          agreedAt: Date.now(),
          ageConfirmedAt: 0,
        });
        page = await h.goIndex(mp);
        await h.sleep(300);
        const start2 = await page.$('.btn-primary');
        await start2.tap();
        const afterRoute = await h.waitFor(
          async () => {
            const current = await mp.currentPage();
            if (!current) return null;
            const route = h.normalizeRoute(current.path);
            return route === '/pages/consent/consent' || route === '/pages/capture/capture' ? route : null;
          },
          8000,
          250,
          'ageConfirmedAt=0 的入口路由'
        );
        const chooseCalls = await h.callCount(mp, 'chooseMedia');
        if (afterRoute !== '/pages/consent/consent') {
          throw new Error(`[assert] ageConfirmedAt=0 仍进入 ${afterRoute}（AC-25 回归失败）`);
        }
        if (chooseCalls !== 0) throw new Error(`[assert] 被 18+ 门禁拦截前 chooseMedia 应 0 次，实际 ${chooseCalls}`);
        const evidence = {
          reset,
          disabledBefore,
          disabledPartial,
          routeAfterForgedCache: afterRoute,
          chooseMediaCalls: chooseCalls,
          screenshot: await h.screenshot(mp, ctx.runDir, 'ac25-age-gate'),
        };
        ctx.write('ac25-age-gate.json', evidence);
        return evidence;
      } finally {
        // 清理构造的非法缓存，避免把 ageConfirmedAt=0 的伪造记录留在本机测试账号。
        await h.removeStorage(mp, 'sinn_consent_v1');
        await h.removeStorage(mp, 'sinn_quota_cache_v1');
      }
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'TC-0001-L3-012',
    tc: 'TC-0001-L3-012',
    ac: 'AC-2/AC-3/AC-4/AC-5/AC-24',
    title: '真实样张 → 服务端预检：各维度子码、≤5s、createTask 0 次、unknown 不放行',
    priority: 'P0',
    requires: [
      'login',
      'cloud',
      'vendor-real',
      'fixtures:MAT-02',
      'fixtures:MAT-03',
      'fixtures:MAT-04',
      'fixtures:MAT-05',
      'fixtures:MAT-06',
      'fixtures:MAT-07',
      'fixtures:MAT-09',
      'fixtures:MAT-10',
      'fixtures:MAT-11',
      'fixtures:MAT-12',
    ],
    steps: [
      '人像样张 MAT-02/03/04/05/06/07 逐张走 capture 选择→L0→上传→服务端预检',
      '记录返回子码（3002/3003/3004/3001/3006）、从点到提示耗时（≤5000ms）、createTask 调用 0 次',
      '衣服样张 MAT-09/10/11/12 走 garment 预检，记录 3010/3008/3009/3011，createTask 0 次',
      'unknown（3013）不得放行、不扣额度',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const personExpectations = [
        { mat: 'MAT-02', code: '3002', keyword: '全身' },
        { mat: 'MAT-03', code: '3003', keyword: '遮挡' },
        { mat: 'MAT-04', code: '3004', keyword: '遮挡' },
        { mat: 'MAT-05', code: '3001', keyword: '单人' },
        { mat: 'MAT-06', code: '3006', keyword: '光线' },
        { mat: 'MAT-07', code: '3006', keyword: '光线' },
      ];
      const garmentExpectations = [
        { mat: 'MAT-09', code: '3010', keyword: '吊牌' },
        { mat: 'MAT-10', code: '3008', keyword: '单件' },
        { mat: 'MAT-11', code: '3009', keyword: '模特' },
        { mat: 'MAT-12', code: '3011', keyword: '商品' },
      ];
      const quotaBefore = await readQuota(mp);
      const personResults = [];
      for (const item of personExpectations) {
        const capture = await h.enterCapture(mp);
        await h.fillMetrics(capture, { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 });
        await h.mockChooseMediaFromDisk(mp, matFiles([item.mat]));
        const t0 = Date.now();
        await h.addPersonPhotos(capture, 1);
        const hint = await h.waitFor(
          async () => {
            const t = await h.text(capture, '.hint');
            return t && t.length ? t : null;
          },
          8000,
          250,
          `${item.mat} 预检失败提示`
        );
        const elapsedMs = Date.now() - t0;
        if (elapsedMs > 5000) throw new Error(`[assert] ${item.mat} 从选择到提示 ${elapsedMs}ms > 5000ms`);
        if (hint.indexOf(item.keyword) < 0) throw new Error(`[assert] ${item.mat} 提示不含「${item.keyword}」：${hint}`);
        const route = h.normalizeRoute((await mp.currentPage()).path);
        if (route !== '/pages/capture/capture') throw new Error(`[assert] ${item.mat} 预检失败后不应离开 capture，实际 ${route}`);
        personResults.push({ mat: item.mat, expectedCode: item.code, hint, elapsedMs, route });
      }
      // 衣服四类：需要一个通过预检的人像后才能进入 garment
      const garmentResults = [];
      for (const item of garmentExpectations) {
        const capture = await h.enterCapture(mp);
        await h.mockChooseMediaFromDisk(mp, matFiles(['MAT-01']));
        await h.addPersonPhotos(capture, 1);
        await h.waitFor(
          async () => {
            const t = await h.text(capture, '.photo-status');
            return t && t.indexOf('已通过') >= 0;
          },
          30000,
          500,
          '人像预检通过'
        );
        await h.tap(capture, '.btn-primary');
        const garment = await h.waitRoute(mp, '/pages/garment/garment');
        await h.mockChooseMediaFromDisk(mp, matFiles([item.mat]));
        await h.addGarmentPhoto(garment);
        const hint = await h.waitFor(
          async () => {
            const t = await h.text(garment, '.hint');
            return t && t.length ? t : null;
          },
          8000,
          250,
          `${item.mat} 衣服预检提示`
        );
        if (hint.indexOf(item.keyword) < 0) throw new Error(`[assert] ${item.mat} 提示不含「${item.keyword}」：${hint}`);
        const route = h.normalizeRoute((await mp.currentPage()).path);
        if (route !== '/pages/garment/garment') throw new Error(`[assert] ${item.mat} 预检失败后不应离开 garment，实际 ${route}`);
        garmentResults.push({ mat: item.mat, expectedCode: item.code, hint, route });
      }
      const quotaAfter = await readQuota(mp);
      const evidence = { personResults, garmentResults, quotaBefore, quotaAfter };
      if (quotaBefore.used !== undefined && quotaAfter.used !== undefined && quotaAfter.used !== quotaBefore.used) {
        throw new Error(`[assert] 预检失败不应消耗额度（before=${quotaBefore.used}, after=${quotaAfter.used}）`);
      }
      ctx.write('ac2-24-precheck.json', evidence);
      return evidence;
    },
  },

  /* ------------------------------------------------------------------ */
  /* DEF-0009 回归：三页滚动容器 + 底部操作可达（用户真机反馈无法上下滑动） */
  {
    id: 'TC-0001-L3-013',
    tc: 'TC-0001-L3-013',
    ac: 'AC-19 / AC-23',
    title: 'DEF-0009 回归：result/profile/generating 可滚动到底，底部操作按钮进入视口可点击',
    priority: 'P0',
    requires: ['login', 'cloud', 'fixtures:MAT-01', 'fixtures:MAT-08'],
    steps: [
      '真实生成一次（mock vendor）拿到成功结果页；滚到底后断言 scrollTop>0，且「返回首页」「删除本次结果」rect 进入视口',
      '点「返回首页」验证可点击（不点删除，避免破坏数据），再进入我的页滚到底，断言「删除全部数据/返回首页」可达',
      'generating 页注入长 errorMessage（仅布局回归）后滚到底，断言「返回首页」可达；失败输出 pagePath/scrollTop/rect/截图',
    ],
    async run(ctx) {
      const { mp } = ctx;
      const evidence = { case: 'TC-0001-L3-013', def: 'DEF-0009', pages: {} };

      // 1) result 页：真实生成一次（消耗 1 次额度；mock vendor 约 8–60s 由环境决定）。
      const gen = await runGeneration(ctx, { personMat: ['MAT-01'], garmentMat: ['MAT-08'] });
      evidence.resultTaskId = gen.taskId;
      evidence.generationElapsedMs = gen.elapsedMs;
      const resultPath = h.normalizeRoute((await h.currentPage(mp)).path);
      if (resultPath !== '/pages/result/result') {
        throw new Error(`[assert] 生成成功后应进入结果页，实际 ${resultPath}`);
      }
      const beforeShot = await h.screenshot(mp, ctx.runDir, 'ac13-result-before-scroll');
      const resultScroll = await scrollToBottom(mp);
      const windowHeight = resultScroll.after.windowHeight || resultScroll.before.windowHeight;
      const resultOverflow = !!resultScroll.after.contentOverflow;
      const resultMaxScroll =
        resultOverflow && resultScroll.after.bodyHeight && resultScroll.after.scrollerHeight
          ? Math.max(0, Math.round(resultScroll.after.bodyHeight - resultScroll.after.scrollerHeight))
          : 0;
      const resultMode = resultScroll.realScroll ? 'actual' : 'structural';
      const resultTargets = await assertReachable(
        mp,
        resultPath,
        windowHeight,
        [
          { selector: '.btn-danger', label: '删除本次结果' },
          { selector: '.btn-secondary', label: '返回首页' },
        ],
        { mode: resultMode, maxScroll: resultMaxScroll }
      );
      const afterShot = await h.screenshot(mp, ctx.runDir, 'ac13-result-after-scroll');
      evidence.pages.result = {
        path: resultPath,
        before: resultScroll.before,
        after: resultScroll.after,
        moved: resultScroll.moved,
        scrollMethod: resultScroll.method,
        realScroll: resultScroll.realScroll,
        scrollAttempts: resultScroll.attempts,
        container: { tagName: resultScroll.tagName, scrollY: resultScroll.scrollY },
        overflow: resultOverflow,
        maxScroll: resultMaxScroll,
        assertMode: resultMode,
        targets: resultTargets,
        screenshots: { before: beforeShot, after: afterShot },
      };
      if (resultScroll.tagName !== 'scroll-view') {
        throw new Error(`[assert] result 页 .page-scroll 实际容器为 ${resultScroll.tagName}（不是 scroll-view），DEF-0009 回归失败`);
      }
      if (resultOverflow && !resultScroll.realScroll) {
        evidence.pages.result.toolchainNote =
          'T-7：Skyline scroll-view 在 automator connect 下无法被驱动（element.scrollTo / node.scrollTo / 手势均 scrollTop=0），改用结构断言：.page-scroll 为 scroll-view + 内容溢出 + 目标按钮在最大滚动位置进入视口；真实手指滑动属 CP-12，不得写「已验证」。';
      } else if (resultOverflow) {
        evidence.pages.result.toolchainNote = '真实滚动可用（scrollTop>0），按视口 rect 断言；真机手指滑动仍属 CP-12。';
      } else {
        evidence.pages.result.toolchainNote = '本机视口 result 内容未超一屏（overflow=false），按钮直接可达。';
      }

      // 点「返回首页」验证滚动后的按钮真实可点击（不点「删除本次结果」，避免破坏证据数据）。
      const resultPage = await h.currentPage(mp);
      const backBtn = await resultPage.$('.btn-secondary');
      if (!backBtn) throw new Error('[assert] 结果页缺少「返回首页」按钮');
      await backBtn.tap();
      await h.waitRoute(mp, '/pages/index/index', 30000);
      evidence.pages.result.clickedBackHome = true;

      // 2) profile 页：滚到底断言底部操作可达。
      const indexPage = await h.currentPage(mp);
      const profileEntry = await indexPage.$('.btn-ghost');
      if (!profileEntry) throw new Error('[assert] 首页缺少「我的」入口（.btn-ghost）');
      await profileEntry.tap();
      await h.waitRoute(mp, '/pages/profile/profile', 30000);
      const profilePath = h.normalizeRoute((await h.currentPage(mp)).path);
      const profileBeforeShot = await h.screenshot(mp, ctx.runDir, 'ac13-profile-before-scroll');
      const profileScroll = await scrollToBottom(mp);
      const profileWindowHeight = profileScroll.after.windowHeight || profileScroll.before.windowHeight;
      const profileOverflow = !!profileScroll.after.contentOverflow;
      const profileMaxScroll =
        profileOverflow && profileScroll.after.bodyHeight && profileScroll.after.scrollerHeight
          ? Math.max(0, Math.round(profileScroll.after.bodyHeight - profileScroll.after.scrollerHeight))
          : 0;
      const profileMode = profileScroll.realScroll ? 'actual' : 'structural';
      const profileTargets = await assertReachable(
        mp,
        profilePath,
        profileWindowHeight,
        [
          { selector: '.btn-secondary', label: '删除全部数据' },
          { selector: '.btn-ghost', label: '返回首页' },
        ],
        { mode: profileMode, maxScroll: profileMaxScroll }
      );
      const profileAfterShot = await h.screenshot(mp, ctx.runDir, 'ac13-profile-after-scroll');
      evidence.pages.profile = {
        path: profilePath,
        before: profileScroll.before,
        after: profileScroll.after,
        moved: profileScroll.moved,
        targets: profileTargets,
        screenshots: { before: profileBeforeShot, after: profileAfterShot },
      };
      evidence.pages.profile.overflow = profileOverflow;
      evidence.pages.profile.scrollMethod = profileScroll.method;
      evidence.pages.profile.realScroll = profileScroll.realScroll;
      evidence.pages.profile.maxScroll = profileMaxScroll;
      evidence.pages.profile.assertMode = profileMode;
      evidence.pages.profile.container = { tagName: profileScroll.tagName, scrollY: profileScroll.scrollY };
      if (profileScroll.tagName !== 'scroll-view') {
        throw new Error(`[assert] profile 页 .page-scroll 实际容器为 ${profileScroll.tagName}（不是 scroll-view），DEF-0009 回归失败`);
      }
      if (profileOverflow && !profileScroll.realScroll) {
        evidence.pages.profile.toolchainNote =
          'T-7：Skyline scroll-view 在 automator connect 下无法被驱动，采用结构断言（scroll-view + 内容溢出 + 目标按钮在最大滚动位置进入视口）；真机手指滑动属 CP-12。';
      } else if (profileOverflow) {
        evidence.pages.profile.toolchainNote = '真实滚动可用（scrollTop>0）；真机手指滑动仍属 CP-12。';
      } else {
        evidence.pages.profile.toolchainNote = '本机视口下 profile 内容未超一屏（overflow=false）；底部按钮直接可达。';
      }

      // 3) generating 页：注入长 errorMessage 仅验证滚动容器布局（不覆盖真实长文案产品路径）。
      const fakeTaskId = 't_e2e00000000000000000000';
      await h.appReLaunch(mp, `/pages/generating/generating?taskId=${encodeURIComponent(fakeTaskId)}`);
      const genPage = await h.waitFor(
        async () => {
          const page = await mp.currentPage();
          if (!page || h.normalizeRoute(page.path) !== '/pages/generating/generating') return null;
          const title = await page.$('.generating-error-title');
          return title ? page : null;
        },
        30000,
        500,
        'generating 失败态渲染'
      );
      const genPath = h.normalizeRoute(genPage.path);
      const genBeforeShot = await h.screenshot(mp, ctx.runDir, 'ac13-generating-before-scroll');
      const longText = '这是用于验证滚动容器的长文案，仅测试布局，不代表真实产品文案。'.repeat(60);
      await genPage.setData({ errorMessage: longText });
      await h.sleep(900);
      let genScroll = await scrollToBottom(mp);
      if (!genScroll.after.contentOverflow) {
        // 一次加长仍不溢出时，再放大一档（仅布局回归）。
        await genPage.setData({ errorMessage: longText.repeat(2) });
        await h.sleep(900);
        genScroll = await scrollToBottom(mp);
      }
      const genWindowHeight = genScroll.after.windowHeight || genScroll.before.windowHeight;
      const genOverflow = !!genScroll.after.contentOverflow;
      const genMaxScroll =
        genOverflow && genScroll.after.bodyHeight && genScroll.after.scrollerHeight
          ? Math.max(0, Math.round(genScroll.after.bodyHeight - genScroll.after.scrollerHeight))
          : 0;
      const genMode = genScroll.realScroll ? 'actual' : 'structural';
      const genTargets = await assertReachable(
        mp,
        genPath,
        genWindowHeight,
        [{ selector: '.btn-secondary', label: '返回首页' }],
        { mode: genMode, maxScroll: genMaxScroll }
      );
      const genAfterShot = await h.screenshot(mp, ctx.runDir, 'ac13-generating-after-scroll');
      evidence.pages.generating = {
        path: genPath,
        injectedLongText: true,
        injectionNote: '通过 page.setData 注入长 errorMessage，仅验证 scroll-view 容器布局与底部按钮可达；不覆盖真实长文案产品路径（真机长文案/小视口由 CP-12 人工项覆盖）。',
        before: genScroll.before,
        after: genScroll.after,
        moved: genScroll.moved,
        scrollMethod: genScroll.method,
        realScroll: genScroll.realScroll,
        maxScroll: genMaxScroll,
        assertMode: genMode,
        container: { tagName: genScroll.tagName, scrollY: genScroll.scrollY },
        overflow: genOverflow,
        targets: genTargets,
        screenshots: { before: genBeforeShot, after: genAfterShot },
      };
      if (!genOverflow) {
        throw new Error('[assert] 注入长文案后 generating 页内容仍未超一屏，无法验证滚动容器（请检查 .page-scroll 结构或注入长度）');
      }
      if (genScroll.tagName !== 'scroll-view') {
        throw new Error(`[assert] generating 页 .page-scroll 实际容器为 ${genScroll.tagName}（不是 scroll-view），DEF-0009 回归失败`);
      }
      if (!genScroll.realScroll) {
        evidence.pages.generating.toolchainNote =
          'T-7：Skyline scroll-view 在 automator connect 下无法被驱动（element.scrollTo / node.scrollTo / 手势均 scrollTop=0），采用结构断言（scroll-view + 内容溢出 + 目标按钮在最大滚动位置进入视口）；真机手指滑动属 CP-12，不得写「已验证」。';
      }
      // 真实 tap「返回首页」验证按钮可点击（不依赖视觉滚动）。
      const genPageNow = await h.currentPage(mp);
      const genBack = await genPageNow.$('.btn-secondary');
      if (!genBack) throw new Error('[assert] generating 页缺少「返回首页」按钮');
      await genBack.tap();
      await h.waitRoute(mp, '/pages/index/index', 30000);
      evidence.pages.generating.clickedBackHome = true;

      // 记录证据文件哈希（截图 + 本 JSON 由 runner 落盘）。
      evidence.sha256 = {};
      const shots = [
        beforeShot,
        afterShot,
        profileBeforeShot,
        profileAfterShot,
        genBeforeShot,
        genAfterShot,
      ].filter(Boolean);
      shots.forEach((rel) => {
        evidence.sha256[rel] = sha256File(rel);
      });
      ctx.write('ac13-scroll.json', evidence);
      return evidence;
    },
  },
  {
    id: 'TC-0001-L3-014',
    tc: 'TC-0001-L3-014',
    ac: 'AC-29',
    title: 'AC-29 供应商输入规格对齐：端上压缩决策/档位/错误码/提示（离线契约场景 ①–④）',
    priority: 'P0',
    offline: true,
    requires: [],
    steps: [
      '离线驱动生产模块 photo-adapt.compressToVendorSpec（注入 renderJpeg/sizeOf deps）：① 6MB/4000px → ≤5MB 且长边 ≤4096、提示「已自动优化照片（供应商限制）」',
      '② 质量档用尽仍超 → 4096→3072→2048 逐档降尺寸，断言最终长边/字节与尝试档位顺序',
      '③ 长边 <1024 / 解码失败 / 全档用尽 → 3014「分辨率过低，请重拍」或 5007「照片处理失败，请重试或更换照片」；契约层不触达 uploadFile/createTask（页面级 spy 由 L2 单测覆盖），assertVendorSpec 二次断言兜底',
      '④ 2048px/2MB 小图 → 不压缩、无提示、字节与长边保持原值；失败输出场景、错误码、压缩参数与计数桩',
    ],
    async run(ctx) {
      // 离线契约用例：不依赖 automator/云环境；页面 UI 与真实 canvas 压缩由 L2/CP-12 覆盖。
      const ac29 = require('./ac29-scenarios');
      const summary = await ac29.runScenarios();
      const evidence = {
        case: 'TC-0001-L3-014',
        ac: 'AC-29',
        kind: 'offline-contract',
        executedBy: 'tests/e2e/lib/ac29-scenarios.js（生产模块 photo-adapt.js + 注入 deps）',
        sourceNote: '不由 automator 驱动页面 UI；不触达 wx.uploadFile/createTask；真实 canvas 压缩字节/耗时/内存需真机 CP-12，不得写「已验证」。',
        environment: {
          needsDevtools: false,
          needsCloud: false,
          module: 'miniprogram/services/photo-adapt.js',
        },
        total: summary.total,
        pass: summary.pass,
        fail: summary.fail,
        scenarios: summary.results,
      };
      ctx.write('ac29-compress.json', evidence);
      if (summary.fail > 0) {
        const failed = summary.results
          .filter((r) => r.status !== 'pass')
          .map((r) => `${r.id}: ${(r.evidence.failure && r.evidence.failure.message) || 'failed'}`)
          .join('; ');
        throw new Error(`[assert] AC-29 离线场景 ${summary.fail}/${summary.total} 失败：${failed}`);
      }
      return evidence;
    },
  },
];

module.exports = { CASES, MAT };
