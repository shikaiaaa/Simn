// cloudfunctions/spike-vendor/index.js
// SPIKE-0001 第 3/4/5/6 项：云函数 + 供应商适配器契约的临时验证入口。
// 本函数只依赖 lib/mock-vendor.js，不连接真实供应商；云开发环境未开通（envId 缺失），
// 因此本地用 Node 直接调用 __test.dispatch / main 验证契约，部署验证标「阻塞」。
// 交付前必须移除本目录（SPIKE-0001 第 8 项）。

'use strict';

var mockVendor = require('./lib/mock-vendor');

var cloud = null;
try {
  // 本地验证环境无 wx-server-sdk；真实云函数部署时由 cloudfunctions 依赖提供。
  cloud = require('wx-server-sdk');
} catch (err) {
  cloud = null;
}
if (cloud && typeof cloud.init === 'function') {
  try {
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  } catch (err) {
    cloud.init();
  }
}

var adapter = mockVendor.createMockAdapter();
var ERROR_CODES = mockVendor.ERROR_CODES;

function createError(code, message, hint) {
  var meta = ERROR_CODES[code] || { name: code, httpStatus: 500 };
  var err = new Error(message || code);
  err.code = code;
  err.name = meta.name;
  err.hint = hint || '';
  err.httpStatus = meta.httpStatus;
  return err;
}

function requestIdOf(event) {
  if (event && event.requestId) return String(event.requestId);
  return 'spike-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function ok(requestId, data) {
  return {
    ok: true,
    data: data,
    error: null,
    requestId: requestId,
    serverTime: new Date().toISOString()
  };
}

function fail(requestId, error) {
  var rawCode = (error && error.code) || 'E_INTERNAL';
  var meta = ERROR_CODES[rawCode] || null;
  if (!meta && error && error.name && ERROR_CODES[error.name]) {
    meta = ERROR_CODES[error.name];
  }
  return {
    ok: false,
    data: null,
    error: {
      code: meta ? meta.code : rawCode,
      name: (error && error.name) || (meta && meta.name) || 'E_INTERNAL',
      message: (error && error.message) || 'internal error',
      hint: (error && error.hint) || '',
      httpStatus: (error && error.httpStatus) || (meta && meta.httpStatus) || 500
    },
    requestId: requestId,
    serverTime: new Date().toISOString()
  };
}

function pollUntilDone(target, taskId, attemptsLeft) {
  var left = attemptsLeft === undefined ? 100 : attemptsLeft;
  return target.query({ taskId: taskId }).then(function (state) {
    if (state.status === 'success' || state.status === 'cancelled' || left <= 0) {
      return state;
    }
    return pollUntilDone(target, taskId, left - 1);
  });
}

// action=selftest 时用短时延实例跑完整生命周期（UPLOAD→VALIDATE→SUBMIT→QUERY→ERASE→404）。
function runSelfTest() {
  var fastTiming = { validateMs: 5, submitMs: 5, saveMs: 5, queryStepMs: 2 };
  var fastProfiles = {
    '1536': { longSide: 1536, generateMs: 40 },
    '2048': { longSide: 2048, generateMs: 80 }
  };
  var fast = mockVendor.createMockAdapter({ timing: fastTiming, profiles: fastProfiles });
  var started = Date.now();
  var report = { simulated: true, startedAt: new Date().toISOString(), taskId: null };
  return fast
    .health()
    .then(function (health) {
      report.health = health;
      return fast.validate({
        photo: { width: 1200, height: 2000, format: 'jpeg' },
        garment: { type: 'top', single: true }
      });
    })
    .then(function (validation) {
      report.validate = validation;
      return fast.submit({
        photoUrl: 'https://mock.invalid/photo.jpg',
        garmentUrl: 'https://mock.invalid/garment.jpg',
        resolution: '2048'
      });
    })
    .then(function (submitted) {
      report.submit = submitted;
      report.taskId = submitted.taskId;
      return pollUntilDone(fast, submitted.taskId);
    })
    .then(function (queryResult) {
      report.query = queryResult;
      return fast.erase({ taskId: report.taskId });
    })
    .then(function (erased) {
      report.erase = erased;
      return fast.query({ taskId: report.taskId }).then(
        function (unexpected) {
          report.afterErase = { unexpected: unexpected };
        },
        function (err) {
          report.afterErase = {
            code: err.name || err.code,
            rawCode: err.code,
            message: err.message
          };
        }
      );
    })
    .then(function () {
      report.stats = fast.stats();
      report.elapsedMs = Date.now() - started;
      report.passed =
        report.query &&
        report.query.status === 'success' &&
        report.erase &&
        report.erase.erased === true &&
        report.afterErase.code === 'E_TASK_NOT_FOUND';
      return report;
    });
}

function dispatch(event) {
  var evt = event || {};
  var action = evt.action;
  var payload = evt.payload || {};
  switch (action) {
    case 'health':
      return adapter.health();
    case 'validate':
      return adapter.validate(payload);
    case 'submit':
      return adapter.submit(payload);
    case 'query':
      return adapter.query(payload);
    case 'cancel':
      return adapter.cancel(payload);
    case 'erase':
      return adapter.erase(payload);
    case 'timing':
      return Promise.resolve(adapter.timingBreakdown(payload.resolution));
    case 'selftest':
      return runSelfTest();
    default:
      return Promise.reject(createError('E_PARAM', 'unknown action: ' + String(action)));
  }
}

exports.main = async function (event) {
  var requestId = requestIdOf(event);
  try {
    var data = await dispatch(event);
    return ok(requestId, data);
  } catch (err) {
    return fail(requestId, err);
  }
};

// 供 docs/dev/spike-verify 的 Node 脚本直接调用（绕过 wx-server-sdk）
exports.__test = {
  dispatch: dispatch,
  ok: ok,
  fail: fail,
  createError: createError,
  adapter: adapter
};
