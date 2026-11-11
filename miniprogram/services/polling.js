/**
 * services/polling.js —— 生成任务轮询与失败分类的纯逻辑（DEV-0001-07）。
 *
 * SPEC v0.9 / REQ v0.6 口径：
 * - 端上每 2s 轮询 taskGet；60s 只提示「生成较慢，请稍候」，不判超时；
 * - 服务端 96s 判 TIMEOUT 并 5002（收到即进超时态）；
 * - 101s（96s+5s）仅作为服务端异常/无终态响应的兜底硬上限。
 *
 * 页面只负责调度（setTimeout/setInterval）与渲染；本模块保持零 wx 依赖，
 * 便于在 Node/jest 下用可控时钟验证 AC-7/8/9/10/12 的口径。
 */
'use strict'

var POLL_INTERVAL_MS = 2000
var MAX_BACKOFF_MS = 10000
var SLOW_HINT_MS = 60000 // SPEC v0.9 §1：60s 仅提示变慢，不判超时
var SERVER_TIMEOUT_MS = 96000 // SPEC v0.9 §2：服务端 96s 判 TIMEOUT（5002）
var HARD_TIMEOUT_MS = 101000 // 96s + 5s：仅服务端无终态响应时兜底
var MAX_NETWORK_ATTEMPTS = 3

var TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED']

var STAGE_TEXTS = {
  QUEUED: '排队中',
  GENERATING: '生成中',
  SAVING: '保存结果中',
  DONE: '已完成',
  FAILED: '生成失败',
  TIMEOUT: '生成超时',
  CANCELLED: '已取消'
}

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value)
}

function isTerminal(status) {
  return TERMINAL_STATUSES.indexOf(status) >= 0
}

function stageText(stage, status) {
  if (status && isTerminal(status) && status !== 'SUCCEEDED' && STAGE_TEXTS[status]) {
    return STAGE_TEXTS[status]
  }
  return STAGE_TEXTS[stage] || STAGE_TEXTS[status] || '处理中'
}

/**
 * 已等待秒数：服务端下发的 waitedSec 优先；否则用 serverTime - createdAt
 * （都以服务端时钟为准），最后才退回本地 startedAt。
 */
function computeWaitedSec(input) {
  var options = input || {}
  if (isFiniteNumber(options.waitedSec)) {
    return Math.max(0, Math.floor(options.waitedSec))
  }
  var referenceNow = isFiniteNumber(options.serverTime) ? options.serverTime : options.now
  if (isFiniteNumber(options.createdAt) && isFiniteNumber(referenceNow)) {
    return Math.max(0, Math.floor((referenceNow - options.createdAt) / 1000))
  }
  if (isFiniteNumber(options.startedAt) && isFiniteNumber(options.now)) {
    return Math.max(0, Math.floor((options.now - options.startedAt) / 1000))
  }
  return 0
}

function formatWaited(waitedSec) {
  var sec = isFiniteNumber(waitedSec) ? Math.max(0, Math.floor(waitedSec)) : 0
  return '已等待 ' + sec + ' 秒'
}

/** 网络失败指数退避：2s → 4s → 8s → 10s 封顶。 */
function nextDelayMs(attempt) {
  var n = isFiniteNumber(attempt) ? Math.floor(attempt) : 1
  if (n < 1) n = 1
  return Math.min(POLL_INTERVAL_MS * Math.pow(2, n - 1), MAX_BACKOFF_MS)
}

function shouldHardTimeout(elapsedMs) {
  return isFiniteNumber(elapsedMs) && elapsedMs >= HARD_TIMEOUT_MS
}

/**
 * 已流逝毫秒：服务端 serverTime - createdAt 优先（AC-7 计时边界），
 * 其次服务端 waitedSec，最后才退回本地 startedAt。
 */
function computeElapsedMs(input) {
  var options = input || {}
  if (isFiniteNumber(options.createdAt) && isFiniteNumber(options.serverTime)) {
    return Math.max(0, options.serverTime - options.createdAt)
  }
  if (isFiniteNumber(options.waitedSec)) {
    return Math.max(0, Math.floor(options.waitedSec * 1000))
  }
  if (isFiniteNumber(options.startedAt) && isFiniteNumber(options.now)) {
    return Math.max(0, options.now - options.startedAt)
  }
  return 0
}

/** 等待态四段：正常 / 变慢提示 / 临近服务端超时 / 兜底硬上限。 */
function waitPhase(elapsedMs) {
  var ms = isFiniteNumber(elapsedMs) ? Math.max(0, elapsedMs) : 0
  if (ms < SLOW_HINT_MS) return 'normal'
  if (ms < SERVER_TIMEOUT_MS) return 'slow'
  if (ms < HARD_TIMEOUT_MS) return 'late'
  return 'hard_timeout'
}

