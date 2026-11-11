// result.js —— 试穿结果页（DEV-0001-08 / SPEC v0.3 AC-13..AC-20 / AC-23 / AC-26）
//
// 数据来源：sinn-task/taskGet → data.result {fileID,width,height,sizeResult,sizeFallback}
// - 单图源展示；缩放/平移/复位由 components/zoom-view 负责（S2+ 主 / S2 兜底）。
// - 尺码仅格式化服务端 sizeResult，端上零推理（见 services/size.js）。
// - AI 标识为独立图层，位于 zoom-view 之外，不随图片缩放。
// - 删除本次结果 = 二次确认 + 服务端物理删除（无墓碑），成功后退回首页，不返还额度。
// - 页面不提供分享/保存相册/价格购买/商家/3D/形象库入口（AC-23）。

'use strict';

var api = require('../../services/api');
var size = require('../../services/size');

var INDEX_URL = '/pages/index/index';

Page({
  data: {
    taskId: '',
    loading: true,
    errorText: '',
    result: null,
    imageUrl: '',
    sizeView: size.buildSizeView(null, null),
    degradedNotice: '',
    deleting: false,
    aiLabel: 'AI 生成'
  },

  onLoad: function (options) {
    var raw = options && options.taskId ? String(options.taskId) : '';
    var taskId = raw;
    try {
      taskId = decodeURIComponent(raw);
    } catch (error) {
      taskId = raw;
    }
    if (!taskId) {
      this.setData({
        loading: false,
        errorText: '缺少任务信息，请从生成页重新进入'
      });
      return;
    }
    this.setData({ taskId: taskId });
    this._loadTask(taskId);
  },

  _loadTask: function (taskId) {
    var self = this;
    this.setData({ loading: true, errorText: '' });
    return api
      .call('sinn-task', 'taskGet', { taskId: taskId }, { requireConsent: false, timeoutMs: 8000 })
      .then(function (res) {
        self._applyTask((res && res.data) || {});
      })
      .catch(function (error) {
        self.setData({ loading: false, errorText: self._errorText(error) });
      });
  },

  _errorText: function (error) {
    if (!error) return '加载失败，请稍后重试';
    if (error.code === 5004 || error.name === 'E_TASK_NOT_FOUND') {
      return '任务不存在或已删除，请返回首页重新开始';
    }
    if (error.code === 5002 || error.code === 5003) {
      return '网络异常，请检查网络后重试';
    }
    var message = api.getUserMessage(error);
    return message || error.message || '加载失败，请稍后重试';
  },

  _applyTask: function (task) {
    var status = task && task.status;
    var result = task && task.result;
    if (status !== 'SUCCEEDED' || !result || !result.fileID) {
      var text = '任务尚未完成，请回到生成页查看进度';
      if (status === 'FAILED' || status === 'TIMEOUT' || status === 'CANCELLED') {
        text = '任务未成功完成，请返回首页重新开始';
      }
      this.setData({ loading: false, errorText: text });
      return;
    }
    var self = this;
    this._resolveImageUrl(result.fileID).then(function (imageUrl) {
      self.setData({
        loading: false,
        result: result,
        imageUrl: imageUrl,
        sizeView: size.buildSizeView(result.sizeResult, result.sizeFallback),
        degradedNotice: size.formatDegradedNotice(result.sizeFallback)
      });
    });
  },

  _resolveImageUrl: function (fileID) {
    var id = fileID ? String(fileID) : '';
    if (!id) return Promise.resolve('');
    if (id.indexOf('cloud://') !== 0) return Promise.resolve(id);
    return new Promise(function (resolve) {
      if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
        resolve(id);
        return;
      }
      function apply(res) {
        var list = (res && res.fileList) || [];
        var first = list[0];
        resolve(first && first.tempFileURL ? first.tempFileURL : id);
      }
      try {
        var request = wx.cloud.getTempFileURL({
          fileList: [id],
          success: apply,
          fail: function () {
            resolve(id);
          }
        });
        // 部分基础库/mock 会返回 Promise 而不同时回调 success，这里双通道兼容。
        if (request && typeof request.then === 'function') {
          request.then(apply, function () {
            resolve(id);
          });
        }
      } catch (error) {
        resolve(id);
      }
    });
  },

  onResetZoom: function () {
    if (typeof this.selectComponent !== 'function') return;
    var zoom = this.selectComponent('#zoom-view');
    if (zoom && typeof zoom.reset === 'function') zoom.reset();
  },

  onBackHome: function () {
    wx.reLaunch({ url: INDEX_URL });
  },

  onDeleteTap: function () {
    var self = this;
    if (this.data.deleting) return;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
    wx.showModal({
      title: '删除本次结果？',
      content: '照片与试穿结果将被物理删除，无法恢复；本次不返还额度。',
      confirmText: '删除',
      cancelText: '取消',
      confirmColor: '#d14343',
      success: function (res) {
        if (res && res.confirm) self._deleteTask();
      }
    });
  },

  _deleteTask: function () {
    var self = this;
    var taskId = this.data.taskId;
    if (!taskId || this.data.deleting) return;
    this.setData({ deleting: true });
    return api
      .call('sinn-task', 'deleteTask', { taskId: taskId }, { requireConsent: true, timeoutMs: 8000 })
      .then(function () {
        self._clearActiveTask();
        wx.reLaunch({ url: INDEX_URL });
      })
      .catch(function (error) {
        if (error && (error.code === 5004 || error.name === 'E_TASK_NOT_FOUND')) {
          self._clearActiveTask();
          wx.reLaunch({ url: INDEX_URL });
          return;
        }
        self.setData({ deleting: false });
        var message = api.getUserMessage(error) || '删除失败，请重试';
        if (typeof wx.showToast === 'function') wx.showToast({ title: message, icon: 'none' });
      });
  },

  _clearActiveTask: function () {
    try {
      wx.removeStorageSync(api.STORAGE_KEYS.ACTIVE_TASK);
    } catch (error) {
      // 本地缓存清理失败不影响服务端删除结果。
    }
  }
});
