// mock-vendor.js
// SPIKE-0001 第 4/6 项：VendorAdapter 契约的 Mock 实现（无 wx / 无云 SDK 依赖）。
// 契约（SPEC-0001 D-2）：health / validate / submit / query / cancel / erase。
// 说明：真实供应商 API 试用账号未提供，本文件只用于验证契约、状态机与端到端时延分解；
// 不代表任何供应商的真实预检能力（预检结论见 docs/dev/SPIKE-0001.md 第 6 项）。

'use strict';

var RESOLUTION_PROFILES = {
  '1536': { longSide: 1536, generateMs: 9000, label: 'degraded-1536' },
  '2048': { longSide: 2048, generateMs: 14000, label: 'preferred-2048' }
};

var DEFAULT_TIMING = {
  validateMs: 120,
  submitMs: 150,
  saveMs: 400,
  queryStepMs: 250
};

var ERROR_CODES = {
  E_PARAM: { code: 1001, name: 'E_PARAM', httpStatus: 400 },
  E_PHOTO_INVALID: { code: 1002, name: 'E_PHOTO_INVALID', httpStatus: 422 },
  E_TASK_NOT_FOUND: { code: 1404, name: 'E_TASK_NOT_FOUND', httpStatus: 404 },
  E_VENDOR_UNAVAILABLE: { code: 1502, name: 'E_VENDOR_UNAVAILABLE', httpStatus: 502 }
};

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function createError(name, message, hint) {
  var meta = ERROR_CODES[name] || ERROR_CODES.E_PARAM;
  return {
    name: meta.name,
    code: meta.code,
    httpStatus: meta.httpStatus,
    message: message || meta.name,
    hint: hint || ''
  };
}

function createTaskId() {
  return (
    'mock_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 8)
  );
}

// 预检规则：三态（pass / fail / unknown）。unknown = 该维度 Mock 无法判断，需真实供应商
// validate 或服务端视觉大模型补充。photo/garment 允许调用方显式传标记，用于构造用例。
function buildChecks(photo, garment) {
  var p = photo || {};
  var g = garment || {};
  var checks = [];

  function add(code, status, hint) {
    checks.push({ code: code, status: status, hint: hint || '' });
  }

  function threeState(flag) {
    if (flag === true) return 'pass';
    if (flag === false) return 'fail';
    return 'unknown';
  }

  add('single_person', threeState(p.detectedPersons === 1 ? true : p.detectedPersons > 1 ? false : undefined), '仅允许单人照片');
  add('full_body_with_feet', threeState(p.fullBodyVisible), '需全身且包含双脚');
  add('face_visible', threeState(p.faceVisible), '面部需可见且无遮挡');
  add('body_not_occluded', threeState(p.bodyOccluded === true ? false : p.bodyOccluded === false ? true : undefined), '身体/腹部不能有遮挡');
  add('upright_frontal', threeState(p.uprightFrontal), '需直立正面');
  add('lighting_ok', threeState(p.backlit === true ? false : p.backlit === false ? true : undefined), '逆光照片不可用');
  add('single_garment', threeState(typeof g.garmentCount === 'number' ? g.garmentCount === 1 : undefined), '服装图需仅一件单件');
  add('not_on_model', threeState(g.onModel === true ? false : g.onModel === false ? true : undefined), '服装图为平铺/商品图，不能是模特上身图');
  add('tag_hidden', threeState(g.tagVisible === true ? false : g.tagVisible === false ? true : undefined), '吊牌/水印需移除');
  add('mall_image_ok', threeState(g.isEcommerceShot === true ? true : undefined), '电商图需白底/纯色底，且与模特肤色区分明显');

  return checks;
}

function judge(checks) {
  var failed = checks.filter(function (item) {
    return item.status === 'fail';
  });
  var unknown = checks.filter(function (item) {
    return item.status === 'unknown';
  });
  return {
    ok: failed.length === 0,
    failed: failed,
    unknown: unknown,
    checks: checks
  };
}

