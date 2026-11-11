'use strict'

/**
 * DEF-0008 证据脚本：Skyline 下 scroll-view 页面空白（仅当自动化服务在 9434 端口运行时）。
 *
 * 用法：
 *   node docs/dev/def-0008-verify.js before    # 修复前：只截图 index，证明空白
 *   node docs/dev/def-0008-verify.js after     # 修复后：7 页截图 + 长页滚到底
 *
 * 输出：docs/dev/def-0008-evidence/*.png 与 stats-<mode>.json（含 darkRatio/contentDarkRatio）。
 * 说明：本机 automator 的 reLaunch/navigateTo 封装在 Skyline 下会超时，统一改用
 * `mp.evaluate(wx.reLaunch)` 导航；页面状态用 setData/滚动也只做视觉取证，不写业务数据。
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const automator = require('miniprogram-automator')

const WS = 'ws://127.0.0.1:9434'
const OUT_DIR = path.join(__dirname, 'def-0008-evidence')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced png not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  if (!channels || bitDepth !== 8) throw new Error('unsupported png: colorType=' + colorType + ' bitDepth=' + bitDepth)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const lineStart = y * stride
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[pos]
      pos += 1
      const left = x >= channels ? out[lineStart + x - channels] : 0
      const up = y > 0 ? out[lineStart - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? out[lineStart - stride + x - channels] : 0
      let val
      if (filter === 0) val = rawByte
      else if (filter === 1) val = (rawByte + left) & 0xff
      else if (filter === 2) val = (rawByte + up) & 0xff
      else if (filter === 3) val = (rawByte + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        val = (rawByte + pr) & 0xff
      } else {
        throw new Error('bad png filter ' + filter)
      }
      out[lineStart + x] = val
    }
  }
  return { width, height, channels, pixels: out }
}

function imageStats(file) {
  const img = decodePng(fs.readFileSync(file))
  const { width, height, channels, pixels } = img
  const contentTop = Math.floor(height * 0.12)
  let dark = 0
  let total = 0
  let darkContent = 0
  let totalContent = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels
      const r = pixels[i]
      const g = channels >= 3 ? pixels[i + 1] : r
      const b = channels >= 3 ? pixels[i + 2] : r
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      total += 1
      if (lum < 160) dark += 1
      if (y >= contentTop) {
        totalContent += 1
        if (lum < 160) darkContent += 1
      }
    }
  }
  return {
    width,
    height,
    darkRatio: Number((dark / total).toFixed(4)),
    contentDarkRatio: Number((darkContent / totalContent).toFixed(4)),
  }
}

async function shot(mp, name) {
  const file = path.join(OUT_DIR, name + '.png')
  await mp.screenshot({ path: file })
  await sleep(250)
  return Object.assign({ name, file }, imageStats(file))
}

async function currentPath(mp) {
  return mp.evaluate(function () {
    const pages = getCurrentPages()
    return pages.length ? pages[pages.length - 1].route : ''
  })
}

async function btnRect(mp) {
  return mp.evaluate(function () {
    return new Promise(function (resolve) {
      var pages = getCurrentPages()
      var cur = pages[pages.length - 1]
      var q = wx.createSelectorQuery().in(cur)
      q.select('.btn-primary').boundingClientRect(function (r) {
        resolve(r ? { top: r.top, bottom: r.bottom, height: r.height } : null)
      })
      q.exec()
    })
  })
}

async function goto(mp, url) {
  await mp.evaluate(function (u) {
    wx.reLaunch({ url: u, success: function () {}, fail: function () {} })
  }, url)
  await sleep(1800)
  return currentPath(mp)
}

async function scrollBottom(mp) {
  // Skyline 没有页面级全局滚动（官方文档），长页滚动必须用 scroll-view 元素自身 scrollTo
  const page = await mp.currentPage()
  const sv = await page.$('scroll-view')
  if (!sv) return { scrolled: false }
  let scrollHeight = 0
  try {
    scrollHeight = await sv.scrollHeight()
  } catch (err) {
    scrollHeight = 0
  }
  const target = Math.max(scrollHeight, 2000)
  await sv.scrollTo(0, target)
  await sleep(700)
  let scrollTop = null
  try {
    scrollTop = await sv.property('scrollTop')
  } catch (err) {
    scrollTop = null
  }
  return { scrolled: true, scrollHeight, scrollTop }
}

async function main() {
  const mode = process.argv[2] || 'after'
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const mp = await automator.connect({ wsEndpoint: WS })
  console.log('connected, mode=' + mode)
  const results = []
  const errors = []

  async function seedConsent() {
    await mp.evaluate(function () {
      wx.setStorageSync(
        'sinn_consent_v1',
        JSON.stringify({ version: '2026-11-09-v1', agreedAt: Date.now(), ageConfirmedAt: Date.now() })
      )
    })
  }

  async function clearConsent() {
    await mp.evaluate(function () {
      wx.removeStorageSync('sinn_consent_v1')
    })
  }

  try {
    if (mode === 'scroll') {
      // 临时 scroll-top 钩子（取证后移除）：用 Page.setData 驱动长页滚到底，截图证明按钮可见
      await clearConsent()
      await mp.evaluate(function () {
        if (!wx.__origCloudCallFunction) {
          wx.__origCloudCallFunction = wx.cloud.callFunction
          wx.cloud.callFunction = function () {
            return Promise.reject(new Error('automator mock: cloud offline for consent screenshot'))
          }
        }
      })
      await goto(mp, '/pages/consent/consent')
      await mp.evaluate(function () {
        const pages = getCurrentPages()
        pages[pages.length - 1].setData({ step: 2, ageConfirmed: true, termsAccepted: true })
      })
      await sleep(900)
      const consentRectBefore = await btnRect(mp)
      await mp.evaluate(function () {
        getCurrentPages()[getCurrentPages().length - 1].setData({ scrollInto: 'consent-submit' })
      })
      await sleep(1200)
      const consentRectAfter = await btnRect(mp)
      results.push(
        Object.assign({ page: await currentPath(mp), scrollInto: 'consent-submit', rectBefore: consentRectBefore, rectAfter: consentRectAfter }, await shot(mp, 'after-consent-step2-scrolled'))
      )
      await mp.evaluate(function () {
        if (wx.__origCloudCallFunction) {
          wx.cloud.callFunction = wx.__origCloudCallFunction
          wx.__origCloudCallFunction = null
        }
      })

      await seedConsent()
      await goto(mp, '/pages/capture/capture')
      const captureRectBefore = await btnRect(mp)
      await mp.evaluate(function () {
        getCurrentPages()[getCurrentPages().length - 1].setData({ scrollInto: 'capture-bottom' })
      })
      await sleep(1200)
      const captureRectAfter = await btnRect(mp)
      results.push(
        Object.assign({ page: await currentPath(mp), scrollInto: 'capture-bottom', rectBefore: captureRectBefore, rectAfter: captureRectAfter }, await shot(mp, 'after-capture-scrolled'))
      )
    } else if (mode === 'minimal') {
      // 最小修复验证：只改 index.wxml 后重新截图 index
      await seedConsent()
      const p = await goto(mp, '/pages/index/index')
      results.push(Object.assign({ page: p }, await shot(mp, 'after-index-minimal')))
    } else if (mode === 'before') {
      const p = await goto(mp, '/pages/index/index')
      results.push(Object.assign({ page: p }, await shot(mp, 'before-index')))
    } else {
      // 1) index
      await seedConsent()
      results.push(Object.assign({ page: await goto(mp, '/pages/index/index') }, await shot(mp, 'after-index')))

      // 2) consent：清本地同意 + 暂时让 profile 云调用失败（否则服务端已有同意会 redirectTo capture）
      //    -> step1 截图 -> setData 进 step2 截图（滚动到底证据见 mode=scroll）
      await clearConsent()
      await mp.evaluate(function () {
        if (!wx.__origCloudCallFunction) {
          wx.__origCloudCallFunction = wx.cloud.callFunction
          wx.cloud.callFunction = function () {
            return Promise.reject(new Error('automator mock: cloud offline for consent screenshot'))
          }
        }
      })
      const consentTop = await goto(mp, '/pages/consent/consent')
      results.push(Object.assign({ page: consentTop }, await shot(mp, 'after-consent-step1')))
      try {
        await mp.evaluate(function () {
          const pages = getCurrentPages()
          pages[pages.length - 1].setData({ step: 2, ageConfirmed: true, termsAccepted: true })
        })
        await sleep(900)
        results.push(Object.assign({ page: await currentPath(mp) }, await shot(mp, 'after-consent-step2')))
      } catch (err) {
        errors.push('consent step2: ' + err.message)
      }
      await mp.evaluate(function () {
        if (wx.__origCloudCallFunction) {
          wx.cloud.callFunction = wx.__origCloudCallFunction
          wx.__origCloudCallFunction = null
        }
      })

      // 3) capture：需要本地同意记录（否则 redirectTo consent）-> 内容顶部截图（滚动到底证据见 mode=scroll）
      await seedConsent()
      results.push(Object.assign({ page: await goto(mp, '/pages/capture/capture') }, await shot(mp, 'after-capture')))

      // 4) garment：需要 globalData.captureDraft（否则 redirectTo capture）
      await mp.evaluate(function () {
        const app = getApp()
        app.globalData.captureDraft = {
          personAssetIds: ['a_0123456789abcdef01234567'],
          metrics: { heightCm: 170, weightKg: 60, gender: 'unspecified' },
          createdAt: Date.now(),
        }
      })
      results.push(Object.assign({ page: await goto(mp, '/pages/garment/garment') }, await shot(mp, 'after-garment')))

      // 5) result：无有效 taskId，应显示错误卡（证明页面可绘制）
      results.push(
        Object.assign(
          { page: await goto(mp, '/pages/result/result?taskId=t_0123456789abcdef01234567') },
          await shot(mp, 'after-result')
        )
      )

      // 6) profile
      results.push(Object.assign({ page: await goto(mp, '/pages/profile/profile') }, await shot(mp, 'after-profile')))

      // 7) generating：无效 taskId，应转到失败态（有文案/按钮）
      results.push(
        Object.assign(
          { page: await goto(mp, '/pages/generating/generating?taskId=t_0123456789abcdef01234567') },
          await shot(mp, 'after-generating')
        )
      )
    }
  } catch (err) {
    errors.push('fatal: ' + (err && err.stack ? err.stack : String(err)))
  } finally {
    try {
      mp.disconnect()
    } catch (err) {
      /* ignore */
    }
  }

  const output = { mode, ws: WS, results, errors }
  fs.writeFileSync(path.join(OUT_DIR, 'stats-' + mode + '.json'), JSON.stringify(output, null, 2))
  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
