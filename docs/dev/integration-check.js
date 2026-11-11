/**
 * docs/dev/integration-check.js —— DEV-0001-10 全链路自检（mock provider）。
 *
 * 目的：在没有云开发 envId / 真实供应商的环境下，用同一份生产代码
 * （cloudfunctions/sinn-task|sinn-account|sinn-cleanup 的 handler/lib +
 *  miniprogram/services 的 api/consent/upload/precheck/size）跑通：
 *   首页(profile) → 同意(recordConsent) → 人像采集(upload+assetRegister+precheck)
 *   → 衣服(garment upload+precheck) → 创建任务(createTask) → 生成(taskGet 轮询)
 *   → 结果(taskGet SUCCEEDED + 服务端 sizeResult) → 删除本次(deleteTask/404)
 *   → 删除全部(deleteAll) → 到期物理清理(cleanup)
 *
 * 边界（不虚报）：
 * - 页面 UI（chooseMedia/授权弹窗/缩放手势/结果页渲染）由 tests/unit 的 304 例单测覆盖；
 * - 真机、真实云开发、真实供应商、e2e（miniprogram-automator）均未就绪，本脚本不冒充；
 * - 本脚本只验证「客户端 service 层 + 云函数 handler 层」在 mock provider 下的装配与数据契约。
 *
 * 运行：node docs/dev/integration-check.js
 * 输出：控制台逐步骤结果 + 汇总 JSON 写入 docs/dev/integration-check-result.json
 */
'use strict'

var path = require('path')
var fs = require('fs')

var ROOT = path.resolve(__dirname, '..', '..')
function req(rel) {
  return require(path.join(ROOT, rel))
}

var results = []
var failures = 0

function record(step, status, detail) {
  results.push({ step: step, status: status, detail: detail || '' })
  if (status === 'fail') failures += 1
  var mark = status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL'
  console.log('[' + mark + '] ' + step + (detail ? ' :: ' + detail : ''))
}

function show(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (e) {
    return String(value)
  }
}

/* ---------------------------------------------------------------- 时钟与后端 */

var clock = { t: Date.UTC(2026, 10, 9, 4, 0, 0) } // 2026-11-09 12:00 +08

var createMemoryStore = req('cloudfunctions/sinn-task/lib/store/memory-store').createMemoryStore
var errorsLib = req('cloudfunctions/sinn-task/lib/errors')
var accountLib = req('cloudfunctions/sinn-task/lib/account')
var createTaskHandler = req('cloudfunctions/sinn-task/lib/handler').createHandler
var createAccountHandler = req('cloudfunctions/sinn-account/lib/handler').createHandler
var createCleanupHandler = req('cloudfunctions/sinn-cleanup/lib/handler').createHandler
var createMockVendorAdapter = req('cloudfunctions/sinn-task/lib/vendor/mock-vendor').createMockVendorAdapter
var createMockPrecheckAdapter = req('cloudfunctions/sinn-task/lib/precheck').createMockPrecheckAdapter

var store = createMemoryStore({
  config: {
    dailyLimitNormal: 5, // 自检需要跑多次 createTask；额度语义由单测按 SPEC 1/10 覆盖
    dailyLimitVip: 10,
    vipWhitelist: ['o_qa'],
    vendorProvider: 'mock',
    sizeMappingVersion: '2026-11-09-v1'
  }
})

var storageCalls = { downloads: [], saved: [], deleted: [] }
var storage = {
  download: function (fileID) {
    storageCalls.downloads.push(fileID)
    return Promise.resolve(Buffer.from('mock-image:' + fileID))
  },
  saveResult: function (info) {
    var fileID = 'cloud://mock-env/sinn/result/' + info.taskId + '.png'
    storageCalls.saved.push({ taskId: info.taskId, fileID: fileID, width: info.width, height: info.height })
    return Promise.resolve({ fileID: fileID })
  },
  deleteFiles: function (fileIDs) {
    var ids = (fileIDs || []).slice()
    for (var i = 0; i < ids.length; i += 1) storageCalls.deleted.push(ids[i])
    return Promise.resolve({ deleted: ids.length })
  }
}

