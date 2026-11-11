'use strict';
/**
 * tests/e2e/lib/env.js
 *
 * QA-0001-02 · L3 e2e 环境探测（只读为主）。
 *
 * 约束（见 AGENTS.md / docs/dev/SPIKE-0001.md §1）：
 * - 开发者工具 CLI 需要写 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.cli`，
 *   本沙箱下该写入 EPERM，因此 e2e 预期阻塞；本模块只负责把「哪一环不满足」探测清楚。
 * - 沙箱内 Node 的 child_process 使用 piped stdio 会 EPERM，因此 CLI 输出一律重定向到
 *   `tests/e2e/results/logs/*.log`（stdio 用文件描述符，不用 pipe），再读文件。
 * - 不修改仓库外任何路径：只 stat/read 开发者工具安装目录与 User Data，不写探测文件。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RESULTS_DIR = path.join(ROOT, 'tests', 'e2e', 'results');
const LOG_DIR = path.join(RESULTS_DIR, 'logs');
const PROJECT_CONFIG_PATH = path.join(ROOT, 'project.config.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function rel(absPath) {
  if (!absPath) return null;
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function statSafe(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString(), isFile: st.isFile() };
  } catch (e) {
    return { exists: false, error: e.code || e.message };
  }
}

/** 开发者工具 CLI 候选路径（Windows / macOS）。 */
function cliCandidates() {
  const list = [];
  if (process.env.WECHAT_DEVTOOLS_CLI) list.push(process.env.WECHAT_DEVTOOLS_CLI);
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
      'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
      'C:\\Program Files\\Tencent\\微信开发者工具\\cli.bat',
      path.join(process.env.LOCALAPPDATA || '', '微信开发者工具', 'cli.bat'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', '微信开发者工具', 'cli.bat')
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
      '/Applications/微信开发者工具.app/Contents/MacOS/cli'
    );
  }
  return list.filter(Boolean);
}

function findCli() {
  for (const candidate of cliCandidates()) {
    const st = statSafe(candidate);
    if (st.exists && st.isFile) return candidate;
  }
  return null;
}

/** 可能的 User Data 根目录（CLI 会在其下 hash 目录写 .cli 标记）。 */
function userDataRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, '微信开发者工具', 'User Data'));
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, '微信开发者工具', 'User Data'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(process.env.HOME || '', 'Library', 'Application Support', '微信开发者工具', 'User Data'));
  }
  return roots;
}

/** 扫描 User Data：hash 目录 + .cli 标记（<hash>/Default/.cli 与 <hash>/.cli）。 */
function inspectUserData() {
  const roots = userDataRoots();
  const hashDirs = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const markerCandidates = [path.join(dir, 'Default', '.cli'), path.join(dir, '.cli')];
      const markers = markerCandidates.map((p) => ({ path: p, ...statSafe(p) }));
      hashDirs.push({
        dir,
        markers,
        markerFound: markers.some((m) => m.exists),
      });
    }
  }
  const active = hashDirs.filter((d) => d.markerFound);
  return {
    roots,
    hashDirs: hashDirs.map((d) => ({
      dir: rel(d.dir),
      markerFound: d.markerFound,
      markers: d.markers.map((m) => ({ path: rel(m.path), exists: m.exists, mtime: m.mtime || null })),
    })),
    markerFound: active.length > 0,
    markerPath: active.length ? rel(active[0].markers.find((m) => m.exists).path) : null,
    note: 'CLI 首次使用时写入 .cli；本沙箱对该路径写入 EPERM（SPIKE-0001 §1）。',
  };
}

function automatorInfo() {
  try {
    const pkgPath = require.resolve('miniprogram-automator/package.json');
    const pkg = readJson(pkgPath) || {};
    return { available: true, version: pkg.version || null, entry: rel(require.resolve('miniprogram-automator')) };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * 运行 CLI 子命令，stdout/stderr 重定向到结果目录日志文件（避免 sandbox 管道 EPERM）。
 * @returns {{command:string[], exitCode:number|null, signal:string|null, error:string|null, output:string, logFile:string|null}}
 */
function runCliToFile(cliPath, args, timeoutMs = 20000) {
  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, `cli-${Date.now()}.log`);
  let fd = null;
  let proc = null;
  try {
    fd = fs.openSync(logFile, 'w');
  } catch (e) {
    return { command: [], exitCode: null, signal: null, error: `open log failed: ${e.message}`, output: '', logFile: null };
  }
  try {
    if (process.platform === 'win32') {
      // 注意：cmd.exe 的参数若含引号会被 Node 二次转义（出现 \" 而是 not recognized），
      // 这里用 windowsVerbatimArguments 原样传入，并采用 cmd 要求的 ""..."" 形式包住带空格的路径。
      const command = `""${cliPath}" ${args.join(' ')}"`;
      proc = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
        stdio: ['ignore', fd, fd],
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      proc = spawnSync(cliPath, args, { stdio: ['ignore', fd, fd], timeout: timeoutMs });
    }
  } catch (e) {
    proc = { status: null, signal: null, error: e };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* ignore */
    }
  }
  let output = '';
  try {
    output = fs.readFileSync(logFile, 'utf8').slice(0, 4000);
  } catch (e) {
    /* ignore */
  }
  return {
    command: process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', `"${cliPath}"`, ...args] : [cliPath, ...args],
    exitCode: proc && typeof proc.status === 'number' ? proc.status : null,
    signal: proc && proc.signal ? proc.signal : null,
    error: proc && proc.error ? String(proc.error.message || proc.error) : null,
    timedOut: Boolean(proc && proc.error && proc.error.code === 'ETIMEDOUT'),
    output,
    logFile: rel(logFile),
  };
}

