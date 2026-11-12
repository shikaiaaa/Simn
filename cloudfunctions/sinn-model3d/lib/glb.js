/**
 * lib/glb.js —— GLB 解析与入库前校验（SPEC-0002 §B.5/§非功能「安全」）。
 *
 * 只做「防御性解析」：
 * - 校验魔数 glTF、版本 2、chunk 边界；
 * - 统计节点数/网格数/图元数/纹理数/纹理字节/三角面估算；
 * - 入库前要求 nodeCount>0 且 meshCount>0（SPEC §2「成功判定」），否则 6002；
 * - 超过 45MB 或纹理超过 15MB → 6003。
 *
 * 本文件不依赖 wx-server-sdk，可本地单测直接 require。
 */
'use strict'

var errors = require('./errors')
var util = require('./util')

var GLB_MAGIC = 'glTF'
var GLB_VERSION = 2
var CHUNK_JSON = 0x4e4f534a
var CHUNK_BIN = 0x004e4942

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

/**
 * 解析 GLB。
 * @param {Buffer} buffer
 * @returns {{ok:true, format:'glb', bytes:number, version:number, nodeCount:number,
 *   meshCount:number, primitiveCount:number, textureCount:number,
 *   textureBytes:number, triangleCount:number, hasBin:boolean}}
 * @throws {AppError} 6002 格式错误；6003 体积超限
 */
function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer)) throw errors.fail(6002, { hint: '模型数据为空' })
  var bytes = buffer.length
  if (bytes === 0) throw errors.fail(6002, { hint: '模型数据为空' })
  if (bytes > util.MAX_MODEL_BYTES) {
    throw errors.fail(6003, { hint: '模型体积超过 45MB 限制' })
  }
  if (bytes < 20) throw errors.fail(6002, { hint: '模型文件不完整' })

  var magic = buffer.toString('ascii', 0, 4)
  if (magic !== GLB_MAGIC) throw errors.fail(6002, { hint: '模型不是合法的 glTF/GLB 文件' })
  var version = readUInt32LE(buffer, 4)
  if (version !== GLB_VERSION) throw errors.fail(6002, { hint: '不支持的 glTF 版本' })
  var declared = readUInt32LE(buffer, 8)
  if (declared !== bytes) throw errors.fail(6002, { hint: '模型文件长度与声明不一致' })

  var offset = 12
  var json = null
  var hasBin = false
  while (offset + 8 <= bytes) {
    var chunkLength = readUInt32LE(buffer, offset)
    var chunkType = readUInt32LE(buffer, offset + 4)
    var dataStart = offset + 8
    var dataEnd = dataStart + chunkLength
    if (chunkLength < 0 || dataEnd > bytes) throw errors.fail(6002, { hint: '模型 chunk 越界' })
    if (chunkType === CHUNK_JSON) {
      try {
        json = JSON.parse(buffer.toString('utf8', dataStart, dataEnd).replace(/\u0000+$/g, ''))
      } catch (e) {
        throw errors.fail(6002, { hint: '模型 JSON 解析失败' })
      }
    } else if (chunkType === CHUNK_BIN) {
      hasBin = true
    }
    offset = dataStart + chunkLength
  }
  if (!json || typeof json !== 'object') throw errors.fail(6002, { hint: '模型缺少 JSON chunk' })

  var nodes = Array.isArray(json.nodes) ? json.nodes : []
  var meshes = Array.isArray(json.meshes) ? json.meshes : []
  var accessors = Array.isArray(json.accessors) ? json.accessors : []
  var bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : []
  var images = Array.isArray(json.images) ? json.images : []
  var textures = Array.isArray(json.textures) ? json.textures : []

  var primitiveCount = 0
  var triangleCount = 0
  meshes.forEach(function (mesh) {
    var primitives = (mesh && Array.isArray(mesh.primitives)) ? mesh.primitives : []
    primitives.forEach(function (primitive) {
      primitiveCount += 1
      var indices = primitive && primitive.indices
      var position = primitive && primitive.attributes && primitive.attributes.POSITION
      var accessor = null
      if (typeof indices === 'number') accessor = accessors[indices]
      else if (typeof position === 'number') accessor = accessors[position]
      if (accessor && util.isFiniteNumber(accessor.count)) {
        triangleCount += Math.max(0, Math.floor(accessor.count / 3))
      }
    })
  })

  var textureBytes = 0
  images.forEach(function (image) {
    if (!image || typeof image.bufferView !== 'number') return
    var view = bufferViews[image.bufferView]
    if (view && util.isFiniteNumber(view.byteLength)) textureBytes += Math.max(0, Math.floor(view.byteLength))
  })

  return {
    ok: true,
    format: 'glb',
    bytes: bytes,
    version: version,
    nodeCount: nodes.length,
    meshCount: meshes.length,
    primitiveCount: primitiveCount,
    textureCount: textures.length,
    textureBytes: textureBytes,
    triangleCount: triangleCount,
    hasBin: hasBin
  }
}

/**
 * 入库前强校验：解析 + 节点/网格数 >0 + 纹理总字节 ≤15MB。
 * 通过返回解析结果；失败抛 6002/6003。
 */
function validateModelBuffer(buffer) {
  var meta = parseGlb(buffer)
  if (meta.nodeCount <= 0 || meta.meshCount <= 0) {
    throw errors.fail(6002, { hint: '模型未包含可渲染的节点/网格' })
  }
  if (meta.textureBytes > util.MAX_TEXTURE_BYTES) {
    throw errors.fail(6003, { hint: '模型纹理总大小超过 15MB 限制' })
  }
  return meta
}

module.exports = {
  GLB_MAGIC: GLB_MAGIC,
  GLB_VERSION: GLB_VERSION,
  parseGlb: parseGlb,
  validateModelBuffer: validateModelBuffer
}
