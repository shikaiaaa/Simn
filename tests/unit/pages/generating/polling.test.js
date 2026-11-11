/**
 * tests/unit/pages/generating/polling.test.js
 * 覆盖 AC-8/9/10 的纯逻辑口径：轮询间隔与退避、stage 文案、等待秒数、硬超时、失败六类分类。
 */
'use strict'

var polling = require('../../../../miniprogram/services/polling')

describe('polling：常量与基本判定', function () {
  test('轮询间隔 2s、退避上限 10s、60s 提示 / 96s 服务端超时 / 101s 兜底', function () {
    expect(polling.POLL_INTERVAL_MS).toBe(2000)
    expect(polling.MAX_BACKOFF_MS).toBe(10000)
    expect(polling.SLOW_HINT_MS).toBe(60000)
    expect(polling.SERVER_TIMEOUT_MS).toBe(96000)
    expect(polling.HARD_TIMEOUT_MS).toBe(101000)
  })

  test('终态判定：仅 SUCCEEDED/FAILED/TIMEOUT/CANCELLED', function () {
    ;['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED'].forEach(function (status) {
      expect(polling.isTerminal(status)).toBe(true)
    })
    ;['QUEUED', 'GENERATING', 'SAVING', ''].forEach(function (status) {
      expect(polling.isTerminal(status)).toBe(false)
    })
  })

  test('stage 文案：服务端 stage 优先，失败态显示服务端 status', function () {
    expect(polling.stageText('QUEUED', 'QUEUED')).toBe('排队中')
    expect(polling.stageText('GENERATING', 'GENERATING')).toBe('生成中')
    expect(polling.stageText('SAVING', 'SAVING')).toBe('保存结果中')
    expect(polling.stageText('DONE', 'SUCCEEDED')).toBe('已完成')
    expect(polling.stageText('GENERATING', 'TIMEOUT')).toBe('生成超时')
    expect(polling.stageText('GENERATING', 'FAILED')).toBe('生成失败')
    expect(polling.stageText('GENERATING', 'CANCELLED')).toBe('已取消')
    expect(polling.stageText('WHATEVER', 'WHATEVER')).toBe('处理中')
  })
})

describe('polling：等待秒数与退避', function () {
  test('waitedSec 优先（服务端下发）', function () {
    expect(polling.computeWaitedSec({ waitedSec: 12, serverTime: 999999, createdAt: 0 })).toBe(12)
  })

  test('无 waitedSec 时用 serverTime - createdAt 计算', function () {
    expect(polling.computeWaitedSec({ serverTime: 1012000, createdAt: 1000000 })).toBe(12)
    expect(polling.computeWaitedSec({ serverTime: 1000500, createdAt: 1000000 })).toBe(0)
  })

  test('兜底用本地 startedAt，且不出现负数', function () {
    expect(polling.computeWaitedSec({ startedAt: 1000, now: 4000 })).toBe(3)
    expect(polling.computeWaitedSec({ waitedSec: -5 })).toBe(0)
    expect(polling.computeWaitedSec({})).toBe(0)
  })

  test('formatWaited 固定文案，无百分比', function () {
    expect(polling.formatWaited(12)).toBe('已等待 12 秒')
    expect(polling.formatWaited(0)).toBe('已等待 0 秒')
    expect(polling.formatWaited(12.9)).toBe('已等待 12 秒')
  })

  test('网络失败指数退避 2/4/8/10/10 秒', function () {
    expect(polling.nextDelayMs(1)).toBe(2000)
    expect(polling.nextDelayMs(2)).toBe(4000)
    expect(polling.nextDelayMs(3)).toBe(8000)
    expect(polling.nextDelayMs(4)).toBe(10000)
    expect(polling.nextDelayMs(9)).toBe(10000)
    expect(polling.nextDelayMs(0)).toBe(2000)
  })

  test('硬超时边界 101000ms（96s + 5s 兜底）', function () {
    expect(polling.shouldHardTimeout(100999)).toBe(false)
    expect(polling.shouldHardTimeout(101000)).toBe(true)
    expect(polling.shouldHardTimeout(101001)).toBe(true)
    expect(polling.shouldHardTimeout(undefined)).toBe(false)
  })
})

