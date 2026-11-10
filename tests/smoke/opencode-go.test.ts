import { afterAll, expect, test } from "bun:test";
import { Effect, Redacted, Schema } from "effect";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  type PacerClock,
  reportedRateLimits,
  RequestPacer,
} from "../../backend/inference/pacing.ts";
import { createAdmittedModels, reviewModelCapabilities } from "../../backend/inference/provider.ts";
import { isCloudProvider } from "../../backend/cloud/contracts.ts";
import { defaultParallel } from "../../backend/packet-review/service.ts";
import { checkConnection, openCodeHeaders } from "../../desktop/connection-check.ts";
import { CredentialError, parseProviderConfiguration } from "../../desktop/credential-files.ts";
import type { ProviderFailure } from "#lib/review/execution.ts";
import { reviewModels, reviewProviderRoutes, runsInCloud } from "#lib/review/models.ts";
import packageInfo from "../../package.json";

const openCodeModels = reviewModels.filter((model) => model.provider === "opencode-go");

test("every listed OpenCode Go model is in Pi's catalog, reads images and is not a free model", () => {
  const catalog = opencodeGoProvider().getModels();

  expect(openCodeModels.map((model) => model.id)).toContain("muse-spark-1.3-contributor");

  for (const model of openCodeModels) {
    const entry = catalog.find((item) => item.id === model.id);

    expect(entry?.input).toContain("image");
    expect(entry?.baseUrl.startsWith(reviewProviderRoutes["opencode-go"].endpoint)).toBe(true);
    // OpenCode answers free models with HTTP 403 outside its own app.
    expect(model.id).not.toMatch(/free/);
    expect(reviewModelCapabilities(model.id).contextWindow).toBe(entry?.contextWindow ?? 0);
  }
});

test("an OpenCode Go key keeps its canonical route and can run in the cloud", () => {
  const config = {
    provider: "opencode-go",
    apiKey: "oc_sk_fixture",
    baseUrl: "https://opencode.ai/inference/go/v1/",
    model: "glm-5.3-flash",
  };

  const parsed = parseProviderConfiguration(JSON.stringify(config));
  expect(parsed.baseUrl).toBe("https://opencode.ai/inference/go/v1");
  expect(isCloudProvider(parsed)).toBe(true);
  expect(runsInCloud("opencode-go")).toBe(true);
  // Only a custom endpoint's key stays on this computer.
  expect(runsInCloud("openai-compatible")).toBe(false);

  for (const invalid of [
    { ...config, baseUrl: "https://opencode.ai/inference/go/openai/v1" },
    { ...config, model: "beam-free" },
    { ...config, model: "muse-spark-1.3" },
  ])
    expect(() => parseProviderConfiguration(JSON.stringify(invalid))).toThrow(CredentialError);
});

/** A Chat Completions stream with a reasoning field, as OpenCode Go returns for GLM. */
function completions() {
  const chunks = [
    {
      id: "go",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "Checking.", content: "Reviewed." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "go",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    },
  ];

  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A Responses stream, as OpenCode Go returns for Muse Spark Contributor. */
function responses() {
  const item = {
    type: "message",
    id: "go-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Reviewed.", annotations: [] }],
  };

  const events = [
    { type: "response.created", response: { id: "go-response" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "go-response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Timers fire at once and advance the pacer's clock, so backoff costs a test no real time. */
function instantClock(): PacerClock {
  let now = 0;

  return {
    now: () => now,
    wall: () => now,
    schedule: (callback, ms) => {
      const timer = setTimeout(() => {
        now += ms;
        callback();
      }, 0);

      return () => clearTimeout(timer);
    },
    random: () => 1,
  };
}

function fixture(model: string, refusal?: () => Response) {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const refused: Array<typeof ProviderFailure.Type> = [];
  const endings: boolean[] = [];

  const admitted = createAdmittedModels(
    {
      provider: "opencode-go",
      apiKey: Redacted.make("oc_sk_fixture"),
      baseUrl: reviewProviderRoutes["opencode-go"].endpoint,
      model,
      route: "recorded",
      pacer: new RequestPacer({ requestsPerMinute: 1e9, tokensPerMinute: 1e15 }, instantClock()),
      transport: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
        });

        if (refusal) return refusal();

        return url.endsWith("/responses") ? responses() : completions();
      },
    },
    {
      packetReview: true,
      maxInputTokens: 4 * 1_000_000,
      maxOutputTokens: 384_000,
      cacheKey: () => "moke-sheet-shared-prefix",
      begin: async () => null,
      send: async () => undefined,
      complete: async () => undefined,
      refused: async (_phase, diagnostic) => {
        refused.push(diagnostic);
      },
      end: async (uncertain) => {
        endings.push(uncertain);
      },
    },
  );

  const resolved = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!resolved) throw new Error("Fixture model not available");

  return { admitted, model: resolved, requests, refused, endings };
}

