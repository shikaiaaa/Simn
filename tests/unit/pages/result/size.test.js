// size.test.js —— 结果页尺码展示（DEV-0001-08 / AC-16 / AC-17 / AC-26）
// 断言重点：端上零推理，只格式化服务端 sizeResult；三围全缺显示「信息不足」；
// 免责声明与标准名原样保留；展示文案不含承诺性禁词。

'use strict';

var size = require('../../../../miniprogram/services/size');

function serverSizeResult(overrides) {
  return Object.assign(
    {
      rangeMin: 'L',
      rangeMax: 'XL',
      standard: 'GB/T 1335.1',
      basis: { heightCm: 175, weightKg: 70, chestCm: 92, waistCm: 78, hipCm: 96 },
      disclaimer: '参考尺码，不构成合身承诺'
    },
    overrides || {}
  );
}

describe('size service: 服务端 sizeResult 展示', () => {
  test('相邻两档用 en dash 展示', () => {
    expect(size.formatRange(serverSizeResult())).toBe('L–XL');
  });

  test('同档结果不重复展示两个档位', () => {
    expect(size.formatRange(serverSizeResult({ rangeMin: 'M', rangeMax: 'M' }))).toBe('M');
  });

  test('标准名原样展示（含三种 gender 映射）', () => {
    ['GB/T 1335.1', 'GB/T 1335.2', 'GB/T 1335（中性映射）'].forEach(function (standard) {
      var view = size.buildSizeView(serverSizeResult({ standard: standard }), null);
      expect(view.standardText).toBe('标准：' + standard);
      expect(view.rangeText).toBe('L–XL');
    });
  });

  test('依据只格式化服务端给出的数值字段', () => {
    var view = size.buildSizeView(serverSizeResult(), null);
    expect(view.basisText).toBe('依据：身高 175cm、体重 70kg、胸围 92cm、腰围 78cm、臀围 96cm');
  });

  test('未提供的三围不显示在依据里（不补算）', () => {
    var view = size.buildSizeView(
      serverSizeResult({ basis: { heightCm: 175, weightKg: 70 } }),
      null
    );
    expect(view.basisText).toBe('依据：身高 175cm、体重 70kg');
  });

  test('sizeResult=null（三围全缺）显示信息不足文案', () => {
    var view = size.buildSizeView(null, null);
    expect(view.available).toBe(false);
    expect(view.insufficientText).toBe('信息不足，无法给出参考尺码');
    expect(view.rangeText).toBe('');
  });

  test('缺 rangeMin/rangeMax 时同样视为不可用，端上不猜尺码', () => {
    expect(size.buildSizeView({ standard: 'GB/T 1335.1' }, null).available).toBe(false);
    expect(size.buildSizeView({ rangeMin: 'L' }, null).available).toBe(false);
    expect(size.buildSizeView(undefined, undefined).available).toBe(false);
  });

  test('免责声明固定为「参考尺码，不构成合身承诺」', () => {
    expect(size.buildSizeView(serverSizeResult(), null).disclaimer).toBe(
      '参考尺码，不构成合身承诺'
    );
    expect(size.buildSizeView(null, null).disclaimer).toBe('参考尺码，不构成合身承诺');
  });

  test('降级结果给出长边与人工复核提示', () => {
    var notice = size.formatDegradedNotice({
      degraded: true,
      longSide: 1536,
      expected: 2048,
      requiresReview: true
    });
    expect(notice).toContain('1536');
    expect(notice).toContain('2048');
    expect(notice).toContain('放大检查');
  });

  test('非降级结果不显示降级提示', () => {
    expect(size.formatDegradedNotice(null)).toBe('');
    expect(size.formatDegradedNotice({ degraded: false })).toBe('');
  });

  test('禁词检测能识别承诺性表述', () => {
    expect(size.findForbiddenWords('保证合身')).toEqual(['保证合身']);
    expect(size.findForbiddenWords('精准匹配')).toEqual(['精准']);
    expect(size.findForbiddenWords('参考尺码，不构成合身承诺')).toEqual([]);
  });

  test('尺码展示文案不含禁词', () => {
    var view = size.buildSizeView(serverSizeResult(), { degraded: true, longSide: 1536, requiresReview: true });
    var text = [
      view.rangeText,
      view.standardText,
      view.basisText,
      view.disclaimer,
      view.insufficientText,
      size.formatDegradedNotice({ degraded: true, longSide: 1536, requiresReview: true })
    ].join(' ');
    expect(size.findForbiddenWords(text)).toEqual([]);
  });

  test('端上不暴露任何档位/推理表（只做展示）', () => {
    expect(size.TIERS).toBeUndefined();
    expect(size.HEIGHT_BANDS).toBeUndefined();
    expect(typeof size.buildSizeView).toBe('function');
    expect(typeof size.formatRange).toBe('function');
  });
});
