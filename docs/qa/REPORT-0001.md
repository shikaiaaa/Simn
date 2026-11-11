---
id: REPORT-0001
title: Sinn 微信小程序 QA-0001 测试报告（demo 阶段）
status: approved
owner: qa
upstream: [TC-0001]
created: 2026-11-10
updated: 2026-11-11
---

# REPORT-0001 · Sinn 微信小程序 QA-0001 测试报告（demo 阶段，v0.2）

> 对应上游：`docs/qa/TC-0001.md`（v0.4，approved）、`docs/qa/E2E-LOG-0001.md`（v0.3，approved）、
> `docs/se/SPEC-0001.md`（approved）§G 人工卡点、`docs/dev/DEV-0001.md`（部署与云端缺陷修复记录）。
> 执行人：QA（agent）；执行时间：**2026-11-11 00:19–00:30（Asia/Shanghai）**；v0.1 基线为 2026-11-10 00:19–00:21。
> 执行环境：本机沙箱（Windows / Node v24.16.0）+ **真实微信开发者工具（connect 模式）+ 真实云开发环境**；
> 无真机、无真实试穿供应商账号（`SINN_VENDOR=mock`）、无正式隐私文本。

## 结论

**不通过（demo 阶段阻塞）**。

本阶段可执行证据全部通过：**L1 单元测试 32 suites / 419 tests 全绿**、全链路自检 **10/10 PASS**、
L3 端到端 **12 条中 4 条真实执行通过（L3-002/009/010/011）、0 失败、8 阻塞**、两条强制门禁 **FAIL=0**。
按最新证据汇总，AC-1..AC-26 为：**通过 12 / 部分 3 / 阻塞 11 / 不通过 0**。

但 SPEC-0001 §G 仍有未闭合卡点：真实试穿供应商（CP-04b/c/d，0 次真实调用）、真机（CP-12）、
人工视觉验收（CP-11）、隐私正式文本（CP-10）、VIP 白名单（CP-09）、真实测试素材（E-7）等；
按 SPEC §G「任何未闭合卡点未解除前 REPORT 不得给通过」的硬性规定，本报告结论只能为**不通过**。

**这是 demo 阶段的预期状态，不是产品质量不合格**：实现侧证据（单测、mock 全链路、真实云部署、4 条真实 e2e、门禁）均已通过，
剩余缺口全部来自外部环境、资质与人工验收条件。阻塞项、责任方与解锁条件见 §7。

**文档状态说明**：本报告 v0.2 已于 2026-11-11 经 Lead 复核批准置 `approved`。
`approved` 仅表示文档评审通过，**不代表测试通过**；测试结论始终以本「结论」节为准（仍为「不通过（demo 阶段阻塞）」）。

## 1. 执行概况

### 1.1 环境与命令

| 项 | 值 |
|---|---|
| 执行时间 | 2026-11-11 00:19–00:30（Asia/Shanghai）；e2e 最终全量 00:21:36–00:24:02 |
| 工作目录 | `C:\Users\admin\WeChatProjects\Sinn` |
| 运行时 | Node v24.16.0；jest 29.7.0；miniprogram-automator 0.12.1 |
| 小程序 | 正式 AppID `wx735e60c2c07673aa`；基础库 3.18.0；开发者工具 connect 模式（`ws://127.0.0.1:9422`） |
| 云开发 | env `simn-01-d5gjsxm0ocb78add8`；`sinn-task`/`sinn-account`/`sinn-cleanup` **Active**，timeout=20s / memory=256MB；5 集合 + 4 索引；`sinnCleanupEvery10m` 定时触发器已创建并实测（2026-11-11 00:15:57 创建；seed 00:16:48 → 触发 00:20 → check 00:21:18 count=0）。证据：DEV-0001 §DEV-0001-31、§DEV-0001-41、B-1 |
| 供应商 | **`SINN_VENDOR=mock`**（真实供应商未接入，CP-04b/c/d 未闭合） |
| 单测命令 | `node node_modules\jest\bin\jest.js --runInBand` |
| 全链路自检 | `node docs/dev/integration-check.js`（mock provider，无需真实供应商） |
| e2e 命令 | `node tests/e2e/run-e2e.js`（connect 模式；`SINN_E2E_WS=ws://127.0.0.1:9422` + `SINN_E2E_CLOUD_READY=1` + `SINN_E2E_PRIVACY_READY=1` + `SINN_E2E_QUOTA_MODE=normal`） |
| 门禁 1 | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-gates.ps1 -Root .` |
| 门禁 2 | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-wxapp.ps1 -Root .` |

### 1.2 用例与判定口径（按 TC-0001 的 70 条用例）

| 项 | 数值 | 说明 |
|---|---|---|
| 用例总数 | 70 | L1 16 / L2 33 / L3 12 / L4 6 / G（门禁）3 |
| 已执行并通过 | 48 | L1 16（jest 32 suites / 419 tests）+ L2 已自动化 25 + G 3 + **L3 4**（runId `20261111-002136`） |
| 待固化 | 8 | L2-002/003/004/005/025/026/031/032（TC 定义：部分自动化或待 QA-0002 固化，本轮不虚报通过） |
| 阻塞（未执行） | 14 | L3 8 条（001/003/004/005/006/007/008/012）+ L4 6 条（人工视觉/真机） |
| 失败 | 0 | 本轮 e2e 失败 0；无新增未修复产品缺陷 |
| 有结论用例 | 70/70（100%） | 每条均为「通过 / 待固化 / 阻塞（未执行）」之一，无未判定项 |
| 真实执行率 | 48/70 = 68.6% | 22 条因环境/人工条件未执行（14 阻塞 + 8 待固化），不计入执行率 |

