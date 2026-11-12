#!/usr/bin/env node
'use strict';
// SPIKE-0002：通过 IDE automator 在 app 上下文调用临时云函数 spike-model3d。
// 不打印任何密钥（云函数仅返回图片 URL）。
// 用法: node spike3d-cloudfn.js uploadInput|deleteInput [fileID]
const automator = require('miniprogram-automator');
const fs = require('fs');
const path = require('path');

const WS = 'ws://127.0.0.1:9434';
const GATE = 'sinn-spike-2026-11-12';
const OUT_DIR = path.join(__dirname, '..', 'evidence');

function save(name, obj) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

(async () => {
  const action = process.argv[2] || 'info';
  const arg2 = process.argv[3] || '';
  const mp = await automator.connect({ wsEndpoint: WS });
  const payload = { gate: GATE, action: action };
  if (action === 'deleteInput') payload.fileID = arg2;
  const result = await mp.evaluate(function (data) {
    return new Promise(function (resolve) {
      wx.cloud.callFunction({
        name: 'spike-model3d',
        data: data,
        success: function (r) { resolve({ ok: true, result: r.result }); },
        fail: function (e) { resolve({ ok: false, errMsg: (e && e.errMsg) || String(e) }); }
      });
    });
  }, payload);
  console.log(JSON.stringify(result));
  save('cloudfn-' + action + '.json', { at: new Date().toISOString(), payload: Object.assign({}, payload), result: result });
  await mp.disconnect();
})().catch((e) => {
  console.error('cloudfn invoke failed:', String((e && e.message) || e));
  process.exit(1);
});
