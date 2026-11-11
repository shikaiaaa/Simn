// docs/dev/spike-verify/run-all.js
// SPIKE-0001 一键复跑脚本：node docs/dev/spike-verify/run-all.js
// 零依赖（只用 Node 内置模块 + 仓库内 SPIKE 代码），结果写 last-run.json 作为交付证据。
'use strict';

var fs = require('fs');
var path = require('path');
var harness = require('./lib/harness');

async function main() {
  harness.reset();
  require('./run-zoom-math').run();
  require('./run-image-prep').run();
  await require('./run-vendor-mock').run();
  await require('./run-cloud-handler').run();

  var summary = harness.summary();
  var report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    groups: summary.groups
  };
  var outFile = path.join(__dirname, 'last-run.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

  summary.groups.forEach(function (group) {
    console.log('\n## ' + group.name + '  (' + group.passed + '/' + group.total + ')');
    group.tests.forEach(function (item) {
      var suffix =
        item.detail === ''
          ? ''
          : ' :: ' + (typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail));
      console.log('  ' + (item.status === 'pass' ? 'PASS' : 'FAIL') + ' ' + item.name + suffix);
    });
  });
  console.log('\n== SPIKE verify: ' + summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed');
  console.log('报告已写入 ' + outFile);
  if (summary.failed !== 0) {
    process.exitCode = 1;
  }
}

main().catch(function (err) {
  console.error('SPIKE verify crashed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
