---
id: SPIKE-0001
title: DEV-0001-01 SPIKE：结果图缩放 / 预检 / 供应商 / 云开发 / 端上图片预处理可行性
status: review
owner: dev
upstream: [SPEC-0001]
created: 2026-11-09
updated: 2026-11-09
---

# SPIKE-0001（DEV-0001-01）技术验证报告

> 任务：`TASKS-0001.json` → DEV-0001-01（spike：结果图缩放 / 试穿供应商 / 云开发 / 预检 / 图片预处理）
> 上游：`docs/se/SPEC-0001.md` v0.2（approved）决策 D-2 / D-3 / §B / §D / §E / §F
> 本机环境：Windows，Node v24.16.0，无真机、无云开发 envId、无供应商 API 试用账号。
> 原则：**能测的测，测不到就标「阻塞 + 解锁条件」，不虚报。**

## 0. 结论总览（8 个验收项）

| # | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 产出本报告，逐项给结论 + 证据 | **通过** | 本文件；`docs/dev/spike-verify/last-run.json`（46/46 断言 PASS） |
| 2 | Skyline 双指缩放 1x–3x / 平移 / 复位，S1、S2 两方案；真机 iOS+Android | **S1 不通过（官方判定不可用）；S2 部分通过（数学逻辑通过，渲染/延迟未实测）；真机项阻塞** | 微信官方「组件(Component)支持情况」表；`zoom-math` 13/13 断言；临时页实现记录 |
| 3 | 云开发可用性（云函数/云存储/云数据库/定时触发器） | **阻塞（无 envId）**；本地契约验证 8/8 通过 | `fixtures/vendor-mock` selftest 107ms 跑通完整生命周期；解锁清单见 §3 |
| 4 | ≥3 家试穿 API 对比（输入/品类/分辨率/耗时/并发/试用/报价/境内/资质/数据留存） | **部分通过**：Perfect Corp、腾讯云 MPS 文档级对比完成；火山引擎/阿里云仅确认产品存在，接口细节未取到 → **待确认** | §4 对比表；文档 URL 已列 |
| 5 | 60s 内 2048px / 1536px 各 3 次实测、阶段耗时分解 | **阻塞（无 API 账号，0 次真实调用）**；提供 SPEC 口径的模拟分解：2048=15870ms、1536=10870ms，均在 60s 内 | Mock 分解 + 复跑脚本；CP-07 建议见 §5 |
| 6 | 预检能力结论（单人/全身含脚/遮挡/多人/逆光/吊牌/多件/模特上身/电商图） | **供应商 validate 不通过（未公开预检接口）**；替代方案（端上校验 + 服务端视觉模型 + 供应商失败码兜底）**待实现/待验证** | 供应商文档；Mock 三态契约 12/12 |
| 7 | 端上图片预处理（EXIF / JPG/PNG / 长边 ≤4096 / ≤10MB）在 Skyline 下的可行性 | **纯函数通过 13/13；canvas 实渲染阻塞（无真机/工具 CLI 授权）** | `miniprogram/utils/image-prep.js`；单测脚本 |
| 8 | 移除临时页 / 临时云函数 / 还原 app.json 并留证 | **通过** | §8 清理清单与前后目录、门禁原文 |

**一句话结论**：官方文档已判定 S1（`movable-area`/`movable-view`）在 Skyline 上不可用，D-3 必须改为「S2+ 手势组件 + worklet 为主、S2 touch+transform 兜底」；其余真机 / 云开发 / 供应商实测均因缺设备、缺 envId、缺 API 账号而阻塞，已逐项写成可执行的解锁条件与 30 分钟内可跑的脚本/清单。**不得在未解锁前宣称任何真机或真实供应商结论。**

## 1. 环境与阻塞总览

