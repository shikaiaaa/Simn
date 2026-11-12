#!/usr/bin/env node
'use strict'
/**
 * SPIKE-0002C：临时页 xr-frame 渲染对比（C1/C2/C3）。
 * 用法：node spike-c-render.js C3 C1 C2
 * 前置：临时页 pages/spike-3d + 组件 spike-xr 已存在、app.json 已注册、IDE automation 端口已开。
 * 产物：docs/dev/spike-0002c/evidence/render-<label>.png / render-<label>.json
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const automator = require('miniprogram-automator')

const TASKS = {
  C1: 'f69d7b90-e3a1-49f9-9965-3e0616451174',
  C2: '9da4aa44-6354-480f-bf4d-9f61c4002707',
  C3: '87bf2c71-1606-48dc-b32d-e22935b825dd'
}
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence')
const TMP_DIR = path.join(os.tmpdir(), 'sinn-spike2c')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readModelUrl(label) {
  const file = path.join(TMP_DIR, 'urls-' + TASKS[label] + '.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!record.modelUrl) throw new Error('no modelUrl for ' + label)
  return record.modelUrl
}

async function renderOne(mp, label, logs) {
  const modelUrl = readModelUrl(label)
  const startedAt = Date.now()
  await mp.evaluate(function (url) {
    wx.setStorageSync('spike_model_url', url)
  }, modelUrl)
  await mp.evaluate(function () {
    wx.reLaunch({ url: '/pages/spike-3d/index' })
  })
  await sleep(4000)
  let page = await mp.currentPage()
  let data = await page.data()
  let waited = 0
  while (waited < 150000) {
    data = await page.data()
    if (data.sceneText === 'SCENE-READY' && data.assetsText === 'ASSETS-LOADED' && data.gltfText === 'GLTF-LOADED') {
      break
    }
    await sleep(4000)
    waited += 4000
  }
  await sleep(3000)
  data = await page.data()
  const screenshotPath = path.join(EVIDENCE_DIR, 'render-' + label + '.png')
  await mp.screenshot({ path: screenshotPath })
  const record = {
    label,
    taskId: TASKS[label],
    waitedMs: waited,
    elapsedMs: Date.now() - startedAt,
    route: await page.path,
    data,
    screenshot: screenshotPath,
    logTail: logs.slice(-20)
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'render-' + label + '.json'), JSON.stringify(record, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, label, data, screenshotPath }))
  return record
}

async function main() {
  const labels = process.argv.slice(2)
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const logs = []
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9434' })
  mp.on('console', (msg) => logs.push('console:' + JSON.stringify(msg)))
  mp.on('exception', (err) => logs.push('exception:' + JSON.stringify(err)))
  try {
    for (const label of labels) {
      if (!TASKS[label]) throw new Error('unknown label ' + label)
      await renderOne(mp, label, logs)
    }
  } finally {
    try { await mp.disconnect() } catch (error) {}
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error && error.message, stack: error && error.stack }))
  process.exitCode = 1
})