> 口径说明：TC-0001 规定「阻塞用例只能写『阻塞（未执行）』+解锁条件，不得写通过/部分通过」。
> `integration-check` 与 mock 单测结果仅作为 L1/L2 证据；L3 结论只采用 `docs/qa/E2E-LOG-0001.md` v0.3 的真实执行证据。
> 与 task-33 描述中「阻塞 18」的差异：18 为 v0.1 旧口径（L3 12 + L4 6）；4 条 L3 转为通过后，阻塞应为 14。

### 1.3 已执行证据原文

**证据 E-1：L1 单元测试（本机实跑 2026-11-11，exit 0）**

```text
Test Suites: 32 passed, 32 total
Tests:       419 passed, 419 total
Snapshots:   0 total
Time:        4.497 s
JEST_EXIT=0
```

**证据 E-2：全链路自检 `node docs/dev/integration-check.js`（本机实跑，exit 0）**

```text
[PASS] 1. 首页读取 profile（未同意） :: consent=null, quota=5/5
[PASS] 2. consent 两步同意 + recordConsent + 本地缓存 :: 版本=2026-11-09-v1，审计仅含用户/版本/时间/hash
[PASS] 3. 人像采集（上传+assetRegister 幂等+服务端 precheck+表单） :: asset=a_b98bb22a7915987f2a13d679，预检 status=pass，metrics.gender=male
[PASS] 4. 衣服采集 + createTask（预扣额度/单活跃/参数校验） :: taskId=t_f69fbebbb59e69f6953384ca，remaining=4
[PASS] 5. 生成轮询（阶段/等待秒数/SUCCEEDED+转存） :: seen=GENERATING→SUCCEEDED，waitedSec=1
[PASS] 6. 结果页数据（服务端 sizeResult 格式化/AI 标识/降级提示） :: range=L–XL，standard=标准：GB/T 1335.1，disclaimer 合规
[PASS] 7. 删除本次（物理删对象+记录，重复查询 404，auditTask exists=false） :: deletedAt=1794196801500，对象删除 3 个，任务记录 0
[PASS] 8. 删除全部（物理全删/幂等/保留同意审计） :: deletedTasks=1，deletedAssets=2，二次 deletedTasks=0
[PASS] 9. sinn-cleanup 到期物理清理（无墓碑、对象+记录全删） :: scanned=1，deleted=1，failed=0
[PASS] 10. 额度与同意状态（删除后保留已用额度、同意记录可查询） :: used=2，consent=2026-11-09-v1

===== 汇总 =====
{ "passed": 10, "blocked": 0, "failed": 0 }
INTEG_EXIT=0
```

> 该脚本按设计重写 `docs/dev/integration-check-result.json`（DEV 侧生成物，QA 不手工编辑）。

**证据 E-3：L3 e2e 真实执行（connect 模式 + 真实云，exit 2）**

- runId **`20261111-002136`**；2026-11-11 00:21:36–00:24:02；期望 12 条 / **通过 4 / 失败 0 / 阻塞 8**；退出码 2。
- 通过（4 条，均为真实云）：

| 用例 | AC | 耗时 | 关键证据 |
|---|---|---|---|
| TC-0001-L3-002 | AC-11 | 45.7s | 普通额度 1/1 → 0/1；第 2 次 `2001 E_QUOTA_EXHAUSTED` 拦截并停留衣服页，提示「今日额度已用完，明日 00:00 重置」；`firstTaskId=t_e2a82cfce0912e4251b054ee` |
| TC-0001-L3-009 | AC-21 | 23.4s | 拒绝后 `chooseMedia=0`；同意后 `requirePrivacyAuthorize=1`；本地 `sinn_consent_v1` 与服务端同意记录一致 |
| TC-0001-L3-010 | AC-23 | 66.0s | 7/7 页真实渲染（index/consent/capture/garment/generating/result/profile），DOM 扫描 0 处范围外入口 |
| TC-0001-L3-011 | AC-25 | 11.2s | 18+/条款未确认时继续按钮 disabled；伪造 `ageConfirmedAt=0` 缓存后仍落 consent 页、`chooseMedia=0` |

- 阻塞（8 条，未执行）：L3-001/004/005/006/007/012（真实供应商 CP-04）、L3-003（MAT-01 素材）、L3-008（cleanup seed）。
- 证据：`tests/e2e/results/20261111-002136/summary.json`（14,670B，SHA256 `F0400CC364BFD61456488041F6CEAF1CE91218CA0B915B1A92730FF38B4753EC`）、日志 `tests/e2e/results/logs/full-run-final.log`（3,560B，SHA256 `8937EEC77923EE05EB2588C3F518DA25605B50FEDDBB3B1D72C4A3D3E80B1EEB`）。
- 样例说明与限制：**L3-002 的生成段使用云端 mock vendor + 合成 smoke 图（非 MAT 固定样张），只验证真实云额度/拦截链路**；AC-7/14/15 的真实供应商生成质量未验。connect 模式存在截图陈旧帧限制（T-5），AC-23 以 DOM 扫描结果为准、补充截图取 runId `20261110-225611`。
- 逐条失败修复过程、E2E-B1..B10、工具链 T-1..T-5 见 `docs/qa/E2E-LOG-0001.md` v0.3。

