import { Effect, Option, Redacted, Schema } from "effect";

/** How a custom endpoint answered one small tool-calling request. */
export type EndpointCheck =
  | { readonly kind: "ready" }
  | { readonly kind: "no_tool_call" }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unexpected" };

const checkTool = "second_set_connection_check";

/** Only the fields the check reads; everything else in the answer is ignored. */
const Completion = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      message: Schema.Struct({
        tool_calls: Schema.optional(
          Schema.NullOr(
            Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
          ),
        ),
      }),
    }),
  ),
});

/** Larger answers are not a chat completion for this request. */
const maxAnswerBytes = 1024 * 1024;

/** A response's text, or undefined past the limit, without buffering more than the limit. */
async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  const chunks = new Array<Uint8Array>();
  let bytes = 0;

  if (reader)
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        bytes += part.value.length;

        if (bytes > maxAnswerBytes) return undefined;
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Send one tool-calling chat completion before the endpoint is saved. Packet reviews work only
 * through tool calls, so an endpoint that answers in prose cannot run one. Provider error text is
 * never read or shown; only the HTTP status is kept.
 */
export const checkConnection = Effect.fn("checkConnection")(function* (endpoint: {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: Redacted.Redacted<string>;
  /** Provider-specific headers, such as OpenCode's session and client identity. */
  readonly headers?: Readonly<Record<string, string>>;
}) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      globalThis.fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...endpoint.headers,
          authorization: `Bearer ${Redacted.value(endpoint.apiKey)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: "user", content: `Call the ${checkTool} tool once.` }],
          tools: [
            {
              type: "function",
              function: {
                name: checkTool,
                description: "Confirms that this endpoint can call tools.",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          max_tokens: 1024,
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      }),
    catch: () => "unreachable" as const,
  }).pipe(Effect.option);

  if (Option.isNone(response)) return { kind: "unreachable" } satisfies EndpointCheck;

  if (!response.value.ok) {
    yield* Effect.promise(() => response.value.body?.cancel() ?? Promise.resolve());

    return { kind: "rejected", status: response.value.status } satisfies EndpointCheck;
  }

  const text = yield* Effect.tryPromise(() => boundedText(response.value)).pipe(Effect.option);

  if (Option.isNone(text) || text.value === undefined)
    return { kind: "unexpected" } satisfies EndpointCheck;

  return Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Completion))(text.value), {
    onNone: (): EndpointCheck => ({ kind: "unexpected" }),
    onSome: (completion): EndpointCheck =>
      completion.choices.some((choice) =>
        choice.message.tool_calls?.some((call) => call.function.name === checkTool),
      )
        ? { kind: "ready" }
        : { kind: "no_tool_call" },
  });
});

/**
 * OpenCode Go identifies its client by user agent and `x-opencode-client`, and routes and caches
 * by `x-opencode-session`, which it requires (400 `MissingSessionID` without it, 2026-11-01).
 */
export function openCodeHeaders(version: string, session: string) {
  return {
    "user-agent": `second-set/${version}`,
    "x-opencode-client": "second-set",
    "x-opencode-session": session,
  };
}

/** What OpenCode Go's refusals mean for a Go key, per its Console docs (2026-11-01). */
function describeOpenCodeRefusal(status: number) {
  if (status === 401)
    return "OpenCode refused the key (HTTP 401). Copy a key from a workspace with a Go subscription.";

  if (status === 403)
    return "OpenCode refused this model for the key (HTTP 403). In Console Settings › Privacy, Muse Spark Contributor needs “Allow paid endpoints that train on request data”.";

  if (status === 429)
    return "OpenCode reports a usage limit for this model (HTTP 429). Go limits reset over 5-hour, weekly and monthly windows.";

  return undefined;
}

/** Plain-language result for the save confirmation; never includes provider text. */
export function describeEndpointCheck(
  check: EndpointCheck,
  service: "opencode-go" | "custom" = "custom",
) {
  if (service === "opencode-go" && check.kind === "rejected") {
    const refusal = describeOpenCodeRefusal(check.status);

    if (refusal !== undefined) return refusal;
  }

  switch (check.kind) {
    case "ready":
      return "The endpoint answered and called the test tool.";
    case "no_tool_call":
      return "The endpoint answered but did not call the test tool. Packet reviews need a model that supports tool calling, so reviews on this endpoint will likely stop early.";
    case "rejected":
      return check.status === 401 || check.status === 403
        ? `The endpoint refused the key (HTTP ${check.status}).`
        : check.status === 404
          ? "The endpoint answered HTTP 404. Check the base URL (it usually ends in /v1) and the model name."
          : `The endpoint refused the test request (HTTP ${check.status}).`;
    case "unreachable":
      return "The endpoint could not be reached within a minute.";
    case "unexpected":
      return "The endpoint's answer was not an OpenAI chat completion.";
  }
}