function createMockAdapter(options) {
  var opts = options || {};
  var timing = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
  // profiles 可注入，便于验证脚本用短时延跑完整生命周期；默认用 SPEC 的模拟生成时长
  var profiles = Object.assign({}, RESOLUTION_PROFILES, opts.profiles || {});
  var tasks = new Map();
  var stats = { submitted: 0, completed: 0, erased: 0 };

  function resolutionProfile(resolution) {
    return profiles[String(resolution || '2048')] || profiles['2048'];
  }

  function health() {
    return Promise.resolve({
      vendor: 'mock',
      adapterVersion: 'spike-1',
      available: true,
      capabilities: {
        validate: true,
        submit: true,
        query: true,
        cancel: true,
        erase: true,
        resolutions: Object.keys(profiles)
      },
      notes: 'MOCK_ONLY - 未连接真实试穿供应商（envId/API 试用账号未提供）'
    });
  }

  function validate(input) {
    var started = now();
    var photo = (input && input.photo) || {};
    var garment = (input && input.garment) || {};
    var checks = buildChecks(photo, garment);
    var verdict = judge(checks);
    return sleep(timing.validateMs).then(function () {
      return Object.assign(
        {
          validatedAt: new Date().toISOString(),
          elapsedMs: now() - started,
          precheckTimeoutMs: 8000
        },
        verdict
      );
    });
  }

  function submit(input) {
    var started = now();
    var payload = input || {};
    if (!payload.photoUrl) {
      return Promise.reject(createError('E_PARAM', 'photoUrl required'));
    }
    if (!payload.garmentUrl) {
      return Promise.reject(createError('E_PARAM', 'garmentUrl required'));
    }
    if (Object.keys(profiles).indexOf(String(payload.resolution)) < 0) {
      return Promise.reject(createError('E_PARAM', 'resolution must be 1536 or 2048'));
    }
    var profile = resolutionProfile(payload.resolution);
    var taskId = createTaskId();
    return sleep(timing.submitMs).then(function () {
      tasks.set(taskId, {
        taskId: taskId,
        status: 'processing',
        resolution: String(profile.longSide),
        photoUrl: payload.photoUrl,
        garmentUrl: payload.garmentUrl,
        createdAt: started,
        generateMs: profile.generateMs,
        resultUrl: null
      });
      stats.submitted += 1;
      return {
        taskId: taskId,
        status: 'processing',
        resolution: String(profile.longSide),
        estimatedMs: profile.generateMs + timing.saveMs,
        acceptedAt: new Date().toISOString(),
        adapter: 'mock'
      };
    });
  }

  function query(input) {
    var taskId = (input && input.taskId) || input;
    var task = tasks.get(taskId);
    if (!task) {
      return Promise.reject(
        createError('E_TASK_NOT_FOUND', 'task not found', '删除为物理全删，无墓碑')
      );
    }
    return sleep(timing.queryStepMs).then(function () {
      var elapsed = now() - task.createdAt;
      // cancelled / success 为终态，轮询不得覆盖；仅 processing → saving → success 推进。
      if (task.status !== 'cancelled' && task.status !== 'success') {
        if (elapsed >= task.generateMs + timing.saveMs) {
          task.status = 'success';
          task.resultUrl =
            'https://mock.invalid/results/' + taskId + '_' + task.resolution + '.jpg';
          stats.completed += 1;
        } else if (elapsed >= task.generateMs) {
          task.status = 'saving';
        }
      }
      var progress = Math.min(
        99,
        Math.round((elapsed / (task.generateMs + timing.saveMs)) * 100)
      );
      return {
        taskId: task.taskId,
        status: task.status,
        progress: progress,
        resolution: task.resolution,
        resultUrl: task.resultUrl,
        elapsedMs: elapsed
      };
    });
  }

  function cancel(input) {
    var taskId = (input && input.taskId) || input;
    var task = tasks.get(taskId);
    if (!task) {
      return Promise.reject(createError('E_TASK_NOT_FOUND', 'task not found'));
    }
    task.status = 'cancelled';
    return Promise.resolve({ taskId: taskId, status: 'cancelled' });
  }

  function erase(input) {
    var taskId = (input && input.taskId) || input;
    if (!tasks.has(taskId)) {
      return Promise.reject(createError('E_TASK_NOT_FOUND', 'task not found'));
    }
    tasks.delete(taskId);
    stats.erased += 1;
    return Promise.resolve({ taskId: taskId, erased: true });
  }

  // 时延分解（SPEC 档位口径的模拟值，用于验证 60s 预算计算口径；真实数字需供应商 + 云环境）。
  // 刻意使用 RESOLUTION_PROFILES / DEFAULT_TIMING 常量，不受测试注入的加速 timing/profiles 影响。
  function timingBreakdown(resolution) {
    var profile = RESOLUTION_PROFILES[String(resolution || '2048')] || RESOLUTION_PROFILES['2048'];
    var generate = profile.generateMs;
    return {
      resolution: String(profile.longSide),
      simulated: true,
      stages: {
        uploadMs: 1200,
        precheckMs: DEFAULT_TIMING.validateMs,
        submitMs: DEFAULT_TIMING.submitMs,
        generateMs: generate,
        saveAndDownloadMs: DEFAULT_TIMING.saveMs
      },
      totalMs:
        1200 +
        DEFAULT_TIMING.validateMs +
        DEFAULT_TIMING.submitMs +
        generate +
        DEFAULT_TIMING.saveMs
    };
  }

  return {
    name: 'mock',
    health: health,
    validate: validate,
    submit: submit,
    query: query,
    cancel: cancel,
    erase: erase,
    timingBreakdown: timingBreakdown,
    stats: function () {
      return Object.assign({}, stats);
    },
    pendingTaskCount: function () {
      return tasks.size;
    }
  };
}

module.exports = {
  RESOLUTION_PROFILES: RESOLUTION_PROFILES,
  DEFAULT_TIMING: DEFAULT_TIMING,
  ERROR_CODES: ERROR_CODES,
  buildChecks: buildChecks,
  judge: judge,
  createMockAdapter: createMockAdapter
};