describe('polling：SPEC v0.9 96s 等待态四段（AC-7/AC-9）', function () {
  test('waitPhase 四段边界：<60s normal / 60–96s slow / 96–101s late / >=101s hard_timeout', function () {
    expect(polling.waitPhase(0)).toBe('normal')
    expect(polling.waitPhase(59999)).toBe('normal')
    expect(polling.waitPhase(60000)).toBe('slow')
    expect(polling.waitPhase(95999)).toBe('slow')
    expect(polling.waitPhase(96000)).toBe('late')
    expect(polling.waitPhase(100999)).toBe('late')
    expect(polling.waitPhase(101000)).toBe('hard_timeout')
    expect(polling.waitPhase(undefined)).toBe('normal')
  })

  test('waitHint 只在 60–101s 给出非百分比提示', function () {
    expect(polling.waitHint(59000)).toBe('')
    expect(polling.waitHint(60000)).toBe('生成较慢，请稍候')
    expect(polling.waitHint(95999)).toBe('生成较慢，请稍候')
    expect(polling.waitHint(96000)).toBe('生成时间较长，正在等待结果…')
    expect(polling.waitHint(100999)).toBe('生成时间较长，正在等待结果…')
    expect(polling.waitHint(101000)).toBe('')
    ;[polling.waitHint(60000), polling.waitHint(96000)].forEach(function (text) {
      expect(text).not.toContain('%')
      expect(text).not.toContain('进度')
    })
  })

  test('computeElapsedMs：serverTime - createdAt 优先，其次 waitedSec，最后本地 startedAt', function () {
    expect(polling.computeElapsedMs({ createdAt: 1000000, serverTime: 1096500 })).toBe(96500)
    expect(polling.computeElapsedMs({ createdAt: 1000000, serverTime: 1096500, waitedSec: 3 })).toBe(96500)
    expect(polling.computeElapsedMs({ waitedSec: 12 })).toBe(12000)
    expect(polling.computeElapsedMs({ startedAt: 1000, now: 4000 })).toBe(3000)
    expect(polling.computeElapsedMs({})).toBe(0)
  })

  test('服务端 96s 超时文案不再写 60 秒；101s 兜底文案单列', function () {
    var serverTimeout = polling.classifyFailure({ status: 'TIMEOUT' })
    expect(serverTimeout.message).toContain('96 秒')
    expect(serverTimeout.message).not.toContain('60 秒')
    var hardTimeout = polling.hardTimeoutFailure()
    expect(hardTimeout.kind).toBe('timeout')
    expect(hardTimeout.title).toBe('生成超时')
    expect(hardTimeout.message).toContain('101 秒')
    expect(hardTimeout.canRetry).toBe(true)
  })
})

describe('polling：失败分类（AC-10 六类）', function () {
  test('生成超时：status=TIMEOUT 或 code=5002 → timeout + 可重试', function () {
    var fromStatus = polling.classifyFailure({ status: 'TIMEOUT' })
    expect(fromStatus.kind).toBe('timeout')
    expect(fromStatus.title).toBe('生成超时')
    expect(fromStatus.canRetry).toBe(true)
    expect(polling.classifyFailure({ status: 'FAILED', code: 5002 }).kind).toBe('timeout')
  })

  test('照片/衣服不合格：3000–3013 → photo，不展示结果', function () {
    ;[3000, 3002, 3008, 3011, 3013].forEach(function (code) {
      var info = polling.classifyFailure({ status: 'FAILED', failure: { code: code, message: '照片不合格' } })
      expect(info.kind).toBe('photo')
      expect(info.title).toBe('照片未通过预检')
      expect(info.message).toContain('照片不合格')
      expect(info.canRetry).toBe(false)
    })
  })

  test('额度不足：2001 → quota', function () {
    var info = polling.classifyFailure({ status: 'FAILED', code: 2001 })
    expect(info.kind).toBe('quota')
    expect(info.title).toContain('次数')
    expect(info.message).toContain('00:00')
  })

  test('内容安全：4001 或 failure.kind=content_blocked → content', function () {
    expect(polling.classifyFailure({ status: 'FAILED', code: 4001 }).kind).toBe('content')
    expect(polling.classifyFailure({ status: 'FAILED', failure: { kind: 'content_blocked' } }).kind).toBe('content')
    expect(polling.classifyFailure({ status: 'FAILED', code: 4001 }).title).toContain('内容')
  })

  test('网络异常：5003 → network + 可重试', function () {
    var info = polling.classifyFailure({ status: 'FAILED', code: 5003 })
    expect(info.kind).toBe('network')
    expect(info.title).toBe('网络异常')
    expect(info.canRetry).toBe(true)
  })

  test('服务不可用/排队超时：5001/5005 → service + 可重试', function () {
    ;[5001, 5005].forEach(function (code) {
      var info = polling.classifyFailure({ status: 'FAILED', code: code })
      expect(info.kind).toBe('service')
      expect(info.title).toContain('服务暂时不可用')
      expect(info.canRetry).toBe(true)
    })
  })

  test('取消/任务不存在/未知失败有独立文案', function () {
    expect(polling.classifyFailure({ status: 'CANCELLED' }).kind).toBe('cancelled')
    expect(polling.classifyFailure({ status: 'FAILED', code: 5004 }).kind).toBe('gone')
    var fallback = polling.classifyFailure({ status: 'FAILED', failure: { code: 9000, message: '内部错误' } })
    expect(fallback.kind).toBe('failed')
    expect(fallback.title).toBe('生成失败')
  })

  test('六类文案互不相同（AC-10 文案差异）', function () {
    var titles = [
      polling.classifyFailure({ status: 'TIMEOUT' }).title,
      polling.classifyFailure({ status: 'FAILED', code: 3002 }).title,
      polling.classifyFailure({ status: 'FAILED', code: 2001 }).title,
      polling.classifyFailure({ status: 'FAILED', code: 4001 }).title,
      polling.classifyFailure({ status: 'FAILED', code: 5003 }).title,
      polling.classifyFailure({ status: 'FAILED', code: 5001 }).title
    ]
    var unique = {}
    titles.forEach(function (title) {
      unique[title] = true
    })
    expect(Object.keys(unique).length).toBe(6)
  })
})