| 资源 | 状态 | 影响 | 解锁条件 |
|---|---|---|---|
| 真机 iOS / Android | 无设备 | 第 2 项双指手势跟手、Skyline worklet 动画、第 7 项 canvas 实渲染均无法实测 | 提供至少 1 台 iOS + 1 台 Android，扫码预览；或由 Lead/用户在执行侧截图/录屏回传 |
| 微信开发者工具 automator | **不可用**：CLI 需写 `C:\Users\admin\AppData\Local\微信开发者工具\User Data\<hash>\Default\.cli`，被沙箱 EPERM 拒绝；`cli islogin` 报 `Please ensure that the IDE has been properly installed` | 无法自动截图/自动遍历页面 | 在沙箱外由 Lead/用户执行 CLI，或给 CLI 放行该 User Data 写权限 |
| 云开发环境 | **未开通（无 envId）** | 第 3 项云函数/存储/数据库/定时触发器均未实测；`spike-vendor` 未部署 | 提供 envId + 云开发权限；按 §3 清单 30 分钟内可跑 |
| 供应商 API 试用账号 | 无 | 第 4/5/6 项真实调用、真实耗时、报价、预检能力全部未核实 | Perfect Corp / 火山引擎 / 阿里云 / 腾讯云任一试用账号；拿到后按 `docs/dev/spike-verify` 的 Mock 契约替换实现即可实测 |
| npm 安装 | 默认缓存目录在沙箱外导致 EPERM；已用 `$env:npm_config_cache=<工作区>\.npm-cache` + `npm install --ignore-scripts --no-audit --no-fund` 装好 371 包 | 无（仅环境说明） | 已解决；`--ignore-scripts` 是因沙箱禁止 piped 子进程 |

## 2. 验收项 2：Skyline 缩放 / 平移 / 复位（S1 vs S2 vs S2+）

### 2.1 官方依据（决定性）

微信官方小程序文档「组件(Component)支持情况」表中，**`movable-area` / `movable-view` 在 Skyline 列标注为「暂不考虑」，备注为「可用手势 + worklet 动画方案替代」**（官方文档站正文抓取时被导航截断，实际正文经官方文档镜像 `miniapp.bilibili.com/miniprogram-docs` 取得，内容与官方一致；检索时间 2026-11-09）。

Skyline 手势组件官方能力（同源文档）：
- 支持 `scale-gesture-handler`、`pan-gesture-handler` 等手势组件；回调必须是 `'worklet'` 函数，运行在 UI 线程，不冒泡；
- 通用属性：`worklet:ongesture`、`worklet:should-response-on-move`、`worklet:should-accept-gesture`、`simultaneous-handlers`、`native-view`、`tag`；
- `scale` 手势事件字段：`state/focalX/focalY/focalDeltaX/focalDeltaY/scale/horizontalScale/verticalScale/rotation/velocityX/velocityY/pointerCount`；
- `pan` 手势事件字段：`state/absoluteX/absoluteY/deltaX/deltaY/velocityX/velocityY`；手势状态 `State { POSSIBLE=0, BEGIN=1, ACTIVE=2, END=3, CANCELLED=4 }`；
- `bl.worklet` 提供 `shared/derived/runOnUI/runOnJS/timing/spring/decay/sequence/repeat/delay/Easing`；页面/组件方法 `applyAnimatedStyle(selector, updaterWorklet)`、`clearAnimatedStyle`；worklet 仅 Skyline，且开发者工具需勾选「将 JS 编译成 ES5」。

### 2.2 结论

- **S1（`movable-area` + `movable-view`，`scale` 1–3、`direction=all`）：不通过。** 官方标记 Skyline 不支持；临时页保留 S1 模式仅用于实证，本地无工具/真机可跑渲染，因此「实际无响应」只有文档级证据，没有截图/录屏（不虚报）。
- **S2（手写 touch + transform，JS 线程 `setData`）：部分通过。** 数学层 13/13 通过（focal 锚点不变、1x–3x 夹取、平移边界、等比 transform、复位、60 帧捏合模拟），但 Skyline 下 touch 事件跨线程有延迟，跟手性未实测 → 真机阻塞。作为**兜底方案**可用。
- **S2+（`scale`/`pan` 手势组件 + `worklet` + `applyAnimatedStyle`）：实现完成、未运行。** 临时页 `spike-zoom` 三个模式（touch / worklet / movable）已实现；由于无开发者工具授权、无真机，worklet 动画运行效果未实测 → 真机阻塞。**建议 S2+ 作为主实现路径，S2 作为降级路径。**

### 2.3 证据

