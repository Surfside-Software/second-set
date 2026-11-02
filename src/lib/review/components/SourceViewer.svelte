<script lang="ts">
  import { ReviewInputError, type Affine, type Region, type Sheet } from "#lib/review/contracts.ts";
  import { invertTransform, transformRegion } from "#lib/review/geometry.ts";
  import { tip } from "#lib/review/tooltip.ts";
  import ReviewIcon from "./ReviewIcon.svelte";

  let {
    imageUrl,
    pdfToPixels,
    overlays = [],
    masks = [],
    label = "Source view",
    selecting = $bindable(false),
    onSelectRegion,
    sheets = [],
    currentSheetId = null,
    onSheet,
    zoomFactor = $bindable(1),
  }: {
    imageUrl: string;
    pdfToPixels: typeof Affine.Type;
    overlays?: ReadonlyArray<{ region: Region; title: string }>;
    /** SAM mask outlines in the displayed image's pixel space. */
    masks?: ReadonlyArray<{ path: string; transform: string }>;
    label?: string;
    selecting?: boolean;
    onSelectRegion?: ((region: Region) => void) | undefined;
    sheets?: ReadonlyArray<Sheet>;
    currentSheetId?: Sheet["id"] | null;
    onSheet?: ((sheet: Sheet) => void) | undefined;
    zoomFactor?: number;
  } = $props();

  let scale = $state(1);
  let rotation = $state(0);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let imageWidth = $state(1);
  let imageHeight = $state(1);
  let selection = $state<{ x: number; y: number; width: number; height: number } | null>(null);
  let selectionStart = { x: 0, y: 0 };
  let sheetQuery = $state("");
  const currentIndex = $derived(sheets.findIndex((sheet) => sheet.id === currentSheetId));

  const matchingSheets = $derived(
    sheets.filter((sheet) =>
      `${sheet.label} page ${sheet.pageIndex + 1}`
        .toLowerCase()
        .includes(sheetQuery.trim().toLowerCase()),
    ),
  );

  function moveSheet(direction: -1 | 1) {
    const sheet = sheets[currentIndex + direction];

    if (sheet && currentIndex >= 0) onSheet?.(sheet);
  }

  function imagePoint(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    const bounds = event.currentTarget.getBoundingClientRect();

    const x =
      (event.clientX - bounds.left - event.currentTarget.clientLeft - viewportWidth / 2 - panX) /
      scale;

    const y =
      (event.clientY - bounds.top - event.currentTarget.clientTop - viewportHeight / 2 - panY) /
      scale;

    const angle = (rotation * Math.PI) / 180;

    return {
      x: Math.max(
        0,
        Math.min(imageWidth, x * Math.cos(angle) + y * Math.sin(angle) + imageWidth / 2),
      ),
      y: Math.max(
        0,
        Math.min(imageHeight, -x * Math.sin(angle) + y * Math.cos(angle) + imageHeight / 2),
      ),
    };
  }

  const transformStyle = $derived(
    `translate(${viewportWidth / 2 + panX}px, ${viewportHeight / 2 + panY}px) rotate(${rotation}deg) scale(${scale}) translate(${-imageWidth / 2}px, ${-imageHeight / 2}px)`,
  );

  const pixelOverlays = $derived(
    overlays.map((overlay) => ({
      title: overlay.title,
      region: transformRegion(pdfToPixels, overlay.region),
    })),
  );

  // A sheet turned a quarter fills the view by its other dimensions.
  function fitScale() {
    if (viewportWidth <= 0 || viewportHeight <= 0 || imageWidth <= 0 || imageHeight <= 0)
      return null;
    const turned = rotation % 180 !== 0;
    const width = turned ? imageHeight : imageWidth;
    const height = turned ? imageWidth : imageHeight;

    return Math.min(viewportWidth / width, viewportHeight / height) * 0.95;
  }

  /** Zoom keeping the sheet point under the anchor in place; the view's center by default. */
  function setScale(next: number, anchorX = viewportWidth / 2, anchorY = viewportHeight / 2) {
    if (fitScale() === null || !Number.isFinite(next)) return;
    const clamped = Math.min(8, Math.max(0.02, next));
    const ratio = clamped / scale;
    panX = anchorX - viewportWidth / 2 - (anchorX - viewportWidth / 2 - panX) * ratio;
    panY = anchorY - viewportHeight / 2 - (anchorY - viewportHeight / 2 - panY) * ratio;
    scale = clamped;
    const fit = fitScale();

    if (fit !== null) zoomFactor = scale / fit;
  }

  function zoom(delta: number) {
    setScale(scale * (delta > 0 ? 1.25 : 0.8));
  }

  function resetZoom() {
    const fit = fitScale();

    if (fit === null) return;
    scale = fit;
    panX = 0;
    panY = 0;
    zoomFactor = 1;
  }

  function rotate(direction: -1 | 1) {
    const fitted =
      Math.abs(zoomFactor - 1) < 0.001 && Math.abs(panX) < 0.001 && Math.abs(panY) < 0.001;

    rotation = (rotation + direction * 90 + 360) % 360;

    // What sits at the center of the view stays there as the sheet turns around it.
    [panX, panY] = direction === 1 ? [-panY, panX] : [panY, -panX];

    if (fitted) {
      resetZoom();

      return;
    }

    const fit = fitScale();

    if (fit !== null) zoomFactor = scale / fit;
  }

  // Control + wheel, and a trackpad pinch, which browsers report as a wheel event with ctrlKey.
  // A pinch's delta is the log of its scale, so it applies exactly; a mouse notch is much larger,
  // and the bound keeps one notch to about one zoom button press.
  function attachWheelZoom(element: HTMLDivElement) {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();

      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * viewportHeight
            : event.deltaY;

      const bounds = element.getBoundingClientRect();

      setScale(
        scale * Math.exp(-Math.max(-25, Math.min(25, delta)) / 100),
        event.clientX - bounds.left - element.clientLeft,
        event.clientY - bounds.top - element.clientTop,
      );
    };

    element.addEventListener("wheel", onWheel, { passive: false });

    return () => element.removeEventListener("wheel", onWheel);
  }

  function onPointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (fitScale() === null) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (selecting) {
      selectionStart = imagePoint(event);
      selection = { ...selectionStart, width: 0, height: 0 };
    }
  }

  function onPointerMove(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (!dragging) return;

    if (selecting) {
      const point = imagePoint(event);
      selection = {
        x: Math.min(selectionStart.x, point.x),
        y: Math.min(selectionStart.y, point.y),
        width: Math.abs(point.x - selectionStart.x),
        height: Math.abs(point.y - selectionStart.y),
      };

      return;
    }

    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    dragging = false;
    const element = event.currentTarget;

    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

    if (
      event.type !== "pointercancel" &&
      selecting &&
      selection &&
      selection.width * scale > 3 &&
      selection.height * scale > 3
    ) {
      const inverse = invertTransform(pdfToPixels);

      if (!(inverse instanceof ReviewInputError))
        onSelectRegion?.(transformRegion(inverse, selection));
      selecting = false;
    }

    selection = null;
  }
