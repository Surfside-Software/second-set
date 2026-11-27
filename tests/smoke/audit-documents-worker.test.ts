import { afterEach, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Region } from "#lib/review/contracts.ts";
import type { DocumentsConfig } from "../../backend/documents/config.ts";
import { Documents } from "../../backend/documents/documents.ts";
import { suggestedSheetLabel } from "../../backend/documents/sheet-label.ts";
import { openPdfWorker, workerInspect } from "../../backend/documents/worker-client.ts";
import { canvasNativeFileName, canvasNativePackage } from "../../scripts/prepare-pdf-assets.ts";

const assetsRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));

const nativeFile = join(
  dirname(fileURLToPath(import.meta.resolve(`${canvasNativePackage()}/package.json`))),
  canvasNativeFileName(),
);

const secretName = "SECOND_SET_AUDIT_PROVIDER_KEY";

afterEach(() => {
  delete process.env[secretName];
});

/** A stand-in worker that runs `respond` with the first request id in scope. */
const scriptedWorker = (respond: string): DocumentsConfig => ({
  dataDirectory: tmpdir(),
  workerCommand: [
    process.execPath,
    "-e",
    `process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  const index = pending.indexOf("\\n");
  if (index < 0) return;
  const { id } = JSON.parse(pending.slice(0, index));
  ${respond}
});`,
  ],
  assetsDirectory: assetsRoot,
  nativeLibraryPath: nativeFile,
});

const failureMessage = (config: DocumentsConfig) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(openPdfWorker(config), (worker) =>
        workerInspect(worker, "/unused.pdf").pipe(Effect.flip),
      ),
    ),
  );

test("the PDF worker gets only its asset paths and system variables, never backend secrets", async () => {
  process.env[secretName] = "sk-not-for-pdf-parsers";

  const failure = await failureMessage(
    scriptedWorker(
      `process.stdout.write(JSON.stringify({ id, ok: false, reason: "invalid", message: JSON.stringify(process.env) }) + "\\n");`,
    ),
  );

  const environment = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  )(failure.message);

  expect(environment[secretName]).toBeUndefined();
  expect(Object.values(environment)).not.toContain("sk-not-for-pdf-parsers");
  expect(environment.SECOND_SET_PDFJS_ASSETS).toBe(assetsRoot);
  expect(environment.NAPI_RS_NATIVE_LIBRARY_PATH).toBe(nativeFile);
  expect(environment.PATH).toBe(process.env.PATH ?? "");
});

test("a response line split across many pipe chunks, with output after it, decodes once", async () => {
  // About 8 MB of output in 64 KB writes, the shape of a large render's single line.
  const failure = await failureMessage(
    scriptedWorker(
      `const line = JSON.stringify({ id, ok: false, reason: "limit", message: "x".repeat(8 * 1024 * 1024) }) + "\\n{";
for (let offset = 0; offset < line.length; offset += 65536) process.stdout.write(line.slice(offset, offset + 65536));`,
    ),
  );

  expect(failure.reason).toBe("limit");
  expect(failure.message).toBe("x".repeat(8 * 1024 * 1024));
});

/** One text item drawn at a PDF user-space point on a page with the given `/Rotate`. */
function labelledPdf(rotation: 0 | 90 | 180 | 270, items: ReadonlyArray<[number, number, string]>) {
  const content = items
    .map(([x, y, text]) => `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET`)
    .join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 600] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: Array<number> = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;

  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

test("rotated sheets find the sheet number in the title block as displayed", () => {
  const box = new Region({ x: 0, y: 0, width: 1000, height: 600 });
  // Unrotated bottom-right, and each corner that a clockwise /Rotate turns to the viewed bottom-right.
  const bottomRight = { text: "D-5", x: 950, y: 20 };
  const topRight = { text: "E-201", x: 950, y: 580 };
  const topLeft = { text: "E-201", x: 20, y: 580 };
  const bottomLeft = { text: "E-201", x: 20, y: 20 };

  expect(suggestedSheetLabel(0, null, [bottomRight, topLeft], box)).toBe("D-5 · Page 1");
  expect(suggestedSheetLabel(0, null, [bottomRight, topRight], box, 90)).toBe("E-201 · Page 1");
  expect(suggestedSheetLabel(0, null, [bottomRight, topLeft], box, 180)).toBe("E-201 · Page 1");
  expect(suggestedSheetLabel(0, null, [bottomRight, bottomLeft], box, 270)).toBe("E-201 · Page 1");
});

test("import proposes the displayed title-block number of a /Rotate 90 sheet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-documents-rotated-"));
  const source = join(directory, "rotated.pdf");
  // A detail callout sits in the unrotated bottom-right; the viewed bottom-right holds the number.
  await writeFile(
    source,
    labelledPdf(90, [
      [950, 20, "D-5"],
      [950, 580, "E-201"],
    ]),
  );

  try {
    const imported = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const documents = yield* Documents;

          return yield* documents.importPdf(source);
        }).pipe(
          Effect.provide(
            Documents.layer({
              dataDirectory: directory,
              workerCommand: [process.execPath, resolve("backend/documents/pdf-worker-main.ts")],
              assetsDirectory: assetsRoot,
              nativeLibraryPath: nativeFile,
            }),
          ),
        ),
      ),
    );

    expect(imported.pages[0]?.rotation).toBe(90);
    expect(imported.pages[0]?.label).toBe("E-201 · Page 1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
