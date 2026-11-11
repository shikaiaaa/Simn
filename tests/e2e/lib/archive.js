'use strict'
/**
 * tests/e2e/lib/archive.js
 *
 * 真实供应商回归结果归档（task-71，用户要求：AI 换装结果保存至本地）。
 *
 * 职责：
 *  1. 汇总本轮真实生成任务（taskId/provider/vendorTaskId/resultFileID/耗时/requestId）；
 *  2. 写 tests/e2e/results/<runId>/real-tasks.json；
 *  3. 用开发者工具官方 CLI（wechatide.cmd cloud_manage_storage --action download）把每张
 *     AI 换装结果图下载到 evidence/2026-11-11/real-runs/<runId>/<taskId>.png（只读，无需确认）；
 *  4. 写 manifest.json（大小/尺寸/SHA256/供应商/成本估算）；下载失败时如实标 pending，不伪造文件。
 *
 * 边界：
 *  - 仅从云端任务记录读取元数据；不改云端数据、不打印 AK/SK；
 *  - evidence/ 已被 .git/info/exclude 忽略，结果图不进仓库；
 *  - 归档失败不改变用例通过/失败结论（调用方 catch 后记录）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const env = require('./env')

const WECHATIDE_CANDIDATES = [
  process.env.SINN_E2E_WECHATIDE,
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\wechatide.cmd',
].filter(Boolean)

/** 成本估算口径（UI 展示给 Lead/用户，仅估算，不替代账单）：DEV-0001 §48 实测约 1 元/次。 */
const COST_PER_REAL_CALL_CNY = Number(process.env.SINN_E2E_COST_PER_CALL || 1)

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

