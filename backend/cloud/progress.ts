import { Effect, Schema, Struct } from "effect";
import { CloudReviewError } from "#lib/review/cloud.ts";
import {
  CloudEngineIdentity,
  CloudWorkerProgress,
  cloudEngineIdentity,
  type CloudReviewRecord,
} from "./contracts.ts";

/**
 * Workers before protocol 6 shipped as MOKE. Their progress files still announce the instruction
 * names they were built with, so recovery matches those exact strings.
 */
const legacyPrompt = Schema.Literal("moke-selected-coordination-v2");

/** Workers from earlier protocols, as built with any packet prompt they shipped with. */
const priorWorkerProgress = (
  protocol: 2 | 3 | 4,
  packetPrompts: ReadonlyArray<`moke-packet-review-v${1 | 2 | 3 | 4 | 5}`>,
) =>
  Schema.Struct({
    ...CloudWorkerProgress.fields,
    identity: Schema.Struct({
      // The code index entered the identity with protocol 5.
      ...CloudEngineIdentity.mapFields(Struct.omit(["codeIndex"])).fields,
      protocol: Schema.Literal(protocol),
      prompt: legacyPrompt,
      packetPrompt: Schema.Literals(packetPrompts),
    }),
  });

const Protocol3CloudWorkerProgress = priorWorkerProgress(3, [
  "moke-packet-review-v1",
  "moke-packet-review-v2",
  "moke-packet-review-v3",
]);

// Protocol 4 shipped with v3, then v4, then v5.
const Protocol4CloudWorkerProgress = priorWorkerProgress(4, [
  "moke-packet-review-v3",
  "moke-packet-review-v4",
  "moke-packet-review-v5",
]);

const protocol5WorkerProgress = (
  packetPrompts: ReadonlyArray<`moke-packet-review-v${6 | 7 | 8 | 9 | 10}`>,
  codeIndex: `florida-code-index-v${1 | 2 | 3}`,
) =>
  Schema.Struct({
    ...CloudWorkerProgress.fields,
    identity: Schema.Struct({
      ...CloudEngineIdentity.fields,
      protocol: Schema.Literal(5),
      prompt: legacyPrompt,
      packetPrompt: Schema.Literals(packetPrompts),
      codeIndex: Schema.Literal(codeIndex),
    }),
  });

// Protocol-5 images used packet prompts v6 or v7 with the v1 index, v8 with v2, then v9 and v10
// with v3. A stopped source's synthesized failure carries the current identity.
const Protocol5CloudWorkerProgress = Schema.Union([
  CloudWorkerProgress,
  protocol5WorkerProgress(
    ["moke-packet-review-v6", "moke-packet-review-v7"],
    "florida-code-index-v1",
  ),
  protocol5WorkerProgress(["moke-packet-review-v8"], "florida-code-index-v2"),
  protocol5WorkerProgress(
    ["moke-packet-review-v9", "moke-packet-review-v10"],
    "florida-code-index-v3",
  ),
]);

/** Unmarked receipts were saved by protocol 2 or 3 desktops, never by protocol 4. */
const UnmarkedCloudWorkerProgress = Schema.Union([
  Protocol3CloudWorkerProgress,
  priorWorkerProgress(2, [
    "moke-packet-review-v1",
    "moke-packet-review-v2",
    "moke-packet-review-v3",
  ]),
]);

const RecoverableCloudWorkerProgress = Schema.Union([
  Protocol5CloudWorkerProgress,
  Protocol4CloudWorkerProgress,
  UnmarkedCloudWorkerProgress,
]);

/** Recovery retains the worker's actual protocol without relaxing new worker admission. */
export type CloudRecoveredWorkerProgress = typeof RecoverableCloudWorkerProgress.Type;

/** Well above a full finding preview and execution status; anything larger is not a progress record. */
export const cloudWorkerProgressMaxBytes = 256 * 1024;

/** Parse progress for the saved owner before acknowledging any result checkpoint. */
export const parseCloudWorkerProgress = Effect.fn("parseCloudWorkerProgress")(function* (
  record: CloudReviewRecord,
  text: string,
) {
  if (Buffer.byteLength(text) > cloudWorkerProgressMaxBytes)
    return yield* new CloudReviewError({
      reason: "incompatible",
      message: "The cloud service returned oversized review progress. Refresh to reconnect.",
    });

  // Old receipts also include v3 jobs saved before this marker was introduced. Only
  // observation of already dispatched work can accept protocols 2 to 5; this never admits a request.
  const dispatched = record.phase === "dispatching" || record.phase === "running";

  const schema =
    !dispatched || record.workerProtocol === cloudEngineIdentity.protocol
      ? CloudWorkerProgress
      : record.workerProtocol === undefined
        ? UnmarkedCloudWorkerProgress
        : record.workerProtocol === 3
          ? Protocol3CloudWorkerProgress
          : record.workerProtocol === 4
            ? Protocol4CloudWorkerProgress
            : Protocol5CloudWorkerProgress;

  const progress = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      () =>
        new CloudReviewError({
          reason: "incompatible",
          message: "The cloud service returned unreadable review progress. Refresh to reconnect.",
        }),
    ),
  );

  if (progress.id !== record.id)
    return yield* new CloudReviewError({
      reason: "incompatible",
      message:
        "The cloud service returned a different review. Your local workspace is still protected.",
    });

  return progress;
});
