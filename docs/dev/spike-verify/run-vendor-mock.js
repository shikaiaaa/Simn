// docs/dev/spike-verify/run-vendor-mock.js
// SPIKE-0001 第 3/4/5/6 项：VendorAdapter 契约、任务状态机、物理删除语义与 60s 时延分解的
// Mock 层验证。真实供应商（Perfect Corp / 腾讯云 / 火山引擎 / 阿里云）调用与实测时延
// 因无 API 试用账号，报告中标「阻塞 + 解锁条件」。
'use strict';

var harness = require('./lib/harness');
var mockVendor = require('./fixtures/vendor-mock/lib/mock-vendor');

function fastAdapter() {
  return mockVendor.createMockAdapter({
    timing: { validateMs: 2, submitMs: 2, saveMs: 2, queryStepMs: 1 },
    profiles: {
      '1536': { longSide: 1536, generateMs: 30 },
      '2048': { longSide: 2048, generateMs: 50 }
    }
  });
}

function pollUntilDone(adapter, taskId) {
  return adapter.query({ taskId: taskId }).then(function (state) {
    if (state.status === 'success' || state.status === 'cancelled') return state;
    return pollUntilDone(adapter, taskId);
  });
}

async function expectReject(promise, expectedName) {
  try {
    await promise;
  } catch (err) {
    harness.equal(err.name, expectedName, '错误名不符');
    return { name: err.name, httpStatus: err.httpStatus, message: err.message };
  }
  throw new Error('预期 reject，实际 resolve');
}

