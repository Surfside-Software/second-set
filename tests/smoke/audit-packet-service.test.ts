import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact } from "#lib/review/contracts.ts";
import { PacketReview } from "#lib/review/packet.ts";
import type { ProviderTransport } from "../../backend/inference/provider.ts";
import { recordLimit } from "../../backend/review/store.ts";
import {
  decodeRequest,
  id,
  open,
  outputs,
  response,
  strings,
  until,
  type Session,
} from "../fixtures/packet-review.ts";

const Attempt = Schema.Struct({
  kind: Schema.Literals(["model", "sam"]),
  status: Schema.Literals(["uncertain", "completed"]),
  sent: Schema.Literals([0, 1]),
});

const attempts = (session: Session, reviewId: string) =>
  session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* Schema.decodeUnknownEffect(Schema.Array(Attempt))(
        yield* sql`SELECT kind,status,sent FROM packet_review_attempts WHERE review_id=${reviewId} ORDER BY task_id,attempt,kind`,
      );
    }),
  );

/** The review's Pi journal write-ahead log, which SQLite removes once the journal closes. */
const journalLog = async (session: Session, reviewId: string) => {
  const rows = await session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ journal_id: Schema.String })),
      )(yield* sql`SELECT journal_id FROM packet_reviews WHERE id=${reviewId}`);
    }),
  );

  const journal = rows[0]?.journal_id;

  if (journal === undefined) throw new Error("The review row has no journal.");

  return join(session.directory, "execution-journals", `${journal}.sqlite-wal`);
};

