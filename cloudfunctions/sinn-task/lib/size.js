/**
 * lib/size.js —— 参考尺码（服务端计算，端上零推理；SPEC-0001 §5 / AC-16/17/26）。
 *
 * 规则（BR-4/CP-06）：
 * - male → GB/T 1335.1 男装表；female → GB/T 1335.2 女装表；unspecified → 中性六档简化映射；
 * - 身高为主档，BMI 至多调整 ±1 档，边界收敛到 XS/XXL；
 * - 若填写三围，用三围收窄区间（三围档位与身高档位取均值）；
 * - 区间为相邻两档（XXL 收为 XL–XXL），落在 XS/S/M/L/XL/XXL 六档内；
 * - 三围全缺 → sizeResult=null（不编造区间）；
 * - 免责固定「参考尺码，不构成合身承诺」，无结论词。
 *
 * 本文件的 SIZE_FIXTURES 是 AC-16/AC-26 的「固定数值预期区间表」，QA 可直接复用。
 */
'use strict'

var TIERS = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
var DISCLAIMER = '参考尺码，不构成合身承诺'
var STANDARDS = {
  male: 'GB/T 1335.1',
  female: 'GB/T 1335.2',
  unspecified: 'GB/T 1335（中性映射）'
}

// 身高分档上界（不含）：[上界, 档位索引]
var HEIGHT_BANDS = {
  male: [[165, 0], [170, 1], [175, 2], [180, 3], [185, 4], [999, 5]],
  female: [[155, 0], [160, 1], [165, 2], [170, 3], [175, 4], [999, 5]],
  unspecified: [[160, 0], [165, 1], [170, 2], [175, 3], [180, 4], [999, 5]]
}

// 三围分档上界（不含，cm）：[上界, 档位索引]
var CIRCUMFERENCE_BANDS = {
  male: {
    chest: [[84, 0], [88, 1], [92, 2], [96, 3], [100, 4], [999, 5]],
    waist: [[72, 0], [76, 1], [80, 2], [84, 3], [88, 4], [999, 5]],
    hip: [[88, 0], [92, 1], [96, 2], [100, 3], [104, 4], [999, 5]]
  },
  female: {
    chest: [[78, 0], [82, 1], [86, 2], [90, 3], [94, 4], [999, 5]],
    waist: [[64, 0], [68, 1], [72, 2], [76, 3], [80, 4], [999, 5]],
    hip: [[86, 0], [90, 1], [94, 2], [98, 3], [102, 4], [999, 5]]
  },
  unspecified: {
    chest: [[80, 0], [84, 1], [88, 2], [92, 3], [96, 4], [999, 5]],
    waist: [[68, 0], [72, 1], [76, 2], [80, 3], [84, 4], [999, 5]],
    hip: [[86, 0], [90, 1], [94, 2], [98, 3], [102, 4], [999, 5]]
  }
}

function clampTier(index) {
  if (index < 0) return 0
  if (index > 5) return 5
  return index
}

function tierForBands(bands, value) {
  for (var i = 0; i < bands.length; i += 1) {
    if (value < bands[i][0]) return bands[i][1]
  }
  return 5
}

function heightTier(gender, heightCm) {
  return tierForBands(HEIGHT_BANDS[gender] || HEIGHT_BANDS.unspecified, heightCm)
}

function bmiAdjustment(heightCm, weightKg) {
  var meters = heightCm / 100
  var bmi = weightKg / (meters * meters)
  if (bmi < 18.5) return -1
  if (bmi >= 28) return 1
  return 0
}

function circumferenceTier(gender, metrics) {
  var table = CIRCUMFERENCE_BANDS[gender] || CIRCUMFERENCE_BANDS.unspecified
  var tiers = []
  if (metrics.chestCm !== undefined) tiers.push(tierForBands(table.chest, metrics.chestCm))
  if (metrics.waistCm !== undefined) tiers.push(tierForBands(table.waist, metrics.waistCm))
  if (metrics.hipCm !== undefined) tiers.push(tierForBands(table.hip, metrics.hipCm))
  if (tiers.length === 0) return null
  var sum = tiers.reduce(function (acc, value) { return acc + value }, 0)
  return Math.round(sum / tiers.length)
}

