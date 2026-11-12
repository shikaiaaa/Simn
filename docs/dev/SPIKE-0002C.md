---
id: SPIKE-0002C
title: Tripo 高档参数与「2D 换装结果 → 3D」两段式可行性（SPIKE-0002C）
status: review
owner: dev
upstream: [SPEC-0002]
---

# SPIKE-0002C：Tripo 高档参数与两段式 2D→3D 可行性

> 结论：**C3（两段式「P1 2D 换装结果 → Tripo 3D」）可行（A）**——3D 模型里能清楚看到换上的白色针织短袖；
> 单图直接转 3D（C1/C2）**无法承载换装**（只复刻输入照片里的原衣着，本例仍是黑色皮羽绒服）。
> 默认档建议：Tripo-H3.1 + geometry standard + texture standard + pbr（30 积分 ≈ ¥2.10，约 98s，GLB ≈39.7MB < 45MB）。
> 本次共 3 次真实调用 160 积分 = **¥11.20**（C1 60 + C2 70 + C3 30），在用户批准的 ¥12 预算内。

## 0. 结论摘要

| 实验 | 输入 | 参数 | 结果 | 判定 |
|---|---|---|---|---|
| C1 | MAT-01 原图 | H3.1 + ultra + detailed(4K) + face_limit 1.5M + pbr | GLB **49,962,520B（47.6MB）> 45MB**；60 积分 ¥4.20；122.7s | 质量可用但**违反 D-3 存储上限**；且只复刻原图衣着 |
| C2 | MAT-01 原图 | H3.1 + ultra + extreme(8K) + face_limit 1.5M + pbr | GLB **56,291,960B（53.7MB）> 45MB**；70 积分 ¥4.90；188.0s | 同上，8K 只作用于 baseColor，体积更大 |
| C3 | **P1 真实 2D 换装结果**（白色针织短袖，1207×1920） | H3.1 + standard + standard + pbr | GLB **41,610,440B（39.7MB）< 45MB**；30 积分 ¥2.10；98.2s | **A：3D 中能看出新衣**，纹理/轮廓保留，细节偏软（接近 A/B） |

## 1. 目标与输入

- 目标：验证「把 P1 既有的真实 2D 换装结果再转成 3D 展示」是否可行；并对比 Tripo 高档参数（ultra/detailed/extreme）在质量、耗时、体积、成本上的差异。
- 相机/渲染口径：临时页 `pages/spike-3d`（页面级 `renderer: webview`）+ 组件 `components/spike-xr`（`renderer: xr-frame`）加载 GLB；临时页/组件已删除、`app.json` 已还原（见 §7）。
- 输入：
  - MAT-01：`tests/fixtures/mat/mat-01-woman-fullbody.jpg`（1600×2545，524,732B，SHA256 `633ce17297f2cd442d6b01a38a7ceba2e92ea771f67a413ad3e04c5e8d0516b6`）。
  - C3 输入：`evidence/2026-11-11/real-runs/20261111-233212/t_92c75debd3c1b23cf6da2213.png`（P1 真实火山换装结果，白色针织短袖；1207×1920，2,288,244B，SHA256 `8F74FF8456D380550E59550B72CC58A34B7086C37CAB3FD7C251168AA68B8BDE`；原 taskId `t_92c75debd3c1b23cf6da2213`，vendorTaskId `2689642730335269708`）。
  - 两张输入均通过云存储临时 URL 传给 Tripo（上传对象在实验后已删除；URL 均为签名短时链接）。

## 2. 调用明细

