---
id: MATERIALS-0001
title: QA-0001 固定测试素材清单（MAT-01..MAT-09 素材固化与许可声明）
status: approved
owner: qa
upstream: [TC-0001]
created: 2026-11-11
updated: 2026-11-11
---

# MATERIALS-0001 固定测试素材清单（MAT-01..MAT-09）

> 本文件是 QA-0001-05/07 的交付物：登记 2026-11-11 固化的 4 张真实人物全身照、1 张真实衣服平铺照
> 与 4 张派生负例，明确来源、许可边界、像素/字节/SHA-256、用途与合成体型数据，供 L3 用例、
> 人工复核与 `TC-0001.md` §5 追溯使用。
>
> **边界声明**：
> 1. 体型/三围/身高数据为**测试用合成值**，与图片中真实人物无关，仅用于驱动参考尺码与表单校验。
> 2. 图片二进制**不入库**（`.gitignore` 已排除 `tests/fixtures/mat/*.jpg`）：Pexels License 允许免费使用，
>    但**不包含「作为素材再分发」授权**，因此仓库只保留本清单与生成脚本；克隆后需按 §3 重新获取。
> 3. 素材仅用于本项目 demo 测试，不得对外再分发、不得用于训练/商业素材库。
> 4. 派生负例由 `tests/fixtures/mat/make-negatives.py` 本地生成，同样不入库；不得用于真实供应商视觉验收。

## 1. 素材清单（MAT-01..MAT-09）

| 素材 | 文件（`tests/fixtures/mat/`） | 类型 | 像素 | 字节 | SHA-256 | 用途 |
|---|---|---|---|---|---|---|
| MAT-01 | `mat-01-woman-fullbody.jpg` | 正面合格人像 | 1600×2545 | 524,732 | `633CE17297F2CD442D6B01A38A7CEBA2E92EA771F67A413AD3E04C5E8D0516B6` | 单人全身含脚、正面、光线均匀；AC-1/7/12/13/14/15 的合格输入 |
| MAT-02 | `mat-02-man-fullbody.jpg` | 正面合格人像 | 1600×2400 | 287,988 | `5D0A78A234F7F7F8347C9B3BD4063ECC8FA9CEEE4A63FA6C2D868639818FB468` | 男性全身正面；AC-2 低分辨率派生源、多人物拼图源 |
| MAT-03 | `mat-03-woman-fullbody.jpg` | 正面合格人像 | 1600×2400 | 341,896 | `8A25D45EC0F800F03A89F313D2FAA214A8827D99178105A4BF3B8F1AEE55B1E3` | 街拍全身；MAT-07 模糊派生源 |
| MAT-04 | `mat-04-man-backside.jpg` | **负例参考（背面）** | 1600×2499 | 366,574 | `9F26FED8325B1C2F73CF9EE7EB02149072C8947BC17E2223860884E38E9B962E` | 全身但背面且黑白：L0 不拦截（内容判定不在 L0），真实视觉预检阶段应判不合格；当前 `SINN_VENDOR=mock` 预检恒 pass，仅作素材留存 |
| MAT-05 | `mat-05-face-only.jpg` | 派生负例（非全身） | 1040×1200 | 186,957 | `9CDA9E0AC3DA4E943B2645A29BCA3EB1A589A8304BF2FEE1289AC016CA6BAA51` | 从 MAT-01 裁头部特写；AC-2 非全身拦截 |
| MAT-06 | `mat-06-lowres.jpg` | 派生负例（低分辨率） | 267×400 | 23,213 | `711024C217ED3D9333D638374A3CDCA1140F46E1A1FB3075AF00AC7AB82BE617` | 从 MAT-02 缩到长边 400px（低于端上 L0 `MIN_LONG_SIDE=1024`）；L0 拦截 |
| MAT-07 | `mat-07-blur.jpg` | 派生负例（模糊） | 1600×2400 | 246,127 | `FB5065DFDAD5881D74DD11F088CEBCD99C8D95A986E672695BB7A0A3E2734AA5` | 从 MAT-03 高斯模糊（半径 8）；真实视觉预检阶段应判不合格 |
| MAT-08 | `mat-08-garment-flat.jpg` | **合格衣服平铺照** | 1600×2416 | 212,289 | `DED3E3C57EB354ABC3363652FF75381363FC62E02A87938E84550CA023F89596` | 单件米色上装平铺、纯色背景、无模特/无遮挡；L3-003/L3-004 等人像+衣服用例的衣服输入；AC-7/24 的「合格衣服」基线 |
| MAT-09 | `mat-09-two-persons.jpg` | 派生负例（多人） | 1554×1200 | 315,717 | `1884AE93B56C808421A11AE84E2237CB06B36F578E4BD0A5833496294CB4DCDC` | MAT-01 + MAT-02 并排拼合；AC-4 多人拦截（原计划编号 MAT-08，因衣服素材占用 MAT-08 顺延为 MAT-09） |

## 2. 来源、许可与合成体型数据

