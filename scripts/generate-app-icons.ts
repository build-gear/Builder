#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  ensureGeneratedRepoDirectory,
  prepareGeneratedRepoDirectory,
  readCheckedBinaryFile,
  repoRelativePath,
  safeErrorMessage,
  removeGeneratedRepoDirectory,
  removeGeneratedRepoFile,
  writeGeneratedRepoBinaryFile
} from "./script-file-safety.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsRelativeDir = "apps/desktop/src-tauri/icons";
const iconsDir = path.join(rootDir, iconsRelativeDir);

function main() {
  try {
    ensureGeneratedRepoDirectory(rootDir, iconsRelativeDir, "icons directory");

    const pngs = new Map<number, Buffer>();
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      pngs.set(size, encodePng(size, size, drawIcon(size)));
    }

    writePng("32x32.png", pngs.get(32));
    writePng("128x128.png", pngs.get(128));
    writePng("128x128@2x.png", pngs.get(256));
    writePng("icon.png", pngs.get(1024));
    writeGeneratedRepoBinaryFile(rootDir, `${iconsRelativeDir}/icon.ico`, encodeIco([
      pngs.get(32),
      pngs.get(128),
      pngs.get(256)
    ]), "ICO icon");
    writeIcns(pngs);

    const iconHash = createHash("sha256").update(pngs.get(1024) ?? Buffer.alloc(0)).digest("hex");
    console.log(`Generated Builder Gear app icons in ${repoRelativePath(rootDir, iconsDir)}`);
    console.log(`Source icon sha256 ${iconHash}`);
  } catch (error) {
    console.error(`icons: ${safeErrorMessage(rootDir, error)}`);
    process.exitCode = 1;
  }
}

function writePng(fileName: string, buffer: Buffer | undefined) {
  if (!buffer) {
    throw new Error(`missing generated PNG for ${fileName}`);
  }

  writeGeneratedRepoBinaryFile(rootDir, `${iconsRelativeDir}/${fileName}`, buffer, `PNG icon ${fileName}`);
}

