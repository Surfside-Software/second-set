<script lang="ts">
  import { Schema } from "effect";
  import {
    citationStanding,
    citationStandingLabels,
    type PacketCitation,
  } from "#lib/review/packet.ts";
  import { ReviewSourceUrl } from "#lib/review/source-url.ts";
  import { tip } from "#lib/review/tooltip.ts";
  import ReviewIcon from "./ReviewIcon.svelte";

  let {
    citation,
    onOpen,
  }: {
    citation: typeof PacketCitation.Type;
    onOpen: (url: string) => void;
  } = $props();

  const standing = $derived(citationStanding(citation));
  const reference = $derived(citation.reference);
  const name = $derived(reference?.title ?? citation.section);

  const originalCitation = $derived(
    [citation.document, citation.edition, citation.section].filter(Boolean).join(" · "),
  );

  const volume = $derived(
    reference
      ? `${reference.document} · ${reference.edition}`
      : [citation.document, citation.edition].filter(Boolean).join(" · "),
  );

  const differentVolume = $derived(
    reference !== undefined &&
      (reference.document !== citation.document || reference.edition !== citation.edition),
  );

  const help = $derived({
    verified: "The quote was found in the official text Moke retrieved.",
    indexed: `This link comes from Moke's Florida code index. ${reference?.access === "open_in_browser" ? "Official text isn't available for automated reading. " : ""}Its wording is unconfirmed. Open the section to check it.`,
    unverified:
      "The wording hasn't been confirmed against retrieved official text. Check it by hand.",
    incorrect: "The citation doesn't match the governing text.",
  } as const);

  const openable = $derived(
    reference !== undefined && Schema.is(ReviewSourceUrl)(reference.url) ? reference.url : null,
  );

  // An indexed citation's wording has not been confirmed against the official section.
  const showQuote = $derived(citation.quote.length > 0 && standing !== "indexed");
</script>

<div class="citation" data-testid="citation-row" data-standing={standing}>
  <details>
    <summary {...tip(help[standing])}>
      <span
        class={[
          "tag",
          {
            success: standing === "verified",
            error: standing === "incorrect",
            accent: standing === "unverified",
          },
        ]}>{citationStandingLabels[standing]}</span
      >
      <span class="name">{name}</span>
      {#if volume}<span class="volume">{volume}</span>{/if}
    </summary>
    <div class="detail selectable">
      {#if differentVolume}<p class="detail-volume">{volume}</p>{/if}
      <p class="note">
        {originalCitation}{citation.jurisdiction ? ` · ${citation.jurisdiction}` : ""}
      </p>
      {#if reference?.check}<p>{reference.check}</p>{/if}
      {#if citation.application}<p>{citation.application}</p>{/if}
      {#if showQuote}<blockquote>{citation.quote}</blockquote>{/if}
      {#if citation.note}<p class="note">{citation.note}</p>{/if}
    </div>
  </details>
  {#if openable}<button
      type="button"
      class="icon-btn"
      aria-label={`Open ${name}`}
      {...tip(
        reference?.access === "open_in_browser"
          ? "Open this section in your browser to confirm its wording."
          : "Open this section in your browser.",
      )}
      onclick={() => {
        if (openable) onOpen(openable);
      }}><ReviewIcon name="arrow-up-right" /></button
    >{/if}
</div>

<style>
  .citation {
    container-type: inline-size;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 32px;
    align-items: start;
    gap: var(--space-xs);
    padding: 2px 0;
    border-top: 1px solid var(--color-border);
  }
  details {
    min-width: 0;
  }
  summary {
    width: 100%;
    min-height: 32px;
    color: var(--color-text);
  }
  .tag {
    height: 20px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .volume {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    display: grid;
    gap: var(--space-2xs);
    padding: 0 0 var(--space-xs) 20px;
  }
  .detail-volume {
    display: none;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  @container (max-width: 480px) {
    .volume {
      display: none;
    }
    .detail-volume {
      display: block;
    }
    .name {
      overflow: visible;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    summary {
      align-items: flex-start;
      padding-block: 6px;
    }
    .tag {
      flex-shrink: 0;
    }
  }
  p {
    margin: 0;
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  blockquote {
    margin: var(--space-2xs) 0;
    padding-left: var(--space-sm);
    border-left: 2px solid var(--color-border-strong);
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }
</style>