- 纯数学：`miniprogram/utils/zoom-math.js`（自临时页 `pages/spike-zoom/zoom-math.js` 迁出保留，结果页将复用）。
- 验证：`node docs/dev/spike-verify/run-all.js` → `zoom-math（S2 缩放数学，Node 纯函数）(13/13)`，含「模拟 60 帧双指捏合：scale 单调递增且始终在 [1,3]、不越界 :: finalScale=3.000」。
- 临时页实现（已按第 8 项删除，代码思路见本次交接）：`touch` 模式用 `zoomAt/panBy` 计算后 `setData` 到 `transform`；`worklet` 模式用 `bl.worklet.shared` 保存 scale/tx/ty，在 `onScaleGesture`（BEGIN 记录基准、ACTIVE 做 focal 锚定缩放与边界夹取）与 `onPanGesture`（ACTIVE 累加/夹取、END 经 `runOnJS` 回主线程）中直接改 shared 值；`movable` 模式为 `movable-area`/`movable-view` 实证入口。
- 已知缺口：worklet 分支中原先用 `this._stageWidth`/`_contentWidth`，已修正为测量后同步标量字段；仍需真机验证 `applyAnimatedStyle` 选择器、手势嵌套与边界行为。

### 2.4 阻塞与解锁

- 解锁条件：拿到开发者工具 CLI 写权限或真机；真机步骤：进入临时页（本次已删，可临时恢复或等结果页实现后回归）→ 三模式各做「双指放大到 3x、缩小到 1x、单指平移、复位」→ 观察跟手延迟、是否越界、是否变形、是否白屏 → 录屏回传。
- 判定标准：跟手无明显滞后（主观 + 录屏帧数）、1x–3x 连续、边界不露黑边、复位无残留。

## 3. 验收项 3：云开发可用性（云函数 / 云存储 / 云数据库 / 定时触发器）

### 3.1 结论：**阻塞**（环境未开通，无 envId，无法部署与调用）

已完成的**离线替代验证**（不冒充云开发实测）：
- 临时云函数 `cloudfunctions/spike-vendor`（已按第 8 项删除，副本见 `docs/dev/spike-verify/fixtures/vendor-mock/`）实现统一响应包裹 `{ok,data,error{code,name,message,hint,httpStatus},requestId,serverTime}`，错误码映射 1001/1404；
- `main({action:'selftest'})` 本地跑通完整生命周期：health → validate → submit → query → success → erase → query=404，耗时 **107ms**（Mock 加速时延）；
- 验证：`cloud-handler（云函数统一响应包裹 / 错误码 / selftest 生命周期）(8/8)`。

### 3.2 解锁后 30 分钟内可跑清单（交给 Lead/用户执行）

1. 开通云开发并给出 envId（`SINN_CLOUD_ENV`），确认免费额度与计费主体。
2. 部署 `cloudfunctions/spike-vendor`（依赖 `wx-server-sdk ~2.6.3`，`config.json` 含 timer 触发器 `0 */5 * * * * *`）。
3. 调用 `selftest`，记录：冷启动耗时、云函数执行耗时、返回包裹的 `requestId/serverTime`。
4. 云存储：上传一张测试图，记录上传耗时与返回 fileID；再下载，记录耗时。
5. 云数据库：建集合 → 写入 → 查询 → 物理删除 → 再查（应无记录），确认无墓碑。
6. 定时触发器：确认 `spikeHeartbeat` 是否按时触发并写日志；确认未触发时的默认行为。
7. 记录免费额度（调用次数/GB·s/存储/数据库读写）与超限后的表现，回填 SPEC §D/CP-04。

> 注意：以上 7 步执行完之前，第 3 项在发布锚点（REPORT）里只能记为「阻塞」，不能记「通过」。

## 4. 验收项 4：试穿供应商对比（≥3 家）

### 4.1 对比表（文档级，2026-11-09；未知项明确标「待确认」）

