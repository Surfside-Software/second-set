import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
// SAFETY: the parser's own conformance encoder is not exported; tests use it to build valid masks.
import { encodeSegmentationMask } from "../../node_modules/@meta-sam/parser/dist/mask-codec.js";
import { calculate } from "../../backend/packet-review/calculations.ts";
import { citationHasSourceSupport } from "../../backend/packet-review/citations.ts";
import { jurisdictionMatch, jurisdictionPlace } from "../../backend/packet-review/jurisdiction.ts";
import { decodePacketSamFocus } from "../../backend/packet-review/sam.ts";
import {
  readSource,
  sourceKey,
  type SourceLookupOptions,
  type SourceResponse,
} from "../../backend/packet-review/sources.ts";
import { ExecutionImage } from "../../backend/review/execution-port.ts";
import { PacketCitation, PacketFindingFocus, PacketSource } from "#lib/review/packet.ts";

const image = Schema.decodeUnknownSync(ExecutionImage)({
  artifactId: randomUUID(),
  projectId: randomUUID(),
  sheetId: randomUUID(),
  mimeType: "image/png",
  data: "aW1hZ2U=",
  width: 320,
  height: 334,
  pdfToPixels: [1, 0, 0, 1, 0, 0],
  pixelsToPdf: [1, 0, 0, 1, 0, 0],
});

const samResponse = (text: string) =>
  JSON.stringify({
    id: "sam-focus",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });

const smallMask = encodeSegmentationMask(new Uint8Array([1]), 1, 1);

// A noisy raster compresses poorly, so its payload is larger than a focus can embed.
const largeMask = (() => {
  const size = 800;
  const raster = new Uint8Array(size * size);
  let seed = 7;

  for (let index = 0; index < raster.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raster[index] = (seed >> 16) & 1;
  }

  return encodeSegmentationMask(raster, size, size);
})();

const instance = (
  id: number,
  confidence: number,
  mask: { readonly payload: string; readonly width: number; readonly height: number },
) =>
  `${id}<|box;x1=${id * 10};y1=10;x2=${id * 10 + 8};y2=50;w=320;h=334;c=${confidence}|><|mask;x=0;y=0;c=${confidence};data=${mask.width},${mask.height},${mask.payload}|>`;

test("a SAM focus keeps the most confident embeddable masks and records what it omitted", async () => {
  expect(largeMask.payload.length).toBeGreaterThan(65536);

  // Twelve small instances in rising confidence, then one very confident oversized mask.
  const instances = Array.from({ length: 12 }, (_, index) =>
    instance(index, (index + 1) / 20, smallMask),
  );

  instances.push(instance(12, 0.99, largeMask));

  const focus = await Effect.runPromise(
    decodePacketSamFocus(samResponse(`<0f>${instances.join(",")}`), image),
  );

  expect(focus.detected).toBe(13);
  expect(focus.oversized).toBe(1);
  expect(focus.segments).toHaveLength(8);
  expect(focus.segments.map((segment) => segment.confidence)).toEqual([
    0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25,
  ]);

  // Stored focus payloads with or without the counts decode.
  const stored = {
    artifactId: randomUUID(),
    sheetId: image.sheetId,
    region: { x: 0, y: 0, width: 10, height: 10 },
    width: 320,
    height: 334,
    box: { left: 0, top: 0, right: 10, bottom: 10 },
    model: "sam-3.1",
    responseId: focus.responseId,
    segments: focus.segments,
  };

  expect(Schema.decodeUnknownSync(PacketFindingFocus)(stored).detected).toBeUndefined();
  expect(
    Schema.decodeUnknownSync(PacketFindingFocus)({ ...stored, detected: 13, oversized: 1 })
      .detected,
  ).toBe(13);
});

