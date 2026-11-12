/**
 * lib/store/memory-store.js —— sinn-model3d 单测用内存数据访问层（等价云数据库语义）。
 *
 * handler 依赖的 store 接口（cloud-store.js 同签名）：
 *   getUser / saveUser / updateUser / getConsent
 *   getTask / getTaskByClientReqId / getActiveModel3dTask / saveTask / updateTask / deleteTask /
 *   listTasksByOpenid / listTasksDue
 *   saveModel / getModel / listModels / deleteModel
 *   getAsset
 *   consumeModel3dDaily / refundModel3dDaily
 *
 * 约定（沿用 P1）：
 * - 所有方法返回 Promise，返回深拷贝；
 * - users 以 openid 为 _id；tasks 以 taskId 为 _id；models 以 modelId 为 _id；
 * - live 3D task = QUEUED/GENERATING/SAVING，user.activeModel3dTaskId 随任务状态自动维护；
 * - 无墓碑：deleteTask/deleteModel 直接物理删除（SPEC-0002 §4）。
 */
'use strict'

var util = require('../util')

var MODEL_TASK_TYPE = util.MODEL_TASK_TYPE
var IN_PROGRESS = util.IN_PROGRESS

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function defaultConfig() {
  return { vendorProvider3d: 'mock', model3dDailyLimit: 0 }
}

