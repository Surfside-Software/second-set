import type { ProjectId } from "./contracts.ts";
import type { ReviewClient } from "./client.ts";
import type { PacketReview } from "./packet.ts";

function backoff(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) finish();
  });
}

/** The time source and reconnect delay a packet review subscription runs on. */
export interface ReconnectClock {
  /** Milliseconds, compared across an attempt to tell a lasting connection from a failing one. */
  readonly now: () => number;
  /** Resolve after `milliseconds`, or as soon as `signal` aborts. */
  readonly sleep: (signal: AbortSignal, milliseconds: number) => Promise<void>;
}

/** One subscription attempt; the delivery callback records when the connection first carried data. */
interface Attempt {
  deliveredAt: number | null;
}

/** Native timers and wall-clock time. */
const systemReconnectClock: ReconnectClock = { now: () => Date.now(), sleep: backoff };

/** Own one cancellable subscription, reload saved progress after an end, and retry with bounded backoff. */
export async function followPacketReviews(options: {
  client: Pick<ReviewClient, "observePacketReviews" | "listPacketReviews">;
  projectId: typeof ProjectId.Type;
  signal: AbortSignal;
  onReview: (review: PacketReview) => void;
  onConnectionLost: (lost: boolean) => void;
  onError: (message: string) => void;
  /** Defaults to native timers; tests pass a manual clock to step through the backoff. */
  clock?: ReconnectClock;
}) {
  const {
    client,
    projectId,
    signal,
    onReview,
    onConnectionLost,
    onError,
    clock = systemReconnectClock,
  } = options;

  let failures = 0;

  while (!signal.aborted) {
    const connectedAt = clock.now();
    // A slow failed attempt never connected, so only time after the first delivery counts.
    const attempt: Attempt = { deliveredAt: null };

    const result = await client.observePacketReviews(
      projectId,
      async (review) => {
        if (signal.aborted) return;
        attempt.deliveredAt ??= clock.now();
        onReview(review);
        onConnectionLost(false);

        if (clock.now() - attempt.deliveredAt > 10000) failures = 0;
      },
      signal,
    );

    if (signal.aborted) return;
    const endedAt = clock.now();

    const lasted =
      (attempt.deliveredAt !== null && endedAt - attempt.deliveredAt > 10000) ||
      (result.ok && endedAt - connectedAt > 10000);

    failures = lasted ? 1 : failures + 1;

    if (failures >= 3) onConnectionLost(true);

    if (!result.ok) onError(result.error.message);
    const saved = await client.listPacketReviews(projectId);

    if (signal.aborted) return;

    if (saved.ok) saved.value.forEach(onReview);
    else onError(saved.error.message);
    await clock.sleep(signal, Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15000));
  }
}
