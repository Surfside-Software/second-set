import { Schema } from "effect";

/** Inference services a review can run on. */
export const ReviewProvider = Schema.Literals(["meta", "baseten", "opencode-go"]);

/** Each provider's name, only accepted endpoint and default model. */
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
  typeof ReviewProvider.Type,
  { readonly label: string; readonly endpoint: string; readonly model: string }
>;

/** Chat models supported by the drawing-review runtime; SAM remains a tool. */
export const ReviewModelId = Schema.Literals([
  "muse-spark-1.3",
  "muse-wonder-1.0",
  "meta-models/muse-spark-open-1026",
  "muse-spark-1.3-contributor",
  "mimo-v2.6-flash",
  "glm-5.3-flash",
  "gpt-6-luna",
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
    label: "Muse Spark 1.3 Contributor",
    provider: "opencode-go",
    reasoning: "xhigh",
    note: "Trains on your drawings",
  },
  { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash", provider: "opencode-go", reasoning: "high" },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", provider: "opencode-go", reasoning: "high" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "opencode-go", reasoning: "high" },
] as const;

/**
 * Connecting OpenCode Go makes it the only chat route, so a review cannot spend another provider's
 * credits by accident. Meta stays connected for SAM and count checks, which do not use this list.
 */
export function offeredReviewModels<
  Model extends { readonly provider: typeof ReviewProvider.Type; readonly available: boolean },
>(models: ReadonlyArray<Model>): ReadonlyArray<Model> {
  return models.some((model) => model.provider === "opencode-go" && model.available)
    ? models.filter((model) => model.provider === "opencode-go")
    : models;
}

/** Renderer-safe model availability contains no credential information. */
export const ReviewModelOption = Schema.Struct({
  id: ReviewModelId,
  label: Schema.String,
  provider: ReviewProvider,
  /** Something a reviewer must know before sending drawings to this model. */
  note: Schema.optionalKey(Schema.String),
  available: Schema.Boolean,
});
