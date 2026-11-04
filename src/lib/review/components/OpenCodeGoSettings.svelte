<script lang="ts">
  import { Redacted } from "effect";
  import { defaultOpenCodeGoModel } from "#lib/review/models.ts";
  import type { OpenCodeGoSettings } from "#lib/review/shell.ts";

  let {
    connected,
    disabled = false,
    onSave,
    onRemove,
  }: {
    connected: boolean;
    /** True while a review runs: saving restarts the app. */
    disabled?: boolean;
    /** Resolves with a status message; the app restarts instead when the key is saved. */
    onSave: (settings: typeof OpenCodeGoSettings.Type) => Promise<string>;
    onRemove: () => Promise<string>;
  } = $props();

  const id = $props.id();

  let apiKey = $state("");
  let message = $state("");
  let working = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();

    if (apiKey.trim() === "") return;
    working = true;
    message = "Testing the key with one small request…";
    message = await onSave({ apiKey: Redacted.make(apiKey.trim()), model: defaultOpenCodeGoModel });
    working = false;
  }

  async function remove() {
    working = true;
    message = await onRemove();
    working = false;
  }
</script>

<section class="settings-section" data-testid="opencode-go">
  <h3>
    OpenCode Go <span class="connection-state">{connected ? "Connected" : "Not connected"}</span>
  </h3>
  <p class="muted">
    Use your OpenCode Go subscription for drawing reviews. Muse Spark 1.3 Contributor then appears
    in the model menu. Create a key on the OpenCode Console harnesses page.
  </p>
  <p class="muted">
    In Console Settings › Privacy, Muse Spark 1.3 Contributor needs “Allow paid endpoints that train
    on request data”: Meta may train on those reviews’ drawings and text.
  </p>
  <form onsubmit={save}>
    <label for={`${id}-key`}>API key</label><input
      id={`${id}-key`}
      type="password"
      placeholder={connected ? "Enter a key to replace the saved one" : "oc_sk_…"}
      autocomplete="off"
      maxlength="4096"
      {disabled}
      bind:value={apiKey}
    />
    <div class="actions">
      <button type="submit" class="btn" disabled={disabled || working || apiKey.trim() === ""}
        >Test and save</button
      >
      {#if connected}<button
          type="button"
          class="btn"
          disabled={disabled || working}
          onclick={remove}>Remove</button
        >{/if}
    </div>
  </form>
  {#if disabled}<p class="muted">
      Finish or pause the running review to change the key; saving restarts MOKE.
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
  input {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 var(--space-md);
    font-family: var(--font-body);
    font-size: var(--text-body-md);
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
