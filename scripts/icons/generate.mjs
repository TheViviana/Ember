import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

/**
 * 生成应用图标：纯黑底 + 白色 Ember。
 * 只依赖 macOS 自带 swift / iconutil，不引入 npm 依赖。
 * 每个最终文件都重新读回 PNG 校验四角像素，避免出现透明角或非纯黑。
 */

const ROOT = resolve(import.meta.dirname, '../..');
const ICONS = join(ROOT, 'src-tauri/icons');
const SCRIPT = join(import.meta.dirname, 'draw.swift');

/** 读 PNG 并返回尺寸与四角 RGBA：仅支持 8bit RGBA / RGB（swift 与 iconutil 的输出都满足） */
const readPng = (file) => {
  const bytes = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data.readUInt8(9);
      if (data.readUInt8(8) !== 8) throw new Error(`${file}: 仅支持 8bit 通道`);
      if (data.readUInt8(12) !== 0) throw new Error(`${file}: 不支持隔行扫描 PNG`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (width === 0 || height === 0) throw new Error(`${file}: 缺少 IHDR`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`${file}: 不支持的色彩类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      const value = line[x];
      let restored = value;
      if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        restored = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[x] = restored & 0xff;
    }
  }

  const pixel = (x, y) => {
    const base = y * stride + x * channels;
    return [
      pixels[base] ?? 0,
      pixels[base + 1] ?? 0,
      pixels[base + 2] ?? 0,
      channels === 4 ? (pixels[base + 3] ?? 255) : 255,
    ];
  };

  return {
    width,
    height,
    corners: [pixel(0, 0), pixel(width - 1, 0), pixel(0, height - 1), pixel(width - 1, height - 1)],
  };
};

const assertBlackCorners = (file, info) => {
  for (const [r, g, b, a] of info.corners) {
    if (!(r === 0 && g === 0 && b === 0 && a === 255)) {
      throw new Error(`${file}: 角像素不是纯黑不透明，实际 rgba(${r},${g},${b},${a})`);
    }
  }
};

const run = (command, args) => {
  execFileSync(command, args, { stdio: 'inherit' });
};

const main = () => {
  const work = mkdtempSync(join(tmpdir(), 'ember-icon-'));
  try {
    run('swift', [SCRIPT, work]);

    const iconset = join(work, 'icon.iconset');
    mkdirSync(iconset, { recursive: true });

    const entries = [
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ];
    for (const [name, size] of entries) {
      copyFileSync(join(work, `${size}.png`), join(iconset, name));
    }

    const appIcons = [
      ['32x32.png', 32],
      ['64x64.png', 64],
      ['128x128.png', 128],
      ['128x128@2x.png', 256],
      ['icon.png', 1024],
    ];
    for (const [name, size] of appIcons) {
      copyFileSync(join(work, `${size}.png`), join(ICONS, name));
    }

    run('iconutil', ['--convert', 'icns', '--output', join(ICONS, 'icon.icns'), iconset]);

    console.log('尺寸与四角像素清单：');
    for (const [name] of appIcons) {
      const file = join(ICONS, name);
      const info = readPng(file);
      assertBlackCorners(file, info);
      const label = `icons/${name}`.padEnd(18, ' ');
      console.log(
        `  ${label} ${String(info.width).padStart(4)}x${String(info.height).padEnd(5)} 四角 ${info.corners
          .map((corner) => `rgba(${corner.join(',')})`)
          .join(' | ')}`,
      );
    }
    const icns = readFileSync(join(ICONS, 'icon.icns'));
    console.log(`  icons/icon.icns      内含 16~1024 全档，${icns.length} 字节`);
    console.log('结论：所有 png 四角均为 #000000（A=255）');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

main();
