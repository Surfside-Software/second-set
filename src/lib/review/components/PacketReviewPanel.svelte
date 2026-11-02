<script lang="ts">
  import { onMount } from "svelte";
  import { Match, Schema } from "effect";
  import {
    cachedPromptShare,
    citationStanding,
    citationStandingLabels,
    packetFindingText,
    packetVerdictLabels,
    type PacketReview,
  } from "#lib/review/packet.ts";
  import { packetCoverageProgress, packetProjectFacts } from "#lib/review/packet-coverage.ts";
  import { ReviewSourceUrl } from "#lib/review/source-url.ts";
  import { tip } from "#lib/review/tooltip.ts";
  import CitationRow from "./CitationRow.svelte";
  import CoverageMatrix from "./CoverageMatrix.svelte";
  import ReviewIcon from "./ReviewIcon.svelte";
  import ReviewText from "./ReviewText.svelte";
  import { formatElapsed } from "./review-format.ts";

  let {
    review,
    busy = false,
    historical = false,
    onControl,
    onFinding,
    onExport,
    onOpenSource,
    onRefresh,
    onCopyDiagnostics,
  }: {
    review: PacketReview;
    busy?: boolean;
    historical?: boolean;
    onControl: (action: "pause" | "resume" | "cancel", maxCalls?: number | null) => Promise<void>;
    onFinding: (findingId: string) => Promise<void>;
    onExport: () => Promise<void>;
    onOpenSource: (url: string) => Promise<void>;
    onRefresh?: () => Promise<void>;
    onCopyDiagnostics: () => Promise<boolean>;
  } = $props();

  let diagnosticNotice = $state("");

  async function copyDiagnostics() {
    const copied = await onCopyDiagnostics();
    diagnosticNotice = copied
      ? "Review diagnostics copied."
      : "Copy is unavailable. The saved review report contains the failure details.";
  }

  const failureMessage = $derived(
    review.state === "cancelled"
      ? review.error?.replace(/\s*Cancel this review before starting a separate review\.\s*$/, "")
      : review.error,
  );

  let additionalCallsDraft = $state<string | null>(null);
  const additionalCalls = $derived(Number(additionalCallsDraft ?? review.maxCalls ?? 1));
  const extendedBudget = $derived(review.admittedCalls + additionalCalls);
  const cachedShare = $derived(cachedPromptShare(review.promptUsage));

  // Large reviews run setup, one reviewer per sheet, then cross-sheet coordination.
  const stageLine = $derived.by(() => {
    if (review.parallel === undefined || review.state !== "running") return null;
    const { stage, sheets } = review.parallel;

    if (stage === "setup") return "Setting up project facts";

    if (stage === "coordination") return "Comparing sheets";

    const count = (state: string) => sheets.filter((entry) => entry.state === state).length;

    return `Reviewers: ${count("running")} running · ${count("completed")} of ${sheets.length} done${
      count("failed") > 0 ? ` · ${count("failed")} stopped` : ""
    }`;
  });

  const validAdditionalCalls = $derived(
    Number.isSafeInteger(additionalCalls) &&
      additionalCalls > 0 &&
      Number.isSafeInteger(extendedBudget),
  );

  const budgetExhausted = $derived(
    review.state === "paused" &&
      review.maxCalls !== null &&
      review.admittedCalls >= review.maxCalls,
  );

  let now = $state(Date.now());
  const running = $derived(review.state === "running");

  const elapsed = $derived(
    Math.max(
      0,
      review.activeDurationMs === undefined
        ? (running ? now : review.changedAt) - review.startedAt
        : review.activeDurationMs +
            (running && review.activeSince != null ? now - review.activeSince : 0),
    ),
  );

  const scope = $derived(
    Match.value(review.scope).pipe(
      Match.tagsExhaustive({
        SelectedSheets: () => "Selected sheets",
        WholeSet: () => "Whole set",
        Discipline: ({ discipline }) => discipline.replaceAll("_", " "),
      }),
    ),
  );

  const coverageProgress = $derived(packetCoverageProgress(review));

  // Needs-input and unexplained not-applicable passes count as recorded but leave a gap.
  const unsettledRecorded = $derived(coverageProgress.recorded - coverageProgress.settled);

  const hasCoverageGaps = $derived(
    review.sheets.some((sheet) => !review.inspectedSheetIds.includes(sheet.id)) ||
      !coverageProgress.complete,
  );

  const hasReviewGaps = $derived(
    review.missingInputs.length > 0 ||
      review.findings.some((finding) => finding.status === "Needs input") ||
      review.citations.some((citation) => citation.status !== "verified"),
  );

  const toConfirm = $derived(
    review.citations.filter((citation) => citationStanding(citation) === "indexed").length,
  );

  const standingCounts = $derived(
    (["indexed", "verified", "unverified", "incorrect"] as const).flatMap((standing) => {
      const count = review.citations.filter(
        (citation) => citationStanding(citation) === standing,
      ).length;

      return count > 0 ? [`${count} ${citationStandingLabels[standing].toLowerCase()}`] : [];
    }),
  );

  const projectFacts = $derived(packetProjectFacts(review.projectConfiguration));
  const factsNeedingInput = $derived(projectFacts.filter((fact) => fact.needsInput).length);

  // What "with gaps" means for this review, on hover of the heading.
  const stateHelp = $derived.by(() => {
    if (running || !review.finished) return undefined;

    const unsettled = coverageProgress.total - coverageProgress.settled;
    const needInput = review.findings.filter((finding) => finding.status === "Needs input").length;

    const parts = [
      unsettled > 0 ? `${unsettled} review passes still open` : "",
      review.missingInputs.length > 0 ? `${review.missingInputs.length} inputs missing` : "",
      needInput > 0 ? `${needInput} findings need input` : "",
      toConfirm > 0 ? `${toConfirm} code sections for you to confirm` : "",
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });

  const stateLabel = $derived(
    running
      ? "Review in progress"
      : review.state === "paused"
        ? "Review paused"
        : review.state === "uncertain"
          ? "Review needs attention"
          : review.state === "cancelled"
            ? "Review cancelled"
            : review.state === "failed"
              ? "Review stopped"
              : hasCoverageGaps
                ? "Review finished with coverage gaps"
                : !review.finished || hasReviewGaps
                  ? "Review finished with gaps"
                  : "Review finished",
  );

  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);

    return () => clearInterval(timer);
  });