| 素材 | 来源页 | 直接下载 URL | 许可 | 合成体型（gender / 身高 / 体重 / 胸 / 腰 / 臀） |
|---|---|---|---|---|
| MAT-01 | https://www.pexels.com/photo/16454901/ | https://images.pexels.com/photos/16454901/pexels-photo-16454901.jpeg?auto=compress&cs=tinysrgb&w=1600 | Pexels License | female / 165cm / 52.0kg / 84 / 66 / 90 cm |
| MAT-02 | https://www.pexels.com/photo/13287851/ | https://images.pexels.com/photos/13287851/pexels-photo-13287851.jpeg?auto=compress&cs=tinysrgb&w=1600 | Pexels License | male / 178cm / 70.0kg / 96 / 80 / 96 cm |
| MAT-03 | https://www.pexels.com/photo/5762357/ | https://images.pexels.com/photos/5762357/pexels-photo-5762357.jpeg?auto=compress&cs=tinysrgb&w=1600 | Pexels License | female / 168cm / 55.0kg / 86 / 68 / 92 cm |
| MAT-04 | https://www.pexels.com/photo/37893267/ | https://images.pexels.com/photos/37893267/pexels-photo-37893267.jpeg?auto=compress&cs=tinysrgb&w=1600 | Pexels License | male / 172cm / 66.0kg / 92 / 78 / 94 cm |
| MAT-08 | https://www.pexels.com/photo/6046231/ | https://images.pexels.com/photos/6046231/pexels-photo-6046231.jpeg?auto=compress&cs=tinysrgb&w=1600 | Pexels License | —（衣服素材，无人像体型数据；测试数值由用例按 MAT-01 合成体型提供） |

- MAT-05..MAT-07、MAT-09 为 MAT-01..MAT-03 的本地产物，无独立外部来源；生成参数见 §3。
- MAT-08 为 Lead 于 2026-11-11 新增的真实衣服平铺照（Pexels 6046231），登记于
  `tests/fixtures/mat/MATERIALS-MANIFEST.json`（该文件由 Lead 维护，QA 不自改）。
- 许可说明：Pexels License（https://www.pexels.com/license/）允许免费使用与修改，无需署名；
  **不授予**将照片作为素材库/测试数据集再分发的权利。本项目仅本地测试使用，图片不提交仓库。
- 合成体型数据与图片无关（见页首边界声明），来源：Lead 按需求拟定的测试值，登记于
  `tests/fixtures/mat/MATERIALS-MANIFEST.json`。

## 3. 复现方式（克隆后重建素材）

```bash
# 1) 按 MATERIALS-MANIFEST.json 的 directUrl 下载 5 张原图：MAT-01..04 人像 + MAT-08 衣服平铺，
#    保存到 tests/fixtures/mat/ 并核对 §1 的像素/字节/SHA-256（不一致则不得用于判定）。
# 2) 生成 4 张派生负例（Python 3.13 + Pillow 12.2，已内置于工作区）：
python tests/fixtures/mat/make-negatives.py
# 输出应为：
#   mat-05-face-only.jpg   1040x1200  186957B
#   mat-06-lowres.jpg       267x400    23213B
#   mat-07-blur.jpg        1600x2400  246127B
#   mat-09-two-persons.jpg 1554x1200  315717B
```

- 派生规则：MAT-05 = MAT-01 头部区域裁切并缩放至 1040×1200；MAT-06 = MAT-02 长边缩至 400px；
  MAT-07 = MAT-03 高斯模糊 radius=8；MAT-09 = MAT-01 与 MAT-02 统一高度 1200 后并排拼合。
- `.gitignore` 规则：`tests/fixtures/mat/*.jpg|jpeg|png|webp`（图片二进制不入库）。
- 本文件与 `MATERIALS-MANIFEST.json`、`make-negatives.py` 入库，可追溯。

## 4. 已知限制与后续

1. **MAT 编号冲突已修复（QA-0001-07 / task-48，2026-11-11）**：MAT-08 改为真实衣服平铺素材、
   双人物负例顺延为 MAT-09；`tests/e2e/lib/cases.js` 的 `MAT` 常量已同步为
   `mat/mat-0{1..9}-*.jpg` 真实路径，L3-003 等 requires `fixtures:MAT-01`+`fixtures:MAT-08` 现可解析。
   MAT-10..MAT-15 仍无文件，依赖它们的用例继续按阻塞登记。
2. MAT-10..MAT-15（衣服负例 MAT-10..12、真实结果样张 MAT-13/14、AC-26 文本 fixture MAT-15）状态不变，
   见 `TC-0001.md` §5；衣服类负例真实素材仍缺。
3. `SINN_VENDOR=mock` 下服务端预检恒 pass，MAT-04/05/07 的「视觉不合格」判定需真实预检能力（CP-04）
   解锁后才可验收；当前仅完成素材固化与 L0 可拦截项（MAT-06）。
4. L3-003 复跑：映射已修复；额度由 Lead 于 2026-11-11 重置测试用户 `usedToday`（进行中），
   重置确认后执行 `--only=TC-0001-L3-003`，执行结果写 `E2E-LOG-0001.md` v0.6；本文件 v0.2 不包含执行结果。
5. L3-012 的负例子码语义（旧编号 MAT-02..12 对应 3002/3003/3004/3001/3006 等）与新编号不一致，
   该用例依赖 CP-04 仍阻塞；解锁后需按新编号重写用例再执行。

## 5. 变更记录

| 日期 | 版本 | 说明 | 作者 |
|---|---|---|---|
| 2026-11-11 | v0.1 | 首次固化 MAT-01..08：4 张 Pexels 真实全身照（含 1 张背面负例参考）+ 4 张派生负例；许可/合成数据/复现命令/已知限制入档。 | qa |
| 2026-11-11 | v0.2 | QA-0001-07（task-48）：MAT-08 改为 Lead 新增的真实衣服平铺照（Pexels 6046231，1600×2416，212,289B，SHA `DED3E3C5…F89596`）；双人物负例顺延为 MAT-09 并重命名 `mat-09-two-persons.jpg`（SHA 不变）；`make-negatives.py` 输出改为 mat-09；§3 下载清单改为 5 张原图；§4 说明编号冲突已修复、MAT-10..15/L3-012 限制与 L3-003 复跑安排。 | qa |