**证据 E-4：强制门禁（本机实跑，均 exit 0）**

```text
ok    TASKS-0001.json: 14 个任务，DAG 合法
结果: 10 个文档, 1 个任务清单, FAIL=0, WARN=0
```

> 说明：本报告置 `approved` 后复跑，`RELEASE-CHECKLIST`（review）的上游 `REPORT-0001` 已 approved，
> 门禁 WARN 随之消失，**FAIL=0 / WARN=0**。此前 review 期间曾出现 1 条「上游 REPORT-0001 尚未 approved」
> 的 WARN，属审批流程的正常中间态，已随批准解除。

```text
ok   appid: wx735e60c2c07673aa
结果: 7 个页面, 0 个分包, 主包 174.6KB / 合计 174.6KB, FAIL=0, WARN=0
```

包体积：主包 174.6KB，对 SPEC-0001 §D 内部预算 200KB 占 87.3%（余量 12.7%），平台硬限 2048KB，PASS。

**证据 E-5：AC-26 双表映射数值核实（node 直调 `cloudfunctions/sinn-task/lib/size.js` 的 `computeSize`，exit 0）**

同一组数值 `{heightCm:168, weightKg:60, chestCm:88, waistCm:72, hipCm:94}`：

| gender | range | standard |
|---|---|---|
| male | `M–L` | `GB/T 1335.1` |
| female | `L–XL` | `GB/T 1335.2` |
| unspecified | `L–XL` | `GB/T 1335（中性映射）` |

三种 gender 的 `disclaimer` 均为「参考尺码，不构成合身承诺」。`SIZE_FIXTURES` 6 组固定预期见 TC-0001 §6。

**证据 E-6：历史缺陷定向回归（本机实跑，均 exit 0）**

```text
√ 已同意且已确认 18+ 可进入
√ 有同意记录但 18+ 未确认（ageConfirmedAt=0）仍回 consent 页
√ 第一步校验：18+ 与禁止条款必须显式确认（不默认勾选）
√ AC-25：18+ 未确认时 ensureUploadAllowed 为 false
√ revokeConsent：物理删除全部数据、取消进行中任务并退款、清同意、审计保留
√ deleteAll：物理删除全部、进行中退款一次、成功任务不退款、保留同意与额度
√ recordConsent：version 非法/18+ 未确认被拒
```

## 2. AC-1..AC-26 汇总

统计：**通过 12 / 部分 3 / 阻塞 11 / 不通过 0**（合计 26）。
判定规则：AC 的验证层（L1/L2/L3/人工/门禁）中，可执行部分全部通过且无未闭合关键卡点 = 通过；部分验证层可执行、关键层仍受外部条件阻塞 = 部分；核心判定条件因外部条件完全无法执行 = 阻塞。

