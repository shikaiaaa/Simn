/**
 * lib/store/cloud-store.js —— 云开发数据库访问层（生产实现，本地单测不加载）。
 *
 * 复用 P1 cloud-store 的三条真实云环境约束（DEV-0001 §30/§35/§37）：
 * - doc(id).set()/update() 的 data 不允许包含 `_id`（自定义 _id 只在 collection.add 允许）；
 * - set()/update() 的 data 不允许包含 `undefined`（嵌套对象/数组元素同样不允许）；
 * - update() 对对象字段是深合并，父字段为 null 时报 -502001；本文件对顶层普通对象统一用
 *   db.command.set 整字段替换，避免同类错误。
 *
 * 集合：sinn_users / sinn_tasks / sinn_assets / sinn_models3d / sinn_config。
 * 语义与 memory-store 一致（返回 Promise、深拷贝语义由读回实现）。
 *
 * 集合与索引创建属部署步骤：sinn_models3d 由 index.js 冷启动时尽力 createCollection，
 * 索引 idx_models_openid_created / idx_models_openid_status 在云开发控制台或 CLI 创建
 * （见 docs/dev/DEV-0002.md §DEV-0002-03）。
 */
'use strict'

var util = require('../util')

var MODEL_TASK_TYPE = util.MODEL_TASK_TYPE
var IN_PROGRESS = util.IN_PROGRESS
var COLLECTIONS = {
  users: 'sinn_users',
  tasks: 'sinn_tasks',
  assets: 'sinn_assets',
  models: 'sinn_models3d',
  config: 'sinn_config'
}

