import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { NotFoundError } from "modal";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModalConfiguration } from "#lib/backend-rpc.ts";
import { CloudReviewError } from "#lib/review/cloud.ts";
import { readCloudCacheState } from "../../backend/cloud/cache.ts";
import { CloudProvider, type CloudReviewRecord } from "../../backend/cloud/contracts.ts";
import { readCloudState, writeCloudState } from "../../backend/cloud/files.ts";
import {
  modalCacheSeedTimeouts,
  modalRecoveryReadTimeoutMs,
  modalResultDownloadTimeoutMs,
  mountCacheSnapshot,
} from "../../backend/cloud/modal.ts";
import {
  parseCloudWorkerProgress,
  stoppedCloudWorkerProgress,
} from "../../backend/cloud/progress.ts";
import type { CloudCacheSeed, CloudSandboxPort } from "../../backend/cloud/sandbox-port.ts";
import { CloudReviews, CloudSandbox } from "../../backend/cloud/service.ts";
import { cloudPackageLimits } from "../../backend/cloud/transfer.ts";
import { runCloudReview } from "../../backend/cloud/worker-review.ts";
import { cloudRecord, countRequest, packetRequest } from "../fixtures/cloud-records.ts";

const modal = Schema.decodeUnknownSync(ModalConfiguration)({
  tokenId: "test-token-id",
  tokenSecret: "test-modal-secret",
  appName: "test",
  environment: "main",
  imageName: "test:one",
  timeoutMinutes: 15,
  poolQueue: null,
});

const provider = Schema.decodeUnknownSync(CloudProvider)({
  provider: "meta",
  apiKey: "test-model-secret",
  baseUrl: "https://api.meta.ai/v1",
  model: "muse-spark-1.3",
});

/** A local port; tests override the calls they observe. */
const port = (overrides: Partial<CloudSandboxPort>): CloudSandboxPort => ({
  preflight: () => Effect.void,
  changes: () => Stream.never,
  allocate: () => Effect.succeed("sandbox-one"),
  upload: () => Effect.succeed("input-snapshot"),
  dispatch: () => Effect.void,
  progress: () => Effect.die("unused"),
  download: () => Effect.void,
  stop: () => Effect.void,
  seedCache: () => Effect.succeed({ cached: [], deferred: [] }),
  ...overrides,
});

const openCloud = (directory: string, sandbox: CloudSandboxPort) =>
  ManagedRuntime.make(
    CloudReviews.layer({
      directory,
      modal,
      provider,
      inspect: () => Effect.succeed({ sourceVersion: 0, factVersion: 0, projectVersion: 0 }),
      prepare: () => Effect.void,
      restorePending: () => false,
      restore: () => Effect.void,
    }).pipe(Layer.provide(Layer.succeed(CloudSandbox, sandbox))),
  );

/** Poll until `check` holds, for background work the service starts on its own. */
const eventually = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 10_000;

  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(10);
  }
};

test("a stopped protocol-4 worker that never wrote progress is recorded as failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-cloud-stopped-"));

  const record: CloudReviewRecord = {
    ...cloudRecord(packetRequest(1), "running", 1),
    workerProtocol: 4,
  };

  await Effect.runPromise(writeCloudState(join(directory, "state.json"), [record]));

  // Recovery read this current-identity record through the protocol-4 schema, which refused it.
  const refused = await Effect.runPromise(
    parseCloudWorkerProgress(record, JSON.stringify(stoppedCloudWorkerProgress(record))).pipe(
      Effect.flip,
    ),
  );

  expect(refused.reason).toBe("incompatible");

  const runtime = openCloud(
    directory,
    port({
      progress: (current) =>
        Effect.succeed({
          progress: stoppedCloudWorkerProgress(current),
          resultSnapshotId: null,
          sourceStopped: true,
        }),
    }),
  );

  try {
    const cloud = await runtime.runPromise(CloudReviews);
    expect((await runtime.runPromise(cloud.refresh(record.id))).phase).toBe("failed");
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a snapshot the provider reports missing counts as expired", async () => {
  expect(await Effect.runPromise(mountCacheSnapshot(() => Promise.resolve()))).toBe("mounted");
  expect(
    await Effect.runPromise(mountCacheSnapshot(() => Promise.reject(new NotFoundError("gone")))),
  ).toBe("expired");
  expect(
    await Effect.runPromise(
      mountCacheSnapshot(() => Promise.reject(new Error("connection reset"))),
    ),
  ).toBe("deferred");
});

const snapshotFile = (seed: string) => {
  const sha256 = new Bun.CryptoHasher("sha256").update(seed).digest("hex");

  return { sha256, bytes: 10, path: `input/artifacts/${sha256}.pdf` };
};