| AC | 结论 | 主要证据（2026-11-11 复核） | 剩余缺口 / 备注 |
|---|---|---|---|
| AC-1 | 通过 | `precheck-l0.test.js`（表单/数值/枚举）、`capture-page.test.js`、handler 参数校验、integration step3/4 | 无（真实预检另见 AC-2） |
| AC-2 | 阻塞 | L1 子码 3002、`precheck-l0.test.js` 计时口径；L2-002 待固化 | 真实样张 ≤5s 需真实供应商预检（CP-04b/c/d）+ MAT 素材；L3-012 阻塞 |
| AC-3 | 阻塞 | L1 子码 3003/3004（`precheck.test.js`）；L2-003 待固化 | 同上（CP-04 + MAT） |
| AC-4 | 阻塞 | L1 子码 3001；L2-004 待固化 | 同上（CP-04 + MAT） |
| AC-5 | 阻塞 | L1 子码 3006；L2-005 待固化 | 同上（CP-04 + MAT） |
| AC-6 | 通过 | `generating-page.test.js` 失败态 WXML 无 img、`result-page.test.js` 未成功不展示 | 无（真实供应商失败码另见 AC-10） |
| AC-7 | 阻塞 | L3-001 未执行（缺真实供应商） | 真实供应商 60s 3/3；CP-04b/c/d、MAT |
| AC-8 | 通过 | `generating-page.test.js`（stage/waitedSec 展示、无虚假百分比） | 无 |
| AC-9 | 通过 | `polling.test.js`（服务端 TIMEOUT + 本地 65s 硬超时、59s 不提前） | 无 |
| AC-10 | 部分 | mock 六类失败独立文案（`generating-page.test.js`、`handler.test.js` 4001/5001/5002/5005） | 真实供应商失败码映射未验（CP-04） |
| AC-11 | 通过（有限制） | **L3-002 真实云通过**（额度 1/1→0/1、2001 拦截、提示与停留）；`profile-helpers.test.js`/`profile-page.test.js`、`handler.test.js` 2001/2002、integration step4/10 | **额度链路在真实云 + mock vendor + 合成 smoke 图上通过**；真实供应商生成段未验；VIP 10/11 分支仍阻塞 CP-09 |
| AC-12 | 部分 | `generating-page.test.js` 恢复路径、integration step5 | L3-003 冷启动恢复因 MAT-01 缺失阻塞 |
| AC-13 | 阻塞 | `zoom-view.test.js`（S2 兜底 + S2+ worklet 数学、边界、复位、双击） | 真机手势与帧率未测；CP-12 |
| AC-14 | 阻塞 | L2 仅覆盖降级提示结构；无真实结果图 | 真实供应商输出分辨率 3/3；CP-04b/c/d、CP-07、CP-11 |
| AC-15 | 阻塞 | 无真实结果图 | 真实输出 + 人工视觉 3/3；CP-04、CP-11 |
| AC-16 | 通过 | `size.test.js`（SIZE_FIXTURES、三标准名、免责、禁词）、`result-page.test.js` | 无 |
| AC-17 | 通过 | `size.test.js`（三围全缺 → null）、`result-page.test.js` 信息不足文案 | 无 |
| AC-18 | 阻塞 | `result-page.test.js` 静态断言 `.result-ai-badge` 在 zoom-view 外 | 真机 1x–3x/滚动后可见；CP-11/CP-12 |
| AC-19 | 部分 | `result-page.test.js` 二次确认/取消不删/404 按成功；integration step7 | L3-006 真云删除因真实供应商阻塞 |
| AC-20 | 阻塞 | `handler.test.js` 物理删/`deletedAt`/重复 404/`auditTask exists=false`；integration step7/8/9；真实触发器已实测执行清理（DEV-0001 §41） | 真实云存储对象 **HEAD 404** 未验证（audit 白名单未配）；L3-007/008 阻塞 |
| AC-21 | 通过（有限制） | **L3-009 真实云通过**（拒绝→`chooseMedia=0`、授权 1 次、记录一致）；`consent-service.test.js`/`consent-page.test.js`、`profile-page.test.js` 撤回 | 后台隐私指引已配置（E2E-B4 解除）；**正式文本核对（L4-005）仍属 CP-10 人工项**，不影响本轮 L2/L3 判定 |
| AC-22 | 通过 | G-001/002/003（双门禁实跑、包体积 174.6KB/200KB=87.3%、工程边界/禁用 API） | 无 |
| AC-23 | 通过（有限制） | **L3-010 真实云通过**（7/7 页真实渲染、DOM 0 命中）；`result-page.test.js`/`profile-page.test.js` 静态断言、`size.test.js` 禁词 | L2-025/026 仍待固化（QA-0002），静态断言已存在；截图受 T-5 限制 |
| AC-24 | 阻塞 | `garment-page.test.js` 四类拦截 3008/3009/3010/3011（createTask 0 次）、`precheck.test.js` | 真实样张与真实供应商预检能力；CP-04 + MAT |
| AC-25 | 通过（有限制） | **L3-011 真实云通过**（18+ 门禁 + ageConfirmedAt=0 回归）；`consent-service.test.js`/`capture-page.test.js` | 真机人工走查（L4-006）仍属 CP-12 人工项 |
| AC-26 | 通过 | `size.test.js`、E-5 三 gender 直调核实、`result-page.test.js` 三 gender 展示（部分） | 无（L2-031/032 待固化不影响本轮 L1 判定） |

> 与 DEV-0001 自检（20 已实现 / 5 部分 / 1 阻塞）差异说明：DEV 的「已实现」是代码层口径；QA 的「通过」要求验证层证据完整。
> 本轮 AC-11/21/23/25 因 L3 真实执行通过而上调；AC-2/3/4/5/13/14/15/18/20/24 因真实供应商/真机/素材/audit 缺口标阻塞。

## 3. 用例执行明细（按层）

| 层 | 总数 | 已执行通过 | 待固化 | 阻塞（未执行） | 说明 |
|---|---|---|---|---|---|
| L1 单元 | 16 | 16 | 0 | 0 | jest 32 suites / 419 tests 全绿（2026-11-11） |
| L2 组件-页面 | 33 | 25 | 8 | 0 | 待固化：L2-002/003/004/005/025/026/031/032（见 TC §4、§8） |
| L3 端到端 | 12 | **4** | 0 | **8** | runId `20261111-002136`；通过 L3-002/009/010/011 |
| L4 人工 | 6 | 0 | 0 | 6 | 人工视觉/真机/隐私文本，见 §8 |
| G 门禁 | 3 | 3 | 0 | 0 | check-gates / check-wxapp / 工程边界扫描 |
| **合计** | **70** | **48** | **8** | **14** | 失败 0 |

## 4. 缺陷清单

### 4.1 本轮新增产品缺陷（均已修复并复核）

