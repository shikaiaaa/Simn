/**
 * tests/unit/pages/capture/photo-adapt.test.js
 * 覆盖 AC-27 端上自动适配：两级压缩策略、EXIF/JPEG 归一、<1024 拒绝、
 * 小图不压缩、压缩失败 5007、两轮后仍超限拒绝、提示文案。
 */
'use strict'

var photoAdapt = require('../../../../miniprogram/services/photo-adapt')

var MB = 1024 * 1024

function info(overrides) {
  var base = {
    path: '/tmp/photo.jpg',
    size: 2 * MB,
    width: 1080,
    height: 1920,
    orientation: 'up',
    type: 'image/jpeg'
  }
  return Object.assign(base, overrides || {})
}

function makeDeps(options) {
  options = options || {}
  var renderResults = (options.renderResults || []).slice()
  var sizes = (options.sizes || []).slice()
  var renderCalls = []
  var deps = {
    now: function () {
      return options.now === undefined ? 1000 : options.now
    },
    renderJpeg: jest.fn(function (src, sourceInfo, target, renderOptions) {
      renderCalls.push({ src: src, info: sourceInfo, target: target, options: renderOptions })
      if (options.renderError) return Promise.reject(new Error('canvas boom'))
      var result = renderResults.length ? renderResults.shift() : null
      if (!result) return Promise.reject(new Error('no fake render result'))
      return Promise.resolve({
        path: result.path === undefined ? '/tmp/out-' + renderCalls.length + '.jpg' : result.path,
        width: result.width === undefined ? target.width : result.width,
        height: result.height === undefined ? target.height : result.height
      })
    }),
    sizeOf: jest.fn(function () {
      if (options.sizeError) return Promise.reject(new Error('stat fail'))
      var next = sizes.length ? sizes.shift() : 4 * MB
      return Promise.resolve(next)
    })
  }
  deps.__renderCalls = renderCalls
  return deps
}

describe('planAdaptive 规划（AC-27 ①②③⑤）', function () {
  test('大图 >4096：需要压缩，第一级目标长边 4096', function () {
    var plan = photoAdapt.planAdaptive(info({ width: 8000, height: 6000, size: 3 * MB }))
    expect(plan.ok).toBe(true)
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('oversized_pixels')
    expect(plan.stage1.maxLongSide).toBe(4096)
    expect(Math.max(plan.stage1.width, plan.stage1.height)).toBe(4096)
  })

  test('长边 <1024：拒绝且提示「分辨率过低，请重拍」', function () {
    var plan = photoAdapt.planAdaptive(info({ width: 800, height: 900 }))
    expect(plan.ok).toBe(false)
    expect(plan.code).toBe('PHOTO_TOO_SMALL')
    expect(plan.apiCode).toBe(3014)
    expect(plan.message).toContain('分辨率过低')
  })

  test('小图（JPG/长边<=4096/<=10MB/方向正）无需压缩', function () {
    var plan = photoAdapt.planAdaptive(info())
    expect(plan.needsCompression).toBe(false)
    expect(plan.stage1.resized).toBe(false)
  })

  test('PNG 需转 JPEG（即使体积/尺寸达标）', function () {
    var plan = photoAdapt.planAdaptive(info({ path: '/tmp/a.png', type: 'image/png' }))
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('not_jpeg')
  })

  test('EXIF 方向非 up 需归一（即使尺寸达标）', function () {
    var plan = photoAdapt.planAdaptive(info({ orientation: 'left' }))
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('exif_orientation')
    expect(Math.max(plan.oriented.width, plan.oriented.height)).toBe(1920)
  })

  test('仅体积 >10MB（长边 4096 内）需压缩且第一级不缩放', function () {
    var plan = photoAdapt.planAdaptive(info({ width: 4096, height: 3000, size: 12 * MB }))
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('oversized_bytes')
    expect(plan.stage1.resized).toBe(false)
  })
})

