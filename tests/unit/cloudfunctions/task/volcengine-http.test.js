'use strict'

/**
 * task-56：火山引擎图片换装 V2 真实 transport 单测（全离线，无网络、无真实凭证）。
 *
 * 覆盖：
 * - V4 签名纯函数（固定时间戳/AK/SK/region/service/action/body，与手工重算对比）
 * - RFC3986 编码、X-Date 格式、规范查询串排序
 * - submit：成功（code=10000 + data.task_id）、业务错误码、图片 >5MB 提前拒绝、
 *   缺图片输入提前拒绝、请求体为 V2 base64 直传格式（req_image_store_type=0）
 * - query：状态映射 in_queue→pending / generating→running / done→success（url 或 base64）/
 *   not_found/expired→errorCode / 未知状态→unknown_status / code!=10000 业务错误
 * - fetchResult：PNG 尺寸解析、空图、缺 URL
 * - ping：网络可达性
 * - 密钥安全：拒绝信息与结果 JSON 不含 AK/SK
 */

var crypto = require('crypto')
var volcHttp = require('../../../../cloudfunctions/sinn-task/lib/vendor/volcengine-http')
var vendorLib = require('../../../../cloudfunctions/sinn-task/lib/vendor/index')

var AK = 'AKLDEMO_example_key_id'
var SK = 'ZGVtby1zZWNyZXQtYWNjZXNzLWtleQ=='
var CREDS = {
  SINN_VENDOR: 'volcengine',
  SINN_VOLC_AK: AK,
  SINN_VOLC_SK: SK,
  SINN_VOLC_REGION: 'cn-north-1'
}
var FIXED_DATE = new Date('2026-11-11T12:34:56.789Z')

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

/** 独立重算 V4 签名（与实现分开手写，用于交叉校验） */
function independentSignature(ak, sk, region, service, xDate, action, version, body) {
  var shortDate = xDate.slice(0, 8)
  var payloadHash = sha256Hex(body)
  var query = 'Action=' + encodeURIComponent(action) + '&Version=' + encodeURIComponent(version)
  var canonicalHeaders =
    'content-type:application/json\n' +
    'host:visual.volcengineapi.com\n' +
    'x-content-sha256:' + payloadHash + '\n' +
    'x-date:' + xDate + '\n'
  var signedHeaders = 'content-type;host;x-content-sha256;x-date'
  // 官方格式："x-date:...\n\ncontent-type;host;..."：headers 块末尾有 \n，再接一个空行。
  var canonicalRequest =
    'POST\n/\n' + query + '\n' +
    canonicalHeaders + '\n' +
    signedHeaders + '\n' +
    payloadHash
  var scope = shortDate + '/' + region + '/' + service + '/request'
  var stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n')
  var kDate = hmacHex(sk, shortDate)
  var kRegion = hmacHex(Buffer.from(kDate, 'hex'), region)
  var kService = hmacHex(Buffer.from(kRegion, 'hex'), service)
  var kSigning = hmacHex(Buffer.from(kService, 'hex'), 'request')
  return {
    signature: hmacHex(Buffer.from(kSigning, 'hex'), stringToSign),
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign
  }
}

