---
id: TEST-STRATEGY
title: 小程序测试策略
status: approved
owner: qa
upstream: []
created: 2026-11-09
---

# 小程序测试策略（QA 在 TC 之前先定这层）

小程序没有浏览器运行时，测试必须分三层做，**混在一起谈"覆盖率"是自欺**。

## 三层与工具

| 层 | 测什么 | 工具 | 谁写 | 能否进 CI |
|---|---|---|---|---|
| L1 单元 | 纯逻辑：格式化、计算、校验、状态机 | jest + `miniprogram-simulate`，`wx.*` 走 `tests/mocks/wx.js` | DEV（随任务交付） | 能 |
| L2 组件/页面 | 组件渲染、事件、`setData` 后的视图、页面生命周期 | `miniprogram-simulate` 渲染组件；页面级逻辑抽成可测函数再测 | DEV | 能 |
| L3 端到端 | 真机/模拟器上的完整链路：跳转、授权、请求、返回 | `miniprogram-automator` + 开发者工具 CLI | QA | 需开发者工具，通常只能本机/专用机 |
| L4 人工 | 授权弹窗、支付、分享卡片、真机兼容、审核 | 无（按检查单） | QA + 产品 | 不能 |

## 硬约定

- `wx.*` 一律走统一 mock 层，禁止在业务代码里散落 `jest.mock('wx')`。mock 层要有：请求成功/失败/超时、`showToast` 记录、`navigateTo` 路由记录、`getStorage` 内存实现。
- L3 前置条件写进 README：开发者工具安装路径、`--auto-port` 端口、测试号 AppID、是否开启「不校验合法域名」。**机器缺工具时，L3 用例状态只能标「阻塞」，不得标「通过」。**
- 每个页面至少一条 L2 用例；每条 AC 映射到 L1/L2/L3 之一，映射表与 TC 的双向追溯表合并维护。
- L4 的每一项都必须在 `RELEASE-CHECKLIST.md` 有对应勾选行，否则视为漏测。

## TC 编号建议

`TC-{需求号}-{层}{序号}`，例如 `TC-0001-L1-003` / `TC-0001-L3-002` / `TC-0001-L4-001`。
这样报告里能直接统计"L3 通过率"，也方便一眼看出某个需求是不是只有 L1 用例在撑。

## 常见坑（写进 TC 时优先覆盖）

1. 分包页面未注册 / 注册了不存在 → 白屏，编译期不报错。由 `tools/check-wxapp.ps1` 兜底。
2. `switchTab` 用成 `navigateTo`（tabBar 页面跳不过去）。
3. 授权拒绝后再进页面：`getUserProfile`/`getPhoneNumber` 失败态没处理，页面卡在 loading。
4. 分享/扫码进入的落地页没做「无上一页」处理，返回键直接退出小程序。
5. 弱网与超时：请求无超时、无重试、无骨架屏，用户看到空白。
6. `setData` 传超大对象（>1MB）导致卡顿；列表长数据未分页。
7. 基础库低版本上 API 不存在，未用 `wx.canIUse` 降级。