function hasAnyCircumference(metrics) {
  return metrics.chestCm !== undefined || metrics.waistCm !== undefined || metrics.hipCm !== undefined
}

/**
 * 计算参考尺码。
 * @param {{gender?:string,heightCm:number,weightKg:number,chestCm?:number,waistCm?:number,hipCm?:number}} metrics
 * @returns {{rangeMin:string,rangeMax:string,standard:string,basis:object,disclaimer:string}|null}
 */
function computeSize(metrics) {
  metrics = metrics || {}
  if (!hasAnyCircumference(metrics)) return null

  var gender = metrics.gender
  if (['male', 'female', 'unspecified'].indexOf(gender) < 0) gender = 'unspecified'

  var heightIndex = heightTier(gender, metrics.heightCm)
  var adjusted = clampTier(heightIndex + bmiAdjustment(metrics.heightCm, metrics.weightKg))
  var circumference = circumferenceTier(gender, metrics)

  // 三围与身高/体重综合：两者取均值后四舍五入（收窄区间）。
  var finalIndex = circumference === null ? adjusted : clampTier(Math.round((adjusted + circumference) / 2))
  var start = clampTier(finalIndex > 4 ? 4 : finalIndex)

  var basis = { heightCm: metrics.heightCm, weightKg: metrics.weightKg }
  if (metrics.chestCm !== undefined) basis.chestCm = metrics.chestCm
  if (metrics.waistCm !== undefined) basis.waistCm = metrics.waistCm
  if (metrics.hipCm !== undefined) basis.hipCm = metrics.hipCm

  return {
    rangeMin: TIERS[start],
    rangeMax: TIERS[start + 1],
    standard: STANDARDS[gender],
    basis: basis,
    disclaimer: DISCLAIMER
  }
}

/**
 * AC-16/AC-26 固定数值预期区间表（供本仓库单测与 QA 断言复用）。
 * 断言：expected 的 rangeMin/rangeMax/standard/disclaimer 与 computeSize 输出一致。
 */
var SIZE_FIXTURES = [
  {
    name: 'male-175-70-with-circumference',
    metrics: { heightCm: 175, weightKg: 70, gender: 'male', chestCm: 92, waistCm: 78, hipCm: 96 },
    expected: { rangeMin: 'L', rangeMax: 'XL', standard: 'GB/T 1335.1' }
  },
  {
    name: 'female-160-50-with-circumference',
    metrics: { heightCm: 160, weightKg: 50, gender: 'female', chestCm: 84, waistCm: 68, hipCm: 90 },
    expected: { rangeMin: 'M', rangeMax: 'L', standard: 'GB/T 1335.2' }
  },
  {
    name: 'unspecified-168-60-with-circumference',
    metrics: { heightCm: 168, weightKg: 60, gender: 'unspecified', chestCm: 88, waistCm: 72, hipCm: 94 },
    expected: { rangeMin: 'L', rangeMax: 'XL', standard: 'GB/T 1335（中性映射）' }
  },
  {
    name: 'male-158-48-low-bmi',
    metrics: { heightCm: 158, weightKg: 48, gender: 'male', chestCm: 82, waistCm: 68, hipCm: 86 },
    expected: { rangeMin: 'XS', rangeMax: 'S', standard: 'GB/T 1335.1' }
  },
  {
    name: 'female-172-78-high-bmi',
    metrics: { heightCm: 172, weightKg: 78, gender: 'female', chestCm: 100, waistCm: 88, hipCm: 104 },
    expected: { rangeMin: 'XL', rangeMax: 'XXL', standard: 'GB/T 1335.2' }
  },
  {
    name: 'unspecified-all-circumference-missing',
    metrics: { heightCm: 168, weightKg: 60, gender: 'unspecified' },
    expected: null
  }
]

module.exports = {
  TIERS: TIERS,
  DISCLAIMER: DISCLAIMER,
  STANDARDS: STANDARDS,
  SIZE_FIXTURES: SIZE_FIXTURES,
  computeSize: computeSize,
  heightTier: heightTier,
  circumferenceTier: circumferenceTier
}