| 编号 | 缺陷 | 修复要点 | QA 复核证据 | 状态 |
|---|---|---|---|---|
| DEF-0004 | 真实云 precheck 写库报 `-502001`：assetRegister 初始化 `precheck:null`，handler `updateAsset` 深合并写 `precheck.at` → `Cannot create field 'at' in element {precheck: null}`，被最外层包装为 `E_INTERNAL 9000`（task-37） | `updateDoc` 对顶层对象字段改用 `db.command.set` 整字段替换；assetRegister 不再写 `precheck:null`；fake db 单测复现 | precheckDebug 定位 `failedStep=step6_updateAsset`；修复后同一 assetId 直调 precheck 返回 `ok:true/status=pass/12 checks`，证据 `tests/e2e/results/precheck-recheck-20261110151321.json`（SHA256 `3917C247…3E0CEE7`） | 已修复 · 复核通过 |
| DEF-0005 | mock vendor 跨 invocation 状态丢失：云函数每次调用新建 adapter，内存 `tasks` 不共享 → createTask 的 `vt_1` 在 taskGet 中不存在 → `query` reject → 5001（task-38） | mock vendor 改无状态：`vt_<base36(submittedAt)>_<seq>` + 时间推导状态；结果图为合法 2048×3072 PNG | 修复后 L3-002 于 `20261111-002136` 真实通过；证据见 E2E-LOG v0.3 §3.1/§4 | 已修复 · 复核通过 |

### 4.2 历史缺陷复核（DEF-0001..DEF-0003）

| 编号 | 缺陷 | 修复要点 | QA 复核证据 | 状态 |
|---|---|---|---|---|
| DEF-0001 | AC-25 门禁失效：同意但未确认 18+ 仍可进入采集/上传（`consent.js` 把显式 `ageConfirmedAt:0` 回退成 `agreedAt`） | `hasAgeFlag` 判断，显式 0 保留；仅缺字段回退 | `capture-page.test.js`「有同意记录但 18+ 未确认仍回 consent 页」；`consent-service.test.js`「18+ 未确认时 ensureUploadAllowed=false」；L3-011 真实云复验通过 | 已修复 · 复核通过 |
| DEF-0002 | 额度误退：`purgeAllUserData` 对 `SUCCEEDED` 任务也退款 | 只对进行中与非 `SUCCEEDED` 终态幂等退款 | `account.test.js`「deleteAll：进行中退款一次、成功任务不退款」；integration step10 `used=2` | 已修复 · 复核通过 |
| DEF-0003 | 任务失败字段丢失：`failureCode` 误取 `ERROR_CODES` 不存在的 `code` 字段 | 写数值 `code`；taskGet 用 `getMeta(task.failureCode)` 回填 | `handler.test.js:464` 断言 `failure.code=4001`；`:475` 5005；`:557` 9000 且记录保留 | 已修复 · 复核通过 |

### 4.3 测试工具说明（非产品缺陷）

- **DEF-0006（不列入产品缺陷）**：task-40 的 `quotaReset` 是 **DEV-0001-40 受保护测试夹具**，仅用于本地 demo 测试链路在额度窗口受限时复位当日额度；**不是产品接口、不写入任何 e2e 用例、上线前移除**。使用记录（3 次）与 requestId/哈希见 E2E-LOG v0.3 §6.3。
- QA 工具链问题 T-1..T-5（L3-010 假通过、结果页 taskId 读取、提示等待时序、summary 循环引用崩溃、connect 模式截图陈旧帧）均已修复或记录，见 E2E-LOG v0.3 §5.1；未改产品代码。

## 5. 未测与风险

| 未测项 | 原因 | 风险 |
|---|---|---|
| AC-7 真实 60s 端到端 3/3 | 真实供应商未接入（CP-04b/c/d） | 60s 时限与 2048px 分辨率可能冲突（SPEC R-3），上线前必须实测 |
| AC-14/15 真实输出分辨率与视觉质量 | 0 次真实供应商调用（CP-04）；人工视觉执行人/样张未确认（CP-11） | 2D 换装真实度上限（R-10）、接缝/块状马赛克风险 |
| AC-13/18 真机手势、缩放后 AI 标识 | 无真机（CP-12）；connect 截图 T-5 限制 | S2+ worklet 跨线程跟手、帧率 ≥45fps 未实测（R-1） |
| AC-20 真实云存储对象 HEAD 404 | audit 白名单未配置（E2E-B6）；真实对象删除验证未做 | 物理全删与「无墓碑」语义在真实云存储层面未验证（R-6/R-7）；清理触发器已实测，但 OBJECT 级须补 |
| AC-21 正式隐私文本核对 | CP-10 未提供正式文本 | 文本与 8 项披露不符可能影响合规 |
| 真实供应商失败码映射（AC-10/24） | CP-04 未接入 | mock 子码与真实失败码可能不一致（R-2/R-5） |
| VIP 额度分支（AC-11 VIP） | CP-09 无 VIP openid 白名单 | VIP 10/11 行为无真实证据 |
| 弱网/断网/超时真机 | 无真机/真实网络 | 仅本地 65s 看门狗单测覆盖 |
| 人工 L4 6 条 | CP-10/CP-11/CP-12 未闭合 | 授权弹窗、真机兼容、视觉判定无人工记录 |
| 云函数运行时版本 | 当前 `Nodejs16.13`（无 Node18 选项） | 与 SPEC/长期支持版本存在偏差，属残余风险（DEV-0001 §41） |
| **供应商 AK/SK 安全** | **用户目前仍使用旧 AK/SK 且未轮换（历史对话中曾出现，按安全最佳实践应立即作废/轮换）**；当前 `SINN_VENDOR=mock` 未启用真实调用 | 启用真实供应商前必须先轮换凭证并只放云函数环境变量；泄露的旧密钥不得复用。属发布前阻断项（SEC-01） |