var vendor = createMockVendorAdapter({
  now: function () { return clock.t },
  scenario: 'success',
  queueMs: 100,
  generateMs: 500,
  width: 2048,
  height: 3072
})
var precheckAdapter = createMockPrecheckAdapter()
var consentRecords = []
var consentStore = {
  append: function (record) {
    consentRecords.push(record)
    return Promise.resolve(record)
  },
  listByOpenid: function (openid) {
    return Promise.resolve(consentRecords.filter(function (r) { return r.openid === openid }))
  }
}

var env = {
  SINN_VENDOR: 'mock',
  ALLOW_DEBUG_AUDIT: 'true',
  QA_OPENID_WHITELIST: 'o_user,o_qa',
  SINN_DAILY_LIMIT_NORMAL: '5',
  SINN_DAILY_LIMIT_VIP: '10',
  SINN_VIP_WHITELIST: 'o_qa'
}
var USER = 'o_user'

var taskHandler = createTaskHandler({
  store: store,
  vendor: vendor,
  precheck: precheckAdapter,
  storage: storage,
  env: env,
  now: function () { return clock.t },
  requestId: function () { return 'req-task-' + clock.t }
})
var accountHandler = createAccountHandler({
  store: store,
  storage: storage,
  vendor: vendor,
  consentStore: consentStore,
  env: env,
  now: function () { return clock.t },
  requestId: function () { return 'req-account-' + clock.t }
})
var cleanupHandler = createCleanupHandler({
  store: store,
  storage: storage,
  vendor: vendor,
  now: function () { return clock.t },
  batchSize: 10,
  logger: { log: function () {} }
})

/* ---------------------------------------------------------------- 假 wx（仅覆盖被 services 用到的 API） */

var localStore = {}
var counters = { privacyAuthorize: 0, chooseMedia: 0, cloudCalls: [] }
var CURRENT_OPENID = USER

function routeCallFunction(params) {
  var name = params && params.name
  var data = (params && params.data) || {}
  counters.cloudCalls.push(name + '/' + (data.action || ''))
  var handler = null
  if (name === 'sinn-task') handler = taskHandler
  else if (name === 'sinn-account') handler = accountHandler
  if (!handler) return Promise.reject(new Error('unknown cloud function: ' + name))
  return handler.handle(data, { openid: CURRENT_OPENID }).then(function (envelope) {
    return { result: envelope, errMsg: 'cloud.callFunction:ok' }
  })
}

global.wx = {
  cloud: {
    init: function () {},
    callFunction: function (params) {
      return routeCallFunction(params)
    },
    uploadFile: function (params) {
      var fileID = 'cloud://mock-env/' + params.cloudPath
      return Promise.resolve({ fileID: fileID, statusCode: 200 })
    },
    getTempFileURL: function (params) {
      var fileList = (params && params.fileList) || []
      return Promise.resolve({
        fileList: fileList.map(function (item) {
          return {
            fileID: item.fileID,
            tempFileURL: 'https://mock.example.com/' + encodeURIComponent(item.fileID)
          }
        })
      })
    }
  },
  requirePrivacyAuthorize: function (options) {
    counters.privacyAuthorize += 1
    if (options && options.success) options.success({ errMsg: 'requirePrivacyAuthorize:ok' })
  },
  onNeedPrivacyAuthorization: function () {},
  offNeedPrivacyAuthorization: function () {},
  chooseMedia: function () {
    counters.chooseMedia += 1
  },
  getStorageSync: function (key) {
    return Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : ''
  },
  setStorageSync: function (key, value) {
    localStore[key] = value
  },
  removeStorageSync: function (key) {
    delete localStore[key]
  },
  clearStorageSync: function () {
    localStore = {}
  },
  getStorageInfoSync: function () {
    return { keys: Object.keys(localStore) }
  },
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  showModal: function (options) {
    if (options && options.success) options.success({ confirm: true, cancel: false })
  },
  navigateTo: function (options) { if (options && options.success) options.success({}) },
  redirectTo: function (options) { if (options && options.success) options.success({}) },
  reLaunch: function (options) { if (options && options.success) options.success({}) },
  navigateBack: function (options) { if (options && options.success) options.success({}) }
}

