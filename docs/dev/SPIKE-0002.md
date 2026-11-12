---
id: SPIKE-0002
title: 轻量 3D 人像形象生成技术预研（SPIKE-0002）
status: review
owner: dev
upstream: [SPEC-0002]
---

# SPIKE-0002 轻量 3D 人像形象生成技术预研

- 任务：TASKS-0002 / DEV-0002-01（SPIKE-0002）
- 上游：`docs/se/SPEC-0002.md` v0.3（approved）、`docs/sa/REQ-0002.md` v0.3（approved）、`docs/se/TASKS-0002.json`
- 执行角色：DEV；执行环境：本机 Windows + 微信开发者工具 2.02.0 + 项目 appid `wx735e60c2c07673aa` + 云环境 `simn-01-d5gjsxm0ocb78add8`
- 日期：2026-11-12
- 结论性质：**技术预研（review）**，不是验收通过；真机相关项一律标阻塞与解锁条件

## 0. 结论摘要

| 问题 | 结论 | 证据强度 |
|---|---|---|
| Q1 渲染：xr-frame 在 skyline + glass-easel 仓库是否可用？ | **可用（开发者工具）**：正确写法是「组件 `renderer:"xr-frame"`」，不是根标签 `<xr-frame>`；3D 查看页必须页面级 `renderer:"webview"`（app 级仍可 skyline），页面级 renderer 覆盖已实测生效。真机帧率/内存/手势未测 → CP-02-06 | 实测（截图 + console + fps） |
| Q2 阿里云百炼 Tripo 真实链路 | **已跑通**：2 次有效生成（各 30 积分、¥2.10/次，合计 ¥4.20，预算用尽）；单次生成 88.1s / 86.0s；返回 GLB 可解析、可被 xr-frame 加载渲染。**但默认参数 GLB 40.3–42.5MB，超 SPEC D-3 ≤20MB 上限约 2 倍** | 实测（任务记录 + 产物解析） |
| Q3 AC-25 指标 | 给出三项指标定义、脚本 `scripts/ac25-metrics.py`（Pillow+numpy）、单样本实测：肤色 ΔE 7.456、发型 IoU 0.9204；五官关键点因环境无关键点模型**未计算**；建议阈值表见 §5，需 SE 用多样本标定后回填 | 部分实测 + 方法/骨架 |
| Q4 包体积 | xr-frame 渲染器为基础库内置 **0KB 增量**；临时组件+页面约 11.2KB（正式实现应更小）；three.js 备选原始字节 754,519B（未打包、未实测）；GLB 样本 40.3/42.5MB；建议值见 §6 | 实测字节 + 估算 |
| D-1 需回 SE 更新 SPEC 的点 | ①3D 页需要页面级 `renderer:"webview"`（已实测）；②xr-frame 必须用组件模式；③默认 GLB 远超 20MB，需加降面参数或调整预算；④真机矩阵/同层 HUD 未闭合（CP-02-06） | — |

**成本与调用次数（如实记录）**：有效生成 2 次 × 30 积分 = 60 积分 = ¥4.20（1 积分 ¥0.07），达到用户批准上限 ≤¥4.2；另有 1 次缺参探针（0 积分、不产生产物）。**后续不得再发起真实生成**。

## 1. 范围与验收依据

- 四问（来自任务描述）：Q1 渲染可行性（A xr-frame / B three.js）；Q2 供应商真实链路与成本；Q3 AC-25 指标计算方法与阈值建议；Q4 包体积与资产样本给 SPEC §D 回填建议。
- SPIKE 判定标准见 SPEC-0002 §B.4.4（渲染 glTF/GLB + 页面级 renderer、≥30fps、内存、真机矩阵；供应商候选 A 与候选 B 对比；AC-25 标定；包体积实测）。
- 红线遵守：未改 P1 业务逻辑、未改 `docs/sa|se|qa`、根配置、`tests/mocks`；three.js 仅作体积估算未进正式包；真实调用次数与积分如实记录；AK 未打印/未落盘。

## 2. Q1 渲染可行性（xr-frame，开发者工具实测）

### 2.1 关键认知纠正（重要教训）

第一次尝试把 `<xr-frame>` 当根标签写在页面 WXML 中，结果：`webgl-ok`、`wx.getXrFrameSystem` 存在、但 scene 永不 ready、cube 场景也不 ready、页面全黑、无 xr 报错。改用**官方组件模式**后一次通过。

