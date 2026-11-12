#!/usr/bin/env node
'use strict';
// SPIKE-0002：验证 Tripo 3D 提交端点可达（用缺参请求，不创建真实任务、不消耗积分）。
// 用法: node dashscope-validate.js [--host dashscope|workspace] [--workspace <id>]
const fs = require('fs');
const https = require('https');

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key';
const HOST_DASHSCOPE = 'dashscope.aliyuncs.com';

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected');
  return raw;
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, timeout: 30000 }, (res) => {
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
  const key = readKey();
  const args = process.argv.slice(2);
  const wi = args.indexOf('--workspace');
  const workspace = wi >= 0 ? args[wi + 1] : '';
  const host = workspace ? workspace + '.cn-beijing.maas.aliyuncs.com' : HOST_DASHSCOPE;
  const url = 'https://' + host + '/api/v1/services/aigc/video-generation/3d-generation';

  // 缺 input：预期 400 参数错误（不创建任务、不计费）。
  const body = JSON.stringify({ model: 'Tripo/Tripo-H3.1', input: {}, parameters: { texture_quality: 'standard' } });
  const r = await post(url, {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable'
  }, body);
  console.log('POST', url, '->', r.status);
  console.log('body:', String(r.body).split(key).join('sk-***').slice(0, 1200));
})().catch((e) => {
  console.error('validate failed:', String(e && e.message ? e.message : e));
  process.exit(1);
});