/* ---------------------------------------------------------------- 客户端 services */

var api = req('miniprogram/services/api')
var consentService = req('miniprogram/services/consent')
var uploadService = req('miniprogram/services/upload')
var precheckService = req('miniprogram/services/precheck')
var sizeService = req('miniprogram/services/size')

function asApiError(error) {
  return error && error.isApiError ? error : new errorsLib.AppError(9000)
}

async function stepProfileBeforeConsent() {
  var res = await api.call('sinn-account', 'profile', {}, { requireConsent: false, timeoutMs: 5000 })
  var data = res.data || {}
  var quota = data.quota || {}
  if (data.consent !== null) throw new Error('未同意时 profile.consent 应为 null')
  if (quota.remaining !== 5) throw new Error('额度异常: ' + show(quota))
  if (counters.privacyAuthorize !== 0) throw new Error('未同意前调用了隐私授权 API')
  record('1. 首页读取 profile（未同意）', 'pass', 'consent=null, quota=' + quota.remaining + '/' + quota.limit)
}

async function stepConsent() {
  var res = await consentService.submitConsent({
    wxRef: global.wx,
    now: clock.t,
    ageConfirmed: true,
    termsAccepted: true,
    privacyAgreed: true
  })
  if (!res.ok) throw new Error('submitConsent 失败: ' + show(res))
  var local = consentService.readLocalConsent(global.wx)
  if (!local || local.version !== consentService.CONSENT_VERSION) throw new Error('本地同意缓存未写入')
  if (!(local.ageConfirmedAt > 0)) throw new Error('本地 ageConfirmedAt 非法')
  if (consentRecords.length !== 1) throw new Error('服务端同意审计记录数异常: ' + consentRecords.length)
  var audit = consentRecords[0]
  if (audit.openid !== USER) throw new Error('审计 openid 异常')
  if ('photos' in audit || 'metrics' in audit || 'gender' in audit) throw new Error('审计包含敏感字段')
  if (counters.privacyAuthorize !== 1) throw new Error('隐私授权调用次数异常: ' + counters.privacyAuthorize)
  if (counters.chooseMedia !== 0) throw new Error('同意流程不应调用 chooseMedia')
  record('2. consent 两步同意 + recordConsent + 本地缓存', 'pass', '版本=' + local.version + '，审计仅含用户/版本/时间/hash')
}

async function uploadPerson() {
  var clientReqId = api.createClientReqId()
  var first = await uploadService.uploadPersonPhoto({
    wxRef: global.wx,
    filePath: 'wxfile://tmp/person-1.jpg',
    mime: 'image/jpeg',
    bytes: 180000,
    width: 1200,
    height: 1600,
    clientReqId: clientReqId
  })
  if (!first.ok || !first.assetId) throw new Error('人像上传登记失败: ' + show(first))
  // 重试同一 clientReqId：应返回同一 assetId，不产生重复资产
  var retry = await uploadService.uploadPersonPhoto({
    wxRef: global.wx,
    filePath: 'wxfile://tmp/person-1.jpg',
    mime: 'image/jpeg',
    bytes: 180000,
    width: 1200,
    height: 1600,
    clientReqId: clientReqId,
    cloudPath: first.cloudPath
  })
  if (!retry.ok || retry.assetId !== first.assetId) throw new Error('重试未复用同一资产: ' + show(retry))
  var assets = store.__countAssets()
  if (assets !== 1) throw new Error('重试产生了重复资产: ' + assets)
  return first
}