describe('adaptPhoto 一级压缩（AC-27 ①）', function () {
  test('6000px -> <=4096 JPEG，返回提示文案', function () {
    var deps = makeDeps({ renderResults: [{ width: 4096, height: 2731 }], sizes: [8 * MB] })
    return photoAdapt.adaptPhoto(deps, info({ width: 6000, height: 4000, size: 12 * MB })).then(function (res) {
      expect(res.ok).toBe(true)
      expect(res.processed).toBe(true)
      expect(res.mime).toBe('image/jpeg')
      expect(Math.max(res.width, res.height)).toBeLessThanOrEqual(4096)
      expect(res.bytes).toBeLessThanOrEqual(10 * MB)
      expect(res.attempts.length).toBe(1)
      expect(deps.__renderCalls[0].options.quality).toBe(photoAdapt.LEVEL1_QUALITY)
      expect(photoAdapt.formatCompressionNote(res)).toBe('已自动压缩（长边 4096px / 8.0MB）')
    })
  })

  test('小图直接返回原图、不调用渲染且无提示', function () {
    var deps = makeDeps()
    return photoAdapt.adaptPhoto(deps, info()).then(function (res) {
      expect(res.ok).toBe(true)
      expect(res.processed).toBe(false)
      expect(deps.renderJpeg).not.toHaveBeenCalled()
      expect(photoAdapt.formatCompressionNote(res)).toBe('')
    })
  })
})

describe('adaptPhoto 二级压缩（AC-27 ②）', function () {
  test('一级后仍 >10MB -> 二级压到 3072', function () {
    var deps = makeDeps({
      renderResults: [{ width: 4096, height: 3277 }, { width: 3072, height: 2458 }],
      sizes: [12 * MB, 6 * MB]
    })
    return photoAdapt.adaptPhoto(deps, info({ width: 5000, height: 4000, size: 18 * MB })).then(function (res) {
      expect(res.ok).toBe(true)
      expect(res.attempts.length).toBe(2)
      expect(res.attempts[0].longSide).toBe(4096)
      expect(res.attempts[1].longSide).toBe(3072)
      expect(deps.__renderCalls[1].target).toEqual({ width: 3072, height: 2458 })
      expect(deps.__renderCalls[1].options.quality).toBe(photoAdapt.LEVEL2_QUALITY)
      expect(photoAdapt.formatCompressionNote(res)).toContain('3072')
    })
  })

  test('两级后仍 >10MB -> 拒绝（不得上传原图）', function () {
    var deps = makeDeps({
      renderResults: [{ width: 4096, height: 3277 }, { width: 3072, height: 2458 }],
      sizes: [15 * MB, 11 * MB]
    })
    return photoAdapt.adaptPhoto(deps, info({ width: 5000, height: 4000, size: 18 * MB })).then(function (res) {
      expect(res.ok).toBe(false)
      expect(res.code).toBe('PHOTO_TOO_LARGE')
      expect(res.apiCode).toBe(5007)
      expect(deps.renderJpeg).toHaveBeenCalledTimes(2)
    })
  })
})

describe('adaptPhoto 失败路径（AC-27 ⑥ / 5007）', function () {
  test('渲染抛错 -> PHOTO_PROCESS_FAILED(5007)', function () {
    var deps = makeDeps({ renderError: true })
    return photoAdapt.adaptPhoto(deps, info({ width: 6000, height: 4000, size: 12 * MB })).then(function (res) {
      expect(res.ok).toBe(false)
      expect(res.code).toBe('PHOTO_PROCESS_FAILED')
      expect(res.apiCode).toBe(5007)
      expect(res.message).toBe('照片处理失败，请重试或更换照片')
    })
  })

  test('尺寸探测失败 -> 5007', function () {
    var deps = makeDeps({ renderResults: [{ width: 4096, height: 2731 }], sizeError: true })
    return photoAdapt.adaptPhoto(deps, info({ width: 6000, height: 4000 })).then(function (res) {
      expect(res.ok).toBe(false)
      expect(res.code).toBe('PHOTO_PROCESS_FAILED')
    })
  })

  test('缺少渲染能力 -> 5007（不降级上传原图）', function () {
    return photoAdapt.adaptPhoto({}, info({ width: 6000, height: 4000 })).then(function (res) {
      expect(res.ok).toBe(false)
      expect(res.code).toBe('PHOTO_PROCESS_FAILED')
      expect(res.apiCode).toBe(5007)
    })
  })

  test('渲染返回空路径 -> 5007', function () {
    var deps = makeDeps({ renderResults: [{ path: '', width: 4096, height: 2731 }], sizes: [1 * MB] })
    return photoAdapt.adaptPhoto(deps, info({ width: 6000, height: 4000 })).then(function (res) {
      expect(res.ok).toBe(false)
      expect(res.code).toBe('PHOTO_PROCESS_FAILED')
    })
  })
})