## 6. 已实现但缺真实环境证据的条目（实现侧已完成，验收证据不足）

| AC | 实现侧证据（已通过） | 缺什么证据 |
|---|---|---|
| AC-2/3/4/5 | 服务端预检子码 3001–3006 + mock 适配器（`precheck.test.js`、`handler.test.js`）、端上 L0（`precheck-l0.test.js`） | 真实样张命中子码、≤5s 时延（L3-012） |
| AC-7 | 状态机、轮询、65s 看门狗、integration 5 步（mock 生命周期） | 真实供应商 3/3 ≤60s 墙钟 |
| AC-10/24 | mock vendor 场景 + 子码映射 + UI 文案（单测） | 真实供应商失败码与真实衣服图拦截 |
| AC-12 | 三级恢复路径（单测） | 冷启动后恢复同一任务（L3-003，缺 MAT-01） |
| AC-13/18 | zoom-view S2/S2+ 实现与数学断言、AI badge 静态位置 | 真机手势、帧率、1x–3x/滚动后可见 |
| AC-14/15 | 结果页结构、降级提示、免责与禁词 | 真实结果图 + 人工视觉 3/3 |
| AC-19/20 | 物理删除 handler + integration step7/8/9 + 清理触发器实测 | 真实云对象 HEAD 404（audit 白名单） |
| AC-21 | 真实云 e2e 已通过（L3-009） | 正式文本逐条核对（L4-005，CP-10） |
| AC-23 | 真实云 e2e 已通过（L3-010） | 无（L2-025/026 待固化为增强证据） |
| AC-25 | 真实云 e2e 已通过（L3-011） | 真机首次流程人工走查（L4-006，CP-12） |

## 7. 阻塞项、责任方与解锁条件（REPORT 结论为「不通过」的直接原因）

| 编号 | 阻塞内容 | 影响 AC / 用例 | 责任方 | 解锁条件 |
|---|---|---|---|---|
| CP-02 | 云开发环境（原为未提供） | 已影响 AC-7/12/19/20；L3-002/003/006/007/008/009 | 需求方 → DEV/Lead | **已完全闭合（2026-11-11，DEV-0001 §41）**：env、3 云函数 Active/timeout=20/memory=256、5 集合+4 索引、`sinnCleanupEvery10m` 触发器实测生效。**闭合 ≠ 验收通过**，验收由本报告与 e2e 决定 |
| CP-04b | 火山引擎账号/AK/SK 凭证未提供（真实供应商 adapters 未实测） | AC-7/10/14/15/24；L3-001/004/012；L4-002/003 | 需求方 | 开通「图片换装 V2」并配置 AK/SK；**旧 AK/SK 已泄露须先轮换**；凭证只放云函数环境变量 |
| CP-04c | 供应商报价 / Q-21 成本上限未提供 | AC-7 成本与可行性 | 需求方 + SE | 提供报价与成本上限，SE 更新 SPEC |
| CP-04d | 真实时延/失败码/输出能力未实测（0 次真实调用） | AC-7/14/15、真实失败码映射 | DEV + QA | 接入后 `SINN_VENDOR=volcengine`；QA 执行 L3-001/004/012 与 CP-07 复核 |
| CP-05 | 微信隐私指引（原未配置） | AC-21；L3-009/012；L4-006 | 运营/需求方 | **已配置**：真实 `wx.getPrivacySetting` 返回 `available:true`、`privacyContractName=《身映小程序隐私保护指引》`（E2E-B4 解除）；真机系统弹窗走查并入 CP-12/L4-006 |
| CP-09 | VIP 白名单未提供 | AC-11 VIP 分支；L3-002 VIP | 需求方/运营 | 提供 demo openid 白名单与 `SINN_VIP_WHITELIST` 配置 |
| CP-10 | 隐私正式文本未评审（draft） | AC-21 文本核对；L4-005 | 需求方 | 提供正式文本并评审通过 |
| CP-11 | 人工视觉验收执行人/固定样张/判定标准未确认 | AC-14/15/18；L4-002/003/004 | QA + 用户（指定执行人） | 提供 3 组固定样张（含 1x/3x 裁切）；指定执行人；确定判定记录表 |
| CP-12 | 无真机 iOS+Android；开发者工具 CLI `.cli` 仍 EPERM（connect 绕过） | AC-13/18/25；L4-001/004/006 | 需求方/环境管理员 | 提供真机并允许 `.cli` 写入（管理员启动 IDE/ACL）；真机前 S2+ 只写「实现完成、未实测」 |
| E-7 | 真实测试素材 MAT-01..MAT-15 未提供（仅有 `_smoke` 合成图） | L3-003/012、L4 人工视觉 | QA + 需求方 | 按 TC-0001 §5 采集素材，落 `tests/fixtures/**`、回填 SHA256；素材不得进 `miniprogramRoot` |
| E2E-B5 | VIP 白名单未配置（e2e 视角） | L3-002 VIP 分支 | Lead/需求方 | 配置后置 `SINN_E2E_VIP_READY=1` |
| E2E-B6 | 测试环境 auditTask 未配置（`ALLOW_DEBUG_AUDIT`/`QA_OPENID_WHITELIST`） | L3-007 | Lead/DEV | 测试环境置 `ALLOW_DEBUG_AUDIT=true` + QA openid 白名单；置 `SINN_E2E_AUDIT_READY=1` |
| E2E-B7 | MAT 素材缺失 | 涉及 MAT 的 L3 与 L4 | 需求方/QA | 同 E-7 |
| E2E-B8 | 24h 清理未在 e2e 中 seed 到期任务 | L3-008 | QA | seed `purgeAt≤now` 未删除任务；置 `SINN_E2E_CLEANUP_SEEDED=1` + `SINN_E2E_CLEANUP_TASK_ID`；**真实触发器本身已由 DEV-0001 §41 实测生效** |
| SEC-01 | 旧供应商 AK/SK 未轮换（历史对话泄露） | 真实供应商启用（CP-04b） | 需求方/DEV | 作废旧密钥、生成新密钥、仅配置为云函数环境变量；启用真实供应商前必须完成 |

