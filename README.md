# Sinn

微信小程序 + **SA → SE → DEV → QA** 四角色流水线的接入版仓库。
P1「2D 虚拟试穿」内部 demo 已完整走完一轮四角色流水线
（REQ-0001 → SPEC-0001 + TASKS-0001 → DEV-0001 → REPORT-0001）。
技术基线：**skyline 渲染器 + glass-easel + 自定义导航栏**，源码根 `miniprogram/`，文档与测试不进包。

当前状态（2026-11-11）：

```
check-gates.ps1   → 10 个文档, 1 个任务清单, FAIL=0, WARN=0
check-wxapp.ps1   → appid: wx735e60c2c07673aa
                    7 个页面, 0 个分包, 主包 174.6KB / 合计 174.6KB, FAIL=0, WARN=0
jest              → 32 suites / 419 tests 全绿
integration-check → 10/10 PASS（mock 全链路）
e2e（真实云）      → 12 条 L3：4 通过 / 0 失败 / 8 阻塞
```

QA 结论为 **「不通过（demo 阶段阻塞）」**：本阶段可执行证据全部通过，剩余缺口是外部条件
（真实试穿供应商、真机、人工视觉、正式隐私文本等），详见 `docs/qa/REPORT-0001.md`。
**不得提审、不得发布**——发布、提审、灰度、回滚由人执行并签字，agent 不代签。

---

## 1. 目录

```
Sinn/
├─ AGENTS.md              四角色写范围 + 上游门禁 + 小程序专项（agent 自动读取）
├─ project.config.json    appid / miniprogramRoot / cloudfunctionRoot / libVersion
├─ project.private.config.json   开发者工具本地配置（不入库）
├─ miniprogram/           唯一进包的目录
│  ├─ app.js / app.json / app.wxss / sitemap.json
│  ├─ config/env.js       云开发 envId 唯一出处
│  ├─ pages/              7 页：index consent capture garment generating result profile
│  ├─ components/         navigation-bar、zoom-view（1x–3x 双指缩放）
│  ├─ services/           api / consent / precheck / upload / polling / size
│  └─ utils/              util / zoom-math / image-prep
├─ cloudfunctions/        云函数（不入包）：sinn-task / sinn-account / sinn-cleanup
├─ docs/
│  ├─ 00-inbox/           原始需求 RQ-0001.md
│  ├─ sa/ se/ dev/ qa/    各角色产物（REQ / SPEC+TASKS / DEV 交接 / TC+E2E-LOG+REPORT）
│  └─ se/SPEC-MINIAPP-ADDENDUM.md、qa/TEST-STRATEGY.md、qa/RELEASE-CHECKLIST.md
├─ playbooks/             lead / sa / se / dev / qa 作业规程
├─ tests/                 unit/（jest）、e2e/（miniprogram-automator）、mocks/wx.js、fixtures/
└─ tools/
   ├─ check-gates.ps1     文档门禁 + 任务 DAG
   └─ check-wxapp.ps1     页面注册 / 包体积 / 动态代码 / 隐私登记
```

## 2. 先跑一遍门禁

```powershell
cd C:\Users\admin\WeChatProjects\Sinn
& .\tools\check-gates.ps1 -Root .
& .\tools\check-wxapp.ps1 -Root .
```

预期两条都 `FAIL=0`。两个脚本必须保持 **UTF-8 with BOM**，用别的编码另存会报"意外的标记"。

## 3. 开发者工具

导入 `C:\Users\admin\WeChatProjects\Sinn` 即可（`miniprogramRoot` 已指向 `miniprogram/`，
工具会自动只把那个目录打进包，`docs/`、`tests/`、`tools/` 天然被排除）。

> 注意本项目的模板配置：`app.json` 里 `renderer: "skyline"` + `navigationStyle: "custom"`，
> 用的是 `components/navigation-bar`。skyline 下部分 WXSS 选择器（如 `page` 上的继承）
> 行为与 webview 不同——改样式前先确认渲染器，别按 webview 的经验写。

## 4. 接入四角色流程：新开一个会话

四角色流水线按会话独立运行（成员、任务板、上下文都隔离）。同一仓库的下一轮需求建议新开会话，
按下面的启动语把 Lead 拉起来。

**开法：**

