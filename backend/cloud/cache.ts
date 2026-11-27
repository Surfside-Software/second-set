import { Effect, Schedule, Schema } from "effect";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeCloudFile } from "./files.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One immutable package file, stored in the workspace cache under its SHA-256. */
export const CloudCachedFile = Schema.Struct({ sha256: Sha256, bytes: ByteCount });

export type CloudCachedFile = typeof CloudCachedFile.Type;

/**
 * A file copied inside Modal from a directory snapshot. Paths are the package's own artifact and
 * journal names, optionally under the input snapshot's `input/` folder, so they are shell-safe.
 */
export const CloudSnapshotFile = Schema.Struct({
  ...CloudCachedFile.fields,
  path: Schema.String.check(
    Schema.isPattern(
      /^(?:input\/)?(?:artifacts\/[a-f0-9]{64}\.(?:pdf|png)|journals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite)$/,
    ),
  ),
});

/** Uploaded package files still to be copied from a review's snapshot into the cache. */
export const CloudPendingRetain = Schema.Struct({
  imageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  expiresAt: Schema.Finite,
  files: Schema.Array(CloudSnapshotFile).check(Schema.isMaxLength(5000)),
});

export type CloudPendingRetain = typeof CloudPendingRetain.Type;

/**
 * Private, per-workspace cache record beside the cloud ownership file, outside portable packages.
 * `cached` is the last listing read back from the Volume; `referenced` is the latest package
 * manifest (sent or returned), which protects journals and crops from pruning.
 */
const CloudCacheState = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  cached: Schema.Array(CloudCachedFile).check(Schema.isMaxLength(20_000)),
  referenced: Schema.Array(Sha256).check(Schema.isMaxLength(20_000)),
  pending: Schema.Array(CloudPendingRetain).check(Schema.isMaxLength(16)),
});

export type CloudCacheState = typeof CloudCacheState.Type;

/** An empty cache record with a new random id, and so a new Volume name. */
export const newCloudCacheState = (): CloudCacheState => ({
  version: 1,
  id: randomBytes(8).toString("hex"),
  cached: [],
  referenced: [],
  pending: [],
});

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const CloudCacheIdentity = Schema.fromJsonString(Schema.Struct({ id: CloudCacheState.fields.id }));

/**
 * A missing record starts a new, empty cache, and a malformed one keeps its id, which names the
 * workspace's Volume. A record that cannot be read leaves the cache off for this launch, so a
 * transient error never replaces the id and orphans the Volume. None of these blocks a review.
 */
export const readCloudCacheState = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new CloudReviewError(
        isMissing(cause)
          ? { reason: "unavailable", message: "The cloud cache record is missing." }
          : { reason: "storage", message: "The cloud cache record could not be read." },
      ),
  }).pipe(
    Effect.retry({
      while: (error) => error.reason === "storage",
      schedule: Schedule.spaced("200 millis"),
      times: 2,
    }),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(CloudCacheState))(text).pipe(
        Effect.catch(() =>
          Effect.logWarning("cloud_cache_state_reset").pipe(
            Effect.andThen(Schema.decodeUnknownEffect(CloudCacheIdentity)(text)),
            Effect.map(({ id }): CloudCacheState => ({ ...newCloudCacheState(), id })),
            Effect.catch(() => Effect.sync(newCloudCacheState)),
          ),
        ),
      ),
    ),
    Effect.catch((error) =>
      error.reason === "unavailable"
        ? Effect.sync(newCloudCacheState)
        : Effect.logWarning("cloud_cache_state_unreadable").pipe(Effect.as(null)),
    ),
  );

export const writeCloudCacheState = (path: string, state: CloudCacheState) =>
  writeCloudFile(path, JSON.stringify(state));

/**
 * One Volume per workspace, so pruning never removes another workspace's files. Modal names allow
 * letters, digits, dashes, periods and underscores, and must be shorter than 64 characters.
 */
export const cloudCacheVolumeName = (appName: string, id: string) =>
  `${appName}-cache-${id}`.length < 64 ? `${appName}-cache-${id}` : `second-set-cache-${id}`;

/** Content-addressed originals and renders in the local artifact store. */
export const listLocalArtifacts = (dataDirectory: string) =>
  Effect.promise(async () => {
    const folder = join(dataDirectory, "artifacts");
    const files: Array<CloudCachedFile & { readonly path: string }> = [];
    let names: Array<string>;

    try {
      names = await readdir(folder);
    } catch {
      return files;
    }

    for (const name of names.sort()) {
      const match = /^([a-f0-9]{64})\.(?:pdf|png)$/.exec(name);

      if (match?.[1] === undefined) continue;

      try {
        const info = await lstat(join(folder, name));

        if (info.isFile())
          files.push({ sha256: match[1], bytes: info.size, path: join(folder, name) });
      } catch {
        // A file removed between listing and measuring is simply not seeded.
      }
    }

    return files;
  });
