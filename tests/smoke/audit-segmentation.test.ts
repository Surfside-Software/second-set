import { expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { DrawingCrop } from "../../backend/segmentation/fixtures.ts";
import { readSegmentation } from "../../backend/segmentation/sam.ts";
import { compareInventories, type NamedBox } from "../../backend/segmentation/spatial-inventory.ts";

const crop = Schema.decodeUnknownSync(DrawingCrop)({
  id: "synthetic-room",
  file: "reference.png",
  pdf: "drawing.pdf",
  page: 1,
  sheet: "TEST",
  pdf_rect_points: [12, 24, 88.8, 104.16],
  dpi: 300,
  width_px: 320,
  height_px: 334,
  pixel_to_pdf: { scale: 0.24, offset_points: [12, 24] },
  purpose: "Synthetic crop",
  sha256: "0".repeat(64),
});

// Complete 60x27 mask from Meta's parser conformance example.
const mask = "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";

function response(text: string) {
  return {
    status: 200,
    body: JSON.stringify({
      id: "synthetic-sam",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    }),
  };
}

const box = (id: string, x: number, y: number) =>
  `${id}<|box;x1=${x};y1=${y};x2=${x + 59};y2=${y + 26};w=320;h=334|>${mask}`;

test("SAM output that repeats an object ID is rejected instead of reusing one mask", async () => {
  const exit = await Effect.runPromiseExit(
    readSegmentation(response(`<0f>${box("7", 10, 10)},${box("7", 100, 100)}`), crop),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(JSON.stringify(exit)).toContain("repeats an object ID");

  const distinct = await Effect.runPromise(
    readSegmentation(response(`<0f>${box("7", 10, 10)},${box("8", 100, 100)}`), crop),
  );

  expect(distinct.objects.map((object) => [object.id, object.pixels.left])).toEqual([
    ["7", 10],
    ["8", 100],
  ]);
});

test("inventory comparison keeps mutual-uniqueness semantics and scales to dense clusters", async () => {
  const small = await Effect.runPromise(
    compareInventories(
      [
        { id: "a", box: { left: 0, top: 0, right: 10, bottom: 10 } },
        { id: "b", box: { left: 100, top: 100, right: 110, bottom: 110 } },
        { id: "c", box: { left: 300, top: 300, right: 310, bottom: 310 } },
      ],
      [
        { id: "x", box: { left: 1, top: 1, right: 11, bottom: 11 } },
        { id: "y", box: { left: 101, top: 101, right: 111, bottom: 111 } },
        { id: "z", box: { left: 102, top: 100, right: 112, bottom: 110 } },
      ],
    ),
  );

  expect(small.matches.map((match) => `${match.leftId}:${match.rightId}`)).toEqual(["a:x"]);
  expect(small.leftOnly).toEqual(["b", "c"]);
  expect(small.rightOnly).toEqual(["y", "z"]);
  expect(small.ambiguous).toEqual(["left:b", "right:y", "right:z"]);

  // 400 x 400 identical boxes yield 160,000 compatible edges; the earlier rescans were quadratic.
  const cluster = (prefix: string): Array<NamedBox> =>
    Array.from({ length: 400 }, (_, index) => ({
      id: `${prefix}${index}`,
      box: { left: 0, top: 0, right: 10, bottom: 10 },
    }));

  const started = performance.now();
  const dense = await Effect.runPromise(compareInventories(cluster("l"), cluster("r")));

  expect(performance.now() - started).toBeLessThan(5_000);
  expect(dense.matches).toEqual([]);
  expect(dense.leftOnly).toHaveLength(400);
  expect(dense.ambiguous).toHaveLength(800);
});