> 未闭合 CP 对 REPORT 的影响：按 SPEC-0001 §G，上述卡点未解除前 REPORT 不得给「通过」。因此即使本地与真实云可执行证据全绿，本报告结论仍为「不通过（demo 阶段阻塞）」。

## 8. 人工项（L4）执行情况

| 用例 | 内容 | 状态 | 执行人要求 |
|---|---|---|---|
| L4-001 | 真机 iOS + Android 主链路走查 | 阻塞（未执行） | QA + 需求方（CP-12） |
| L4-002 | AC-14 固定样张 1x/3x 分辨率与纹理人工判定 | 阻塞（未执行） | QA + 用户（CP-11，需 3/3 记录） |
| L4-003 | AC-15 接缝/明暗断层/矩形拼接人工判定 | 阻塞（未执行） | QA + 用户（CP-11，需 3/3 记录） |
| L4-004 | AC-18 真机 AI 标识可见性 | 阻塞（未执行） | QA + 需求方（CP-11/CP-12） |
| L4-005 | 隐私文本与同意页 8 项披露人工核对 | 阻塞（未执行） | QA + 需求方（CP-10） |
| L4-006 | 微信隐私授权弹窗/拒绝降级真机走查 | 阻塞（未执行） | QA + 需求方（CP-05 已配置，真机仍待 CP-12） |

人工项**不得由 agent 代替执行或签字**；执行后需在 `docs/qa/RELEASE-CHECKLIST.md` 对应行填写执行人、日期、设备/样张哈希与截图路径，届时另行更新报告。

## 9. 风险与回归建议

### 9.1 关键风险

- **SEC-01（高）**：旧供应商 AK/SK 未轮换且曾在对话中出现；启用真实供应商前必须作废/轮换，否则存在凭据泄露风险。
- **R-3（SPEC）** 60s 时限与 2048px 分辨率可能冲突：真实供应商时延未知，需 CP-04 解锁后实测，必要时按 CP-07 走 1536px 降级 + 用户复核。
- **R-6/R-7** 云函数无 HTTP 码、物理全删不可追溯：AC-20 需 `error.httpStatus`+`deletedAt`+`auditTask exists=false`+真实存储 HEAD 404 组合断言；当前 HEAD 404 缺口未补。
- **R-5** 供应商无独立预检端点：真实预检依赖视觉模型选型（或供应商失败码映射），unknown 必须不放行（3013）。
- **R-1** S2+ worklet 跨线程跟手/帧率只在数学层验证，真机未测。
- **R-12** 云存储无法按文件隔离（已登录可读），需在隐私/合规评估中记录。
- **T-5** connect 模式截图陈旧帧：页面判定以 DOM/JSON 为准；真机/人工视觉证据仍须补齐。
- **运行时**：云函数 Nodejs16.13（当前环境无 Node18 选项），需在上线前确认生命周期。

### 9.2 复测建议（按解锁顺序）

1. **CP-04b/c/d 解锁**：轮换 AK/SK → 开通火山图片换装 V2 → DEV 接入并切换 `SINN_VENDOR=volcengine` → QA 执行 L3-001（60s 3/3）、L3-004（2048/1536）、L3-012（真实样张子码）、L3-006（真实供应商删除链路）→ CP-07 复核。
2. **E2E-B6/B8 解锁**：配置 audit 白名单、seed 到期任务后重跑 L3-007/008（触发器已实测，只需补对象 HEAD 404 与 e2e 链路）。
3. **E-7 解锁**：补齐 MAT-01..MAT-15 素材并记录 SHA256 → 重跑 L3-003/L3-012 与 L4 视觉项。
4. **CP-09 解锁**：VIP 白名单 → L3-002 VIP 10/11 分支。
5. **CP-12 解锁**：真机 iOS/Android → L4-001/004/006，AC-13/18/25 真机项；同时 `.cli` 写权限可恢复 launch 模式（可选）。
6. **CP-10 解锁**：正式隐私文本 → L4-005 文本逐条核对。
7. **CP-11 解锁**：固定样张 + 执行人 + 判定表 → L4-002/003，AC-14/15 签署记录。
8. 待固化 8 条（L2-002/003/004/005/025/026/031/032）在 QA-0002 固化后重跑；本轮已如实标注，不计入通过。

