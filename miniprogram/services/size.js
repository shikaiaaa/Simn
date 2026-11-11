// size.js —— 结果页尺码展示（端上零推理，仅格式化服务端 sizeResult）。
//
// SPEC-0001 §5 / AC-16 / AC-17 / AC-26：
// - 参考尺码完全由服务端按 metrics 计算（male→GB/T 1335.1、female→GB/T 1335.2、
//   unspecified→GB/T 1335 中性映射），端上不得重算、不得编造。
// - 三围全缺时服务端返回 sizeResult=null，端上显示「信息不足，无法给出参考尺码」。
// - 免责声明固定为「参考尺码，不构成合身承诺」；页面禁止出现
//   「保证合身 / 精准 / 准确 / 适合你」等承诺性表述。

'use strict';

var SIZE_DISCLAIMER = '参考尺码，不构成合身承诺';
var SIZE_INSUFFICIENT_TEXT = '信息不足，无法给出参考尺码';
var FORBIDDEN_WORDS = ['保证合身', '精准', '准确', '适合你'];

var BASIS_LABELS = {
  heightCm: '身高',
  weightKg: '体重',
  chestCm: '胸围',
  waistCm: '腰围',
  hipCm: '臀围'
};

var BASIS_UNITS = {
  heightCm: 'cm',
  weightKg: 'kg',
  chestCm: 'cm',
  waistCm: 'cm',
  hipCm: 'cm'
};

var BASIS_ORDER = ['heightCm', 'weightKg', 'chestCm', 'waistCm', 'hipCm'];

function normalizeSizeResult(sizeResult) {
  if (!sizeResult || typeof sizeResult !== 'object') return null;
  var rangeMin = sizeResult.rangeMin;
  var rangeMax = sizeResult.rangeMax;
  if (!rangeMin || !rangeMax) return null;
  return {
    rangeMin: String(rangeMin),
    rangeMax: String(rangeMax),
    standard: typeof sizeResult.standard === 'string' ? sizeResult.standard : '',
    basis: sizeResult.basis && typeof sizeResult.basis === 'object' ? sizeResult.basis : {},
    disclaimer:
      typeof sizeResult.disclaimer === 'string' && sizeResult.disclaimer
        ? sizeResult.disclaimer
        : SIZE_DISCLAIMER
  };
}

// 相邻两档用 en dash 连接；同档才显示单值（服务端保证相邻两档或同档）。
function formatRange(sizeResult) {
  var normalized = normalizeSizeResult(sizeResult);
  if (!normalized) return '';
  if (normalized.rangeMin === normalized.rangeMax) return normalized.rangeMin;
  return normalized.rangeMin + '–' + normalized.rangeMax;
}

function formatBasis(basis) {
  if (!basis || typeof basis !== 'object') return '';
  var parts = [];
  for (var i = 0; i < BASIS_ORDER.length; i += 1) {
    var key = BASIS_ORDER[i];
    var value = basis[key];
    if (typeof value === 'number' && isFinite(value)) {
      parts.push(BASIS_LABELS[key] + ' ' + value + BASIS_UNITS[key]);
    }
  }
  if (!parts.length) return '';
  return '依据：' + parts.join('、');
}

function formatDegradedNotice(sizeFallback) {
  if (!sizeFallback || typeof sizeFallback !== 'object' || !sizeFallback.degraded) return '';
  var longSide = typeof sizeFallback.longSide === 'number' ? sizeFallback.longSide : 0;
  var text =
    longSide > 0
      ? '当前结果长边为 ' + longSide + 'px，低于优先分辨率 2048px，已降级输出。'
      : '当前结果分辨率低于优先分辨率 2048px，已降级输出。';
  if (sizeFallback.requiresReview) {
    text += '请放大检查衣服纹理与边缘细节后再使用。';
  }
  return text;
}

function buildSizeView(sizeResult, sizeFallback) {
  var normalized = normalizeSizeResult(sizeResult);
  var fallback = sizeFallback && typeof sizeFallback === 'object' ? sizeFallback : null;
  var degraded = !!(fallback && fallback.degraded);
  if (!normalized) {
    return {
      available: false,
      rangeText: '',
      standardText: '',
      basisText: '',
      disclaimer: SIZE_DISCLAIMER,
      insufficientText: SIZE_INSUFFICIENT_TEXT,
      degraded: degraded
    };
  }
  return {
    available: true,
    rangeText: formatRange(normalized),
    standardText: normalized.standard ? '标准：' + normalized.standard : '',
    basisText: formatBasis(normalized.basis),
    disclaimer: normalized.disclaimer || SIZE_DISCLAIMER,
    insufficientText: '',
    degraded: degraded
  };
}

// 供单测/静态检查使用：返回命中的承诺性禁词，空数组表示通过。
function findForbiddenWords(text) {
  var source = typeof text === 'string' ? text : '';
  var hits = [];
  for (var i = 0; i < FORBIDDEN_WORDS.length; i += 1) {
    if (source.indexOf(FORBIDDEN_WORDS[i]) >= 0) hits.push(FORBIDDEN_WORDS[i]);
  }
  return hits;
}

module.exports = {
  SIZE_DISCLAIMER: SIZE_DISCLAIMER,
  SIZE_INSUFFICIENT_TEXT: SIZE_INSUFFICIENT_TEXT,
  FORBIDDEN_WORDS: FORBIDDEN_WORDS,
  BASIS_LABELS: BASIS_LABELS,
  normalizeSizeResult: normalizeSizeResult,
  formatRange: formatRange,
  formatBasis: formatBasis,
  formatDegradedNotice: formatDegradedNotice,
  buildSizeView: buildSizeView,
  findForbiddenWords: findForbiddenWords
};
