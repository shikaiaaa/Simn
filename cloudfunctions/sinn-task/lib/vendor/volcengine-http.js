'use strict';

/**
 * 火山引擎「图片换装 V2」真实 HTTP 传输层（task-56）。
 *
 * 依据（已核对官方文档，2026-11-11）：
 * - 图片换装 V2 接口文档：
 *   https://docs.volcengine.com/docs/zh/large-model-of-image-generation/image-change-v2-interface-documentation.md
 *   - 接口地址 https://visual.volcengineapi.com，POST，Content-Type application/json
 *   - Region 固定 cn-north-1，Service 固定 cv
 *   - 提交 Action=CVSubmitTask&Version=2022-08-31，req_key=dressing_diffusionV2
 *     支持 req_image_store_type=0 + binary_data_base64（模特图 + 服装图，最多 2 件服装）
 *   - 查询 Action=CVGetResult&Version=2022-08-31，返回 data.status
 *     in_queue / generating / done / not_found / expired；成功图片 image_urls（24h，PNG）
 *   - 输入限制：JPG/PNG/JFIF，建议 JPG；小于 5MB，小于 4096*4096
 * - 签名：https://docs.volcengine.com/docs/zh/api-signature-call-guide/signature-method.md
 *   公共参数：https://docs.volcengine.com/docs/zh/api-signature-call-guide/common-parameters.md
 *   V4 HMAC-SHA256：CanonicalRequest / StringToSign / kSigning 派生 / Authorization 头。
 *
 * 约定：
 * - AK/SK 只从 env（生产为 process.env 的 SINN_VOLC_AK / SINN_VOLC_SK）读取；
 *   本文件不打印、不返回、不落盘任何密钥或图片 base64。
 * - 本模块是纯 Node 代码（https/crypto），不依赖 wx-server-sdk，可在单测直接加载。
 * - 这是 volcengine-vendor.js 的 transport 注入实现，不含业务状态机；状态归一化由
 *   volcengine-vendor.js 完成（本层把 V2 状态映射成 vendor 约定的 pending/running/success/failed）。
 * - 部署时随云函数目录整体上传；真实调用成本 1 元/次（V1/V2 同价，产品介绍页），
 *   本任务真实调用次数受 Q-21 限制（≤2 次），由 Lead 安排执行。
 */

var crypto = require('crypto');
var https = require('https');
var http = require('http');
var urlmod = require('url');

var HOST = 'visual.volcengineapi.com';
var PATH = '/';
var SERVICE = 'cv';
var API_VERSION = '2022-08-31';
var REGION_DEFAULT = 'cn-north-1';
var REQ_KEY = 'dressing_diffusionV2';
var ACTION_SUBMIT = 'CVSubmitTask';
var ACTION_QUERY = 'CVGetResult';
var DEFAULT_TIMEOUT_MS = 8000;
var PING_TIMEOUT_MS = 3000;
var MAX_INPUT_BYTES = 5 * 1024 * 1024; // 官方限制：单图小于 5MB
var MAX_REDIRECTS = 3;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC3986 编码：encodeURIComponent 之外再转义 ! ' ( ) * */
function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (ch) {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
  });
}

/** X-Date：UTC ISO8601 基本格式 YYYYMMDD'T'HHMMSS'Z' */
function formatXDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 规范查询串：按参数名 ASCII 升序，RFC3986 编码后 '&' 连接 */
function buildCanonicalQuery(params) {
  var keys = Object.keys(params || {}).sort();
  return keys
    .map(function (key) {
      return encodeRfc3986(key) + '=' + encodeRfc3986(params[key]);
    })
    .join('&');
}

/**
 * 构造 V4 签名头（纯函数，供单测用固定时间戳/固定密钥断言）。
 * @param {{ak:string,sk:string,region:string,service:string,xDate:string,method:string,path:string,query:object,body:Buffer|string,contentType:string}} input
 * @returns {{headers:object,canonicalRequest:string,stringToSign:string,signature:string}}
 */
