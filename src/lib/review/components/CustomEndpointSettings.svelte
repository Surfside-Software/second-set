<script lang="ts">
  import { Redacted } from "effect";
  import { customContextWindow, type CustomEndpointSummary } from "#lib/review/models.ts";
  import type { CustomEndpointSettings } from "#lib/review/shell.ts";

  let {
    endpoint,
    disabled = false,
    onSave,
    onRemove,
  }: {
    /** The saved endpoint without its key, or undefined when none is connected. */
    endpoint: typeof CustomEndpointSummary.Type | undefined;
    /** True while a review runs: saving restarts the app. */
    disabled?: boolean;
    /** Resolves with a status message; the app restarts instead when the endpoint is saved. */
    onSave: (settings: typeof CustomEndpointSettings.Type) => Promise<string>;
    onRemove: () => Promise<string>;
  } = $props();

  const id = $props.id();

  // The draft starts from the saved endpoint; the key is never sent back, so it is entered again.
  let baseUrl = $derived(endpoint?.baseUrl ?? "");
  let model = $derived(endpoint?.model ?? "");
  let images = $derived(endpoint?.images ?? true);

  let contextWindow = $derived<number | undefined>(
    endpoint?.contextWindow ?? customContextWindow.default,
  );

  let apiKey = $state("");
  let message = $state("");
  let working = $state(false);

  const validContext = $derived(
    contextWindow !== undefined &&
      Number.isInteger(contextWindow) &&
      contextWindow >= customContextWindow.minimum &&
      contextWindow <= customContextWindow.maximum,
  );

  const complete = $derived(
    baseUrl.trim() !== "" && model.trim() !== "" && apiKey.trim() !== "" && validContext,
  );

  async function save(event: SubmitEvent) {
    event.preventDefault();

    if (!complete || contextWindow === undefined) return;
    working = true;
    message = "Testing the endpoint with one small request…";
    message = await onSave({
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: Redacted.make(apiKey.trim()),
      images,
      contextWindow,
    });
    working = false;
  }

  async function remove() {
    working = true;
    message = await onRemove();
    working = false;
  }
</script>

<section class="settings-section" data-testid="custom-endpoint">
  <h3>
    Custom endpoint <span class="connection-state">{endpoint ? "Connected" : "Not connected"}</span>
  </h3>
  <p class="muted">
    Run drawing reviews on another OpenAI-compatible chat completions endpoint, such as a vLLM or
    Ollama server. For OpenCode Go, use its own section above. The model must support tool calling
    and a context of at least 32,768 tokens; review instructions alone use about 15,000. SAM keeps
    using the Meta connection, and reviews on this endpoint run on this computer only.
  </p>
  <form onsubmit={save}>
    <label for={`${id}-url`}>Base URL</label><input
      id={`${id}-url`}
      type="url"
      placeholder="https://example.com/v1"
      autocomplete="off"
      spellcheck="false"
      maxlength="2048"
      {disabled}
      bind:value={baseUrl}
    />
    <label for={`${id}-model`}>Model</label><input
      id={`${id}-model`}
      placeholder="Model name the server expects"
      autocomplete="off"
      spellcheck="false"
      maxlength="256"
      {disabled}
      bind:value={model}
    />
    <label for={`${id}-key`}>API key</label><input
      id={`${id}-key`}
      type="password"
      placeholder={endpoint ? "Enter the key again to save changes" : ""}
      autocomplete="off"
      maxlength="4096"
      {disabled}
      bind:value={apiKey}
    />
    <label for={`${id}-context`}>Context window (tokens)</label><input
      id={`${id}-context`}
      type="number"
      min={customContextWindow.minimum}
      max={customContextWindow.maximum}
      step="1"
      {disabled}
      bind:value={contextWindow}
    />
    <label class="check"
      ><input type="checkbox" {disabled} bind:checked={images} />The model reads images</label
    >
    <div class="actions">
      <button type="submit" class="btn" disabled={disabled || working || !complete}
        >Test and save</button
      >
      {#if endpoint}<button
          type="button"
          class="btn"
          disabled={disabled || working}
          onclick={remove}>Remove</button
        >{/if}
    </div>
  </form>
  {#if disabled}<p class="muted">
      Finish or pause the running review to change the endpoint; saving restarts MOKE.
    </p>{/if}
  <p class="muted" role="status">{message}</p>
</section>

<style>
  .settings-section {
    display: grid;
    gap: var(--space-sm);
    padding: 20px 0;
    border-bottom: 1px solid var(--color-border);
  }
  h3 {
    margin: 0;
    font-size: var(--text-body-md);
    font-weight: 600;
  }
  p {
    margin: 6px 0;
    font-size: var(--text-body-sm);
    line-height: var(--leading-relaxed);
  }
  form {
    display: grid;
    gap: var(--space-xs);
  }
  label {
    margin-top: var(--space-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  input:not([type="checkbox"]) {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 var(--space-md);
    font-family: var(--font-body);
    font-size: var(--text-body-md);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-family: var(--font-body);
    font-size: var(--text-body-sm);
    letter-spacing: normal;
    text-transform: none;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: var(--space-sm);
  }
  .connection-state {
    float: right;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 400;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .muted {
    color: var(--color-text-muted);
  }
</style>
