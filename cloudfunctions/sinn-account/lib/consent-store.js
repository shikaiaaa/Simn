/**
 * sinn-account/lib/consent-store.js —— 同意审计（append-only）。
 *
 * SPEC §B.3：sinn_consents 只保存同意元数据（用户、版本、时间、文本 hash、ageConfirmedAt），
 * **禁止**保存照片、围度、性别等业务数据。审计记录只追加，不随删除/撤回删除。
 *
 * 生产实现（CP-02 云开发开通后可用）：
 *   db.collection('sinn_consents').doc(recordId).set({data: record 去掉 _id})
 * 注意（task-30）：微信云数据库 doc(id).set() 的 data 不允许包含 `_id`
 * （自定义 _id 只在 collection.add({data:{_id}}) 允许），因此 append 写库前
 * 必须删除 record._id，否则云端会抛 -501001 错误。
 * 单测使用内存实现（tests/unit/cloudfunctions/account/fixtures.js）。
 */
'use strict'

function createCloudConsentStore(db) {
  if (!db) throw new Error('createCloudConsentStore 需要注入 db（cloud.database()）')
  var collection = db.collection('sinn_consents')

  return {
    append: async function (record) {
      // task-30：set 的 data 不允许 _id（文档 id 即 recordId）
      var data = Object.assign({}, record)
      delete data._id
      await collection.doc(record.recordId).set({ data: data })
      return record
    },

    listByOpenid: async function (openid) {
      var res = await collection.where({ openid: openid }).limit(100).get()
      return (res && res.data) || []
    }
  }
}

module.exports = {
  createCloudConsentStore: createCloudConsentStore
}