function createMemoryStore(options) {
  options = options || {}
  var config = Object.assign(defaultConfig(), options.config || {})
  var users = {}
  var tasks = {}
  var models = {}
  var assets = {}

  function ensureUser(openid) {
    if (!users[openid]) {
      users[openid] = {
        openid: openid,
        consentVersion: null,
        consentAt: null,
        ageConfirmedAt: null,
        revokedAt: null,
        consentVersion3d: null,
        activeModel3dTaskId: null,
        model3dUsedDayKey: '',
        model3dUsedToday: 0
      }
    }
    return users[openid]
  }

  function syncActive(task) {
    if (!task || !task.openid) return
    var user = users[task.openid]
    if (!user) return
    if (IN_PROGRESS.indexOf(task.status) >= 0) {
      user.activeModel3dTaskId = task.taskId
    } else if (user.activeModel3dTaskId === task.taskId) {
      user.activeModel3dTaskId = null
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

    updateUser: function (openid, patch) {
      var user = ensureUser(openid)
      Object.assign(user, clone(patch || {}))
      return Promise.resolve(clone(user))
    },

    getConsent: function (openid) {
      var user = users[openid]
      if (!user || !user.consentVersion || user.revokedAt || !user.ageConfirmedAt) {
        return Promise.resolve(null)
      }
      return Promise.resolve({
        version: user.consentVersion,
        agreedAt: user.consentAt,
        ageConfirmedAt: user.ageConfirmedAt,
        // TODO(DEV-0002-06)：3D 披露节版本（consentVersion3d）确定后，此处要求 >= 该版本。
        version3d: user.consentVersion3d || null
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

    getActiveModel3dTask: function (openid) {
      var user = users[openid]
      if (!user || !user.activeModel3dTaskId) return Promise.resolve(null)
      var task = tasks[user.activeModel3dTaskId]
      if (!task || task.taskType !== MODEL_TASK_TYPE || IN_PROGRESS.indexOf(task.status) < 0) {
        user.activeModel3dTaskId = null
        return Promise.resolve(null)
      }
      return Promise.resolve(clone(task))
    },

    saveTask: function (task) {
      if (!task || !task.taskId) return Promise.reject(new Error('saveTask 需要 taskId'))
      tasks[task.taskId] = clone(task)
      syncActive(tasks[task.taskId])
      return Promise.resolve(clone(tasks[task.taskId]))
    },

    updateTask: function (taskId, patch) {
      var task = tasks[taskId]
      if (!task) return Promise.reject(new Error('updateTask: 任务不存在 ' + taskId))
      Object.assign(task, clone(patch || {}))
      syncActive(task)
      return Promise.resolve(clone(task))
    },

    deleteTask: function (taskId) {
      var task = tasks[taskId]
      if (!task) return Promise.resolve(false)
      var user = users[task.openid]
      if (user && user.activeModel3dTaskId === taskId) user.activeModel3dTaskId = null
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

    /** 清理用：purgeAt <= now 的任务，按 purgeAt 升序取前 limit 条（含 2D/3D，调用方自过滤）。 */
    listTasksDue: function (nowMs, limit) {
      var cap = typeof limit === 'number' && limit > 0 ? limit : 100
      return Promise.resolve(
        Object.keys(tasks)
          .map(function (id) { return clone(tasks[id]) })
          .filter(function (task) {
            return util.isFiniteNumber(task.purgeAt) && task.purgeAt <= nowMs
          })
          .sort(function (a, b) { return a.purgeAt - b.purgeAt })
          .slice(0, cap)
      )
    },

    // ---- models ----
    saveModel: function (model) {
      if (!model || !model.modelId) return Promise.reject(new Error('saveModel 需要 modelId'))
      models[model.modelId] = clone(model)
      return Promise.resolve(clone(models[model.modelId]))
    },

    getModel: function (modelId) {
      return Promise.resolve(models[modelId] ? clone(models[modelId]) : null)
    },

    updateModel: function (modelId, patch) {
      var model = models[modelId]
      if (!model) return Promise.reject(new Error('updateModel: 模型不存在 ' + modelId))
      Object.assign(model, clone(patch || {}))
      return Promise.resolve(clone(model))
    },

    deleteModel: function (modelId) {
      if (!models[modelId]) return Promise.resolve(false)
      delete models[modelId]
      return Promise.resolve(true)
    },

    /** 列表：openid 过滤 + createdAt 倒序 + cursor(createdAt|modelId) 分页。 */
    listModels: function (openid, params) {
      params = params || {}
      var limit = util.isFiniteNumber(params.limit) && params.limit > 0 ? Math.min(20, Math.floor(params.limit)) : 20
      var cursor = params.cursor || null
      var items = Object.keys(models)
        .map(function (id) { return clone(models[id]) })
        .filter(function (model) { return model.openid === openid })
        .sort(function (a, b) {
          if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
          return a.modelId < b.modelId ? 1 : -1
        })
      if (cursor) {
        items = items.filter(function (model) {
          if (model.createdAt < cursor.createdAt) return true
          if (model.createdAt > cursor.createdAt) return false
          return model.modelId < cursor.modelId
        })
      }
      var page = items.slice(0, limit)
      var nextCursor = items.length > limit ? util.encodeCursor(page[page.length - 1]) : null
      return Promise.resolve({ items: page, nextCursor: nextCursor, total: items.length })
    },

    // ---- assets（P1 assetRegister 写入；submit 时绑定 taskId 供 cleanup 物理删除） ----
    getAsset: function (assetId) {
      return Promise.resolve(assets[assetId] ? clone(assets[assetId]) : null)
    },

    updateAsset: function (assetId, patch) {
      var asset = assets[assetId]
      if (!asset) return Promise.reject(new Error('updateAsset: 资产不存在 ' + assetId))
      Object.assign(asset, clone(patch || {}))
      return Promise.resolve(clone(asset))
    },

    // ---- 3D 日上限（默认 0=不限；配置 N 时第 N+1 次拒绝 6006） ----
    consumeModel3dDaily: function (params) {
      params = params || {}
      var openid = params.openid
      var nowMs = util.isFiniteNumber(params.now) ? params.now : Date.now()
      var limit = util.isFiniteNumber(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 0
      var user = ensureUser(openid)
      var dayKey = util.beijingDayKey(nowMs)
      if (user.model3dUsedDayKey !== dayKey) {
        user.model3dUsedDayKey = dayKey
        user.model3dUsedToday = 0
      }
      if (limit > 0 && user.model3dUsedToday >= limit) {
        return Promise.resolve({
          ok: false,
          used: user.model3dUsedToday,
          limit: limit,
          dayKey: dayKey,
          resetAt: util.beijingResetAt(nowMs)
        })
      }
      user.model3dUsedToday = (user.model3dUsedToday || 0) + 1
      return Promise.resolve({
        ok: true,
        used: user.model3dUsedToday,
        limit: limit,
        dayKey: dayKey,
        resetAt: util.beijingResetAt(nowMs)
      })
    },

    refundModel3dDaily: function (openid) {
      var user = ensureUser(openid)
      user.model3dUsedToday = Math.max(0, (user.model3dUsedToday || 0) - 1)
      return Promise.resolve(clone(user))
    },

    // ---- test helpers ----
    __snapshot: function () {
      return clone({ users: users, tasks: tasks, models: models, assets: assets, config: config })
    },
    __countTasks: function () {
      return Object.keys(tasks).length
    },
    __countModels: function () {
      return Object.keys(models).length
    },
    __seedAsset: function (asset) {
      assets[asset.assetId] = clone(asset)
      return clone(assets[asset.assetId])
    }
  }

  return store
}

module.exports = {
  createMemoryStore: createMemoryStore,
  defaultConfig: defaultConfig
}
