'use strict';
// 生成托盘图标 tray-icon.png 与应用图标 icon.ico（纯代码绘制，无外部资源）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) | 0;
  }
  return (~crc) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
const BLUE = [58, 111, 242, 255], WHITE = [255, 255, 255, 255];
function render(size) {
  const rgba = Buffer.alloc(size * size * 4); // 透明
  const s = size / 32;
  function px(x, y, c) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
  }
  function fillRect(x0, y0, x1, y1, c) {
    for (let y = Math.round(y0); y <= Math.round(y1); y++)
      for (let x = Math.round(x0); x <= Math.round(x1); x++) px(x, y, c);
  }
  function inRoundRect(x, y, rx0, ry0, rx1, ry1, r) {
    if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
    const cx = Math.max(rx0 + r, Math.min(x, rx1 - r));
    const cy = Math.max(ry0 + r, Math.min(y, ry1 - r));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }
  function roundRect(x0, y0, x1, y1, rIn, c) {
    const x0s = x0 * s, y0s = y0 * s, x1s = x1 * s, y1s = y1 * s, rs = rIn * s;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (inRoundRect(x, y, x0s, y0s, x1s, y1s, rs)) px(x, y, c);
  }
  // 蓝色圆角底板
  roundRect(2, 2, 30, 30, 7, BLUE);
  // 白色打印机机身
  roundRect(6, 10, 26, 25, 3, WHITE);
  // 出纸处顶部纸张
  roundRect(12, 4, 20, 10, 1, WHITE);
  // 机身内纸张槽（露出底板蓝色）
  roundRect(9, 13, 23, 20, 2, BLUE);
  return rgba;
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'tray-icon.png'), encodePNG(32, render(32)));
fs.writeFileSync(path.join(dir, 'icon.png'), encodePNG(256, render(256)));

// icon.ico = ICONDIR + 单个 256x256 PNG 条目
const png = fs.readFileSync(path.join(dir, 'icon.png'));
const icondir = Buffer.alloc(6); icondir.writeUInt16LE(1, 2); icondir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0;      // 宽/高，0 = 256
entry[2] = 0; entry[3] = 0;      // 调色板计数、保留
entry.writeUInt16LE(1, 4);       // 平面数
entry.writeUInt16LE(32, 6);      // 位深
entry.writeUInt32LE(png.length, 8); // 字节数
entry.writeUInt32LE(22, 12);     // 数据偏移
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([icondir, entry, png]));
console.log('已生成: tray-icon.png / icon.png / icon.ico');