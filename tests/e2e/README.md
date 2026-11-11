# tests/e2e — L3 端到端（QA-0001-02）

本目录是 `docs/qa/TC-0001.md` §4.3 的 **12 条 L3 用例**的执行实现，基于
[`miniprogram-automator`](https://www.npmjs.com/package/miniprogram-automator) 连接微信开发者工具。

> **当前状态（2026-11-10 晚）**：本机改为 **connect 模式**（`SINN_E2E_WS` + `cli.bat auto`），
> 已绕过沙箱无法写 `.cli` 的 EPERM 限制；云开发环境可用（appid `wx735e60c2c07673aa`、
> env `simn-01-d5gjsxm0ocb78add8`），隐私指引已配置。**L3-009 / L3-010 / L3-011 已真实执行通过**；
> 其余用例依赖固定素材（MAT）、真实供应商、测试环境 audit、cleanup seed 等，仍如实标「阻塞」；
> L3-002 因云端 `precheck` 返回 `E_INTERNAL 9000`（真实云缺陷候选，已报 Lead/DEV）暂记失败。
> 详细执行记录与证据见 [`docs/qa/E2E-LOG-0001.md`](../../docs/qa/E2E-LOG-0001.md) v0.2。

## 目录

```
tests/e2e/
├── run-e2e.js          # 执行入口（node，不是 jest；不命中 tests/**/*.test.js，不污染 L1 基线）
├── lib/
│   ├── env.js          # 环境探测：CLI 路径、.cli 标记、登录态、automator 模块、开发者工具进程
│   ├── harness.js      # automator 封装：launch / 页面等待 / 输入 / 云函数调用 / Storage / mock / 计数
│   └── cases.js        # 12 条 L3 用例（TC ID 与 AC 对齐，含 requires 与阻塞条件）
└── results/            # 运行生成物：last-run.json、<runId>/summary.json、逐用例证据
```

**注意**：`results/`、`logs/` 为运行生成物。证据保留在本地供 QA/Lead 复核；是否入库由 Lead 决定。

## 前置条件（全部满足才可能得到「通过」）

1. **开发者工具**已安装并登录；设置 → 安全设置中开启「服务端口」。
2. **二选一连接方式**：
   - **connect（推荐，本机当前方式）**：先由 shell 起自动化端口，再设 `SINN_E2E_WS=ws://127.0.0.1:<port>`；
   - launch（传统方式）：CLI 可写标记 `<User Data>/<hash>/Default/.cli` 必须能被创建
     （当前沙箱 EPERM，故本机不可用，遇此情况 runner 记阻塞 `E2E-B1`）。
3. **云开发**已开通并填入 `envId`，部署 `sinn-task` / `sinn-account` / `sinn-cleanup` 三个云函数，
   建立 5 个集合（`sinn_users`、`sinn_tasks`、`sinn_assets`、`sinn_consents`、`sinn_config`）。
4. **真实供应商**已接入（`SINN_VENDOR` 非 mock）或明确本轮只验 mock（mock 下 AC-7/14 不能判通过）。
5. **微信隐私指引**已在后台声明相册/摄像头（CP-05），否则 `chooseMedia` 真机不可用。
6. **测试环境审计**：`ALLOW_DEBUG_AUDIT=true` 且 `QA_OPENID_WHITELIST` 含执行账号（AC-20 需要）。
7. **固定素材**按 `docs/qa/TC-0001.md` §5 放入 `tests/fixtures/`（不得放进 `miniprogramRoot`），并回填 SHA。
8. 项目 `setting.compileWorklet` 需在开发者工具中勾选「将 JS 编译成 ES5」（若跑缩放相关用例）。

### 环境变量开关（runner 据此判断能否执行）

| 变量 | 值 | 对应依赖 |
|---|---|---|
| `SINN_E2E_CLOUD_READY` | `1` | 云开发与云函数已部署（CP-02） |
| `SINN_E2E_VENDOR_READY` | `1` | 真实供应商可用（CP-04） |
| `SINN_E2E_VIP_READY` | `1` | VIP 白名单已配置（CP-09） |
| `SINN_E2E_PRIVACY_READY` | `1` | 隐私指引已配置（CP-05） |
| `SINN_E2E_AUDIT_READY` | `1` | auditTask 可用（测试环境） |
| `SINN_E2E_CLEANUP_SEEDED` | `1` | 已 seed 到期任务 |
| `SINN_E2E_CLEANUP_TASK_ID` | `t_...` | 到期任务 taskId |
| `SINN_E2E_QUOTA_MODE` | `normal` / `vip` | L3-002 额度档位 |
| `SINN_E2E_VIP_FULL_RUN` | `1` | 允许 VIP 分支真实跑满 10 次 |
| `SINN_E2E_CASE_TIMEOUT_MS` | 默认 `300000` | 单条用例超时 |

未声明对应开关时，runner 会把相关用例记为 **阻塞（附解锁条件）**，不会静默跳过或记通过。

## connect 模式（本机当前方式）

本机沙箱不允许 `automator.launch()`（Node 管道 spawn EPERM），但允许连接一个**已经运行**的
开发者工具自动化端口。做法：

```powershell
# 1) 用隔离的 USERPROFILE 启动带自动化端口的 IDE 窗口（端口掉线后再执行一次即可）
$env:USERPROFILE='C:\Users\admin\WeChatProjects\Sinn\.tmp-cli-home'
& 'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat' auto `
    --project 'C:\Users\admin\WeChatProjects\Sinn' --auto-port 9422 --trust-project
# 看到 {"autoPort":9422,...} 即端口就绪；可用下面确认
Test-NetConnection 127.0.0.1 -Port 9422 -InformationLevel Quiet

# 2) 跑用例（SINN_E2E_WS 存在即走 connect，不传则回退 launch 并标阻塞）
$env:SINN_E2E_WS='ws://127.0.0.1:9422'
$env:SINN_E2E_CLOUD_READY='1'
$env:SINN_E2E_PRIVACY_READY='1'          # 隐私指引已配置时才设
$env:SINN_E2E_QUOTA_MODE='normal'
node tests/e2e/run-e2e.js
```

注意：

- 每次连接断开后自动化端口可能退出，重跑前先 `Test-NetConnection` 确认，掉了就重起第 1 步。
- connect 模式下 `mp.reLaunch()` / `mp.navigateBack()` 偶发 10s 协议超时（IDE 桥延迟，非业务问题）；
  `lib/harness.js` 已改用小程序内 `wx.reLaunch`（`appReLaunch`）并避开「点 consent 复选框后立即导航」，
  新用例请复用这些 helper，不要直接调 `mp.reLaunch`。
- CLI 登录态探测仍可能显示 EPERM（写 `.cli` 失败），connect 模式不依赖它。

## 运行

```powershell
# 环境探测 + 列出用例
node tests/e2e/run-e2e.js --list

# 全量执行（当前预期：12 条全部阻塞，退出码 2）
node tests/e2e/run-e2e.js

# 只跑其中几条
node tests/e2e/run-e2e.js --only=TC-0001-L3-001,TC-0001-L3-003
```

退出码：`0` 全部通过；`1` 存在失败；`2` 无失败但存在阻塞（含环境未就绪）。

## 结果与证据

- `tests/e2e/results/<runId>/summary.json`：本次运行的环境、逐用例状态、结论。
- `tests/e2e/results/last-run.json`：最近一次运行镜像。
- `tests/e2e/results/<runId>/<caseId>/`：用例证据（JSON、截图 `*.png`、失败快照）。
- `tests/e2e/results/logs/cli-*.log`：CLI 探测输出（含失败原文）。

状态只有三种：**通过 / 失败 / 阻塞**。凡未执行或环境不满足一律记「阻塞」并附原因与解锁条件，
**不得**写成通过；截图与耗时必须是真实运行产生。

## 本机阻塞原因与手工执行步骤（环境解锁前）

**阻塞原因**：`automator.launch` 在本机沙箱不可用（无法写 `<User Data>\<hash>\Default\.cli`，EPERM；
`tasklist` 也被沙箱拒绝）。因此本机统一走 connect 模式（见上节）；launch 相关阻塞仍保留在
`docs/qa/E2E-LOG-0001.md` 的 `E2E-B1` 条目中，供无 connect 条件的环境参考。

**其余阻塞**：固定素材 MAT-01..MAT-15 未提供（`tests/fixtures/` 仅有合成冒烟图 `_smoke/`，
非 MAT、不得用于视觉判定）；真实供应商未采购（CP-04，SINN_VENDOR=mock）；测试环境 audit 未开启
（CP-02/AC-20 真实断言）；cleanup 定时任务未 seed；真机未提供（CP-12）。

**解锁前的人工替代步骤**（结果只能记「人工观察」，不能替代自动化通过）：

1. 打开微信开发者工具，导入本仓库（appid `wxbbdcd1c49ad1259a`，miniprogramRoot `miniprogram/`）。
2. 编译预览，按 `docs/qa/E2E-LOG-0001.md` 的逐条步骤手工走查，记录操作人、日期、设备、截图路径。
3. 涉及真实供应商/额度的项，等 CP-04/CP-09 就绪后再执行；涉及删除的项需测试环境审计权限。
