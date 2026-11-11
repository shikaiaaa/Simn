/**
 * lib/store/memory-store.js —— 单测用内存数据访问层（等价云数据库语义）。
 *
 * 云函数 handler 的 store 依赖接口（cloud-store.js 同签名）：
 *   getConfig / getUser / saveUser / getConsent /
 *   getTask / getTaskByClientReqId / getActiveTask / saveTask / updateTask / deleteTask /
 *   saveAsset / getAsset / updateAsset / deleteAsset / listAssetsByTaskId / findAssetByClientReqId /
 *   consumeQuota / refundQuota
 *
 * 约定：
 * - 所有方法返回 Promise，便于在 Node 单测与云函数中复用同一套 handler；
 * - 返回的都是深拷贝，测试断言不会污染内部状态；
 * - users 以 openid 为 _id、tasks 以 taskId 为 _id、assets 以 assetId 为 _id；
 * - live task = QUEUED/GENERATING/SAVING，用户 activeTaskId 随任务状态自动维护；
 * - 无 tombstone：deleteTask/deleteAsset 直接物理删（SPEC §4）。
 */
'use strict'

var util = require('../util')

var IN_PROGRESS = ['QUEUED', 'GENERATING', 'SAVING']

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function defaultConfig() {
  return {
    dailyLimitNormal: 1,
    dailyLimitVip: 10,
    vipWhitelist: [],
    vendorProvider: 'mock',
    sizeMappingVersion: '2026-11-09-v1'
  }
}

