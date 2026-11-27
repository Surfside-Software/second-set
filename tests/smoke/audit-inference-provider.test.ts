import { expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import { maxCooldownMs, type PacerClock, RequestPacer } from "../../backend/inference/pacing.ts";
import { createAdmittedModels, type ProviderTransport } from "../../backend/inference/provider.ts";
import { reviewProviderRoutes } from "#lib/review/models.ts";

/** A clock that never moves on its own; the refusal budget is read from it. */
function stillClock() {
  const timers = new Set<{ readonly at: number; readonly callback: () => void }>();
  let now = 0;

  const clock: PacerClock = {
    now: () => now,
    wall: () => Date.UTC(2026, 10, 26) + now,
    schedule: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.add(timer);

      return () => timers.delete(timer);
    },
    random: () => 1,
  };

  const advance = (ms: number) => {
    now += ms;

    for (const timer of [...timers].filter((entry) => entry.at <= now)) {
      timers.delete(timer);
      timer.callback();
    }
  };

  return { clock, advance };
}

/** A Meta Responses stream that answers with one short message. */
function metaAnswer() {
  const item = {
    type: "message",
    id: "audit-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Reviewed.", annotations: [] }],
  };

  const events = [
    { type: "response.created", response: { id: "audit-response" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "audit-response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    },
  ];

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const generation = {
  name: "pi.durable.phase",
  attributes: { "task.id": 1, "task.name": "pi.generation", phase: "request", attempt: 1 },
};

/** The conversation context the SDK completion entrypoints accept. */
type Conversation = Parameters<
  ReturnType<typeof createAdmittedModels>["models"]["completeSimple"]
>[1];

const shortContext: Conversation = {
  messages: [{ role: "user", content: "Review this packet.", timestamp: 0 }],
};

function session(
  provider: keyof typeof reviewProviderRoutes,
  transport: ProviderTransport,
  pacer = new RequestPacer({ requestsPerMinute: 1e9, tokensPerMinute: 1e15 }),
) {
  const endings: Array<boolean> = [];
  let sends = 0;

  const admitted = createAdmittedModels(
    {
      provider,
      model: reviewProviderRoutes[provider].model,
      apiKey: Redacted.make("audit-inference-fixture-key"),
      route: "recorded",
      pacer,
      transport: async (input, init) => {
        sends++;

        return transport(input, init);
      },
    },
    {
      packetReview: true,
      maxInputTokens: 1048576,
      maxOutputTokens: 131072,
      begin: async () => null,
      send: async () => undefined,
      complete: async () => undefined,
      end: async (uncertain) => {
        endings.push(uncertain);
      },
    },
  );

  const model = admitted.models.getModel(admitted.model.provider, admitted.model.modelId);

  if (!model) throw new Error("Fixture model not available");

  return {
    endings,
    get sends() {
      return sends;
    },
    complete: (context: Conversation = shortContext) =>
      admitted.telemetry.startSpan(generation, (telemetry) =>
        admitted.models.completeSimple(model, context, { telemetry }),
      ),
  };
}

test.each(["baseten", "opencode-go"] as const)(
  "a %s 404 model_not_found is a configuration error and is not resent",
  async (provider) => {
    const fixture = session(provider, async () =>
      Response.json(
        { error: { code: "model_not_found", message: "The requested model was not found." } },
        { status: 404, headers: { "retry-after": "1" } },
      ),
    );

    const answer = await fixture.complete();

    expect(answer.stopReason).toBe("error");
    expect(fixture.sends).toBe(1);
  },
);

test("a Retry-After far beyond the refusal budget ends the attempt at once and caps the cooldown", async () => {
  const { clock, advance } = stillClock();
  const pacer = new RequestPacer({ requestsPerMinute: 6000, tokensPerMinute: 10_000_000 }, clock);

  const fixture = session(
    "meta",
    async () =>
      Response.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "retry-after": "999999999" } },
      ),
    pacer,
  );

  const answer = await fixture.complete();
  expect(answer.stopReason).toBe("error");
  expect(fixture.sends).toBe(1);

  // Other conversations on the key wait out ten minutes, not the provider's 31 years.
  let released = false;

  const next = pacer.acquire(1).then((lease) => {
    released = true;

    return lease;
  });

  advance(maxCooldownMs - 1);
  await Promise.resolve();
  expect(released).toBe(false);
  advance(1);
  expect((await next).dispatchedAt).toBe(maxCooldownMs);
});

test("a transcript string that only looks like an image data URL is sent as text", async () => {
  const bodies: Array<string> = [];

  const fixture = session("meta", async (_input, init) => {
    bodies.push(Schema.decodeUnknownSync(Schema.String)(init?.body));

    return metaAnswer();
  });

  const text = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";

  const answer = await fixture.complete({
    messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
  });

  expect(answer.stopReason).toBe("stop");
  expect(fixture.sends).toBe(1);
  expect(bodies[0]).toContain("data:image/svg+xml");
  expect(fixture.endings).toEqual([false]);
});
