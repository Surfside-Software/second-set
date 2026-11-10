import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import {
  decodeRequest,
  id,
  open,
  response,
  systemPrompt,
  until,
} from "../fixtures/packet-review.ts";

test("an OpenCode Go usage limit pauses a parallel review after one refused request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-packet-go-limit-"));
  let sheetSends = 0;

  const transport: ProviderTransport = async (_url, init) => {
    if (!systemPrompt(decodeRequest(init)).includes("## Parallel review: sheet reviewer"))
      return response([], "Project configuration recorded.");

    sheetSends++;

    return Response.json(
      {
        type: "error",
        error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
        metadata: { workspace: "wrk_go_limit", limitName: "5 hour" },
      },
      { status: 429, headers: { "retry-after": "120" } },
    );
  };

  const session = await open(directory, transport, true, undefined, "observe", {
    minSheets: 2,
    concurrency: { "opencode-go": 3 },
  });

  try {
    const request = await session.request("Review the whole drawing set.", {
      model: "muse-spark-1.3-contributor",
    });

    const started = await session.run(session.packets.start(request));
    const paused = await until(session, started.id, "paused");

    expect(paused.error).toContain("usage limit");
    expect(paused.error).toContain("Nothing was generated or charged");
    expect(paused.providerFailure).toMatchObject({
      category: "http",
      httpStatus: 429,
      detail: "usage_limit",
    });

    // The waiting sheet reviewer is held back, so nothing else spends requests against the limit.
    await Bun.sleep(250);
    expect(sheetSends).toBe(1);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a request the provider refuses past its budget pauses the review uncharged and resumes explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-packet-refusal-"));
  let sends = 0;

  const session = await open(directory, async () => {
    sends++;

    // A provider wait longer than the 10-minute refusal budget ends the attempt at once.
    return sends === 1
      ? Response.json(
          { error: "Rate limit exceeded" },
          { status: 429, headers: { "retry-after": "900" } },
        )
      : response([], "Continued the review once the provider accepted requests again.");
  });

  try {
    const request = await session.request("Please run a quick QA pass.");
    const started = await session.run(session.packets.start(request));
    const paused = await until(session, started.id, "paused");
    expect(sends).toBe(1);
    expect(paused.admittedCalls).toBe(1);
    expect(paused.error).toContain("HTTP 429");
    expect(paused.error).toContain("Nothing was generated or charged");
    expect(paused.error).not.toContain("may have been charged");
    expect(paused.providerFailure).toMatchObject({
      category: "http",
      httpStatus: 429,
      detail: "rate_limit",
    });

    // No attempt is left unresolved, so nothing blocks an explicit resume.
    const unresolved = await session.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ task_id: Schema.Int })),
        )(
          yield* sql`SELECT task_id FROM packet_review_attempts WHERE review_id=${started.id} AND status='uncertain'`,
        );
      }),
    );

    expect(unresolved).toEqual([]);

    const resuming = await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: paused.version,
        action: "resume",
        commandId: id(),
      }),
    );

    expect(resuming.providerFailure).toBeNull();

    // The scripted reviewer answers without finishing, so the resumed review ends incomplete.
    const resumed = await until(session, started.id, "failed");
    expect(sends).toBe(2);
    expect(resumed.admittedCalls).toBe(2);
    expect(resumed.summary).toContain("once the provider accepted requests again");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