const changePacketVersion = (session: Session) =>
  session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE review_projects SET payload=json_set(payload,'$.sourceVersion',json_extract(payload,'$.sourceVersion')+1) WHERE id=${session.projectId}`;
    }),
  );

async function eventually(check: () => Promise<boolean>, what: string, ms = 20000) {
  const deadline = performance.now() + ms;

  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }

  throw new Error(`Timed out waiting for ${what}.`);
}

const settled = async (session: Session, reviewId: string) => {
  let current = await session.run(session.packets.get(session.projectId, reviewId));

  await eventually(async () => {
    current = await session.run(session.packets.get(session.projectId, reviewId));

    return current.state !== "running";
  }, "the review to stop running");

  return current;
};

const samReceipt = () =>
  Response.json({
    id: "audit-sam",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
  });

/** Render the first sheet, then segment the rendered image. */
const segmentingReviewer = (sheet: () => string, sam: ProviderTransport): ProviderTransport => {
  let sends = 0;

  return async (url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1") return await sam(url, init);

    switch (sends++) {
      case 0:
        return response([{ name: "render_sheet", arguments: { sheetId: sheet() } }]);
      case 1: {
        const rendered = outputs(Schema.Struct({ artifact: Artifact }), request).at(-1);

        if (!rendered) throw new Error("The rendered sheet was not delivered to the model.");

        return response([
          {
            name: "segment_objects",
            arguments: {
              artifactId: rendered.artifact.id,
              prompt: { kind: "concept", text: "receptacles" },
            },
          },
        ]);
      }

      default:
        return response([], "Reviewed without SAM.");
    }
  };
};

test("a SAM attempt stopped before dispatch is withdrawn uncharged instead of left uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-sam-unsent-"));
  let session: Session | undefined;
  let changed = false;
  let samSends = 0;
  let sheetId = "";

  // The packet changes after the SAM intent is saved and before it is marked sent.
  const afterRun = async <A>(value: A) => {
    if (changed || value !== null || session === undefined) return;
    const current = session;
    const reviews = await current.run(current.packets.list(current.projectId));
    const review = reviews[0];

    if (review === undefined) return;

    const unsent = (await attempts(current, review.id)).some(
      (attempt) => attempt.kind === "sam" && attempt.sent === 0,
    );

    if (!unsent) return;
    changed = true;
    await changePacketVersion(current);
  };

  session = await open(
    directory,
    segmentingReviewer(
      () => sheetId,
      async () => {
        samSends++;

        return samReceipt();
      },
    ),
    true,
    afterRun,
  );

  try {
    sheetId = (await session.snapshot()).sheets[0]?.id ?? "";

    const started = await session.run(
      session.packets.start(await session.request("Count the receptacles on the plan.")),
    );

    const stopped = await settled(session, started.id);
    expect(changed).toBe(true);
    expect(samSends).toBe(0);
    expect(stopped.state).toBe("failed");
    expect(stopped.error ?? "").not.toContain("SAM request has an unresolved outcome");
    expect(stopped.providerFailure).toBeNull();
    // Two model requests were admitted; the withdrawn SAM attempt is refunded.
    expect(stopped.admittedCalls).toBe(2);
    expect((await attempts(session, started.id)).map((attempt) => attempt.kind)).toEqual([
      "model",
      "model",
    ]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("cancelling during a SAM refusal backoff withdraws the refused attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-sam-backoff-"));
  const refused = Promise.withResolvers<void>();
  let samSends = 0;
  let sheetId = "";

  const session = await open(
    directory,
    segmentingReviewer(
      () => sheetId,
      async () => {
        samSends++;
        refused.resolve();

        return new Response("busy", { status: 429, headers: { "retry-after": "30" } });
      },
    ),
  );

  try {
    sheetId = (await session.snapshot()).sheets[0]?.id ?? "";

    const started = await session.run(
      session.packets.start(await session.request("Count the receptacles on the plan.")),
    );

    await session.run(Effect.promise(() => refused.promise).pipe(Effect.timeout("20 seconds")));
    expect(await attempts(session, started.id)).toContainEqual({
      kind: "sam",
      status: "uncertain",
      sent: 1,
    });

    const current = await session.run(session.packets.get(session.projectId, started.id));

    await session.run(
      session.packets.control({
        projectId: session.projectId,
        reviewId: started.id,
        expectedVersion: current.version,
        action: "cancel",
        commandId: id(),
      }),
    );

    await eventually(
      async () => (await attempts(session, started.id)).every((attempt) => attempt.kind !== "sam"),
      "the refused SAM attempt to be withdrawn",
    );

    const cancelled = await session.run(session.packets.get(session.projectId, started.id));
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.admittedCalls).toBe(2);
    expect(samSends).toBe(1);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a resume that fails to launch returns to paused, releases its journal and can be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-resume-launch-"));
  let sends = 0;

  const session = await open(directory, async () =>
    sends++ === 0
      ? response([{ name: "inventory_packet", arguments: {} }])
      : response([], "Resumed review response."),
  );

  try {
    const started = await session.run(
      session.packets.start(await session.request("Perform a packet QA pass.", { maxCalls: 1 })),
    );

    await until(session, started.id, "paused");

    // An instruction left from the paused run makes launch save steering after Harness.open;
    // the changed packet then fails that save.
    await session.database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const steering = [{ commandId: id(), text: "Also check egress.", status: "unanswered" }];
        yield* sql`UPDATE packet_reviews SET payload=json_set(payload,'$.steering',json(${JSON.stringify(steering)})) WHERE id=${started.id}`;
      }),
    );
    await changePacketVersion(session);

    const paused = await session.run(session.packets.get(session.projectId, started.id));
    const commandId = id();

    const resume = () =>
      session.run(
        Effect.result(
          session.packets.control({
            projectId: session.projectId,
            reviewId: started.id,
            expectedVersion: paused.version,
            action: "resume",
            maxCalls: 5,
            commandId,
          }),
        ),
      );

    const failed = await resume();
    expect(Result.isFailure(failed)).toBe(true);

    if (Result.isFailure(failed)) expect(failed.failure.reason).toBe("conflict");

    const restored = await session.run(session.packets.get(session.projectId, started.id));
    expect(restored.state).toBe("paused");
    expect(restored.error).toContain("The packet changed");
    expect(existsSync(await journalLog(session, started.id))).toBe(false);

    // The failed resume left no receipt, so the same command is evaluated again, not replayed
    // as running; the changed version now refuses it.
    const retried = await resume();
    expect(Result.isFailure(retried)).toBe(true);
    expect((await session.run(session.packets.get(session.projectId, started.id))).state).toBe(
      "paused",
    );
    expect(sends).toBe(1);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a finished review releases its runtime and journal before the service closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-runtime-release-"));
  const session = await open(directory, async () => response([], "Reviewed."));

  try {
    const started = await session.run(
      session.packets.start(await session.request("Perform a packet QA pass.")),
    );

    expect((await settled(session, started.id)).state).toBe("failed");
    const log = await journalLog(session, started.id);
    await eventually(async () => !existsSync(log), "the finished review's journal to close");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a failure to record a tool's finished activity does not fail the tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-activity-"));
  const failure = "Activity bookkeeping fixture failure.";
  let failed = false;
  let followUp = "";
  let sends = 0;

  const afterRun = async <A>(value: A) => {
    if (
      !failed &&
      value instanceof PacketReview &&
      value.activity?.tool === "inventory_packet" &&
      value.activity.status === "finished"
    ) {
      failed = true;
      throw new Error(failure);
    }
  };

  const session = await open(
    directory,
    async (_url, init) => {
      if (sends++ === 0) return response([{ name: "inventory_packet", arguments: {} }]);
      followUp = strings(decodeRequest(init).input ?? null).join("\n");

      return response([], "Inventory read.");
    },
    true,
    afterRun,
  );

  try {
    const started = await session.run(
      session.packets.start(await session.request("Inventory the drawing packet.")),
    );

    await settled(session, started.id);
    expect(failed).toBe(true);
    expect(followUp).not.toContain(failure);
    expect(followUp).toContain("Inventory the drawing packet.");
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("findings recorded under the placeholder id stay distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-placeholder-finding-"));
  const placeholder = "00000000-0000-0000-0000-000000000000";
  let sheetId = "";
  let sends = 0;

  const finding = (title: string) => ({
    id: placeholder,
    title,
    discipline: "general",
    severity: "Minor",
    status: "Needs input",
    classification: "Drawing conflict",
    locations: [{ sheetId, detail: "Door 101 hardware", region: null }],
    observed: `${title} on the plan.`,
    correction: "Revise the plan so it matches the schedule.",
    evidenceIds: [],
    evidenceNote: "The tag is printed on the sheet.",
    citationIds: [],
    calculationIds: [],
    priorCommentId: null,
  });

  const session = await open(directory, async () => {
    switch (sends++) {
      case 0:
        return response([
          { name: "record_finding", arguments: finding("Hardware set differs from schedule") },
        ]);
      case 1:
        return response([
          { name: "record_finding", arguments: finding("Door swing differs from schedule") },
        ]);
      default:
        return response([], "Two findings recorded.");
    }
  });

  try {
    sheetId = (await session.snapshot()).sheets[0]?.id ?? "";

    const started = await session.run(
      session.packets.start(await session.request("Review the door hardware.")),
    );

    const stopped = await settled(session, started.id);
    expect(stopped.findings.map((item) => item.title).toSorted()).toEqual([
      "Door swing differs from schedule",
      "Hardware set differs from schedule",
    ]);
    expect(stopped.findings.some((item) => item.id === placeholder)).toBe(false);
    expect(new Set(stopped.findings.map((item) => item.id)).size).toBe(2);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

const Count = Schema.Array(Schema.Struct({ n: Schema.Int }));

const messageCount = (session: Session) =>
  session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* Schema.decodeUnknownEffect(Count)(
        yield* sql`SELECT count(*) AS n FROM review_records WHERE project_id=${session.projectId} AND kind='message'`,
      ))[0]?.n;
    }),
  );

/** Fill the project's conversation with valid reviewer messages up to the record limit. */
const fillMessages = async (session: Session) => {
  const conversation = (await session.snapshot()).conversations[0];

  if (!conversation) throw new Error("Missing test conversation");
  const held = (await messageCount(session)) ?? 0;

  await session.database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (let index = held; index < recordLimit; index++) {
        const message = {
          id: crypto.randomUUID(),
          projectId: session.projectId,
          conversationId: conversation.id,
          role: "reviewer",
          text: `Seeded message ${index}.`,
          createdAt: new Date(0).toISOString(),
        };

        yield* sql`INSERT INTO review_records(project_id,id,kind,payload) VALUES (${session.projectId},${message.id},'message',${JSON.stringify(message)})`;
      }
    }),
  );

  expect(await messageCount(session)).toBe(recordLimit);

  return conversation.id;
};

/** A reviewer whose first request waits for the test, then answers with `next`. */
const heldReviewer = (next: (sends: number) => Response) => {
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let sends = 0;

  const transport: ProviderTransport = async () => {
    const send = sends++;

    if (send === 0) {
      dispatched.resolve();
      await release.promise;
    }

    return next(send);
  };

  return { transport, dispatched: dispatched.promise, release: () => release.resolve() };
};

test("steering into a project at its message limit is refused and saves nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-steer-limit-"));
  const reviewer = heldReviewer(() => response([], "Reviewed."));
  const session = await open(directory, reviewer.transport);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Perform a packet QA pass.")),
    );

    await session.run(Effect.promise(() => reviewer.dispatched).pipe(Effect.timeout("20 seconds")));
    const conversationId = await fillMessages(session);

    const steered = await session.run(
      Effect.result(
        session.packets.steer({
          commandId: id(),
          projectId: session.projectId,
          reviewId: started.id,
          conversationId,
          text: "Also check egress widths.",
        }),
      ),
    );

    expect(Result.isFailure(steered)).toBe(true);

    if (Result.isFailure(steered)) {
      expect(steered.failure.reason).toBe("input");
      expect(steered.failure.message).toContain(`at most ${recordLimit} messages`);
    }

    expect(await messageCount(session)).toBe(recordLimit);
    const running = await session.run(session.packets.get(session.projectId, started.id));
    expect(running.state).toBe("running");
    expect(running.steering ?? []).toEqual([]);

    reviewer.release();
    const stopped = await settled(session, started.id);
    expect(stopped.steering ?? []).toEqual([]);
    expect(await messageCount(session)).toBe(recordLimit);
  } finally {
    reviewer.release();
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a review finishing in a project at its message limit keeps its outcome without the reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-reply-limit-"));
  const summary = "The packet was reviewed for coordination issues.";

  const reviewer = heldReviewer((send) =>
    send === 0
      ? response([{ name: "finish_review", arguments: { summary, missingInputs: [] } }])
      : response([], "Final reply."),
  );

  const session = await open(directory, reviewer.transport);

  try {
    const started = await session.run(
      session.packets.start(await session.request("Perform a packet QA pass.")),
    );

    await session.run(Effect.promise(() => reviewer.dispatched).pipe(Effect.timeout("20 seconds")));
    await fillMessages(session);
    reviewer.release();

    const completed = await until(session, started.id, "completed");
    expect(completed.summary).toBe(summary);
    expect(completed.error).toBeNull();
    expect(await messageCount(session)).toBe(recordLimit);
  } finally {
    reviewer.release();
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("a saved SAM focus records how many objects SAM found beyond the kept masks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-sam-focus-counts-"));

  const instances = Array.from(
    { length: 10 },
    (_, index) =>
      `${index}<|box;x1=${index * 30};y1=10;x2=${index * 30 + 20};y2=50;w=320;h=334;c=0.9|><|mask;x=0;y=0;c=0.8;data=1,1,!!!!!&O.lVP|>`,
  ).join(",");

  let box = { x: 0, y: 0, width: 1, height: 1 };
  let sheetId = "";
  let followUp = "";
  let sends = 0;

  const session = await open(directory, async (_url, init) => {
    const request = decodeRequest(init);

    if (request.model === "sam-3.1")
      return Response.json({
        id: "sam-focus-counts",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: `<0f>${instances}` }] }],
      });

    if (sends++ === 0)
      return response([
        {
          name: "record_finding",
          arguments: {
            title: "Door hardware tag conflicts with the schedule",
            discipline: "general",
            severity: "Minor",
            status: "Needs input",
            classification: "Drawing conflict",
            locations: [
              {
                sheetId,
                detail: "Door 101 hardware",
                region: {
                  x: box.x + box.width * 0.3,
                  y: box.y + box.height * 0.3,
                  width: box.width * 0.2,
                  height: box.height * 0.2,
                },
              },
            ],
            observed: "The plan tags hardware set 3 where the schedule lists set 4.",
            correction: "Revise the plan or the schedule so both list one hardware set.",
            evidenceIds: [],
            evidenceNote: "The hardware tag is printed on the sheet.",
            citationIds: [],
            calculationIds: [],
            priorCommentId: null,
          },
        },
      ]);
    followUp = strings(request.input ?? null).join("\n");

    return response([], "Finding recorded.");
  });

  try {
    const sheet = (await session.snapshot()).sheets[0];

    if (!sheet) throw new Error("The fixture PDF has no source sheet.");
    sheetId = sheet.id;
    box = { x: sheet.box.x, y: sheet.box.y, width: sheet.box.width, height: sheet.box.height };

    const started = await session.run(
      session.packets.start(await session.request("Check the door hardware tags.")),
    );

    const stopped = await settled(session, started.id);
    const focus = stopped.findings[0]?.focus;

    if (!focus) throw new Error("The recorded finding has no SAM zoom.");
    expect(focus.segments).toHaveLength(8);
    expect(focus.detected).toBe(10);
    expect(focus.oversized).toBe(0);
    expect(followUp).toContain('"detected":10');
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
