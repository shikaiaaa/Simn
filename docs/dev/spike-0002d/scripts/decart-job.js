#!/usr/bin/env node
/**
 * SPIKE-0002D：Decart Lucy VTON 批量任务脚本（默认 dry-run，不花钱）。
 *
 * 用法：
 *   node docs/dev/spike-0002d/scripts/decart-job.js            # 只查 credits + 校验输入（不提交任务）
 *   node docs/dev/spike-0002d/scripts/decart-job.js --run      # 真的提交 1 个批量任务（≤$0.25）
 *
 * 安全：
 *   - key 只从 C:\Users\admin\.sinn-secrets\decart.key 读取，绝不打印；日志中一律 dct_***
 *   - 失败不重试；只允许 1 个任务（脚本不循环提交）
 *   - 输出视频 ≤10MB 时入库到 evidence/，否则放 %TEMP%\sinn-spike2d\ 只记录 SHA256
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const KEY_PATH = 'C:\\Users\\admin\\.sinn-secrets\\decart.key'
const API = 'https://api.decart.ai'

const REPO = path.resolve(__dirname, '..', '..', '..', '..')
const SPIKE_DIR = path.join(REPO, 'docs', 'dev', 'spike-0002d')
const INPUT_DIR = path.join(SPIKE_DIR, 'inputs')
const EVIDENCE_DIR = path.join(SPIKE_DIR, 'evidence')
const VIDEO_PATH = path.join(INPUT_DIR, 'mat-01-person-5s-720x1280.mp4')
const GARMENT_PATH = path.join(INPUT_DIR, 'mat-08-garment-crop-1024.jpg')

const PROMPT =
  'Substitute the current top with a cream oversized knit short-sleeve sweater, crew neck, ribbed hem'

function log(...args) {
  console.log('[spike2d]', ...args)
}

function sha256File(file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

function readKey() {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error('missing key file: ' + KEY_PATH + '（等待用户放入 decart.key）')
  }
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  if (!/^dct_/.test(key)) {
    throw new Error('key format unexpected（不是 dct_ 前缀），长度=' + key.length)
  }
  return key
}

function maskKey(text) {
  return String(text || '').replace(/dct_[A-Za-z0-9_\-]+/g, 'dct_***')
}

async function apiJson(key, url, options) {
  const res = await fetch(url, Object.assign({}, options, {
    headers: Object.assign({ Authorization: 'Bearer ' + key }, (options && options.headers) || {}),
  }))
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (e) {
    /* 非 JSON */
  }
  return { status: res.status, ok: res.ok, json, text: json ? null : text.slice(0, 800) }
}

function assertInputs() {
  for (const f of [VIDEO_PATH, GARMENT_PATH]) {
    if (!fs.existsSync(f)) throw new Error('missing input: ' + f)
  }
  const video = fs.statSync(VIDEO_PATH)
  const garment = fs.statSync(GARMENT_PATH)
  log('input video:', video.size, 'bytes, sha256=' + sha256File(VIDEO_PATH))
  log('input garment:', garment.size, 'bytes, sha256=' + sha256File(GARMENT_PATH))
  if (video.size > 200 * 1024 * 1024) throw new Error('video too large > 200MB')
  return {
    videoBytes: video.size,
    videoSha256: sha256File(VIDEO_PATH),
    garmentBytes: garment.size,
    garmentSha256: sha256File(GARMENT_PATH),
  }
}

async function getCredits(key) {
  const res = await apiJson(key, API + '/v1/credits', { method: 'GET' })
  return res
}