const generation = {
  name: "pi.durable.phase",
  attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
};

const context = {
  systemPrompt: "Review the drawing packet.",
  messages: [{ role: "user" as const, content: "Review this packet.", timestamp: 0 }],
};

test.each([
  ["glm-5.3-flash", "glm-5.3-flash", "/chat/completions"],
  ["muse-spark-1.3-contributor", "muse-spark-1.3-contributor", "/responses"],
] as const)(
  "%s uses its own wire format and the conversation's OpenCode session",
  async (reviewModel, upstream, path) => {
    const session = fixture(reviewModel);

    const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, {
        telemetry,
        sessionId: "conversation-session-7",
      }),
    );

    expect(answer.stopReason).toBe("stop");
    expect(session.admitted.model).toEqual({ provider: "opencode-go", modelId: upstream });
    const [request] = session.requests;

    if (!request) throw new Error("No request reached OpenCode Go");
    expect(request.url).toBe(`https://opencode.ai/inference/go/v1${path}`);
    expect(request.headers.get("authorization")).toBe("Bearer oc_sk_fixture");
    // One session per conversation, as OpenCode asks, rather than the prefix shared by sheets.
    expect(request.headers.get("x-opencode-session")).toBe("conversation-session-7");
    expect(request.headers.get("x-opencode-client")).toBe("second-set");
    expect(request.headers.get("user-agent")).toBe(`second-set/${packageInfo.version}`);
    expect(request.headers.get("x-session-affinity")).toBeNull();
    expect(JSON.parse(request.body)).toMatchObject({ model: upstream });
  },
);

test("a request outside a durable conversation still sends a stable OpenCode session", async () => {
  const session = fixture("glm-5.3-flash");

  for (let index = 0; index < 2; index++)
    await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, { telemetry }),
    );

  const sessions = session.requests.map((request) => request.headers.get("x-opencode-session"));
  expect(sessions[0]).toMatch(/^second-set-/);
  expect(sessions[1]).toBe(sessions[0]);
});

test.each(["GoUsageLimitError", "BudgetLimitError", "CreditLimitExceeded"])(
  "a %s refusal is never resent and is recorded as a definite usage limit",
  async (type) => {
    // The body and Retry-After OpenCode's own client tests use for a Go limit (2026-11-01).
    const session = fixture("glm-5.3-flash", () =>
      Response.json(
        {
          type: "error",
          error: { type, message: "Go usage limit exceeded" },
          metadata: { workspace: "wrk_go_limit", limitName: "5 hour" },
        },
        { status: 429, headers: { "retry-after": "120" } },
      ),
    );

    const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, { telemetry }),
    );

    expect(answer.stopReason).toBe("error");
    expect(answer.usage.totalTokens).toBe(0);
    expect(session.requests).toHaveLength(1);
    expect(session.refused).toEqual([
      expect.objectContaining({ category: "http", httpStatus: 429, detail: "usage_limit" }),
    ]);
    expect(session.endings).toEqual([false]);
  },
);

test("any other Go 429 is resent at most ten times, as OpenCode's own client does", async () => {
  const session = fixture("glm-5.3-flash", () =>
    Response.json(
      { error: { type: "rate_limit_error", message: "Too many requests" } },
      { status: 429, headers: { "retry-after": "1" } },
    ),
  );

  const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(session.model, context, { telemetry }),
  );

  expect(answer.stopReason).toBe("error");
  expect(session.requests).toHaveLength(11);
  expect(session.refused).toEqual([
    expect.objectContaining({ category: "http", httpStatus: 429, detail: "rate_limit" }),
  ]);
  expect(session.endings).toEqual([false]);
});

test("OpenCode Go reviews stay at about one person's agents", () => {
  expect(defaultParallel.concurrency["opencode-go"]).toBe(3);
  expect(reportedRateLimits["opencode-go"].requestsPerMinute).toBe(60);
});

const seen: Array<Headers> = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    seen.push(request.headers);
    await request.json();

    // OpenCode Go refuses a request without a session before checking the key.
    if (!request.headers.get("x-opencode-session"))
      return Response.json({ error: { type: "MissingSessionID" } }, { status: 400 });

    return Response.json({ error: { message: "Go requires a credential" } }, { status: 403 });
  },
});

afterAll(() => server.stop(true));

test("the OpenCode Go key check sends the session, client and user agent OpenCode asks for", async () => {
  const check = await Effect.runPromise(
    checkConnection({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "glm-5.3-flash",
      apiKey: Redacted.make("oc_sk_fixture"),
      headers: openCodeHeaders("0.1.0", "moke-check-1"),
    }),
  );

  expect(check).toEqual({ kind: "rejected", status: 403 });
  expect(seen[0]?.get("x-opencode-session")).toBe("moke-check-1");
  expect(seen[0]?.get("x-opencode-client")).toBe("second-set");
  expect(seen[0]?.get("user-agent")).toBe("second-set/0.1.0");
});