function buildV4SignedHeaders(input) {
  var method = (input.method || 'POST').toUpperCase();
  var path = input.path || PATH;
  var contentType = input.contentType || 'application/json';
  var body = input.body === undefined || input.body === null ? Buffer.alloc(0) : input.body;
  var bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  var payloadHash = sha256Hex(bodyBuffer);
  var xDate = input.xDate;
  var shortDate = xDate.slice(0, 8);
  var canonicalQuery = buildCanonicalQuery(input.query || {});
  var signedHeaders = 'content-type;host;x-content-sha256;x-date';
  var canonicalHeaders =
    'content-type:' + contentType + '\n' +
    'host:' + HOST + '\n' +
    'x-content-sha256:' + payloadHash + '\n' +
    'x-date:' + xDate + '\n';
  // 官方 V4 格式：headers 块本身以 \n 结尾，其后还需一个空行再跟 SignedHeaders，
  // 即 "x-date:...\n\ncontent-type;host;..."（两个换行）。用 join 拼接时不要再插入空串元素。
  var canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  var scope = shortDate + '/' + (input.region || REGION_DEFAULT) + '/' + (input.service || SERVICE) + '/request';
  var stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n');

  var kDate = hmacSha256(input.sk, shortDate);
  var kRegion = hmacSha256(kDate, input.region || REGION_DEFAULT);
  var kService = hmacSha256(kRegion, input.service || SERVICE);
  var kSigning = hmacSha256(kService, 'request');
  var signature = hmacSha256(kSigning, stringToSign).toString('hex');

  var authorization =
    'HMAC-SHA256 Credential=' + input.ak + '/' + scope +
    ', SignedHeaders=' + signedHeaders +
    ', Signature=' + signature;

  return {
    headers: {
      Host: HOST,
      'Content-Type': contentType,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: authorization
    },
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signature: signature
  };
}

/** 默认 HTTP 请求器：POST JSON 到火山视觉接口，永不打印请求内容 */
function defaultRequestFn(options) {
  return new Promise(function (resolve, reject) {
    var body = options.body || Buffer.alloc(0);
    var headers = Object.assign(
      { 'Content-Length': body.length },
      options.headers || {}
    );
    var req = https.request(
      {
        hostname: HOST,
        port: 443,
        path: options.path,
        method: 'POST',
        headers: headers
      },
      function (res) {
        var chunks = [];
        res.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, text: text, json: json });
        });
      }
    );
    req.setTimeout(options.timeoutMs || DEFAULT_TIMEOUT_MS, function () {
      req.destroy(new Error('volcengine http timeout'));
    });
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}

/** 下载 URL 到 Buffer，最多跟随 3 次 302/301 */
function defaultFetchFn(targetUrl, timeoutMs) {
  return new Promise(function (resolve, reject) {
    function attempt(currentUrl, redirectsLeft) {
      var parsed = urlmod.parse(currentUrl);
      var lib = parsed.protocol === 'http:' ? http : https;
      var req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.path,
          method: 'GET'
        },
        function (res) {
          var status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            var next = urlmod.resolve(currentUrl, res.headers.location);
            attempt(next, redirectsLeft - 1);
            return;
          }
          var chunks = [];
          res.on('data', function (chunk) {
            chunks.push(chunk);
          });
          res.on('end', function () {
            if (status < 200 || status >= 300) {
              reject(new Error('volcengine result download http ' + status));
              return;
            }
            resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' });
          });
        }
      );
      req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, function () {
        req.destroy(new Error('volcengine result download timeout'));
      });
      req.on('error', reject);
      req.end();
    }
    attempt(targetUrl, MAX_REDIRECTS);
  });
}

