import { expect, test } from "bun:test";
import { plugin } from "bun";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { compileModule } from "svelte/compiler";
import { Artifact, ProjectId, Sheet } from "#lib/review/contracts.ts";
import type {
  SourceView as SourceViewClass,
  SourceViewPorts,
} from "#lib/review/source-view.svelte.ts";

// Compile rune modules as the Svelte Vite plugin does, so the real SourceView runs under Bun.
plugin({
  name: "audit-svelte-module",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(
        await readFile(args.path, "utf8"),
      );

      const compiled = compileModule(javascript, {
        filename: args.path.replace(/\.ts$/, ".js"),
        generate: "client",
      });

      return { contents: compiled.js.code, loader: "js" };
    });
  },
});

const { SourceView } = await import("#lib/review/source-view.svelte.ts");

const projectId = Schema.decodeUnknownSync(ProjectId)(crypto.randomUUID());
const revisionId = crypto.randomUUID();

const sheet = (pageIndex: number) =>
  Schema.decodeUnknownSync(Sheet)({
    id: crypto.randomUUID(),
    projectId,
    revisionId,
    pageIndex,
    label: `A-${pageIndex + 1}`,
    confirmed: true,
    box: { x: 0, y: 0, width: 612, height: 792 },
    rotation: 0,
    userUnit: 1,
    coverage: "unreviewed",
  });

const artifact = (rendered: Sheet) =>
  Schema.decodeUnknownSync(Artifact)({
    id: crypto.randomUUID(),
    projectId,
    revisionId,
    sheetId: rendered.id,
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 1,
    width: 850,
    height: 1100,
    region: rendered.box,
    dpi: 100,
    pdfToPixels: [1, 0, 0, 1, 0, 0],
    pixelsToPdf: [1, 0, 0, 1, 0, 0],
    operationId: crypto.randomUUID(),
  });

/** Ports whose render and image loads complete only when the test releases them. */
function ports(selected: () => typeof ProjectId.Type | null) {
  const released: Array<string> = [];
  const renders: Array<PromiseWithResolvers<void>> = [];
  let images = 0;

  const view: SourceViewClass = new SourceView({
    render: async (request) => {
      const gate = Promise.withResolvers<void>();
      renders.push(gate);
      await gate.promise;
      const rendered = [first, second].find((item) => item.id === request.sheetId) ?? first;

      return { ok: true, value: artifact(rendered) };
    },
    loadImage: async () => ({ ok: true, value: `blob:image-${++images}` }),
    selectedProject: selected,
    releaseImage: (url) => released.push(url),
  } satisfies SourceViewPorts);

  return { view, released, renders };
}

const first = sheet(0);
const second = sheet(1);
const render = { projectId, dpi: 100, overlays: () => [] };

test("a current render dropped because the project changed stops the loading state", async () => {
  let selected: typeof ProjectId.Type | null = projectId;
  const { view, renders } = ports(() => selected);
  const pending = view.renderSheet(first, render);
  expect(view.loading).toBe(true);
  selected = null;
  renders[0]?.resolve();

  expect(await pending).toBeNull();
  expect(view.loading).toBe(false);
  expect(view.imageUrl).toBe("");
});

test("a render claimed before a newer request leaves the newer request's canvas untouched", async () => {
  const { view, released, renders } = ports(() => projectId);
  const stale = view.begin();
  const newer = view.renderSheet(second, render);
  renders[0]?.resolve();
  expect(await newer).toBeNull();
  const shown = view.imageUrl;
  expect(shown).toStartWith("blob:");

  expect(await view.renderSheet(first, { ...render, request: stale })).toBeNull();
  expect(await view.openArtifact(stale, artifact(first), first, [])).toBeNull();
  expect(view.imageUrl).toBe(shown);
  expect(view.sheet?.id).toBe(second.id);
  expect(view.loading).toBe(false);
  expect(released).not.toContain(shown);
  expect(renders).toHaveLength(1);
});
