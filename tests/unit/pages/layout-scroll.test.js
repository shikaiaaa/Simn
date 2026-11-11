/**
 * tests/unit/pages/layout-scroll.test.js
 * DEF-0009：result / profile / generating 三页统一为 .screen + scroll-view 结构，
 * navigation-bar 在 scroll-view 外；用于防止长页内容被裁且不可滚动。
 */
'use strict'

var fs = require('fs')
var path = require('path')

var ROOT = path.join(__dirname, '..', '..', '..', 'miniprogram')
var PAGES = {
  result: path.join(ROOT, 'pages', 'result', 'result.wxml'),
  profile: path.join(ROOT, 'pages', 'profile', 'profile.wxml'),
  generating: path.join(ROOT, 'pages', 'generating', 'generating.wxml')
}

function readWxml(key) {
  return fs.readFileSync(PAGES[key], 'utf8')
}

describe('DEF-0009：三页滚动容器结构', function () {
  Object.keys(PAGES).forEach(function (key) {
    test(key + '.wxml 使用 .screen + scroll-view.page.page-scroll', function () {
      var wxml = readWxml(key)
      expect(wxml).toContain('<view class="screen">')
      expect(wxml).toContain('<scroll-view class="page page-scroll" scroll-y>')
      expect(wxml).not.toMatch(/<view class="page">/)
      // screen 开标签必须在 navigation-bar 之前，scroll-view 之后必须闭合
      expect(wxml.indexOf('<view class="screen">')).toBeLessThan(wxml.indexOf('<navigation-bar'))
      expect(wxml.indexOf('</scroll-view>')).toBeGreaterThan(wxml.indexOf('<scroll-view'))
    })

    test(key + '.wxml 的 navigation-bar 在 scroll-view 外', function () {
      var wxml = readWxml(key)
      var nav = wxml.indexOf('<navigation-bar')
      var scroll = wxml.indexOf('<scroll-view')
      var scrollEnd = wxml.indexOf('</scroll-view>')
      expect(nav).toBeGreaterThan(-1)
      expect(nav).toBeLessThan(scroll)
      // 导航栏标签不落在 scroll-view 开闭区间内
      expect(nav < scroll || nav > scrollEnd).toBe(true)
    })

    test(key + '.wxml 的 page-body 包裹在 scroll-view 内', function () {
      var wxml = readWxml(key)
      var scroll = wxml.indexOf('<scroll-view')
      var scrollEnd = wxml.indexOf('</scroll-view>')
      var body = wxml.indexOf('<view class="page-body">')
      expect(body).toBeGreaterThan(scroll)
      expect(body).toBeLessThan(scrollEnd)
    })
  })
})

describe('DEF-0009：result 页关键内容与手势容器', function () {
  test('zoom-view 与 AI 标识都在滚动容器内且 AI 标识在 zoom-view 之外', function () {
    var wxml = readWxml('result')
    var scroll = wxml.indexOf('<scroll-view')
    var scrollEnd = wxml.indexOf('</scroll-view>')
    var zoom = wxml.indexOf('<zoom-view')
    var badge = wxml.indexOf('result-ai-badge')
    expect(zoom).toBeGreaterThan(scroll)
    expect(zoom).toBeLessThan(scrollEnd)
    expect(badge).toBeGreaterThan(zoom)
    // AI 标识位于 result-stage 内、不随 zoom-view 内部裁切
    expect(wxml).toContain('<view class="result-ai-badge">')
  })

  test('删除/返回按钮与 loading/error 分支都在 scroll-view 内可达', function () {
    var wxml = readWxml('result')
    var scrollEnd = wxml.indexOf('</scroll-view>')
    expect(wxml.indexOf('删除本次结果')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onDeleteTap')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onBackHome')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('wx:if="{{loading}}"')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('wx:elif="{{errorText}}"')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('result-actions')).toBeLessThan(scrollEnd)
  })
})

describe('DEF-0009：profile / generating 关键内容可达', function () {
  test('profile 的删除全部/撤回/返回按钮在 scroll-view 内', function () {
    var wxml = readWxml('profile')
    var scrollEnd = wxml.indexOf('</scroll-view>')
    expect(wxml.indexOf('onDeleteAll')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onRevokeConsent')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onBackHome')).toBeLessThan(scrollEnd)
  })

  test('generating 的取消/重试/返回在 scroll-view 内', function () {
    var wxml = readWxml('generating')
    var scrollEnd = wxml.indexOf('</scroll-view>')
    expect(wxml.indexOf('onCancel')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onRetry')).toBeLessThan(scrollEnd)
    expect(wxml.indexOf('onBackHome')).toBeLessThan(scrollEnd)
  })
})