/** 默认 ping：仅验证 Endpoint 网络可达（不带凭证、不发业务请求、不计费） */
function defaultPingFn(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var req = https.request(
      { hostname: HOST, port: 443, path: '/', method: 'GET' },
      function (res) {
        res.resume();
        resolve({ ok: true, statusCode: res.statusCode });
      }
    );
    req.setTimeout(timeoutMs || PING_TIMEOUT_MS, function () {
      req.destroy(new Error('volcengine ping timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 解析图片尺寸：PNG IHDR 优先；JPEG 扫描 SOF 段 */
function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return {};
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    var offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      var marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
          format: 'jpeg'
        };
      }
      var length = buffer.readUInt16BE(offset + 2);
      if (!length || length < 2) break;
      offset += 2 + length;
    }
  }
  return {};
}

function toBusinessError(json, statusCode, fallbackMessage) {
  var code = json && (json.code !== undefined ? json.code : json.status);
  return {
    errorCode: code !== undefined ? code : statusCode,
    errorMessage: (json && (json.message || json.msg)) || fallbackMessage || 'volcengine request failed',
    httpStatus: statusCode
  };
}

/**
 * 创建真实 transport。
 * @param {object} env 环境变量来源（生产 process.env）
 * @param {object} [options] 测试注入：{now, timeoutMs, requestFn, fetchFn, pingFn}
 */
