/**
 * tests/unit/pages/capture/precheck-l0.test.js
 * 覆盖：端上 L0 预检（JPG/PNG、<=10MB、长边 1024-4096、长宽比、EXIF）与 capture 表单校验。
 * AC-1 / AC-26 / AC-2 服务端预检计时口径。
 */
'use strict'

var precheck = require('../../../../miniprogram/services/precheck')

function meta(overrides) {
  var base = {
    path: '/tmp/photo.jpg',
    size: 2 * 1024 * 1024,
    width: 1080,
    height: 1920,
    type: 'image/jpeg',
    orientation: 'up'
  }
  return Object.assign(base, overrides || {})
}

describe('端上 L0 预检', function () {
  test('JPG 竖版全身照通过', function () {
    var result = precheck.validateImageL0(meta())
    expect(result.ok).toBe(true)
    expect(result.meta.mime).toBe('image/jpeg')
    expect(result.meta.orientation).toBe('up')
  })

  test('PNG 通过且 MIME 可识别', function () {
    var result = precheck.validateImageL0(meta({ path: '/tmp/photo.png', type: 'image/png' }))
    expect(result.ok).toBe(true)
    expect(result.meta.mime).toBe('image/png')
  })

  test('非 JPG/PNG 拦截（L0_FORMAT）', function () {
    var result = precheck.validateImageL0(meta({ path: '/tmp/photo.webp', type: 'image/webp' }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_FORMAT')
  })

  test('超过 10MB 拦截（L0_BYTES）', function () {
    var result = precheck.validateImageL0(meta({ size: 10 * 1024 * 1024 + 1 }))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('L0_BYTES')
    expect(result.message).toContain('10MB')
  })

  test('长边小于 1024 拦截（L0_SIZE_MIN）', function () {
    var result = precheck.validateImageL0(meta({ width: 800, height: 900 }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_SIZE_MIN')
  })

  test('长边大于 4096 拦截（L0_SIZE_MAX）', function () {
    var result = precheck.validateImageL0(meta({ width: 5000, height: 6000 }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_SIZE_MAX')
  })

  test('长宽比超过 3:1 拦截（L0_ASPECT）', function () {
    var result = precheck.validateImageL0(meta({ width: 4000, height: 1000 }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_ASPECT')
  })

  test('尺寸缺失拦截（L0_DIMENSIONS）', function () {
    var result = precheck.validateImageL0(meta({ width: 0, height: 0 }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_DIMENSIONS')
  })

  test('未知 EXIF 方向拦截（L0_EXIF）', function () {
    var result = precheck.validateImageL0(meta({ orientation: 'weird-orientation' }))
    expect(result.ok).toBe(false)
    expect(result.reasons.map(function (r) { return r.code })).toContain('L0_EXIF')
  })

  test('L0 为同步纯函数：不返回 Promise 且耗时远低于 300ms', function () {
    var started = Date.now()
    var result = precheck.validateImageL0(meta())
    var elapsed = Date.now() - started
    expect(result.then).toBeUndefined()
    expect(elapsed).toBeLessThan(300)
  })

  test('inferMime 从路径/类型推断', function () {
    expect(precheck.inferMime('/a/b.JPG')).toBe('image/jpeg')
    expect(precheck.inferMime('/a/b.jpeg')).toBe('image/jpeg')
    expect(precheck.inferMime('/a/b.png')).toBe('image/png')
    expect(precheck.inferMime('/a/b.gif')).toBe('')
  })
})

describe('capture 表单校验（AC-1 / AC-26）', function () {
  function form(overrides) {
    var base = {
      photos: [{ path: '/tmp/a.jpg' }],
      heightCm: '175',
      weightKg: '70.5',
      gender: 'unspecified',
      chestCm: '',
      waistCm: '',
      hipCm: ''
    }
    return Object.assign(base, overrides || {})
  }

  test('完整合法表单通过，性别默认 unspecified、三围不出现', function () {
    var check = precheck.validateCaptureForm(form({ gender: '' }))
    expect(check.ok).toBe(true)
    expect(check.normalized.metrics.heightCm).toBe(175)
    expect(check.normalized.metrics.weightKg).toBe(70.5)
    expect(check.normalized.metrics.gender).toBe('unspecified')
    expect(check.normalized.metrics.chestCm).toBeUndefined()
  })

  test('缺照片/缺身高/缺体重给出具体缺失项', function () {
    var check = precheck.validateCaptureForm({ photos: [], heightCm: '', weightKg: '' })
    expect(check.ok).toBe(false)
    var fields = check.errors.map(function (e) { return e.field })
    expect(fields).toContain('photos')
    expect(fields).toContain('heightCm')
    expect(fields).toContain('weightKg')
  })

  test('身高非整数/越界拦截', function () {
    expect(precheck.validateCaptureForm(form({ heightCm: '175.5' })).errors.map(function (e) { return e.code })).toContain('HEIGHT_RANGE')
    expect(precheck.validateCaptureForm(form({ heightCm: '99' })).errors.map(function (e) { return e.code })).toContain('HEIGHT_RANGE')
    expect(precheck.validateCaptureForm(form({ heightCm: '251' })).errors.map(function (e) { return e.code })).toContain('HEIGHT_RANGE')
  })

  test('体重超过 1 位小数/越界拦截', function () {
    expect(precheck.validateCaptureForm(form({ weightKg: '70.55' })).errors.map(function (e) { return e.code })).toContain('WEIGHT_RANGE')
    expect(precheck.validateCaptureForm(form({ weightKg: '24.9' })).errors.map(function (e) { return e.code })).toContain('WEIGHT_RANGE')
  })

  test('三围选填：填了才校验 40–200 且最多 1 位小数', function () {
    expect(precheck.validateCaptureForm(form({ chestCm: '92', waistCm: '78', hipCm: '96' })).ok).toBe(true)
    expect(precheck.validateCaptureForm(form({ chestCm: '39' })).errors.map(function (e) { return e.code })).toContain('CIRCUMFERENCE_RANGE')
    expect(precheck.validateCaptureForm(form({ waistCm: '78.55' })).errors.map(function (e) { return e.code })).toContain('CIRCUMFERENCE_RANGE')
  })

  test('性别仅接受三个枚举值', function () {
    var bad = precheck.validateCaptureForm(form({ gender: 'other' }))
    expect(bad.ok).toBe(false)
    expect(bad.errors.map(function (e) { return e.code })).toContain('GENDER_INVALID')
    ;['male', 'female', 'unspecified'].forEach(function (gender) {
      expect(precheck.validateCaptureForm(form({ gender: gender })).ok).toBe(true)
    })
  })

  test('人像超过 3 张拦截', function () {
    var photos = [{ path: '/a' }, { path: '/b' }, { path: '/c' }, { path: '/d' }]
    var check = precheck.validateCaptureForm(form({ photos: photos }))
    expect(check.ok).toBe(false)
    expect(check.errors.map(function (e) { return e.code })).toContain('PHOTOS_LIMIT')
  })

  test('错误文案去重且中文可读', function () {
    var check = precheck.validateCaptureForm({ photos: [], heightCm: '999', weightKg: '' })
    var text = precheck.buildFormErrorText(check.errors)
    expect(text).toContain('请至少添加 1 张人像照片')
    expect(text).toContain('身高需为 100–250 的整数')
    expect(text.split('；').length).toBeGreaterThan(1)
  })

  test('garment 表单必须且仅需一张衣服照片', function () {
    expect(precheck.validateGarmentForm({ photo: null }).ok).toBe(false)
    expect(precheck.validateGarmentForm({ photo: { path: '/g.jpg' } }).ok).toBe(true)
  })

  test('AC-2 预检计时口径：<=5000ms 视为达标', function () {
    expect(precheck.isPrecheckWithinTarget(4200, 5000)).toBe(true)
    expect(precheck.isPrecheckWithinTarget(5001, 5000)).toBe(false)
    expect(precheck.isPrecheckWithinTarget(-1, 5000)).toBe(false)
  })
})
