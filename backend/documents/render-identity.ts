import { createHash } from "node:crypto";
import type { Region, Sheet } from "#lib/review/contracts.ts";

/**
 * Rasterizer identity of stored renders. Change it with the pinned PDF.js or canvas version, and
 * with any worker change to the pixels or coordinate maps produced for the same request.
 */
// moke-render-2 decodes embedded images up to maxEmbeddedImagePixels instead of the output limit.
export const pdfRendererVersion = "pdfjs-dist@6.5.438 @napi-rs/canvas@1.1.0 moke-render-2";

/** Exact source and rasterizer inputs that determine a render's pixels and coordinate maps. */
export function renderIdentity(
  originalSha256: string,
  page: Pick<Sheet, "pageIndex" | "rotation" | "userUnit">,
  region: Region,
  effectiveDpi: number,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        renderer: pdfRendererVersion,
        source: originalSha256,
        page: page.pageIndex,
        rotation: page.rotation,
        userUnit: page.userUnit,
        region: [region.x, region.y, region.width, region.height],
        dpi: effectiveDpi,
      }),
    )
    .digest("hex");
}
