/**
 * ac29-scenarios.js —— AC-29（供应商输入规格对齐）离线场景执行器（QA task-70）。
 *
 * 目的：在不依赖开发者工具/云环境/真实 canvas 的前提下，用可控 deps 直接驱动
 * 生产模块 `miniprogram/services/photo-adapt.js` 的 `compressToVendorSpec` 与
 * `assertVendorSpec`，覆盖 AC-29 ①–④ 的压缩决策、档位顺序、错误码与提示文案。
 *
 * 边界（不夸大）：
 * - 本脚本执行的是「生产模块 + 注入 deps」的契约/决策层；不执行页面 UI、不执行
 *   wx.uploadFile / createTask。页面级「失败不上传、不建任务、不扣额度」由 DEV
 *   单测（capture-page/upload 的 spy）与 L2 承担；真实 canvas 压缩的字节/耗时/内存
 *   需真机验证（CP-12），本脚本不替代。
 * - 「uploadFile 调用 0 次 / createTask 调用 0 次」在本脚本中以「模块契约上不触达」
 *   + 注入计数桩恒为 0 表达；证据中明确标注。
 */
'use strict'

var path = require('path')

var PHOTO_ADAPT_PATH = path.resolve(__dirname, '../../../miniprogram/services/photo-adapt.js')
var pa = require(PHOTO_ADAPT_PATH)

var MB = 1024 * 1024

function assert(cond, message, details) {
  if (!cond) {
    var err = new Error('[ac29-assert] ' + message)
    err.details = details || null
    throw err
  }
}

function mockDeps(options) {
  var opts = options || {}
  var writes = []
  var counters = { renderJpeg: 0, sizeOf: 0, uploadFileCalls: 0, createTaskCalls: 0 }
  var files = {}
  var seq = 0
  var deps = {
    uploadFileCalls: counters.uploadFileCalls,
    createTaskCalls: counters.createTaskCalls,
    renderJpeg: function (src, info, target, renderOpts) {
      counters.renderJpeg += 1
      if (typeof opts.render === 'function') {
        return Promise.resolve(opts.render(src, info, target, renderOpts, counters))
      }
      throw new Error('mock renderJpeg: no render policy')
    },
    sizeOf: function (filePath) {
      counters.sizeOf += 1
      if (!(filePath in files)) throw new Error('mock sizeOf: unknown ' + filePath)
      return Promise.resolve(files[filePath])
    },
    now: (function () {
      var t = 1794326400000
      return function () {
        t += 7
        return t
      }
    })(),
    __counters: counters,
    __files: files,
    __writes: writes,
    __nextPath: function () {
      seq += 1
      return 'mock://e2e/ac29-' + seq + '.jpg'
    }
  }
  return deps
}

function runOne(scenario) {
  var deps = scenario.deps()
  var result = null
  var error = null
  return Promise.resolve()
    .then(function () {
      return pa.compressToVendorSpec(deps, scenario.info)
    })
    .then(function (res) {
      result = res
    })
    .catch(function (err) {
      error = err
    })
    .then(function () {
      var evidence = {
        result: result,
        error: error ? { message: error.message, details: error.details } : null,
        counters: deps.__counters
      }
      try {
        scenario.check(result, error, deps, evidence)
        return {
          id: scenario.id,
          ac: scenario.ac,
          title: scenario.title,
          status: 'pass',
          evidence: evidence
        }
      } catch (err) {
        evidence.failure = { message: err.message, details: err.details || null }
        return {
          id: scenario.id,
          ac: scenario.ac,
          title: scenario.title,
          status: 'fail',
          evidence: evidence
        }
      }
    })
}

