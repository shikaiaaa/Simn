#!/usr/bin/env node
'use strict';
/**
 * tests/e2e/run-e2e.js
 *
 * QA-0001-02 · L3 端到端执行入口（非 jest；文件名不命中 tests/**\/*.test.js，避免污染 L1 基线）。
 *
 * 用法：
 *   node tests/e2e/run-e2e.js                 # 环境探测 + 顺序执行全部 12 条 L3 用例
 *   node tests/e2e/run-e2e.js --list          # 只列出用例与依赖，不执行
 *   node tests/e2e/run-e2e.js --only=L3-001,L3-003
 *   node tests/e2e/run-e2e.js --continue-on-block=1   # 默认就会继续，此参数仅为显式兼容
 *
 * 状态口径（AGENTS.md §4）：通过 / 失败 / 阻塞。阻塞必须带原因与解锁条件，不得记通过。
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 无失败但存在阻塞（含环境未就绪、未启动工具）。
 *
 * 证据：tests/e2e/results/<runId>/summary.json 与逐用例 JSON/截图；
 *      tests/e2e/results/last-run.json 为最近一次运行镜像；logs/ 下保存 CLI 输出。
 * 运行说明见 tests/e2e/README.md；执行记录见 docs/qa/E2E-LOG-0001.md。
 */

const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const archive = require('./lib/archive');

const CASE_TIMEOUT_MS = Number(process.env.SINN_E2E_CASE_TIMEOUT_MS || 300000);

