#!/usr/bin/env node
'use strict';
// SPIKE-0002：提交 Tripo 3D 生成任务（真实调用，消耗积分）。
// 用法: node dashscope-submit.js <imageUrl> [--model Tripo/Tripo-H3.1] [--texture standard]
// 记录：证据 JSON（不含密钥）；最多人工调用 2 次，需自行控制。
const fs = require('fs');
const https = require('https');
const path = require('path');

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key';
const URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/3d-generation';
const OUT_DIR = path.join(__dirname, '..', 'evidence');

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected');
  return raw;
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, timeout: 60000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const imageUrl = process.argv[2];
  if (!imageUrl) throw new Error('imageUrl required');
  const args = process.argv.slice(2);
  const mi = args.indexOf('--model');
  const model = mi >= 0 ? args[mi + 1] : 'Tripo/Tripo-H3.1';
  const ti = args.indexOf('--texture');
  const texture = ti >= 0 ? args[ti + 1] : 'standard';
  const key = readKey();
  const payload = {
    model: model,
    input: { image: imageUrl },
    parameters: { texture_quality: texture }
  };
  const body = JSON.stringify(payload);
  const startedAt = Date.now();
  const r = await post(URL, {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable'
  }, body);
  const elapsedMs = Date.now() - startedAt;
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (e) { /* ignore */ }
  const safe = { httpStatus: r.status, elapsedMs: elapsedMs, request: { model: model, textureQuality: texture, imageUrl: imageUrl }, response: parsed, rawBody: String(r.body).split(key).join('sk-***') };
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'submit-' + startedAt + '.json');
  fs.writeFileSync(file, JSON.stringify(safe, null, 2), 'utf8');
  console.log(JSON.stringify({ sent: true, httpStatus: r.status, elapsedMs: elapsedMs, taskId: parsed && parsed.output ? parsed.output.task_id : null, status: parsed && parsed.output ? parsed.output.task_status : null, evidence: file }));
})().catch((e) => {
  console.error('submit failed:', String((e && e.message) || e));
  process.exit(1);
});
