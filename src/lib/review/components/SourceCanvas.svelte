<script lang="ts">
  import type { Region, Revision, Sheet } from "#lib/review/contracts.ts";
  import type { PacketFindingFocus } from "#lib/review/packet.ts";
  import type { SourceView } from "#lib/review/source-view.svelte.ts";
  import { tip } from "#lib/review/tooltip.ts";
  import SourceViewer from "./SourceViewer.svelte";

  let {
    view,
    revisions,
    provenance,
    sheets = [],
    onSheet,
    masks = [],
    focus = null,
    selecting = $bindable(false),
    onSelectRegion,
  }: {
    view: SourceView;
    revisions: ReadonlyArray<Revision>;
    /** A count check's render names its DPI and source hash; a sheet view names partial pages. */
    provenance: "render" | "sheet";
    /** Sheets of the same revision, for previous and next navigation. */
    sheets?: ReadonlyArray<Sheet>;
    onSheet?: (sheet: Sheet) => void;
    masks?: ReadonlyArray<{ path: string; transform: string }>;
    /** The finding's SAM zoom, while its artifact is the displayed source. */
    focus?: typeof PacketFindingFocus.Type | null;
    selecting?: boolean;
    onSelectRegion?: (region: Region) => void;
  } = $props();

  const revision = $derived(revisions.find((item) => item.id === view.sheet?.revisionId));

  // A saved model render can be a partial crop even when a location only names the sheet.
  const crop = $derived(
    view.artifact?.region != null &&
      view.sheet !== null &&
      (view.artifact.region.width < view.sheet.box.width * 0.98 ||
        view.artifact.region.height < view.sheet.box.height * 0.98),
  );
</script>

{#if view.loading}<p class="muted" role="status">
    Rendering source…
  </p>{:else if view.imageUrl}<SourceViewer
    bind:zoomFactor={view.zoom}
    {sheets}
    currentSheetId={view.sheet?.id ?? null}
    {onSheet}
    imageUrl={view.imageUrl}
    pdfToPixels={view.artifact?.pdfToPixels ?? [1, 0, 0, 1, 0, 0]}
    overlays={view.overlays}
    {masks}
    label="Original source render"
    bind:selecting
    {onSelectRegion}
  />{/if}
{#if provenance === "render"}
  {#if view.sheet && view.artifact}<div class="source-provenance selectable">
      <strong>{view.sheet.label}</strong><span
        {...tip(`Source SHA ${revision?.sha256.slice(0, 16)}`)}
        >{revision?.name} · page {view.sheet.pageIndex + 1} · {view.artifact.dpi} DPI</span
      >
    </div>{/if}
{:else if view.sheet}
  <div class="source-provenance selectable">
    <strong>{view.sheet.label}</strong><span
      >{revision?.name} · page {view.sheet.pageIndex + 1}{crop ? " · partial view" : ""}</span
    >
    {#if focus}<span
        class="tag"
        data-testid="sam-focus-caption"
        {...tip("SAM 3.1 outlines are proposals, not verified symbols.")}
        >{focus.segments.length} SAM {focus.segments.length === 1 ? "segment" : "segments"}</span
      >{/if}
  </div>
{/if}

<style>
  .muted {
    color: var(--color-text-muted);
  }
  .source-provenance {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--space-xs);
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .source-provenance strong {
    color: var(--color-text);
    font-size: var(--text-body-sm);
    font-weight: 600;
  }
</style>
