// docs/dev/spike-verify/lib/harness.js
// SPIKE-0001 验证脚本的最小断言工具：零依赖，输出可复现的通过/失败明细。
'use strict';

var state = { groups: [] };

function group(name) {
  state.groups.push({ name: name, tests: [] });
}

function push(name, status, detail) {
  state.groups[state.groups.length - 1].tests.push({
    name: name,
    status: status,
    detail: detail === undefined ? '' : detail
  });
}

function test(name, fn) {
  try {
    var value = fn();
    push(name, 'pass', value);
  } catch (err) {
    push(name, 'fail', (err && err.message) || String(err));
  }
}

async function testAsync(name, fn) {
  try {
    var value = await fn();
    push(name, 'pass', value);
  } catch (err) {
    push(name, 'fail', (err && err.message) || String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      (message || 'not equal') +
        ': actual=' +
        JSON.stringify(actual) +
        ' expected=' +
        JSON.stringify(expected)
    );
  }
}

function approx(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > (tolerance === undefined ? 1e-9 : tolerance)) {
    throw new Error(
      (message || 'not approx') + ': actual=' + actual + ' expected=' + expected
    );
  }
}

function summary() {
  var groups = state.groups.map(function (item) {
    var passed = item.tests.filter(function (t) {
      return t.status === 'pass';
    }).length;
    var failed = item.tests.length - passed;
    return {
      name: item.name,
      total: item.tests.length,
      passed: passed,
      failed: failed,
      tests: item.tests
    };
  });
  var total = 0;
  var passed = 0;
  groups.forEach(function (g) {
    total += g.total;
    passed += g.passed;
  });
  return { groups: groups, total: total, passed: passed, failed: total - passed };
}

function reset() {
  state.groups = [];
}

module.exports = {
  group: group,
  test: test,
  testAsync: testAsync,
  assert: assert,
  equal: equal,
  approx: approx,
  summary: summary,
  reset: reset
};