/** 开发者工具进程是否在运行（tasklist 输出重定向到文件，避免管道）。 */
function devtoolsProcess() {
  if (process.platform !== 'win32') return { checked: false };
  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, `tasklist-${Date.now()}.log`);
  let fd = null;
  try {
    fd = fs.openSync(logFile, 'w');
    spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq 微信开发者工具.exe', '/NH'], {
      stdio: ['ignore', fd, fd],
      timeout: 8000,
      windowsHide: true,
    });
  } catch (e) {
    /* ignore */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
    }
  }
  let output = '';
  try {
    output = fs.readFileSync(logFile, 'utf8').slice(0, 800);
  } catch (e) {
    /* ignore */
  }
  const denied = /access denied|拒绝访问/i.test(output);
  return {
    checked: !denied,
    running: denied ? null : /微信开发者工具|WeChatDevTools/i.test(output),
    error: denied ? 'tasklist 被沙箱拒绝（Access denied），进程状态不可探测' : null,
    output,
    logFile: rel(logFile),
  };
}

/** 解析 SINN_E2E_WS（ws://host:port[/path]）。 */
function parseWsEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const m = /^(wss?):\/\/([^/:]+)(?::(\d+))?/i.exec(text);
  if (!m) return null;
  const secure = m[1].toLowerCase() === 'wss';
  return {
    endpoint: text,
    host: m[2],
    port: Number(m[3] || (secure ? 443 : 80)),
  };
}

/** TCP 连通探测（connect 模式用；不写任何文件）。 */
function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (e) {
        /* ignore */
      }
      resolve(Object.assign({ probeMs: Date.now() - started }, result));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, error: null }));
    socket.once('timeout', () => finish({ reachable: false, error: `TCP connect timeout（${timeoutMs}ms）` }));
    socket.once('error', (e) => finish({ reachable: false, error: String((e && (e.code || e.message)) || e) }));
  });
}

