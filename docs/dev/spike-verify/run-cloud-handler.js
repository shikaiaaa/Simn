// docs/dev/spike-verify/run-cloud-handler.js
// SPIKE-0001 第 3 项：云函数入口的本地契约验证（wx-server-sdk 缺失时降级为可测模式）。
// 真实云开发部署验证（云函数创建/调用、云存储、云数据库、定时触发器）因 envId 未开通，报告标阻塞。
'use strict';

var harness = require('./lib/harness');
var cloudFunction = require('./fixtures/vendor-mock/index');

function assertEnvelope(envelope) {
  ['ok', 'data', 'error', 'requestId', 'serverTime'].forEach(function (key) {
    harness.assert(Object.prototype.hasOwnProperty.call(envelope, key), '响应缺少字段 ' + key);
  });
  harness.assert(typeof envelope.ok === 'boolean', 'ok 必须为 boolean');
  harness.assert(!isNaN(Date.parse(envelope.serverTime)), 'serverTime 不是合法时间');
}

async function run() {
  harness.group('cloud-handler（云函数统一响应包裹 / 错误码 / selftest 生命周期）');

  await harness.testAsync('dispatch(health)：返回 mock 适配器能力', async function () {
    var data = await cloudFunction.__test.dispatch({ action: 'health' });
    harness.equal(data.vendor, 'mock');
    harness.equal(data.available, true);
    return 'vendor=mock';
  });

  await harness.testAsync('dispatch(未知 action)：E_PARAM 拒绝', async function () {
    try {
      await cloudFunction.__test.dispatch({ action: 'nope' });
      throw new Error('预期 reject');
    } catch (err) {
      harness.equal(err.name, 'E_PARAM');
      return err.message;
    }
  });

  await harness.testAsync('main(health)：统一响应包裹 {ok,data,error,requestId,serverTime}', async function () {
    var envelope = await cloudFunction.main({ action: 'health', requestId: 'req-spike-1' });
    assertEnvelope(envelope);
    harness.equal(envelope.ok, true);
    harness.equal(envelope.error, null);
    harness.equal(envelope.requestId, 'req-spike-1');
    harness.equal(envelope.data.vendor, 'mock');
    return envelope.requestId;
  });

  await harness.testAsync('main(参数错误)：error.code=1001 / name=E_PARAM / httpStatus=400', async function () {
    var envelope = await cloudFunction.main({ action: 'submit', payload: { garmentUrl: 'g' } });
    assertEnvelope(envelope);
    harness.equal(envelope.ok, false);
    harness.equal(envelope.data, null);
    harness.equal(envelope.error.code, 1001);
    harness.equal(envelope.error.name, 'E_PARAM');
    harness.equal(envelope.error.httpStatus, 400);
    harness.assert(typeof envelope.error.hint === 'string', 'error.hint 缺失');
    return JSON.stringify(envelope.error);
  });

  await harness.testAsync('main(任务不存在)：E_TASK_NOT_FOUND / 404', async function () {
    var envelope = await cloudFunction.main({ action: 'query', payload: { taskId: 'mock_missing' } });
    assertEnvelope(envelope);
    harness.equal(envelope.ok, false);
    harness.equal(envelope.error.code, 1404);
    harness.equal(envelope.error.name, 'E_TASK_NOT_FOUND');
    harness.equal(envelope.error.httpStatus, 404);
    return '404';
  });

  await harness.testAsync('main(selftest)：完整生命周期 + erase 后 404', async function () {
    var envelope = await cloudFunction.main({ action: 'selftest' });
    assertEnvelope(envelope);
    harness.equal(envelope.ok, true);
    var report = envelope.data;
    harness.equal(report.passed, true);
    harness.equal(report.query.status, 'success');
    harness.equal(report.erase.erased, true);
    harness.equal(report.afterErase.code, 'E_TASK_NOT_FOUND');
    harness.equal(report.stats.submitted, 1);
    harness.equal(report.stats.erased, 1);
    harness.assert(report.elapsedMs < 5000, 'selftest 耗时异常');
    return { elapsedMs: report.elapsedMs, afterErase: report.afterErase };
  });

  await harness.testAsync('main(timing)：1536/2048 阶段分解与总时长', async function () {
    var preferred = await cloudFunction.main({ action: 'timing', payload: { resolution: '2048' } });
    var degraded = await cloudFunction.main({ action: 'timing', payload: { resolution: '1536' } });
    harness.equal(preferred.data.totalMs, 15870);
    harness.equal(degraded.data.totalMs, 10870);
    harness.assert(preferred.data.totalMs <= 60000, '2048 超 60s');
    harness.assert(degraded.data.totalMs <= 60000, '1536 超 60s');
    return { p2048: preferred.data.totalMs, p1536: degraded.data.totalMs };
  });

  await harness.testAsync('main(submit)：合法参数受理并返回 taskId，随后可 erase 清理', async function () {
    var envelope = await cloudFunction.main({
      action: 'submit',
      payload: {
        photoUrl: 'https://mock.invalid/photo.jpg',
        garmentUrl: 'https://mock.invalid/garment.jpg',
        resolution: '2048'
      }
    });
    assertEnvelope(envelope);
    harness.equal(envelope.ok, true);
    harness.assert(/^mock_/.test(envelope.data.taskId), 'taskId 格式不符');
    harness.equal(envelope.data.status, 'processing');
    var erased = await cloudFunction.main({
      action: 'erase',
      payload: { taskId: envelope.data.taskId }
    });
    harness.equal(erased.data.erased, true);
    return envelope.data.taskId;
  });
}

module.exports = { run: run };