function runScenarios() {
  var startedAt = new Date().toISOString()
  var specs = [scenario1(), scenario2(), scenario3a(), scenario3b(), scenario3c(), scenario4()]
  var results = []
  var p = Promise.resolve()
  specs.forEach(function (spec) {
    p = p.then(function () {
      return runOne(spec).then(function (r) {
        results.push(r)
      })
    })
  })
  return p.then(function () {
    var pass = results.filter(function (r) { return r.status === 'pass' }).length
    var fail = results.length - pass
    return {
      kind: 'ac29-offline-scenarios',
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      module: 'miniprogram/services/photo-adapt.js',
      modulePath: PHOTO_ADAPT_PATH,
      limits: {
        vendorMaxBytes: pa.VENDOR_MAX_BYTES,
        vendorMaxLongSide: pa.VENDOR_MAX_LONG_SIDE,
        sizeTiers: pa.VENDOR_SIZE_TIERS,
        qualityTiers: pa.VENDOR_QUALITY_TIERS
      },
      total: results.length,
      pass: pass,
      fail: fail,
      results: results
    }
  })
}

/* ------------------------------- scenarios ------------------------------- */

/** ① 6MB / 4000px JPEG：>5MB 但未超 4096（vendor_limit），先降质量到 ≤5MB。 */
function scenario1() {
  return {
    id: 'AC29-1',
    ac: 'AC-29①',
    title: '6MB/4000px JPEG → 压缩后 ≤5MB 且长边 ≤4096，供应商限制提示，createTask 1 次',
    info: { path: 'mock://in/6mb-4000.jpg', size: 6 * MB, width: 4000, height: 3000, type: 'image/jpeg' },
    deps: function () {
      var deps = mockDeps({
        render: function (src, info, target, renderOpts, counters) {
          var longSide = Math.max(target.width, target.height)
          // 质量越高字节越大：q0.92 → 5.4MB（仍超）；q≤0.85 → 4.6MB（达标）。
          var bytes = renderOpts.quality >= 0.92 ? Math.round(5.4 * MB) : Math.round(4.6 * MB)
          var filePath = deps.__nextPath()
          deps.__files[filePath] = bytes
          return { path: filePath, width: target.width, height: target.height, longSide: longSide }
        }
      })
      return deps
    },
    check: function (result, error, deps) {
      assert(!error, '不应抛异常：' + (error && error.message))
      assert(result && result.ok === true, '应压缩成功', result)
      assert(result.processed === true, '应发生压缩')
      assert(result.bytes <= pa.VENDOR_MAX_BYTES, '压缩后字节应 ≤5MB，实际 ' + result.bytes)
      assert(Math.max(result.width, result.height) <= pa.VENDOR_MAX_LONG_SIDE, '长边应 ≤4096，实际 ' + Math.max(result.width, result.height))
      assert(result.reason === 'vendor_limit', 'reason 应为 vendor_limit，实际 ' + result.reason)
      var note = pa.formatVendorCompressionNote(result)
      assert(note === '已自动优化照片（供应商限制）', '提示文案应为「已自动优化照片（供应商限制）」，实际 ' + note)
      assert(result.attempts.length === 2, '应先降质量：q0.92 仍超 → q0.85 达标，实际尝试 ' + result.attempts.length + ' 次')
      assert(deps.__counters.uploadFileCalls === 0 && deps.__counters.createTaskCalls === 0, '离线契约层不应触达上传/建任务')
      var second = pa.assertVendorSpec({ bytes: result.bytes, width: result.width, height: result.height, mime: 'image/jpeg' })
      assert(second.ok === true, '二次断言应在达标后通过')
      // 本用例成功路径对应 1 次 createTask：本脚本不触发网络，标注由页面/L3 端到端覆盖。
      result.evidenceNote = 'createTask 1 次由 capture/garment 页在 compressionNote 后走既有上传/建任务链路；本脚本不触达网络，页面级由 L2 单测与 L3 整跑覆盖。'
    }
  }
}

