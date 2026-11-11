/**
 * lib/store/cloud-store.js —— 云开发数据库访问层（生产实现，本地单测不加载）。
 *
 * task-30 修复（真实云环境实测）：微信云数据库 doc(id).set()/update() 的 data
 * **不允许包含 `_id`**（自定义 _id 只在 collection.add({data:{_id}}) 场景允许；
 * set/update 带 _id 会抛 -501001 错误）。此前 saveUser/saveTask/saveAsset 与
 * consumeQuota 首次建用户都在 data 里带了 _id，导致云端首写即 E_INTERNAL；
 * 现统一由 stripId 去掉 _id，getDoc 读回时补 _id 以保持与 memory-store 语义一致。
 *
 * task-35 修复（真实云环境实测）：微信云数据库 set/update 的 data **不允许包含
 * `undefined`**（嵌套对象/数组元素同样不允许）。此前 handler.precheck 的 record 把
 * normalizeResult 的可选字段（pass/unknown 分支为 undefined）一并写入，导致 precheck
 * 真实云 E_INTERNAL。现统一经 sanitizeWriteData 递归剔除 undefined，空 patch 跳过写入。
 *
 * task-37 修复（真实云环境实测）：微信云数据库 doc().update({data}) 对**对象型字段做
 * 深合并**——若目标字段当前是 `null`（如 assetRegister 初始化的 `precheck: null`），
 * 再写入对象子字段会报 `-502001 Cannot create field 'at' in element {precheck: null}`。
 * 现 updateDoc 对 patch 中的**顶层普通对象**统一用 `db.command.set(value)` 整字段替换，
 * 不再深合并；标量/数组/命令对象（inc、lt 等）保持原语义。因此 update 的对象字段是
 * 「整体替换」语义，调用方要写对象字段时请给完整对象，不要依赖部分字段合并。
 *
 * 依赖由 index.js 注入 `wx-server-sdk` 的 db 实例；本地无 envId，无法在沙箱验证。
 * 部署步骤见 docs/dev/DEV-0001.md 及本文件顶部注释：
 * 1) 云开发控制台创建集合：sinn_users / sinn_tasks / sinn_assets / sinn_config，
 *    权限均设为「仅创建者可读写」（云函数默认拥有 admin 权限，绕过规则）；
 * 2) sinn_users 的 _id 存 openid；sinn_tasks 的 _id 存 taskId；sinn_assets 的 _id 存 assetId；
 * 3) 建议索引：sinn_tasks(openid+clientReqId 唯一复合)、sinn_tasks(openid+status)、
 *    sinn_tasks(purgeAt)、sinn_assets(openid+clientReqId)、sinn_assets(taskId)；
 * 4) 构建索引与集合创建属于部署步骤，CP-02 环境开通后执行。
 *
 * 语义与 memory-store 完全一致（所有方法返回 Promise、返回深拷贝语义）。
 * 后台任务（cleanup）可直接使用本模块暴露的 `raw()` 访问 db。
 */
'use strict'

var util = require('../util')

var IN_PROGRESS = ['QUEUED', 'GENERATING', 'SAVING']
var COLLECTIONS = {
  users: 'sinn_users',
  tasks: 'sinn_tasks',
  assets: 'sinn_assets',
  config: 'sinn_config'
}