async function stepCaptureFlow() {
  var person = await uploadPerson()
  var personCheck = await precheckService.runServerPrecheck(person.assetId, { now: clock.t })
  if (!personCheck.ok || personCheck.pass !== true) throw new Error('人像预检未通过: ' + show(personCheck))
  var form = precheckService.validateCaptureForm({
    photos: [{ path: 'wxfile://tmp/person-1.jpg' }],
    heightCm: 175,
    weightKg: 70,
    gender: 'male',
    chestCm: 92,
    waistCm: 78,
    hipCm: 96
  })
  if (!form.ok) throw new Error('采集表单校验失败: ' + show(form.errors))
  record('3. 人像采集（上传+assetRegister 幂等+服务端 precheck+表单）', 'pass',
    'asset=' + person.assetId + '，预检 status=' + personCheck.status + '，metrics.gender=' + form.normalized.metrics.gender)
  return { person: person, metrics: form.normalized.metrics }
}

async function stepGarmentAndCreateTask(person, metrics) {
  var garment = await uploadService.uploadGarmentPhoto({
    wxRef: global.wx,
    filePath: 'wxfile://tmp/garment-1.jpg',
    mime: 'image/jpeg',
    bytes: 150000,
    width: 900,
    height: 1200
  })
  if (!garment.ok || !garment.assetId) throw new Error('衣服上传登记失败: ' + show(garment))
  var check = await precheckService.runServerPrecheck(garment.assetId, { now: clock.t })
  if (!check.ok || check.pass !== true) throw new Error('衣服预检未通过: ' + show(check))

  var created = await api.call(
    'sinn-task',
    'createTask',
    {
      clientReqId: api.createClientReqId(),
      personAssetIds: [person.assetId],
      garmentAssetId: garment.assetId,
      metrics: metrics
    },
    { timeoutMs: 15000 }
  )
  var data = created.data || {}
  if (!data.taskId) throw new Error('createTask 未返回 taskId: ' + show(created))
  if (data.quota.remaining !== 4) throw new Error('额度预扣异常: ' + show(data.quota))
  record('4. 衣服采集 + createTask（预扣额度/单活跃/参数校验）', 'pass',
    'taskId=' + data.taskId + '，remaining=' + data.quota.remaining)
  return { taskId: data.taskId, createdAt: data.createdAt }
}

async function stepGenerating(taskId, createdAt) {
  var seen = []
  var terminal = null
  for (var i = 0; i < 12; i += 1) {
    clock.t += 200
    var res = await api.call('sinn-task', 'taskGet', { taskId: taskId }, { requireConsent: false, timeoutMs: 8000 })
    var data = res.data || {}
    if (seen.indexOf(data.status) < 0) seen.push(data.status)
    if (data.status === 'SUCCEEDED' || data.status === 'FAILED' || data.status === 'TIMEOUT' || data.status === 'CANCELLED') {
      terminal = data
      break
    }
  }
  if (!terminal) throw new Error('轮询未到终态，seen=' + show(seen))
  if (terminal.status !== 'SUCCEEDED') throw new Error('任务未成功: ' + show(terminal))
  // waitedSec 按服务端时间计算：终态后把时钟推进到创建后 1.5s，再取一次视图确认秒数不回退/能前进
  if (!(terminal.waitedSec > 0)) {
    clock.t = createdAt + 1500
    var again = await api.call('sinn-task', 'taskGet', { taskId: taskId }, { requireConsent: false, timeoutMs: 8000 })
    terminal = again.data || terminal
  }
  if (!terminal.result || !terminal.result.fileID) throw new Error('成功任务缺少 result.fileID')
  if (!(terminal.waitedSec > 0)) throw new Error('waitedSec 未按服务端时间推进')
  if (storageCalls.saved.length !== 1) throw new Error('结果转存次数异常: ' + storageCalls.saved.length)
  record('5. 生成轮询（阶段/等待秒数/SUCCEEDED+转存）', 'pass',
    'seen=' + seen.join('→') + '，waitedSec=' + terminal.waitedSec + '，result=' + terminal.result.fileID)
  return terminal.result
}