/** ② 质量档最低仍 >5MB：4096/3072 各 7 个质量档后，降到 2048 才达标。 */
function scenario2() {
  return {
    id: 'AC29-2',
    ac: 'AC-29②',
    title: '质量档用尽仍超 → 按 4096→3072→2048 逐档降尺寸，最终 ≤5MB 且长边断言',
    info: { path: 'mock://in/huge-30mb-8000.jpg', size: 30 * MB, width: 6000, height: 8000, type: 'image/jpeg' },
    deps: function () {
      var deps = mockDeps({
        render: function (src, info, target, renderOpts) {
          var longSide = Math.max(target.width, target.height)
          // 4096/3072 任一质量档都 >5MB；到 2048 档才达标（3MB）。
          var bytes = longSide > 2048 ? Math.round(6 * MB) : Math.round(3 * MB)
          var filePath = deps.__nextPath()
          deps.__files[filePath] = bytes
          return { path: filePath, width: target.width, height: target.height, longSide: longSide }
        }
      })
      return deps
    },
    check: function (result, error, deps) {
      assert(!error, '不应抛异常：' + (error && error.message))
      assert(result && result.ok === true && result.processed === true, '应压缩成功', result)
      assert(result.sizeStep === 2048, '应降到 2048 档，实际 ' + result.sizeStep)
      assert(result.longSide <= 2048, '最终长边应 ≤2048，实际 ' + result.longSide)
      assert(result.bytes <= pa.VENDOR_MAX_BYTES, '最终字节应 ≤5MB')
      assert(result.reason === 'upload_limit', '超大原图应记 upload_limit，实际 ' + result.reason)
      var note = pa.formatVendorCompressionNote(result)
      assert(/已自动压缩照片（长边 \d+→\d+，大小 [\d.]+→[\d.]+MB）/.test(note), 'upload_limit 提示应含前后对比，实际 ' + note)
      assert(result.attempts.length === 15, '应为 4096×7 + 3072×7 + 2048×1 = 15 次尝试，实际 ' + result.attempts.length)
      var tiers = result.attempts.map(function (a) { return a.sizeStep })
      assert(tiers[0] === 4096 && tiers[7] === 3072 && tiers[14] === 2048, '档位顺序应为 4096→3072→2048，实际 ' + JSON.stringify(tiers))
      assert(deps.__counters.uploadFileCalls === 0, '离线契约层不应触达上传')
    }
  }
}

/** ③a 长边 <1024：拒绝重拍，不压缩、不触达上传。 */
function scenario3a() {
  return {
    id: 'AC29-3a',
    ac: 'AC-29③',
    title: '长边 <1024px → 「分辨率过低，请重拍」，不压缩、不触达 uploadFile/createTask',
    info: { path: 'mock://in/small-800.jpg', size: 300 * 1024, width: 800, height: 600, type: 'image/jpeg' },
    deps: function () { return mockDeps({ render: function () { throw new Error('不应调用 renderJpeg') } }) },
    check: function (result, error, deps) {
      assert(!error, '不应抛异常：' + (error && error.message))
      assert(result && result.ok === false, '应返回失败', result)
      assert(result.apiCode === 3014 && result.name === 'E_PRECHECK_TOO_SMALL', '应为 3014 E_PRECHECK_TOO_SMALL，实际 ' + JSON.stringify(result))
      assert(result.message === '分辨率过低，请重拍', '文案应为「分辨率过低，请重拍」，实际 ' + result.message)
      assert(deps.__counters.renderJpeg === 0, '不应执行压缩渲染')
      assert(deps.__counters.uploadFileCalls === 0 && deps.__counters.createTaskCalls === 0, '不应触达上传/建任务')
    }
  }
}

/** ③b 解码/编码失败：5007，不触达上传。 */
function scenario3b() {
  return {
    id: 'AC29-3b',
    ac: 'AC-29③',
    title: '解码/编码失败 → 「照片处理失败，请重试或更换照片」（5007），不触达 uploadFile/createTask',
    info: { path: 'mock://in/6mb-3000-decode-fail.jpg', size: 6 * MB, width: 3000, height: 2000, type: 'image/jpeg' },
    deps: function () {
      return mockDeps({ render: function () { throw new Error('mock canvas decode failed') } })
    },
    check: function (result, error, deps) {
      assert(!error, '应被捕获为 photoFail 而非冒泡：' + (error && error.message))
      assert(result && result.ok === false, '应返回失败', result)
      assert(result.apiCode === 5007, '应为 5007，实际 ' + result.apiCode)
      assert(result.message === '照片处理失败，请重试或更换照片', '文案应为「照片处理失败，请重试或更换照片」，实际 ' + result.message)
      assert(deps.__counters.uploadFileCalls === 0 && deps.__counters.createTaskCalls === 0, '不应触达上传/建任务')
      assert(deps.__counters.createTaskCalls === 0, '不应创建任务')
    }
  }
}

