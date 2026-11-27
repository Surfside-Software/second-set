import { expect, test } from "bun:test";
import { Region, ReviewInputError } from "#lib/review/contracts.ts";
import {
  containsRegion,
  deliveredBoxToPdf,
  deliveredImageSize,
  invertTransform,
} from "#lib/review/geometry.ts";

test("a box drawn over the whole delivered image of a 100-dpi render stays inside its page", () => {
  // The PDF worker stores the inverse of PDF.js's viewport transform, as here for a 306 × 792 pt page.
  const page = new Region({ x: 0, y: 0, width: 306, height: 792 });
  const scale = 100 / 72;
  const pixelsToPdf = invertTransform([scale, 0, 0, -scale, 0, 792 * scale]);

  if (pixelsToPdf instanceof ReviewInputError) throw new Error(pixelsToPdf.message);
  const artifact = { width: 425, height: 1100, pixelsToPdf };
  const delivered = deliveredImageSize(artifact.width, artifact.height);

  const region = deliveredBoxToPdf(artifact, {
    left: 0,
    top: 0,
    right: delivered.width,
    bottom: delivered.height,
  });

  if (region instanceof ReviewInputError) throw new Error(region.message);
  // The round trip lands a hair past the page edge.
  expect(region.y + region.height).toBeGreaterThan(page.y + page.height);
  expect(containsRegion(page, region)).toBe(true);
});

test("a region past its page by a visible amount is still outside it", () => {
  const page = new Region({ x: 10, y: 20, width: 306, height: 792 });

  expect(containsRegion(page, new Region({ x: 10, y: 20, width: 306.01, height: 792 }))).toBe(
    false,
  );
  expect(containsRegion(page, new Region({ x: 9.99, y: 20, width: 100, height: 100 }))).toBe(false);
  expect(containsRegion(page, new Region({ x: 10, y: 20, width: 306, height: 792 }))).toBe(true);
});

test("an image box on an artifact with no pixel size is an input error, not a thrown defect", () => {
  for (const size of [
    { width: 0, height: 0 },
    { width: 0, height: 1100 },
    { width: 425, height: 0 },
  ]) {
    const result = deliveredBoxToPdf(
      { ...size, pixelsToPdf: [1, 0, 0, 1, 0, 0] },
      { left: 0, top: 0, right: 1, bottom: 1 },
    );

    expect(result).toBeInstanceOf(ReviewInputError);
  }
});
