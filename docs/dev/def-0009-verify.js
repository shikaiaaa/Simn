/**
 * docs/dev/def-0009-verify.js — DEF-0009（result/profile/generating 可滚动）取证脚本。
 * 复用 task-49 方式：IDE automator（端口 9434）+ wx.createSelectorQuery 量 rect +
 * 临时 scroll-into-view 钩子证明可滚到底。取证后临时钩子必须还原（见 DEV-0001 §45）。
 *
 * 用法：node docs/dev/def-0009-verify.js
 */
'use strict'

var fs = require('fs')
var path = require('path')
var automator = require('miniprogram-automator')

var WS = 'ws://127.0.0.1:9434'
var OUT = path.join(__dirname, 'def-0009-evidence')

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
}

async function rect(mp, selector) {
  var res = await mp.evaluate(function (sel) {
    return new Promise(function (resolve) {
      var q = wx.createSelectorQuery()
      q.select(sel).boundingClientRect()
      q.exec(function (list) {
        resolve(list && list[0] ? list[0] : null)
      })
    })
  }, selector)
  return res
}

async function pageDataSet(mp, patch) {
  var page = await mp.currentPage()
  await page.setData(patch)
  return true
}

async function main() {
  ensureOut()
  var mp = await automator.connect({ wsEndpoint: WS })
  var results = {}

  await mp.evaluate(function (url) {
    wx.reLaunch({ url: url })
  }, '/pages/result/result?taskId=t_def0009_verify')
  await sleep(800)

  // 注入一屏以上的结果内容（避免依赖真实任务/真实云数据）
  await pageDataSet(mp, {
    loading: false,
    errorText: '',
    aiLabel: 'AI 生成',
    imageUrl: '',
    result: { width: 2048, height: 3072 },
    sizeView: {
      available: true,
      rangeText: 'L–XL',
      standardText: '标准：GB/T 1335.1',
      basisText: '依据：身高 175cm / 体重 70.5kg',
      disclaimer: '参考尺码，不构成合身承诺'
    },
    degradedNotice: ''
  })
  await sleep(500)

  var scrollBox = await rect(mp, '.page-scroll')
  var stage = await rect(mp, '.result-stage')
  var actionsBefore = await rect(mp, '#result-actions')
  var footnoteBefore = await rect(mp, '.result-footnote')
  var shotTop = path.join(OUT, 'result-scroll-top.png')
  await mp.screenshot({ path: shotTop })

  // 临时 scroll-into-view 钩子：把 actions 滚入视口
  await pageDataSet(mp, { scrollInto: 'result-actions' })
  await sleep(600)
  var actionsAfter = await rect(mp, '#result-actions')
  var sys = await mp.systemInfo()
  var shotBottom = path.join(OUT, 'result-scroll-bottom.png')
  await mp.screenshot({ path: shotBottom })

  results.result = {
    viewport: { windowWidth: sys.windowWidth, windowHeight: sys.windowHeight },
    scrollBox: scrollBox,
    stage: stage,
    actionsBefore: actionsBefore,
    actionsAfter: actionsAfter,
    footnoteBefore: footnoteBefore,
    actionsMovedIntoViewport:
      actionsAfter && sys && actionsAfter.top >= 0 && actionsAfter.bottom <= sys.windowHeight,
    screenshots: { top: shotTop, bottom: shotBottom }
  }

  // profile / generating 结构同样可滚动：量 scrollBox 高度供 §45 记录
  for (var i = 0; i < 2; i += 1) {
    var route = i === 0 ? '/pages/profile/profile' : '/pages/generating/generating?taskId=t_def0009_verify'
    var key = i === 0 ? 'profile' : 'generating'
    await mp.evaluate(function (url) {
      wx.reLaunch({ url: url })
    }, route)
    await sleep(700)
    var box = await rect(mp, '.page-scroll')
    var shot = path.join(OUT, key + '-page.png')
    await mp.screenshot({ path: shot })
    results[key] = { scrollBox: box, screenshot: shot }
  }

  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ ok: true, out: OUT, results: results }, null, 2))
  await mp.disconnect()
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
