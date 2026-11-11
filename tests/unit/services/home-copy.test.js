/**
 * tests/unit/services/home-copy.test.js —— DEV-0001-02 工程骨架与首页静态断言（L1）。
 *
 * 断言内容（不依赖开发者工具）：
 * - app.json 7 页顺序与 SPEC §A 路由表一致，logs 已移除，skyline/glass-easel/lazyCodeLoading 保留；
 * - 7 页四件套齐全（页面路径小写 + `-`）；
 * - 首页四入口与 AC-23 禁入口/禁词；
 * - 页面不裸调 wx.cloud.callFunction（统一走 services/api.js）。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')
const MP = path.join(ROOT, 'miniprogram')

function read(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8')
}

const EXPECTED_PAGES = [
  'pages/index/index',
  'pages/consent/consent',
  'pages/capture/capture',
  'pages/garment/garment',
  'pages/generating/generating',
  'pages/result/result',
  'pages/profile/profile'
]

describe('app.json 路由与渲染配置', () => {
  const app = JSON.parse(read('app.json'))

  test('pages 与 SPEC §A 顺序一致，且不再包含 logs', () => {
    expect(app.pages).toEqual(EXPECTED_PAGES)
    expect(app.pages).not.toContain('pages/logs/logs')
  })

  test('保持 skyline + glass-easel + lazyCodeLoading，无 tabBar/分包', () => {
    expect(app.renderer).toBe('skyline')
    expect(app.componentFramework).toBe('glass-easel')
    expect(app.lazyCodeLoading).toBe('requiredComponents')
    expect(app.rendererOptions.skyline.sdkVersionBegin).toBe('3.0.0')
    expect(app.window.navigationStyle).toBe('custom')
    expect(app.tabBar).toBeUndefined()
    expect(app.subPackages).toBeUndefined()
  })
})

describe('7 页四件套与静态禁入口', () => {
  test.each(EXPECTED_PAGES)('%s 四件套齐全', (page) => {
    const base = path.join(MP, page)
    ;['.js', '.wxml', '.wxss', '.json'].forEach((ext) => {
      expect(fs.existsSync(base + ext)).toBe(true)
    })
  })

  test('页面路径均为小写 + 连字符（SPEC 门禁）', () => {
    EXPECTED_PAGES.forEach((page) => {
      expect(page).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)+$/)
    })
  })

  test('首页四入口文案：开始试穿 / 继续上次生成 / 我的 / 功能说明', () => {
    const wxml = read('pages/index/index.wxml')
    expect(wxml).toContain('开始试穿')
    expect(wxml).toContain('继续上次生成')
    expect(wxml).toContain('我的')
    expect(wxml).toContain('2D 虚拟试穿')
  })

  test('AC-23：首页无导购/分享/保存/3D/形象库入口与价格类文案', () => {
    const text = read('pages/index/index.wxml') + read('pages/index/index.js')
    const forbidden = [/分享/, /保存相册/, /价格/, /购买/, /下单/, /商家/, /3D/, /形象库/, /支付/, /保证合身/, /精准/, /准确/, /适合你/]
    forbidden.forEach((re) => expect(text).not.toMatch(re))
  })
})

describe('页面不裸调云函数（统一封装约束）', () => {
  test('首页通过 services/api.js 调用 profile，未直接使用 wx.cloud.callFunction', () => {
    const js = read('pages/index/index.js')
    expect(js).toContain("require('../../services/api')")
    expect(js).toMatch(/api\s*\.call\('sinn-account', 'profile'/)
    expect(js).not.toContain('wx.cloud.callFunction')
  })

  test('API 封装暴露统一入口与错误码表', () => {
    const api = require('../../../miniprogram/services/api')
    expect(typeof api.call).toBe('function')
    expect(typeof api.parseEnvelope).toBe('function')
    expect(api.ERROR_CODES[1003].name).toBe('E_CONSENT_REQUIRED')
    expect(api.ERROR_CODES[5004].httpStatus).toBe(404)
  })
})