function createVolcengineHttpTransport(env, options) {
  env = env || {};
  options = options || {};
  var ak = env.SINN_VOLC_AK || '';
  var sk = env.SINN_VOLC_SK || '';
  var region = env.SINN_VOLC_REGION || REGION_DEFAULT;
  var timeoutMs = Number(env.SINN_VOLC_TIMEOUT_MS) || Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  var now = options.now || function () {
    return new Date();
  };
  var requestFn = options.requestFn || defaultRequestFn;
  var fetchFn = options.fetchFn || defaultFetchFn;
  var pingFn = options.pingFn || defaultPingFn;
  var logger = options.logger || console;
  var calls = { submit: 0, query: 0, fetchResult: 0, ping: 0 };

  // 只记录可暴露的元数据（动作/尺寸/任务号/结果图 SHA/耗时），绝不记录 AK/SK、请求体、base64。
  function safeLog(record) {
    try {
      if (logger && typeof logger.log === 'function') {
        logger.log('[sinn/vendor] volcengine ' + JSON.stringify(record));
      }
    } catch (ignored) {
      // 日志失败不影响主流程
    }
  }

  function resultImageSha256(buffer) {
    try {
      return sha256Hex(buffer).slice(0, 16);
    } catch (ignored) {
      return null;
    }
  }

  function postAction(action, body, extraHeaders) {
    var startedAt = Date.now();
    var bodyText = JSON.stringify(body);
    var bodyBuffer = Buffer.from(bodyText, 'utf8');
    var xDate = formatXDate(now());
    var signed = buildV4SignedHeaders({
      ak: ak,
      sk: sk,
      region: region,
      service: SERVICE,
      xDate: xDate,
      method: 'POST',
      path: PATH,
      query: { Action: action, Version: API_VERSION },
      body: bodyBuffer,
      contentType: 'application/json'
    });
    var headers = Object.assign({}, signed.headers, extraHeaders || {});
    return requestFn({
      url: 'https://' + HOST + PATH + '?Action=' + encodeRfc3986(action) + '&Version=' + encodeRfc3986(API_VERSION),
      path: PATH + '?Action=' + encodeRfc3986(action) + '&Version=' + encodeRfc3986(API_VERSION),
      method: 'POST',
      headers: headers,
      body: bodyBuffer,
      timeoutMs: timeoutMs
    }).then(function (res) {
      var json = res && res.json;
      if (!json) {
        return {
          errorCode: 'invalid_response',
          errorMessage: 'volcengine response is not valid json',
          httpStatus: res && res.statusCode
        };
      }
      if (json.code !== 10000) {
        safeLog({
          operation: action,
          ok: false,
          vendorCode: json.code === undefined ? null : json.code,
          httpStatus: res && res.statusCode,
          elapsedMs: Date.now() - startedAt
        });
        return toBusinessError(json, res && res.statusCode, 'volcengine business error');
      }
      return { ok: true, json: json, statusCode: res && res.statusCode };
    }).catch(function () {
      safeLog({
        operation: action,
        ok: false,
        errorCode: 'network_error',
        elapsedMs: Date.now() - startedAt
      });
      // 网络层失败（DNS/连接/超时/证书）不把异常抛给业务层；错误信息不含密钥与请求体。
      return {
        errorCode: 'network_error',
        errorMessage: 'volcengine request failed (network)',
        httpStatus: 0
      };
    });
  }

  function submit(payload) {
    calls.submit += 1;
    payload = payload || {};
    var persons = Array.isArray(payload.personBuffers) ? payload.personBuffers.filter(Buffer.isBuffer) : [];
    var garment = Buffer.isBuffer(payload.garmentBuffer) ? payload.garmentBuffer : null;
    if (!persons.length || !garment) {
      return Promise.resolve({
        errorCode: 'missing_image_input',
        errorMessage: 'volcengine submit requires person and garment image buffers',
        httpStatus: 0
      });
    }
    var person = persons[0]; // V2 模特图仅 1 张；多张时取第一张（端上 1–3 张只用于预检展示）
    if (person.length >= MAX_INPUT_BYTES || garment.length >= MAX_INPUT_BYTES) {
      return Promise.resolve({
        errorCode: 'input_image_too_large',
        errorMessage: 'image must be smaller than 5MB per volcengine image-change V2 limit',
        httpStatus: 0
      });
    }
    var body = {
      req_key: REQ_KEY,
      req_image_store_type: 0,
      binary_data_base64: [person.toString('base64'), garment.toString('base64')],
      garment: { data: [{ type: 'upper' }] }
    };
    var startedAt = Date.now();
    // 调用前打印可公开的参数元数据（不含 AK/SK、不含 base64、不含图片字节）。
    safeLog({
      operation: 'submit',
      phase: 'request',
      action: ACTION_SUBMIT,
      apiVersion: API_VERSION,
      region: region,
      reqKey: REQ_KEY,
      imageStoreType: 0,
      personCount: persons.length,
      personBytes: person.length,
      garmentBytes: garment.length,
      garmentType: 'upper'
    });
    return postAction(ACTION_SUBMIT, body).then(function (result) {
      if (!result.ok) return result;
      var data = result.json.data || {};
      if (!data.task_id) {
        return {
          errorCode: 'invalid_response',
          errorMessage: 'volcengine submit response missing data.task_id',
          httpStatus: result.statusCode
        };
      }
      var taskId = String(data.task_id);
      var requestId = result.json.request_id || null;
      safeLog({
        operation: 'submit',
        phase: 'response',
        ok: true,
        taskId: taskId,
        requestId: requestId,
        elapsedMs: Date.now() - startedAt
      });
      return { taskId: taskId, requestId: requestId };
    });
  }

  function query(payload) {
    calls.query += 1;
    var vendorTaskId = payload && payload.vendorTaskId ? String(payload.vendorTaskId) : '';
    if (!vendorTaskId) {
      return Promise.resolve({
        errorCode: 'missing_task_id',
        errorMessage: 'volcengine query requires vendorTaskId',
        httpStatus: 0
      });
    }
    var body = {
      req_key: REQ_KEY,
      task_id: vendorTaskId,
      req_json: JSON.stringify({ return_url: true })
    };
    var startedAt = Date.now();
    function finish(outcome) {
      safeLog({
        operation: 'query',
        phase: 'response',
        status: outcome && outcome.status ? outcome.status : null,
        errorCode: (outcome && outcome.errorCode) || null,
        elapsedMs: Date.now() - startedAt
      });
      return outcome;
    }
    return postAction(ACTION_QUERY, body).then(function (result) {
      if (!result.ok) return result;
      var data = result.json.data || {};
      var status = String(data.status || '');
      if (status === 'in_queue') return finish({ status: 'pending' });
      if (status === 'generating') return finish({ status: 'running' });
      if (status === 'done') {
        var urls = Array.isArray(data.image_urls) ? data.image_urls : [];
        if (urls.length) return finish({ status: 'success', resultUrl: String(urls[0]) });
        var b64 = Array.isArray(data.binary_data_base64) ? data.binary_data_base64 : [];
        if (b64.length) {
          return finish({ status: 'success', imageBuffer: Buffer.from(String(b64[0]), 'base64') });
        }
        return finish({
          errorCode: 'invalid_response',
          errorMessage: 'volcengine done response has neither image_urls nor binary_data_base64',
          httpStatus: result.statusCode
        });
      }
      if (status === 'not_found' || status === 'expired') {
        return finish({
          errorCode: status,
          errorMessage: 'volcengine task ' + status,
          httpStatus: result.statusCode
        });
      }
      return finish({
        errorCode: 'unknown_status',
        errorMessage: 'volcengine unknown task status: ' + status,
        httpStatus: result.statusCode
      });
    });
  }

  function fetchResult(payload) {
    calls.fetchResult += 1;
    var target = payload && payload.url ? String(payload.url) : '';
    if (!target) {
      return Promise.resolve({
        errorCode: 'missing_result_url',
        errorMessage: 'volcengine fetchResult requires url',
        httpStatus: 0
      });
    }
    var startedAt = Date.now();
    return fetchFn(target, timeoutMs).then(function (res) {
      var buffer = res && res.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        safeLog({ operation: 'fetchResult', ok: false, errorCode: 'empty_result_image', elapsedMs: Date.now() - startedAt });
        return {
          errorCode: 'empty_result_image',
          errorMessage: 'volcengine result image is empty',
          httpStatus: res && res.statusCode
        };
      }
      var size = imageSize(buffer);
      safeLog({
        operation: 'fetchResult',
        ok: true,
        bytes: buffer.length,
        sha256_16: resultImageSha256(buffer),
        width: size.width || null,
        height: size.height || null,
        format: size.format || null,
        elapsedMs: Date.now() - startedAt
      });
      return {
        buffer: buffer,
        width: size.width,
        height: size.height,
        format: size.format || null,
        contentType: res.contentType || '',
        bytes: buffer.length
      };
    }).catch(function () {
      safeLog({ operation: 'fetchResult', ok: false, errorCode: 'fetch_failed', elapsedMs: Date.now() - startedAt });
      return {
        errorCode: 'fetch_failed',
        errorMessage: 'volcengine result download failed',
        httpStatus: 0
      };
    });
  }

  function ping() {
    calls.ping += 1;
    var startedAt = Date.now();
    var timeout = Math.min(timeoutMs, PING_TIMEOUT_MS);
    return Promise.resolve()
      .then(function () {
        return pingFn(timeout);
      })
      .then(function (res) {
        return { ok: !!(res && res.ok), latencyMs: Date.now() - startedAt, statusCode: res && res.statusCode };
      })
      .catch(function () {
        return { ok: false, latencyMs: Date.now() - startedAt, statusCode: 0 };
      });
  }

  return {
    configured: !!(ak && sk),
    region: region,
    submit: submit,
    query: query,
    fetchResult: fetchResult,
    ping: ping,
    __calls: function () {
      return Object.assign({}, calls);
    }
  };
}

module.exports = {
  HOST: HOST,
  SERVICE: SERVICE,
  API_VERSION: API_VERSION,
  REGION_DEFAULT: REGION_DEFAULT,
  REQ_KEY: REQ_KEY,
  ACTION_SUBMIT: ACTION_SUBMIT,
  ACTION_QUERY: ACTION_QUERY,
  MAX_INPUT_BYTES: MAX_INPUT_BYTES,
  encodeRfc3986: encodeRfc3986,
  formatXDate: formatXDate,
  buildCanonicalQuery: buildCanonicalQuery,
  buildV4SignedHeaders: buildV4SignedHeaders,
  imageSize: imageSize,
  createVolcengineHttpTransport: createVolcengineHttpTransport
};