/** 60–96s / 96–101s 的等待提示；其余阶段不显示额外提示。 */
function waitHint(elapsedMs) {
  var phase = waitPhase(elapsedMs)
  if (phase === 'slow') return '生成较慢，请稍候'
  if (phase === 'late') return '生成时间较长，正在等待结果…'
  return ''
}

/** 101s 兜底：服务端无终态响应时才使用，区别于服务端 96s TIMEOUT 文案。 */
function hardTimeoutFailure() {
  return failureInfo('timeout', '生成超时', '等待超过 101 秒仍未收到生成结果，本次未出图；可重试或返回首页。', {
    canRetry: true
  })
}

function failureInfo(kind, title, message, extra) {
  var info = {
    kind: kind,
    title: title,
    message: message,
    canRetry: false,
    canCancel: false
  }
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      info[key] = extra[key]
    })
  }
  return info
}

/**
 * 失败分类（六类 + 取消/任务不存在/兜底）。
 * 输入：{status, failure:{code,name,message,kind}, code}。
 * 输出：{kind, title, message, canRetry, canCancel}；页面不得展示结果图。
 */
function classifyFailure(input) {
  var info = input || {}
  var status = info.status
  var failure = info.failure || {}
  var code = isFiniteNumber(info.code) ? info.code : isFiniteNumber(failure.code) ? failure.code : null

  if (status === 'CANCELLED') {
    return failureInfo('cancelled', '任务已取消', '本次生成已取消，额度已返还。')
  }
  if (code === 5004) {
    return failureInfo('gone', '任务不存在', '任务不存在或已被删除、清理，无法查看结果。')
  }
  if (status === 'TIMEOUT' || code === 5002) {
    return failureInfo('timeout', '生成超时', '生成超过 96 秒仍未完成，本次未出图；可重试或返回首页。', {
      canRetry: true
    })
  }
  if (failure.kind === 'content_blocked' || code === 4001) {
    return failureInfo('content', '内容校验未通过', '照片或服装未通过内容安全校验，请更换照片后重试。')
  }
  if (status === 'FAILED') {
    if (code !== null && code >= 3000 && code <= 3013) {
      return failureInfo(
        'photo',
        '照片未通过预检',
        failure.message || '照片或服装不符合要求，请重拍后重试。'
      )
    }
    if (code === 2001) {
      return failureInfo('quota', '今日次数已用完', '今日试穿次数已用完，明日 00:00 重置后再试。')
    }
    if (code === 5003) {
      return failureInfo('network', '网络异常', '网络连接不稳定，请稍后重试。', { canRetry: true })
    }
    if (code === 5001) {
      return failureInfo('service', '服务暂时不可用', '试穿服务暂时不可用或排队超时，请稍后重试。', {
        canRetry: true
      })
    }
    if (code === 5005) {
      return failureInfo('service', '服务暂时不可用', '试穿服务返回异常，请稍后重试。', { canRetry: true })
    }
    return failureInfo('failed', '生成失败', failure.message || '本次生成失败，未出图；可稍后重试。', {
      canRetry: true
    })
  }

  if (code === 5003) {
    return failureInfo('network', '网络异常', '网络连接不稳定，请稍后重试。', { canRetry: true })
  }
  if (code === 5001 || code === 5005) {
    return failureInfo('service', '服务暂时不可用', '试穿服务暂时不可用，请稍后重试。', { canRetry: true })
  }
  return failureInfo('service', '服务暂时不可用', '请稍后重试。', { canRetry: true })
}

module.exports = {
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  MAX_BACKOFF_MS: MAX_BACKOFF_MS,
  SLOW_HINT_MS: SLOW_HINT_MS,
  SERVER_TIMEOUT_MS: SERVER_TIMEOUT_MS,
  HARD_TIMEOUT_MS: HARD_TIMEOUT_MS,
  MAX_NETWORK_ATTEMPTS: MAX_NETWORK_ATTEMPTS,
  TERMINAL_STATUSES: TERMINAL_STATUSES,
  STAGE_TEXTS: STAGE_TEXTS,
  isTerminal: isTerminal,
  stageText: stageText,
  computeWaitedSec: computeWaitedSec,
  formatWaited: formatWaited,
  nextDelayMs: nextDelayMs,
  shouldHardTimeout: shouldHardTimeout,
  computeElapsedMs: computeElapsedMs,
  waitPhase: waitPhase,
  waitHint: waitHint,
  hardTimeoutFailure: hardTimeoutFailure,
  classifyFailure: classifyFailure
}
