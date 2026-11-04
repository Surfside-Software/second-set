import { Schema } from "effect";
import { Affine, Region, ReviewInputError } from "#lib/review/contracts.ts";

/** Apply a PDF-to-pixel or pixel-to-PDF affine transform to one source point. */
export function transformPoint(transform: typeof Affine.Type, x: number, y: number) {
  const [a, b, c, d, e, f] = transform;

  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Invert a nondegenerate coordinate map; invalid maps cannot become evidence. */
export function invertTransform(transform: typeof Affine.Type) {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;

  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return new ReviewInputError({ message: "The source transform cannot be inverted." });
  }

  return Schema.decodeUnknownSync(Affine)([
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]);
}

/** A requested region must fit inside its source page, including a nonzero page origin. */
export function containsRegion(page: Region, region: Region) {
  return (
    region.x >= page.x &&
    region.y >= page.y &&
    region.x + region.width <= page.x + page.width &&
    region.y + region.height <= page.y + page.height
  );
}

/** Moke delivers source images to models at most 2,048 pixels on either side. */
export const modelImageLimit = 2048;

/** The pixel size Moke delivers to a model for a rendered artifact of this size. */
export function deliveredImageSize(width: number, height: number) {
  const scale = Math.min(1, modelImageLimit / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A pixel box in a delivered image, with a top-left origin. */
export interface ImageBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Map a box drawn on the image a model received back to PDF points through the artifact's
 * stored pixel transform, so models never convert coordinates themselves.
 */
export function deliveredBoxToPdf(
  artifact: {
    readonly width: number;
    readonly height: number;
    readonly pixelsToPdf: typeof Affine.Type;
  },
  box: ImageBox,
) {
  const delivered = deliveredImageSize(artifact.width, artifact.height);

  if (
    !(
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= delivered.width &&
      box.bottom <= delivered.height
    ) ||
    box.right <= box.left ||
    box.bottom <= box.top
  )
    return new ReviewInputError({
      message: `The image box must lie inside the delivered ${delivered.width}×${delivered.height}-pixel image, with right greater than left and bottom greater than top.`,
    });

  const sx = artifact.width / delivered.width;
  const sy = artifact.height / delivered.height;

  return transformRegion(
    artifact.pixelsToPdf,
    new Region({
      x: box.left * sx,
      y: box.top * sy,
      width: (box.right - box.left) * sx,
      height: (box.bottom - box.top) * sy,
    }),
  );
}

/** Map all four corners, retaining a useful enclosing rectangle after rotation. */
export function transformRegion(transform: typeof Affine.Type, region: Region) {
  const corners = [
    transformPoint(transform, region.x, region.y),
    transformPoint(transform, region.x + region.width, region.y),
    transformPoint(transform, region.x, region.y + region.height),
    transformPoint(transform, region.x + region.width, region.y + region.height),
  ];

  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return new Region({
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  });
}