function writeIcns(pngs: Map<number, Buffer>) {
  const iconsetRelativeDir = `${iconsRelativeDir}/builder-gear.iconset`;
  const iconsetDir = prepareGeneratedRepoDirectory(rootDir, iconsetRelativeDir, "temporary iconset directory");

  const iconsetFiles: Array<[string, number]> = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
  ];

  for (const [fileName, size] of iconsetFiles) {
    const buffer = pngs.get(size);
    if (!buffer) {
      throw new Error(`missing generated PNG for ${fileName}`);
    }
    writeGeneratedRepoBinaryFile(rootDir, `${iconsetRelativeDir}/${fileName}`, buffer, `iconset PNG ${fileName}`);
  }

  const outputRelativePath = `${iconsRelativeDir}/icon.icns`;
  const tempOutputRelativePath = `${iconsRelativeDir}/icon.${process.pid}.${Date.now()}.tmp.icns`;
  const tempOutputPath = path.join(rootDir, tempOutputRelativePath);
  const result = spawnSync("iconutil", ["-c", "icns", "-o", tempOutputPath, iconsetDir], {
    cwd: iconsDir,
    encoding: "utf8"
  });

  let cleanupError: unknown;
  try {
    removeGeneratedRepoDirectory(rootDir, iconsetRelativeDir, "temporary iconset directory");
  } catch (error) {
    cleanupError = error;
  }

  if (result.status !== 0) {
    removeGeneratedRepoFile(rootDir, tempOutputRelativePath, "temporary ICNS icon");
    throw new Error(`iconutil failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  if (cleanupError) {
    removeGeneratedRepoFile(rootDir, tempOutputRelativePath, "temporary ICNS icon");
    throw cleanupError;
  }

  try {
    const icns = readCheckedBinaryFile(tempOutputPath, "temporary ICNS icon", 16 * 1024 * 1024);
    writeGeneratedRepoBinaryFile(rootDir, outputRelativePath, icns, "ICNS icon");
  } finally {
    removeGeneratedRepoFile(rootDir, tempOutputRelativePath, "temporary ICNS icon");
  }
}

function drawIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.215;
  const inset = size * 0.055;
  const innerInset = size * 0.19;
  const innerRadius = size * 0.09;
  const center = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = roundedRectContains(x + 0.5, y + 0.5, inset, inset, size - inset * 2, size - inset * 2, radius);

      if (!inside) {
        pixels[offset + 3] = 0;
        continue;
      }

      const nx = x / Math.max(1, size - 1);
      const ny = y / Math.max(1, size - 1);
      const diagonal = Math.max(0, 1 - Math.abs((nx - ny) * 1.35));
      const cornerGlow = Math.max(0, 1 - distance(nx, ny, 0.28, 0.2) * 2.9);
      const bottomGlow = Math.max(0, 1 - distance(nx, ny, 0.74, 0.83) * 3.2);
      const shade = Math.max(0, 1 - ny * 0.65);

      setPixel(pixels, offset, {
        r: 9 + shade * 22 + cornerGlow * 42,
        g: 13 + shade * 24 + diagonal * 22 + cornerGlow * 84 + bottomGlow * 18,
        b: 18 + shade * 28 + diagonal * 38 + bottomGlow * 68,
        a: 255
      });
    }
  }

  drawGrid(pixels, size, inset, radius);
  fillRoundedRect(pixels, size, innerInset, innerInset, size - innerInset * 2, size - innerInset * 2, innerRadius, { r: 13, g: 18, b: 22, a: 218 });
  strokeRoundedRect(pixels, size, innerInset, innerInset, size - innerInset * 2, size - innerInset * 2, innerRadius, size * 0.018, { r: 149, g: 230, b: 187, a: 210 });
  strokeRoundedRect(pixels, size, inset, inset, size - inset * 2, size - inset * 2, radius, size * 0.012, { r: 255, g: 255, b: 255, a: 62 });

  const chipInset = size * 0.27;
  const chipSize = size - chipInset * 2;
  drawCircuitPins(pixels, size, chipInset, chipInset, chipSize, chipSize);
  drawPromptMark(pixels, size, center, center);
  drawNode(pixels, size, size * 0.73, size * 0.28, size * 0.028, { r: 185, g: 167, b: 255, a: 230 });
  drawNode(pixels, size, size * 0.27, size * 0.72, size * 0.024, { r: 149, g: 230, b: 187, a: 230 });

  return pixels;
}

function drawGrid(pixels: Uint8Array, size: number, inset: number, radius: number) {
  const spacing = Math.max(8, Math.round(size / 8));
  const lineWidth = Math.max(1, Math.round(size / 180));
  const rectSize = size - inset * 2;

  for (let y = Math.round(inset + spacing); y < size - inset; y += spacing) {
    fillRectMasked(pixels, size, inset, y, rectSize, lineWidth, inset, radius, { r: 255, g: 255, b: 255, a: 18 });
  }

  for (let x = Math.round(inset + spacing); x < size - inset; x += spacing) {
    fillRectMasked(pixels, size, x, inset, lineWidth, rectSize, inset, radius, { r: 255, g: 255, b: 255, a: 16 });
  }
}

function drawCircuitPins(pixels: Uint8Array, size: number, x: number, y: number, width: number, height: number) {
  const pin = Math.max(1, Math.round(size * 0.018));
  const gap = height / 5;
  const color = { r: 149, g: 230, b: 187, a: 185 };

  for (let index = 1; index <= 4; index += 1) {
    const py = y + gap * index;
    fillRect(pixels, size, x - pin * 2.4, py - pin / 2, pin * 2.4, pin, color);
    fillRect(pixels, size, x + width, py - pin / 2, pin * 2.4, pin, color);
  }

  for (let index = 1; index <= 4; index += 1) {
    const px = x + gap * index;
    fillRect(pixels, size, px - pin / 2, y - pin * 2.4, pin, pin * 2.4, color);
    fillRect(pixels, size, px - pin / 2, y + height, pin, pin * 2.4, color);
  }
}

function drawPromptMark(pixels: Uint8Array, size: number, cx: number, cy: number) {
  const stroke = Math.max(3, size * 0.055);
  const left = cx - size * 0.14;
  const right = cx + size * 0.045;
  const top = cy - size * 0.13;
  const bottom = cy + size * 0.13;
  const baselineY = cy + size * 0.155;
  const baselineStart = cx + size * 0.04;
  const baselineEnd = cx + size * 0.18;
  const mint = { r: 207, g: 252, b: 224, a: 248 };
  const violet = { r: 185, g: 167, b: 255, a: 225 };

  drawThickLine(pixels, size, left, top, right, cy, stroke, mint);
  drawThickLine(pixels, size, right, cy, left, bottom, stroke, mint);
  drawThickLine(pixels, size, baselineStart, baselineY, baselineEnd, baselineY, stroke * 0.85, violet);
}

function fillRoundedRect(pixels: Uint8Array, size: number, x: number, y: number, width: number, height: number, radius: number, color: Rgba) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(size, Math.ceil(x + width));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(size, Math.ceil(y + height));

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      if (roundedRectContains(px + 0.5, py + 0.5, x, y, width, height, radius)) {
        blendPixel(pixels, (py * size + px) * 4, color);
      }
    }
  }
}

function strokeRoundedRect(pixels: Uint8Array, size: number, x: number, y: number, width: number, height: number, radius: number, stroke: number, color: Rgba) {
  const minX = Math.max(0, Math.floor(x - stroke));
  const maxX = Math.min(size, Math.ceil(x + width + stroke));
  const minY = Math.max(0, Math.floor(y - stroke));
  const maxY = Math.min(size, Math.ceil(y + height + stroke));

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const centerX = px + 0.5;
      const centerY = py + 0.5;
      const outer = roundedRectContains(centerX, centerY, x, y, width, height, radius);
      const inner = roundedRectContains(centerX, centerY, x + stroke, y + stroke, width - stroke * 2, height - stroke * 2, Math.max(0, radius - stroke));

      if (outer && !inner) {
        blendPixel(pixels, (py * size + px) * 4, color);
      }
    }
  }
}

function fillRectMasked(pixels: Uint8Array, size: number, x: number, y: number, width: number, height: number, maskInset: number, maskRadius: number, color: Rgba) {
  const maxRect = size - maskInset * 2;
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(size, Math.ceil(y + height)); py += 1) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(size, Math.ceil(x + width)); px += 1) {
      if (roundedRectContains(px + 0.5, py + 0.5, maskInset, maskInset, maxRect, maxRect, maskRadius)) {
        blendPixel(pixels, (py * size + px) * 4, color);
      }
    }
  }
}

function fillRect(pixels: Uint8Array, size: number, x: number, y: number, width: number, height: number, color: Rgba) {
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(size, Math.ceil(y + height)); py += 1) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(size, Math.ceil(x + width)); px += 1) {
      blendPixel(pixels, (py * size + px) * 4, color);
    }
  }
}

function drawNode(pixels: Uint8Array, size: number, cx: number, cy: number, radius: number, color: Rgba) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(size, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(size, Math.ceil(cy + radius));

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      if (distance(x + 0.5, y + 0.5, cx, cy) <= radius) {
        blendPixel(pixels, (y * size + x) * 4, color);
      }
    }
  }
}

function drawThickLine(pixels: Uint8Array, size: number, x1: number, y1: number, x2: number, y2: number, width: number, color: Rgba) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - width));
  const maxX = Math.min(size, Math.ceil(Math.max(x1, x2) + width));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - width));
  const maxY = Math.min(size, Math.ceil(Math.max(y1, y2) + width));
  const radius = width / 2;

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2) <= radius) {
        blendPixel(pixels, (y * size + x) * 4, color);
      }
    }
  }
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function encodeIco(images: Array<Buffer | undefined>): Buffer {
  const buffers = images.filter((image): image is Buffer => Boolean(image));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(buffers.length, 4);

  let offset = 6 + buffers.length * 16;
  const entries: Buffer[] = [];

  for (const image of buffers) {
    const { width, height } = pngSize(image);
    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;
    entry[1] = height >= 256 ? 0 : height;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...buffers]);
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function roundedRectContains(px: number, py: number, x: number, y: number, width: number, height: number, radius: number): boolean {
  const clampedX = Math.max(x + radius, Math.min(px, x + width - radius));
  const clampedY = Math.max(y + radius, Math.min(py, y + height - radius));
  return distance(px, py, clampedX, clampedY) <= radius;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return distance(px, py, x1 + t * dx, y1 + t * dy);
}

function setPixel(pixels: Uint8Array, offset: number, color: Rgba) {
  pixels[offset] = clamp(color.r);
  pixels[offset + 1] = clamp(color.g);
  pixels[offset + 2] = clamp(color.b);
  pixels[offset + 3] = clamp(color.a);
}

function blendPixel(pixels: Uint8Array, offset: number, color: Rgba) {
  const alpha = clamp(color.a) / 255;
  const existingAlpha = (pixels[offset + 3] ?? 0) / 255;
  const outputAlpha = alpha + existingAlpha * (1 - alpha);

  if (outputAlpha <= 0) {
    return;
  }

  pixels[offset] = clamp(((color.r * alpha) + ((pixels[offset] ?? 0) * existingAlpha * (1 - alpha))) / outputAlpha);
  pixels[offset + 1] = clamp(((color.g * alpha) + ((pixels[offset + 1] ?? 0) * existingAlpha * (1 - alpha))) / outputAlpha);
  pixels[offset + 2] = clamp(((color.b * alpha) + ((pixels[offset + 2] ?? 0) * existingAlpha * (1 - alpha))) / outputAlpha);
  pixels[offset + 3] = clamp(outputAlpha * 255);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

main();