async function submitJob(key, prompt) {
  const form = new FormData()
  form.append('data', new Blob([fs.readFileSync(VIDEO_PATH)], { type: 'video/mp4' }), 'mat-01-person-5s-720x1280.mp4')
  form.append('prompt', prompt)
  form.append(
    'reference_image',
    new Blob([fs.readFileSync(GARMENT_PATH)], { type: 'image/jpeg' }),
    'mat-08-garment-crop-1024.jpg'
  )
  form.append('resolution', '720p')

  const res = await fetch(API + '/v1/jobs/lucy-vton-latest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body: form,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (e) {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, json, rawText: json ? null : maskKey(text).slice(0, 1200) }
}

function jobIdOf(json) {
  if (!json) return ''
  return json.id || json.job_id || json.jobId || (json.data && (json.data.id || json.data.job_id)) || ''
}

function statusOf(json) {
  if (!json) return ''
  const s = json.status || (json.data && json.data.status) || ''
  return String(s).toLowerCase()
}

async function pollJob(key, jobId, onState) {
  const startedAt = Date.now()
  const maxWaitMs = 10 * 60 * 1000
  const intervalMs = 5000
  let last = null
  while (Date.now() - startedAt < maxWaitMs) {
    const res = await apiJson(key, API + '/v1/jobs/' + encodeURIComponent(jobId), { method: 'GET' })
    const status = statusOf(res.json)
    if (onState && (!last || last !== status)) {
      onState(status, res.status)
      last = status
    }
    if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
      return { status, body: res.json, httpStatus: res.status }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('poll timeout after ' + Math.round(maxWaitMs / 1000) + 's')
}

async function downloadContent(key, jobId, label) {
  const res = await fetch(API + '/v1/jobs/' + encodeURIComponent(jobId) + '/content', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + key },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error('content download failed http=' + res.status + ' ' + maskKey(text).slice(0, 500))
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const maxRepoBytes = 10 * 1024 * 1024
  let outPath
  if (buf.length <= maxRepoBytes) {
    outPath = path.join(EVIDENCE_DIR, 'decart-output-' + label + '.mp4')
  } else {
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'sinn-spike2d')
    fs.mkdirSync(tmpDir, { recursive: true })
    outPath = path.join(tmpDir, 'decart-output-' + label + '.mp4')
  }
  fs.writeFileSync(outPath, buf)
  return { bytes: buf.length, sha256: sha, path: outPath, repoTracked: buf.length <= maxRepoBytes }
}

async function main() {
  const run = process.argv.includes('--run')
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const inputs = assertInputs()

  let key
  try {
    key = readKey()
    log('key loaded: dct_*** (length=' + key.length + ')')
  } catch (e) {
    log('BLOCKED: ' + e.message)
    log('inputs are ready; script will submit 1 job (≤$0.25) once the key exists.')
    return 0
  }

  const creditsBefore = await getCredits(key)
  log('credits before: http=' + creditsBefore.status + ' body=' + JSON.stringify(creditsBefore.json || creditsBefore.text))
  if (!run) {
    log('dry-run: not submitting. rerun with --run to submit exactly 1 job.')
    return 0
  }

  const label = String(Date.now())
  const startedAt = Date.now()
  const timeline = []
  const submitted = await submitJob(key, PROMPT)
  log('submit: http=' + submitted.status)
  if (!submitted.ok) {
    const ev = { label, phase: 'submit_failed', httpStatus: submitted.status, raw: submitted.rawText, prompt: PROMPT, inputs, creditsBefore: creditsBefore.json, timeline, at: new Date().toISOString() }
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'decart-submit-failed-' + label + '.json'), JSON.stringify(ev, null, 2))
    log('submit failed, not retrying:', submitted.rawText || JSON.stringify(submitted.json))
    return 1
  }
  const jobId = jobIdOf(submitted.json)
  if (!jobId) {
    log('submit ok but no job id:', JSON.stringify(submitted.json))
    return 1
  }
  log('job id:', jobId)

  const result = await pollJob(key, jobId, (status, httpStatus) => {
    timeline.push({ status, httpStatus, at: Date.now() })
    log('status:', status, 'http=' + httpStatus, 'elapsed=' + Math.round((Date.now() - startedAt) / 1000) + 's')
  })
  const totalMs = Date.now() - startedAt

  let output = null
  let downloadError = null
  if (result.status === 'completed') {
    try {
      output = await downloadContent(key, jobId, label)
      log('output:', output.bytes, 'bytes sha256=' + output.sha256, 'path=' + output.path)
    } catch (e) {
      downloadError = maskKey(e.message)
      log('download failed:', downloadError)
    }
  }

  const creditsAfter = await getCredits(key)
  const evidence = {
    label,
    provider: 'decart',
    model: 'lucy-vton-latest',
    jobId,
    prompt: PROMPT,
    resolution: '720p',
    submitAt: startedAt,
    totalMs,
    status: result.status,
    timeline,
    creditsBefore: creditsBefore.json,
    creditsAfter: creditsAfter.json,
    output,
    downloadError,
    inputs,
    note: '单次任务；失败不重试；key 已脱敏',
    at: new Date().toISOString(),
  }
  const evPath = path.join(EVIDENCE_DIR, 'decart-job-' + label + '.json')
  fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2))
  log('evidence:', evPath)
  return result.status === 'completed' && output ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[spike2d] ERROR:', maskKey(e && e.stack ? e.stack : e))
    process.exit(1)
  })
