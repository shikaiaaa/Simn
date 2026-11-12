#!/usr/bin/env node
'use strict';
// SPIKE-0002：查询/轮询 DashScope Tripo 任务；不打印密钥。
// 用法: node dashscope-task.js <task_id> [--poll]
const fs = require('fs');
const https = require('https');

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1/tasks/';

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected');
  return raw;
}

function get(url, key) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function sanitize(text, key) { return String(text || '').split(key).join('sk-***'); }

(async () => {
  const taskId = process.argv[2];
  if (!taskId) throw new Error('task_id required');
  const key = readKey();
  const poll = process.argv.includes('--poll');
  const t0 = Date.now();
  let lastStatus = '';
  const deadline = Date.now() + 8 * 60 * 1000;
  do {
    const r = await get(BASE + encodeURIComponent(taskId), key);
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) { /* ignore */ }
    const st = parsed && parsed.output ? parsed.output.task_status : ('HTTP_' + r.status);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('[' + elapsed + 's] status=' + st + ' http=' + r.status);
    if (st !== lastStatus) {
      console.log('  body:', sanitize(r.body, key).slice(0, 3000));
      lastStatus = st;
    }
    if (!poll) return;
    if (['SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'].indexOf(st) >= 0) {
      console.log('FINAL body:', sanitize(r.body, key));
      return;
    }
    await new Promise((res) => setTimeout(res, 10000));
  } while (Date.now() < deadline);
  console.log('poll timeout');
})().catch((e) => {
  console.error('task query failed:', String(e && e.message ? e.message : e));
  process.exit(1);
});
