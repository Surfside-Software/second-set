# Inference setup

For development, copy `.env.example` to `.env` and fill in the keys you use:

```dotenv
MODEL_API_KEY=
BASETEN_API_KEY=
OPENCODE_API_KEY=
```

Bun loads the root `.env` when `bun run dev` starts. Restart after changing it.
Configured providers are available together in the Model menu, except that a Go
key limits chat to Go and any saved custom endpoint; see [OpenCode Go](#opencode-go). Keep each
key with its own provider and endpoint; keys never enter renderer code or logs.
The repository ignores `.env` and `.env.*` except the blank `.env.example`.

## Models and routes

| Model                              | Provider    | Canonical endpoint                    | Credential         |
| ---------------------------------- | ----------- | ------------------------------------- | ------------------ |
| `muse-spark-1.3`                   | Meta        | `https://api.meta.ai/v1`              | `MODEL_API_KEY`    |
| `muse-wonder-1.0`                  | Meta        | `https://api.meta.ai/v1`              | `MODEL_API_KEY`    |
| `meta-models/muse-spark-open-1026` | Baseten     | `https://inference.baseten.co/v1`     | `BASETEN_API_KEY`  |
| `muse-spark-1.3-contributor`       | OpenCode Go | `https://opencode.ai/inference/go/v1` | `OPENCODE_API_KEY` |

## OpenCode Go

The **Initial Review** button uses Muse Spark 1.3 Contributor when OpenCode Go is connected, and
Meta's Muse Spark 1.3 otherwise. Go is a subscription with monthly dollar allowances, a 5-hour cap of
20% and a weekly cap of 50%; see its [pricing](https://opencode.ai/docs/go/).

**Muse Spark Contributor trains on your drawings.** Go sells it at a discount in exchange for using
prompts and completions to train Meta's models, and it is not zero-retention. An owner must turn on
**Allow paid endpoints that train on request data** in the workspace's Settings > Privacy, or Go
refuses it.

- **Traffic.** Go is designed for coding agents and monitors traffic for abuse. Parallel drawing
  reviews are not typical coding traffic. Moke identifies itself as `moke/<version>`, sends a session
  ID per conversation and runs 3 sheet reviewers at a time. See [OpenCode Go](#opencode-go-1).
- **Images.** Go has no Files API, so images travel inline. Reviews keep the eight-image window Baseten
  uses, so a reviewer inspects a batch before requesting the next.
- **The only chat route once connected.** With a Go key present, the model menu and the Initial Review
  button offer only Muse Spark 1.3 Contributor and any saved custom endpoint, so a review cannot
  spend Meta or Baseten credits by accident.
- **What stays on Meta.** SAM runs only on Meta, so object counting needs `MODEL_API_KEY`. Selected
  count checks run on Meta or Baseten, because their table admits only those two; a check started while
  the Go model is selected uses that default route.
- **Search.** There is no built-in web search; reviewers use `search_sources` and `read_source`.

Keep the `-1026` suffix for the supplied Baseten hackathon key. Public examples
use `meta-models/muse-spark-open`, which is a different configured model ID. SAM
3.1 runs on Meta with `MODEL_API_KEY` and is not a chat-model option. When that
key is configured, packet reviews use it with either chat provider; see
[SAM in packet reviews](#sam-in-packet-reviews).

`MOKE_PROVIDER` chooses the preferred startup provider, with `meta` as the
default. Each review saves the model selected in the workbench. Changing the menu
does not change an existing run. When Go is connected, a follow-up whose earlier
model the menu no longer offers moves to the first model it does. The
other endpoint and model variables in `.env.example` support experiment scripts;
they do not override the desktop's canonical routes.

Import the PDF packet and send a natural-language review request. Auto routes a
whole-set QA request or a named discipline; an explicit reviewer selects that
discipline. No count check or manual sheet confirmation is required to start a
packet review. A note is saved without calling a model. The model receives the
full Moke AGENTS.md, shared method and applicable discipline instructions as its
Pi system instructions. See the [prompt documentation](../backend/review/prompts/README.md).

## Model capabilities and operational budgets

Packet review uses automatic Pi compaction for long conversations. On Meta it
matches the settings Meta's console uses for Muse Spark 1.3: `xhigh` reasoning, a
256,000-token output limit, and Meta's built-in `web_search` tool with high search
context. Web search runs on Meta's side and returns cited text. Reviewers still
record governing sources with `read_source`. Baseten packet requests use high
reasoning. The installed Meta catalog gives Spark 1.3 and Wonder a 1,048,576-token
context and records a 131,072-token output limit; Meta accepted 256,000 for Spark
1.3 on 2026-10-29. Meta documents the full context window in its
[model catalog](https://dev.meta.ai/docs/models).

Meta's [rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for Spark 1.3
are 3,000 requests and 4,000,000 tokens a minute, shared by every key on a team;
response headers confirmed them for the configured key. Meta reads images returned
in tool results, and accepted 300 small tool-result images in one request.
The Baseten hackathon key reports 100 requests and 2,000,000 tokens a minute
(2026-10-31). Its request limiter allows about 50 requests at once, and
[Baseten counts cached input](https://docs.baseten.co/inference/model-apis/pricing-and-limits#rate-limits)
toward the token limit. `bun run check:api-keys` prints both keys' current limits.

### Rate-limit pacing and refusals

Every request on a key in the backend process passes through one shared pacer
(`backend/inference/pacing.ts`). It holds at most half a minute of requests and
estimated tokens, replenishes them continuously, and releases requests in arrival
order. Each response's `x-ratelimit-limit-*` and `x-ratelimit-remaining-*` headers
update it. Both providers send them. The pacer waits before the durable request
attempt is recorded, so a cancel or shutdown during the wait leaves nothing
unresolved, and the 300-second request deadline starts only when the request is sent.

HTTP 429 and 529 mean the provider refused the request before generating. A gateway's 502 or
503 is handled the same way: Meta answered 7 of 13 sheet reviewers with 502 within about 110 ms
on 2026-10-31, before any generation, and not resending it left those sheets unreviewed. HTTP
500 and 504 can follow real work and are not resent. A SAM request refused with 429, 502, 503 or
529 is resent up to three times; if every send is refused, its attempt is withdrawn uncharged and
the reviewer continues without that segmentation or finding zoom. The
refusal starts one cooldown that every conversation on the key waits out, so
parallel sheet reviewers do not retry into the same limit. The cooldown honours
`Retry-After` in full, as delay-seconds or an HTTP-date. Otherwise, or when it is
zero or malformed, it starts at 2 seconds and doubles up to 60 when requests sent
after it began are refused again. Baseten's 429 carries no `Retry-After`. Meta
also answers a served model with HTTP 404 `model_not_found` now and then (1 in 8
requests for one team's key on 2026-10-30). Nothing is generated, so that request
alone is resent after its own backoff. A refused request is resent within the same
admitted attempt for up to 10 minutes or 40 sends (11 on OpenCode Go), and stops at
once if its next send could go out only after the 10 minutes. A packet request refused on every
send generated nothing, so the review pauses without an unresolved request and
says it was not charged; Resume continues it. Other failures are not resent.
Large packets review each sheet in its own conversation; see
[parallel packet reviews](review-runtime.md#parallel-packet-reviews).

Baseten
advertises a [1M-token context for Spark Open](https://www.baseten.co/blog/muse-spark-open-launch/)
but does not publish a separate serving output ceiling there. The desktop leaves
Baseten's output parameter at its API default by using the ordinary stream path;
the SDK's simple stream would insert a context-sized output limit. The public
[Chat Completions reference](https://docs.baseten.co/reference/inference-api/chat-completions)
documents a 4,096-token default for `max_tokens`. The dated hackathon variant's
separate limit for `max_completion_tokens` is not established by that reference.
The adapter sets neither field for Baseten packet requests and retains explicit
high reasoning. Request-shape captures verify both completion entrypoints.
These capability sources were checked on 2026-10-29. The output-policy correction
does not establish the cause of the observed provider timeout or guarantee review
completion.

A packet review defaults to no application call ceiling. An optional user call
budget counts model and SAM requests together. Reaching it pauses work and keeps
the review ledger; explicitly extend the budget to resume. Packet review has no
separate two-SAM cap or six-image context window. The host still bounds transport
memory to 64 MiB of decoded image data and 72 MiB per serialized request. Those
are application memory bounds, not provider token maxima. Image-token accounting
and cost can remain unknown.

## SAM in packet reviews

With `MODEL_API_KEY` configured, packet reviews use SAM 3.1 in two places:

- **Device counts.** The reviewer calls `segment_objects` on a focused crop to
  find receptacles, switches, luminaires, plumbing fixtures and similar symbols,
  then checks each candidate against the source. The host rejects a finding
  that states a drawn device or fixture count until SAM has segmented a crop of
  one of its sheets in the same review. Room, circuit, sheet and code-section
  numbers before a device name do not count as a quantity.
- **Finding zooms.** After `record_finding`, the host renders a padded zoom of
  the first location region that covers at most half its sheet. It sends the
  region to SAM as a box with a positive point at its center and stores the
  masks with the finding. The workbench opens a finding on its zoom with the
  masks drawn over the source, and the exported report embeds the same view.
  Whole-sheet locations get no zoom.

Both uses share the review's request ledger and call budget. If the budget is
already spent, the finding is recorded without a zoom. An unresolved SAM outcome
stops the review as an unresolved model request does, and it is never resent.
SAM masks propose locations only. They do not verify a symbol's class, establish
coverage or measure physical dimensions.

The older selected-count execution adapter keeps its narrower admission limits
for compatibility. Those limits do not define ordinary packet review.

## Prompt caching and request images

Meta and Baseten cache prompt prefixes automatically. Moke routes requests that
share a prefix to the same cache and keeps earlier turns unchanged, aiming for at
least 90% of prompt tokens served from cache (`cacheRead / (input + cacheRead)`).

- **One key per shared prefix.** Every sheet reviewer of a review shares one key,
  and the coordinator's setup and coordination turns share another. The key is a
  hash of the model, project and instructions; it carries no names or prompt text.
  Meta receives it as `prompt_cache_key` with `prompt_cache_retention: "24h"`;
  Baseten receives it as `x-session-affinity`. Each count check uses its own key.
  Pi's per-conversation session ID is not forwarded, because per-session keys would
  split reviewers that share a prefix. On Baseten (2026-10-31), a prefix cached under
  one `x-session-affinity` value was never reused by requests with a different value,
  so each extra key would pay the full prefix again. Twelve parallel 4-turn
  conversations on one key had 91.7% of prompt tokens cached, against 88.7% with no
  header. See [Baseten rate limits and caching](validation/baseten-rate-limits.md).
- **Shared fields first.** A sheet reviewer's opening message lists the request,
  scope, inventory, project configuration and sources before its own sheet, so
  peers reuse the same prefix.
- **Warm before fan-out.** One sheet reviewer starts first. The others start when
  its opening request settles, or after 90 seconds, so they find the prefix cached.
- **Append-only history.** Meta packet requests keep every image. Baseten packet
  requests (8 images) and count checks (6 images) drop the oldest images several
  at a time (4 and 3) instead of one per turn, so an earlier position changes once
  per step. Images added since the model's last turn are never dropped for older
  ones; the step stops short of them.
- **Images by reference.** Live Meta requests upload each delivered image once to
  the [Files API](https://dev.meta.ai/docs/file-handling) (`purpose=user_data`,
  24-hour expiry) and send its `file_id`, so later turns no longer resend base64.
  A failed upload leaves that image inline and is not retried for five minutes.
  A review uploads at most eight images at once. An upload stops when every request
  waiting for it is cancelled, and the next request uploads that image again.

A probe on 2026-10-30 confirmed that Meta accepts `file_id` images inside
`function_call_output` and reads them, that a base64 request after the matching
`file_id` request still hit the cache, and that the second of two requests with
the same key and a 7,216-token prefix was 99.1% cached. Each review records its
token totals, overall and per sheet reviewer. The packet panel shows the cached
share, and **Copy review diagnostics** includes it for every finished review.

## OpenCode Go

Review settings → OpenCode Go connects an [OpenCode Go](https://opencode.ai/docs/go/)
subscription, so reviews need not spend Meta or Baseten credits. Paste a key from
the Console harnesses page (`oc_sk_...`). In development, `OPENCODE_API_KEY` in
`.env` does the same; Pi and OpenCode read the same variable. The model menu then
offers `muse-spark-1.3-contributor`, which reads images and calls tools over Responses.

Moke offers only Meta's model through Go. Earlier reviews on MiMo-V2.6-Flash,
GLM-5.3-Flash or GPT-6 Luna stay readable, and a saved connection that names one of
them still opens, but no menu offers them for new reviews.

Requests go through Pi's built-in `opencode-go` provider, which OpenCode lists as
a supported harness. Its catalog picks each model's wire format, reasoning field
and request fields, under `https://opencode.ai/inference/go/v1`. OpenCode asks
clients for a stable `x-opencode-session` per conversation and rejects requests
without one (HTTP 400 `MissingSessionID`, checked 2026-11-01). Pi sends it from
each durable conversation's session ID, so every sheet reviewer keeps its own
session across restarts; Baseten's shared prefix key is not used. Requests also
identify MOKE with `User-Agent: moke/<version>` and `x-opencode-client: moke`,
as OpenCode asks of third-party clients. Free Go models are not offered: OpenCode
answers them with HTTP 403 outside its own app.

Go meters spend per model over 5-hour, weekly and monthly windows (20%, 50% and
100% of the monthly limit) and publishes no request rate or concurrency limit.
Its [docs](https://opencode.ai/docs/go/) say Go "is designed for OpenCode and
other coding agents", ask clients to "send typical coding agent traffic", and
monitor "for abuse that degrades the experience for other users". OpenCode's
[terms](https://opencode.ai/legal/terms-of-service) also bar "placing an
unreasonable load" on its infrastructure and using the service on behalf of a
third party. MOKE is an agent but not a coding agent, so it keeps its traffic
modest, identifies itself honestly, and should not run client work on a Go key:

- A packet review starts three sheet reviewers at once, about one person's agents.
  One reviewer sends about three requests a minute (measured on Muse Spark 1.3,
  2026-10-30), so a 29-sheet review takes about an hour at that speed.
- The pacer caps every use of the key at 60 requests and 5M tokens a minute. This
  is MOKE's own ceiling, not a published limit.
- A `GoUsageLimitError`, `BudgetLimitError` or `CreditLimitExceeded` 429 is never
  resent, matching OpenCode's own client. The review pauses until the reviewer
  resumes it.
- Any other 429 is resent at most ten times, also matching OpenCode's client.

"Extra Usage" on the Console's Go page moves requests past a limit onto
pay-as-you-go instead of refusing them, so leave it off to keep the limit as a
hard stop.

Packet reviews keep Baseten's eight-image window. A full window is about 4.5 MB
of base64 images per request, more than a coding agent's text request, and is the
least typical part of this traffic. Model images are at most 2048 pixels on their
long edge; OpenCode's catalog suggests 2000, so a model that receives them
resized could place an image box up to about 2% off.

Muse Spark 1.3 Contributor needs "Allow paid endpoints that train on request
data" under Settings › Privacy. Meta may then train on those reviews' drawings and
text. Without that setting Go refuses the model; turn it on, or remove the Go
connection to return to Meta's and Baseten's models. **Test and save** sends one tool-calling Chat Completions request (OpenCode
translates the format for every model) and reports a refused key, a refused
model or a usage limit. The key is stored and removed like a custom endpoint's,
in `opencode-go-credential.json`. Count checks stay on Meta and Baseten, and SAM
3.1 keeps using the Meta connection.

## Model for Initial Review and new conversations

Review settings → Model connections chooses the model the Initial Review button
and new conversations use. Until it is set, a connected OpenCode Go key selects
Muse Spark 1.3 Contributor, then Muse Spark 1.3, then a connected custom endpoint.
The choice is stored
in the window's local storage and holds no credential. A review records the model
it started with. Initial Review runs on this computer whenever its model's key
stays here.

## Custom OpenAI-compatible endpoint

Review settings → Custom endpoint runs drawing reviews on another server that
speaks the OpenAI Chat Completions API, such as vLLM, Ollama, LM Studio or a
hosted gateway. Use the OpenCode Go section for OpenCode, which needs its session
header. Enter the base URL (usually ending in `/v1`), the model name the server
expects, the API key, the model's context window and whether it reads images.
The context must be at least 32,768 tokens: packet review instructions alone are
about 15,000 (59 KB), before tool definitions, sheet images and conversation. The
address must be `https://`, or `http://` for a server on this computer
(`localhost`, `127.0.0.1`, `[::1]`), without sign-in details, a query or a
fragment.

**Test and save** first sends one small tool-calling request from the desktop
shell. Packet reviews work through tool calls, so the confirmation says whether
the model called the test tool, refused the key, or answered with something
other than a chat completion. Only the HTTP status is kept, never provider text.
Saving encrypts the endpoint with Electron safeStorage in
`custom-endpoint-credential.json`, apart from imported Meta and Baseten
credentials, and restarts the app. Connections saved in Review settings apply
even when a session-only file supplies Meta and Baseten. The key is never sent
back to the renderer; editing the endpoint means entering the key again.
**Remove** deletes the file and restarts. Saving and removing are disabled while
a review runs, because a restart marks an in-flight request unresolved. A
provider set imported from File → Import provider credential configuration may
also carry one `opencode-go` entry and one `openai-compatible` entry, with
optional `images` and `contextWindow` fields for the latter; each is stored the
same way, and a session-only file may include them too.

The endpoint appears in the model menu as one fixed review model,
`openai-compatible`, labelled with its model name. A review records that ID;
the upstream model name stays in the endpoint's settings, so a paused review
resumes on whatever model the endpoint names then.

Requests use only the fields such servers commonly accept: a `system` role,
`max_tokens` outside packet review (packet requests leave it to the server),
and no `store`, `reasoning_effort`, prompt-cache key or session-affinity header.
The server's limits are unknown, so packet reviews keep the eight-image request
window used for Baseten and start eight sheet reviewers at once. The shared
pacer starts at 600 requests and 10M tokens a minute, adopts the server's
`x-ratelimit-*` headers, and waits out 429 refusals as for the other providers.
A text-only model receives an omission notice in place of each image, and the
prompt tells it to record unread sheets as Needs input.

SAM 3.1 still runs on the Meta connection, so device counts and finding zooms
keep using Meta credits while chat requests go to the endpoint. Without a Meta
key, reviews on the endpoint run without SAM. The custom endpoint does not run
cloud reviews: its key never leaves this computer. Count checks also stay on Meta and Baseten,
whose execution records are constrained to those providers.

## Packaged desktop credentials

Packaged builds use an explicitly selected private credential file or the File
menu's encrypted credential import. They do not search the installation directory
for `.env`. The development keys can be transferred through that private launch
configuration; never bundle `.env` or expose keys through `PUBLIC_` or `VITE_`
variables.

A session file accepts one provider configuration or both:

```json
{
  "providers": [
    {
      "provider": "meta",
      "apiKey": "YOUR_META_KEY",
      "baseUrl": "https://api.meta.ai/v1",
      "model": "muse-spark-1.3"
    },
    {
      "provider": "baseten",
      "apiKey": "YOUR_BASETEN_KEY",
      "baseUrl": "https://inference.baseten.co/v1",
      "model": "meta-models/muse-spark-open-1026"
    }
  ]
}
```

Set `MOKE_SESSION_CREDENTIAL_FILE` to that private file for the launch. Unix files
must be owner-only; Windows uses file ACLs. Importing one provider preserves the
other provider's saved connection. Restart after changing the session file.
A model whose provider is unconfigured stays disabled. Connected in settings
means configuration is present; it does not prove that the provider authenticated
a live request. See [packaged launch details](deployment.md#provider-credentials-in-a-packaged-launch).

## Optional authentication check

```sh
bun run check:api-keys
```

This sends one small text request to Meta and one to Baseten using `.env`, and
prints only a safe success or failure summary. It is separate from ordinary
verification, which needs no keys and makes no hosted requests. A successful text
check proves authentication and a text response, not a completed drawing review.
See the [model reference](models.md) for provider documentation and experiments.