1. 新建会话，工作目录设为 `C:\Users\admin\WeChatProjects\Sinn`。
2. 插件页 →「智能体团队」→ 确认开关打开（每个会话独立）。
3. 贴下面的启动语。

### 启动语（整段复制）

```
这是一个微信小程序项目 Sinn，按仓库根 AGENTS.md 走 SA→SE→DEV→QA 四角色流水线。
技术基线：skyline 渲染器 + glass-easel + 自定义导航栏（components/navigation-bar），
源码根是 miniprogram/，文档与测试不进包。

1. 你作为 Lead，先读 README.md、AGENTS.md、playbooks/lead.md。
2. 确认 docs/00-inbox/RQ-0001.md 存在且非空；不存在就先问我，不要自己编需求。
3. 建 SA 任务并 spawn 名为 sa 的成员，只做需求调研，产出 docs/sa/REQ-0001.md。
4. SA 交回后，先把 REQ 的"待确认口径"列给我确认；我确认前不要派 SE。
5. 之后依次走 SE（SPEC + TASKS）→ 我人工评审 → DEV → QA。
6. 每步完成都跑 tools/check-gates.ps1 和 tools/check-wxapp.ps1，FAIL 不许往下走。
```

## 5. 写第一条需求

新建 `docs/00-inbox/RQ-0001.md`，用 `docs/00-inbox/RQ-TEMPLATE.md` 做骨架即可。要点：

- 给谁用、解决什么问题
- 核心流程（点几下、看到什么）
- 明确不要什么（范围外）
- 已知约束：类目、登录、支付、数据来源

## 6. 派 SA 前需要你拍板的三件事

1. **类目与资质**：什么服务类目？是否涉及需资质类目（医疗/金融/教育/招聘/电商/直播）？
2. **数据来源**：自有后台、第三方 API、纯本地？请求域名是否已在公众平台配置？
3. **隐私与授权**：要拿手机号/位置/相册/剪贴板吗？《用户隐私保护指引》谁填？

这三条会进 `docs/se/SPEC-MINIAPP-ADDENDUM.md` 的 F 节，QA 的 `RELEASE-CHECKLIST.md` 逐条核对。

## 7. 角色写范围

| 角色 | 可写 |
|---|---|
| SA | `docs/sa/**`、`docs/00-inbox/**` |
| SE | `docs/se/**` |
| DEV | `miniprogram/**`、`tests/unit/**`、`docs/dev/**` |
| QA | `tests/**`、`docs/qa/**` |

跨角色改文件走消息协商，由 owner 自己动手。

## 8. 常用命令

```powershell
& .\tools\check-gates.ps1 -Root .      # 文档与任务 DAG
& .\tools\check-wxapp.ps1 -Root .      # 页面注册 / 包体积 / 动态代码 / 隐私
# 单测（沙箱内 npm test 会 spawn EPERM，用 node 直跑 jest）
node node_modules\jest\bin\jest.js --runInBand
# mock 全链路自检（无需真实云/供应商）
node docs/dev/integration-check.js
# e2e（真实云 + 开发者工具 connect 模式，需先起 IDE 自动化端口）
node tests/e2e/run-e2e.js
```

## 9. demo 收尾前必须处理

- **移除受保护的调试入口**：`bootstrap` / `selftest` / `precheckDebug` / `cleanupSeed` /
  `cleanupCheck` / `quotaReset` 及 `SINN_SELFTEST` 环境变量（登记见 `docs/dev/DEV-0001.md`
  「上线前移除清单」）。
- **清理本地联调临时物**：`.tmp-*`（假 HOME、CLI 登录凭据、探针脚本、截图），均已被 `.gitignore` 排除。
- **外部解锁项**：轮换已泄露的火山 AK/SK（SEC-01）、开通「图片换装 V2」并实测（CP-04）、
  真机与人工视觉（CP-11/CP-12）、正式隐私文本（CP-10）、素材（E-7）。

## 10. 参考实现

同级的 `C:\Users\admin\Documents\deepseek-harness\default-workspace\devteam-demo` 是同一套流程
跑通成绩 CSV 工具的实证（8 源文件、103 单测、88 条用例、196 全绿）。看作业范本读它的
`docs/se/SPEC-0001.md` 与 `docs/qa/REPORT-0001.md`，但别把它的成员、任务、口径带进 Sinn。
