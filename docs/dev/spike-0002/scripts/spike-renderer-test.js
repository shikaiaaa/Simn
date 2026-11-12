#!/usr/bin/env node
'use strict';
// SPIKE-0002：页面级 renderer:"webview" 覆盖探针。
// 判定：skyline 下 wx.pageScrollTo 不生效（DEF-0008 已证）；webview 下生效 -> delta > 0。
// 用法: node spike-renderer-test.js
const automator = require('miniprogram-automator');
const fs = require('fs');
const path = require('path');

const WS = 'ws://127.0.0.1:9434';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const ts = Date.now();

function save(name, obj) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

(async () => {
  const mp = await automator.connect({ wsEndpoint: WS });
  const logs = [];
  mp.on('console', function (msg) {
    logs.push({ type: 'console', text: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  });
  mp.on('exception', function (err) {
    logs.push({ type: 'exception', text: JSON.stringify(err) });
  });

  await mp.evaluate(function (url) { wx.reLaunch({ url: url }); }, '/pages/spike-renderer/index');
  await sleep(4500);

  const snap = await mp.evaluate(function () {
    var pages = getCurrentPages();
    var p = pages[pages.length - 1];
    return { route: p && p.route, data: (p && p.data) || null };
  });

  const shot = path.join(OUT_DIR, 'renderer-probe-' + ts + '.png');
  try {
    await mp.screenshot({ path: shot });
  } catch (e) {
    logs.push({ type: 'screenshot-failed', text: String((e && e.message) || e) });
  }

  const out = {
    at: new Date().toISOString(),
    page: '/pages/spike-renderer/index',
    pageJsonRenderer: 'webview',
    snap: snap,
    console: logs.slice(0, 200),
    screenshot: shot
  };
  save('renderer-probe-' + ts + '.json', out);
  console.log(JSON.stringify(out, null, 2));

  await mp.disconnect();
})().catch(function (e) {
  console.error('renderer probe failed:', String((e && e.message) || e));
  process.exit(1);
});
