import { deliveredImageSize } from "#lib/review/geometry.ts";

/** Largest decoded image Moke sends a model or SAM. */
export const modelImageBytes = 1024 * 1024;

/**
 * Resize a stored PNG to the delivered size. Embedded scans can push a full sheet's PNG past the
 * model limit; with `lossy` such an image becomes JPEG at the same pixel size, so image boxes still
 * convert through the same transform. SAM needs PNG and keeps the limit.
 */
export async function encodeModelImage(bytes: Uint8Array, lossy: boolean) {
  const image = new Bun.Image(bytes);
  const metadata = await image.metadata();
  const { width, height } = deliveredImageSize(metadata.width, metadata.height);
  const png = Buffer.from(await image.resize(width, height).png().toBuffer());

  if (png.byteLength <= modelImageBytes || !lossy)
    return { data: png, width, height, mimeType: "image/png" as const };

  // Step the quality down until the image fits; drawings rarely need the lower steps.
  let jpeg = png;

  for (const quality of [82, 70, 55, 40]) {
    jpeg = Buffer.from(
      await new Bun.Image(bytes).resize(width, height).jpeg({ quality }).toBuffer(),
    );

    if (jpeg.byteLength <= modelImageBytes) break;
  }

  return { data: jpeg, width, height, mimeType: "image/jpeg" as const };
}
