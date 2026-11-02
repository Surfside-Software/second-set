import { expect, test } from "bun:test";
import { Schema, Struct } from "effect";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PacketCitation } from "#lib/review/packet.ts";
import {
  CodeReference,
  codeReference,
  floridaCodeIndex,
  parseCodeReferences,
  resolveCodeReference,
  searchCodeReferences,
} from "../../backend/review/code-index/code-index.ts";
import provenance from "../../backend/review/code-index/provenance.json";
import { decodeRequest, id, open, outputs, response, until } from "../fixtures/packet-review.ts";

const assets = "backend/review/code-index";

test("every entry in the owner's reference and the additions becomes a unique, linked pointer", async () => {
  const reference = await readFile(
    join(assets, "assets/FBC_2023_plan_review_reference.md"),
    "utf8",
  );

  const bullets = reference.split("\n").filter((line) => line.startsWith("- **"));
  const parsed = parseCodeReferences(reference);

  // One entry links both the commercial and residential energy chapters.
  expect(parsed.length).toBe(bullets.length + 1);
  expect(new Set(floridaCodeIndex.map((entry) => entry.id)).size).toBe(floridaCodeIndex.length);
  expect(floridaCodeIndex.every((entry) => entry.url.startsWith("https://"))).toBe(true);
  expect(new Set(floridaCodeIndex.map((entry) => entry.document))).toEqual(
    new Set([
      "FBC Building (Commercial)",
      "FBC Residential",
      "FBC Existing Building",
      "FBC Energy Conservation",
      "FBC Accessibility",
      "FBC Mechanical",
      "FBC Plumbing",
      "FBC Fuel Gas",
      "Florida Statutes",
      "Florida Administrative Code",
      "Florida Building Code",
    ]),
  );

  for (const file of provenance.files) {
    const bytes = await readFile(join(assets, file.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
});

test("only links the app can retrieve are marked for read_source", () => {
  const access = (title: string) =>
    floridaCodeIndex.find((entry) => entry.title.startsWith(title))?.access;

  expect(access("1004 Occupant Load")).toBe("open_in_browser");
  expect(access("553.79 Permits")).toBe("read_source");
  expect(access("61G15-23.002 Seals")).toBe("open_in_browser");
});

test("search ranks section numbers and plan review terms", () => {
  const titles = (query: string, limit = 3) =>
    searchCodeReferences(floridaCodeIndex, query, limit).map((entry) => entry.title);

  expect(titles("occupant load")[0]).toBe("1004 Occupant Load");
  expect(titles("1005.3")[0]).toBe("1005 Egress Sizing");
  expect(titles("R302 townhouse fire separation")[0]).toBe("R302 Fire-resistant construction");
  expect(titles("threshold building structural inspection plan")[0]).toStartWith("553.79");
  expect(titles("engineer seal digital signature")).toContain(
    "61G15-23.004 Procedures for Digitally Signing and Sealing Electronically Transmitted Plans, Specifications, Reports or Other Documents",
  );
  expect(titles("the of and")).toEqual([]);
  expect(searchCodeReferences(floridaCodeIndex, "egress", 20).length).toBeLessThanOrEqual(20);
});

test("a citation that names no search result resolves to its one indexed section", () => {
  const resolve = (document: string, edition: string, section: string) =>
    resolveCodeReference(floridaCodeIndex, { document, edition, section })?.title;

  // The same volume under the names reviewers and drawings use.
  expect(resolve("Florida Building Code, Building", "2023 8th Edition", "1004")).toBe(
    "1004 Occupant Load",
  );
  expect(resolve("FBC Building (Commercial)", "", "Section 1004")).toBe("1004 Occupant Load");
  expect(resolve("Florida Building Code, Building 2023", "", "1004")).toBe("1004 Occupant Load");
  // A subsection falls back to the section the link actually opens.
  expect(resolve("FBC Building", "2023 8th Edition", "1004.5")).toBe("1004 Occupant Load");
  expect(resolve("FBC Mechanical", "2023 8th Edition", "802")).toBe("802/803 Vents & Connectors");
  expect(resolve("FBC Mechanical", "2023 8th Edition", "803")).toBeUndefined();
  // Existing Building is a different volume from Building, despite the shared word.
  expect(resolve("FBC Existing Building", "2023 8th Edition", "301.3")).toBe(
    "301.3 Compliance path election",
  );
  expect(resolve("FBC Building", "2023 8th Edition", "301.3")).toBeUndefined();
  // Statutes resolve too, and can be read and verified.
  expect(resolve("Florida Statutes", "", "553.79")).toStartWith("553.79");
  // Another edition, another code or no section number never links to this index.
  expect(resolve("Florida Building Code, Building", "2020 7th Edition", "1004")).toBeUndefined();
  expect(resolve("International Building Code", "2021", "1004")).toBeUndefined();
  expect(resolve("Florida Building Code, Building", "2023 8th Edition", "Means of egress")).toBe(
    undefined,
  );
});

test("automatic citation links follow URL sections, reject ambiguity and respect every edition hint", () => {
  const resolve = (document: string, section: string, edition = "2023 8th Edition") =>
    resolveCodeReference(floridaCodeIndex, { document, edition, section });

  expect(resolve("FBC Building", "303")).toBeUndefined();
  expect(resolve("FBC Building", "304")?.url).toEndWith("_Sec304");
  expect(resolve("FBC Building", "318")).toBeUndefined();
  expect(resolve("FBC Mechanical", "1004")?.url).toContain("FLMC2023P2");
  expect(resolve("FBC Building", "1004")?.url).toContain("FLBC2023P2");
  expect(resolve("FBC Building", "1004 and 1005")).toBeUndefined();
  expect(resolve("FBC Building", "1004", "7th Edition")).toBeUndefined();
  expect(resolve("FBC Building 2020", "1004")).toBeUndefined();
  expect(resolve("FBC Residential", "r302.1")?.url).toEndWith("_SecR302.1");
  expect(resolve("FBC Residential", "R609.4.1")?.url).toEndWith("_SecR609.4");
  expect(resolve("Florida Administrative Code", "101", "Current rules")).toBeUndefined();
  expect(resolve("Florida Administrative Code", "69A-60.004", "Current rules")?.url).toEndWith(
    "id=69A-60.004",
  );
  // Two topics list 2002 at the same URL. Duplicate topics do not make the link ambiguous.
  expect(resolve("FBC Building", "2002")?.url).toEndWith("_Sec2002");
});

test("multi-section citations resolve only a complete title set at one unambiguous link", () => {
  const citation = {
    document: "FBC Mechanical",
    edition: "2023 8th Edition",
    section: "802/803",
  };

  for (const section of ["802/803", "802 / 803", "802 and 803", "803, 802", "802/803/802"]) {
    expect(resolveCodeReference(floridaCodeIndex, { ...citation, section })?.url).toEndWith(
      "_Sec802",
    );
  }

  for (const section of ["803", "802, 803, 804", "802 and 1105", "802.1/803"]) {
    expect(resolveCodeReference(floridaCodeIndex, { ...citation, section })).toBeUndefined();
  }

  expect(resolveCodeReference(floridaCodeIndex, { ...citation, section: "802" })?.url).toEndWith(
    "_Sec802",
  );
  expect(
    resolveCodeReference(floridaCodeIndex, { ...citation, edition: "2020 7th Edition" }),
  ).toBeUndefined();
  expect(
    resolveCodeReference(floridaCodeIndex, { ...citation, document: "FBC Building" }),
  ).toBeUndefined();
  const entry = resolveCodeReference(floridaCodeIndex, citation);

  expect(entry).toBeDefined();

  if (!entry) return;

  expect(resolveCodeReference([entry, entry], citation)?.url).toBe(entry.url);
  expect(
    resolveCodeReference(
      [entry, new CodeReference(Struct.assign(entry, { url: `${entry.url}-other` }))],
      citation,
    ),
  ).toBeUndefined();
});

test("a citation names a search_code result and the host attaches its link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moke-code-citation-"));

  const SearchOutput = Schema.Struct({
    index: Schema.String,
    results: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  });

  const citationId = id();
  let resultId: string | undefined;
  let rejected = false;
  let step = 0;

  const citation = (codeReferenceId: string) => ({
    id: citationId,
    sourceId: null,
    jurisdiction: "Florida",
    document: "Florida Building Code, Building",
    edition: "2023 8th Edition",
    section: "1004",
    quote: "",
    application: "Occupant load posted on the life safety plan.",
    status: "verified",
    note: "",
    codeReferenceId,
  });

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    switch (step++) {
      case 0:
        return response([{ name: "search_code", arguments: { query: "occupant load", limit: 2 } }]);
      case 1:
        resultId = outputs(SearchOutput, request).at(-1)?.results[0]?.id;

        return response([{ name: "record_citation", arguments: citation("not-an-index-id") }]);
      case 2:
        rejected = JSON.stringify(request).includes("Unknown code reference");

        return response([{ name: "record_citation", arguments: citation(resultId ?? "") }]);
      default:
        return response([], "Code citation fixture finished.");
    }
  });

  try {
    const started = await session.run(
      session.packets.start(await session.request("Check the occupant load requirement.")),
    );

    const finished = await until(session, started.id, "failed");
    const recorded = finished.citations.find((entry) => entry.id === citationId);
    const indexed = codeReference(resultId ?? "");

    expect(indexed?.title).toBe("1004 Occupant Load");
    expect(rejected).toBe(true);
    expect(Schema.is(PacketCitation)(recorded)).toBe(true);
    expect(recorded?.reference).toEqual({
      id: indexed?.id ?? "",
      document: "FBC Building (Commercial)",
      edition: "2023 8th Edition",
      title: "1004 Occupant Load",
      check: indexed?.check ?? "",
      url: indexed?.url ?? "",
      access: "open_in_browser",
    });
    // A pointer is not retrieved text, so a verified claim without a source stays unverified.
    expect(recorded?.status).toBe("unverified");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
