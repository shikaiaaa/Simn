---
id: SPIKE-0002D
title: Decart Lucy VTON 5s 视频换装样片与接入可行性预研（SPIKE-0002D）
status: draft
owner: dev
upstream: [SPEC-0002]
---

# SPIKE-0002D：Decart Lucy VTON 样片预研

## 0. 当前状态（2026-11-12）

**阻塞：等待用户放入 `C:\Users\admin\.sinn-secrets\decart.key`。**

已按 task-79 要求完成全部「不花钱」的准备工作：

- 输入素材（人物 5s 视频 + 衣服裁剪图）已生成并校验；
- 任务脚本 `decart-job.js`（dry-run 默认，`--run` 才提交）已就绪；
- 抽帧/九宫格/三图对比脚本 `extract-frames.py` 已就绪；
- **尚未调用 Decart API，未产生任何费用**。

Key 到位后的执行顺序：

1. `node docs/dev/spike-0002d/scripts/decart-job.js`（dry-run）→ 校验 key、查 `GET /v1/credits` 余额；
2. `node docs/dev/spike-0002d/scripts/decart-job.js --run` → **恰好 1 个**批量任务（5s ≈ $0.20，≤ $0.25 红线）；
3. `python docs/dev/spike-0002d/scripts/extract-frames.py` → 抽帧 + 九宫格 + 三图对比；
4. 按 §5 判定 A/B/C，回填 §6 并更新本文档状态；
5. 双门禁 + jest 全绿后 complete task-79 并交接。

## 1. 输入素材（本地、零成本）

| 素材 | 路径 | 规格 | 字节 | SHA256 |
|---|---|---|---|---|
| 人物视频 | `docs/dev/spike-0002d/inputs/mat-01-person-5s-720x1280.mp4` | 720×1280、9:16、30fps、5s、150 帧 | 1,621,319 | `7bdd4621c7bbfd1c720565082ab3acee7bc80267097fa88d58c28a8f680c8cb4` |
| 衣服图 | `docs/dev/spike-0002d/inputs/mat-08-garment-crop-1024.jpg` | 1024×1024、白底、JPEG | 116,709 | `e48ccc1ee18271a03b776a7125753e187c76a7cc6c1f455c2866f1b41c7a42e2` |

- 人物视频由 MAT-01（`tests/fixtures/mat/mat-01-woman-fullbody.jpg`，SHA256 `633ce17297f2cd442d6b01a38a7ceba2e92ea771f67a413ad3e04c5e8d0516b6`，1600×2545）裁 9:16 后生成，画面 1.00→1.03 极轻微推近，接近静止；
- 衣服图由 MAT-08（`tests/fixtures/mat/mat-08-garment-flat.jpg`，SHA256 `f9705e4f5b94a981b8111f85c610b89c6d5fbaf0dc67276d071aa0a0d62a7456`）裁纯衣服 + 白底 1024×1024 JPEG；
- 生成命令：`python docs/dev/spike-0002d/scripts/prepare-inputs.py`；结果写入 `inputs/manifest.json`。

### 1.1 编码限制（如实记录）

- 本机**没有 ffmpeg / imageio-ffmpeg / OpenH264 库**；OpenCV `cv2.VideoWriter` 尝试 `avc1`、`H264` 均无法打开（`Failed to load OpenH264 library`），最终使用 **`mp4v`（MPEG-4 Part 2）容器写入**。
- 回读校验：720×1280、30fps、150 帧可正常解码（`inputs/manifest.json` 有 `codec_attempts` / `codec_used` / `readback_frame_count`）。
- 若 Decart API 对编码有硬性要求（文档推荐 H.264）而拒绝 `mp4v`：需先安装 ffmpeg 或 OpenH264 后重新编码（**解锁条件**；不影响本轮「等 key」阻塞）。届时以真实错误原文记录，不重试烧钱。

## 2. 调用计划（key 到位后，恰好 1 次）

