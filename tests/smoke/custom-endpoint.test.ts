import { afterAll, expect, test } from "bun:test";
import { Effect, Redacted, Schema } from "effect";
import { createCanvas } from "@napi-rs/canvas";
import { RequestPacer } from "../../backend/inference/pacing.ts";
import {
  createAdmittedModels,
  reviewModelCapabilities,
  routeModel,
} from "../../backend/inference/provider.ts";
import { packetReviewPrompt } from "../../backend/review/prompts/review-prompt.ts";
import { checkConnection } from "../../desktop/connection-check.ts";
import { CredentialError, parseProviderConfiguration } from "../../desktop/credential-files.ts";
import { offeredReviewModels, reviewModels, runsInCloud } from "#lib/review/models.ts";
import { PacketScope } from "#lib/review/packet.ts";

const endpoint = {
  provider: "openai-compatible",
  apiKey: "custom-fixture-key",
  baseUrl: "https://llm.example.test/v1",
  model: "opencodeinterpreter-ds-33b",
} as const;

test("custom endpoints accept HTTPS or a server on this computer, keeping only the address", () => {
  expect(
    parseProviderConfiguration(
      JSON.stringify({ ...endpoint, baseUrl: "https://llm.example.test/v1//" }),
    ).baseUrl,
  ).toBe("https://llm.example.test/v1");

  for (const baseUrl of ["http://localhost:8000/v1", "http://127.0.0.1:11434/v1"])
    expect(parseProviderConfiguration(JSON.stringify({ ...endpoint, baseUrl })).baseUrl).toBe(
      baseUrl,
    );

  for (const invalid of [
    { ...endpoint, baseUrl: "http://192.168.1.20:8000/v1" },
    { ...endpoint, baseUrl: "https://user:secret@llm.example.test/v1" },
    { ...endpoint, baseUrl: "https://llm.example.test/v1?api_key=secret" },
    { ...endpoint, baseUrl: "https://llm.example.test/v1#models" },
    // Packet review instructions alone fill most of a 16k context.
    { ...endpoint, contextWindow: 16384 },
    // Meta and Baseten keep their canonical routes and carry no custom settings.
    {
      provider: "meta",
      apiKey: "meta-key",
      baseUrl: "https://api.meta.ai/v1",
      model: "muse-spark-1.3",
      images: false,
    },
  ])
    expect(() => parseProviderConfiguration(JSON.stringify(invalid))).toThrow(CredentialError);
});

test("a custom endpoint reports its declared context and keeps its own model name", () => {
  expect(reviewModelCapabilities("openai-compatible", { contextWindow: 32768 })).toEqual({
    contextWindow: 32768,
    maxOutputTokens: null,
  });
  expect(reviewModelCapabilities("openai-compatible").contextWindow).toBe(131072);

  const configuration = {
    ...endpoint,
    apiKey: Redacted.make(endpoint.apiKey),
    route: "live" as const,
  };

  expect(routeModel(configuration, "openai-compatible")).toBe(endpoint.model);
  expect(routeModel({ ...configuration, provider: "meta" }, "muse-wonder-1.0")).toBe(
    "muse-wonder-1.0",
  );
});

/** A Chat Completions stream answering with text, as an OpenAI-compatible server sends it. */
function streamed() {
  const chunks = [
    {
      id: "custom",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Reviewed." }, finish_reason: null },
      ],
    },
    {
      id: "custom",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    },
  ];

  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function fixture(options: { readonly images?: boolean; readonly packetReview?: boolean } = {}) {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];

  const admitted = createAdmittedModels(
    {
      ...endpoint,
      apiKey: Redacted.make(endpoint.apiKey),
      route: "recorded",
      contextWindow: 32768,
      images: options.images ?? true,
      pacer: new RequestPacer({ requestsPerMinute: 1e9, tokensPerMinute: 1e15 }),
      transport: async (input, init) => {
        // A redirect would forward the drawings to a server the reviewer did not choose.
        expect(init?.redirect).toBe("error");

        requests.push({
          url: input instanceof Request ? input.url : String(input),
          headers: new Headers(init?.headers),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
        });

        return streamed();
      },
    },
    {
      packetReview: options.packetReview ?? true,
      maxInputTokens: 4 * 32768,
      maxOutputTokens: 32768,
      cacheKey: () => "moke-sheet-fixture",
      begin: async () => null,
      send: async () => undefined,
      complete: async () => undefined,
      end: async () => undefined,
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!model) throw new Error("Fixture model not available");

  return { admitted, model, requests };
}

const generation = {
  name: "pi.durable.phase",
  attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
};

const Wire = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(Schema.Struct({ role: Schema.String })),
  }),
);