test("a section heading followed by a dot or dash and its title is recognised", () => {
  const quote = "Door openings shall have a clear width of at least thirty two inches.";

  const source = (text: string) =>
    Schema.decodeUnknownSync(PacketSource)({
      id: randomUUID(),
      url: "https://codes.iccsafe.org/example",
      title: "2023 Florida Building Code — Residential",
      retrievedAt: "2026-10-28T00:00:00.000Z",
      status: "available",
      official: true,
      sha256: "a".repeat(64),
      text,
    });

  const citation = (sourceId: string, section: string) =>
    Schema.decodeUnknownSync(PacketCitation)({
      id: randomUUID(),
      sourceId,
      jurisdiction: "Needs adoption confirmation",
      document: "Florida Building Code, Residential",
      edition: "2023",
      section,
      quote,
      application: "The door opening must be checked against the clear-width requirement.",
      status: "verified",
      note: "Textual support only.",
    });

  for (const [text, section] of [
    [`101.2. Scope\n${quote}\n101.3 Other\nUnrelated.`, "101.2"],
    [`R301.2 - Climatic criteria\n${quote}\nR301.3 Other\nUnrelated.`, "R301.2"],
    [`R301.2 – Climatic criteria\n${quote}`, "R301.2"],
  ] as const) {
    const read = source(text);
    expect(citationHasSourceSupport(citation(read.id, section), read)).toBe(true);
  }

  // The next heading still bounds the section.
  const bounded = source(`101.2. Scope\nIntroductory text only.\n101.3. Doors\n${quote}`);
  expect(citationHasSourceSupport(citation(bounded.id, "101.2"), bounded)).toBe(false);
  expect(citationHasSourceSupport(citation(bounded.id, "101.3"), bounded)).toBe(true);
});

test("a state name inside a city or county name is not read as the state", () => {
  const states = (text: string) => [...jurisdictionPlace(text).states].toSorted();

  expect(states("Washington, DC")).toEqual(["District of Columbia"]);
  expect(states("Kansas City, MO")).toEqual(["Missouri"]);
  expect(states("Washington County, OR")).toEqual(["Oregon"]);
  expect(states("Nevada County, CA")).toEqual(["California"]);
  expect(states("Virginia Beach, VA")).toEqual(["Virginia"]);
  expect(states("City of Nevada, MO")).toEqual(["Missouri"]);
  expect([...jurisdictionPlace("Washington County, OR").localities]).toEqual(["washington county"]);

  // Without an explicit code, a bare state-named city still names its state.
  expect(states("Oklahoma City")).toEqual(["Oklahoma"]);
  expect(states("Kansas City, Kansas")).toEqual(["Kansas"]);
  expect(states("Seattle, Washington")).toEqual(["Washington"]);

  expect(
    jurisdictionMatch(jurisdictionPlace("Kansas City, MO"), jurisdictionPlace("Wichita, KS")),
  ).toBeNull();
  expect(
    jurisdictionMatch(jurisdictionPlace("Washington, DC"), jurisdictionPlace("Seattle, WA")),
  ).toBeNull();
});

const publicDns: NonNullable<SourceLookupOptions["resolve"]> = async () => [
  { address: "1.1.1.1", family: 4 },
];

const respond = (response: SourceResponse): SourceLookupOptions => ({
  resolve: publicDns,
  transport: async () => response,
});

const latin1 = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

