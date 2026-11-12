#!/usr/bin/env node
'use strict';
// SPIKE-0002：拉取 Tripo 任务最终结果、下载 GLB/预览图、解析 GLB 摘要。
// 用法: node tripo-fetch-result.js <task_id>
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1/tasks/';
const OUT = path.join(__dirname, '..', 'evidence');

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected');
  return raw;
}

function request(url, headers, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {}, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function getJson(url, headers) {
  const res = await request(url, headers);
  let data = '';
  for await (const chunk of res.stream) data += chunk;
  let parsed = null;
  try { parsed = JSON.parse(data); } catch (e) { /* ignore */ }
  return { status: res.status, parsed: parsed, raw: data };
}

async function download(url, file) {
  const res = await request(url, {});
  if (res.status !== 200) throw new Error('download HTTP ' + res.status + ' for ' + file);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let bytes = 0;
  await new Promise((resolve, reject) => {
    res.stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); out.write(chunk); });
    res.stream.on('end', () => { out.end(resolve); });
    res.stream.on('error', reject);
    out.on('error', reject);
  });
  return { bytes: bytes, sha256: hash.digest('hex') };
}

function parseGlb(buf) {
  const out = { magic: '', version: 0, totalBytes: buf.length, chunks: [], json: null, meshCount: 0, nodeCount: 0, materialCount: 0, imageCount: 0, textureBytesTotal: 0, primitiveCount: 0, accessorsMax: 0 };
  if (buf.length < 12) return out;
  out.magic = buf.toString('ascii', 0, 4);
  out.version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  let off = 12;
  while (off + 8 <= buf.length && off + 8 <= total) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    out.chunks.push({ type: type, bytes: len });
    if (type === 'JSON') {
      const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
      out.json = json;
      out.meshCount = (json.meshes || []).length;
      out.nodeCount = (json.nodes || []).length;
      out.materialCount = (json.materials || []).length;
      out.imageCount = (json.images || []).length;
      out.primitiveCount = (json.meshes || []).reduce((a, m) => a + (m.primitives || []).length, 0);
      for (const img of json.images || []) {
        const bv = (json.bufferViews || [])[img.bufferView];
        if (img.bufferView !== undefined && bv) {
          out.textureBytesTotal += bv.byteLength || 0;
          if (!img.mimeType) out.imageMimeMissing = true;
        } else {
          out.imageExternal = (out.imageExternal || 0) + 1;
        }
      }
      for (const acc of json.accessors || []) {
        if (acc.type === 'VEC3' && acc.count) out.accessorsMax = Math.max(out.accessorsMax, acc.count);
      }
      out.materials = (json.materials || []).map((m) => ({
        name: m.name || '',
        pbr: m.pbrMetallicRoughness ? {
          hasBaseColorTexture: !!(m.pbrMetallicRoughness.baseColorTexture),
          hasMetallicRoughnessTexture: !!(m.pbrMetallicRoughness.metallicRoughnessTexture),
          baseColorFactor: m.pbrMetallicRoughness.baseColorFactor || null
        } : null,
        normalTexture: !!m.normalTexture
      }));
    }
    off += 8 + len;
    while (off % 4 !== 0) off += 1;
  }
  return out;
}

(async () => {
  const taskId = process.argv[2];
  if (!taskId) throw new Error('task_id required');
  const key = readKey();
  const q = await getJson(BASE + encodeURIComponent(taskId), { Authorization: 'Bearer ' + key });
  const output = (q.parsed && q.parsed.output) || {};
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'task-result-' + taskId + '.json'), JSON.stringify(q.parsed, null, 2), 'utf8');
  console.log('status=' + output.task_status + ' credits=' + JSON.stringify((q.parsed && q.parsed.usage) || null));
  let results = output.results || [];
  // 兼容 results 为对象数组或单对象
  const item = Array.isArray(results) ? (results[0] || {}) : (results || {});
  const modelUrl = item.pbr_model_url || item.model_url || item.base_model_url || '';
  const renderedUrl = item.rendered_image_url || '';
  const summary = { taskId: taskId, status: output.task_status, submit_time: output.submit_time, scheduled_time: output.scheduled_time, end_time: output.end_time, usage: (q.parsed && q.parsed.usage) || null, modelUrl: modelUrl, renderedUrl: renderedUrl, downloaded: {} };
  if (modelUrl) {
    const glbFile = path.join(OUT, 'model-' + taskId + '.glb');
    const dl = await download(modelUrl, glbFile);
    const buf = fs.readFileSync(glbFile);
    summary.downloaded.glb = { file: path.basename(glbFile), bytes: dl.bytes, sha256: dl.sha256, glb: parseGlb(buf) };
    console.log('GLB downloaded bytes=' + dl.bytes + ' sha256=' + dl.sha256 + ' magic=' + summary.downloaded.glb.glb.magic + ' meshes=' + summary.downloaded.glb.glb.meshCount + ' nodes=' + summary.downloaded.glb.glb.nodeCount + ' materials=' + summary.downloaded.glb.glb.materialCount + ' images=' + summary.downloaded.glb.glb.imageCount + ' textureBytes=' + summary.downloaded.glb.glb.textureBytesTotal);
  }
  if (renderedUrl) {
    const ext = /\.webp(\?|$)/i.test(renderedUrl) ? 'webp' : 'img';
    const imgFile = path.join(OUT, 'rendered-' + taskId + '.' + ext);
    const dl2 = await download(renderedUrl, imgFile);
    summary.downloaded.rendered = { file: path.basename(imgFile), bytes: dl2.bytes, sha256: dl2.sha256 };
    console.log('rendered downloaded bytes=' + dl2.bytes + ' sha256=' + dl2.sha256);
  }
  fs.writeFileSync(path.join(OUT, 'task-summary-' + taskId + '.json'), JSON.stringify(summary, null, 2), 'utf8');
})().catch((e) => {
  console.error('fetch result failed:', String((e && e.message) || e));
  process.exit(1);
});