/** 云开发环境 ID（唯一出处 miniprogram/config/env.js，只读）。 */
function readCloudEnvId() {
  const file = path.join(ROOT, 'miniprogram', 'config', 'env.js');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /ENV_ID\s*=\s*['"]([^'"]+)['"]/.exec(text);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * 环境探测主入口（异步：connect 模式需 TCP 探测 9420）。
 *
 * 两种连接方式：
 * - `SINN_E2E_WS=ws://127.0.0.1:9420`：由 shell 先 `cli.bat auto --auto-port 9420`，
 *   本进程用 `automator.connect` 连接（沙箱下 launch 的 pipe spawn 永久 EPERM）。
 * - 未设置：回退 `automator.launch`，需 CLI 可写 .cli（当前沙箱仍阻塞 E2E-B1）。
 *
 * @returns {Promise<object>} blockers 里每条 = { code, message, unlock }
 */
async function detect() {
  const projectConfig = readJson(PROJECT_CONFIG_PATH) || {};
  const automator = automatorInfo();
  const cliPath = findCli();
  const userData = inspectUserData();
  const connectMode = String(process.env.SINN_E2E_WS || '').trim().length > 0;
  const ws = parseWsEndpoint(process.env.SINN_E2E_WS || '');
  const wsProbe = ws ? await probeTcp(ws.host, ws.port, Number(process.env.SINN_E2E_WS_PROBE_MS || 3000)) : null;
  const cliState = cliPath ? runCliToFile(cliPath, ['islogin'], 20000) : { skipped: true, exitCode: null };
  const cliInitError = !cliState.skipped && /initialize error|EPERM|Please ensure that the IDE has been properly installed/i.test(cliState.output || '');
  const devtools = devtoolsProcess();
  const cloudEnvId = readCloudEnvId();

  const blockers = [];
  if (!automator.available) {
    blockers.push({
      code: 'AUTOMATOR_MODULE_MISSING',
      message: `miniprogram-automator 不可用：${automator.error || 'require 失败'}`,
      unlock: '在仓库根执行 npm install（依赖由 Lead/根配置维护，QA 不改根配置）。',
    });
  }
  if (connectMode) {
    if (!ws) {
      blockers.push({
        code: 'WS_ENDPOINT_INVALID',
        message: `SINN_E2E_WS 不是合法 ws 地址：${process.env.SINN_E2E_WS}`,
        unlock: '设置 SINN_E2E_WS=ws://127.0.0.1:9420（端口与 cli.bat auto --auto-port 一致）',
      });
    } else if (!wsProbe.reachable) {
      blockers.push({
        code: 'WS_UNREACHABLE',
        message: `连不上自动化端口 ${ws.endpoint}（${wsProbe.error}）。请在 shell 先启动：$env:USERPROFILE='<repo>\\.tmp-cli-home'; & '<微信开发者工具>\\cli.bat' auto --project '<repo>' --auto-port ${ws.port} --trust-project`,
        unlock: '启动 cli.bat auto 并确认输出含 {"autoPort":9420,...}；端口会随连接关闭而退出，每次跑前重起。',
      });
    }
  } else {
    if (!cliPath) {
      blockers.push({
        code: 'DEVTOOLS_CLI_MISSING',
        message: '未找到微信开发者工具 CLI（cli.bat / cli）。',
        unlock: '安装微信开发者工具，或用 WECHAT_DEVTOOLS_CLI 环境变量指向 cli；登录后开启「设置 → 安全设置 → 服务端口」。',
      });
    }
    if (!userData.markerFound) {
      blockers.push({
        code: 'CLI_MARKER_MISSING',
        message: `未找到 CLI 通信标记 .cli（<User Data>/<hash>/Default/.cli）。CLI 只有在开发者工具已登录并开启服务端口后才会写入；本沙箱写该路径 EPERM。cli islogin 原始输出见 ${cliState.logFile || '（无日志）'}${cliInitError ? '（含 EPERM：operation not permitted, open ...\\Default\\.cli）' : ''}。`,
        unlock: '人工在微信开发者工具中登录、打开本项目、开启服务端口（会生成 .cli）；若 CLI 仍需写该路径，需给 e2e 专用机 / 非沙箱环境；或改用 connect 模式（SINN_E2E_WS）。见 SPIKE-0001 §1、DEV-0001 B-5。',
      });
    } else if (cliState.exitCode !== 0 || cliInitError) {
      blockers.push({
        code: 'CLI_ISLOGIN_FAILED',
        message: `cli islogin 退出码 ${cliState.exitCode === null ? 'null（可能超时/无法启动）' : cliState.exitCode}${cliInitError ? '，且输出含 initialize error / EPERM' : ''}；输出见 ${cliState.logFile || '（无日志）'}。`,
        unlock: '在开发者工具中扫码登录开发者账号，并重试；如输出含 "Please ensure that the IDE has been properly installed" 则为 IDE/CLI 安装态问题（SPIKE-0001 §1）。',
      });
    }
  }

  const ready = blockers.length === 0 && automator.available;
  return {
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    project: {
      path: ROOT,
      appid: projectConfig.appid || null,
      miniprogramRoot: projectConfig.miniprogramRoot || null,
      libVersion: projectConfig.libVersion || null,
      compileType: projectConfig.compileType || null,
      cloudEnvId,
    },
    automator,
    connect: {
      mode: connectMode ? 'connect' : 'launch',
      requested: connectMode,
      endpoint: ws ? ws.endpoint : process.env.SINN_E2E_WS || null,
      host: ws ? ws.host : null,
      port: ws ? ws.port : null,
      reachable: wsProbe ? wsProbe.reachable : null,
      probeMs: wsProbe ? wsProbe.probeMs : null,
      error: wsProbe ? wsProbe.error : null,
    },
    cli: {
      path: cliPath,
      candidates: cliCandidates().map((p) => ({ path: p, ...statSafe(p) })),
      loginOk: cliState.skipped ? null : cliState.exitCode === 0 && !cliInitError,
      initError: cliInitError,
      isLogin: cliState.skipped
        ? { skipped: true }
        : {
            exitCode: cliState.exitCode,
            signal: cliState.signal,
            timedOut: cliState.timedOut,
            error: cliState.error,
            output: cliState.output,
            logFile: cliState.logFile,
          },
    },
    userData,
    devtools,
    ready,
    blockers,
    notes: [
      '本探测不写仓库外路径；CLI 输出/进程查询均重定向到 tests/e2e/results/logs/。',
      'connect 模式（SINN_E2E_WS）绕过 .cli EPERM：先由 shell 起 cli.bat auto --auto-port，再由本进程 automator.connect。',
      'ready=true 只代表具备连开发者工具的前提，不等于用例可跑：AC-7/14/20 还依赖真实供应商（CP-04）与素材（CP-11）。',
    ],
  };
}

module.exports = {
  ROOT,
  RESULTS_DIR,
  LOG_DIR,
  PROJECT_CONFIG_PATH,
  cliCandidates,
  findCli,
  inspectUserData,
  automatorInfo,
  runCliToFile,
  devtoolsProcess,
  detect,
  rel,
};