官方正确用法（来源：书栈网镜像的微信官方文档「XR-FRAME / 开始」；官方页为 JS 渲染无法静态抓取，以实测为准）：

1. 新建自定义组件，组件 json 写 `{ "component": true, "renderer": "xr-frame", "usingComponents": {} }`；
2. 组件 wxml 内只写 `<xr-scene>` 及 xr-* 元素（xr-camera/xr-light/xr-env/xr-assets/xr-asset-load/xr-gltf/xr-mesh…），**不要混写传统 view/text**；
3. 页面 json `usingComponents` 引用该组件 + `disableScroll: true`；页面 wxml 用 `<view>` 包住组件，传 `width`/`height`/`renderWidth`/`renderHeight`（页面脚本用 windowWidth/Height/pixelRatio 计算）；
4. 同一时刻全局只能存在一个 xr-frame 组件；一个组件只能有一个顶层 xr-scene；组件与页面通过 `triggerEvent` 通信实现 HUD（同层方案）。

### 2.2 实测结论

| 项 | 结果 | 证据 |
|---|---|---|
| 组件初始化 | `sceneText=SCENE-READY`、`assetsText=ASSETS-LOADED`，console `[xr-frame] scene ready` | `evidence/render-xr-1794445874793.json/.png`、`render-summary.json` |
| GLB 加载 | 远程 Tripo pbr GLB（40.3MB）由 xr-frame 内部加载器成功加载；`gltf-loaded` 事件触发 | 同上 |
| 视觉 | 截图可见人像 3D 模型（黑色羽绒服/牛仔裤/运动鞋，即 MAT-01 的生成结果），非黑屏 | `evidence/render-success-xrframe-devtools.png` |
| 帧率 | `bind:tick` 每秒统计约 118–121（开发者工具 vsync ~120Hz）；**不代表真机** | render JSON |
| 页面级 renderer 覆盖 | app 级 `renderer:"skyline"` + 页面 json `renderer:"webview"`：用 `wx.pageScrollTo` 位移标记实测 delta=600px（webview 下 pageScrollTo 生效，skyline 下无效）→ **覆盖生效** | `evidence/renderer-probe-1794445349309.json/.png` |
| 3D 页不声明 webview 时 | 开发者工具报错：`[Component] <canvas>: 开发者工具暂未支持 Skyline 下的 canvas 组件调试，请先到真机上预览调试`，scene 不 ready | `evidence/render-xr-1794445955997.json`、`render-xr-skyline.json` |

### 2.3 限制与待真机项（CP-02-06）

- 开发者工具**不支持同层渲染**：页面 DOM HUD 与 xr-frame 原生层叠层无法在工具验证（截图里 HUD 不显示，只有 3D 画面），需真机。
- 真机帧率（iOS/Android）、内存峰值（40MB+ GLB 是否 OOM）、`camera-orbit-control` 手势旋转、iOS≥8.0.29 / Android≥8.0.30 / 基础库≥2.27.1 兼容性：**全部未验证**，解锁条件=真机矩阵（CP-02-06）。
- 域名白名单：开发者工具中 `wx.request` 直连 Tripo CDN 报 `url not in domain list`，但 xr-frame 内部加载器仍成功下载远程 GLB（工具行为，真机可能不同）。**正式实现应从自家云存储（`sinn/model3d/...` 的临时 URL）加载**，这符合 SPEC B.5 的转存要求，可规避该问题。
- 开发者工具版本 2.02.0；官方建议最新 Nightly，工具差异需在落地时复验。

### 2.4 备选方案 B（webview + three.js）

- 未实测：Q1-A 已通过，按 Lead 指示无需硬转 B。
- 体积估算（下载原始文件实测字节）：`three.min.js` 648,280B + `GLTFLoader.js` 106,239B = 754,519B（未压缩/未打包；且 three r158+ 已移除 `three.min.js`，固定 0.157.0 版本需打包方案）。
- 结论：B 作为备选保留；若 A 真机失败（CP-02-06），B 需放入 `package-3d` 分包并按需加载，体积约 750KB 原始字节，真机需重新评估。

## 3. Q2 阿里云百炼 Tripo 真实链路

