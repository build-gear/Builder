import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";

interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

test("renders the technical dark command surface instead of a blank shell", async ({ page }) => {
  await openAtViewport(page, { width: 1440, height: 900 });

  const shellStyle = await page.locator(".app-shell").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      gridTemplateColumns: style.gridTemplateColumns
    };
  });
  const promptBox = await page.locator(".prompt-frame").boundingBox();
  const sidebarBox = await page.locator(".sidebar").boundingBox();
  const screenshotStats = imageStats(decodePng(await page.screenshot({ type: "png" })));

  expect(shellStyle.backgroundColor).toBe("rgb(13, 13, 15)");
  expect(shellStyle.backgroundImage).toContain("repeating-linear-gradient");
  expect(shellStyle.gridTemplateColumns).toContain("292px");
  expect(sidebarBox?.width).toBeGreaterThanOrEqual(280);
  expect(sidebarBox?.width).toBeLessThanOrEqual(304);
  expect(promptBox?.width).toBeGreaterThanOrEqual(620);
  expect(promptBox?.width).toBeLessThanOrEqual(840);
  expect(promptBox?.height).toBeGreaterThanOrEqual(160);
  expect(screenshotStats.averageLuminance).toBeGreaterThan(10);
  expect(screenshotStats.averageLuminance).toBeLessThan(72);
  expect(screenshotStats.distinctSampledColors).toBeGreaterThan(34);
  expect(screenshotStats.greenAccentSamples).toBeGreaterThanOrEqual(2);
  expect(screenshotStats.redAccentSamples).toBeGreaterThan(0);
});

test("keeps the technical shell visually usable on mobile", async ({ page }) => {
  await openAtViewport(page, { width: 390, height: 844 });

  const screenshotStats = imageStats(decodePng(await page.screenshot({ type: "png" })));
  const navBox = await page.getByRole("navigation", { name: "Main" }).boundingBox();
  const promptBox = await page.locator(".prompt-frame").boundingBox();

  expect(navBox?.width).toBeLessThanOrEqual(390);
  expect(promptBox?.x).toBeGreaterThanOrEqual(0);
  expect(promptBox!.x + promptBox!.width).toBeLessThanOrEqual(390);
  expect(promptBox?.height).toBeGreaterThanOrEqual(160);
  expect(screenshotStats.averageLuminance).toBeGreaterThan(10);
  expect(screenshotStats.averageLuminance).toBeLessThan(76);
  expect(screenshotStats.distinctSampledColors).toBeGreaterThan(36);
  expect(screenshotStats.greenAccentSamples).toBeGreaterThan(1);
});

async function openAtViewport(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.locator(".prompt-frame")).toBeVisible();
}

function imageStats(image: RgbaImage) {
  let luminanceTotal = 0;
  let sampleCount = 0;
  let greenAccentSamples = 0;
  let redAccentSamples = 0;
  const distinct = new Set<string>();
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 42));

  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      const red = image.pixels[offset] ?? 0;
      const green = image.pixels[offset + 1] ?? 0;
      const blue = image.pixels[offset + 2] ?? 0;

      luminanceTotal += (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
      sampleCount += 1;
      distinct.add(`${Math.floor(red / 12)}:${Math.floor(green / 12)}:${Math.floor(blue / 12)}`);

      if (green > 150 && red > 80 && blue > 100 && green > red && green > blue) {
        greenAccentSamples += 1;
      }

      if (red > 180 && green < 130 && blue < 130) {
        redAccentSamples += 1;
      }
    }
  }

  return {
    averageLuminance: luminanceTotal / sampleCount,
    distinctSampledColors: distinct.size,
    greenAccentSamples,
    redAccentSamples
  };
}

function decodePng(buffer: Buffer): RgbaImage {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error("screenshot is not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      const interlace = data[12] ?? 0;
      if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
        throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    }

    if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    }

    if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (!width || !height || idatChunks.length === 0) {
    throw new Error("PNG is missing IHDR or IDAT data");
  }

  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset] ?? 0;
    sourceOffset += 1;
    const row = Uint8Array.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    unfilterScanline(row, previous, channels, filter);

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = row[source] ?? 0;
      rgba[target + 1] = row[source + 1] ?? 0;
      rgba[target + 2] = row[source + 2] ?? 0;
      rgba[target + 3] = channels === 4 ? row[source + 3] ?? 255 : 255;
    }

    previous = row;
  }

  return { width, height, pixels: rgba };
}

function unfilterScanline(row: Uint8Array, previous: Uint8Array, bytesPerPixel: number, filter: number) {
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;

    switch (filter) {
      case 0:
        break;
      case 1:
        row[index] = (row[index] ?? 0) + left;
        break;
      case 2:
        row[index] = (row[index] ?? 0) + up;
        break;
      case 3:
        row[index] = (row[index] ?? 0) + Math.floor((left + up) / 2);
        break;
      case 4:
        row[index] = (row[index] ?? 0) + paethPredictor(left, up, upLeft);
        break;
      default:
        throw new Error(`unsupported PNG scanline filter: ${filter}`);
    }
  }
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }

  if (upDistance <= upLeftDistance) {
    return up;
  }

  return upLeft;
}