</script>

<section
  class={["packet-review", { running }]}
  aria-label={`${scope} review`}
  data-testid={historical ? "historical-review-panel" : "packet-review-panel"}
>
  <header>
    <div class="heading">
      {#if running}<span class="live-dot" aria-hidden="true"></span>{/if}
      <h2 class:thinking-text={running} {...stateHelp ? tip(stateHelp) : {}}>
        {stateLabel}
      </h2>
      <span class="tag scope">{scope}</span>
    </div>
    <span class="duration" aria-label="Review elapsed time">{formatElapsed(elapsed)}</span>
  </header>
  <div
    class="meter"
    role="progressbar"
    aria-label="Review passes recorded"
    aria-valuemin="0"
    aria-valuemax={coverageProgress.total}
    aria-valuenow={coverageProgress.recorded}
  >
    <span
      style:width={`${(coverageProgress.recorded / Math.max(1, coverageProgress.total)) * 100}%`}
    ></span>
  </div>
  <p
    class="progress"
    role="status"
    {...tip(
      "Every sheet gets four passes for each discipline: completeness, code, coordination and prior comments.",
      "Review passes",
    )}
  >
    {review.inspectedSheetIds.length} of {review.sheets.length}
    {review.sheets.length === 1 ? "sheet" : "sheets"} · {coverageProgress.recorded}
    of
    {coverageProgress.total} passes{unsettledRecorded > 0
      ? ` · ${unsettledRecorded} ${unsettledRecorded === 1 ? "needs" : "need"} input`
      : ""}{stageLine ? ` · ${stageLine}` : ""}
  </p>
  {#if review.summary}<div class="summary">
      <ReviewText
        text={review.summary.length > 500 ? review.summary.slice(0, 500) + "…" : review.summary}
      />
    </div>
    {#if review.summary.length > 500}<details class="inline-record">
        <summary>Full review notes</summary>
        <ReviewText text={review.summary} />
      </details>{/if}{/if}
  {#if review.steering?.length}<details class="inline-record">
      <summary>Follow-up instructions · {review.steering.length}</summary
      >{#each review.steering as instruction (instruction.commandId)}<p>
          {instruction.text}
          <span class="muted"
            >{instruction.status === "queued"
              ? "Queued"
              : instruction.status === "applied"
                ? "Applied"
                : instruction.status === "pending"
                  ? "Saved"
                  : "Not answered"}</span
          >
        </p>{/each}
    </details>{/if}
  {#if failureMessage}<p class="attention" role="alert">{failureMessage}</p>{/if}
  <div class="actions">
    <button
      class="btn"
      disabled={busy}
      {...tip("Save a self-contained HTML report with evidence and coverage.")}
      onclick={onExport}>Export review report</button
    >
    {#if review.error || review.state !== "running"}<button
        class="btn"
        {...tip("Copy technical details for troubleshooting.")}
        onclick={copyDiagnostics}>Copy review diagnostics</button
      >{/if}
    {#if !historical && onRefresh}<button
        class="btn"
        disabled={busy}
        data-testid="refresh-review"
        {...tip("Reload this review's saved progress.")}
        onclick={onRefresh}>Refresh review</button
      >{/if}
    {#if running && !historical}<button
        class="btn"
        disabled={busy}
        {...tip("Stop after the current step. Resume any time.")}
        onclick={() => onControl("pause")}>Pause review</button
      >{/if}
    {#if budgetExhausted && !historical}<div class="budget-extension">
        <label
          >Additional calls<input
            type="number"
            min="1"
            step="1"
            value={additionalCallsDraft ?? String(review.maxCalls ?? 1)}
            disabled={busy}
            oninput={(event) => {
              additionalCallsDraft = event.currentTarget.value;
            }}
          /></label
        ><button
          class="btn"
          disabled={busy || !validAdditionalCalls}
          {...validAdditionalCalls
            ? tip(`New budget: ${extendedBudget} calls, ${review.admittedCalls} already used.`)
            : {}}
          onclick={() => onControl("resume", extendedBudget)}>Add calls and resume</button
        >
        {#if !validAdditionalCalls}<p class="muted">Enter a positive whole number.</p>{/if}
      </div>{:else if review.state === "paused" && !historical}<button
        class="btn"
        disabled={busy}
        onclick={() => onControl("resume")}>Resume review</button
      >{/if}
    {#if !historical && ["running", "paused", "uncertain"].includes(review.state)}<button
        class="btn"
        disabled={busy}
        onclick={() => onControl("cancel")}>Cancel review</button
      >{/if}
  </div>
  {#if diagnosticNotice}<p role="status" class="muted">{diagnosticNotice}</p>{/if}
  {#if review.state === "uncertain"}<p class="muted">
      The last request may have been charged and won't be sent again. Cancel to start a new review;
      saved work stays.
    </p>{/if}
  {#if review.findings.length > 0}
    <div class="findings">
      <h3>Review findings <span>{review.findings.length}</span></h3>
      {#each review.findings as finding (finding.id)}
        <button
          type="button"
          class="finding"
          data-testid={`packet-finding-${finding.id}`}
          data-decision={finding.decision?.verdict}
          onclick={() => onFinding(finding.id)}
          ><span class="severity" data-severity={finding.severity}>{finding.severity}</span><strong
            >{packetFindingText(finding).title}</strong
          ><span class="finding-status"
            >{finding.decision
              ? `${finding.status} · ${packetVerdictLabels[finding.decision.verdict]}`
              : finding.status}</span
          ></button
        >
      {/each}
    </div>
  {/if}
  <div class="records">
    {#if review.missingInputs.length > 0}<details class="record">
        <summary
          >Needs input<span class="record-meta attention-count">{review.missingInputs.length}</span
          ></summary
        >
        <ul class="record-body selectable">
          {#each review.missingInputs as input, index (`${index}:${input}`)}<li>{input}</li>{/each}
        </ul>
      </details>{/if}
    {#if review.citations.length > 0 || review.sources.length > 0}<details class="record">
        <summary
          >Sources and citations{#if standingCounts.length > 0}<span class="record-meta"
              >{standingCounts.join(" · ")}</span
            >{/if}</summary
        >
        <div class="record-body">
          {#each review.citations as citation (citation.id)}<CitationRow
              {citation}
              onOpen={(url) => void onOpenSource(url)}
            />{/each}
          {#if review.sources.length > 0}<h4>Retrieved sources</h4>{/if}
          {#each review.sources as source (source.id)}
            <div class="source" data-testid="source-row">
              <details>
                <summary
                  {...tip(
                    `${source.official ? "Official source. " : ""}${source.status === "available" ? "Retrieved and saved with this review." : "Text was not retrieved. Open the source to check it by hand."}`,
                  )}
                >
                  <span class={["tag", { success: source.status === "available" }]}
                    >{source.status === "available" ? "Read" : "Unavailable"}</span
                  >
                  <span class="source-name">{source.title || source.url}</span>
                </summary>
                <div class="source-text selectable">
                  <p class="muted">
                    {source.url} · {new Date(source.retrievedAt).toLocaleString()}
                  </p>
                  <p>{source.text || "No text was retrieved."}</p>
                </div>
              </details>
              {#if Schema.is(ReviewSourceUrl)(source.url)}<button
                  type="button"
                  class="icon-btn"
                  aria-label={`Open ${source.title || source.url}`}
                  {...tip("Open this source in your browser.")}
                  onclick={() => onOpenSource(source.url)}
                  ><ReviewIcon name="arrow-up-right" /></button
                >{/if}
            </div>
          {/each}
        </div>
      </details>{/if}
    <details class="record">
      <summary
        >Coverage<span class="record-meta"
          >{coverageProgress.recorded} of {coverageProgress.total}</span
        ></summary
      >
      <CoverageMatrix {review} />
    </details>
    {#if projectFacts.length > 0 || review.firmChecklist || review.jurisdictionLeads?.reviews.length}<details
        class="record"
      >
        <summary
          >Project{#if factsNeedingInput > 0}<span class="record-meta attention-count"
              >{factsNeedingInput} need input</span
            >{/if}</summary
        >
        <dl class="configuration record-body">
          {#each projectFacts as fact (fact.key)}
            <div class="fact" data-needs-input={fact.needsInput || undefined}>
              <dt {...tip(fact.label)}>{fact.label}</dt>
              <dd>
                {#if fact.detail}<details>
                    <summary>
                      {#if fact.needsInput}<span class="tag accent">{fact.value}</span>{:else}<span
                          class="fact-value">{fact.value}</span
                        >{/if}
                    </summary>
                    <p class="selectable">{fact.detail}</p>
                  </details>{:else if fact.needsInput}<span class="tag accent">{fact.value}</span
                  >{:else}{fact.value}{/if}
              </dd>
            </div>
          {/each}
          {#if review.jurisdictionLeads?.reviews.length}{@const leads = review.jurisdictionLeads}
            <div class="fact" data-testid="jurisdiction-leads">
              <dt>Earlier reviews</dt>
              <dd
                {...tip(
                  `${leads.reviews.map((item) => `${item.projectName} (same ${item.match === "locality" ? "county or city" : "state"})`).join(", ")}. Offered as leads, not evidence: ${leads.sources} sources, ${leads.citations} citations, ${leads.editions} code editions, ${leads.agencyComments} agency comments.`,
                  "Same jurisdiction",
                )}
              >
                {leads.reviews.length} in this jurisdiction
              </dd>
            </div>{/if}
          {#if review.firmChecklist}<div class="fact" data-testid="firm-checklist-applied">
              <dt>Firm checklist</dt>
              <dd>Revision {review.firmChecklist.revision}</dd>
            </div>{/if}
        </dl>
      </details>{/if}
    {#if review.calculations.length > 0}<details class="record">
        <summary>Calculations<span class="record-meta">{review.calculations.length}</span></summary>
        <div class="record-body">
          {#each review.calculations as calculation (calculation.id)}<section class="calculation">
              <h4>{calculation.title}</h4>
              <p>
                <code>{calculation.expression}</code> =
                <strong>{calculation.result} {calculation.unit}</strong>
              </p>
              <p class="muted">
                {Object.entries(calculation.inputs)
                  .map(([name, input]) => `${name} = ${input.value} ${input.unit}`)
                  .join(" · ")}
              </p>
              <p>{calculation.explanation}</p>
            </section>{/each}
        </div>
      </details>{/if}
    {#if review.priorComments.length > 0}<details class="record">
        <summary
          >Prior comments<span class="record-meta">{review.priorComments.length}</span></summary
        >
        <div class="record-body">
          {#each review.priorComments as comment (comment.id)}<section class="calculation">
              <h4>{comment.agency} {comment.number} · {comment.status}</h4>
              <p>{comment.comment}</p>
              <p>{comment.response}</p>
              {#if comment.changedSources}<p class="muted">{comment.changedSources}</p>{/if}
            </section>{/each}
        </div>
      </details>{/if}
    <details class="record">
      <summary>Technical details</summary>
      <p class="muted record-body technical">
        {review.admittedCalls} provider calls{review.maxCalls === null
          ? ""
          : ` of the optional ${review.maxCalls}-call budget`}{cachedShare === null
          ? ""
          : ` · ${Math.round(cachedShare * 100)}% of prompt tokens cached`} · {review.promptVersion}{review.preset
          ? ` · ${review.preset}`
          : ""}
      </p>
    </details>
  </div>
</section>

<style>
  .packet-review {
    position: relative;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-lg) var(--space-lg);
    margin: 20px 0 28px;
    color: var(--color-text);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    font-size: var(--text-body-sm);
  }
  /* A slow Ember breath around the whole card while the model is working. */
  .packet-review.running {
    border-color: color-mix(in srgb, var(--color-ember) 45%, var(--color-border));
  }
  .packet-review.running::before {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    box-shadow:
      0 0 0 1px var(--color-ember-halo),
      0 0 32px -6px var(--color-ember-halo);
    pointer-events: none;
    animation: review-breath 2.4s ease-in-out infinite;
  }
  @keyframes review-breath {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    margin: 0 calc(var(--space-lg) * -1);
    padding: var(--space-md) var(--space-lg);
  }
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs) var(--space-sm);
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-title-md);
    font-weight: 600;
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }
  .running h2 {
    font-size: var(--text-headline-md);
  }
  .live-dot {
    position: relative;
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--color-ember);
  }
  .live-dot::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--color-ember);
    animation: review-ping 1.6s var(--ease-out) infinite;
  }
  @keyframes review-ping {
    from {
      opacity: 0.7;
      transform: scale(1);
    }
    to {
      opacity: 0;
      transform: scale(3.2);
    }
  }
  .scope {
    text-transform: uppercase;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-body-md);
    font-weight: 600;
    margin: var(--space-lg) 0 var(--space-xs);
  }
  h4 {
    font-size: var(--text-body-sm);
    font-weight: 600;
    margin: var(--space-sm) 0 4px;
  }
  p {
    line-height: var(--leading-relaxed);
    margin: 6px 0;
  }
  .summary,
  li {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .muted,
  .progress {
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  .duration {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .running .duration {
    color: var(--color-text);
  }
  .meter {
    position: relative;
    height: 2px;
    margin: 0 calc(var(--space-lg) * -1) var(--space-md);
    overflow: hidden;
    background: var(--color-border);
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--color-ash-soft);
    transition: width var(--duration-base) var(--ease-out);
  }
  .running .meter span {
    background: var(--color-ember);
  }
  .running .meter::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 30%;
    background: linear-gradient(90deg, transparent, var(--color-spark), transparent);
    animation: review-scan 1.8s linear infinite;
  }
  @keyframes review-scan {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .packet-review.running::before,
    .live-dot::after,
    .running .meter::after {
      animation: none;
    }
    .running .meter::after {
      display: none;
    }
  }
  .progress {
    margin-top: 0;
  }
  .budget-extension {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-xs);
    flex-basis: 100%;
  }
  .budget-extension label {
    display: grid;
    gap: 6px;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .budget-extension input {
    width: 130px;
  }
  .budget-extension p {
    flex-basis: 100%;
    margin-top: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
    margin-top: var(--space-md);
  }
  .attention {
    border-left: 2px solid var(--color-error);
    padding-left: var(--space-sm);
    color: var(--color-error);
  }
  ul {
    margin: 6px 0;
    padding-left: 20px;
  }
  li {
    font-size: var(--text-body-sm);
    line-height: var(--leading-relaxed);
  }
  .findings > h3 span {
    min-width: 20px;
    height: 20px;
    display: inline-grid;
    place-items: center;
    padding: 0 4px;
    border-radius: var(--radius-sm);
    background: var(--color-slate);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
  }
  .finding {
    display: flex;
    width: 100%;
    text-align: left;
    border: 0;
    border-top: 1px solid var(--color-border);
    border-radius: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px var(--space-sm);
    padding: var(--space-sm) var(--space-xs);
    background: transparent;
    color: var(--color-text);
    transition: background var(--duration-fast) var(--ease-out);
  }
  .finding:hover {
    background: var(--color-wash);
  }
  .finding::after {
    content: "";
    order: 3;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    background: var(--color-text-muted);
    -webkit-mask: var(--icon-chevron-right) center / 16px 16px no-repeat;
    mask: var(--icon-chevron-right) center / 16px 16px no-repeat;
  }
  .finding strong {
    order: 1;
    flex: 1;
    min-width: 120px;
    font-size: var(--text-body-sm);
    font-weight: 500;
  }
  .severity,
  .finding-status {
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .severity {
    order: 0;
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
  }
  .severity[data-severity="Critical"] {
    border-color: var(--color-error);
    color: var(--color-error);
  }
  .finding-status {
    order: 2;
    color: var(--color-text-muted);
  }
  .finding:is(
      [data-decision="false_alarm"],
      [data-decision="not_applicable"],
      [data-decision="duplicate"]
    )
    strong {
    color: var(--color-text-muted);
    text-decoration: line-through;
  }
  /* The review's records: one quiet row each, with what matters on the right. */
  .records {
    display: grid;
    margin-top: var(--space-md);
  }
  .inline-record {
    margin-top: var(--space-xs);
  }
  .inline-record p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .record {
    border-top: 1px solid var(--color-border);
  }
  .record > summary {
    width: 100%;
    min-height: 40px;
    font-size: var(--text-body-sm);
    font-weight: 500;
    color: var(--color-text);
  }
  .record-meta {
    margin-left: auto;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    font-weight: 400;
    letter-spacing: var(--tracking-wide);
    font-variant-numeric: tabular-nums;
  }
  .attention-count {
    color: var(--color-ember);
  }
  .record-body {
    margin: 0 0 var(--space-sm);
  }
  .technical {
    padding-left: 20px;
  }
  .record-body > h4 {
    margin: var(--space-sm) 0 var(--space-2xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .source {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 32px;
    align-items: start;
    gap: var(--space-xs);
    padding: 2px 0;
    border-top: 1px solid var(--color-border);
  }
  .source details {
    min-width: 0;
  }
  .source summary {
    width: 100%;
    min-height: 32px;
    color: var(--color-text);
  }
  .source .tag {
    height: 20px;
  }
  .source-name {
    min-width: 0;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-text {
    max-height: 280px;
    overflow: auto;
    padding: 0 var(--space-xs) var(--space-xs) 20px;
  }
  .source-text p {
    margin: var(--space-2xs) 0;
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .calculation {
    padding: 0 0 var(--space-xs) 20px;
    overflow-wrap: anywhere;
  }
  .calculation p {
    white-space: pre-wrap;
  }
  .configuration {
    display: grid;
  }
  .fact {
    display: grid;
    grid-template-columns: minmax(0, 200px) minmax(0, 1fr);
    align-items: start;
    gap: var(--space-md);
    padding: 6px 0 6px 20px;
    border-top: 1px solid var(--color-border);
  }
  .fact dt {
    overflow: hidden;
    color: var(--color-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fact dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .fact dd summary {
    width: 100%;
    color: var(--color-text);
  }
  .fact dd summary::before {
    order: 1;
  }
  .fact-value {
    min-width: 0;
  }
  .fact dd p {
    margin: var(--space-2xs) 0 0;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
    line-height: var(--leading-normal);
  }
  .fact .tag {
    height: 20px;
  }
  @media (max-width: 640px) {
    .fact {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
</style>