### 3.1 接口事实（官方文档 help.aliyun.com/zh/model-studio/tripo-3d-generation-api-reference，已与 SPEC 附录核对）

- 提交：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/3d-generation`；实测通用 host `https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/3d-generation` 同样可用（无需 WorkspaceId）。
- Header：`Authorization: Bearer <sk-...>`、`Content-Type: application/json`、`X-DashScope-Async: enable`。
- Body：`model: "Tripo/Tripo-H3.1"` 或 `"Tripo/Tripo-P1.0"`；`input.image`（单图公网 URL，JPEG/PNG，20–6000px，≤20MB）；`parameters`: `texture_quality`(standard/detailed/extreme)、`geometry_quality`(standard/ultra，仅 H3.1)、`pbr`、`texture`、`quad`、`face_limit`、`smart_low_poly` 等（详见 SPEC 附录 / task board）。
- 查询：`GET .../api/v1/tasks/{task_id}`；状态 PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN。
- 成功返回 `output.results[]`：`pbr_model_url`（GLB）、`base_model_url`、`model_url`、`rendered_image_url`（预览图）；`usage.credits_consumed` 等。
- 有效期：`task_id` 24h；产物 URL 2h 签名链接；查询 RPS 20；建议 10s 后每 15–30s 轮询。

### 3.2 真实调用记录（全部如实记录，无成功伪造）

| # | 类型 | task_id | 提交→完成 | 积分/成本 | 产物 | 备注 |
|---|---|---|---|---|---|---|
| 0 | 缺参探针（input 为空） | `b04a7dfe-2c33-4c92-b6fb-a51cd9890428` | 0.4s FAILED | 0 积分（无 usage） | 无 | `InvalidParameter: input must contain prompt, image, or images`；不计费、不计有效生成 |
| 1 | 真实生成（H3.1，MAT-01） | `9906ae33-4412-49f4-811a-cc6af2f911db` | 08:50:58.550 → 08:52:26.636，**88,086ms≈88.1s** | 30 积分 = **¥2.10** | GLB 42,316,656B（SHA256 `4c9f89e1…`）、预览 PNG 117,726B | 成功 |
| 2 | 真实生成（参数误复制，如实记录） | `9dd8836d-6520-4d2c-8e08-9d1fc0a4c51c` | 08:53:45.684 → 08:55:11.664，**85,980ms≈86.0s** | 30 积分 = **¥2.10** | GLB 44,541,908B（SHA256 `80c363e0…`）、预览 PNG 115,755B | 本意验证 `face_limit`，但脚本未透传该参数，实际与 #1 参数相同；产物略大（后端非确定性），如实标注 |

- 合计：有效生成 2 次，60 积分 = ¥4.20（上限用尽）。
- 云存储测试对象 `sinn/spike2/mat-01-*.jpg` 已于调用后删除（`cloudfn-deleteInput.json` 显示状态 0/ok）。
- 提交/查询/下载证据：`evidence/submit-*.json`、`task-result-*.json`、`task-summary-*.json`；渲染预览：`rendered-*.webp`、`rendered-preview.png`。

### 3.3 产物校验（GLB 结构解析）

| 指标 | 调用 #1 | 调用 #2 |
|---|---|---|
| 文件字节 | 42,316,656（40.35MiB） | 44,541,908（42.49MiB） |
| GLB 头 | magic `glTF`、version 2、JSON chunk 2,112B + BIN chunk 42,314,516B | 同类结构 |
| mesh / node / material | 1 / 1 / 1 | 1 / 1 / 1 |
| 顶点数（POSITION） | 714,860 | 752,462 |
| 索引数 / 三角面 | 4,184,640 / 1,394,880 | 4,407,774 / 1,469,258 |
| 贴图 | 3 张（Color jpg 688,662B + ORM jpg 490,676B + NormalGL png 1,521,093B，合计 2,700,431B） | 3 张，合计 2,829,876B |
| PBR 材质 | baseColorTexture + metallicRoughnessTexture + normalTexture，metallicFactor 1 / roughnessFactor 1 | 同 |
| 预览图 | 512×512 PNG（实际字节为 PNG，非 webp 扩展名） | 512×512 |

**关键发现**：GLB 体积的主要来源是几何数据（约 39.6MB）而非纹理（约 2.7MB），默认 H3.1 参数远超 SPEC-0002 D-3「单模型（含纹理）≤20MB」。可选缓解（本次预算耗尽未实测）：`parameters.face_limit`（H3.1 上限 1.5M 三角面）、`smart_low_poly`（+10 积分）、`Tripo-P1.0`（≤2 万面，快速档）、落地前 GLB Draco/meshopt 压缩（xr-frame 对 Draco 的支持需真机验证）。

### 3.4 候选 B（腾讯混元生3D）与选型口径

- 文档调研（未实测，无凭证）：`SubmitProfileTo3DJob`/`DescribeProfileTo3DJob`（+AutoRigging）；单张真人图 URL/base64，单边 500–4096、base64 ≤10MB、JPG/PNG；输出 OBJ/MTL/FBX/IMAGE（**未见 GLTF/GLB**，需转换）；控制台 100 免费积分（1 年）、积分包 1000 积分 = ¥100；**2027-01-19 预下线**。
- 阻塞：腾讯云账号/密钥/开通状态属 CP-02-01；本期未取得，无法实测对比。
- 选型口径：**不承诺供应商**；从文档与实测看，候选 A（阿里云百炼 Tripo）链路已跑通、原生输出 GLB、境内可访问，作为优先验证对象；候选 B 需 CP-02-01 解锁后按 §B.4.4 补测。
- 供应商状态映射建议：PENDING/SUBMITTED→QUEUED；RUNNING/BUILDING/TEXTURING→GENERATING；SUCCEEDED→SAVING→SUCCEEDED；FAILED/CANCELED→FAILED；UNKNOWN 不得当成功；供应商错误按 SPEC B.4 映射（鉴权/欠费/限流/网络→6001，超时→5002，参数类→3015，内容安全→4001，输入/人体→3001–3012）。

## 4. Q1 补充：页面级 renderer 覆盖与工程口径

- 实测：app 级 `renderer:"skyline"` 时，页面 json `renderer:"webview"` 生效（renderer-renderer probe delta=600px）。
- 开发者工具中 skyline 页面的 xr-frame/canvas 不可调试（报「暂未支持 Skyline 下的 canvas 组件调试」）；因此 3D 查看页在工具环境必须 webview。
- 建议 SPEC 记录：`package-3d/pages/model3d-view/index.json` 必须 `renderer:"webview"`；其余页面保持 skyline；`componentFramework` 保持 `glass-easel`（不要尝试 exparser：本次试验导致工具编译挂起，且 Skyline 本来要求 glass-easel）。
- 同层 HUD：官方说明工具暂不支持，真机才可验证；实现时按「组件 triggerEvent + 页面 DOM 叠层」设计，工具环境仅验证 3D 层。

## 5. Q3 AC-25 指标：定义、脚本、单样本实测与阈值建议

### 5.1 指标定义

1. **五官关键点归一化位移**：检测输入人像与 3D 渲染预览中的人脸关键点（68/468 点），以两眼中心距离（或人脸框宽度）归一化后，逐点计算位移的均值与 P95。
2. **肤色 ΔE**：分别取输入照片与 3D 预览的肤色像素（YCbCr 经验阈值），转换到 CIELAB（D65）后计算均值色差 ΔE76。
3. **发型轮廓 IoU**：在头部区域内分割发型（当前用亮度/颜色阈值近似），计算两图发型掩码的交并比。

### 5.2 脚本

- `docs/dev/spike-0002/scripts/ac25-metrics.py`（Python 3 + Pillow + numpy，已跑通）
- 用法：
  - `python ac25-metrics.py --input tests/fixtures/mat/mat-01-woman-fullbody.jpg --rendered docs/dev/spike-0002/evidence/rendered-9906ae33-....webp --out docs/dev/spike-0002/evidence/ac25-metrics.json`
- 说明：脚本中「五官关键点」项**未计算**（环境无 mediapipe/dlib/OpenCV），输出 `ok:false, reason:keypoint_model_unavailable` 并附实现方法；肤色 ΔE 与发型 IoU 可运行。

### 5.3 单样本实测（2026-11-12）

| 指标 | 结果 | 说明 |
|---|---|---|
| 肤色 ΔE（均值） | **7.456** | 输入肤色 RGB≈(155,120,98)，预览≈(175,139,113)；光照/白平衡差异存在，单样本 |
| 发型轮廓 IoU | **0.9204** | 输入深色区域占比大（深色墙面背景影响近似掩码），IoU 偏高，仅作方法验证 |
| 五官关键点归一化位移 | 未计算 | 缺关键点模型；不得作为验收结论 |

### 5.4 阈值建议（供 SE 用多样本标定后回填 SPEC）

| 指标 | 建议阈值 | 说明 |
|---|---|---|
| 五官关键点归一化位移 P95 | ≤0.08（以两眼距/人脸宽归一化） | 均值建议 ≤0.04；需 5 组以上样本标定 |
| 肤色 ΔE 均值 / 最大 | ≤8 / ≤12（CIE76） | 单样本已 7.456，接近阈值；真机+多样本再收紧或放宽 |
| 发型轮廓 IoU | ≥0.55（本方法近似掩码） | 需先统一取景/裁剪规则，否则真实值波动大 |
| 人工 5 级制 | ≥4 且不得明显换人/崩脸/恐怖谷 | 沿用 SPEC D-6 要求 |

**局限**：单样本；输入为照片、对比图为 512×512 供应商预览（非小程序渲染链路）；肤色/发型受背景与光照影响；关键点位移未计算。AC-25 在 SPIKE 阶段应保持「阻塞/待标定」，不得据此判通过。

## 6. Q4 包体积与资产（给 SPEC §D 回填建议）

### 6.1 实测数字

| 项 | 字节 | 说明 |
|---|---|---|
| xr-frame 渲染器 | **0KB** | 基础库内置组件，无 npm 依赖 |
| 临时验证组件 `spike-xr`（json/wxml/js/wxss） | 3,273 | 正式实现只保留必要逻辑，预计更小 |
| 临时页面 `spike-3d` 四件套 | 5,084 | 含 HUD/探针代码，正式页更精简 |
| 临时页面 `spike-renderer` 四件套 | 2,883 | 仅探针，正式无 |
| 临时云函数 `spike-model3d` | 2 文件/829B（收尾桩） | 部署时含测试图，已清理 |
| `three.min.js` + `GLTFLoader.js`（备选） | 648,280 + 106,239 = **754,519**（原始未压缩） | 未打包、未实测；r158+ 已移除 three.min.js |
| GLB 样本 #1 / #2 | 42,316,656 / 44,541,908 | 默认参数，超 D-3 20MB |
| 预览图样本 | 117,726 / 115,755 | 512×512 PNG（扩展名 webp 实为 PNG，需服务端按魔数识别） |

### 6.2 建议 SPEC §D 回填

- 主包：xr-frame 组件/渲染器 **+0KB**（内置）；正式实现新增代码预计 <15KB（以实测为准）。
- `package-3d` 分包：3 页 + 组件 + 3D HUD 逻辑，建议预算 ≤60KB（不含 three.js）。
- three.js 备选：原始 754,519B（约 737KB），压包后未知；若采用需单独分包按需加载，且需打包器；**未实测**。
- 资产：GLB 单模型 ≤20MB 在当前默认参数下**不可达**（默认约 40–42.5MB）；建议 SE 与供应商参数一起定稿：要么加 `face_limit`/`smart_low_poly` 后复验体积，要么把 D-3 上限调整为可接收值（并考虑客户端 LRU≤200MB 的缓存策略与 24h 有效期）。落地前服务端仍需按 SPEC B.5 校验（超限 6003）。

## 7. 未闭合卡点（CP）与解锁条件

| CP | 内容 | 解锁条件 |
|---|---|---|
| CP-02-01 | 候选 B 腾讯混元生3D 凭证/账号/开通状态未取得 | 用户提供腾讯云账号并开通混元生3D，DEV 按 §B.4.4 补 1–2 次真实调用（预算另批） |
| CP-02-06 | 真机渲染矩阵：iOS/Android 各 ≥1 台（微信 ≥8.0.30）、帧率 ≥30fps、内存不 OOM、手势旋转、同层 HUD | 用户提供真机 + 预览版；DEV 补真机取证 |
| AC-25 标定 | 五官关键点模型缺失；样本仅 1 组 | 接入 mediapipe/dlib（或提供可用的关键点服务），≥5 组样本重新计算并回填 SPEC |
| GLB 体积 | 默认 H3.1 产出 40–42.5MB > D-3 20MB | SE/产品决策：降面参数复验 或 调整 SPEC 上限；需预算重新批准才能复测 |
| 临时云函数删除 | 开发者工具 CLI 无 cloud function delete 命令，`spike-model3d` 已重部署为「1004 停用空壳」（829B），仍存在于云环境 | 用户在云开发控制台删除 `spike-model3d` |

## 8. 清理记录

| 项 | 状态 |
|---|---|
| `miniprogram/pages/spike-3d/` | 已删除 |
| `miniprogram/pages/spike-renderer/` | 已删除 |
| `miniprogram/components/spike-xr/` | 已删除 |
| `miniprogram/app.json` pages 临时项 | 已还原（git diff 为空） |
| `cloudfunctions/spike-model3d/` | 本地已删除；云端已换成停用空壳（待控制台删除） |
| `cloudfunctions/.deploy/` staging | 已删除 |
| `.devtools-home/`（假 USERPROFILE） | 已删除 |
| 云存储测试对象 `sinn/spike2/mat-01-*.jpg` | 已删除 |
| `docs/dev/spike-0002/{scripts,evidence,vendor}` | 保留（本 SPIKE 证据，约 1.26MB） |

## 9. 复现步骤（脚本说明）

| 脚本 | 作用 |
|---|---|
| `scripts/dashscope-probe.js` | 验证 DashScope 凭证/端点（GET tasks/0 + GET models），不打印密钥 |
| `scripts/dashscope-submit.js <imageUrl>` | 提交 3D 生成任务，写 `evidence/submit-*.json`（密钥脱敏）；**无 face_limit 参数透传**（本次 #2 误复制的根因） |
| `scripts/dashscope-task.js <task_id> --poll` | 轮询任务状态 |
| `scripts/dashscope-validate.js` | 缺参探针（0 计费） |
| `scripts/tripo-fetch-result.js <task_id>` | 下载/解析 GLB + 预览图，输出 task-result/task-summary JSON |
| `scripts/spike3d-cloudfn.js <action>` | 通过 automator 调临时云函数（uploadInput/deleteInput/info） |
| `scripts/spike-render-test.js <waitMs>` | 打开临时页、收集 console、截图、dump page data（渲染验证） |
| `scripts/spike-renderer-test.js` | renderer 覆盖探针（pageScrollTo delta） |
| `scripts/ac25-metrics.py` | AC-25 三项指标计算（关键点项未实现） |

注：automator 连接 `ws://127.0.0.1:9434`，由 `cli.bat auto --project ... --auto-port 9434 --trust-project` 启动（假 USERPROFILE 方案见 DEV-0001 §11）；相关进程本机未关闭，属开发环境，不影响仓库。

