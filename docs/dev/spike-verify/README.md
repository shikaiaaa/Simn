# SPIKE-0001 验证脚本（DEV 临时物，随 SPIKE 结束保留在 docs/dev 作为证据）

一键复跑（在仓库根目录）：

```
node docs/dev/spike-verify/run-all.js
```

输出：每个分组的 `PASS/FAIL` 明细 + 末行汇总；完整结构化结果写入 `docs/dev/spike-verify/last-run.json`。

## 覆盖范围（可在本机无云环境、无真机、无 API 账号时验证）

| 分组 | 覆盖 |
|---|---|
| `run-zoom-math.js` | S2 缩放数学：1x–3x、focal 锚点、平移边界、等比 transform、复位、60 帧捏合模拟 |
| `run-image-prep.js` | EXIF 8 种方向映射、长边 4096 缩放、10MB/格式判定、处理计划与上传校验纯函数 |
| `run-vendor-mock.js` | VendorAdapter 契约（health/validate/submit/query/cancel/erase）、预检三态、状态机、物理删除 404、并发、60s 阶段分解 |
| `run-cloud-handler.js` | 云函数统一响应包裹、错误码映射（1001/1404）、selftest 完整生命周期、requestId/serverTime |

## 目录说明

- `run-*.js`：验证脚本（零依赖，`run-all.js` 一次跑完）。
- `fixtures/vendor-mock/`：SPIKE 结束时 `cloudfunctions/spike-vendor` 被删除后保留下来的**只读副本**
  （`index.js` + `lib/mock-vendor.js`），仅用于让本目录脚本可复跑；不是可部署的云函数。
- 被保留的产品候选工具（非临时物）：
  - `miniprogram/utils/zoom-math.js`：S2 缩放数学（结果页将复用）；
  - `miniprogram/utils/image-prep.js`：端上图片预处理纯函数 + wx 适配（拍照页将复用）。

## 一眼结论（详细证据见 `docs/dev/SPIKE-0001.md`）

- 本机可自动验证的 46 项断言全部 PASS（2026-11-09）。
- 不能在无设备/无 envId/无 API 账号条件下验证的项已在报告中逐条标「阻塞 + 解锁条件」，未虚报。

## 明确不能在本机验证（报告中按「阻塞 + 解锁条件」记录）

- 微信开发者工具 automator：CLI 写 `.cli` 被沙箱拒绝（EPERM），此前 CLI 报
  `Please ensure that the IDE has been properly installed`。
- 真机 iOS/Android：无设备连接，双指手势跟手延迟、Skyline worklet 动画、canvas 端上预处理均未实测。
- 云开发：无 envId，`cloudfunctions/spike-vendor` 未部署（云函数/云存储/云数据库/定时触发器均未实测）。
- 供应商 API：无试用账号，未调用真实 validate/submit/query，真实耗时/分辨率/报价未核实。

解锁后复跑方式：拿到 envId 后部署 `cloudfunctions/spike-vendor` 并调用 `action=selftest`；
拿到开发者工具授权/设备后按 `docs/dev/SPIKE-0001.md` 第 2/7 项的人工步骤执行。