test("a source is decoded by its declared charset and hashed over the bytes served", async () => {
  const body = latin1("<html><body><p>§ 553.79 requires 90° bends.</p></body></html>");

  for (const [contentType, bytes] of [
    ["text/html; charset=windows-1252", body],
    ["text/html; charset=ISO-8859-1", body],
    ["text/html", body],
    [
      "text/html",
      latin1(
        '<html><head><meta charset="windows-1252"></head><body><p>§ 553.79 requires 90° bends.</p></body></html>',
      ),
    ],
  ] as const) {
    const source = await Effect.runPromise(
      readSource(
        "https://county.gov/code",
        respond({ status: 200, headers: { "content-type": contentType }, body: bytes }),
      ),
    );

    expect(source.status).toBe("available");
    expect(source.text).toContain("§ 553.79 requires 90° bends.");
    expect(source.text).not.toContain("�");
    expect(source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }

  // A UTF-8 byte-order mark is stripped from the text but kept in the hash.
  const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Section 1 text")]);

  const bom = await Effect.runPromise(
    readSource(
      "https://county.gov/plain",
      respond({ status: 200, headers: { "content-type": "text/plain" }, body: marked }),
    ),
  );

  expect(bom.text).toBe("Section 1 text");
  expect(bom.sha256).toBe(createHash("sha256").update(marked).digest("hex"));

  const unsupported = await Effect.runPromise(
    readSource(
      "https://county.gov/odd",
      respond({
        status: 200,
        headers: { "content-type": "text/html; charset=x-unknown-charset" },
        body,
      }),
    ),
  );

  expect(unsupported.status).toBe("unavailable");
  expect(unsupported.sha256).toBeNull();
});

test("stray angle brackets and apostrophes in markup do not swallow governing text", async () => {
  const read = (body: string) =>
    Effect.runPromise(
      readSource(
        "https://county.gov/rule",
        respond({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: new TextEncoder().encode(body),
        }),
      ),
    );

  const prose = await read(
    "<p>Clear width < 36 in. is allowed at the owner's option.</p><p>Landings are required.</p>",
  );

  expect(prose.text).toBe(
    "Clear width < 36 in. is allowed at the owner's option.\nLandings are required.",
  );

  const apostrophe = await read(
    "<p><a title=John's>Rule</a> text.</p><p>Guards shall be 42 inches high.</p>",
  );

  expect(apostrophe.text).toContain("Rule text.");
  expect(apostrophe.text).toContain("Guards shall be 42 inches high.");

  const unclosed = await read('<p><a title="Rule>Rule 1</a> text.</p><p>Guards are required.</p>');
  expect(unclosed.text).toContain("Guards are required.");

  const quoted = await read('<p><a title="a > b">Linked</a> rule.</p>');
  expect(quoted.text).toBe("Linked rule.");
});

const pdf = (pageCount: number, requests: Array<number>): SourceLookupOptions => ({
  resolve: publicDns,
  transport: async () => ({
    status: 200,
    headers: { "content-type": "application/pdf" },
    body: new TextEncoder().encode("%PDF-1.7"),
  }),
  pdfText: (_bytes, firstPage) => {
    requests.push(firstPage);

    return Effect.succeed({
      sha256: "d".repeat(64),
      pageCount,
      firstPage,
      lastPage: Math.min(firstPage, pageCount),
      text: `[Page ${firstPage}]\nRule text`,
      truncated: false,
    });
  },
});

test("a PDF page past the readable range is reported instead of reread as page 1", async () => {
  const requests: Array<number> = [];

  const beyond = await Effect.runPromise(
    readSource("https://county.gov/code.pdf#page=250", pdf(150, requests)),
  );

  expect(beyond.status).toBe("unavailable");
  expect(beyond.text).toContain("page 250");
  expect(requests).toEqual([]);
  expect(sourceKey("https://county.gov/code.pdf#page=250")).toBe(
    "https://county.gov/code.pdf#page=250",
  );

  const last = await Effect.runPromise(
    readSource("https://county.gov/code.pdf#page=200", pdf(200, requests)),
  );

  expect(last.status).toBe("available");
  expect(last.text).toContain("[Page 200]");
});

test("a PDF file name with a malformed escape keeps its raw name", async () => {
  const source = await Effect.runPromise(
    readSource("https://county.gov/docs/100%.pdf", pdf(1, [])),
  );

  expect(source.status).toBe("available");
  expect(source.title).toStartWith("100%.pdf (PDF pages 1-1 of 1)");

  const encoded = await Effect.runPromise(
    readSource("https://county.gov/docs/r%E9sum%E9.pdf", pdf(1, [])),
  );

  expect(encoded.title).toStartWith("r%E9sum%E9.pdf");
});

const calculation = (
  expression: string,
  inputs: Record<string, { value: number; unit: string }>,
  unit: string,
) =>
  Effect.runPromise(
    Effect.result(
      calculate({
        title: "Angle check",
        expression,
        inputs,
        unit,
        explanation: "Reproduce the stated slope geometry.",
      }),
    ),
  );

test("trigonometry rejects degree inputs and degree results that were not converted", async () => {
  const slope = { slope: { value: 30, unit: "deg" }, L: { value: 10, unit: "ft" } };

  for (const [expression, inputs, unit] of [
    ["L * cos(slope)", slope, "ft"],
    ["L * sin(2 * slope)", slope, "ft"],
    ["atan(rise / run)", { rise: { value: 1, unit: "ft" }, run: { value: 12, unit: "ft" } }, "°"],
  ] as const) {
    const result = await calculation(expression, inputs, unit);
    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) expect(result.failure.message).toMatch(/radians/);
  }

  const converted = await calculation("L * cos(slope * pi / 180)", slope, "ft");
  expect(Result.isSuccess(converted) && converted.success.result).toBeCloseTo(8.6603, 3);

  const angle = await calculation(
    "atan(rise / run) * 180 / pi",
    { rise: { value: 1, unit: "ft" }, run: { value: 1, unit: "ft" } },
    "deg",
  );

  expect(Result.isSuccess(angle) && angle.success.result).toBeCloseTo(45, 6);

  const radians = await calculation("cos(theta)", { theta: { value: Math.PI, unit: "rad" } }, "");
  expect(Result.isSuccess(radians) && radians.success.result).toBeCloseTo(-1, 6);
});