| 维度 | Perfect Corp（AI Fabric） | 腾讯云 MPS AI 换装 | 火山引擎 图片换装 V2 | 阿里云百炼 AI 试衣 | 美图（候选补充） |
|---|---|---|---|---|---|
| 产品/接口 | `AI Fabric Virtual Try-On`；`POST /s2s/v2.0/task/fabric`（`template_id` + `src_file_id`），`GET /task/fabric/{task_id}` 轮询 | MPS `ProcessImage`（Product=mps, Version=2019-06-12）；`ImageTask.AiTryOnConfig` | 「图片换装 V2 接口文档」（智能视觉服务） | 「AI 试衣 / 图片精修」相关文档 | `meitu-cli`（meitu ai capability CLI） |
| 输入要求 | 单人、腹部/脸/肩可见、脸无遮挡、直立正面、不坐不蹲、<10MB、jpg/jpeg、长边 ≤4096 | 参考模特图 1 张（URL/COS）；`AddOnParameter.ImageSet` 参考图最多 13 张，Type=garment/background/identity/pose/accessories/shoes | 待确认（文档正文除导航外未取到，需登录试用） | 待确认（文档 302 到模型市场页） | 待确认 |
| 品类 | **布料/图案试穿（template=fabric 模板）**，与「用户上传整件服装图」语义有缺口 | 支持普通衣物 + 内衣；自研模型，强调服装纹理还原 | 待确认 | 待确认（AI 试衣/图片精修方向） | 待确认 |
| 输出分辨率 | 待确认（文档未给固定分辨率） | `Resolution` 枚举 **1K/2K/4K** | 待确认 | 待确认 | 待确认 |
| 耗时 | 异步任务；SLA 待确认 | 待确认（按量计费，异步任务） | 待确认 | 待确认 | 待确认 |
| 并发 | 待确认 | 待确认 | 待确认 | 待确认 | 待确认 |
| 免费试用额度 | 待确认（需销售/试用账号） | 待确认（需开通 MPS + 服务角色授权） | 待确认 | 待确认 | 待确认 |
| 正式报价 | 2 Units/次（AI Fabric V1.0），**单价未公开** | 按量计费，AI 换装单价页未取到 | 待确认 | 待确认 | 待确认 |
| 境内可访问性 | 服务端 `yce-api-01.makeupar.com`，任务结果链接走 AWS S3 accelerate → **涉境外与数据出境评估** | **境内**（腾讯云） | **境内**（火山引擎） | **境内**（阿里云） | **境内** |
| 资质 | 台湾 Perfect Corp（讯连科技） | 腾讯云 | 字节跳动/火山引擎 | 阿里云 | 美图 |
| 数据留存/出境 | 文档未明确留存期；结果链接 `ttl30`（约 30 分钟）需确认；跨境处理需法务评估 | 境内，默认留存策略待确认 | 境内，待确认 | 境内，待确认 | 待确认 |
| 文档 URL | https://docs.perfectcorp.com/reference/ai_fabric.md | https://cloud.tencent.com/document/product/862/132594 | https://docs.volcengine.com/docs/intelligent-vision-services/image-change-v2-interface-documentation?lang=zh | https://help.aliyun.com/zh/model-studio/aitryon-refiner.md | https://github.com/meitu/meitu-cli |

### 4.2 建议（**需 CP-04 采购决策，未经 SE/Lead 确认不得改 SPEC 枚举**）

- **首选（建议试用验证）：腾讯云 MPS AI 换装。** 理由：境内数据处理、分辨率档位明确（1K/2K/4K，可覆盖 2048 优先/1536 降级策略）、模型分级（lite/flash/pro）、参考图集语义比 Perfect Corp 的「布料模板」更贴近「用户上传服装图换装」；与 SPEC 的异步 task_id + 轮询契约天然匹配。风险：耗时/并发/单价/预检均待实测。
- **备选一：Perfect Corp。** 文档最完整、生态成熟，但 AI Fabric 是「布料/图案」试穿而非整件服装换装，存在**语义错配**；且服务在境外、任务链接 AWS，须过数据出境与采购评估。若采用，需先确认是否有 garment-level try-on 产品线。
- **备选二：火山引擎图片换装 V2 / 阿里云百炼 AI 试衣。** 均确认产品存在，但本次未取到接口正文（页面导航过重/重定向），字段、报价、免费额度全部待确认，需申请试用后再比较。
- **补充：美图（meitu-cli）。** 仅确认有 AI 能力 CLI，接口/报价待确认，作为最后补充。
- **对 D-2 的回填建议**：`VendorAdapter` 契约以本次实现的 6 方法（health/validate/submit/query/cancel/erase）+ 三态 validate 为基线；供应商枚举建议追加 `tencentmps`（若采纳首选），`perfectcorp` 保留但需注明布料模板适配缺口；`volcengine`/`aliyun` 待试用后定。**SPEC D-2 枚举的修改属 SE 职责，DEV 只给建议。**

