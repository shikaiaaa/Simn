# Sinn

微信小程序 + **SA → SE → DEV → QA** 四角色流水线的接入版仓库。
业务代码是开发者工具默认模板（`pages/index`、`pages/logs`、`components/navigation-bar`），
已被移到 `miniprogram/` 下，流程文档与门禁已就位。

当前状态：

```
check-gates.ps1   → 3 个文档, 0 个任务清单, FAIL=0, WARN=0
check-wxapp.ps1   → appid: wxbbdcd1c49ad1259a
                    2 个页面, 0 个分包, 主包 14.7KB / 合计 14.7KB, FAIL=0, WARN=0
```

---

## 1. 目录

```
Sinn/
├─ AGENTS.md              四角色写范围 + 上游门禁 + 小程序专项（agent 自动读取）
├─ project.config.json    appid 保留你自己的；miniprogramRoot = miniprogram/
├─ project.private.config.json   开发者工具本地配置（不入库）
├─ miniprogram/           唯一进包的目录
│  ├─ app.js / app.json / app.wxss / sitemap.json
│  ├─ pages/index、pages/logs
│  ├─ components/navigation-bar
│  └─ utils/
├─ docs/
│  ├─ 00-inbox/           原始需求 RQ-0001.md 放这里（无 frontmatter 也行）
│  ├─ sa/  se/  dev/  qa/ 各角色产物，模板已就位
│  └─ se/SPEC-MINIAPP-ADDENDUM.md、qa/TEST-STRATEGY.md、qa/RELEASE-CHECKLIST.md
├─ playbooks/             lead / sa / se / dev / qa 作业规程
├─ tests/                 unit/（miniprogram-simulate + jest）、mocks/wx.js
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

本会话（成绩工具演示）不能复用：成员名永久、任务板有 10 条旧任务、共享 cwd 无隔离。

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
npm test                               # jest + miniprogram-simulate（DEV 首个任务负责搭建）
```

## 9. 参考实现

同级的 `C:\Users\admin\Documents\deepseek-harness\default-workspace\devteam-demo` 是同一套流程
跑通成绩 CSV 工具的实证（8 源文件、103 单测、88 条用例、196 全绿）。看作业范本读它的
`docs/se/SPEC-0001.md` 与 `docs/qa/REPORT-0001.md`，但别把它的成员、任务、口径带进 Sinn。
