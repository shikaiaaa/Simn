/**
 * tests/unit/cloudfunctions/model3d/glb.test.js —— GLB 防御性解析与入库校验。
 */
'use strict'

var glb = require('../../../../cloudfunctions/sinn-model3d/lib/glb')
var buildMockGlb = require('../../../../cloudfunctions/sinn-model3d/lib/vendor/mock-model3d-vendor').buildMockGlb

function buildGlb(json) {
  var body = Buffer.from(JSON.stringify(json), 'utf8')
  var paddedLength = Math.ceil(body.length / 4) * 4
  var padded = Buffer.alloc(paddedLength, 0x20)
  body.copy(padded, 0)
  var header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedLength, 8)
  var chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(paddedLength, 0)
  chunk.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunk, padded])
}

function expectCode(fn, code) {
  var caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).not.toBeNull()
  expect(caught.code).toBe(code)
  return caught
}

describe('lib/glb parseGlb', function () {
  test('mock GLB：magic/版本/节点/网格统计正确，无纹理', function () {
    var buffer = buildMockGlb()
    var meta = glb.parseGlb(buffer)
    expect(meta).toMatchObject({
      ok: true,
      format: 'glb',
      version: 2,
      nodeCount: 1,
      meshCount: 1,
      primitiveCount: 1,
      textureCount: 0,
      textureBytes: 0,
      triangleCount: 0,
      hasBin: false
    })
    expect(meta.bytes).toBe(buffer.length)
  })

  test('非 Buffer / 空 / 过短 → 6002', function () {
    expectCode(function () { glb.parseGlb('x') }, 6002)
    expectCode(function () { glb.parseGlb(Buffer.alloc(0)) }, 6002)
    expectCode(function () { glb.parseGlb(Buffer.alloc(10)) }, 6002)
  })

  test('magic/版本/声明长度错误 → 6002', function () {
    var badMagic = Buffer.from(buildMockGlb())
    badMagic.write('XXXX', 0, 'ascii')
    expectCode(function () { glb.parseGlb(badMagic) }, 6002)

    var badVersion = Buffer.from(buildMockGlb())
    badVersion.writeUInt32LE(1, 4)
    expectCode(function () { glb.parseGlb(badVersion) }, 6002)

    var badLength = Buffer.from(buildMockGlb())
    badLength.writeUInt32LE(badLength.length + 4, 8)
    expectCode(function () { glb.parseGlb(badLength) }, 6002)
  })

  test('缺 JSON chunk → 6002', function () {
    var buffer = buildMockGlb()
    buffer.writeUInt32LE(0x004e4942, 16) // JSON chunk 类型改成 BIN
    expectCode(function () { glb.parseGlb(buffer) }, 6002)
  })

  test('超过 45MB → 6003', function () {
    var huge = Buffer.alloc(45 * 1024 * 1024 + 1)
    huge.write('glTF', 0, 'ascii')
    expectCode(function () { glb.parseGlb(huge) }, 6003)
  })

  test('空 JSON（无节点/网格）可通过 parseGlb，但 validateModelBuffer → 6002', function () {
    var buffer = buildGlb({ asset: { version: '2.0' } })
    var meta = glb.parseGlb(buffer)
    expect(meta.nodeCount).toBe(0)
    expectCode(function () { glb.validateModelBuffer(buffer) }, 6002)
  })

  test('validateModelBuffer：mock GLB 通过', function () {
    expect(glb.validateModelBuffer(buildMockGlb()).meshCount).toBe(1)
  })
})
