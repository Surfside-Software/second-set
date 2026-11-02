<script lang="ts">
  import {
    countPacketCoverage,
    indexPacketCoverageCells,
    packetCoverageCellKey,
    packetCoverageProgress,
    packetCoverageStatus,
    type PacketCoverageCounts,
  } from "#lib/review/packet-coverage.ts";
  import { reviewDisciplines, type ReviewDiscipline } from "#lib/review/disciplines.ts";
  import { ReviewPass, type PacketCoverage, type PacketReview } from "#lib/review/packet.ts";
  import { tip } from "#lib/review/tooltip.ts";
  import ReviewIcon from "./ReviewIcon.svelte";

  let { review }: { review: PacketReview } = $props();

  type Status = (typeof PacketCoverage.Type)["status"];

  type Discipline = typeof ReviewDiscipline.Type;

  const statuses = [
    { id: "checked", label: "Checked", glyph: "✓" },
    { id: "issue", label: "Issue", glyph: "!" },
    { id: "needs_input", label: "Needs input", glyph: "?" },
    { id: "unreviewed", label: "Unreviewed", glyph: "" },
    { id: "not_applicable", label: "Not applicable", glyph: "–" },
  ] as const satisfies ReadonlyArray<{ id: Status; label: string; glyph: string }>;

  const statusOf = (id: Status) => statuses.find((status) => status.id === id) ?? statuses[0];

  const shortLabels: Record<Discipline, string> = {
    general: "GEN",
    civil: "CIV",
    building_design: "BLDG",
    life_safety: "LS",
    structural: "STR",
    mechanical: "MECH",
    electrical: "ELEC",
    plumbing: "PLMB",
    fire_alarm: "FA",
    fire_sprinkler: "FS",
    fire_protection: "FP",
  };

  const passLabels = {
    completeness: "Document completeness",
    requirements: "Code and agency requirements",
    coordination: "Drawing coordination",
    prior_comments: "Prior comments",
  } as const;

  let focus = $state<Status | null>(null);
  let selected = $state<{ sheetId: string; discipline: Discipline } | null>(null);
  let sheetQuery = $state("");
  let includeEarlier = $state(false);

  const progress = $derived(packetCoverageProgress(review));
  const rows = $derived(includeEarlier ? progress.ledger : progress.rows);
  const hasEarlier = $derived(progress.ledger.length > progress.rows.length);
  const displayRows = $derived(rows.map((row) => ({ ...row, status: packetCoverageStatus(row) })));
  const counts = $derived(countPacketCoverage(displayRows));

  const countOf = $derived({
    checked: counts.checked,
    issue: counts.issues,
    needs_input: counts.needsInput,
    unreviewed: counts.unreviewed,
    not_applicable: counts.notApplicable,
  });

  // A live update can remove the last matching pass. Keep its selected filter removable.
  const activeFocus = $derived(focus !== null && countOf[focus] > 0 ? focus : null);

  // One cell per sheet and discipline; passes are grouped once per coverage change.
  const cells = $derived(indexPacketCoverageCells(rows));

  const disciplines = $derived(
    reviewDisciplines.filter((discipline) => rows.some((row) => row.discipline === discipline.id)),
  );

  const visibleSheets = $derived(
    review.sheets.filter((sheet) => {
      if (
        !`${sheet.label} ${sheet.documentName} page ${sheet.pageIndex + 1}`
          .toLowerCase()
          .includes(sheetQuery.trim().toLowerCase())
      )
        return false;

      return (
        activeFocus === null ||
        disciplines.some((discipline) =>
          cells
            .get(packetCoverageCellKey(sheet.id, discipline.id))
            ?.rows.some((row) => packetCoverageStatus(row) === activeFocus),
        )
      );
    }),
  );

  const selectedCell = $derived(
    selected && visibleSheets.some((sheet) => sheet.id === selected?.sheetId)
      ? cells.get(packetCoverageCellKey(selected.sheetId, selected.discipline))
      : undefined,
  );

  const selectedSheet = $derived(review.sheets.find((sheet) => sheet.id === selected?.sheetId));

  const selectedDiscipline = $derived(
    reviewDisciplines.find((discipline) => discipline.id === selected?.discipline),
  );

  const summarize = (counts: PacketCoverageCounts) =>
    (
      [
        [counts.checked, "checked"],
        [counts.issues, counts.issues === 1 ? "issue" : "issues"],
        [counts.needsInput, "need input"],
        [counts.unreviewed, "unreviewed"],
        [counts.notApplicable, "not applicable"],
      ] as const
    )
      .flatMap(([count, label]) => (count > 0 ? [`${count} ${label}`] : []))
      .join(" · ");
