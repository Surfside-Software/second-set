import { Schema } from "effect";

/**
 * Credential owners. OpenCode Go is a subscription whose key is added in Review settings.
 * `openai-compatible` is one endpoint the user adds there; its address, upstream model name and
 * key stay with the desktop's private credential.
 */
export const ReviewProvider = Schema.Literals([
  "meta",
  "baseten",
  "opencode-go",
  "openai-compatible",
]);

/** Each subscription provider's name, only accepted endpoint and default model. */
export const reviewProviderRoutes = {
  meta: { label: "Meta", endpoint: "https://api.meta.ai/v1", model: "muse-spark-1.3" },
  baseten: {
    label: "Baseten",
    endpoint: "https://inference.baseten.co/v1",
    model: "meta-models/muse-spark-open-1026",
  },
  "opencode-go": {
    label: "OpenCode Go",
    endpoint: "https://opencode.ai/inference/go/v1",
    model: "muse-spark-1.3-contributor",
  },
} as const satisfies Record<
  Exclude<typeof ReviewProvider.Type, "openai-compatible">,
  { readonly label: string; readonly endpoint: string; readonly model: string }
>;

/**
 * OpenCode Go models that read images and call tools. Free Go models answer HTTP 403 outside
 * OpenCode itself, so none is listed.
 */
export const OpenCodeGoModelId = Schema.Literals([
  "muse-spark-1.3-contributor",
  "mimo-v2.6-flash",
  "glm-5.3-flash",
  "gpt-6-luna",
]);

/** The model a new OpenCode Go connection is tested with. */
export const defaultOpenCodeGoModel = reviewProviderRoutes["opencode-go"].model;

/** Chat models supported by the drawing-review runtime; SAM remains a tool. */
export const ReviewModelId = Schema.Literals([
  "muse-spark-1.3",
  "muse-wonder-1.0",
  "meta-models/muse-spark-open-1026",
  "muse-spark-1.3-contributor",
  "mimo-v2.6-flash",
  "glm-5.3-flash",
  "gpt-6-luna",
  "openai-compatible",
]);

/** Explicit provider routes keep a model selection from changing credential ownership. */
export const reviewModels = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", provider: "meta", reasoning: "xhigh" },
  { id: "muse-wonder-1.0", label: "Muse Wonder", provider: "meta", reasoning: "xhigh" },
  {
    id: "meta-models/muse-spark-open-1026",
    label: "Muse Spark Open",
    provider: "baseten",
    reasoning: "high",
  },
  // OpenCode Go sells this model at a discount in exchange for training on prompts and completions.
  {
    id: "muse-spark-1.3-contributor",
    label: "Muse Spark 1.3 Contributor (trains on drawings)",
    provider: "opencode-go",
    reasoning: "xhigh",
  },
  { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash", provider: "opencode-go", reasoning: "high" },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", provider: "opencode-go", reasoning: "high" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "opencode-go", reasoning: "high" },
  // One fixed ID: the upstream model name is part of the endpoint's settings, not the review.
  {
    id: "openai-compatible",
    label: "Custom endpoint",
    provider: "openai-compatible",
    reasoning: "high",
  },
] as const;

/** Whether a reviewer must be told that sending drawings to this model trains on them. */
export const trainsOnDrawings = (model: string) => model === "muse-spark-1.3-contributor";

/**
 * Connecting OpenCode Go leaves it and a custom endpoint the only chat routes, so a review cannot spend another provider's
 * credits by accident. Meta stays connected for SAM and count checks, which do not use this list.
 */
export function offeredReviewModels<
  Model extends { readonly provider: typeof ReviewProvider.Type; readonly available: boolean },
>(models: ReadonlyArray<Model>): ReadonlyArray<Model> {
  return models.some((model) => model.provider === "opencode-go" && model.available)
    ? models.filter(
        (model) => model.provider === "opencode-go" || model.provider === "openai-compatible",
      )
    : models;
}

/**
 * Smallest and largest context a custom endpoint may declare, and the default, in tokens. Packet
 * review instructions alone are about 15,000 tokens (59 KB, 2026-11-01), before tools and sheets.
 */
export const customContextWindow = {
  minimum: 32_768,
  maximum: 2_097_152,
  default: 131_072,
} as const;

/** Non-secret settings of the custom endpoint, shown so the reviewer can tell which one is used. */
export const CustomEndpointSummary = Schema.Struct({
  baseUrl: Schema.String,
  model: Schema.String,
  images: Schema.Boolean,
  contextWindow: Schema.Int,
});

/** A custom endpoint's key stays on the computer that saved it; the others can run in the cloud. */
export const runsInCloud = (provider: typeof ReviewProvider.Type) =>
  provider !== "openai-compatible";

/** Renderer-safe model availability contains no credential information. */
export const ReviewModelOption = Schema.Struct({
  id: ReviewModelId,
  label: Schema.String,
  provider: ReviewProvider,
  available: Schema.Boolean,
  endpoint: Schema.optionalKey(CustomEndpointSummary),
});
