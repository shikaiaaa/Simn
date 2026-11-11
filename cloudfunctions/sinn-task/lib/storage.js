/**
 * lib/storage.js —— 云存储适配器（SPEC-0001 §B.5）。
 *
 * 路径规则（不含 openid）：sinn/person|garment/{yyyyMMdd}/{uuid}.jpg、
 * sinn/result/{yyyyMMdd}/{taskId}.png。
 * handler 只依赖 {download, saveResult, deleteFiles} 三个方法；单测注入 fake。
 */
'use strict'

var util = require('./util')

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function datePath(nowMs) {
  // 以北京时间（UTC+8）生成日期目录，与额度 dayKey 口径一致
  var d = new Date(nowMs + 8 * 60 * 60 * 1000)
  return String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
}

function createCloudStorage(options) {
  options = options || {}
  var cloud = options.cloud
  if (!cloud) throw new Error('createCloudStorage 需要注入 cloud（wx-server-sdk）')
  var now = options.now || function () { return Date.now() }

  function download(fileID) {
    return cloud.downloadFile({ fileID: fileID }).then(function (res) {
      return res.fileContent
    })
  }

  function upload(buffer, cloudPath) {
    return cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer }).then(function (res) {
      return res.fileID
    })
  }

  function saveResult(params) {
    var taskId = params.taskId
    var cloudPath = 'sinn/result/' + datePath(now()) + '/' + taskId + '.png'
    return upload(params.buffer, cloudPath).then(function (fileID) {
      return { fileID: fileID, width: params.width, height: params.height }
    })
  }

  function deleteFiles(fileIDs) {
    var list = (fileIDs || []).filter(function (id) { return !!id })
    if (!list.length) return Promise.resolve({ deleted: [] })
    return cloud.deleteFile({ fileList: list }).then(function (res) {
      var results = (res && res.fileList) || []
      var failed = results.filter(function (item) { return !item.status })
      // 尽力删除：部分对象本来就不存在（重复删除/已清理）不算失败
      return { deleted: results, failed: failed }
    })
  }

  return {
    download: download,
    upload: upload,
    saveResult: saveResult,
    deleteFiles: deleteFiles,
    __datePath: datePath
  }
}

module.exports = { createCloudStorage: createCloudStorage, datePath: datePath }