async function stepResult(taskId, result) {
  var sizeView = sizeService.buildSizeView(result.sizeResult)
  if (!sizeView.available) throw new Error('尺码展示不可用: ' + show(sizeView))
  if (sizeView.rangeText !== 'L–XL') throw new Error('尺码区间异常: ' + sizeView.rangeText)
  if (String(sizeView.standardText).indexOf('GB/T 1335.1') < 0) throw new Error('标准名异常: ' + sizeView.standardText)
  if (sizeService.findForbiddenWords(sizeView.disclaimer + sizeView.basisText).length > 0) {
    throw new Error('结果页出现禁词')
  }
  if (!result.sizeFallback && (result.width < 2048 || result.height < 2048)) {
    throw new Error('长边 <2048 时应给出 sizeFallback')
  }
  record('6. 结果页数据（服务端 sizeResult 格式化/AI 标识/降级提示）', 'pass',
    'range=' + sizeView.rangeText + '，standard=' + sizeView.standardText + '，disclaimer 合规')
}

async function stepDeleteTask(taskId) {
  var before = storageCalls.deleted.length
  var res = await api.call('sinn-task', 'deleteTask', { taskId: taskId }, { timeoutMs: 15000 })
  if (!res.data || !res.data.deletedAt) throw new Error('deleteTask 未返回 deletedAt')
  var deletedNow = storageCalls.deleted.length - before
  if (deletedNow < 3) throw new Error('删除对象数异常（人像+衣服+结果应为 3）: ' + deletedNow)
  var notFound = null
  try {
    await api.call('sinn-task', 'taskGet', { taskId: taskId }, { requireConsent: false })
  } catch (error) {
    notFound = error
  }
  if (!notFound || notFound.code !== 5004) throw new Error('删除后 taskGet 未返回 5004: ' + show(notFound && notFound.code))
  var audit = await api.call('sinn-task', 'auditTask', { taskId: taskId }, { requireConsent: false })
  if (!audit.data || audit.data.exists !== false) throw new Error('auditTask 显示数据仍存在')
  if (audit.data.assets && audit.data.assets.some(function (a) { return a.exists })) {
    throw new Error('auditTask 显示资产仍存在')
  }
  if (store.__countTasks() !== 0) throw new Error('任务记录未物理删除: ' + store.__countTasks())
  record('7. 删除本次（物理删对象+记录，重复查询 404，auditTask exists=false）', 'pass',
    'deletedAt=' + res.data.deletedAt + '，对象删除 ' + deletedNow + ' 个，任务记录 0')
}

async function createSecondTaskForDeleteAll() {
  var person = await uploadPerson()
  var garment = await uploadService.uploadGarmentPhoto({
    wxRef: global.wx,
    filePath: 'wxfile://tmp/garment-2.jpg',
    mime: 'image/jpeg',
    bytes: 140000,
    width: 900,
    height: 1200
  })
  if (!garment.ok) throw new Error('第二批衣服上传失败')
  await precheckService.runServerPrecheck(person.assetId, { now: clock.t })
  await precheckService.runServerPrecheck(garment.assetId, { now: clock.t })
  var created = await api.call('sinn-task', 'createTask', {
    clientReqId: api.createClientReqId(),
    personAssetIds: [person.assetId],
    garmentAssetId: garment.assetId,
    metrics: { heightCm: 168, weightKg: 60, gender: 'unspecified' }
  }, { timeoutMs: 15000 })
  return created.data.taskId
}

async function stepDeleteAll() {
  var taskId = await createSecondTaskForDeleteAll()
  clock.t += 120
  var res = await api.call('sinn-account', 'deleteAll', {}, { timeoutMs: 15000 })
  var data = res.data || {}
  if (!data.deletedAt) throw new Error('deleteAll 未返回 deletedAt')
  if (data.deletedTasks < 1) throw new Error('deleteAll 未统计任务: ' + show(data))
  if (store.__countTasks() !== 0) throw new Error('deleteAll 后仍有任务记录')
  if (store.__countAssets() !== 0) throw new Error('deleteAll 后仍有资产记录')
  // 幂等：二次调用不报错且计数不再增长
  var again = await api.call('sinn-account', 'deleteAll', {}, { timeoutMs: 15000 })
  if (!again.data || again.data.deletedTasks !== 0) throw new Error('deleteAll 不幂等: ' + show(again.data))
  // 同意审计保留，同意状态仍为已同意（deleteAll 不清同意）
  if (consentRecords.length !== 1) throw new Error('deleteAll 误删同意审计')
  record('8. 删除全部（物理全删/幂等/保留同意审计）', 'pass',
    'deletedTasks=' + data.deletedTasks + '，deletedAssets=' + data.deletedAssets + '，二次 deletedTasks=0')
}

