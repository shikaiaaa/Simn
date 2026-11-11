# 开发流程门禁

本项目按 **SA → SE → DEV → QA** 四角色流水线开发。任何 agent（包括 teammate 和临时子代理）
在本仓库工作时必须遵守以下规则。规则冲突时，以本节为准。

## 1. 角色与写范围

| 角色 | 可写 | 必须只读 |
|---|---|---|
| SA | `docs/sa/**`、`docs/00-inbox/**` | 全部源码 |
| SE | `docs/se/**` | `docs/sa/**`、源码（只读用于评估） |
| DEV | `miniprogram/**`、`cloudfunctions/**`、`tests/unit/**`、`docs/dev/**` | `docs/sa/**`、`docs/se/**`、`docs/qa/**`、根配置（只读） |
| QA | `tests/**`、`docs/qa/**` | `docs/sa/**`、`docs/se/**`、`docs/dev/**`、根配置（只读） |
| Lead | 根配置：`project.config.json`、`project.private.config.json`、`package.json`、`jest.config.js`、`.gitignore`、`AGENTS.md`；集成、门禁执行与任务编排 | `docs/**`（只评审，不代写）、`miniprogram/**`、`cloudfunctions/**` |

跨角色写文件一律禁止。需要对方改，发消息说明"哪条路径、改什么、为什么"，由 owner 自己改。

补充约定（2026-11-09 用户裁定，见 `docs/se/SPEC-0001.md` CP-01/CP-02/CP-03）：

- `cloudfunctions/**` 归 DEV（云函数代码，**不得**放在 `miniprogramRoot` 内，否则会打进小程序包）。
- 根配置（`project.config.json`、`package.json`、`jest.config.js`、`.gitignore`、`tests/mocks/**`）由 Lead 维护；DEV/QA 需要增删依赖或改配置时，发消息给 Lead，由 Lead 改。
- `tests/unit/**` 归 DEV，`tests/e2e/**`、`tests/fixtures/**` 归 QA；`tests/mocks/**` 为共享 mock，由 Lead 维护。

## 2. 上游门禁

- 开工前必须确认上游文档存在，且 frontmatter 中 `status: approved`。
- `draft` / `review` 的上游只能用来阅读和评审，**不得据此实现或测试**。
- 上游变更后，下游必须重新核对；`superseded` 的下游产物要一并归档或重做。

## 3. 任务领取

- 只处理已 `claim` 到自己名下的任务。
- claim 前检查 `dependencies` 全部 `completed`；不满足就等待，不要"先做一部分"。
- 完成后 `complete`，并在同一步里把交接信息发给下游。

## 4. 交付定义（DoD）

一个任务算完成，必须同时具备：

1. 产物文件已写入，frontmatter 字段完整；
2. 交接文档写明：做了什么、改了哪些路径、如何验证、遗留风险；
3. 任务状态已更新为 completed；
4. 已给下游发一条消息，包含**产物路径 + 一句话摘要 + 验收标准**。

缺任何一条都算未完成，下游有权拒收。

## 5. 禁止事项

- 不得替下游"顺手做掉"（DEV 不写测试用例，QA 不改业务代码）。
- 不得在上游未 `approved` 时推进。
- 不得把结论只留在对话里而不落盘。
- 不得跳过 `tools/check-gates.ps1` 直接宣布完成。

## 6. 文档规范

- 文件名与 `id` 同号，全程可追溯（`REQ-0007` 对应 `SPEC-0007`、`TASKS-0007`…）。
- frontmatter 必填：`id`、`title`、`status`、`owner`、`upstream`。
- 状态只能取：`draft`、`review`、`approved`、`superseded`。
- 日期用 `YYYY-MM-DD`。


## 小程序专项门禁（追加到仓库根 AGENTS.md）

本仓库是微信小程序项目，除通用流程门禁外，以下规则同样具有强制力。

### 1. 页面即契约
- 改 `app.json` 的 `pages` / `subPackages` / `tabBar`，必须在同一个任务里同步：页面四件套（`.js` `.json` `.wxml` `.wxss`）、`docs/se/SPEC-*.md` 的页面路由表、`docs/qa/TC-*.md` 的对应用例。
- 只改 `app.json` 不加文件，或只加文件不注册，一律视为未完成。`tools/check-wxapp.ps1` 会直接 FAIL。
- 页面路径一律小写、用 `-` 分词，禁止中文与空格（真机与部分基础库对路径大小写敏感）。

### 2. 包体积是硬预算
- 主包 ≤ 2MB，单个分包 ≤ 2MB，全部分包合计 ≤ 20MB。**超了就是 FAIL，不是 WARN。**
- 新增第三方库、图片、字体前，先在 SPEC 的包体积预算表里登记预计增量；未登记的实现不予验收。
- `docs/`、`playbooks/`、`tests/`、`tools/` 不得位于 `miniprogramRoot` 内。
- 优先用分包 + `lazyCodeLoading: requiredComponents`；整包预下载只在 SPEC 明确要求时使用。

### 3. 禁用与高危 API
- 禁止 `eval`、`new Function`、动态 `require`/`import()` 拼接路径：小程序运行时不支持，且会被审核判为动态代码。
- 新增 `wx.*` 中的隐私类 API（位置、相册、摄像头、剪贴板、手机号、通讯录、蓝牙、麦克风），必须在 SPEC 的「隐私与授权点」表登记：用途、触发时机、拒绝后的降级路径、对应的用户隐私保护指引条目。
- 网络请求域名必须已在公众平台配置；本地调试用 `不校验合法域名` 时必须写进 DEV 交接文档，禁止带进提交版本。

### 4. 测试的边界
- 单元测试用 `miniprogram-simulate` + jest，`wx.*` 走 `tests/mocks/wx.js`；禁止在单测里依赖开发者工具。
- 端到端用 `miniprogram-automator` 连开发者工具，属**环境依赖**：机器上没有开发者工具时，QA 必须把相关用例标为「阻塞」并写明原因，不得标「通过」。
- 授权弹窗、支付、真机兼容、审核结果**不可自动化**，只认 `docs/qa/RELEASE-CHECKLIST.md` 里的人工勾选记录。

### 5. 仓库卫生
- `project.private.config.json` 不入库（本地个人配置）。
- `miniprogram_npm/`、`node_modules/` 由构建生成，不入库。
- 不修改仓库外的任何路径；小程序相关的自动化脚本一律放 `tools/`。

### 6. 发布锚点
- REPORT 结论为「通过」之前，`check-gates.ps1` 与 `check-wxapp.ps1` 必须同时 PASS，且 `RELEASE-CHECKLIST.md` 无未勾选项。
- 发布、提审、灰度、回滚由**人**执行并签字；agent 只能准备材料与检查单，不得代签，不得调用任何提交/发布接口。