## 10. 风险与教训

1. **xr-frame 不是根标签**：首轮误用导致全黑且无报错，浪费一轮实测；正确做法是「组件 renderer」模式。已写入本 SPIKE，避免落地时重犯。
2. **exparser 不可用于 skyline 项目**：临时改 `componentFramework:"exparser"` 导致工具编译挂起/automator 超时，已回退；Skyline 必须 glass-easel。
3. **真实调用预算一次性用尽**：第二次调用因脚本未透传 `face_limit` 与首调参数相同（30 积分又消耗一次），属于流程事故；已如实记录。后续如需验证降面参数必须重新获预算批准。
4. **供应商默认产物体积风险**：如果直接按 D-3 ≤20MB 落地将无法入库；必须在 DEV-0002-04 之前由 SE 决策降面参数/上限。
5. **域名白名单**：工具内 xr-frame 可绕过 wx.request 校验加载远程 GLB，但真机行为未知；正式实现必须从自家云存储加载（SPEC B.5 已要求），并提前在公众平台配置合法域名（若直接加载供应商 URL）。
6. **预览图魔数**：阿里云返回的 `rendered_image_url` 文件扩展名 `.webp` 实际字节为 PNG，服务端转存/校验要按魔数判断，不能只看扩展名。

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 创建 SPIKE-0002（DEV-0002-01）：Q1-A devtools 渲染实测通过；Q2 Tripo 2 次真实调用成功（¥4.20）；Q3 AC-25 方法+单样本；Q4 包体积实测；清理临时产物；待 Lead 审核 |