async function stepCleanup() {
  var person = await uploadPerson()
  var garment = await uploadService.uploadGarmentPhoto({
    wxRef: global.wx,
    filePath: 'wxfile://tmp/garment-3.jpg',
    mime: 'image/jpeg',
    bytes: 130000,
    width: 900,
    height: 1200
  })
  await precheckService.runServerPrecheck(person.assetId, { now: clock.t })
  await precheckService.runServerPrecheck(garment.assetId, { now: clock.t })
  var created = await api.call('sinn-task', 'createTask', {
    clientReqId: api.createClientReqId(),
    personAssetIds: [person.assetId],
    garmentAssetId: garment.assetId,
    metrics: { heightCm: 170, weightKg: 65, gender: 'female' }
  }, { timeoutMs: 15000 })
  var taskId = created.data.taskId
  // 将 purgeAt 调整到过去，模拟 23h 后到期
  await store.updateTask(taskId, { purgeAt: clock.t - 1000 })
  var out = await cleanupHandler.handle()
  if (!out.ok) throw new Error('cleanup 失败: ' + show(out))
  var data = out.data || {}
  if (data.scanned < 1 || data.deleted < 1) throw new Error('cleanup 未清理到期任务: ' + show(data))
  if (store.__countTasks() !== 0) throw new Error('cleanup 后任务记录残留')
  if (store.__countAssets() !== 0) throw new Error('cleanup 后资产记录残留')
  record('9. sinn-cleanup 到期物理清理（无墓碑、对象+记录全删）', 'pass',
    'scanned=' + data.scanned + '，deleted=' + data.deleted + '，failed=' + data.failed)
}

async function stepQuotaContext() {
  var res = await api.call('sinn-account', 'profile', {}, { requireConsent: false })
  var quota = res.data.quota
  if (!quota || typeof quota.used !== 'number') throw new Error('profile.quota 异常')
  record('10. 额度与同意状态（删除后保留已用额度、同意记录可查询）', 'pass',
    'used=' + quota.used + '，consent=' + (res.data.consent ? res.data.consent.version : 'null'))
}

async function run() {
  try {
    await stepProfileBeforeConsent()
    await stepConsent()
    var capture = await stepCaptureFlow()
    var created = await stepGarmentAndCreateTask(capture.person, capture.metrics)
    var result = await stepGenerating(created.taskId, created.createdAt)
    await stepResult(created.taskId, result)
    await stepDeleteTask(created.taskId)
    await stepDeleteAll()
    await stepCleanup()
    await stepQuotaContext()
  } catch (error) {
    record('全链路自检中断', 'fail', error && error.stack ? error.stack : String(error))
  }

  var summary = {
    generatedAt: new Date().toISOString(),
    environment: {
      cloudEnv: 'not-provided (CP-02)',
      vendor: 'mock (SINN_VENDOR=mock)',
      realDevice: 'not-available',
      devtoolsAutomator: 'blocked (sandbox EPERM)'
    },
    clock: clock.t,
    results: results,
    passed: results.filter(function (r) { return r.status === 'pass' }).length,
    blocked: results.filter(function (r) { return r.status === 'blocked' }).length,
    failed: failures
  }
  var outFile = path.join(ROOT, 'docs/dev/integration-check-result.json')
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8')
  console.log('\n===== 汇总 =====')
  console.log(JSON.stringify({ passed: summary.passed, blocked: summary.blocked, failed: summary.failed }, null, 2))
  console.log('明细已写入 docs/dev/integration-check-result.json')
  process.exitCode = failures > 0 ? 1 : 0
}

run()