describe('EXIF 与错误码映射（AC-27 ④）', function () {
  test('竖拍 left 方向以 oriented 尺寸渲染并输出 JPEG', function () {
    var deps = makeDeps({ renderResults: [{ width: 3072, height: 4096 }], sizes: [5 * MB] })
    return photoAdapt.adaptPhoto(deps, info({ width: 3000, height: 4000, orientation: 'left', size: 11 * MB })).then(
      function (res) {
        expect(res.ok).toBe(true)
        expect(deps.__renderCalls[0].info.orientation).toBe('left')
        expect(deps.__renderCalls[0].target).toEqual({ width: 4000, height: 3000 })
        expect(res.mime).toBe('image/jpeg')
      }
    )
  })

  test('服务端兜底错误码 3014 与 5007 文案映射', function () {
    expect(photoAdapt.getPhotoErrorMeta('PHOTO_TOO_SMALL').apiCode).toBe(3014)
    expect(photoAdapt.getPhotoErrorMeta('PHOTO_TOO_SMALL').message).toBe('分辨率过低，请重拍')
    expect(photoAdapt.getPhotoErrorMeta('PHOTO_PROCESS_FAILED').apiCode).toBe(5007)
    expect(photoAdapt.getPhotoErrorMeta('PHOTO_PROCESS_FAILED').message).toBe('照片处理失败，请重试或更换照片')
  })
})

/* ------------------- 供应商规格压缩（SPEC v0.11 §B.2 / AC-29） ------------------- */

describe('planVendorSpec 规划（AC-29 ①②③④）', function () {
  test('6MB/4000px JPEG：需要压缩且原因 vendor_limit', function () {
    var plan = photoAdapt.planVendorSpec(info({ width: 4000, height: 3000, size: 6 * MB }))
    expect(plan.ok).toBe(true)
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('oversized_bytes')
    expect(plan.reason).toBe('vendor_limit')
  })

  test('>4096px 或 >10MB：原因 upload_limit', function () {
    expect(photoAdapt.planVendorSpec(info({ width: 6000, height: 4000, size: 3 * MB })).reason).toBe('upload_limit')
    expect(photoAdapt.planVendorSpec(info({ width: 4000, height: 3000, size: 12 * MB })).reason).toBe(
      'upload_limit'
    )
  })

  test('JPG/≤5MB/≤4096：无需压缩', function () {
    var plan = photoAdapt.planVendorSpec(info({ width: 2048, height: 1536, size: 2 * MB }))
    expect(plan.needsCompression).toBe(false)
    expect(plan.reason).toBe(null)
  })

  test('长边 <1024：拒绝 3014（不放大）', function () {
    var plan = photoAdapt.planVendorSpec(info({ width: 900, height: 900 }))
    expect(plan.ok).toBe(false)
    expect(plan.apiCode).toBe(3014)
    expect(plan.message).toContain('分辨率过低')
  })

  test('PNG 小图：需要压缩（not_jpeg，vendor_limit）', function () {
    var plan = photoAdapt.planVendorSpec(info({ path: '/tmp/a.png', type: 'image/png' }))
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('not_jpeg')
    expect(plan.reason).toBe('vendor_limit')
  })

  test('EXIF 方向非 up：需要压缩（exif_orientation）', function () {
    var plan = photoAdapt.planVendorSpec(info({ orientation: 'left' }))
    expect(plan.needsCompression).toBe(true)
    expect(plan.reasons).toContain('exif_orientation')
  })
})

