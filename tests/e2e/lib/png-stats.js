'use strict';

/**
 * PNG 像素统计（零依赖）——供 e2e 断言「页面真实绘制」使用。
 *
 * 背景：DEF-0008（Skyline 下 scroll-view 未给高度 → 只布局不绘制、整页仅剩导航栏）在 7 轮
 * e2e 中未被发现，因为 AC-23 只断言路由 / DOM 元素存在；而该缺陷下 DOM 元素仍然存在，
 * **只有像素层面能区分「绘制了」与「白屏」**。因此这里用与 DEV 证据脚本
 * （docs/dev/def-0008-verify.js）相同的口径做统计：
 *   - 每 2px 采样一次；
 *   - 亮度 lum = 0.299R + 0.587G + 0.114B，lum < 160 记为 dark；
 *   - darkRatio = dark / total；
 *   - contentDarkRatio = 仅统计顶部 12% 以下区域（避开导航栏/状态栏）的 dark 占比；
 *   - contentEdgeRatio = 顶部 12% 以下区域中「与右/下相邻采样像素亮度差 > 20」的占比。
 *     白屏/未绘制页面内容区是纯背景色，边缘占比接近 0；有文字/卡片/按钮的页面明显 > 0，
 *     因此它比纯 dark 比例更能区分「元素存在但未绘制」（DEF-0008）与「正常绘制」。
 *
 * 支持 8-bit、非隔行、colorType 0/2/4/6 的 PNG（开发者工具截图实测为 colorType=2 RGB）。
 */

const fs = require('fs');
const zlib = require('zlib');

function decodePng(buf) {
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是合法 PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels || bitDepth !== 8) {
    throw new Error(`不支持的 PNG：colorType=${colorType} bitDepth=${bitDepth}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const lineStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[pos];
      pos += 1;
      const left = x >= channels ? out[lineStart + x - channels] : 0;
      const up = y > 0 ? out[lineStart - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[lineStart - stride + x - channels] : 0;
      let val;
      if (filter === 0) val = rawByte;
      else if (filter === 1) val = (rawByte + left) & 0xff;
      else if (filter === 2) val = (rawByte + up) & 0xff;
      else if (filter === 3) val = (rawByte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        val = (rawByte + pr) & 0xff;
      } else {
        throw new Error('非法 PNG filter：' + filter);
      }
      out[lineStart + x] = val;
    }
  }
  return { width, height, channels, pixels: out };
}

function statsFromBuffer(buf) {
  const img = decodePng(buf);
  const { width, height, channels, pixels } = img;
  const contentTop = Math.floor(height * 0.12);
  let dark = 0;
  let total = 0;
  let darkContent = 0;
  let totalContent = 0;
  let edgeContent = 0;
  function lumAt(x, y) {
    const i = (y * width + x) * channels;
    const r = pixels[i];
    const g = channels >= 3 ? pixels[i + 1] : r;
    const b = channels >= 3 ? pixels[i + 2] : r;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const lum = lumAt(x, y);
      total += 1;
      if (lum < 160) dark += 1;
      if (y >= contentTop) {
        totalContent += 1;
        if (lum < 160) darkContent += 1;
        let isEdge = false;
        if (x + 2 < width && Math.abs(lumAt(x + 2, y) - lum) > 20) isEdge = true;
        if (!isEdge && y + 2 < height && Math.abs(lumAt(x, y + 2) - lum) > 20) isEdge = true;
        if (isEdge) edgeContent += 1;
      }
    }
  }
  return {
    width,
    height,
    darkRatio: Number((dark / total).toFixed(4)),
    contentDarkRatio: Number((darkContent / totalContent).toFixed(4)),
    contentEdgeRatio: Number((edgeContent / totalContent).toFixed(4)),
  };
}

function imageStats(file) {
  const buf = fs.readFileSync(file);
  return Object.assign({ file }, statsFromBuffer(buf));
}

module.exports = { imageStats, statsFromBuffer };
