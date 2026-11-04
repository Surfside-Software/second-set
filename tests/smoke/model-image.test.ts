import { expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { encodeModelImage, modelImageBytes } from "../../backend/review/model-image.ts";

/** A noisy sheet, like an embedded scan, whose PNG exceeds the model limit at delivered size. */
function noisyPng() {
  const canvas = createCanvas(2400, 1800);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(2400, 1800);
  let seed = 7;

  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const value = seed % 256;
    pixels.data.set([value, value, value, 255], index);
  }

  context.putImageData(pixels, 0, 0);

  return new Uint8Array(canvas.toBuffer("image/png"));
}

test("an oversized sheet image reaches the model as JPEG at the same delivered size", async () => {
  const source = noisyPng();
  const png = await encodeModelImage(source, false);
  const jpeg = await encodeModelImage(source, true);

  expect(png).toMatchObject({ mimeType: "image/png", width: 2048, height: 1536 });
  expect(png.data.byteLength).toBeGreaterThan(modelImageBytes);
  expect(jpeg).toMatchObject({ mimeType: "image/jpeg", width: 2048, height: 1536 });
  expect(jpeg.data.byteLength).toBeLessThanOrEqual(modelImageBytes);
});
