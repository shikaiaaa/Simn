#!/usr/bin/env node
'use strict'
/**
 * SPIKE-0002C：刷新已完成 task 的结果 URL（查询不计费；结果 URL 2h 有效）。
 * 用法：node tripo-refresh-url.js <taskId> [--out <file>]
 * 输出：JSON {taskId,status,modelUrl,renderedImageUrl,...}（不打印密钥）
 * 默认写到 %TEMP%/sinn-spike2c/urls-<taskId>.json
 */
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key'
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks'

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected')
  return raw
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 60000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const taskId = args[0]
  if (!taskId) throw new Error('taskId required')
  let out = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null
  const key = readKey()
  const res = await get(TASK_URL + '/' + taskId, { Authorization: 'Bearer ' + key })
  if (res.status !== 200) throw new Error('query http ' + res.status)
  const json = JSON.parse(res.body)
  const output = json.output || {}
  const results = output.results || []
  const first = results[0] || {}
  const record = {
    taskId,
    status: output.task_status || null,
    submitTime: output.submit_time || null,
    endTime: output.end_time || null,
    usage: json.usage || null,
    modelUrl: first.pbr_model_url || first.base_model_url || first.model_url || null,
    renderedImageUrl: first.rendered_image_url || null,
    rawKeys: Object.keys(first)
  }
  if (!out) {
    const tmpDir = path.join(os.tmpdir(), 'sinn-spike2c')
    fs.mkdirSync(tmpDir, { recursive: true })
    out = path.join(tmpDir, 'urls-' + taskId + '.json')
  }
  fs.writeFileSync(out, JSON.stringify(record, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: res.status === 200, status: record.status, out: out.replace(os.tmpdir(), '%TEMP%'), modelUrlPresent: !!record.modelUrl, renderedImageUrlPresent: !!record.renderedImageUrl }))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error && error.message }))
  process.exitCode = 1
})