</script>

<section class="viewer" aria-label={label}>
  <div class="viewer-controls">
    {#if onSheet && sheets.length > 0}
      <nav class="sheet-navigation" aria-label="Source sheets">
        <button
          type="button"
          class="icon-btn"
          aria-label="Previous sheet"
          disabled={currentIndex <= 0 || selecting}
          onclick={() => moveSheet(-1)}><ReviewIcon name="chevron-left" /></button
        >
        <span class="sheet-position">{currentIndex + 1} of {sheets.length}</span>
        <button
          type="button"
          class="icon-btn"
          aria-label="Next sheet"
          disabled={currentIndex < 0 || currentIndex >= sheets.length - 1 || selecting}
          onclick={() => moveSheet(1)}><ReviewIcon name="chevron-right" /></button
        >
        <details>
          <summary>Jump to sheet</summary>
          <div class="sheet-picker">
            <input
              aria-label="Find source sheet"
              type="search"
              bind:value={sheetQuery}
              placeholder="Sheet or page…"
            />
            {#each matchingSheets as sheet (sheet.id)}<button
                type="button"
                class="sheet-option"
                disabled={selecting}
                aria-current={sheet.id === currentSheetId ? "page" : undefined}
                onclick={(event) => {
                  onSheet(sheet);
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}>{sheet.label} · page {sheet.pageIndex + 1}</button
              >{/each}
            {#if matchingSheets.length === 0}<p>No matching sheet.</p>{/if}
          </div>
        </details>
      </nav>
    {/if}
    <div class="viewer-toolbar" role="toolbar" aria-label="Sheet view">
      <button
        type="button"
        class="icon-btn"
        aria-label="Zoom out"
        {...tip("Or hold Ctrl and scroll, or pinch on a trackpad.", "Zoom out")}
        onclick={() => zoom(-0.2)}><ReviewIcon name="zoom-out" /></button
      >
      <button
        type="button"
        class="zoom-level"
        aria-label="Reset zoom"
        data-testid="zoom-level"
        {...tip("Fit the whole sheet in view.", "Reset zoom")}
        onclick={resetZoom}>{Math.round(zoomFactor * 100)}%</button
      >
      <button
        type="button"
        class="icon-btn"
        aria-label="Zoom in"
        {...tip("Or hold Ctrl and scroll, or pinch on a trackpad.", "Zoom in")}
        onclick={() => zoom(0.2)}><ReviewIcon name="zoom-in" /></button
      >
      <span class="toolbar-divider" role="separator" aria-orientation="vertical"></span>
      <button
        type="button"
        class="icon-btn"
        aria-label="Rotate sheet counterclockwise"
        {...tip("Turn the sheet 90° to the left.", "Rotate counterclockwise")}
        onclick={() => rotate(-1)}><ReviewIcon name="rotate-2" size={20} /></button
      >
      <button
        type="button"
        class="icon-btn"
        aria-label="Rotate sheet clockwise"
        {...tip("Turn the sheet 90° to the right.", "Rotate clockwise")}
        onclick={() => rotate(1)}><ReviewIcon name="rotate-clockwise-2" size={20} /></button
      >
    </div>
  </div>
  {#if selecting}<p class="selection-help" role="status">
      Drag a box around the area to count. <button
        type="button"
        class="text-link"
        onclick={() => {
          selecting = false;
          selection = null;
        }}>Cancel</button
      >
    </p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The image canvas supports focusable keyboard pan and zoom.) -->
  <div
    class="viewport"
    class:selecting
    role="application"
    aria-label="Pan and zoom source canvas"
    tabindex="0"
    bind:clientWidth={viewportWidth}
    bind:clientHeight={viewportHeight}
    {@attach attachWheelZoom}
    onkeydown={(event) => {
      if (event.key === "+" || event.key === "=") zoom(0.2);
      else if (event.key === "-") zoom(-0.2);
      else if (event.key === "ArrowLeft") panX += 24;
      else if (event.key === "ArrowRight") panX -= 24;
      else if (event.key === "ArrowUp") panY += 24;
      else if (event.key === "ArrowDown") panY -= 24;
      else return;
      event.preventDefault();
    }}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    <div class="transform-layer" style={`transform: ${transformStyle}`}>
      <img
        src={imageUrl}
        alt=""
        draggable="false"
        onload={(event) => {
          if (!(event.currentTarget instanceof HTMLImageElement)) return;
          imageWidth = event.currentTarget.naturalWidth;
          imageHeight = event.currentTarget.naturalHeight;
          rotation = 0;
          scale = (fitScale() ?? 1) * zoomFactor;
          panX = 0;
          panY = 0;
        }}
      />
      {#if masks.length}<svg
          class="masks"
          width={imageWidth}
          height={imageHeight}
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          aria-hidden="true"
          >{#each masks as mask, index (index)}<path
              d={mask.path}
              transform={mask.transform}
            />{/each}</svg
        >{/if}
      {#each pixelOverlays as overlay, index (index)}
        <div
          class="overlay"
          style={`left:${overlay.region.x}px;top:${overlay.region.y}px;width:${overlay.region.width}px;height:${overlay.region.height}px`}
          title={overlay.title}
        ></div>
      {/each}
      {#if selection}<div
          class="overlay"
          style={`left:${selection.x}px;top:${selection.y}px;width:${selection.width}px;height:${selection.height}px`}
        ></div>{/if}
    </div>
  </div>
</section>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-height: 0;
    flex: 0 0 300px;
    height: 300px;
  }
  .selection-help {
    font-size: var(--text-mono-sm);
    margin: 0;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .text-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-accent);
    font-weight: 500;
  }
  .text-link:hover {
    color: var(--color-accent-hover);
  }
  .viewport.selecting {
    cursor: crosshair;
  }
  .viewer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px var(--space-md);
    flex-shrink: 0;
  }
  .viewer-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .zoom-level {
    min-width: 52px;
    height: 32px;
    padding: 0 var(--space-2xs);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--tracking-wide);
    transition:
      color var(--duration-fast) var(--ease-out),
      background var(--duration-fast) var(--ease-out);
  }
  .zoom-level:hover {
    background: var(--color-slate);
    color: var(--color-text);
  }
  .toolbar-divider {
    width: 1px;
    height: 20px;
    margin: 0 var(--space-xs);
    background: var(--color-border-strong);
  }
  .sheet-navigation {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-size: var(--text-body-sm);
  }
  .sheet-position {
    min-width: 56px;
    text-align: center;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
  }
  .sheet-navigation details {
    position: relative;
    margin-left: var(--space-xs);
  }
  .sheet-navigation summary {
    height: 32px;
    padding: 0 10px 0 var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-label-sm);
    font-weight: 600;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    transition: border-color var(--duration-fast) var(--ease-out);
  }
  .sheet-navigation summary:hover {
    border-color: var(--color-bone);
  }
  .sheet-navigation summary::before {
    order: 1;
    -webkit-mask-image: var(--icon-chevron-down);
    mask-image: var(--icon-chevron-down);
  }
  .sheet-navigation details[open] > summary::before {
    transform: rotate(180deg);
  }
  .sheet-picker {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 2;
    display: grid;
    gap: 2px;
    width: min(300px, 60vw);
    max-height: 240px;
    overflow-y: auto;
    padding: var(--space-2xs);
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }
  .sheet-picker input {
    margin-bottom: var(--space-2xs);
  }
  .sheet-picker p {
    margin: 0;
    padding: 6px var(--space-xs);
    color: var(--color-text-muted);
  }
  .sheet-option {
    min-height: 32px;
    padding: 0 var(--space-xs);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    text-align: left;
  }
  .sheet-option:hover:not(:disabled) {
    background: var(--color-slate);
  }
  .sheet-option[aria-current="page"] {
    background: var(--color-slate);
    box-shadow: inset 2px 0 0 var(--color-ember);
  }
  .sheet-option[aria-current="page"]:focus-visible {
    box-shadow:
      inset 2px 0 0 var(--color-ember),
      var(--shadow-focus-ring);
  }
  .viewport {
    position: relative;
    flex: 1;
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-ink);
    touch-action: none;
    cursor: grab;
  }
  .viewport:active {
    cursor: grabbing;
  }
  .viewport:focus-visible {
    border-color: var(--color-accent);
    box-shadow: var(--shadow-focus);
  }
  .transform-layer {
    position: relative;
    transform-origin: 0 0;
    display: inline-block;
  }
  .transform-layer img {
    display: block;
    max-width: none;
    user-select: none;
  }
  .masks {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
  }
  .masks path {
    fill: rgb(246 90 26 / 0.3);
  }
  .overlay {
    position: absolute;
    border: 2px solid var(--color-ember);
    background: rgb(246 90 26 / 0.06);
    pointer-events: none;
    box-sizing: border-box;
  }
</style>