## 5. 验收项 5：60s 内可达分辨率实测（2048px / 1536px 各 3 次）

### 5.1 结论：**阻塞（0 次真实调用）**

无供应商 API 账号，无法发起真实生成；按验收要求不得用 Mock 冒充实测。已提供：
- **SPEC 口径的模拟阶段分解**（Mock，明确标 `simulated: true`，非真实供应商数据）：

| 阶段 | 预算 | 2048 模拟值 | 1536 模拟值 |
|---|---|---|---|
| 上传 | ≤8s | 1200ms | 1200ms |
| 预检 | ≤5s | 120ms | 120ms |
| 提交供应商 | ≤10s | 150ms | 150ms |
| 生成 | ≤40s | 14000ms | 9000ms |
| 转存与下载 | ≤5s | 400ms | 400ms |
| **合计** | **≤60s** | **15870ms** | **10870ms** |

- 证据：`run-vendor-mock` 分组「60s 预算：2048/1536 模拟阶段分解均在预算内 :: {"preferred":15870,"degraded":10870}」（断言逐阶段 ≤ 预算、总时长 ≤60s），以及 2048/1536 各 3 次 submit→query→success→erase 生命周期（Mock 加速，wallMs 61/62/61ms、47/46/47ms，**不代表真实耗时**）。

### 5.2 解锁条件与 CP-07 建议

- 解锁：任一供应商试用账号 + 真实图片（≥2048px 目标图），按 `docs/dev/spike-verify` 契约实现真实 adapter，2048 与 1536 各跑 3 次，记录上传/预检/提交/生成/转存下载五阶段墙钟时间与失败率。
- **CP-07（1536 降级复核）当前不能闭合**。建议口径：若真实 2048 总时长超过 60s 或预算单项超限，则降级 1536 并在结果页展示「已降级，请人工复核清晰度」；若 1536 仍超时，回 SPEC/REQ 重新评估 60s 红线（不得由 DEV 私自放宽）。

## 6. 验收项 6：预检能力结论

### 6.1 供应商 validate：**不通过（未公开预检接口）**

- Perfect Corp AI Fabric 文档只有生成接口与输入约束，**没有独立的 validate/预检端点**；生成失败时返回错误（如 `error_apply_region_not_detected`），属于「事后失败」而非预检。
- 腾讯云 MPS AI 换装文档未提供预检字段；火山引擎/阿里云文档正文未取到，未知。
- 结论：**不能依赖供应商 validate 做点按前的预检**；验收项要求的 10 个维度当前一律视为 `unknown`（Mock 三态已建模，见 6.3）。

### 6.2 替代方案（建议实现顺序）

1. **端上基础校验（已具备）**：`miniprogram/utils/image-prep.js` 判尺寸/格式/大小/EXIF，明确「无法判断内容语义」（13/13 通过）。
2. **服务端视觉大模型逐项判定（待选型）**：如阿里云 qwen-vl、腾讯云图像分析等，把照片 + 服装图送入模型，输出结构化 JSON（单人/全身含脚/面部遮挡/身体遮挡/多人/逆光/吊牌/多件/模特上身/电商图），超时 8s 硬截断（SPEC 预检硬超时）；需实测准确率、耗时、成本。
3. **供应商失败码兜底**：真实 adapter 把 `error_apply_region_not_detected` 等映射为 `E_PHOTO_INVALID`（422）+ 可执行提示（如「请上传全身、脸部无遮挡的正立照片」）。
4. **Mock 三态契约**：`validate` 返回 `checks[{code,status:pass|fail|unknown,hint}]` + 聚合 `{ok,failed,unknown}`；`unknown` 必须显式返回，不能被当成 pass。

### 6.3 维度判断矩阵（当前状态）

