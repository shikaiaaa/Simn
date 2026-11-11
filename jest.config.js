/**
 * 根 jest 配置（由 Lead 维护，见 AGENTS.md 角色写范围表）。
 * - 单测/组件测试：tests/unit/**（DEV 编写，miniprogram-simulate）
 * - e2e：tests/e2e/**（QA 编写，miniprogram-automator，属环境依赖，缺开发者工具时标阻塞）
 * - wx.* 统一走 tests/mocks/wx.js（AGENTS.md 小程序专项门禁 §4）
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  setupFiles: ['<rootDir>/tests/mocks/wx.js'],
  // tests/e2e/results/** 是 QA 生成的证据目录（含下载的云函数 package.json），
  // 会让 jest-haste-map 报 package.json 命名冲突；它不是被测代码，直接忽略。
  modulePathIgnorePatterns: ['<rootDir>/miniprogram_npm/', '<rootDir>/tests/e2e/results/'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/'],
  clearMocks: false,
  restoreMocks: false
};
