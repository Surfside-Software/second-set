import { expect, test } from "bun:test";
import { ExecutionError } from "#lib/review/execution.ts";
import { ProjectId } from "#lib/review/contracts.ts";
import { followPacketReviews, type ReconnectClock } from "#lib/review/packet-subscription.ts";
import { Schema } from "effect";

const projectId = Schema.decodeUnknownSync(ProjectId)(crypto.randomUUID());

/** Virtual time whose sleeps return at once, recording each requested delay. */
function instantClock() {
  let now = 0;
  const delays: Array<number> = [];

  const clock: ReconnectClock = {
    now: () => now,
    sleep: async (_signal, milliseconds) => {
      delays.push(milliseconds);
      now += milliseconds;
    },
  };

  return {
    clock,
    delays,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("attempts that take longer than ten seconds to fail without delivering a review report the lost connection", async () => {
  const controller = new AbortController();
  const time = instantClock();
  const connections: Array<boolean> = [];
  let attempts = 0;

  await followPacketReviews({
    projectId,
    signal: controller.signal,
    clock: time.clock,
    client: {
      observePacketReviews: async () => {
        attempts++;
        // A TCP or HTTP timeout: the transport fails late and nothing was ever delivered.
        time.advance(30_000);

        if (attempts === 4) controller.abort();

        return {
          ok: false,
          error: new ExecutionError({ reason: "unavailable", message: "Transport timed out" }),
        };
      },
      listPacketReviews: async () => ({ ok: true, value: [] }),
    },
    onReview: () => undefined,
    onConnectionLost: (lost) => connections.push(lost),
    onError: () => undefined,
  });

  expect(attempts).toBe(4);
  expect(connections).toEqual([true]);
  expect(time.delays).toEqual([1000, 2000, 4000]);
});

test("an idle subscription that ended cleanly after a long connection still counts as lasting", async () => {
  const controller = new AbortController();
  const time = instantClock();
  const connections: Array<boolean> = [];
  let attempts = 0;

  await followPacketReviews({
    projectId,
    signal: controller.signal,
    clock: time.clock,
    client: {
      observePacketReviews: async () => {
        attempts++;
        time.advance(60_000);

        if (attempts === 4) controller.abort();

        return { ok: true, value: undefined };
      },
      listPacketReviews: async () => ({ ok: true, value: [] }),
    },
    onReview: () => undefined,
    onConnectionLost: (lost) => connections.push(lost),
    onError: () => undefined,
  });

  expect(attempts).toBe(4);
  expect(connections).not.toContain(true);
  expect(time.delays).toEqual([1000, 1000, 1000]);
});