test("a snapshot that could not be mounted stays pending for the next seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-cloud-deferred-"));
  const cachePath = join(directory, "cache.json");
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  const seeds: Array<CloudCacheSeed> = [];

  await mkdir(directory, { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      version: 1,
      id: "0123456789abcdef",
      cached: [],
      referenced: [],
      pending: [
        { imageId: "snapshot-unreachable", expiresAt, files: [snapshotFile("a")] },
        { imageId: "snapshot-copied", expiresAt, files: [snapshotFile("b")] },
      ],
    }),
  );

  const runtime = openCloud(
    directory,
    port({
      seedCache: (request) =>
        Effect.sync(() => {
          seeds.push(request);

          return { cached: [snapshotFile("b")], deferred: ["snapshot-unreachable"] };
        }),
    }),
  );

  const PendingIds = Schema.fromJsonString(
    Schema.Struct({ pending: Schema.Array(Schema.Struct({ imageId: Schema.String })) }),
  );

  const pending = async () =>
    Schema.decodeUnknownSync(PendingIds)(await readFile(cachePath, "utf8")).pending.map(
      (entry) => entry.imageId,
    );

  try {
    await runtime.runPromise(CloudReviews);
    await eventually(async () => (await pending()).length === 1);
    expect(seeds[0]?.snapshots.map((entry) => entry.imageId)).toEqual([
      "snapshot-unreachable",
      "snapshot-copied",
    ]);
    expect(await pending()).toEqual(["snapshot-unreachable"]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed cache record keeps its Volume id and an unreadable one is never replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-cloud-cache-record-"));
  const cachePath = join(directory, "cache.json");

  try {
    const created = await Effect.runPromise(readCloudCacheState(cachePath));
    expect(created?.id).toMatch(/^[a-f0-9]{16}$/);

    // More pending snapshots than the schema admits: the contents reset, the Volume name stays.
    const pending = Array.from({ length: 17 }, (_, index) => ({
      imageId: `snapshot-${index}`,
      expiresAt: Date.now() + 60_000,
      files: [],
    }));

    await writeFile(
      cachePath,
      JSON.stringify({ version: 1, id: "fedcba9876543210", cached: [], referenced: [], pending }),
    );

    const reset = await Effect.runPromise(readCloudCacheState(cachePath));
    expect(reset?.id).toBe("fedcba9876543210");
    expect(reset?.pending).toEqual([]);

    // A record that exists but cannot be read leaves the cache off for this launch.
    await rm(cachePath);
    await mkdir(cachePath);
    expect(await Effect.runPromise(readCloudCacheState(cachePath))).toBeNull();

    const allocated: Array<string | undefined> = [];
    const seeds: Array<CloudCacheSeed> = [];

    const runtime = openCloud(
      directory,
      port({
        allocate: (record) =>
          Effect.sync(() => {
            allocated.push(record.cacheVolume);

            return "sandbox-one";
          }),
        seedCache: (request) =>
          Effect.sync(() => {
            seeds.push(request);

            return { cached: [], deferred: [] };
          }),
      }),
    );

    try {
      const cloud = await runtime.runPromise(CloudReviews);
      await runtime.runPromise(cloud.start(countRequest()));
      await runtime.runPromise(cloud.syncCache);
      await Bun.sleep(50);
      expect(allocated).toEqual([undefined]);
      expect(seeds).toEqual([]);
      expect((await stat(cachePath)).isDirectory()).toBe(true);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized ownership file is refused by size before it is read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-cloud-oversized-"));
  const path = join(directory, "state.json");

  try {
    // A sparse 5 GiB file: reading it whole fails outright rather than reaching the size check.
    const file = await open(path, "w");

    try {
      await file.truncate(5 * 1024 * 1024 * 1024);
    } finally {
      await file.close();
    }

    const refused = await Effect.runPromise(readCloudState(path).pipe(Effect.flip));
    expect(refused.reason).toBe("limit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery sandboxes outlive a full-size result download and cache copies get time to finish", () => {
  expect(modalRecoveryReadTimeoutMs).toBe(120_000);
  // The largest admitted package at the 900 KiB/s the cache seeder assumes for the desktop link.
  expect(modalResultDownloadTimeoutMs).toBeGreaterThan(
    (cloudPackageLimits.maxBytes / (900 * 1024)) * 1000,
  );
  expect(modalResultDownloadTimeoutMs).toBeLessThanOrEqual(60 * 60_000);

  expect(modalCacheSeedTimeouts(0, 0)).toEqual({ sandboxMs: 300_000, scriptMs: 300_000 });

  // 8 GiB retained from earlier snapshots, copied at 10 MiB/s.
  const copied = modalCacheSeedTimeouts(0, 8 * 1024 * 1024 * 1024);
  expect(copied.scriptMs).toBeGreaterThan(((8 * 1024) / 10) * 1000);
  expect(copied.scriptMs).toBeLessThanOrEqual(copied.sandboxMs);
});

test("a failed interim progress write leaves the review to finish, export and report ready", async () => {
  const request = countRequest();
  const runId = crypto.randomUUID();
  const published: Array<string> = [];
  let exported = false;
  let writes = 0;

  const status = (state: string) => ({ runId, state, admittedCalls: 1 });

  // SAFETY: for a count request runCloudReview calls only these execution members and
  // exportPackage, so the rest of the application service is never read.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const application = {
    execution: {
      start: () => Effect.succeed(status("running")),
      observe: () =>
        Stream.fromIterable([
          { runId, state: "running" },
          { runId, state: "completed" },
        ]),
      status: () => Effect.succeed(status("completed")),
      quiesce: Effect.void,
    },
    packets: {},
    exportPackage: () =>
      Effect.sync(() => {
        exported = true;
      }),
  } as unknown as Parameters<typeof runCloudReview>[0];

  await Effect.runPromise(
    runCloudReview(application, request, 60_000, "/unused", (progress) =>
      Effect.suspend(() => {
        writes += 1;

        // Every interim write fails, as a full or briefly unavailable disk would.
        if (progress.phase !== "ready")
          return Effect.fail(new CloudReviewError({ reason: "storage", message: "Disk full." }));

        published.push(progress.phase);

        return Effect.void;
      }),
    ),
  );

  expect(writes).toBeGreaterThan(1);
  expect(exported).toBe(true);
  expect(published).toEqual(["ready"]);
});
