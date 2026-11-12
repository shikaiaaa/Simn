#!/usr/bin/env node
'use strict';
// SPIKE-0002 探针：验证 DashScope 凭证/端点可用性。绝不打印密钥明文。
// 用法: node dashscope-probe.js [--tasks-zero] [--models]
const fs = require('fs');
const https = require('https');

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key';

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!raw.startsWith('sk-') || raw.length !== 117) {
    throw new Error('key format unexpected: len=' + raw.length + ' prefix=' + raw.slice(0, 3));
  }
  return raw;
}

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 20000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const key = readKey();
  const auth = { Authorization: 'Bearer ' + 'sk-***' };
  void auth;
  const useTasksZero = process.argv.includes('--tasks-zero');
  const useModels = process.argv.includes('--models');

  if (useTasksZero) {
    const r = await request('GET', 'https://dashscope.aliyuncs.com/api/v1/tasks/0', {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    });
    console.log('GET /api/v1/tasks/0 ->', r.status);
    console.log('body:', sanitize(r.body, key));
  }

  if (useModels) {
    const r = await request('GET', 'https://dashscope.aliyuncs.com/api/v1/models?page_size=200', {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    });
    console.log('GET /api/v1/models ->', r.status);
    if (r.status === 200) {
      let names = [];
      try {
        const j = JSON.parse(r.body);
        const list = j.data || j.models || j.output || [];
        names = list.map((m) => m.name || m.model || m.id).filter(Boolean);
      } catch (e) { /* ignore */ }
      const tripo = names.filter((n) => /tripo/i.test(n));
      console.log('total_models=' + names.length + ' tripo=' + JSON.stringify(tripo));
    } else {
      console.log('body:', sanitize(r.body, key));
    }
  }
})().catch((e) => {
  console.error('probe failed:', String(e && e.message ? e.message : e));
  process.exit(1);
});

function sanitize(text, key) {
  if (!text) return '';
  return String(text).split(key).join('sk-***');
}
