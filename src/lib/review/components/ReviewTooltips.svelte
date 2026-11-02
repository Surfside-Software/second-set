<script lang="ts">
  import { onMount, tick } from "svelte";

  const hoverDelay = 280;
  const gap = 8;
  const margin = 8;

  let element = $state<HTMLDivElement>();
  let active: HTMLElement | null = null;
  let displayed: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refresher: ReturnType<typeof setInterval> | undefined;
  let frame: number | undefined;
  let title = $state("");
  let text = $state("");
  let side = $state<"above" | "below">("above");
  let arrow = $state(0);

  const tipOf = (node: EventTarget | null) =>
    node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null;

  const hasKeyboardFocus = (target: HTMLElement) =>
    target.contains(document.activeElement) && document.activeElement?.matches(":focus-visible");

  const isActive = (target: HTMLElement | null): target is HTMLElement =>
    target !== null &&
    target.isConnected &&
    Boolean(target.dataset.tip) &&
    document.visibilityState !== "hidden" &&
    (target.matches(":hover") || Boolean(hasKeyboardFocus(target)));

  function read(target: HTMLElement) {
    title = target.dataset.tipTitle ?? "";
    text = target.dataset.tip ?? "";
  }

  function place(target: HTMLElement) {
    if (!element) return;
    const anchor = target.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const fitsAbove = anchor.top >= size.height + gap + margin;
    const center = anchor.left + anchor.width / 2;

    const left = Math.max(
      margin,
      Math.min(center - size.width / 2, window.innerWidth - size.width - margin),
    );

    side = fitsAbove ? "above" : "below";
    arrow = Math.max(12, Math.min(center - left, size.width - 12));
    element.style.left = `${left}px`;
    element.style.top = `${fitsAbove ? anchor.top - size.height - gap : anchor.bottom + gap}px`;
  }

  function queueUpdate() {
    if (frame !== undefined) return;

    // Focus events can run inside a Svelte render or another popover's show operation.
    // Coalesce them outside that stack before changing state or the browser's top layer.
    frame = requestAnimationFrame(() => {
      frame = undefined;
      void update();
    });
  }

  async function update() {
    const target = active;

    if (!isActive(target)) {
      hide();

      return;
    }

    read(target);
    await tick();

    if (active !== target || !target.isConnected || !element?.isConnected) return;

    // The top layer keeps a tooltip above dialogs, menus and clipped panels.
    // A new target may belong to a dialog or menu opened since the previous tooltip.
    if (displayed !== target && element.matches(":popover-open")) element.hidePopover();

    if (!element.matches(":popover-open")) element.showPopover();

    displayed = target;
    place(target);
    clearInterval(refresher);

    // Counts in a tooltip stay live, and a removed target takes its tooltip with it.
    refresher = setInterval(() => {
      if (isActive(active)) queueUpdate();
      else hide();
    }, 500);
  }

  function hide() {
    clearTimeout(timer);
    clearInterval(refresher);

    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    active = null;
    displayed = null;

    // Dismiss synchronously: hidden windows can suspend animation frames indefinitely.
    if (element?.matches(":popover-open")) element.hidePopover();
  }

  function schedule(target: HTMLElement, delay: number) {
    clearTimeout(timer);
    active = target;

    // Moving between neighboring controls keeps the tooltip responsive once one is open.
    if (delay === 0 || element?.matches(":popover-open")) queueUpdate();
    else {
      // A queued hide or refresh must not reveal a new target before its hover delay.
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      timer = setTimeout(queueUpdate, delay);
    }
  }

  onMount(() => {
    const controller = new AbortController();
    const { signal } = controller;

    document.addEventListener(
      "pointerover",
      (event) => {
        if (event.pointerType === "touch") return;
        const target = tipOf(event.target);

        if (target === active) return;

        // Layout changes can put a plain element under a stationary pointer during tabbing.
        if (!target && active && hasKeyboardFocus(active)) return;

        if (target) schedule(target, hoverDelay);
        else hide();
      },
      { signal },
    );
    document.addEventListener("pointerdown", hide, { signal });
    document.addEventListener(
      "focusin",
      (event) => {
        const target = tipOf(event.target);

        if (target?.matches(":focus-visible")) schedule(target, 0);
      },
      { signal },
    );
    document.addEventListener(
      "focusout",
      (event) => {
        if (tipOf(event.target) === active) hide();
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") hide();
      },
      { signal },
    );
    document.addEventListener(
      "scroll",
      () => {
        // Browser scrolling can settle after pointerover or focusin. Keep a pending hover delay,
        // and reposition an open tooltip once the target's hover/focus state has settled.
        if (element?.matches(":popover-open")) queueUpdate();
      },
      { signal, capture: true, passive: true },
    );
    window.addEventListener("blur", hide, { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") hide();
      },
      { signal },
    );

    return () => {
      controller.abort();
      hide();
    };
  });
</script>

<div
  class="review-tooltip"
  popover="manual"
  role="tooltip"
  data-side={side}
  data-testid="review-tooltip"
  style:--arrow={`${arrow}px`}
  bind:this={element}
>
  {#if title}<strong>{title}</strong>{/if}{#if text}<span>{text}</span>{/if}
</div>

<style>
  .review-tooltip {
    position: fixed;
    inset: auto;
    width: max-content;
    max-width: 280px;
    margin: 0;
    padding: var(--space-xs) 10px;
    overflow: visible;
    display: none;
    pointer-events: none;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-slate);
    color: color-mix(in srgb, var(--color-text) 80%, var(--color-text-muted));
    box-shadow: var(--shadow-pop);
    font-family: var(--font-body);
    font-size: var(--text-mono-sm);
    font-weight: 400;
    line-height: var(--leading-normal);
    letter-spacing: normal;
    text-align: left;
    text-transform: none;
    white-space: normal;
    opacity: 1;
    transform: translateY(0);
    transition:
      opacity var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }
  .review-tooltip:popover-open {
    display: grid;
    gap: 2px;
  }
  @starting-style {
    .review-tooltip:popover-open {
      opacity: 0;
    }
    .review-tooltip:popover-open[data-side="above"] {
      transform: translateY(3px);
    }
    .review-tooltip:popover-open[data-side="below"] {
      transform: translateY(-3px);
    }
  }
  /* A small pointer, drawn from the panel's own border so it reads as one shape. */
  .review-tooltip::after {
    content: "";
    position: absolute;
    left: calc(var(--arrow) - 4px);
    width: 8px;
    height: 8px;
    border: solid var(--color-border-strong);
    background: var(--color-slate);
    transform: rotate(45deg);
  }
  .review-tooltip[data-side="above"]::after {
    bottom: -5px;
    border-width: 0 1px 1px 0;
  }
  .review-tooltip[data-side="below"]::after {
    top: -5px;
    border-width: 1px 0 0 1px;
  }
  strong {
    color: var(--color-text);
    font-size: var(--text-mono-sm);
    font-weight: 600;
  }
  span {
    overflow-wrap: anywhere;
  }
</style>