- 接口：`POST https://api.decart.ai/v1/jobs/lucy-vton-latest`（multipart）
  - `data`：人物视频 mp4；`prompt`：substitute 模式；`reference_image`：衣服图；`resolution=720p`。
  - 轮询 `GET /v1/jobs/{id}` → `completed`；下载 `GET /v1/jobs/{id}/content` 取 mp4。
  - 余额：调用前后各 `GET /v1/credits`。
- prompt（20–30 词，substitute）：
  `Substitute the current top with a cream oversized knit short-sleeve sweater, crew neck, ribbed hem`
- 成本：5s × $0.04 = **$0.20**（≤ $0.25 红线；1 credit=$0.01，$1=100 credits）。
- 失败不重试；任务 job_id/状态时间线/耗时/credits 前后余额/失败原文全部写入 `evidence/decart-job-<ts>.json`；key 只输出 `dct_***`。

## 3. 评估方法

- 抽帧：开头/中间/末帧 + 3×3 九宫格（`extract-frames.py`）；
- 三图对比：输入 MAT-01 / P1 火山 2D 换装结果（`evidence/2026-11-11/real-runs/20261111-233212/t_92c75debd3c1b23cf6da2213.png`，1207×1920）/ Decart 输出末帧；
- 观察项：脸像不像本人、衣服还原度（颜色/领口/袖长/纹理）、下装是否被重绘、有无形变/闪烁、720p 清晰度是否够用（对比 P1 2D 1207×1920）；
- 结论：**A** 明显优于火山 2D → 建议评估接入；**B** 相当 → 说明差异；**C** 不如/不可用 → 说明原因。

## 4. 接入可行性（不实现，仅记录）

- **实时路径**：Decart 实时换装依赖 WebRTC；微信小程序 Skyline/原生组件不支持 WebRTC，需要 H5 `web-view`（需业务域名与备案）或独立端（App/H5），接入成本高。
- **批量路径**：要求视频输入；照片需先合成视频（本机/服务端需 ffmpeg，云函数环境无 ffmpeg，需云托管/容器服务），且 5s 视频 ≈$0.20/次，用户等待与成本均高于 P1 单图 2D 换装。
- **费用测算**：5s ≈ $0.20（约 ¥1.4，汇率按 7）；30s 实时 ≈ $0.60（约 ¥4.2）；未计视频合成/转码成本。

## 5. 结论（待 key 到位后回填）

- 判定：待填（A/B/C）。
- 依据：待填（分项观察 + 帧/对比图路径）。

## 6. 证据清单（已完成部分）

- `docs/dev/spike-0002d/inputs/manifest.json`：输入素材元信息（字节/SHA256/编码尝试/回读帧数）；
- `docs/dev/spike-0002d/inputs/mat-01-person-5s-720x1280.mp4`：人物视频；
- `docs/dev/spike-0002d/inputs/mat-08-garment-crop-1024.jpg`：衣服图；
- `docs/dev/spike-0002d/inputs/person-video-frame-preview.png`：视频中间帧预览；
- `docs/dev/spike-0002d/scripts/prepare-inputs.py`、`decart-job.js`、`extract-frames.py`。

待 key 到位后新增：`evidence/decart-job-*.json`、`decart-output-*.mp4`（≤10MB 时入库）、`decart-frame-*.png`、`decart-contact-sheet.jpg`、`decart-comparison.jpg`、`decart-frames-meta.json`。

## 7. 阻塞与解锁条件

| 阻塞 | 解锁条件 |
|---|---|
| `decart.key` 不存在（当前唯一阻塞） | 用户把 Decart key 放到 `C:\Users\admin\.sinn-secrets\decart.key`（单行 `dct_…`） |
| 无 ffmpeg/OpenH264，视频编码为 mp4v 而非 H.264 | 安装 ffmpeg（或 OpenH264）后重新运行 `prepare-inputs.py`；若 API 接受 mp4v 则无需处理 |
| 实时接入需 WebRTC | 后续若选实时路线，需 H5/独立端方案评估（非本 SPIKE 范围） |

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初版：完成输入素材与脚本准备，如实记录 key 缺失阻塞与 mp4v 编码限制；未产生费用。 |