async function run() {
  harness.group('mock-vendor（VendorAdapter 契约 / 状态机 / 物理删除 / 时延分解）');

  harness.test('供应商档位与错误码表', function () {
    harness.equal(Object.keys(mockVendor.RESOLUTION_PROFILES), ['1536', '2048']);
    harness.equal(mockVendor.RESOLUTION_PROFILES['2048'].longSide, 2048);
    harness.equal(mockVendor.RESOLUTION_PROFILES['1536'].longSide, 1536);
    harness.equal(Object.keys(mockVendor.ERROR_CODES), [
      'E_PARAM',
      'E_PHOTO_INVALID',
      'E_TASK_NOT_FOUND',
      'E_VENDOR_UNAVAILABLE'
    ]);
    harness.equal(mockVendor.ERROR_CODES.E_TASK_NOT_FOUND.httpStatus, 404);
  });

  await harness.testAsync('health：适配器能力声明（6 个契约方法 + 两档分辨率）', async function () {
    var health = await fastAdapter().health();
    harness.equal(health.vendor, 'mock');
    harness.equal(health.available, true);
    harness.equal(health.capabilities.resolutions, ['1536', '2048']);
    ['validate', 'submit', 'query', 'cancel', 'erase'].forEach(function (key) {
      harness.assert(health.capabilities[key] === true, key + ' 能力缺失');
    });
    return 'MOCK_ONLY';
  });

  await harness.testAsync('validate：全部通过用例（10 项 pass）', async function () {
    var adapter = fastAdapter();
    var result = await adapter.validate({
      photo: {
        detectedPersons: 1,
        fullBodyVisible: true,
        faceVisible: true,
        bodyOccluded: false,
        uprightFrontal: true,
        backlit: false
      },
      garment: {
        garmentCount: 1,
        onModel: false,
        tagVisible: false,
        isEcommerceShot: true
      }
    });
    harness.equal(result.ok, true);
    harness.equal(result.failed.length, 0);
    harness.equal(result.unknown.length, 0);
    harness.equal(result.checks.length, 10);
    return '10/10 pass';
  });

  await harness.testAsync('validate：无法判断维度返回 unknown（Mock 不冒充真实预检）', async function () {
    var adapter = fastAdapter();
    var result = await adapter.validate({ photo: {}, garment: {} });
    harness.equal(result.ok, true);
    harness.equal(result.failed.length, 0);
    harness.equal(result.unknown.length, 10);
    return '10 unknown';
  });

  await harness.testAsync('validate：失败用例聚合（9 项 fail + 1 项 unknown）', async function () {
    var adapter = fastAdapter();
    var result = await adapter.validate({
      photo: {
        detectedPersons: 2,
        fullBodyVisible: false,
        faceVisible: false,
        bodyOccluded: true,
        uprightFrontal: false,
        backlit: true
      },
      garment: { garmentCount: 2, onModel: true, tagVisible: true }
    });
    harness.equal(result.ok, false);
    harness.equal(result.failed.length, 9);
    harness.equal(result.unknown.length, 1);
    var codes = result.failed.map(function (item) {
      return item.code;
    });
    harness.assert(codes.indexOf('single_person') >= 0, '缺少 single_person 失败');
    harness.assert(codes.indexOf('backlit') < 0, 'lighting_ok 应映射到 lighting_ok');
    return 'failed=' + codes.join(',');
  });

  await harness.testAsync('submit：缺少 photoUrl / garmentUrl / 非法分辨率均拒绝', async function () {
    var adapter = fastAdapter();
    var e1 = await expectReject(adapter.submit({ garmentUrl: 'g' }), 'E_PARAM');
    var e2 = await expectReject(adapter.submit({ photoUrl: 'p' }), 'E_PARAM');
    var e3 = await expectReject(
      adapter.submit({ photoUrl: 'p', garmentUrl: 'g', resolution: '4096' }),
      'E_PARAM'
    );
    harness.equal(e1.httpStatus, 400);
    harness.equal(e2.httpStatus, 400);
    harness.equal(e3.httpStatus, 400);
    return '3 reject';
  });

  await harness.testAsync('query：不存在的任务返回 E_TASK_NOT_FOUND(404)，无墓碑', async function () {
    var adapter = fastAdapter();
    var err = await expectReject(adapter.query({ taskId: 'mock_missing' }), 'E_TASK_NOT_FOUND');
    harness.equal(err.httpStatus, 404);
    harness.assert(/没有找到|not found|物理/.test(err.message + err.hint), '缺 E_TASK_NOT_FOUND 语义');
    return '404';
  });

  await harness.testAsync('生命周期：2048 / 1536 各 3 次 submit→query→success→erase', async function () {
    var adapter = fastAdapter();
    var records = [];
    var resolutions = ['2048', '1536'];
    for (var r = 0; r < resolutions.length; r += 1) {
      for (var i = 0; i < 3; i += 1) {
        var started = Date.now();
        var submitted = await adapter.submit({
          photoUrl: 'https://mock.invalid/photo_' + r + '_' + i + '.jpg',
          garmentUrl: 'https://mock.invalid/garment_' + r + '_' + i + '.jpg',
          resolution: resolutions[r]
        });
        var finished = await pollUntilDone(adapter, submitted.taskId);
        var erased = await adapter.erase({ taskId: submitted.taskId });
        harness.equal(finished.status, 'success');
        harness.assert(/\/results\//.test(finished.resultUrl || ''), '无 resultUrl');
        harness.equal(finished.resolution, resolutions[r]);
        harness.equal(erased.erased, true);
        records.push({
          resolution: resolutions[r],
          iteration: i + 1,
          wallMs: Date.now() - started,
          resultUrl: finished.resultUrl
        });
      }
    }
    harness.equal(records.length, 6);
    harness.equal(adapter.pendingTaskCount(), 0);
    harness.equal(adapter.stats().submitted, 6);
    harness.equal(adapter.stats().erased, 6);
    return records;
  });

  await harness.testAsync('60s 预算：2048/1536 模拟阶段分解均在预算内', async function () {
    var adapter = fastAdapter();
    var preferred = adapter.timingBreakdown('2048');
    var degraded = adapter.timingBreakdown('1536');
    harness.equal(preferred.stages.uploadMs, 1200);
    harness.equal(preferred.stages.precheckMs, 120);
    harness.equal(preferred.stages.submitMs, 150);
    harness.equal(preferred.stages.generateMs, 14000);
    harness.equal(preferred.stages.saveAndDownloadMs, 400);
    harness.equal(preferred.totalMs, 15870);
    harness.equal(degraded.totalMs, 10870);
    harness.assert(preferred.stages.uploadMs <= 8000, '上传超 8s');
    harness.assert(preferred.stages.precheckMs <= 5000, '预检超 5s');
    harness.assert(preferred.stages.submitMs <= 10000, '提交超 10s');
    harness.assert(preferred.stages.generateMs <= 40000, '生成超 40s');
    harness.assert(preferred.stages.saveAndDownloadMs <= 5000, '转存下载超 5s');
    harness.assert(preferred.totalMs <= 60000, '总时长超 60s');
    harness.assert(degraded.totalMs <= 60000, '1536 总时长超 60s');
    return { preferred: preferred.totalMs, degraded: degraded.totalMs };
  });

  await harness.testAsync('物理删除：erase 后 query=404，重复 erase=404，无墓碑', async function () {
    var adapter = fastAdapter();
    var submitted = await adapter.submit({
      photoUrl: 'https://mock.invalid/p.jpg',
      garmentUrl: 'https://mock.invalid/g.jpg',
      resolution: '1536'
    });
    var erased = await adapter.erase({ taskId: submitted.taskId });
    harness.equal(erased.erased, true);
    harness.equal(adapter.pendingTaskCount(), 0);
    await expectReject(adapter.query({ taskId: submitted.taskId }), 'E_TASK_NOT_FOUND');
    await expectReject(adapter.erase({ taskId: submitted.taskId }), 'E_TASK_NOT_FOUND');
    return 'erase→404→404';
  });

  await harness.testAsync('cancel：取消后状态为 cancelled，仍可物理删除', async function () {
    var adapter = fastAdapter();
    var submitted = await adapter.submit({
      photoUrl: 'https://mock.invalid/p.jpg',
      garmentUrl: 'https://mock.invalid/g.jpg',
      resolution: '1536'
    });
    var cancelled = await adapter.cancel({ taskId: submitted.taskId });
    harness.equal(cancelled.status, 'cancelled');
    var queried = await adapter.query({ taskId: submitted.taskId });
    harness.equal(queried.status, 'cancelled');
    await adapter.erase({ taskId: submitted.taskId });
    harness.equal(adapter.pendingTaskCount(), 0);
    return 'cancelled';
  });

  await harness.testAsync('并发：5 个任务并行提交/完成/删除，内存任务表归零', async function () {
    var adapter = fastAdapter();
    var submitted = await Promise.all(
      [0, 1, 2, 3, 4].map(function (i) {
        return adapter.submit({
          photoUrl: 'https://mock.invalid/p' + i + '.jpg',
          garmentUrl: 'https://mock.invalid/g' + i + '.jpg',
          resolution: '1536'
        });
      })
    );
    harness.equal(adapter.pendingTaskCount(), 5);
    var finished = await Promise.all(
      submitted.map(function (task) {
        return pollUntilDone(adapter, task.taskId);
      })
    );
    finished.forEach(function (task) {
      harness.equal(task.status, 'success');
    });
    await Promise.all(
      submitted.map(function (task) {
        return adapter.erase({ taskId: task.taskId });
      })
    );
    harness.equal(adapter.pendingTaskCount(), 0);
    return '5/5 concurrent ok';
  });
}

module.exports = { run: run };