function makePng(width, height) {
  var buffer = Buffer.alloc(33)
  ;[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach(function (byte, index) {
    buffer[index] = byte
  })
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8 // bit depth
  buffer[25] = 6 // color type
  return buffer
}

function makeTransport(overrides) {
  overrides = overrides || {}
  var requests = []
  var calls = { fetch: 0, ping: 0 }
  var transport = volcHttp.createVolcengineHttpTransport(CREDS, {
    now: function () {
      return FIXED_DATE
    },
    timeoutMs: 1000,
    logger: overrides.logger || { log: function () {} },
    requestFn: function (options) {
      requests.push(options)
      if (overrides.requestFn) return overrides.requestFn(options)
      return Promise.resolve({
        statusCode: 200,
        json: { code: 10000, data: { task_id: '7392616336519610409' }, request_id: 'req-1', message: 'Success' }
      })
    },
    fetchFn: overrides.fetchFn || function () {
      calls.fetch += 1
      return Promise.resolve({ buffer: makePng(100, 200), contentType: 'image/png', statusCode: 200 })
    },
    pingFn: overrides.pingFn || function () {
      calls.ping += 1
      return Promise.resolve({ ok: true, statusCode: 200 })
    }
  })
  return { transport: transport, requests: requests, calls: calls }
}

describe('task-56 火山引擎 V2 transport（离线）', function () {
  test('V4 签名与独立重算一致，Authorization 结构符合官方格式', function () {
    var body = Buffer.from(JSON.stringify({ req_key: 'dressing_diffusionV2', task_id: 't1' }), 'utf8')
    var signed = volcHttp.buildV4SignedHeaders({
      ak: AK,
      sk: SK,
      region: 'cn-north-1',
      service: 'cv',
      xDate: '20261111T123456Z',
      method: 'POST',
      path: '/',
      query: { Action: 'CVGetResult', Version: '2022-08-31' },
      body: body,
      contentType: 'application/json'
    })
    var expected = independentSignature(AK, SK, 'cn-north-1', 'cv', '20261111T123456Z', 'CVGetResult', '2022-08-31', body)
    expect(signed.signature).toBe(expected.signature)
    expect(signed.stringToSign).toBe(expected.stringToSign)
    expect(signed.canonicalRequest).toBe(expected.canonicalRequest)
    expect(signed.canonicalRequest).toContain(
      'x-date:20261111T123456Z\n\ncontent-type;host;x-content-sha256;x-date\n'
    )
    expect(signed.canonicalRequest).not.toContain('\n\n\n')
    expect(signed.headers.Authorization).toBe(
      'HMAC-SHA256 Credential=' + AK + '/20261111/cn-north-1/cv/request' +
      ', SignedHeaders=content-type;host;x-content-sha256;x-date' +
      ', Signature=' + expected.signature
    )
    expect(signed.headers['X-Content-Sha256']).toBe(sha256Hex(body))
    expect(signed.headers['X-Date']).toBe('20261111T123456Z')
  })

  test('辅助函数：X-Date 格式、RFC3986 编码、查询串 ASCII 升序', function () {
    expect(volcHttp.formatXDate(FIXED_DATE)).toBe('20261111T123456Z')
    expect(volcHttp.encodeRfc3986("a b!'()*~_-.")).toBe('a%20b%21%27%28%29%2A~_-.')
    expect(volcHttp.buildCanonicalQuery({ Version: '2022-08-31', Action: 'CVSubmitTask' })).toBe(
      'Action=CVSubmitTask&Version=2022-08-31'
    )
  })

  test('submit 成功：CVSubmitTask + V2 base64 直传格式，返回 taskId/requestId', async function () {
    var fixture = makeTransport()
    var person = Buffer.from('PERSON_IMAGE_BYTES')
    var garment = Buffer.from('GARMENT_IMAGE_BYTES')
    var result = await fixture.transport.submit({ personBuffers: [person], garmentBuffer: garment, metrics: null })

    expect(result.taskId).toBe('7392616336519610409')
    expect(result.requestId).toBe('req-1')

    var request = fixture.requests[0]
    expect(request.path).toBe('/?Action=CVSubmitTask&Version=2022-08-31')
    expect(request.method).toBe('POST')
    expect(request.headers.Authorization).toMatch(/^HMAC-SHA256 Credential=AKLDEMO_example_key_id\/20261111\/cn-north-1\/cv\/request/)
    expect(request.headers['X-Date']).toBe('20261111T123456Z')
    expect(request.headers['X-Content-Sha256']).toBe(sha256Hex(request.body))

    var body = JSON.parse(request.body.toString('utf8'))
    expect(body.req_key).toBe('dressing_diffusionV2')
    expect(body.req_image_store_type).toBe(0)
    expect(body.binary_data_base64).toEqual([person.toString('base64'), garment.toString('base64')])
    expect(body.garment.data).toEqual([{ type: 'upper' }])
    // 结果对象不含密钥
    expect(JSON.stringify(result)).not.toMatch(/ZGVtby1zZWNyZXQ|AKLDEMO/)
  })

  test('submit 业务错误码透传（HTTP 400 + code 50413，不乱重试）', async function () {
    var fixture = makeTransport({
      requestFn: function () {
        return Promise.resolve({
          statusCode: 400,
          json: { code: 50413, message: 'Post Text Risk Not Pass', request_id: 'req-risk' }
        })
      }
    })
    var result = await fixture.transport.submit({
      personBuffers: [Buffer.from('p')],
      garmentBuffer: Buffer.from('g')
    })
    expect(result.errorCode).toBe(50413)
    expect(result.errorMessage).toBe('Post Text Risk Not Pass')
    expect(result.httpStatus).toBe(400)
    expect(JSON.stringify(result)).not.toMatch(/ZGVtby1zZWNyZXQ|AKLDEMO/)
  })

  test('submit 图片超过 5MB：提前拒绝，不发起真实请求', async function () {
    var requestCount = 0
    var fixture = makeTransport({
      requestFn: function () {
        requestCount += 1
        return Promise.resolve({ statusCode: 200, json: { code: 10000, data: { task_id: 'x' } } })
      }
    })
    var tooLarge = Buffer.alloc(volcHttp.MAX_INPUT_BYTES + 1)
    var result = await fixture.transport.submit({ personBuffers: [tooLarge], garmentBuffer: Buffer.from('g') })
    expect(result.errorCode).toBe('input_image_too_large')
    expect(requestCount).toBe(0)
  })

  test('submit 缺图片输入：提前拒绝，不发起请求', async function () {
    var fixture = makeTransport()
    var result = await fixture.transport.submit({ personBuffers: [], garmentBuffer: null })
    expect(result.errorCode).toBe('missing_image_input')
    expect(fixture.requests).toHaveLength(0)
  })

  test('query 状态映射：in_queue/generating/done(url 或 base64)/not_found/expired/未知', async function () {
    var cases = [
      { status: 'in_queue', expect: { status: 'pending' } },
      { status: 'generating', expect: { status: 'running' } },
      { status: 'done', image_urls: ['https://example.com/r.png'], expect: { status: 'success', resultUrl: 'https://example.com/r.png' } },
      { status: 'done', binary_data_base64: [makePng(1, 1).toString('base64')], expect: { status: 'success' } },
      { status: 'not_found', expect: { errorCode: 'not_found' } },
      { status: 'expired', expect: { errorCode: 'expired' } },
      { status: 'weird', expect: { errorCode: 'unknown_status' } }
    ]
    for (var index = 0; index < cases.length; index += 1) {
      var entry = cases[index]
      var fixture = makeTransport({
        requestFn: function () {
          return Promise.resolve({ statusCode: 200, json: { code: 10000, data: entry, request_id: 'r' } })
        }
      })
      var result = await fixture.transport.query({ vendorTaskId: 'vt_1' })
      Object.keys(entry.expect).forEach(function (key) {
        expect(result[key]).toEqual(entry.expect[key])
      })
      var requestBody = JSON.parse(fixture.requests[0].body.toString('utf8'))
      expect(requestBody.req_key).toBe('dressing_diffusionV2')
      expect(requestBody.task_id).toBe('vt_1')
      expect(JSON.parse(requestBody.req_json).return_url).toBe(true)
      expect(fixture.requests[0].path).toBe('/?Action=CVGetResult&Version=2022-08-31')
    }
  })

  test('query 业务错误：code != 10000 返回 vendorCode/httpStatus', async function () {
    var fixture = makeTransport({
      requestFn: function () {
        return Promise.resolve({ statusCode: 400, json: { code: 50411, message: 'Pre Img Risk Not Pass' } })
      }
    })
    var result = await fixture.transport.query({ vendorTaskId: 'vt_1' })
    expect(result.errorCode).toBe(50411)
    expect(result.errorMessage).toBe('Pre Img Risk Not Pass')
    expect(result.httpStatus).toBe(400)
  })

  test('fetchResult：下载 PNG 并解析 IHDR 宽高', async function () {
    var fixture = makeTransport()
    var result = await fixture.transport.fetchResult({ url: 'https://example.com/result.png' })
    expect(Buffer.isBuffer(result.buffer)).toBe(true)
    expect(result.width).toBe(100)
    expect(result.height).toBe(200)
    expect(result.format).toBe('png')
  })

  test('fetchResult：空图/缺 URL 返回错误，不抛未捕获异常', async function () {
    var empty = makeTransport({
      fetchFn: function () {
        return Promise.resolve({ buffer: Buffer.alloc(0), statusCode: 200 })
      }
    })
    var emptyResult = await empty.transport.fetchResult({ url: 'https://example.com/a.png' })
    expect(emptyResult.errorCode).toBe('empty_result_image')

    var missing = makeTransport()
    var missingResult = await missing.transport.fetchResult({})
    expect(missingResult.errorCode).toBe('missing_result_url')
  })

  test('ping：仅验证 Endpoint 可达，不计费、不带凭证', async function () {
    var fixture = makeTransport()
    var result = await fixture.transport.ping()
    expect(result.ok).toBe(true)
    expect(typeof result.latencyMs).toBe('number')
    expect(fixture.calls.ping).toBe(1)
  })

  test('缺凭证时 transport.configured=false（不假装可用；vendor 层会拒绝网络方法）', function () {
    var transport = volcHttp.createVolcengineHttpTransport({ SINN_VENDOR: 'volcengine' }, {})
    expect(transport.configured).toBe(false)
    var noCredsAdapter = vendorLib.createVendorAdapter({ SINN_VENDOR: 'volcengine' }, { transport: transport })
    expect(noCredsAdapter.configured).toBe(false)
  })
})