function createCloudStore(options) {
  options = options || {}
  var db = options.db
  if (!db) throw new Error('createCloudStore 需要注入 db（cloud.database()）')
  var command = db.command
  var config = Object.assign({ vendorProvider3d: 'mock', model3dDailyLimit: 0 }, options.config || {})

  function collection(name) {
    return db.collection(name)
  }

  function stripId(doc) {
    var data = Object.assign({}, doc || {})
    delete data._id
    return data
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false
    var proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  function sanitizeWriteData(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return item === undefined ? null : sanitizeWriteData(item)
      })
    }
    if (isPlainObject(value)) {
      var out = {}
      Object.keys(value).forEach(function (key) {
        if (value[key] === undefined) return
        out[key] = sanitizeWriteData(value[key])
      })
      return out
    }
    return value
  }

  function setDoc(name, id, doc) {
    var data = sanitizeWriteData(stripId(doc))
    if (Object.keys(data).length === 0) return Promise.resolve({ skipped: true })
    return collection(name).doc(id).set({ data: data })
  }

  function prepareUpdateData(patch) {
    var data = sanitizeWriteData(stripId(patch))
    if (!command || typeof command.set !== 'function') return data
    var out = {}
    Object.keys(data).forEach(function (key) {
      var value = data[key]
      out[key] = isPlainObject(value) ? command.set(value) : value
    })
    return out
  }

  function updateDoc(name, id, patch) {
    var data = prepareUpdateData(patch)
    if (Object.keys(data).length === 0) return Promise.resolve({ skipped: true, stats: { updated: 0 } })
    return collection(name).doc(id).update({ data: data })
  }

  function unwrapDoc(res) {
    if (!res) return null
    var data = res.data
    if (Array.isArray(data)) return data[0] || null
    return data || null
  }

  async function getDoc(name, id) {
    try {
      var doc = unwrapDoc(await collection(name).doc(id).get())
      if (doc && doc._id === undefined) doc._id = id
      return doc
    } catch (error) {
      return null
    }
  }

  async function queryOne(name, where) {
    var res = await collection(name).where(where).limit(1).get()
    var list = (res && res.data) || []
    return list[0] || null
  }

  async function syncActive(task) {
    if (!task || !task.openid) return
    var user = await getDoc(COLLECTIONS.users, task.openid)
    if (!user) return
    var patch = null
    if (IN_PROGRESS.indexOf(task.status) >= 0) {
      if (user.activeModel3dTaskId !== task.taskId) patch = { activeModel3dTaskId: task.taskId }
    } else if (user.activeModel3dTaskId === task.taskId) {
      patch = { activeModel3dTaskId: null }
    }
    if (patch) await updateDoc(COLLECTIONS.users, task.openid, patch)
  }

  return {
    raw: function () { return db },
    collections: COLLECTIONS,

    getConfig: async function () {
      try {
        var docs = await collection(COLLECTIONS.config).limit(1).get()
        var remote = (docs && docs.data && docs.data[0]) || null
        return remote ? Object.assign({}, config, remote) : config
      } catch (error) {
        return config
      }
    },

    getUser: function (openid) {
      return getDoc(COLLECTIONS.users, openid)
    },

    saveUser: async function (user) {
      if (!user || !user.openid) throw new Error('saveUser 需要 openid')
      await setDoc(COLLECTIONS.users, user.openid, Object.assign({}, user, { _id: user.openid }))
      return user
    },

    updateUser: async function (openid, patch) {
      await updateDoc(COLLECTIONS.users, openid, patch)
      return getDoc(COLLECTIONS.users, openid)
    },

    getConsent: async function (openid) {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (!user || !user.consentVersion || user.revokedAt || !user.ageConfirmedAt) return null
      return {
        version: user.consentVersion,
        agreedAt: user.consentAt,
        ageConfirmedAt: user.ageConfirmedAt,
        // TODO(DEV-0002-06)：3D 披露节版本（consentVersion3d）确定后，此处要求 >= 该版本。
        version3d: user.consentVersion3d || null
      }
    },

    getTask: function (taskId) {
      return getDoc(COLLECTIONS.tasks, taskId)
    },

    getTaskByClientReqId: function (openid, clientReqId) {
      return queryOne(COLLECTIONS.tasks, {
        openid: openid,
        clientReqId: clientReqId,
        taskType: MODEL_TASK_TYPE
      })
    },

    getActiveModel3dTask: async function (openid) {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (!user || !user.activeModel3dTaskId) return null
      var task = await getDoc(COLLECTIONS.tasks, user.activeModel3dTaskId)
      if (!task || task.taskType !== MODEL_TASK_TYPE || IN_PROGRESS.indexOf(task.status) < 0) {
        await updateDoc(COLLECTIONS.users, openid, { activeModel3dTaskId: null })
        return null
      }
      return task
    },

    saveTask: async function (task) {
      if (!task || !task.taskId) throw new Error('saveTask 需要 taskId')
      await setDoc(COLLECTIONS.tasks, task.taskId, Object.assign({}, task, { _id: task.taskId }))
      await syncActive(task)
      return task
    },

    updateTask: async function (taskId, patch) {
      await updateDoc(COLLECTIONS.tasks, taskId, patch)
      var task = await getDoc(COLLECTIONS.tasks, taskId)
      if (task) await syncActive(task)
      return task
    },

    deleteTask: async function (taskId) {
      var task = await getDoc(COLLECTIONS.tasks, taskId)
      if (!task) return false
      await collection(COLLECTIONS.tasks).doc(taskId).remove()
      var user = await getDoc(COLLECTIONS.users, task.openid)
      if (user && user.activeModel3dTaskId === taskId) {
        await updateDoc(COLLECTIONS.users, task.openid, { activeModel3dTaskId: null })
      }
      return true
    },

    listTasksByOpenid: async function (openid) {
      var res = await collection(COLLECTIONS.tasks).where({ openid: openid }).limit(100).get()
      return (res && res.data) || []
    },

    listTasksDue: async function (nowMs, limit) {
      var cap = typeof limit === 'number' && limit > 0 ? limit : 100
      var res = await collection(COLLECTIONS.tasks)
        .where({ purgeAt: command.lte(nowMs) })
        .orderBy('purgeAt', 'asc')
        .limit(cap)
        .get()
      return (res && res.data) || []
    },

    saveModel: async function (model) {
      if (!model || !model.modelId) throw new Error('saveModel 需要 modelId')
      await setDoc(COLLECTIONS.models, model.modelId, Object.assign({}, model, { _id: model.modelId }))
      return model
    },

    getModel: function (modelId) {
      return getDoc(COLLECTIONS.models, modelId)
    },

    updateModel: async function (modelId, patch) {
      await updateDoc(COLLECTIONS.models, modelId, patch)
      return getDoc(COLLECTIONS.models, modelId)
    },

    deleteModel: async function (modelId) {
      try {
        await collection(COLLECTIONS.models).doc(modelId).remove()
        return true
      } catch (error) {
        return false
      }
    },

    /**
     * 列表：openid + createdAt 倒序；cursor = {createdAt, modelId}。
     * 云数据库复合分页用 command.lte + 内存过滤（demo 单用户数据量小；索引见部署文档）。
     */
    listModels: async function (openid, params) {
      params = params || {}
      var limit = util.isFiniteNumber(params.limit) && params.limit > 0 ? Math.min(20, Math.floor(params.limit)) : 20
      var cursor = params.cursor || null
      var where = { openid: openid }
      if (cursor) where.createdAt = command.lte(cursor.createdAt)
      var res = await collection(COLLECTIONS.models)
        .where(where)
        .orderBy('createdAt', 'desc')
        .limit(limit + 1)
        .get()
      var items = ((res && res.data) || []).slice()
      if (cursor) {
        items = items.filter(function (model) {
          if (model.createdAt < cursor.createdAt) return true
          if (model.createdAt > cursor.createdAt) return false
          return model.modelId < cursor.modelId
        })
      }
      var page = items.slice(0, limit)
      var nextCursor = items.length > limit ? util.encodeCursor(page[page.length - 1]) : null
      return { items: page, nextCursor: nextCursor, total: items.length }
    },

    getAsset: function (assetId) {
      return getDoc(COLLECTIONS.assets, assetId)
    },

    updateAsset: async function (assetId, patch) {
      await updateDoc(COLLECTIONS.assets, assetId, patch)
      return getDoc(COLLECTIONS.assets, assetId)
    },

    /** 3D 日上限：默认 0=不限；配置 N 时第 N+1 次拒绝（并发 1 由任务层保证，无原子竞争）。 */
    consumeModel3dDaily: async function (params) {
      params = params || {}
      var openid = params.openid
      var nowMs = util.isFiniteNumber(params.now) ? params.now : Date.now()
      var limit = util.isFiniteNumber(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 0
      var dayKey = util.beijingDayKey(nowMs)
      var user = await getDoc(COLLECTIONS.users, openid)
      if (!user) {
        user = {
          openid: openid,
          consentVersion: null,
          consentAt: null,
          ageConfirmedAt: null,
          revokedAt: null,
          consentVersion3d: null,
          activeModel3dTaskId: null,
          model3dUsedDayKey: dayKey,
          model3dUsedToday: 0
        }
        await setDoc(COLLECTIONS.users, openid, user)
      } else if (user.model3dUsedDayKey !== dayKey) {
        await updateDoc(COLLECTIONS.users, openid, { model3dUsedDayKey: dayKey, model3dUsedToday: 0 })
        user.model3dUsedDayKey = dayKey
        user.model3dUsedToday = 0
      }
      var used = util.isFiniteNumber(user.model3dUsedToday) ? user.model3dUsedToday : 0
      if (limit > 0 && used >= limit) {
        return { ok: false, used: used, limit: limit, dayKey: dayKey, resetAt: util.beijingResetAt(nowMs) }
      }
      var next = used + 1
      await updateDoc(COLLECTIONS.users, openid, { model3dUsedToday: next })
      return { ok: true, used: next, limit: limit, dayKey: dayKey, resetAt: util.beijingResetAt(nowMs) }
    },

    refundModel3dDaily: async function (openid) {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (user && util.isFiniteNumber(user.model3dUsedToday) && user.model3dUsedToday > 0) {
        await updateDoc(COLLECTIONS.users, openid, { model3dUsedToday: user.model3dUsedToday - 1 })
      }
      return getDoc(COLLECTIONS.users, openid)
    }
  }
}

module.exports = {
  createCloudStore: createCloudStore,
  COLLECTIONS: COLLECTIONS
}