| 项 | C1 | C2 | C3 |
|---|---|---|---|
| task_id | `f69d7b90-e3a1-49f9-9965-3e0616451174` | `9da4aa44-6354-480f-bf4d-9f61c4002707` | `87bf2c71-1606-48dc-b32d-e22935b825dd` |
| model | Tripo/Tripo-H3.1 | Tripo/Tripo-H3.1 | Tripo/Tripo-H3.1 |
| 参数 | ultra + detailed + face_limit 1500000 + pbr | ultra + extreme + face_limit 1500000 + pbr | standard + standard + pbr |
| 耗时 | 122,705ms | 188,025ms | 98,220ms |
| credits_consumed | 60（geometry 20 + texture 20） | 70（geometry 20 + texture 30） | 30（texture 10） |
| 成本 | ¥4.20 | ¥4.90 | ¥2.10 |
| GLB bytes | 49,962,520B（47.6MB） | 56,291,960B（53.7MB） | 41,610,440B（39.7MB） |
| GLB SHA256 | `d27ed4af01f0ada851920eda3c1b62d56de95cb9eda5ddd579bb40800654bb08` | `fff95ff4a074b889211e1f9e35bb4e43c53b80e0947c0965b654f44e8c9a1b0d` | `3ddbb9430e67bdc54d59b5ee2c5d52944c56c7a4e120640d564c5caff12f3118` |
| 三角面 | 247,847 | 245,695 | 237,672 |
| 贴图 | 3×4096²，合计 8,775,595B | baseColor 8192² + 2×4096²，合计 15,476,348B | 3×2048²，合计 2,143,647B |
| 超 45MB | **是** | **是** | 否 |
| rendered 预览 | 512×512 PNG 106,527B | 512×512 PNG 123,967B | 512×512 PNG 93,254B |

注：`face_limit=1500000` 两次 ultra 实验实际三角面仍约 24.5–24.8 万，说明 face_limit 更像上限/保护而非目标面数；体积大头是顶点/索引二进制（C1 BIN 49.96MB vs 贴图 8.8MB），**仅调贴图档位不能把 GLB 拉回 45MB 内**。

## 3. 关键判断：两段式（2D 换装结果 → 3D）= A（可行）

- C3 的 3D 模型渲染里能**清楚看到白色针织短袖**（P1 2D 换装结果里的新上装），颜色/大轮廓保留，脸/发型/姿态与 2D 结果一致；下装沿用 P1 火山结果（该条真实结果里火山把牛仔长裤重绘为露腿+白袜运动鞋，3D 也如实保留）。
- 不足：standard 档纹理偏软，袖口/肩线接缝略糊，针织织物细节不清晰；因此判定 **A（可行）但接近 B**，不是「完美还原」。
- 反证：C1/C2（原图直接转 3D）只复刻原照片的黑色皮羽绒服——**单图转 3D 天然无法承载「换上另一件衣服」的信息**，与参数高低无关。这支持用户判断：3D 若不能体现换装就没有意义。
- 对 P2 的影响：建议 P2 主线改为「**P1 2D 换装（已有真实链路）→ Tripo 标准档 3D 展示**」；端上交互（xr-frame 旋转/缩放）已在 devtools 用同一条链路验证可行。

## 4. 质量参数对比与默认档建议

- C1（ultra+detailed 4K）与 C2（ultra+extreme 8K）在 512×512 供应商预览与 devtools 230×497 截图下肉眼差异很小：8K 只提升 baseColor 一张图（8192²，9.83MB），ORM/normal 仍是 4096²；三角面数甚至略低于 C1（247,847 vs 245,695），几何细节提升有限。
- 体积/成本却显著上升：C1 47.6MB/¥4.20、C2 53.7MB/¥4.90，均**超过 SPEC D-3 单模型 45MB 上限**；C3 39.7MB/¥2.10 落在上限内。
- **默认档建议（demo）**：`Tripo/Tripo-H3.1` + `geometry_quality=standard` + `texture_quality=standard` + `pbr=true`（30 积分，约 ¥2.10/次，98s 量级，39.7MB）。
- 若 SE 希望更清晰：按本次数据，优先方向应是**降顶点/索引体积**（smart_low_poly、面数控制、Draco/geometry 压缩）而不是把贴图升到 8K；`texture_quality=detailed` 在几何 ultra 下仍会 47.6MB，需要先把几何体积压下来再评估。该组合未花预算实测（CP，见 §6）。

## 5. AC-25 三项口径补充（两段式口径）

- 对两段式，建议口径为「**P1 2D 换装结果 vs 3D 渲染预览**」（衡量 3D 对换装结果的保真），另附「原图 vs 3D 渲染」用于看脸像不像：
  - C3 2D 结果 vs C3 渲染（`c3-rendered.png`）：肤色 ΔE76 均值 **5.28**（建议阈值 ≤8）、发型 IoU **0.742**（建议阈值 ≥0.55）——均在建议阈值内。
  - MAT-01 原图 vs C3 渲染：ΔE **16.06**（受 2D 换装后的光照/肤色渲染影响）、IoU 0.739。
  - C1 原图 vs 渲染：ΔE 2.47、IoU 0.9308；C2：ΔE 7.804、IoU 0.9219。