复测通过判定：对应 AC 的 L1+L2+L3（及人工）证据齐全、3/3 判定、无阻塞；届时由 Lead 复核后另行出具报告版本，结论才可改为「通过」或「有条件通过」。

## 10. 结论对发布的影响

- 当前不满足「REPORT 结论为通过」的任何发布前置条件（AGENTS.md §6：REPORT 通过前双门禁 PASS 且 RELEASE-CHECKLIST 无未勾选项）。
- `docs/qa/RELEASE-CHECKLIST.md` 整体状态仍为「未就绪」；本轮仅更新了自动化可验证项中已有真实证据的条目（L3 4 条通过、真实云部署），人工项与发布动作保持空白。
- **不得提审、不得发布、不得灰度**。发布、提审、灰度、回滚由**人**执行并签字，agent 不代签、不调用任何发布接口。

## 11. 附录：证据文件索引

| 证据 | 路径 | 说明/哈希 |
|---|---|---|
| TC 用例与 AC 映射 | `docs/qa/TC-0001.md`（v0.4，approved） | 70 条用例、26/26 AC 映射；L3 状态已同步 E2E-LOG v0.3 |
| e2e 执行记录 | `docs/qa/E2E-LOG-0001.md`（v0.3，approved） | 12 条逐条结果、E2E-B1..B10、T-1..T-5、59 个证据哈希 |
| e2e 结果摘要（最终全量） | `tests/e2e/results/20261111-002136/summary.json` | 14,670B；SHA256 `F0400CC364BFD61456488041F6CEAF1CE91218CA0B915B1A92730FF38B4753EC` |
| e2e 运行日志（最终全量） | `tests/e2e/results/logs/full-run-final.log` | 3,560B；SHA256 `8937EEC77923EE05EB2588C3F518DA25605B50FEDDBB3B1D72C4A3D3E80B1EEB` |
| L3-002 证据 | `tests/e2e/results/20261111-002136/TC-0001-L3-002/ac11-normal.json` | 1,288B；SHA256 `AF999C92EA5DF772CDDCE149B802BD016790EA416A16A99AFEE57FDEC3C9B775` |
| precheck 修复复测（DEF-0004） | `tests/e2e/results/precheck-recheck-20261110151321.json` | 2,221B；SHA256 `3917C247BB64EB0B9B05E8742F37FF63134BA3902791158706DC324FF3E0CEE7` |
| 全链路自检 | `docs/dev/integration-check.js` / `docs/dev/integration-check-result.json` | 10/10 PASS（2026-11-11 复跑）；生成物由 DEV 侧维护 |
| 单测 | `tests/unit/**` | 32 suites / 419 tests，jest 全绿，exit 0 |
| 门禁 | `tools/check-gates.ps1`、`tools/check-wxapp.ps1` | FAIL=0；主包 174.6KB（87.3% / 200KB） |
| 云端部署与缺陷记录 | `docs/dev/DEV-0001.md` | §DEV-0001-31/§DEV-0001-35/§DEV-0001-37/§DEV-0001-38/§DEV-0001-39/§DEV-0001-41；B-1/B-2/B-3 |
| 发布检查单 | `docs/qa/RELEASE-CHECKLIST.md` | 自动化项更新；人工项留空；整体未就绪 |

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-11-10 | 初稿：执行证据（jest 21/304、integration 10/10、e2e 12 阻塞、双门禁 FAIL=0）、AC 8/15/3、缺陷复核、未测与风险、阻塞项/责任方/解锁条件、复测建议、发布影响。status: review（待 Lead 复核；agent 不自行 approved）。 |
| v0.1（审批） | 2026-11-10 | Lead 复核通过：结论仍为「不通过（demo 阶段阻塞）」；approved 仅表示文档评审状态，不代表测试通过。 |
| v0.2 | 2026-11-11 | 基于真实云 + connect 模式 e2e 重写：L1 更新为 32 suites/419 tests；e2e 最终全量 `20261111-002136`（4 通过/0 失败/8 阻塞，L3-002/009/010/011 通过）；AC 汇总改为 12/3/11（AC-11/21/23/25 上调通过并注明限制）；用例统计 48/8/14；新增 DEF-0004（precheck -502001）、DEF-0005（mock vendor 跨 invocation）已修复复核；DEF-0006 仅作为测试夹具说明（非缺陷）；CP-02 改「已完全闭合（DEV-0001 §41）」；CP-04 拆 04b/04c/04d；新增 SEC-01（旧 AK/SK 未轮换）；增补真实云部署、触发器实测、T-5 截图限制与运行时残余风险；结论保持「不通过（demo 阶段阻塞）」。status 由 approved → review（待 Lead 复核 v0.2，agent 不自行 approved）。 |
| v0.2（审批） | 2026-11-11 | Lead 复核通过（全文 353 行）：status review → **approved**。**approved 仅表示文档评审状态，不代表测试通过**；结论仍为「不通过（demo 阶段阻塞）」，AC 12/3/11/0、用例 48/8/14 不变。Lead 确认「阻塞 18（v0.1 旧口径）→ 14」换算正确（48+8+14=70），无需回改。 |