describe('compressToVendorSpec 档位推进（AC-29 ①②）', function () {
  function renderSlots(count) {
    var list = []
    for (var i = 0; i < count; i += 1) list.push({})
    return list
  }

  test('6MB/4000px：先降质量到 0.85 达标即停，输出 JPG 且提示供应商限制', function () {
    var deps = makeDeps({ renderResults: renderSlots(2), sizes: [6 * MB, 5 * MB] })
    return photoAdapt
      .compressToVendorSpec(deps, info({ width: 4000, height: 3000, size: 6 * MB }))
      .then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.processed).toBe(true)
        expect(res.mime).toBe('image/jpeg')
        expect(res.quality).toBe(0.85)
        expect(res.sizeStep).toBe(4096)
        expect(res.bytes).toBe(5 * MB)
        expect(res.attempts.length).toBe(2)
        expect(deps.__renderCalls[0].options.quality).toBe(0.92)
        expect(deps.__renderCalls[1].options.quality).toBe(0.85)
        expect(photoAdapt.formatVendorCompressionNote(res)).toBe('已自动优化照片（供应商限制）')
      })
  })

  test('12MB/6000px：质量档用尽后降尺寸档（4096→3072）', function () {
    // 4096 档的 7 个质量档都 >5MB，随后降到 3072 档 q0.92 达标。
    var sizes = [9 * MB, 8 * MB, 7.5 * MB, 7 * MB, 6.5 * MB, 6 * MB, 5.5 * MB, 4 * MB]
    var deps = makeDeps({ renderResults: renderSlots(8, 4096, 2731), sizes: sizes })
    return photoAdapt
      .compressToVendorSpec(deps, info({ width: 6000, height: 4000, size: 12 * MB }))
      .then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.sizeStep).toBe(3072)
        expect(res.quality).toBe(0.92)
        expect(res.attempts.length).toBe(8)
        expect(res.attempts[0].sizeStep).toBe(4096)
        expect(res.attempts[6].sizeStep).toBe(4096)
        expect(res.attempts[7].sizeStep).toBe(3072)
        expect(photoAdapt.formatVendorCompressionNote(res)).toContain('已自动压缩照片')
        expect(photoAdapt.formatVendorCompressionNote(res)).toContain('6000→3072')
        expect(photoAdapt.formatVendorCompressionNote(res)).toContain('12.0')
        expect(photoAdapt.formatVendorCompressionNote(res)).toContain('4.0MB')
      })
  })

  test('全部档位用尽仍 >5MB -> 5007 且不返回原图', function () {
    var sizes = []
    for (var i = 0; i < 28; i += 1) sizes.push(6 * MB)
    var deps = makeDeps({ renderResults: renderSlots(28, 4096, 2731), sizes: sizes })
    return photoAdapt
      .compressToVendorSpec(deps, info({ width: 6000, height: 4000, size: 12 * MB }))
      .then(function (res) {
        expect(res.ok).toBe(false)
        expect(res.apiCode).toBe(5007)
        expect(res.reason).toBe('vendor_spec_exhausted')
        expect(deps.renderJpeg).toHaveBeenCalledTimes(28)
        expect(res.path).toBeUndefined()
      })
  })

  test('小图不压缩：原路径/原字节直接通过，不调用渲染', function () {
    var deps = makeDeps()
    return photoAdapt
      .compressToVendorSpec(deps, info({ width: 2048, height: 1536, size: 2 * MB }))
      .then(function (res) {
        expect(res.ok).toBe(true)
        expect(res.processed).toBe(false)
        expect(res.path).toBe('/tmp/photo.jpg')
        expect(res.bytes).toBe(2 * MB)
        expect(res.quality).toBe(null)
        expect(deps.renderJpeg).not.toHaveBeenCalled()
        expect(photoAdapt.formatVendorCompressionNote(res)).toBe('')
      })
  })

  test('渲染失败 -> PHOTO_PROCESS_FAILED 5007', function () {
    var deps = makeDeps({ renderError: true })
    return photoAdapt
      .compressToVendorSpec(deps, info({ width: 6000, height: 4000, size: 12 * MB }))
      .then(function (res) {
        expect(res.ok).toBe(false)
        expect(res.code).toBe('PHOTO_PROCESS_FAILED')
        expect(res.apiCode).toBe(5007)
      })
  })
})

describe('assertVendorSpec 上传前二次断言（AC-29 ③）', function () {
  test('JPG/≤4096/≤5MB 通过', function () {
    expect(photoAdapt.assertVendorSpec({ path: '/tmp/a.jpg', bytes: 5 * MB, width: 4096, height: 3000 })).toEqual({
      ok: true
    })
  })

  test('非 JPG -> 5007 且原因 not_jpeg', function () {
    var res = photoAdapt.assertVendorSpec({ path: '/tmp/a.png', bytes: 1 * MB, width: 1024, height: 1024 })
    expect(res.ok).toBe(false)
    expect(res.apiCode).toBe(5007)
    expect(res.reasons).toContain('not_jpeg')
  })

  test('>5MB 或 >4096 长边 -> 5007', function () {
    var big = photoAdapt.assertVendorSpec({ path: '/tmp/a.jpg', bytes: 6 * MB, width: 4000, height: 3000 })
    expect(big.ok).toBe(false)
    expect(big.reasons).toContain('oversized_bytes')
    var wide = photoAdapt.assertVendorSpec({ path: '/tmp/a.jpg', bytes: 2 * MB, width: 5000, height: 3000 })
    expect(wide.ok).toBe(false)
    expect(wide.reasons).toContain('oversized_pixels')
  })
})