test.each(["simple", "generic"] as const)(
  "packet requests through %s completion use only widely accepted Chat Completions fields",
  async (entrypoint) => {
    const session = fixture();

    const context = {
      systemPrompt: "Review the drawing packet.",
      messages: [{ role: "user" as const, content: "Review this packet.", timestamp: 0 }],
    };

    const answer = await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      entrypoint === "simple"
        ? session.admitted.models.completeSimple(session.model, context, {
            telemetry,
            reasoning: "high",
          })
        : session.admitted.models.complete(session.model, context, { telemetry }),
    );

    expect(answer.stopReason).toBe("stop");
    expect(session.admitted.model).toEqual({
      provider: "openai-compatible",
      modelId: endpoint.model,
    });
    expect(session.admitted.capabilities.contextWindow).toBe(32768);
    const [request] = session.requests;

    if (!request) throw new Error("No request reached the endpoint");
    expect(request.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${endpoint.apiKey}`);
    // An unknown server's caching is not assumed, so no routing key is sent.
    expect(request.headers.get("x-session-affinity")).toBeNull();
    const wire = Schema.decodeUnknownSync(Wire)(request.body);
    expect(wire.model).toBe(endpoint.model);
    expect(wire.messages[0]?.role).toBe("system");
    const body = JSON.parse(request.body);

    for (const field of [
      "store",
      "reasoning_effort",
      "max_completion_tokens",
      "max_tokens",
      "prompt_cache_key",
    ])
      expect(body).not.toHaveProperty(field);
  },
);

test("requests outside packet review state their output limit as max_tokens", async () => {
  const session = fixture({ packetReview: false });

  await session.admitted.telemetry.startSpan(generation, (telemetry) =>
    session.admitted.models.completeSimple(
      session.model,
      { messages: [{ role: "user" as const, content: "Check.", timestamp: 0 }] },
      { telemetry },
    ),
  );

  // The SDK trims the limit to the context left after the request; the field name is what matters.
  const body = JSON.parse(session.requests[0]?.body ?? "{}");
  expect(body.max_tokens).toBeGreaterThan(0);
  expect(body.max_tokens).toBeLessThanOrEqual(32768);
  expect(body).not.toHaveProperty("max_completion_tokens");
});

test("a text-only endpoint receives a placeholder instead of image pixels", async () => {
  const canvas = createCanvas(16, 16);
  canvas.getContext("2d").fillText("E", 1, 12);

  const context = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Read this sheet." },
          {
            type: "image" as const,
            mimeType: "image/png",
            data: canvas.toBuffer("image/png").toString("base64"),
          },
        ],
        timestamp: 0,
      },
    ],
  };

  for (const images of [true, false]) {
    const session = fixture({ images });

    await session.admitted.telemetry.startSpan(generation, (telemetry) =>
      session.admitted.models.completeSimple(session.model, context, { telemetry }),
    );

    const body = session.requests[0]?.body ?? "";
    expect(body.includes("data:image/png;base64,")).toBe(images);
    expect(body.includes("image omitted")).toBe(!images);
  }
});

test("connecting OpenCode Go keeps a custom endpoint on offer and hides other providers", () => {
  const offered = offeredReviewModels(
    reviewModels.map((model) => ({
      id: model.id,
      provider: model.provider,
      available: model.provider === "opencode-go" || model.provider === "openai-compatible",
    })),
  );

  expect(offered.some((model) => model.provider === "openai-compatible")).toBe(true);
  expect(offered.some((model) => model.provider === "meta")).toBe(false);
  expect(runsInCloud("openai-compatible")).toBe(false);
});

test("custom endpoint prompts carry the image window and no Meta web search", () => {
  const prompt = packetReviewPrompt(PacketScope.cases.WholeSet.make({}), {
    provider: "openai-compatible",
    role: "sheet",
  });

  expect(prompt).toContain("at most eight images");
  expect(prompt).toContain("you cannot read drawings");
  expect(prompt).not.toContain("built-in web search");
});

const answers = new Map<string, () => Response>([
  [
    "/ready/v1/chat/completions",
    () =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: { name: "second_set_connection_check", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
  ],
  [
    "/prose/v1/chat/completions",
    () => Response.json({ choices: [{ message: { content: "I cannot call tools." } }] }),
  ],
  [
    "/refused/v1/chat/completions",
    () => Response.json({ error: "secret detail" }, { status: 401 }),
  ],
  ["/html/v1/chat/completions", () => new Response("<html>login</html>")],
  ["/huge/v1/chat/completions", () => new Response("x".repeat(2 * 1024 * 1024))],
]);

const seen: Array<{ authorization: string | null; tools: unknown }> = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = await request.json();
    seen.push({ authorization: request.headers.get("authorization"), tools: body.tools });

    return (
      answers.get(new URL(request.url).pathname)?.() ?? new Response("missing", { status: 404 })
    );
  },
});

afterAll(() => server.stop(true));

test("the connection check tells tool calling apart from prose, refusals and other servers", async () => {
  const check = (path: string) =>
    checkConnection({
      baseUrl: `http://127.0.0.1:${server.port}${path}`,
      model: endpoint.model,
      apiKey: Redacted.make("check-key"),
    });

  expect(await Effect.runPromise(check("/ready/v1"))).toEqual({ kind: "ready" });
  expect(await Effect.runPromise(check("/prose/v1"))).toEqual({ kind: "no_tool_call" });
  expect(await Effect.runPromise(check("/refused/v1"))).toEqual({ kind: "rejected", status: 401 });
  expect(await Effect.runPromise(check("/html/v1"))).toEqual({ kind: "unexpected" });
  expect(await Effect.runPromise(check("/huge/v1"))).toEqual({ kind: "unexpected" });
  expect(await Effect.runPromise(check("/missing/v1"))).toEqual({ kind: "rejected", status: 404 });
  expect(seen[0]?.authorization).toBe("Bearer check-key");
  expect(JSON.stringify(seen[0]?.tools)).toContain("second_set_connection_check");

  // A server that has stopped refuses the connection.
  const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const closedPort = stopped.port;
  await stopped.stop(true);

  expect(
    await Effect.runPromise(
      checkConnection({
        baseUrl: `http://127.0.0.1:${closedPort}/v1`,
        model: endpoint.model,
        apiKey: Redacted.make("check-key"),
      }),
    ),
  ).toEqual({ kind: "unreachable" });
});