function createCloudStore(options) {
  options = options || {}
  var db = options.db
  if (!db) throw new Error('createCloudStore 需要注入 db（cloud.database()）')
  var config = Object.assign(
    {
      dailyLimitNormal: 1,
      dailyLimitVip: 10,
      vipWhitelist: [],
      vendorProvider: 'mock',
      sizeMappingVersion: '2026-11-09-v1'
    },
    options.config || {}
  )
  var command = db.command

  function collection(name) {
    return db.collection(name)
  }

  /**
   * task-30：微信云数据库 doc(id).set()/update() 的 data 不允许包含 _id
   * （自定义 _id 只在 collection.add({data:{_id}}) 场景允许；set/update 带 _id 会抛错）。
   * 所有写入统一经 stripId 去掉 _id；读取时 getDoc 自行补 _id，保持与 memory-store 语义一致。
   */
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

  /**
   * task-35：微信云数据库 set/update 的 data 不允许包含 undefined（嵌套对象/数组元素同样
   * 不允许；memory-store 不校验，导致真实的 precheck/updateTask 写库 E_INTERNAL）。
   * 递归删除对象中值为 undefined 的键、数组元素 undefined 归一为 null；
   * 保留 null/false/0/''；返回新对象，不修改入参。
   */
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
    // 空 data 不写库（避免覆盖/非法空 update）；调用方按 skipped 正常继续。
    if (Object.keys(data).length === 0) return Promise.resolve({ skipped: true })
    return collection(name).doc(id).set({ data: data })
  }

  /**
   * task-37：update 的对象字段改用 db.command.set 整字段替换，避免「父字段为 null 时
   * 深合并子字段」报 -502001（真实云 precheck: null 场景实测）。标量、数组、命令对象
   * 不包装，保持原有 update 语义。command 不可用（如 fake db）时退化为原样 data。
   */
  function prepareUpdateData(patch) {
    var data = sanitizeWriteData(stripId(patch))
    if (!command || typeof command.set !== 'function') return data
    var out = {}
    Object.keys(data).forEach(function (key) {
      var value = data[key]
      // 只对顶层普通对象做整字段替换；数组在 update 中本身就是整体赋值，不需要 set。
      out[key] = isPlainObject(value) ? command.set(value) : value
    })
    return out
  }

  function updateDoc(name, id, patch) {
    var data = prepareUpdateData(patch)
    // 空 patch 不发 update（云数据库空 data 非法；语义上也没有需要更新的字段）。
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
      // 记录不存在时 wx-server-sdk 会抛错，统一按 null 处理
      return null
    }
  }

  async function queryOne(name, where) {
    var res = await collection(name).where(where).limit(1).get()
    var list = (res && res.data) || []
    return list[0] || null
  }

  async function syncActive(openid, task) {
    if (!openid) return
    if (IN_PROGRESS.indexOf(task.status) >= 0) {
      await updateDoc(COLLECTIONS.users, openid, { activeTaskId: task.taskId })
    } else {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (user && user.activeTaskId === task.taskId) {
        await updateDoc(COLLECTIONS.users, openid, { activeTaskId: null })
      }
    }
  }

  return {
    raw: function () { return db },
    collections: COLLECTIONS,

    getConfig: async function () {
      var docs = await collection(COLLECTIONS.config).limit(1).get()
      var remote = (docs && docs.data && docs.data[0]) || null
      return remote ? Object.assign({}, config, remote) : config
    },

    getUser: function (openid) {
      return getDoc(COLLECTIONS.users, openid)
    },

    saveUser: async function (user) {
      if (!user || !user.openid) throw new Error('saveUser 需要 openid')
      // task-30：set 的 data 不含 _id（文档 id 即 user.openid）
      await setDoc(COLLECTIONS.users, user.openid, Object.assign({}, user, { _id: user.openid }))
      return user
    },

    getConsent: async function (openid) {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (!user || !user.consentVersion || user.revokedAt || !user.ageConfirmedAt) return null
      return { version: user.consentVersion, agreedAt: user.consentAt, ageConfirmedAt: user.ageConfirmedAt }
    },

    getTask: function (taskId) {
      return getDoc(COLLECTIONS.tasks, taskId)
    },

    getTaskByClientReqId: function (openid, clientReqId) {
      return queryOne(COLLECTIONS.tasks, { openid: openid, clientReqId: clientReqId })
    },

    getActiveTask: async function (openid) {
      var user = await getDoc(COLLECTIONS.users, openid)
      if (!user || !user.activeTaskId) return null
      var task = await getDoc(COLLECTIONS.tasks, user.activeTaskId)
      if (!task || IN_PROGRESS.indexOf(task.status) < 0) {
        if (user.activeTaskId) {
          await updateDoc(COLLECTIONS.users, openid, { activeTaskId: null })
        }
        return null
      }
      return task
    },

    saveTask: async function (task) {
      if (!task || !task.taskId) throw new Error('saveTask 需要 taskId')
      // task-30：set 的 data 不含 _id（文档 id 即 task.taskId）
      await setDoc(COLLECTIONS.tasks, task.taskId, Object.assign({}, task, { _id: task.taskId }))
      await syncActive(task.openid, task)
      return task
    },

    updateTask: async function (taskId, patch) {
      // task-30：update 的 data 同样不允许 _id，统一 stripId
      await updateDoc(COLLECTIONS.tasks, taskId, patch)
      var task = await getDoc(COLLECTIONS.tasks, taskId)
      if (task) await syncActive(task.openid, task)
      return task
    },

    deleteTask: async function (taskId) {
      var task = await getDoc(COLLECTIONS.tasks, taskId)
      if (!task) return false
      await collection(COLLECTIONS.tasks).doc(taskId).remove()
      await syncActive(task.openid, Object.assign({}, task, { status: 'DELETED' }))
      return true
    },

    listTasksByOpenid: async function (openid) {
      var res = await collection(COLLECTIONS.tasks).where({ openid: openid }).limit(100).get()
      return (res && res.data) || []
    },

    /** 清理到期任务（sinn-cleanup 用）：purgeAt <= now，按 purgeAt 升序取前 limit 条。 */
    listTasksDue: async function (nowMs, limit) {
      var cap = typeof limit === 'number' && limit > 0 ? limit : 100
      var res = await collection(COLLECTIONS.tasks)
        .where({ purgeAt: command.lte(nowMs) })
        .orderBy('purgeAt', 'asc')
        .limit(cap)
        .get()
      return (res && res.data) || []
    },

    saveAsset: async function (asset) {
      if (!asset || !asset.assetId) throw new Error('saveAsset 需要 assetId')
      // task-30：set 的 data 不含 _id（文档 id 即 asset.assetId）
      await setDoc(COLLECTIONS.assets, asset.assetId, Object.assign({}, asset, { _id: asset.assetId }))
      return asset
    },

    getAsset: function (assetId) {
      return getDoc(COLLECTIONS.assets, assetId)
    },

    updateAsset: async function (assetId, patch) {
      // task-30：update 的 data 同样不允许 _id，统一 stripId
      await updateDoc(COLLECTIONS.assets, assetId, patch)
      return getDoc(COLLECTIONS.assets, assetId)
    },

    deleteAsset: async function (assetId) {
      try {
        await collection(COLLECTIONS.assets).doc(assetId).remove()
        return true
      } catch (error) {
        return false
      }
    },

    listAssetsByTaskId: async function (taskId) {
      var res = await collection(COLLECTIONS.assets).where({ taskId: taskId }).limit(100).get()
      return (res && res.data) || []
    },

    findAssetByClientReqId: function (openid, clientReqId) {
      return queryOne(COLLECTIONS.assets, { openid: openid, clientReqId: clientReqId })
    },

    /**
     * 预扣额度：跨天惰性重置 + 原子条件更新（usedToday < limit 才 +1）。
     * 返回 {ok, user, quota}。并发下用 where 条件 + update 的 stats.updated 判定。
     */
    consumeQuota: async function (params) {
      params = params || {}
      var openid = params.openid
      var nowMs = typeof params.now === 'number' ? params.now : Date.now()
      var dayKey = util.beijingDayKey(nowMs)
      var vip = (config.vipWhitelist || []).indexOf(openid) >= 0
      var limit = vip ? config.dailyLimitVip : config.dailyLimitNormal
      var user = await getDoc(COLLECTIONS.users, openid)

      if (!user) {
        user = {
          _id: openid,
          openid: openid,
          dayKey: dayKey,
          usedToday: 0,
          dailyLimit: limit,
          vip: vip,
          vipSource: null,
          activeTaskId: null,
          consentVersion: null,
          consentAt: null,
          ageConfirmedAt: null,
          revokedAt: null
        }
        // task-30：set 的 data 不含 _id（文档 id 即 openid）
        await setDoc(COLLECTIONS.users, openid, user)
      } else if (user.dayKey !== dayKey) {
        await updateDoc(COLLECTIONS.users, openid, { dayKey: dayKey, usedToday: 0 })
        user.dayKey = dayKey
        user.usedToday = 0
      }

      var res = await collection(COLLECTIONS.users)
        .where({ _id: openid, dayKey: dayKey, usedToday: command.lt(limit) })
        .update({ data: sanitizeWriteData({ usedToday: command.inc(1), vip: vip, dailyLimit: limit }) })

      var ok = !!(res && res.stats && res.stats.updated === 1)
      var fresh = await getDoc(COLLECTIONS.users, openid)
      var used = fresh ? fresh.usedToday : limit
      return {
        ok: ok,
        user: fresh,
        quota: {
          used: used,
          limit: limit,
          remaining: Math.max(0, limit - used),
          vip: vip,
          dayKey: dayKey,
          resetAt: util.beijingResetAt(nowMs)
        }
      }
    },

    refundQuota: async function (openid) {
      await collection(COLLECTIONS.users)
        .where({ _id: openid, usedToday: command.gt(0) })
        .update({ data: sanitizeWriteData({ usedToday: command.inc(-1) }) })
      return getDoc(COLLECTIONS.users, openid)
    }
  }
}

module.exports = { createCloudStore: createCloudStore, COLLECTIONS: COLLECTIONS }
