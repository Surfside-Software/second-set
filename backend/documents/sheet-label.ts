import type { Region } from "#lib/review/contracts.ts";

/** Text positions from PDF.js, kept separate from confirmed engineering labels. */
export interface SheetText {
  /** Extracted text in its original reading order. */
  readonly text: string;
  /** PDF text origin. */
  readonly x: number;
  /** PDF text origin. */
  readonly y: number;
}

/**
 * Where a PDF point appears on the displayed sheet, as fractions from its left and top edges.
 * `/Rotate` turns the displayed page clockwise, as PDF.js viewports do.
 */
function viewedPosition(item: SheetText, box: Region, rotation: 0 | 90 | 180 | 270) {
  const across = (item.x - box.x) / box.width;
  const up = (item.y - box.y) / box.height;

  if (rotation === 90) return { left: up, top: across };

  if (rotation === 180) return { left: 1 - across, top: up };

  if (rotation === 270) return { left: 1 - up, top: 1 - across };

  return { left: across, top: 1 - up };
}

/** Prefer an embedded label or an unambiguous printed title-block identity; never confirms it. */
export function suggestedSheetLabel(
  pageIndex: number,
  embeddedLabel: string | null,
  text: ReadonlyArray<SheetText>,
  box: Region,
  rotation: 0 | 90 | 180 | 270 = 0,
): string {
  const page = `Page ${pageIndex + 1}`;

  if (embeddedLabel?.trim() && !/^\d+$/.test(embeddedLabel.trim()))
    return `${embeddedLabel.trim().slice(0, 130)} · ${page}`;

  const candidates = new Map<string, string>();

  for (const item of text) {
    const value = item.text.trim();

    const titled = /^([A-Z]{1,3}(?:[-.]\d{1,3}|\d{2,3})(?:\.\d{1,2})?)\s*\|\s*(.{3,110})$/.exec(
      value,
    );

    if (titled?.[1] && titled[2]) {
      const code = titled[1];

      if (!candidates.has(code)) candidates.set(code, `${code} · ${titled[2].trim()}`);
      continue;
    }

    // The title block is the bottom-right corner of the sheet as displayed.
    const viewed = viewedPosition(item, box, rotation);
    const inTitleBlock = viewed.left >= 0.75 && viewed.top >= 0.7;

    if (inTitleBlock && /^[A-Z]{1,3}(?:[-.]\d{1,3}|\d{2,3})(?:\.\d{1,2})?$/.test(value))
      candidates.set(value, candidates.get(value) ?? value);
  }

  const proposed = candidates.size === 1 ? candidates.values().next().value : undefined;

  return proposed ? `${proposed.slice(0, 140)} · ${page}` : page;
}
