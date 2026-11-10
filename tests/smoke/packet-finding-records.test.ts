import { expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isQuickGatewayRefusal, type ProviderTransport } from "../../backend/inference/provider.ts";
import { PacketFindingLocationInput } from "#lib/review/packet.ts";
import { predecessorsOf } from "../../backend/packet-review/service.ts";
import { Artifact, ReviewCommand, ReviewInputError } from "#lib/review/contracts.ts";
import { deliveredBoxToPdf, deliveredImageSize } from "#lib/review/geometry.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  until,
} from "../fixtures/packet-review.ts";

const Rendered = Schema.Struct({
  artifact: Artifact,
  width: Schema.Number,
  height: Schema.Number,
});

const Recorded = Schema.Struct({ id: Schema.String, sourceId: Schema.NullOr(Schema.String) });

const sam = () =>
  Response.json({
    id: "sam-records",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
  });

test("an image box maps delivered pixels back to PDF points through the artifact transform", () => {
  // A 96-dpi render of a 2304 × 1674-point sheet, delivered to the model at 2048 × 1488 pixels.
  const artifact = {
    width: 3072,
    height: 2232,
    pixelsToPdf: [0.75, 0, 0, -0.75, 0, 1674] as const,
  };

  // Muse Spark located "17 OCCUPANTS X 0.2" on LS-1 at about these delivered pixels.
  const region = deliveredBoxToPdf(artifact, { left: 20, top: 324, right: 107, bottom: 335 });

  if (region instanceof ReviewInputError) throw new Error(region.message);
  // pdftotext places the words at x 21-120 and y 1297-1309 (bottom-left origin).
  expect(region.x).toBeCloseTo(22.5, 1);
  expect(region.y).toBeCloseTo(1297.1, 1);
  expect(region.y + region.height).toBeCloseTo(1309.5, 1);

  for (const box of [
    { left: 0, top: 0, right: 2049, bottom: 10 },
    { left: 50, top: 50, right: 40, bottom: 60 },
  ])
    expect(deliveredBoxToPdf(artifact, box)).toBeInstanceOf(ReviewInputError);
});

test("a location with no image box accepts the null models send for it", () => {
  const decoded = Schema.decodeUnknownSync(PacketFindingLocationInput)({
    sheetId: id(),
    detail: "Door 101 hardware",
    region: null,
    imageBox: null,
  });

  expect(decoded.imageBox).toBeNull();
});

test("a gateway error counts as a refusal only when it answers at once", () => {
  expect(isQuickGatewayRefusal(502, 110)).toBe(true);
  expect(isQuickGatewayRefusal(503, 5000)).toBe(true);
  // A late one can follow real work, so its charge stays unresolved.
  expect(isQuickGatewayRefusal(502, 5001)).toBe(false);
  expect(isQuickGatewayRefusal(500, 110)).toBe(false);
});

test("revised sheets inherit the earlier sheets they replace through chained correspondence", () => {
  expect(
    predecessorsOf(
      ["a2", "b1", "c1"],
      [
        { oldSheetId: "a0", newSheetId: "a1", content: "changed" },
        { oldSheetId: "a1", newSheetId: "a2", content: "unchanged" },
        { oldSheetId: "b0", newSheetId: null, content: "removed" },
        { oldSheetId: "c0", newSheetId: "c1", content: "unresolved" },
      ],
    ),
  ).toEqual({ a2: ["a1", "a0"] });
});

