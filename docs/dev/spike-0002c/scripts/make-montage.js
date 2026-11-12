#!/usr/bin/env node
'use strict'
/**
 * SPIKE-0002C：生成对比九宫格（原图 / P1 2D 换装结果 / C3 两段式 3D / C1 / C2 / xr-frame 实测）。
 * 用法：node make-montage.js
 * 输出：docs/dev/spike-0002c/evidence/comparison-montage.jpg
 */
const path = require('path')
const Jimp = require('jimp')

const EVIDENCE = path.join(__dirname, '..', 'evidence')
const REPO = path.join(__dirname, '..', '..', '..', '..')
const CELL = 320

const PANELS = [
  { title: 'MAT-01 original photo', file: path.join(REPO, 'tests', 'fixtures', 'mat', 'mat-01-woman-fullbody.jpg') },
  { title: 'P1 2D try-on result (C3 input)', file: path.join(REPO, 'evidence', '2026-11-11', 'real-runs', '20261111-233212', 't_92c75debd3c1b23cf6da2213.png') },
  { title: 'C3 two-stage 3D (standard, vendor render)', file: path.join(EVIDENCE, 'c3-rendered.png') },
  { title: 'C3 xr-frame in devtools (230x497)', file: path.join(EVIDENCE, 'render-C3.png') },
  { title: 'C1 single-image 3D (ultra+detailed 4K, vendor render)', file: path.join(EVIDENCE, 'c1-rendered.png') },
  { title: 'C2 single-image 3D (ultra+extreme 8K, vendor render)', file: path.join(EVIDENCE, 'c2-rendered.png') }
]

async function main() {
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
  const cols = 3
  const rows = Math.ceil(PANELS.length / cols)
  const width = cols * CELL
  const height = rows * (CELL + 44)
  const out = new Jimp(width, height, 0x1a1d24ff)
  for (let i = 0; i < PANELS.length; i++) {
    const panel = PANELS[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = col * CELL
    const y = row * (CELL + 44)
    try {
      const img = await Jimp.read(panel.file)
      img.contain(CELL - 12, CELL - 12)
      out.composite(img, x + 6, y + 6)
    } catch (error) {
      out.print(font, x + 8, y + 20, 'load failed')
    }
    const label = panel.title.length > 34 ? panel.title.slice(0, 33) + '…' : panel.title
    out.print(font, x + 6, y + CELL + 8, label)
  }
  const target = path.join(EVIDENCE, 'comparison-montage.jpg')
  await out.quality(90).writeAsync(target)
  console.log(JSON.stringify({ ok: true, path: target, width, height }))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error && error.message }))
  process.exitCode = 1
})
