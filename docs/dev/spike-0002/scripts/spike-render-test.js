#!/usr/bin/env node
'use strict';
// SPIKE-0002：渲染可行性实测（临时页 pages/spike-3d/index，页面级 renderer:"webview" + xr-frame）。
// 用法: node spike-render-test.js [waitMs]
const automator = require('miniprogram-automator');
const fs = require('fs');
const path = require('path');

const WS = 'ws://127.0.0.1:9434';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const WAIT_MS = Number(process.argv[2] || 24000);
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
  try {
    mp.on('console', function (msg) {
      logs.push({ type: 'console', text: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    });
    mp.on('exception', function (err) {
      logs.push({ type: 'exception', text: JSON.stringify(err) });
    });
  } catch (e) {
    logs.push({ type: 'hook-failed', text: String((e && e.message) || e) });
  }

  try {
    await mp.evaluate(function (url) { wx.reLaunch({ url: url }); }, '/pages/spike-3d/index');
  } catch (e) {
    logs.push({ type: 'relaunch-failed', text: String((e && e.message) || e) });
  }

  await sleep(3000);
  const snap1 = await mp.evaluate(function () {
    var pages = getCurrentPages();
    var p = pages[pages.length - 1];
    return { route: p && p.route, data: (p && p.data) || null };
  });

  await sleep(WAIT_MS);
  const snap2 = await mp.evaluate(function () {
    var pages = getCurrentPages();
    var p = pages[pages.length - 1];
    return { route: p && p.route, data: (p && p.data) || null };
  });

  const shot = path.join(OUT_DIR, 'render-xr-' + ts + '.png');
  try {
    await mp.screenshot({ path: shot });
  } catch (e) {
    logs.push({ type: 'screenshot-failed', text: String((e && e.message) || e) });
  }

  const out = {
    at: new Date().toISOString(),
    page: '/pages/spike-3d/index',
    pageJsonRenderer: 'webview',
    waitMs: WAIT_MS,
    snap1: snap1,
    snap2: snap2,
    console: logs.slice(0, 200),
    screenshot: shot
  };
  save('render-xr-' + ts + '.json', out);
  console.log(JSON.stringify(out, null, 2));

  await mp.disconnect();
})().catch(function (e) {
  console.error('render test failed:', String((e && e.message) || e));
  process.exit(1);
});