| 维度 | 端上 | 供应商文档 | 当前结论 |
|---|---|---|---|
| 单人 / 多人 | 不能 | 输入约束「单人」但无预检端点 | unknown（待真实 validate 或视觉模型） |
| 全身含脚 | 不能 | 同上 | unknown |
| 面部可见 / 无遮挡 | 不能 | 同上 | unknown |
| 身体遮挡 | 不能 | 同上 | unknown |
| 逆光 | 不能 | 未提及 | unknown |
| 吊牌/水印 | 不能 | 未提及 | unknown |
| 多件服装 / 模特上身 | 不能 | 未提及 | unknown |
| 电商图白底 | 不能 | 未提及 | unknown |

> 任何一项在真实账号实测前不得写「通过」；这些维度直接对应 SPEC §B 的预检与 CP-11 人工视觉。

## 7. 验收项 7：端上图片预处理（Skyline）

### 7.1 结论：**纯函数通过 13/13；canvas 实渲染阻塞**

纯函数（`miniprogram/utils/image-prep.js`，Node 可跑，不依赖 wx）已验证：
- EXIF 8 种 orientation → rotate/flip 映射；`left → 顺时针 90°`、`right → 顺时针 270°`；
- 长边 ≤4096 等比缩放（8000x6000 → 4096x3072）；`orientedSize` 旋转后交换宽高；
- JPG/PNG/heic 判定、10MB 上限、`planPhotoProcessing` 四类问题（exif_orientation / oversized_pixels / not_jpeg / oversized_bytes）与步骤顺序（EXIF → resize → 转 JPG → 压缩）；
- `validateForUpload`：过小/缺尺寸拒绝；12MB JPG 可上传但强制压缩。

### 7.2 未验证部分（阻塞）

- `wx.createOffscreenCanvas({type:'2d'})` + `canvasToTempFilePath`（fileType jpg / quality 90 / rotate/flip 绘制）在 **Skyline 渲染器**下的实际行为：无开发者工具 CLI 授权、无真机，未跑过。
- 待真机验证：离屏 canvas 2d 是否可用、`wx.canvasToTempFilePath` 对离屏 canvas 的支持、4096px 画布内存峰值、EXIF 实际方向（不同 Android 厂商）、处理耗时。
- 解锁条件：沙箱外开发者工具或真机；步骤：进入临时页（或后续拍照页）→ 选图 → 记录 getImageInfo 的 orientation/宽高 → 执行 `renderNormalized` → 比对输出图方向/尺寸/字节 → 上传链路冒烟。

## 8. 验收项 8：临时物清理与还原（完成）

### 8.1 清理动作与结果

| 动作 | 结果 |
|---|---|
| 移除临时页 `miniprogram/pages/spike-zoom/`（.js/.json/.wxml/.wxss + zoom-math.js） | 已删除；`miniprogram/pages/` 仅剩 `index/`、`logs/` |
| 移除临时云函数 `cloudfunctions/spike-vendor/`（index.js/package.json/config.json/lib） | 已删除；`cloudfunctions/` 为空（后续 DEV 任务按需新建正式云函数） |
| 还原 `miniprogram/app.json` 的 `pages` | 已从 `[index, logs, spike-zoom]` 还原为 `[pages/index/index, pages/logs/logs]` |
| 保留可复跑证据 | `docs/dev/spike-verify/`（脚本 + `last-run.json` + `fixtures/vendor-mock/` 只读副本）；产品候选工具 `miniprogram/utils/zoom-math.js`、`miniprogram/utils/image-prep.js`（非临时物，后续结果页/拍照页复用） |

清理后复跑 `node docs/dev/spike-verify/run-all.js`：**46/46 passed, 0 failed**（证明清理未破坏可复现性；fixtures 为云函数删除后的只读副本，不可部署）。

### 8.2 门禁原文（最终，本报告落盘后）

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-gates.ps1 -Root .
ok    TASKS-0001.json: 14 个任务，DAG 合法

结果: 6 个文档, 1 个任务清单, FAIL=0, WARN=0
EXIT=0

$ powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-wxapp.ps1 -Root .
ok   appid: wxbbdcd1c49ad1259a