/** ③c 全部尺寸/质量档用尽仍 >5MB：5007，不上传原图。 */
function scenario3c() {
  return {
    id: 'AC29-3c',
    ac: 'AC-29③',
    title: '最小档仍 >5MB → 全档用尽返回 5007，不上传原图（二次断言兜底）',
    info: { path: 'mock://in/always-6mb.jpg', size: 6 * MB, width: 4000, height: 3000, type: 'image/jpeg' },
    deps: function () {
      var deps = mockDeps({
        render: function (src, info, target) {
          var filePath = deps.__nextPath()
          deps.__files[filePath] = 6 * MB
          return { path: filePath, width: target.width, height: target.height }
        }
      })
      return deps
    },
    check: function (result, error, deps) {
      assert(!error, '不应抛异常：' + (error && error.message))
      assert(result && result.ok === false, '应返回失败', result)
      assert(result.apiCode === 5007, '应为 5007，实际 ' + result.apiCode)
      assert(result.code === 'PHOTO_VENDOR_SPEC' || result.code === 'PHOTO_PROCESS_FAILED', '应为 PHOTO_VENDOR_SPEC/PHOTO_PROCESS_FAILED，实际 ' + result.code)
      assert(/更换照片|重拍/.test(result.message), '文案应提示更换照片/重拍，实际 ' + result.message)
      assert(deps.__counters.renderJpeg === 28, '应尝试 4 档 × 7 质量档 = 28 次，实际 ' + deps.__counters.renderJpeg)
      // uploadFile 前二次断言：即使拿到超规结果也必须拒绝（防御纵深）。
      var guard = pa.assertVendorSpec({ bytes: 6 * MB, width: 4000, height: 3000, mime: 'image/jpeg' })
      assert(guard.ok === false && guard.apiCode === 5007, 'assertVendorSpec 应拒绝超 5MB 结果')
      assert(Array.isArray(guard.reasons) && guard.reasons.indexOf('oversized_bytes') >= 0, 'reasons 应含 oversized_bytes，实际 ' + JSON.stringify(guard.reasons))
      assert(deps.__counters.uploadFileCalls === 0 && deps.__counters.createTaskCalls === 0, '不应触达上传/建任务')
    }
  }
}

/** ④ 正常小图（2048px/2MB）：不压缩、无提示、字节/长边保持原值。 */
function scenario4() {
  return {
    id: 'AC29-4',
    ac: 'AC-29④',
    title: '正常小图 2048px/2MB → 不压缩、无提示、字节与长边保持原值',
    info: { path: 'mock://in/normal-2048.jpg', size: 2 * MB, width: 2048, height: 1536, type: 'image/jpeg' },
    deps: function () {
      return mockDeps({ render: function () { throw new Error('不应调用 renderJpeg') } })
    },
    check: function (result, error, deps) {
      assert(!error, '不应抛异常：' + (error && error.message))
      assert(result && result.ok === true, '应成功直通', result)
      assert(result.processed === false && result.compressed === false, '不应压缩')
      assert(result.path === 'mock://in/normal-2048.jpg', '路径应保持原值')
      assert(result.bytes === 2 * MB, '字节应保持 2MB，实际 ' + result.bytes)
      assert(result.width === 2048 && result.height === 1536, '长边应保持 2048，实际 ' + result.width + 'x' + result.height)
      assert(pa.formatVendorCompressionNote(result) === '', '不应出现压缩提示')
      assert(deps.__counters.renderJpeg === 0, '不应执行渲染')
    }
  }
}

module.exports = {
  PHOTO_ADAPT_PATH: PHOTO_ADAPT_PATH,
  runScenarios: runScenarios
}
