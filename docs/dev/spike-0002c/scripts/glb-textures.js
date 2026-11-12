#!/usr/bin/env node
'use strict'
/**
 * SPIKE-0002C：提取 GLB 内嵌纹理并导出缩略预览（用于 4K vs 8K 贴图质量对比）。
 * 用法：node glb-textures.js C1 C2 C3
 * 输入：%TEMP%/sinn-spike2c/<label>-<taskId>.glb
 * 输出：docs/dev/spike-0002c/evidence/textures-<label>/（预览 jpg + summary json）、docs/dev/spike-0002c/evidence/texture-summary.json
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Jimp = require('jimp')

const TASKS = {
  C1: 'f69d7b90-e3a1-49f9-9965-3e0616451174',
  C2: '9da4aa44-6354-480f-bf4d-9f61c4002707',
  C3: '87bf2c71-1606-48dc-b32d-e22935b825dd'
}
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence')
const TMP_DIR = path.join(os.tmpdir(), 'sinn-spike2c')

function parseJsonChunk(buffer) {
  const declared = buffer.readUInt32LE(8)
  if (buffer.toString('ascii', 0, 4) !== 'glTF' || declared !== buffer.length) throw new Error('bad glb')
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'JSON') return JSON.parse(buffer.toString('utf8', offset + 8, offset + 8 + length))
    offset += 8 + length
  }
  throw new Error('no JSON chunk')
}

function binChunkRange(buffer) {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type.startsWith('BIN')) return { start: offset + 8, length: length }
    offset += 8 + length
  }
  throw new Error('no BIN chunk')
}

function guessExt(mime, bytes) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  return 'bin'
}

async function extract(label) {
  const glbPath = path.join(TMP_DIR, label + '-' + TASKS[label] + '.glb')
  const buffer = fs.readFileSync(glbPath)
  const json = parseJsonChunk(buffer)
  const bin = binChunkRange(buffer)
  const outDir = path.join(EVIDENCE_DIR, 'textures-' + label)
  fs.mkdirSync(outDir, { recursive: true })
  const images = []
  for (let i = 0; i < (json.images || []).length; i++) {
    const image = json.images[i]
    if (image.bufferView === undefined || !json.bufferViews) continue
    const view = json.bufferViews[image.bufferView]
    const start = bin.start + (view.byteOffset || 0)
    const end = start + view.byteLength
    const raw = buffer.slice(start, end)
    const ext = guessExt(image.mimeType, raw)
    const fileName = 'image-' + i + '.' + ext
    fs.writeFileSync(path.join(outDir, fileName), raw)
    let width = null
    let height = null
    let preview = null
    try {
      const img = await Jimp.read(raw)
      width = img.bitmap.width
      height = img.bitmap.height
      const copy = img.clone()
      if (width > 512 || height > 512) copy.scaleToFit(512, 512)
      const previewName = 'image-' + i + '-preview.jpg'
      await copy.quality(90).writeAsync(path.join(outDir, previewName))
      preview = path.join(outDir, previewName)
    } catch (error) {
      width = null
    }
    images.push({
      index: i,
      mimeType: image.mimeType || null,
      bytes: raw.length,
      width,
      height,
      file: path.join(outDir, fileName),
      preview
    })
  }
  const summary = {
    label,
    taskId: TASKS[label],
    glbBytes: buffer.length,
    textureCount: images.length,
    textureBytes: images.reduce((sum, item) => sum + item.bytes, 0),
    images
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'texture-' + label + '.json'), JSON.stringify(summary, null, 2), 'utf8')
  return summary
}

async function main() {
  const labels = process.argv.slice(2)
  const all = []
  for (const label of labels) {
    if (!TASKS[label]) throw new Error('unknown label ' + label)
    all.push(await extract(label))
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'texture-summary.json'), JSON.stringify(all, null, 2), 'utf8')
  console.log(JSON.stringify(all.map((item) => ({ label: item.label, textureBytes: item.textureBytes, images: item.images.map((img) => ({ bytes: img.bytes, width: img.width, height: img.height })) })), null, 2))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error && error.message }))
  process.exitCode = 1
})