</script>

<div class="coverage-matrix">
  <div class="bar" aria-hidden="true">
    {#each statuses as status (status.id)}{#if countOf[status.id] > 0}<span
          data-status={status.id}
          style:flex-grow={countOf[status.id]}
        ></span>{/if}{/each}
  </div>
  <div class="legend" role="group" aria-label="Show only one status">
    {#each statuses as status (status.id)}<button
        type="button"
        class="legend-item"
        data-status={status.id}
        aria-pressed={activeFocus === status.id}
        disabled={countOf[status.id] === 0}
        onclick={() => {
          focus = activeFocus === status.id ? null : status.id;
          selected = null;
        }}
        ><span class="swatch" aria-hidden="true">{status.glyph}</span>{status.label}<span
          class="count">{countOf[status.id]}</span
        ></button
      >{/each}
    {#if hasEarlier}<label
        class="earlier"
        {...tip("Add passes from earlier reviews whose sheets haven't changed.")}
        ><input type="checkbox" bind:checked={includeEarlier} />Earlier reviews</label
      >{/if}
  </div>
  {#if review.sheets.length > 12}<input
      class="sheet-search"
      type="search"
      aria-label="Find a sheet"
      placeholder="Find a sheet…"
      bind:value={sheetQuery}
    />{/if}
  <div class="grid-scroll" role="region" aria-label="Coverage by sheet and discipline">
    <table data-testid="coverage-matrix">
      <thead>
        <tr>
          <th scope="col" class="sheet-heading">Sheet</th>
          {#each disciplines as discipline (discipline.id)}<th
              scope="col"
              {...tip(
                summarize(
                  countPacketCoverage(
                    displayRows.filter((row) => row.discipline === discipline.id),
                  ),
                ),
                discipline.label,
              )}><abbr aria-label={discipline.label}>{shortLabels[discipline.id]}</abbr></th
            >{/each}
        </tr>
      </thead>
      <tbody>
        {#each visibleSheets as sheet (sheet.id)}
          <tr>
            <th
              scope="row"
              class="sheet-name"
              {...tip(`${sheet.documentName}, page ${sheet.pageIndex + 1}`, sheet.label)}
              >{sheet.label}</th
            >
            {#each disciplines as discipline (discipline.id)}
              {@const cell = cells.get(packetCoverageCellKey(sheet.id, discipline.id))}
              <td>
                {#if cell}<button
                    type="button"
                    class="cell"
                    data-testid="coverage-cell"
                    data-status={cell.status}
                    class:dim={activeFocus !== null &&
                      !cell.rows.some((row) => packetCoverageStatus(row) === activeFocus)}
                    aria-pressed={selected?.sheetId === sheet.id &&
                      selected.discipline === discipline.id}
                    aria-label={`${sheet.label}, ${discipline.label}: ${statusOf(cell.status).label}`}
                    {...tip(summarize(cell.counts), `${sheet.label} · ${discipline.label}`)}
                    onclick={() => {
                      selected =
                        selected?.sheetId === sheet.id && selected.discipline === discipline.id
                          ? null
                          : { sheetId: sheet.id, discipline: discipline.id };
                    }}>{statusOf(cell.status).glyph}</button
                  >{/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if visibleSheets.length === 0}<p class="empty" role="status">No sheets match.</p>{/if}
  {#if selected && selectedCell}
    <section
      class="passes"
      aria-label={`${selectedSheet?.label} ${selectedDiscipline?.label} passes`}
    >
      <header>
        <strong>{selectedSheet?.label} · {selectedDiscipline?.label}</strong>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close passes"
          onclick={() => (selected = null)}><ReviewIcon name="x" size={14} /></button
        >
      </header>
      {#each ReviewPass.literals as pass (pass)}
        {@const record = selectedCell.rows.find((row) => row.pass === pass)}
        {#if record}
          {@const note = record.note.trim()}
          {@const status = packetCoverageStatus(record)}
          <details class="pass" data-testid="coverage-record" data-status={status}>
            <summary class:plain={note.length === 0}>
              <span class="pass-name">{passLabels[pass]}</span>
              <span class="pass-status"
                ><span class="swatch" aria-hidden="true">{statusOf(status).glyph}</span>{statusOf(
                  status,
                ).label}{record.status === "not_applicable" && note.length === 0
                  ? " · reason missing"
                  : ""}</span
              >
            </summary>
            {#if note}<p class="selectable">{note}</p>{/if}
          </details>
        {/if}
      {/each}
    </section>
  {/if}
</div>

<style>
  .coverage-matrix {
    display: grid;
    gap: var(--space-sm);
    padding-top: var(--space-sm);
    --tone-checked: var(--color-success);
    --tone-issue: var(--color-error);
    --tone-needs_input: var(--color-ember);
    --tone-unreviewed: var(--color-border-strong);
    --tone-not_applicable: var(--color-ash-soft);
  }
  [data-status="checked"] {
    --tone: var(--tone-checked);
  }
  [data-status="issue"] {
    --tone: var(--tone-issue);
  }
  [data-status="needs_input"] {
    --tone: var(--tone-needs_input);
  }
  [data-status="unreviewed"] {
    --tone: var(--tone-unreviewed);
  }
  [data-status="not_applicable"] {
    --tone: var(--tone-not_applicable);
  }
  .bar {
    display: flex;
    gap: 2px;
    height: 6px;
    overflow: hidden;
    border-radius: var(--radius-sm);
  }
  .bar span {
    flex-basis: 0;
    min-width: 2px;
    background: var(--tone);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--space-xs);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 var(--space-xs) 0 var(--space-2xs);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
    transition:
      background var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out);
  }
  .legend-item:hover:not(:disabled) {
    background: var(--color-slate);
    color: var(--color-text);
  }
  .legend-item[aria-pressed="true"] {
    border-color: var(--tone);
    color: var(--color-text);
  }
  .count {
    color: var(--color-text);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 1px solid var(--tone);
    border-radius: var(--radius-sm);
    color: var(--tone);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 600;
    line-height: 1;
  }
  .earlier {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  .sheet-search {
    width: min(260px, 100%);
    min-height: 32px;
  }
  .grid-scroll {
    max-height: 420px;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    min-width: 40px;
    padding: var(--space-xs) 2px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wide);
    text-align: center;
  }
  abbr {
    text-decoration: none;
  }
  .sheet-heading,
  .sheet-name {
    position: sticky;
    left: 0;
    width: 100%;
    max-width: 240px;
    padding-left: var(--space-sm);
    padding-right: var(--space-sm);
    background: var(--color-surface);
    text-align: left;
  }
  .sheet-heading {
    z-index: 3;
  }
  .sheet-name {
    z-index: 1;
    overflow: hidden;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-body-sm);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tbody tr:last-child > * {
    border-bottom: 0;
  }
  td {
    padding: 3px;
    border-bottom: 1px solid var(--color-border);
    text-align: center;
  }
  .cell {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--tone) 16%, transparent);
    color: var(--tone);
    font-family: var(--font-mono);
    font-size: var(--text-mono-sm);
    font-weight: 600;
    line-height: 1;
    transition:
      border-color var(--duration-fast) var(--ease-out),
      opacity var(--duration-fast) var(--ease-out);
  }
  .cell[data-status="unreviewed"] {
    border-color: var(--color-border);
    background: transparent;
  }
  .cell:hover {
    border-color: var(--tone);
  }
  .cell[data-status="unreviewed"]:hover {
    border-color: var(--color-ash-soft);
  }
  .cell[aria-pressed="true"] {
    border-color: var(--color-bone);
  }
  .cell.dim {
    opacity: 0.2;
  }
  .empty {
    margin: 0;
    color: var(--color-text-muted);
  }
  .passes {
    display: grid;
    padding: 0 var(--space-sm) var(--space-2xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
  }
  .passes header {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
  }
  .passes header strong {
    font-weight: 600;
  }
  .pass {
    border-top: 1px solid var(--color-border);
  }
  .pass summary {
    width: 100%;
    min-height: 32px;
    color: var(--color-text);
  }
  .pass summary.plain {
    cursor: default;
  }
  .pass summary.plain::before {
    visibility: hidden;
  }
  .pass-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pass-status {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--color-text-muted);
    font-size: var(--text-mono-sm);
  }
  .pass p {
    margin: 0;
    padding: 0 0 var(--space-xs) 20px;
    color: var(--color-text-muted);
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
  }
</style>