结果: 2 个页面, 0 个分包, 主包 25.7KB / 合计 25.7KB, FAIL=0, WARN=0
EXIT=0
```

> 清理与还原后、本报告落盘前的基线为「5 个文档 / 主包 25.7KB，FAIL=0」；本报告落盘后门禁为「6 个文档 / 2 个页面 / 主包 25.7KB，FAIL=0」，两次均通过。
> 包体积变化：14.7KB → 25.7KB（+11.0KB，来自 `utils/zoom-math.js` 与 `utils/image-prep.js` 两个产品候选工具），占主包预算 120KB 的 21.4%，无需调整 §D 预算。

## 9. 对 SPEC 的回填建议（DEV 建议，SE 裁定）

1. **D-3（必须先改）**：删除「S1 `movable-area/movable-view` 优先」表述；改为「S2+（`scale`/`pan` 手势组件 + `worklet` + `applyAnimatedStyle`）为主实现，S2（手写 touch + transform）为兜底；两者都不可用时回 REQ，不得私自降级为点按放大」。真机确认前该决策保持 open（不视为已闭合）。
2. **D-2（建议）**：供应商枚举追加 `tencentmps`（若 CP-04 采纳首选）；`perfectcorp` 注明 AI Fabric 为布料/图案模板、与整件服装换装有语义缺口；`volcengine`/`aliyun` 待试用核实。`VendorAdapter` 契约以本次 6 方法 + 三态 validate 为基线。
3. **§D 包体积**：本次新增 11.0KB（工具代码），主包 25.7KB/120KB；后续 capture/result 页开始前建议在预算表登记每页预计增量（建议单页 ≤8KB），本次不需调整总预算。
4. **§E 基础库**：最低 3.0.0 可覆盖 `wx.cloud`(2.2.3+)、`wx.chooseMedia`(2.10.0+)、`wx.requirePrivacyAuthorize`(2.32.3+)；**worklet 需开发者工具勾选「将 JS 编译成 ES5」**，建议写入 SPEC/README 的环境要求；真机验证 worklet 前不要把 S2+ 写成「已验证」。
5. **§F 隐私**：本次临时页删除后无新增隐私 API 调用点；后续拍照页实现 `wx.chooseMedia` 前必须先过 `wx.requirePrivacyAuthorize`，并在 SPEC §F 登记（CP-05 仍 open）。
6. **人工卡点状态**：CP-04（采购/报价）仍阻塞；CP-05 仍 open；CP-07（1536 降级）仍阻塞于真实时延；CP-11（人工视觉）仍 open；CP-12（真机兼容）仍阻塞于设备。

## 10. 复跑与证据文件

```
node docs/dev/spike-verify/run-all.js
```

| 文件 | 内容 |
|---|---|
| `docs/dev/spike-verify/run-all.js` | 一键入口，结果写 `last-run.json` |
| `docs/dev/spike-verify/run-zoom-math.js` | S2 缩放数学 13 项 |
| `docs/dev/spike-verify/run-image-prep.js` | 图片预处理 13 项 |
| `docs/dev/spike-verify/run-vendor-mock.js` | 供应商契约/状态机/删除语义/60s 分解 12 项 |
| `docs/dev/spike-verify/run-cloud-handler.js` | 云函数包裹/selftest 8 项 |
| `docs/dev/spike-verify/last-run.json` | 最近一次 46/46 结构化结果 |
| `docs/dev/spike-verify/fixtures/vendor-mock/` | 临时云函数删除后的只读副本（不可部署） |

## 11. 遗留风险与给后续任务的提示

- **真机不可替代**：S1/S2+ 渲染、worklet 跟手、canvas 预处理、隐私弹窗都只能真机/授权工具验证；在 CP-12 闭合前，结果页实现只能以「逻辑实现 + 单测」交付，不得宣称兼容性通过。
- **供应商适配**：当前只有 Mock 契约；真实 adapter 需在拿到账号后按同一契约实现，重点验证「真实预检能力、真实时延、报价、数据留存/出境」。
- **D-2 枚举与 D-3 表述需 SE 更新 SPEC**；DEV 实现前以更新后的 SPEC 为准，避免自行改口径。
- **下一步 DEV 任务**：按 `TASKS-0001.json` 顺序继续（DEV-0001-02 应用骨架路由等）；`miniprogram/utils/zoom-math.js`、`image-prep.js` 可直接复用，但需在对应任务的单测里补覆盖。
