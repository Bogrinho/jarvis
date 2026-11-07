import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function png(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const radius = Math.hypot(dx, dy);
      const glow = Math.exp(-Math.pow(radius / 0.65, 4) * 1.5);
      const ring = Math.exp(-Math.pow((radius - 0.53) / 0.045, 2));
      const core = Math.exp(-Math.pow(radius / 0.35, 2));
      const alpha = Math.min(1, glow * 0.85 + ring * 0.8);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels[offset] = Math.min(255, 8 + core * 100 + ring * 125);
      pixels[offset + 1] = Math.min(255, 105 + core * 125 + ring * 100);
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 32, 48, 256];
const images = sizes.map(png);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  directory[entry] = sizes[i] % 256;
  directory[entry + 1] = sizes[i] % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[i].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
fs.writeFileSync(path.join(publicDir, 'jarvis.ico'), Buffer.concat([directory, ...images]));
for (const size of [192, 512]) fs.writeFileSync(path.join(publicDir, `jarvis-${size}.png`), png(size));