- 五官关键点归一化位移**仍未计算**（无关键点模型；待 SPIKE-0002B，task-77）。脚本与阈值建议沿用 `docs/dev/spike-0002/scripts/ac25-metrics.py`，证据落 `docs/dev/spike-0002c/evidence/ac25-*.json`。

## 6. 预算与合规

- 真实调用：C1 + C2 + C3 = **160 积分**，1 积分 ¥0.07 → **¥11.20 ≤ ¥12**（用户批准上限）；无失败重试、无额外参数探针。
- Key 只读自 `C:\Users\admin\.sinn-secrets\tripo.key`，日志与证据中不出现完整 key；证据 URL 的签名参数已脱敏。
- 未发 Decart 调用（task-79 无 key）；未调用任何其他付费 API。

## 7. 清理记录

- 删除临时页 `miniprogram/pages/spike-3d/**`、临时组件 `miniprogram/components/spike-xr/**`；`miniprogram/app.json` 还原为 7 页，`git diff -- miniprogram/app.json` 为空。
- 删除 `.devtools-home`（IDE 配置副本）与 `.tcb-home`（tcb 登录态副本，含 auth.json）——两者均不留在工作区。
- 删除云存储测试对象 `sinn/spike2c/mat-01-*.jpg` 与 `sinn/spike2c/c3-tryon-*.png`。
- 大 GLB 仅存 `%TEMP%\sinn-spike2c\`（不入库）；`docs/dev/spike-0002c/` 只保留脚本、小体积证据（渲染预览、devtools 截图、montage、AC-25/metrics JSON、纹理 512 预览）。
- 原始全分辨率纹理（C1 8.8MB / C2 15.5MB / C3 2.1MB）在算完 `texture-metrics.json` 后删除，仅保留预览与统计。

## 8. 局部阻塞与风险

1. **真机渲染/帧率/内存未测**（CP-02-06）：devtools 截图仅 230×497（模拟器窗口缩放；`wx.getWindowInfo` 渲染区 390×658 逻辑像素），达不到 task-78 期望的 ≥1024 宽；另本次 devtools 窗口处于后台/最小化状态，`fpsText=1`（SPIKE-0002 前台时同链路为 118–121），**帧率结论以 SPIKE-0002 为准**，本任务不据此判性能。供应商 512×512 渲染预览作为视觉对照补充。
2. **两段式对 P1 2D 质量的依赖**：本次输入是火山把长裤重绘成短裤的已知偏差结果，3D 如实复制；若产品要保下装需先在 P1/供应商侧解决。
3. **GLB 45MB**：C1/C2 超限；默认档 C3 39.7MB 余量仅 ~5.3MB，若输入更复杂可能逼近上限，需要落地时加体积兜底（超限 6003 已在服务端契约中）。
4. **成本**：两段式每张展示新增 ~¥2.10（不含 P1 2D），比独立 3D 只多 1 次生成；若按「每个用户多套衣服」会线性增长，需产品定预算。
5. **single-sample**：结论基于 1 张人像 + 1 套换装；未做多图/多品类批次。

## 9. 证据清单

- 调用证据：`evidence/submit-C1.json`、`task-C1.json`、`result-C1.json`（C2/C3 同名）。
- 渲染：`evidence/c1-rendered.png`、`c2-rendered.png`、`c3-rendered.png`（供应商 512×512）；`evidence/render-C1.png`、`render-C2.png`、`render-C3.png`、`render-*.json`（devtools xr-frame 实测，230×497）。
- 对比：`evidence/comparison-montage.jpg`（原图 / P1 2D 结果 / C3 3D / C3 xr-frame / C1 / C2）。
- 纹理：`evidence/texture-*.json`、`texture-summary.json`、`texture-metrics.json`、`textures-*/image-*-preview.jpg`。
- AC-25：`evidence/ac25-c3-vs-2d.json`、`ac25-c3-vs-mat01.json`、`ac25-c1-vs-mat01.json`、`ac25-c2-vs-mat01.json`。
- 脚本：`scripts/tripo-call.js`、`tripo-refresh-url.js`、`spike-c-render.js`、`glb-textures.js`、`texture-metrics.py`、`make-montage.js`。

## 10. 变更记录

- 2026-11-12：创建；C1/C2/C3 三次真实调用完成、渲染对比与 AC-25 补充、文档与清理落地。