function rel(p) {
  return path.relative(env.ROOT, p).replace(/\\/g, '/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = { list: false, only: null };
  for (const item of argv) {
    if (item === '--list') args.list = true;
    else if (item.indexOf('--only=') === 0) {
      args.only = item
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

/** 环境依赖 flag：requires 里的语义项 → 环境变量与解锁说明。 */
const REQUIRE_FLAGS = {
  cloud: {
    flag: 'SINN_E2E_CLOUD_READY',
    label: '云开发已部署（envId + sinn-task/sinn-account/sinn-cleanup + 5 集合）',
    unlock: 'CP-02：开通云开发环境、填 envId 并部署云函数；确认后设置 SINN_E2E_CLOUD_READY=1',
  },
  'vendor-real': {
    flag: 'SINN_E2E_VENDOR_READY',
    label: '真实试穿供应商可用（非 mock）',
    unlock: 'CP-04：采购/试用供应商并接入 adapter，设置 SINN_VENDOR=<provider>；确认后设置 SINN_E2E_VENDOR_READY=1',
  },
  'vip-whitelist': {
    flag: 'SINN_E2E_VIP_READY',
    label: 'VIP 白名单账号与额度已配置',
    unlock: 'CP-09：在 sinn_config/环境变量配置 VIP openid 白名单；确认后设置 SINN_E2E_VIP_READY=1',
  },
  'privacy-config': {
    flag: 'SINN_E2E_PRIVACY_READY',
    label: '微信后台《用户隐私保护指引》已声明相册/摄像头',
    unlock: 'CP-05：在微信公众平台配置隐私指引并开通相册/摄像头接口；确认后设置 SINN_E2E_PRIVACY_READY=1',
  },
  'test-env-audit': {
    flag: 'SINN_E2E_AUDIT_READY',
    label: '测试环境 auditTask 可用（ALLOW_DEBUG_AUDIT=true + QA openid 白名单）',
    unlock: '在测试环境云函数设置 ALLOW_DEBUG_AUDIT=true、QA_OPENID_WHITELIST=<QA openid>；确认后设置 SINN_E2E_AUDIT_READY=1',
  },
  'cleanup-seeded': {
    flag: 'SINN_E2E_CLEANUP_SEEDED',
    label: '已 seed 到期任务（SINN_E2E_CLEANUP_TASK_ID）',
    unlock: '在测试库构造 purgeAt≤now 的未删除任务并记录 taskId/文件；设置 SINN_E2E_CLEANUP_SEEDED=1 与 SINN_E2E_CLEANUP_TASK_ID=<taskId>',
  },
  login: {
    flag: null,
    label: '开发者工具已登录且 automator 可连接',
    unlock: '打开微信开发者工具完成登录、开启服务端口（设置→安全设置），并确保可写 <User Data>/<hash>/Default/.cli',
  },
  'quota-mode': {
    flag: null,
    label: '额度档位已声明（SINN_E2E_QUOTA_MODE=normal|vip）',
    unlock: '按测试账号设置 SINN_E2E_QUOTA_MODE=normal 或 vip（普通 1 次/日、VIP 10 次/日）',
  },
};

/** 预检 requires：返回 {ok:true} 或 {ok:false, reason, unlock}。 */
function precheckRequirements(caseDef, detection) {
  const requires = caseDef.requires || [];
  for (const req of requires) {
    if (req.indexOf('fixtures:') === 0) {
      const matId = req.slice('fixtures:'.length);
      const info = caseDef.__fixtures && caseDef.__fixtures[matId];
      if (info && info.missing) {
        return {
          ok: false,
          reason: `缺少固定素材 ${matId}：${info.files.map(rel).join(', ')}`,
          unlock: '按 docs/qa/TC-0001.md §5 提供素材到 tests/fixtures/ 并回填 SHA（素材不得放进 miniprogramRoot）',
        };
      }
      continue;
    }
    const rule = REQUIRE_FLAGS[req];
    if (!rule) continue;
    if (rule.flag && process.env[rule.flag] !== '1') {
      return { ok: false, reason: `环境未声明：${rule.label}（缺 ${rule.flag}=1）`, unlock: rule.unlock };
    }
  }
  if (!detection.ready) {
    return {
      ok: false,
      reason: `开发者工具不可连接：${detection.blockers.map((b) => b.code).join(', ')}`,
      unlock: detection.blockers.map((b) => b.unlock).join('；'),
    };
  }
  return { ok: true };
}

function loadCases() {
  const { CASES, MAT } = require('./lib/cases');
  for (const caseDef of CASES) {
    caseDef.__fixtures = {};
    for (const req of caseDef.requires || []) {
      if (req.indexOf('fixtures:') !== 0) continue;
      const matId = req.slice('fixtures:'.length);
      const relPath = MAT[matId];
      const abs = path.join(env.ROOT, 'tests', 'fixtures', relPath);
      caseDef.__fixtures[matId] = { files: [abs], missing: !fs.existsSync(abs) };
    }
  }
  return CASES;
}

function stringifyForFile(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    // evidence 里可能混入 automator 的 Page/连接对象（含 Timer 循环引用），
    // 兜底：丢弃函数、把重复引用替换为 [Circular]，保证 summary/结果文件仍可落盘。
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === 'function') return undefined;
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2
    );
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, stringifyForFile(value) + '\n', 'utf8');
  return rel(file);
}

function printEnvironment(detection) {
  console.log('===== 环境探测 =====');
  console.log(`仓库根        : ${detection.project.path}`);
  console.log(`appid         : ${detection.project.appid}`);
  console.log(`云开发 envId  : ${detection.project.cloudEnvId || '未配置'}`);
  console.log(`miniprogramRoot: ${detection.project.miniprogramRoot}`);
  console.log(`libVersion    : ${detection.project.libVersion}`);
  console.log(`automator     : ${detection.automator.available ? detection.automator.version : '未安装'}`);
  const conn = detection.connect || { mode: 'launch' };
  if (conn.mode === 'connect') {
    console.log(`连接方式      : connect（automator.connect）${conn.endpoint}`);
    console.log(`TCP 探测      : ${conn.reachable ? `可达（${conn.probeMs}ms）` : `不可达（${conn.error}）`}`);
  } else {
    console.log('连接方式      : launch（automator.launch，需 CLI 可写 .cli）');
  }
  console.log(`开发者工具 CLI: ${detection.cli.path || '未找到'}`);
  console.log(
    `CLI 登录态    : ${
      detection.cli.loginOk === null
        ? '未验证（未找到 CLI）'
        : detection.cli.loginOk
          ? '已登录'
          : `不可用（初始化失败${detection.cli.initError ? '：EPERM 写 .cli / IDE 未就绪' : ''}）`
    }`
  );
  for (const item of detection.userData.hashDirs || []) {
    console.log(`User Data     : ${item.dir}（.cli ${item.markerFound ? '存在' : '不存在'}）`);
  }
  console.log(
    `开发者工具进程: ${
      detection.devtools.checked ? (detection.devtools.running ? '运行中' : '未运行') : `无法探测（${detection.devtools.error}）`
    }`
  );
  console.log(`可执行 e2e    : ${detection.ready ? '是' : '否'}`);
  if (!detection.ready) {
    for (const b of detection.blockers) {
      console.log(`  [阻塞] ${b.code}: ${b.message}`);
      console.log(`         解锁: ${b.unlock}`);
    }
  }
  console.log('');
}

function printTable(rows) {
  console.log('===== 执行结果 =====');
  const header = ['用例', 'AC', '状态', '耗时', '说明'];
  console.log(header.join(' | '));
  console.log('--- | --- | --- | --- | ---');
  for (const row of rows) {
    const note = row.status === '阻塞' ? row.reason : row.status === '失败' ? row.error : row.note || '—';
    console.log(`${row.id} | ${row.ac} | ${row.status} | ${row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : '—'} | ${String(note || '—').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(env.RESULTS_DIR);
  ensureDir(env.LOG_DIR);

  const detection = await env.detect();
  printEnvironment(detection);

  let cases;
  try {
    cases = loadCases();
  } catch (e) {
    console.error(`[FATAL] 用例加载失败：${e && (e.stack || e.message || e)}`);
    process.exit(1);
  }
  if (args.only) {
    const wanted = new Set(args.only);
    cases = cases.filter((c) => wanted.has(c.id) || wanted.has(c.id.replace('TC-0001-', '')));
  }
  if (!cases.length) {
    console.error('[FATAL] --only 未匹配任何用例');
    process.exit(1);
  }

  if (args.list) {
    for (const c of cases) {
      console.log(`${c.id} | ${c.ac} | ${c.priority} | ${c.title}`);
      console.log(`  requires: ${(c.requires || []).join(', ') || '无'}`);
    }
    console.log(`\n共 ${cases.length} 条用例（不执行，--list 退出码 0）`);
    return 0;
  }

  const runId = stamp();
  const runDir = path.join(env.RESULTS_DIR, runId);
  ensureDir(runDir);
  const runStartedAt = new Date().toISOString();
  const rows = [];
  /** task-71：本轮真实生成任务，用例通过 ctx.archiveTask 追加；每条用例跑完立即增量归档到 evidence/ */
  const archiveTasks = [];
  let archiveResult = null;
  let archivedEntries = [];
  let lastArchivedCount = 0;
  /**
   * 逐用例即时归档：L3-011 撤回同意会删除该用户全部云端任务/结果（BR-8），L3-006 会物理删除任务，
   * 因此不能等批次结束再下载；每跑完一条就把新增任务落盘，已下载的条目经 known 复用、不重复下载。
   */
  function archiveIncrement() {
    if (!archiveTasks.length || archiveTasks.length === lastArchivedCount) return;
    try {
      archiveResult = archive.finalize({
        runId,
        runDir,
        tasks: archiveTasks,
        known: archivedEntries,
        appid: detection.project.appid,
        envId: detection.project.cloudEnvId,
      });
      archivedEntries = archiveResult.tasks;
      lastArchivedCount = archiveTasks.length;
      console.log(
        `[archive] 增量归档：任务 ${archiveResult.totals.tasks} / 已下载 ${archiveResult.totals.downloaded} / 待归档 ${archiveResult.totals.pending} / 真实调用 ${archiveResult.totals.realCalls} / ¥${archiveResult.totals.costEstimateCny}`
      );
    } catch (e) {
      console.error(`[WARN] 增量归档失败：${e && (e.stack || e.message || e)}`);
    }
  }

  // ---- 环境不可连接：不尝试 launch，全部记阻塞（不得记通过）
  if (!detection.ready) {
    for (const c of cases) {
      rows.push({
        id: c.id,
        ac: c.ac,
        title: c.title,
        status: '阻塞',
        reason: `开发者工具不可连接：${detection.blockers.map((b) => b.code).join(', ')}`,
        unlock: detection.blockers.map((b) => b.unlock).join('；'),
        evidenceDir: null,
      });
    }
  } else {
    let h;
    try {
      h = require('./lib/harness');
    } catch (e) {
      for (const c of cases) {
        rows.push({ id: c.id, ac: c.ac, title: c.title, status: '阻塞', reason: `harness 加载失败：${e && (e.message || e)}`, unlock: '检查 node_modules/miniprogram-automator 安装' });
      }
    }
    if (h) {
      // 预检：全部用例先按依赖判定是否可直接跑
      const runnable = [];
      for (const c of cases) {
        const check = precheckRequirements(c, detection);
        if (!check.ok) {
          rows.push({ id: c.id, ac: c.ac, title: c.title, status: '阻塞', reason: check.reason, unlock: check.unlock, evidenceDir: null });
        } else {
          runnable.push(c);
        }
      }

      if (runnable.length) {
        let launched;
        const connect = detection.connect || { mode: 'launch' };
        try {
          launched = await h.launch({
            cliPath: detection.cli.path,
            wsEndpoint: connect.mode === 'connect' ? connect.endpoint : undefined,
            timeoutMs: Number(process.env.SINN_E2E_LAUNCH_TIMEOUT_MS || 180000),
            resultsDir: runDir,
            logDir: path.join(runDir, 'logs'),
          });
        } catch (e) {
          for (const c of runnable) {
            rows.push({
              id: c.id,
              ac: c.ac,
              title: c.title,
              status: '阻塞',
              reason: `automator.${connect.mode} 失败：${e && (e.message || e)}`,
              unlock:
                connect.mode === 'connect'
                  ? `确认 9420 端口仍可用（每次跑前重起 cli.bat auto），并检查 ${runDir} 下 logs/automator-connect.log`
                  : '检查开发者工具登录态、服务端口、项目信任设置；CLI 需可写 <User Data>/<hash>/Default/.cli，或改用 SINN_E2E_WS connect 模式',
              evidenceDir: null,
            });
          }
        }

        if (launched) {
          writeJson(path.join(runDir, 'launch.json'), {
            mode: launched.info.mode,
            wsEndpoint: launched.info.wsEndpoint || null,
            launchedAt: launched.info.launchedAt,
            launchMs: launched.info.launchMs,
            systemInfo: launched.info.systemInfo,
            consoleLogs: launched.info.logs ? launched.info.logs.length : 0,
          });
          for (const c of runnable) {
            const caseDir = path.join(runDir, c.id);
            ensureDir(caseDir);
            const startedAt = new Date().toISOString();
            const t0 = Date.now();
            const ctx = {
              mp: launched.mp,
              env: detection,
              caseId: c.id,
              caseAc: c.ac,
              caseRunId: runId,
              project: detection.project,
              runDir: caseDir,
              /** task-71：把真实生成任务登记到本轮归档队列（runner 结束时统一下载结果图并写 manifest）。 */
              archiveTask(entry) {
                if (entry && entry.taskEnvelope) archiveTasks.push(entry);
              },
              write(name, data) {
                const file = path.join(caseDir, /\.json$/i.test(name) ? name : `${name}.json`);
                writeJson(file, data);
                return rel(file);
              },
            };
            let row;
            try {
              const output = await Promise.race([
                c.run(ctx),
                new Promise((resolve, reject) => setTimeout(() => reject(new Error(`用例超时（>${CASE_TIMEOUT_MS}ms）`)), CASE_TIMEOUT_MS)),
              ]);
              row = { id: c.id, ac: c.ac, title: c.title, status: '通过', durationMs: Date.now() - t0, startedAt, finishedAt: new Date().toISOString(), evidenceDir: rel(caseDir), output: output === undefined ? null : output };
            } catch (e) {
              const isBlocked = !!(h.CaseBlocked && e instanceof h.CaseBlocked) || e.name === 'CaseBlocked';
              row = {
                id: c.id,
                ac: c.ac,
                title: c.title,
                status: isBlocked ? '阻塞' : '失败',
                durationMs: Date.now() - t0,
                startedAt,
                finishedAt: new Date().toISOString(),
                evidenceDir: rel(caseDir),
                reason: isBlocked ? e.message : undefined,
                unlock: isBlocked ? e.unlock : undefined,
                error: isBlocked ? undefined : String((e && (e.stack || e.message)) || e),
                screenshot: await h.screenshot(launched.mp, caseDir, 'failure').catch(() => null),
              };
            }
            rows.push(row);
            writeJson(path.join(caseDir, 'result.json'), row);
            console.log(`[${row.status}] ${row.id} (${row.ac}) ${row.status === '通过' ? '' : '— ' + (row.reason || row.error || '').split('\n')[0]}`);
            // task-71：逐用例即时归档（避免后续删除/撤回同意清空云端数据导致结果图丢失）。
            archiveIncrement();
          }
          await h.close(launched.mp, launched.info);
          // ---- task-71：收尾再归档一次（幂等；逐用例已在每条用例结束时增量归档）
          archiveIncrement();
          if (archiveResult) {
            console.log('');
            console.log('===== 真实结果归档 =====');
            console.log(
              `任务 ${archiveResult.totals.tasks} / 已下载 ${archiveResult.totals.downloaded} / 待归档 ${archiveResult.totals.pending} / 真实调用 ${archiveResult.totals.realCalls} 次 / 预估成本 ¥${archiveResult.totals.costEstimateCny}`
            );
            console.log(`real-tasks: ${rel(archiveResult.realTasksPath)}`);
            console.log(`manifest  : ${rel(archiveResult.manifestPath)}`);
          }
        }
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const pass = rows.filter((r) => r.status === '通过').length;
  const fail = rows.filter((r) => r.status === '失败').length;
  const blocked = rows.filter((r) => r.status === '阻塞').length;
  const summary = {
    runId,
    startedAt: runStartedAt,
    finishedAt,
    environment: {
      ready: detection.ready,
      connect: detection.connect,
      blockers: detection.blockers.map((b) => ({
        code: b.code,
        message: b.message,
        unlock: b.unlock,
      })),
      project: detection.project,
      automator: detection.automator,
      cli: { path: detection.cli.path, loginOk: detection.cli.loginOk, initError: detection.cli.initError, isLogin: detection.cli.isLogin },
      userData: detection.userData,
      devtools: { checked: detection.devtools.checked, running: detection.devtools.running, error: detection.devtools.error },
      node: detection.node,
      platform: detection.platform,
      flags: Object.fromEntries(
        Object.values(REQUIRE_FLAGS)
          .filter((r) => r.flag)
          .map((r) => [r.flag, process.env[r.flag] === '1'])
      ),
    },
    expected: cases.length,
    pass,
    fail,
    blocked,
    archive: archiveResult
      ? {
          realTasksPath: rel(archiveResult.realTasksPath),
          manifestPath: rel(archiveResult.manifestPath),
          archiveDir: rel(archiveResult.outDir),
          totals: archiveResult.totals,
        }
      : null,
    conclusion:
      fail > 0 ? '存在失败' : blocked > 0 ? '存在阻塞（未通过）' : '全部通过',
    cases: rows,
  };
  const summaryRel = writeJson(path.join(runDir, 'summary.json'), summary);
  writeJson(path.join(env.RESULTS_DIR, 'last-run.json'), summary);
  printTable(rows);
  console.log(`汇总: 期望 ${cases.length} 条 / 通过 ${pass} / 失败 ${fail} / 阻塞 ${blocked}`);
  console.log(`结论: ${summary.conclusion}`);
  console.log(`证据: ${summaryRel}`);
  if (fail > 0) return 1;
  if (blocked > 0) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[FATAL] ${e && (e.stack || e.message || e)}`);
    process.exit(1);
  });