test("finding records are validated, withdrawable and carried into a revised review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-packet-finding-records-"));
  const inputs: Array<string> = [];
  let phase = 1;
  let step = 0;
  let firstSheet = "";
  let revisedSheet = "";
  let carried = "";
  let citation = "";
  const priorComment = id();

  const finding = (
    sheetId: string,
    rendered: typeof Rendered.Type,
    changes: Readonly<Record<string, typeof Schema.Json.Type>> = {},
  ) => ({
    title: "Door hardware set differs from the schedule",
    discipline: "general",
    severity: "Minor",
    status: "Needs input",
    classification: "Drawing conflict",
    locations: [
      {
        sheetId,
        detail: "Door 101 hardware",
        imageBox: {
          artifactId: rendered.artifact.id,
          left: rendered.width * 0.3,
          top: rendered.height * 0.3,
          right: rendered.width * 0.45,
          bottom: rendered.height * 0.4,
        },
      },
    ],
    observed: "The plan lists hardware set 3 where the door schedule lists set 4.",
    correction: "Revise the plan or the door schedule so both list one hardware set.",
    evidenceIds: [rendered.artifact.id],
    evidenceNote: "The hardware tag is legible on the rendered sheet.",
    citationIds: [],
    calculationIds: [],
    priorCommentId: null,
    ...changes,
  });

  const transport: ProviderTransport = async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") return sam();

    const input = strings(request.input ?? null).join("\n");
    inputs.push(input);
    const renders = outputs(Rendered, request);
    const first = renders.find((item) => item.artifact.sheetId === firstSheet);
    const revised = renders.find((item) => item.artifact.sheetId === revisedSheet);

    if (phase === 1)
      switch (step++) {
        case 0:
          return response([{ name: "render_sheet", arguments: { sheetId: firstSheet } }]);
        case 1:
          if (!first) throw new Error("The first sheet was not rendered.");

          return response([
            {
              name: "record_finding",
              arguments: finding(firstSheet, first, {
                locations: [
                  {
                    sheetId: firstSheet,
                    detail: "Outside the image",
                    imageBox: {
                      artifactId: first.artifact.id,
                      left: 0,
                      top: 0,
                      right: first.width + 10,
                      bottom: 10,
                    },
                  },
                ],
              }),
            },
            {
              name: "record_finding",
              arguments: finding(firstSheet, first, {
                title: "Circuit labels illegible on the power plan",
                observed: "The circuit labels are illegible at the submitted resolution.",
              }),
            },
            {
              name: "record_finding",
              arguments: finding(firstSheet, first, { calculationIds: [id()] }),
            },
            {
              name: "record_citation",
              arguments: {
                id: id(),
                sourceId: null,
                jurisdiction: "Florida",
                document: "FBC Building",
                edition: "2023 8th Edition",
                section: "1010.1.9",
                quote: "",
                application: "Door hardware on the plan.",
                status: "unverified",
                note: "Printed on the sheet.",
              },
            },
          ]);
        case 2: {
          if (!first) throw new Error("The first sheet was not rendered.");
          expect(input).toContain("must lie inside the delivered");
          expect(input).toContain("render a focused crop of it with render_sheet, cite that crop");
          expect(input).toContain("Unknown calculation ids");
          const recorded = outputs(Recorded, request).find((item) => item.sourceId === null);

          if (!recorded) throw new Error("The citation result has no host id.");
          citation = recorded.id;

          return response([
            {
              name: "record_finding",
              arguments: finding(firstSheet, first, {
                citationIds: [citation],
                priorCommentId: priorComment,
              }),
            },
            {
              name: "record_finding",
              arguments: finding(firstSheet, first, { title: "Second door hardware note" }),
            },
            {
              name: "record_coverage_batch",
              arguments: {
                entries: [
                  {
                    sheetId: firstSheet,
                    discipline: "general",
                    pass: "completeness",
                    status: "needs_input",
                    note: "",
                  },
                ],
              },
            },
          ]);
        }

        case 3: {
          expect(input).toContain("Entry 1 (");
          expect(input).toContain("record the specific reason or missing input");
          const ids = outputs(Schema.Struct({ id: Schema.String, summary: Schema.Json }), request);
          const [kept, mistaken] = ids.map((item) => item.id);

          if (!kept || !mistaken) throw new Error("Both findings were not recorded.");
          carried = kept;

          return response([
            { name: "withdraw_finding", arguments: { id: mistaken, reason: "Duplicate note." } },
          ]);
        }

        case 4:
          return response([
            {
              name: "finish_review",
              arguments: { summary: "Door hardware reviewed.", missingInputs: [] },
            },
          ]);
        default:
          return response([], "Door hardware needs coordination.");
      }

    switch (step++) {
      case 0:
        return response([{ name: "inventory_packet", arguments: {} }]);
      case 1:
        expect(input).toContain(carried);

        return response([
          {
            name: "record_finding",
            arguments: {
              title: "Door hardware set differs from the schedule",
              discipline: "general",
              severity: "Minor",
              status: "Resolved",
              classification: "Drawing conflict",
              locations: [{ sheetId: revisedSheet, detail: "Door 101 hardware", region: null }],
              observed: "Revision B lists hardware set 4 on the plan and the schedule.",
              correction: "No correction remains.",
              evidenceIds: [],
              evidenceNote: "Not yet inspected.",
              citationIds: [],
              calculationIds: [],
              priorCommentId: null,
              id: carried,
            },
          },
        ]);
      case 2:
        expect(input).toContain("Resolved applies only to a finding carried");

        return response([{ name: "render_sheet", arguments: { sheetId: revisedSheet } }]);
      case 3:
        if (!revised) throw new Error("The revised sheet was not rendered.");

        return response([
          {
            name: "record_finding",
            arguments: finding(revisedSheet, revised, {
              id: carried,
              status: "Resolved",
              observed: "The hardware set missing from Revision A is now on the plan and schedule.",
              evidenceNote: "Revision B lists hardware set 4 on both the plan and the schedule.",
              citationIds: [citation],
            }),
          },
          { name: "withdraw_finding", arguments: { id: carried, reason: "Resolved." } },
        ]);
      case 4:
        expect(input).toContain("cannot be withdrawn");

        return response([
          {
            name: "finish_review",
            arguments: { summary: "Revision B resolves the hardware note.", missingInputs: [] },
          },
        ]);
      default:
        return response([], "Revision B resolves the door hardware note.");
    }
  };

  const session = await open(directory, transport);

  try {
    const sheet = (await session.snapshot()).sheets[0];

    if (!sheet) throw new Error("The fixture PDF has no source sheet.");
    firstSheet = sheet.id;

    const started = await session.run(
      session.packets.start(await session.request("Check the door hardware.")),
    );

    const finished = await until(session, started.id, "completed");
    expect(finished.findings.map((item) => item.id)).toEqual([carried]);

    const [recorded] = finished.findings;

    const artifact = (await session.snapshot()).artifacts.find(
      (item) => item.id === recorded?.evidenceIds[0],
    );

    if (!recorded || !artifact) throw new Error("The kept finding lost its evidence.");
    // The stored region is exactly the host's conversion of the box drawn on the delivered image.
    const delivered = deliveredImageSize(artifact.width, artifact.height);

    const expected = deliveredBoxToPdf(artifact, {
      left: delivered.width * 0.3,
      top: delivered.height * 0.3,
      right: delivered.width * 0.45,
      bottom: delivered.height * 0.4,
    });

    if (expected instanceof ReviewInputError) throw new Error(expected.message);
    const region = recorded.locations[0]?.region;

    expect([region?.x, region?.y, region?.width, region?.height]).toEqual([
      expected.x,
      expected.y,
      expected.width,
      expected.height,
    ]);
    // A comment can be recorded after its finding; the report names only comments the review holds.
    expect(recorded.priorCommentId).toBe(priorComment);
    expect(finished.citations).toEqual([expect.objectContaining({ id: citation })]);

    // Import revision B and map its first page to the reviewed sheet.
    const before = await session.snapshot();
    const source = join(directory, "Revision B.pdf");
    await writeFile(source, createHeroPdf("B"));
    await session.importPdf({
      commandId: id(),
      projectId: session.projectId,
      expectedVersion: before.project?.version ?? -1,
      source,
      name: "Revision B.pdf",
    });

    const imported = await session.snapshot();
    const revision = imported.revisions.at(-1);

    const replacement = imported.sheets.find(
      (item) => item.revisionId === revision?.id && item.pageIndex === sheet.pageIndex,
    );

    if (!revision || !replacement) throw new Error("Revision B was not imported.");
    revisedSheet = replacement.id;
    await session.command(
      ReviewCommand.cases.AssociateRevision.make({
        commandId: id(),
        projectId: session.projectId,
        expectedVersion: imported.project?.version ?? -1,
        revisionId: revision.id,
        correspondence: [
          { oldSheetId: sheet.id, newSheetId: replacement.id, confirmed: true, content: "changed" },
        ],
      }),
    );

    phase = 2;
    step = 0;

    const followUp = await session.run(
      session.packets.start(await session.request("Recheck the door hardware on revision B.")),
    );

    const rechecked = await until(session, followUp.id, "completed");
    expect(rechecked.predecessorSheetIds?.[replacement.id]).toEqual([sheet.id]);
    expect(rechecked.carriedFindingIds).toEqual([carried]);
    expect(rechecked.findings).toHaveLength(1);
    expect(rechecked.findings[0]).toMatchObject({ id: carried, status: "Resolved" });
    expect(rechecked.findings[0]?.locations.map((location) => location.sheetId)).toEqual([
      replacement.id,
    ]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
