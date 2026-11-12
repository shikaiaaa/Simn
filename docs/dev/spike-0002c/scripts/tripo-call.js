#!/usr/bin/env node
'use strict'
/**
 * SPIKE-0002C：Tripo 图片换装（3D 形象）高档参数调用脚本。
 *
 * 用法：
 *   node tripo-call.js --label C1 --image-url <公网临时URL> [--model Tripo/Tripo-H3.1]
 *     [--geometry ultra] [--texture detailed] [--face-limit 1500000] [--pbr true]
 *     [--poll-sec 8] [--max-wait-sec 600]
 *
 * 行为：submit → 轮询任务 → 下载 GLB/rendered → 解析 GLB 摘要 → 写证据 JSON（不含密钥/不存大文件）。
 * 证据目录：docs/dev/spike-0002c/evidence/
 * 临时下载目录：%TEMP%/sinn-spike2c/（大 GLB 不入库；脚本结束不自动删，由清理脚本处理）
 */
const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')

const KEY_FILE = 'C:\\Users\\admin\\.sinn-secrets\\tripo.key'
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/3d-generation'
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks'
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence')
const TMP_DIR = path.join(os.tmpdir(), 'sinn-spike2c')

function readKey() {
  const raw = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (!raw.startsWith('sk-') || raw.length !== 117) throw new Error('key format unexpected')
  return raw
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key || !key.startsWith('--')) throw new Error('bad arg: ' + key)
    args[key.slice(2)] = argv[i + 1]
  }
  return args
}

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 120000 }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 180000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('download http ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error('glb too short')
  const magic = buffer.toString('ascii', 0, 4)
  if (magic !== 'glTF') throw new Error('bad magic: ' + magic)
  const version = readUInt32LE(buffer, 4)
  const declared = readUInt32LE(buffer, 8)
  if (version !== 2) throw new Error('bad version: ' + version)
  if (declared !== buffer.length) throw new Error('declared length mismatch: ' + declared + ' != ' + buffer.length)
  let json = null
  let binBytes = 0
  let offset = 12
  const chunks = []
  while (offset + 8 <= buffer.length) {
    const length = readUInt32LE(buffer, offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    chunks.push({ type, bytes: length })
    if (type === 'JSON') json = JSON.parse(buffer.toString('utf8', offset + 8, offset + 8 + length))
    if (type === 'BIN\0' || type.startsWith('BIN')) binBytes += length
    offset += 8 + length
  }
  if (!json) throw new Error('no JSON chunk')
  const accessors = json.accessors || []
  let triangleCount = 0
  ;(json.meshes || []).forEach((mesh) => {
    ;(mesh.primitives || []).forEach((prim) => {
      const mode = prim.mode === undefined ? 4 : prim.mode
      if (mode !== 4) return
      if (prim.indices && prim.indices >= 0) triangleCount += Math.floor(accessors[prim.indices].count / 3)
      else if (prim.attributes && prim.attributes.POSITION && prim.attributes.POSITION >= 0) {
        triangleCount += Math.floor(accessors[prim.attributes.POSITION].count / 3)
      }
    })
  })
  const images = json.images || []
  const textureBytes = images.reduce((sum, img) => {
    const view = img.bufferView !== undefined && json.bufferViews ? json.bufferViews[img.bufferView] : null
    return sum + (view && view.byteLength ? view.byteLength : 0)
  }, 0)
  return {
    version,
    bytes: buffer.length,
    sha256: sha256(buffer),
    chunks,
    binBytes,
    nodeCount: (json.nodes || []).length,
    meshCount: (json.meshes || []).length,
    primitiveCount: (json.meshes || []).reduce((n, m) => n + (m.primitives || []).length, 0),
    materialCount: (json.materials || []).length,
    imageCount: images.length,
    textureBytes,
    triangleCount,
    generator: (json.asset && json.asset.generator) || '',
    hasPbrMaterial: (json.materials || []).some((m) => m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const label = args.label
  const imageUrl = args['image-url']
  if (!label) throw new Error('--label required')
  if (!imageUrl) throw new Error('--image-url required')
  const model = args.model || 'Tripo/Tripo-H3.1'
  const geometry = args.geometry || 'standard'
  const texture = args.texture || 'standard'
  const pbr = args.pbr !== 'false'
  const faceLimit = args['face-limit'] ? Number(args['face-limit']) : null
  const pollSec = Number(args['poll-sec'] || 8)
  const maxWaitSec = Number(args['max-wait-sec'] || 600)
  const key = readKey()
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })

  const parameters = { texture_quality: texture, geometry_quality: geometry, pbr }
  if (faceLimit) parameters.face_limit = faceLimit
  const body = JSON.stringify({ model, input: { image: imageUrl }, parameters })
  const submittedAt = Date.now()
  const submitRes = await request('POST', ENDPOINT, {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable'
  }, body)
  const submitJson = submitRes.status === 200 ? JSON.parse(submitRes.body) : null
  const taskId = submitJson && submitJson.output && submitJson.output.task_id
  const submitRecord = {
    label,
    endpoint: ENDPOINT,
    model,
    parameters,
    inputImageIsUrl: true,
    inputImageUrl: imageUrl.replace(/sign=[^&]+/, 'sign=***'),
    httpStatus: submitRes.status,
    requestId: submitJson && submitJson.request_id,
    taskId: taskId || null,
    submittedAt,
    submittedAtIso: new Date(submittedAt).toISOString(),
    response: submitJson || { raw: submitRes.body },
    note: '密钥不打印、不落盘'
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'submit-' + label + '.json'), JSON.stringify(submitRecord, null, 2), 'utf8')
  if (!taskId) {
    console.log(JSON.stringify({ ok: false, stage: 'submit', label, httpStatus: submitRes.status, response: submitJson || submitRes.body }, null, 2))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify({ ok: true, stage: 'submitted', label, taskId, requestId: submitRecord.requestId }, null, 2))

  const startedPoll = Date.now()
  let latest = null
  let lastStatus = ''
  while ((Date.now() - startedPoll) / 1000 < maxWaitSec) {
    const res = await request('GET', TASK_URL + '/' + taskId, { Authorization: 'Bearer ' + key }, null)
    if (res.status !== 200) {
      latest = { httpStatus: res.status, raw: res.body }
      break
    }
    const json = JSON.parse(res.body)
    const status = (json.output && json.output.task_status) || 'UNKNOWN'
    lastStatus = status
    latest = json
    const elapsedMs = Date.now() - submittedAt
    console.log(JSON.stringify({ poll: true, label, status, elapsedMs }))
    if (['SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'].indexOf(status) >= 0 && status !== 'UNKNOWN') break
    await new Promise((r) => setTimeout(r, pollSec * 1000))
  }

  const finishedAt = Date.now()
  const output = (latest && latest.output) || {}
  const results = output.results || []
  const first = results[0] || {}
  const modelUrl = first.pbr_model_url || first.base_model_url || first.model_url || null

  const taskRecord = {
    label,
    taskId,
    status: lastStatus,
    submittedAt,
    finishedAt,
    elapsedMs: finishedAt - submittedAt,
    submitTime: output.submit_time,
    scheduledTime: output.scheduled_time,
    endTime: output.end_time,
    usage: latest && latest.usage ? latest.usage : null,
    results: results.map((r) => ({
      pbrModelUrl: r.pbr_model_url ? r.pbr_model_url.replace(/auth_key=[^&]+/, 'auth_key=***') : null,
      baseModelUrl: r.base_model_url ? r.base_model_url.replace(/auth_key=[^&]+/, 'auth_key=***') : null,
      renderedImageUrl: r.rendered_image_url ? r.rendered_image_url.replace(/auth_key=[^&]+/, 'auth_key=***') : null
    })),
    rawSummary: { code: latest && latest.code, message: latest && latest.message, requestId: latest && latest.request_id }
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'task-' + label + '.json'), JSON.stringify(taskRecord, null, 2), 'utf8')

  if (lastStatus !== 'SUCCEEDED' || !modelUrl) {
    console.log(JSON.stringify({ ok: false, stage: 'task', label, status: lastStatus, taskRecord }, null, 2))
    process.exitCode = 1
    return
  }

  const modelBuffer = await download(modelUrl)
  const glbPath = path.join(TMP_DIR, label + '-' + taskId + '.glb')
  fs.writeFileSync(glbPath, modelBuffer)
  const glbSummary = parseGlb(modelBuffer)

  let renderedBytes = null
  let renderedSha = null
  if (first.rendered_image_url) {
    const rendered = await download(first.rendered_image_url)
    const renderedPath = path.join(TMP_DIR, label + '-' + taskId + '-rendered.webp')
    fs.writeFileSync(renderedPath, rendered)
    renderedBytes = rendered.length
    renderedSha = sha256(rendered)
  }

  const result = {
    label,
    taskId,
    model,
    parameters,
    usage: taskRecord.usage,
    elapsedMs: taskRecord.elapsedMs,
    status: lastStatus,
    glb: {
      bytes: glbSummary.bytes,
      sha256: glbSummary.sha256,
      nodeCount: glbSummary.nodeCount,
      meshCount: glbSummary.meshCount,
      primitiveCount: glbSummary.primitiveCount,
      materialCount: glbSummary.materialCount,
      imageCount: glbSummary.imageCount,
      textureBytes: glbSummary.textureBytes,
      triangleCount: glbSummary.triangleCount,
      generator: glbSummary.generator,
      hasPbrMaterial: glbSummary.hasPbrMaterial,
      chunks: glbSummary.chunks
    },
    exceeds45MB: glbSummary.bytes > 45 * 1024 * 1024,
    renderedImage: renderedBytes ? { bytes: renderedBytes, sha256: renderedSha } : null,
    localGlbPath: glbPath.replace(os.tmpdir(), '%TEMP%')
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'result-' + label + '.json'), JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, stage: 'done', result }, null, 2))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, stage: 'exception', message: error && error.message }, null, 2))
  process.exitCode = 1
})
