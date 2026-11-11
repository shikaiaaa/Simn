#!/usr/bin/env node
/**
 * ac29-offline.js —— AC-29 离线契约执行入口（QA task-70）。
 *
 * 运行：node tests/e2e/ac29-offline.js
 * 不需要开发者工具/自动化端口/云环境；直接驱动生产模块 photo-adapt.js。
 * 产物：tests/e2e/results/ac29-offline/<runId>/ac29-offline.json（含证据与 SHA256）
 * 退出码：0 = 全部场景通过；1 = 有失败。
 *
 * 口径：本脚本只覆盖 AC-29 的端上压缩决策/档位/错误码/提示文案契约；
 * 页面 UI、uploadFile/createTask 的 spy 断言由 DEV L2 单测与 L3 automator 整跑覆盖；
 * 真实 canvas 压缩的字节/耗时/内存需真机 CP-12，本脚本不替代、不写「已验证」。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { runScenarios, PHOTO_ADAPT_PATH } = require('./lib/ac29-scenarios')

const ROOT = path.resolve(__dirname, '../..')
const RESULTS_DIR = path.join(ROOT, 'tests/e2e/results/ac29-offline')

function pad(n) {
  return String(n).padStart(2, '0')
}

function runId() {
  const d = new Date()
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '-ac29'
  )
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
}

function main() {
  const id = runId()
  const dir = path.join(RESULTS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })

  console.log('[ac29-offline] module=' + PHOTO_ADAPT_PATH)
  console.log('[ac29-offline] runId=' + id)

  return runScenarios().then((summary) => {
    summary.runId = id
    summary.kind = 'ac29-offline-contract'
    summary.environment = {
      mode: 'node-offline',
      needsDevtools: false,
      needsCloud: false,
      productModule: 'miniprogram/services/photo-adapt.js',
      note: '注入 deps（renderJpeg/sizeOf/now）驱动生产压缩模块；不触达 wx.uploadFile/createTask；真实 canvas 压缩需真机 CP-12'
    }

    const outFile = path.join(dir, 'ac29-offline.json')
    const text = JSON.stringify(summary, null, 2)
    fs.writeFileSync(outFile, text, 'utf8')
    const sha = sha256(Buffer.from(text, 'utf8'))

    console.log('')
    console.log('| 场景 | AC | 状态 | 结果 |')
    console.log('| --- | --- | --- | --- |')
    summary.results.forEach((r) => {
      const ev = r.evidence || {}
      const brief = ev.failure
        ? ev.failure.message
        : ev.error
          ? 'error: ' + ev.error.message
          : (ev.result && (ev.result.ok
            ? 'ok compressed=' + ev.result.compressed + ' bytes=' + ev.result.bytes + ' longSide=' + ev.result.longSide + ' sizeStep=' + (ev.result.sizeStep || '-')
            : 'fail code=' + ev.result.apiCode + ' ' + ev.result.code))
      console.log('| ' + r.id + ' | ' + r.ac + ' | ' + r.status + ' | ' + String(brief).replace(/\|/g, '/') + ' |')
    })
    console.log('')
    console.log('[ac29-offline] total=' + summary.total + ' pass=' + summary.pass + ' fail=' + summary.fail)
    console.log('[ac29-offline] evidence=' + path.relative(ROOT, outFile) + ' bytes=' + Buffer.byteLength(text) + ' sha256=' + sha)

    // last-run 指针（供文档/报告引用；生成物，已被 gitignore）
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'last-run.json'),
      JSON.stringify({ runId: id, file: path.relative(ROOT, outFile), sha256: sha, at: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    )

    if (summary.fail > 0) {
      console.error('[ac29-offline] FAILED: ' + summary.fail + ' scenario(s) failed')
      process.exitCode = 1
    } else {
      console.log('[ac29-offline] PASS: all ' + summary.pass + ' scenario(s) passed')
    }
  })
}

main().catch((err) => {
  console.error('[ac29-offline] FATAL: ' + (err && err.stack ? err.stack : err))
  process.exitCode = 1
})
