/**
 * tests/unit/cloudfunctions/task/size.test.js
 * 参考尺码：AC-16/AC-17/AC-26 的固定数值预期区间表与边界断言（L1）。
 */
'use strict'

var sizeLib = require('../../../../cloudfunctions/sinn-task/lib/size')

var BANNED_WORDS = ['保证合身', '精准', '准确', '适合你']

describe('DEV-0001-03 sizeResult（参考尺码）', function () {
  test('SIZE_FIXTURES 全部命中固定预期区间（AC-16/AC-26）', function () {
    sizeLib.SIZE_FIXTURES.forEach(function (fixture) {
      var result = sizeLib.computeSize(fixture.metrics)
      if (fixture.expected === null) {
        expect(result).toBeNull()
        return
      }
      expect(result).not.toBeNull()
      expect(result.rangeMin).toBe(fixture.expected.rangeMin)
      expect(result.rangeMax).toBe(fixture.expected.rangeMax)
      expect(result.standard).toBe(fixture.expected.standard)
      expect(result.disclaimer).toBe('参考尺码，不构成合身承诺')
      expect(result.basis.heightCm).toBe(fixture.metrics.heightCm)
      expect(result.basis.weightKg).toBe(fixture.metrics.weightKg)
    })
  })

  test('三围全缺 → sizeResult=null，不编造区间（AC-17）', function () {
    expect(sizeLib.computeSize({ heightCm: 170, weightKg: 60, gender: 'male' })).toBeNull()
    expect(sizeLib.computeSize({ heightCm: 170, weightKg: 60, gender: 'female' })).toBeNull()
    expect(sizeLib.computeSize({ heightCm: 170, weightKg: 60 })).toBeNull()
  })

  test('区间始终是六档内相邻两档（含边界收敛）', function () {
    var cases = [
      { heightCm: 150, weightKg: 40, gender: 'female', chestCm: 74, waistCm: 58, hipCm: 80 },
      { heightCm: 190, weightKg: 95, gender: 'male', chestCm: 110, waistCm: 100, hipCm: 112 },
      { heightCm: 168, weightKg: 60, gender: 'unspecified', chestCm: 88, waistCm: 72, hipCm: 94 }
    ]
    cases.forEach(function (metrics) {
      var result = sizeLib.computeSize(metrics)
      var minIndex = sizeLib.TIERS.indexOf(result.rangeMin)
      var maxIndex = sizeLib.TIERS.indexOf(result.rangeMax)
      expect(minIndex).toBeGreaterThanOrEqual(0)
      expect(maxIndex).toBe(minIndex + 1)
      expect(maxIndex).toBeLessThan(sizeLib.TIERS.length)
    })
  })

  test('三种 gender 使用对应国标；非法 gender 归入 unspecified', function () {
    var base = { heightCm: 170, weightKg: 65, chestCm: 90, waistCm: 76, hipCm: 96 }
    expect(sizeLib.computeSize(Object.assign({ gender: 'male' }, base)).standard).toBe('GB/T 1335.1')
    expect(sizeLib.computeSize(Object.assign({ gender: 'female' }, base)).standard).toBe('GB/T 1335.2')
    expect(sizeLib.computeSize(Object.assign({ gender: 'unspecified' }, base)).standard).toBe(
      'GB/T 1335（中性映射）'
    )
    expect(sizeLib.computeSize(Object.assign({ gender: 'robot' }, base)).standard).toBe(
      'GB/T 1335（中性映射）'
    )
  })

  test('输出文案不含禁词（AC-16）', function () {
    sizeLib.SIZE_FIXTURES.forEach(function (fixture) {
      var result = sizeLib.computeSize(fixture.metrics)
      if (!result) return
      var text = JSON.stringify(result)
      BANNED_WORDS.forEach(function (word) {
        expect(text.indexOf(word)).toBe(-1)
      })
    })
  })
})
