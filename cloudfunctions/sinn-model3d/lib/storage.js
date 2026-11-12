/**
 * lib/storage.js —— 云存储适配器（SPEC-0002 §B.5）。
 *
 * 路径规则（不含 openid 明文）：
 *   sinn/model3d/{openidHash}/{modelId}/model.glb
 *   sinn/model3d/{openidHash}/{modelId}/thumb.webp（缩略图；当前无服务端渲染，先留空）
 *
 * handler 只依赖 {getTempFileURL, download, uploadModel, deleteFiles} 四个方法；
 * 单测注入 fake，不加载 wx-server-sdk。
 */
'use strict'

var DEFAULT_URL_MAX_AGE_SEC = 600 // SPEC §B.5：下载 URL 短期有效（≤10 分钟）

function createModel3dStorage(options) {
  options = options || {}
  var cloud = options.cloud
  if (!cloud) throw new Error('createModel3dStorage 需要注入 cloud（wx-server-sdk）')
  var urlMaxAgeSec = options.urlMaxAgeSec || DEFAULT_URL_MAX_AGE_SEC

  function getTempFileURL(fileIDs) {
    var list = (fileIDs || []).filter(function (id) { return !!id })
    if (!list.length) return Promise.resolve([])
    return cloud.getTempFileURL({ fileList: list, maxAge: urlMaxAgeSec }).then(function (res) {
      return (res && res.fileList) || []
    })
  }

  function download(fileID) {
    return cloud.downloadFile({ fileID: fileID }).then(function (res) {
      return res.fileContent
    })
  }

  function modelCloudPath(openidHash, modelId) {
    return 'sinn/model3d/' + openidHash + '/' + modelId + '/model.glb'
  }

  function uploadModel(buffer, params) {
    params = params || {}
    var cloudPath = modelCloudPath(params.openidHash, params.modelId)
    return cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer }).then(function (res) {
      return {
        fileID: res.fileID,
        cloudPath: cloudPath,
        bytes: buffer.length
      }
    })
  }

  function uploadThumb(buffer, params) {
    params = params || {}
    var cloudPath = 'sinn/model3d/' + params.openidHash + '/' + params.modelId + '/thumb.webp'
    return cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer }).then(function (res) {
      return { fileID: res.fileID, cloudPath: cloudPath, bytes: buffer.length }
    })
  }

  function deleteFiles(fileIDs) {
    var list = (fileIDs || []).filter(function (id) { return !!id })
    if (!list.length) return Promise.resolve({ deleted: [], failed: [] })
    return cloud.deleteFile({ fileList: list }).then(function (res) {
      var results = (res && res.fileList) || []
      var failed = results.filter(function (item) { return !item.status })
      return { deleted: results, failed: failed }
    })
  }

  return {
    getTempFileURL: getTempFileURL,
    download: download,
    uploadModel: uploadModel,
    uploadThumb: uploadThumb,
    deleteFiles: deleteFiles,
    modelCloudPath: modelCloudPath,
    urlMaxAgeSec: urlMaxAgeSec
  }
}

module.exports = {
  createModel3dStorage: createModel3dStorage,
  DEFAULT_URL_MAX_AGE_SEC: DEFAULT_URL_MAX_AGE_SEC
}