function createMemoryStore(options) {
  options = options || {}
  var config = Object.assign(defaultConfig(), options.config || {})
  var users = {}
  var tasks = {}
  var assets = {}

  function ensureUser(openid) {
    if (!users[openid]) {
      users[openid] = {
        openid: openid,
        dayKey: '',
        usedToday: 0,
        dailyLimit: 0,
        vip: false,
        vipSource: null,
        activeTaskId: null,
        consentVersion: null,
        consentAt: null,
        ageConfirmedAt: null,
        revokedAt: null
      }
    }
    return users[openid]
  }

  function clearActive(openid, taskId) {
    var user = users[openid]
    if (user && (!taskId || user.activeTaskId === taskId)) user.activeTaskId = null
  }

  function syncActive(user, task) {
    if (!user) return
    if (IN_PROGRESS.indexOf(task.status) >= 0) {
      user.activeTaskId = task.taskId
    } else if (user.activeTaskId === task.taskId) {
      user.activeTaskId = null
    }
  }

  var store = {
    // ---- config / user / consent ----
    getConfig: function () {
      return Promise.resolve(clone(config))
    },

    getUser: function (openid) {
      return Promise.resolve(users[openid] ? clone(users[openid]) : null)
    },

    saveUser: function (user) {
      if (!user || !user.openid) return Promise.reject(new Error('saveUser 需要 openid'))
      users[user.openid] = clone(user)
      return Promise.resolve(clone(users[user.openid]))
    },

    getConsent: function (openid) {
      var user = users[openid]
      if (!user || !user.consentVersion || user.revokedAt || !user.ageConfirmedAt) {
        return Promise.resolve(null)
      }
      return Promise.resolve({
        version: user.consentVersion,
        agreedAt: user.consentAt,
        ageConfirmedAt: user.ageConfirmedAt
      })
    },

    // ---- tasks ----
    getTask: function (taskId) {
      return Promise.resolve(tasks[taskId] ? clone(tasks[taskId]) : null)
    },

    getTaskByClientReqId: function (openid, clientReqId) {
      var ids = Object.keys(tasks)
      for (var i = 0; i < ids.length; i += 1) {
        var task = tasks[ids[i]]
        if (task.openid === openid && task.clientReqId === clientReqId) return Promise.resolve(clone(task))
      }
      return Promise.resolve(null)
    },

    getActiveTask: function (openid) {
      var user = users[openid]
      if (!user || !user.activeTaskId) return Promise.resolve(null)
      var task = tasks[user.activeTaskId]
      if (!task || IN_PROGRESS.indexOf(task.status) < 0) {
        user.activeTaskId = null
        return Promise.resolve(null)
      }
      return Promise.resolve(clone(task))
    },

    saveTask: function (task) {
      if (!task || !task.taskId) return Promise.reject(new Error('saveTask 需要 taskId'))
      tasks[task.taskId] = clone(task)
      syncActive(users[task.openid], tasks[task.taskId])
      return Promise.resolve(clone(tasks[task.taskId]))
    },

    updateTask: function (taskId, patch) {
      var task = tasks[taskId]
      if (!task) return Promise.reject(new Error('updateTask: 任务不存在 ' + taskId))
      Object.assign(task, clone(patch || {}))
      task.statusUpdatedAt = patch && patch.statusUpdatedAt !== undefined ? patch.statusUpdatedAt : task.statusUpdatedAt
      syncActive(users[task.openid], task)
      return Promise.resolve(clone(task))
    },

    deleteTask: function (taskId) {
      var task = tasks[taskId]
      if (!task) return Promise.resolve(false)
      clearActive(task.openid, taskId)
      delete tasks[taskId]
      return Promise.resolve(true)
    },

    listTasksByOpenid: function (openid) {
      return Promise.resolve(
        Object.keys(tasks)
          .map(function (id) { return clone(tasks[id]) })
          .filter(function (task) { return task.openid === openid })
      )
    },

    /** 清理到期任务（sinn-cleanup 用）：purgeAt <= now，按 purgeAt 升序取前 limit 条。 */
    listTasksDue: function (nowMs, limit) {
      var cap = typeof limit === 'number' && limit > 0 ? limit : 100
      return Promise.resolve(
        Object.keys(tasks)
          .map(function (id) { return clone(tasks[id]) })
          .filter(function (task) {
            return typeof task.purgeAt === 'number' && task.purgeAt <= nowMs
          })
          .sort(function (a, b) { return a.purgeAt - b.purgeAt })
          .slice(0, cap)
      )
    },

    // ---- assets ----
    saveAsset: function (asset) {
      if (!asset || !asset.assetId) return Promise.reject(new Error('saveAsset 需要 assetId'))
      assets[asset.assetId] = clone(asset)
      return Promise.resolve(clone(assets[asset.assetId]))
    },

    getAsset: function (assetId) {
      return Promise.resolve(assets[assetId] ? clone(assets[assetId]) : null)
    },

    updateAsset: function (assetId, patch) {
      var asset = assets[assetId]
      if (!asset) return Promise.reject(new Error('updateAsset: 资产不存在 ' + assetId))
      Object.assign(asset, clone(patch || {}))
      return Promise.resolve(clone(asset))
    },

    deleteAsset: function (assetId) {
      if (!assets[assetId]) return Promise.resolve(false)
      delete assets[assetId]
      return Promise.resolve(true)
    },

    listAssetsByTaskId: function (taskId) {
      return Promise.resolve(
        Object.keys(assets)
          .map(function (id) { return clone(assets[id]) })
          .filter(function (asset) { return asset.taskId === taskId })
      )
    },

    findAssetByClientReqId: function (openid, clientReqId) {
      var ids = Object.keys(assets)
      for (var i = 0; i < ids.length; i += 1) {
        var asset = assets[ids[i]]
        if (asset.openid === openid && asset.clientReqId === clientReqId) return Promise.resolve(clone(asset))
      }
      return Promise.resolve(null)
    },

    // ---- quota ----
    /**
     * 预扣额度（SPEC §3）。dayKey 惰性重置：跨天第一次访问清零 usedToday。
     * VIP 依据 config.vipWhitelist（CP-09 白名单未定，先按 config 注入）。
     */
    consumeQuota: function (params) {
      params = params || {}
      var openid = params.openid
      var nowMs = typeof params.now === 'number' ? params.now : Date.now()
      var user = ensureUser(openid)
      var dayKey = util.beijingDayKey(nowMs)
      var vip = (config.vipWhitelist || []).indexOf(openid) >= 0
      var limit = vip ? config.dailyLimitVip : config.dailyLimitNormal
      if (user.dayKey !== dayKey) {
        user.dayKey = dayKey
        user.usedToday = 0
      }
      user.vip = vip
      user.dailyLimit = limit
      if (user.usedToday >= limit) {
        return Promise.resolve({
          ok: false,
          user: clone(user),
          quota: {
            used: user.usedToday,
            limit: limit,
            remaining: 0,
            vip: vip,
            dayKey: dayKey,
            resetAt: util.beijingResetAt(nowMs)
          }
        })
      }
      user.usedToday += 1
      return Promise.resolve({
        ok: true,
        user: clone(user),
        quota: {
          used: user.usedToday,
          limit: limit,
          remaining: Math.max(0, limit - user.usedToday),
          vip: vip,
          dayKey: dayKey,
          resetAt: util.beijingResetAt(nowMs)
        }
      })
    },

    /** 返还一次额度（幂等由调用方用 task.quotaRefunded 保证）。不跨天返还。 */
    refundQuota: function (openid) {
      var user = ensureUser(openid)
      user.usedToday = Math.max(0, user.usedToday - 1)
      return Promise.resolve(clone(user))
    },

    // ---- test helpers ----
    __snapshot: function () {
      return clone({ users: users, tasks: tasks, assets: assets, config: config })
    },
    __countTasks: function () {
      return Object.keys(tasks).length
    },
    __countAssets: function () {
      return Object.keys(assets).length
    }
  }

  return store
}

module.exports = {
  createMemoryStore: createMemoryStore,
  defaultConfig: defaultConfig
}