/** 读取 PNG IHDR 的宽高（零依赖）。非 PNG 返回 null。 */
function pngSize(file) {
  try {
    const buf = fs.readFileSync(file)
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch (e) {
    return null
  }
}

/** 把 cloud://env.bucket/path 转成 storage API 需要的相对路径。 */
function cloudPathOf(fileID) {
  if (!fileID || typeof fileID !== 'string') return null
  const m = /^cloud:\/\/[^/]+\/(.+)$/.exec(fileID)
  return m ? m[1] : null
}

function findWechatide() {
  for (const p of WECHATIDE_CANDIDATES) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/** 解析 CLI 输出（stderr 有 skill-call 行、stdout 为 JSON）。 */
function parseCliJson(output) {
  if (!output) return null
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch (e) {
    return null
  }
}

/**
 * 执行 wechatide CLI 并把 stdout/stderr 重定向到临时文件再读回。
 * 原因：DSH/沙箱环境禁止 Node 通过管道捕获子进程输出（spawnSync 默认 pipe 会 EPERM），
 * 但允许继承/文件描述符重定向；因此这里用 fs.openSync 的 fd 作为 stdio，避免 EPERM。
 * @param {string[]} args 不含 cmd.exe /c 的参数数组（第一个是 cli 路径）
 * @returns {{status:number|null, error:Error|null, stdout:string, stderr:string}}
 */
function runCli(args, timeoutMs) {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const outFile = path.join(os.tmpdir(), `sinn-e2e-cli-${uniq}.out.log`)
  const errFile = path.join(os.tmpdir(), `sinn-e2e-cli-${uniq}.err.log`)
  const outFd = fs.openSync(outFile, 'w')
  const errFd = fs.openSync(errFile, 'w')
  let res = null
  try {
    res = spawnSync('cmd.exe', ['/c', ...args], {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs || 180000,
      windowsHide: true,
    })
  } finally {
    try {
      fs.closeSync(outFd)
    } catch (e) {
      /* ignore */
    }
    try {
      fs.closeSync(errFd)
    } catch (e) {
      /* ignore */
    }
  }
  let stdout = ''
  let stderr = ''
  try {
    stdout = fs.readFileSync(outFile, 'utf8')
    stderr = fs.readFileSync(errFile, 'utf8')
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(outFile)
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(errFile)
  } catch (e) {
    /* ignore */
  }
  return { status: res && res.status, error: (res && res.error) || null, stdout: stdout, stderr: stderr }
}

/** 调 wechatide cloud_manage_storage download；成功返回 {ok:true,bytes}，失败返回 {ok:false,error}。 */
function downloadCloudFile({ cli, appid, envId, fileID, localPath }) {
  const cloudPath = cloudPathOf(fileID)
  if (!cloudPath) return { ok: false, error: '无法从 resultFileID 解析 cloudPath：' + fileID }
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  const args = [
    cli,
    '-c',
    'deepseek',
    'cloud_manage_storage',
    '--appid',
    appid,
    '--env',
    envId,
    '--action',
    'download',
    '--cloud-path',
    cloudPath,
    '--local-path',
    localPath,
  ]
  const res = runCli(args, 180000)
  const stdout = (res.stdout || '') + '\n' + (res.stderr || '')
  const parsed = parseCliJson(stdout)
  const success =
    parsed && parsed.ok === true && parsed.result && parsed.result.success === true && fs.existsSync(localPath)
  if (!success) {
    const message =
      (parsed && parsed.result && parsed.result.message) ||
      (parsed && parsed.message) ||
      (res.error && res.error.message) ||
      'wechatide download 未返回成功结果'
    return { ok: false, error: String(message), cloudPath, cliOutput: stdout.slice(0, 1200) }
  }
  return { ok: true, cloudPath, bytes: fs.statSync(localPath).size }
}

/** 调 wechatide cloud_db_read_doc 读取任务完整文档（含 vendorProvider/vendorTaskId/resultFileID 等）。
 *  taskGet 的客户端视图不暴露供应商字段，归档需从云端任务集合补全；只读、仅 QA 环境使用。
 *  成功返回 {ok:true, doc}，失败返回 {ok:false, error}（不抛错，归档降级为 taskGet 视图字段）。
 */
function readTaskDoc({ cli, appid, envId, taskId }) {
  const queryFile = path.join(os.tmpdir(), `sinn-e2e-task-query-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  try {
    // 注意：必须无 BOM 写 JSON，wechatide 的 JSON 文件解析不接受 BOM。
    fs.writeFileSync(queryFile, JSON.stringify({ taskId }) , 'utf8')
  } catch (e) {
    return { ok: false, error: `写查询条件失败：${e && e.message}` }
  }
  const args = [
    cli,
    '-c',
    'deepseek',
    'cloud_db_read_doc',
    '--appid',
    appid,
    '--env',
    envId,
    '--collection-name',
    'sinn_tasks',
    '--query-file',
    queryFile,
    '--limit',
    '3',
  ]
  const res = runCli(args, 120000)
  const stdout = (res.stdout || '') + '\n' + (res.stderr || '')
  const parsed = parseCliJson(stdout)
  try {
    fs.unlinkSync(queryFile)
  } catch (e) {
    /* ignore */
  }
  const data = parsed && parsed.result && Array.isArray(parsed.result.data) ? parsed.result.data : null
  const doc = data ? data.find((d) => d && d.taskId === taskId) : null
  if (!doc) {
    return {
      ok: false,
      error:
        (parsed && parsed.result && parsed.result.message) ||
        (parsed && parsed.message) ||
        (res.error && res.error.message) ||
        'cloud_db_read_doc 未返回任务文档',
      requestId: (parsed && parsed.result && parsed.result.requestId) || null,
    }
  }
  return { ok: true, doc, requestId: (parsed && parsed.result && parsed.result.requestId) || null }
}

/** 把 runGeneration 返回的 taskGet envelope 规范化为归档条目。 */
function normalizeTask(input) {
  const envelope = input && input.taskEnvelope ? input.taskEnvelope : null
  const doc = envelope && (envelope.data || envelope.result || envelope) ? envelope.data || envelope : null
  if (!doc || !doc.taskId) throw new Error('archive: taskEnvelope 缺少 task 文档/taskId：' + JSON.stringify(input).slice(0, 300))
  const viewResult = doc.result || {}
  return {
    taskId: doc.taskId,
    caseId: input.caseId || null,
    ac: input.ac || null,
    status: doc.status || null,
    // 客户端 taskGet 视图不暴露供应商字段，后续会用 cloud_db_read_doc 补全（metaSource=cloud_db）。
    vendorProvider: doc.vendorProvider || null,
    vendorTaskId: doc.vendorTaskId || null,
    resultFileID: doc.resultFileID || viewResult.fileID || null,
    resultWidth: doc.resultWidth || viewResult.width || null,
    resultHeight: doc.resultHeight || viewResult.height || null,
    submittedAt: doc.submittedAt || doc.createdAt || null,
    successAt: doc.successAt || doc.statusUpdatedAt || null,
    elapsedMs: typeof input.elapsedMs === 'number' ? input.elapsedMs : null,
    requestId: input.requestId || null,
    taskGetRequestId: envelope && envelope.requestId ? envelope.requestId : null,
    fixtureKind: input.fixtureKind || null,
    realCall: doc.vendorProvider === 'volcengine' || input.realVendor === true,
    metaSource: doc.vendorProvider ? 'taskGet' : 'taskGet（视图字段有限）',
    // L3-006 等会物理删除任务的用例：删除前先 snapshot 落盘，finalize 时按 taskId 合并复用。
    preArchive: input.preArchive || null,
  }
}

/**
 * 任务被删除前立即下载结果图（L3-006 专用）：返回 `{archive:{status,localPath,...}}`。
 * 读云端完整文档补全 resultFileID；任何失败都返回 pending 条目，不抛错（不阻断用例）。
 */
function snapshotTaskResult({ taskEnvelope, runId, appid, envId, archiveRoot }) {
  try {
    let t = normalizeTask({ taskEnvelope })
    const cli = findWechatide()
    if (!cli) return { archive: { status: 'pending', error: '未找到 wechatide.cmd（开发者工具 CLI）' } }
    const full = readTaskDoc({ cli, appid, envId, taskId: t.taskId })
    if (full.ok) t = mergeFullDoc(t, full.doc)
    else t = Object.assign({}, t, { docReadError: full.error || 'cloud_db_read_doc 失败' })
    if (!t.resultFileID) return { archive: { status: 'pending', error: 'resultFileID 为空（删除前无法归档）' } }
    const root = archiveRoot || process.env.SINN_E2E_ARCHIVE_ROOT || path.join(env.ROOT, 'evidence', '2026-11-11', 'real-runs')
    const outDir = path.join(root, runId)
    fs.mkdirSync(outDir, { recursive: true })
    const localPath = path.join(outDir, `${t.taskId}.png`)
    const dl = downloadCloudFile({ cli, appid, envId, fileID: t.resultFileID, localPath })
    if (!dl.ok) return { archive: { status: 'pending', error: dl.error } }
    const size = pngSize(localPath) || {}
    return {
      archive: {
        status: 'downloaded',
        localPath: path.relative(env.ROOT, localPath).replace(/\\/g, '/'),
        bytes: fs.statSync(localPath).size,
        sha256: sha256File(localPath),
        width: size.width || null,
        height: size.height || null,
        cloudPath: dl.cloudPath,
      },
    }
  } catch (e) {
    return { archive: { status: 'pending', error: String((e && e.message) || e) } }
  }
}

/** 用云端任务集合的完整文档补全归档字段（供应商/结果文件/时间戳）。 */
function mergeFullDoc(entry, full) {
  if (!full) return entry
  const merged = Object.assign({}, entry)
  merged.status = full.status || merged.status
  merged.vendorProvider = full.vendorProvider || merged.vendorProvider
  merged.vendorTaskId = full.vendorTaskId || merged.vendorTaskId
  merged.resultFileID = full.resultFileID || merged.resultFileID
  merged.resultWidth = full.resultWidth || merged.resultWidth
  merged.resultHeight = full.resultHeight || merged.resultHeight
  merged.submittedAt = full.submittedAt || merged.submittedAt
  merged.successAt = full.successAt || full.statusUpdatedAt || merged.successAt
  merged.metaSource = 'cloud_db'
  merged.realCall = merged.vendorProvider === 'volcengine' || merged.realCall === true
  return merged
}

/**
 * 归档本轮真实任务。
 * @param {{runId:string, runDir:string, tasks:Array, appid:string, envId:string, archiveRoot?:string}} opts
 * @returns {{realTasksPath:string, manifestPath:string, tasks:Array, totals:object, pending:number}}
 */
function finalize(opts) {
  const { runId, runDir, tasks } = opts
  const appid = opts.appid || 'wx735e60c2c07673aa'
  const envId = opts.envId || 'simn-01-d5gjsxm0ocb78add8'
  const archiveRoot =
    opts.archiveRoot || process.env.SINN_E2E_ARCHIVE_ROOT || path.join(env.ROOT, 'evidence', '2026-11-11', 'real-runs')
  const outDir = path.join(archiveRoot, runId)
  fs.mkdirSync(outDir, { recursive: true })

  // 逐用例增量归档（task-71）：上一轮 finalize 已下载的条目直接复用，避免重复下载；
  // 也避免后续用例（如 L3-006 物理删除 / L3-011 撤回同意）把已归档结果图删掉后覆盖为 pending。
  const known = new Map()
  for (const e of opts.known || []) {
    if (e && e.taskId) known.set(e.taskId, e)
  }

  const cli = findWechatide()
  const seen = new Set()
  const normalized = []
  for (const item of tasks || []) {
    let t = normalizeTask(item)
    if (seen.has(t.taskId)) {
      // 删除前 snapshot 的条目合并进已登记条目（L3-006）。
      if (t.preArchive) {
        const prev = normalized.find((x) => x.taskId === t.taskId)
        if (prev && !prev.preArchive) prev.preArchive = t.preArchive
      }
      continue
    }
    seen.add(t.taskId)
    const prev = known.get(t.taskId)
    if (prev) {
      t = Object.assign({}, t, {
        vendorProvider: t.vendorProvider || prev.vendorProvider || null,
        vendorTaskId: t.vendorTaskId || prev.vendorTaskId || null,
        resultFileID: t.resultFileID || prev.resultFileID || null,
        resultWidth: t.resultWidth || prev.resultWidth || null,
        resultHeight: t.resultHeight || prev.resultHeight || null,
        requestId: t.requestId || prev.requestId || null,
        metaSource: prev.metaSource || t.metaSource,
        preArchive: prev.archive || null,
      })
    } else if (cli) {
      // 客户端 taskGet 视图不含供应商字段/结果归属，优先读云端任务文档补全（只读）。
      const full = readTaskDoc({ cli, appid, envId, taskId: t.taskId })
      if (full.ok) t = mergeFullDoc(t, full.doc)
      else t.docReadError = full.error || 'cloud_db_read_doc 失败'
    }
    normalized.push(t)
  }

  const tasksOut = normalized.map((t) => {
    const entry = Object.assign({}, t)
    // 已下载过的条目：直接复用本地文件（校验文件仍在，防止 evidence 被清理后虚报）。
    if (t.preArchive && t.preArchive.status === 'downloaded' && t.preArchive.localPath) {
      const abs = path.isAbsolute(t.preArchive.localPath)
        ? t.preArchive.localPath
        : path.join(env.ROOT, t.preArchive.localPath)
      if (fs.existsSync(abs)) {
        entry.archive = t.preArchive
        return entry
      }
    }
    delete entry.preArchive
    if (!t.resultFileID) {
      entry.archive = { status: 'pending', error: 'resultFileID 为空（任务可能未成功/已删除）' }
      return entry
    }
    if (!cli) {
      entry.archive = { status: 'pending', error: '未找到 wechatide.cmd（开发者工具 CLI）' }
      return entry
    }
    const localPath = path.join(outDir, `${t.taskId}.png`)
    const dl = downloadCloudFile({ cli, appid, envId, fileID: t.resultFileID, localPath })
    if (!dl.ok) {
      entry.archive = { status: 'pending', error: dl.error }
      return entry
    }
    const size = pngSize(localPath) || {}
    entry.archive = {
      status: 'downloaded',
      localPath: path.relative(env.ROOT, localPath).replace(/\\/g, '/'),
      bytes: fs.statSync(localPath).size,
      sha256: sha256File(localPath),
      width: size.width || null,
      height: size.height || null,
      cloudPath: dl.cloudPath,
    }
    return entry
  })

  const realCalls = tasksOut.filter((t) => t.realCall).length
  const downloaded = tasksOut.filter((t) => t.archive && t.archive.status === 'downloaded').length
  const pending = tasksOut.length - downloaded
  const totals = {
    tasks: tasksOut.length,
    downloaded,
    pending,
    realCalls,
    costEstimateCny: realCalls * COST_PER_REAL_CALL_CNY,
    costBasis: `按 DEV-0001 §48 实测约 1 元/次估算（上限 ≤2 元/次）；query/轮询/下载不计费`,
  }

  const realTasks = {
    runId,
    generatedAt: new Date().toISOString(),
    appid,
    envId,
    tasks: tasksOut,
    totals,
  }
  const realTasksPath = path.join(runDir, 'real-tasks.json')
  fs.writeFileSync(realTasksPath, JSON.stringify(realTasks, null, 2) + '\n', 'utf8')

  const manifest = {
    runId,
    generatedAt: new Date().toISOString(),
    archiveRoot: path.relative(env.ROOT, outDir).replace(/\\/g, '/'),
    appid,
    envId,
    provider: Array.from(new Set(tasksOut.map((t) => t.vendorProvider).filter(Boolean))),
    tasks: tasksOut,
    totals,
  }
  const manifestPath = path.join(outDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  return { realTasksPath, manifestPath, outDir, tasks: tasksOut, totals, pending }
}

module.exports = { finalize, snapshotTaskResult, normalizeTask, cloudPathOf, pngSize, sha256File, findWechatide, timestamp, COST_PER_REAL_CALL_CNY }
