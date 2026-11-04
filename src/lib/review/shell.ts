import { ReviewSourceUrl } from "./source-url.ts";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { PacketReviewRpc } from "./packet.ts";
import { ExecutionRpc } from "./execution.ts";
import { CloudReviewRpc } from "./cloud.ts";
import { CommandId, CommandReceipt, ProjectId, ReviewError, ReviewRpc } from "./contracts.ts";
import { customContextWindow, OpenCodeGoModelId } from "./models.ts";

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Shell import hands stable command identity to the trusted desktop frame. */
const ChooseReviewPdf = Schema.Struct({
  projectId: ProjectId,
  expectedVersion: Version,
  commandId: CommandId,
  revisionLabel: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  ),
  dropToken: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});

/**
 * An OpenAI-compatible endpoint entered in Review settings. The key crosses to the trusted shell
 * once, is encrypted there, and is never sent back to the renderer.
 */
export const CustomEndpointSettings = Schema.Struct({
  baseUrl: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  model: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  apiKey: Schema.RedactedFromValue(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
  images: Schema.Boolean,
  contextWindow: Schema.Int.check(
    Schema.isBetween({
      minimum: customContextWindow.minimum,
      maximum: customContextWindow.maximum,
    }),
  ),
});

/**
 * An OpenCode Go key entered in Review settings, with the model it is tested with and suggested
 * for. The key crosses to the trusted shell once and is never sent back to the renderer.
 */
export const OpenCodeGoSettings = Schema.Struct({
  apiKey: Schema.RedactedFromValue(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
  model: OpenCodeGoModelId,
});

/** Parent implements the file dialog and backend ImportReviewPdf call. */
export class ReviewShellRpc extends RpcGroup.make(
  Rpc.make("CopyPacketReviewDiagnostics", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Schema.String.check(Schema.isUUID()),
    }),
    success: Schema.Void,
    error: ReviewError,
  }),
  Rpc.make("OpenReviewSource", {
    payload: { url: ReviewSourceUrl },
    success: Schema.Void,
    error: ReviewError,
  }),
  Rpc.make("ChoosePacketReport", {
    payload: Schema.Struct({
      projectId: ProjectId,
      reviewId: Schema.String.check(Schema.isUUID()),
    }),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewPdf", {
    payload: ChooseReviewPdf,
    success: Schema.NullOr(CommandReceipt),
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewExport", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("ChooseReviewRestore", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  /** Checks the endpoint, asks to save and restart, and answers false when the reviewer declines. */
  Rpc.make("SaveCustomEndpoint", {
    payload: CustomEndpointSettings,
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("RemoveCustomEndpoint", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
  /** Checks the key with one request, asks to save and restart, and answers false when declined. */
  Rpc.make("SaveOpenCodeGo", {
    payload: OpenCodeGoSettings,
    success: Schema.Boolean,
    error: ReviewError,
  }),
  Rpc.make("RemoveOpenCodeGo", {
    payload: Schema.Struct({}),
    success: Schema.Boolean,
    error: ReviewError,
  }),
) {}

/** Desktop renderer RPC: application review API plus shell file capabilities. */
export class ReviewDesktopRpc extends ReviewRpc.merge(ReviewShellRpc)
  .merge(ExecutionRpc)
  .merge(PacketReviewRpc)
  .merge(CloudReviewRpc) {}
