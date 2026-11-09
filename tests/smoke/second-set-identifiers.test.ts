import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../../backend/database-files.ts";
import { PackageManifest, packageFormat } from "#lib/review/packages.ts";
import { readStoredSetting, storedSettingKeys } from "#lib/review/stored-setting.ts";
import { cloudWorkerRoot } from "../../backend/cloud/contracts.ts";

const migrate = (filename: string, directory: string, backups: string) =>
  Effect.runPromise(Effect.scoped(migrateDatabase(filename, directory, backups)));

test("migration 0014 renames saved instruction identifiers and leaves provider history intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-identifiers-"));

  try {
    const earlier = join(directory, "earlier");
    await mkdir(earlier);

    for (const name of await readdir("migrations"))
      if (name < "0014") await copyFile(join("migrations", name), join(earlier, name));

    const filename = join(directory, "app.sqlite");
    const backups = join(directory, "backups");
    await migrate(filename, earlier, backups);

    const toolResult = JSON.stringify({
      note: "Leads from earlier MOKE reviews",
      prompt: "moke-packet-review-v10",
    });

    const database = new Database(filename);
    database.exec(`
      INSERT INTO review_projects (id, version, payload) VALUES ('p1', 0, '{}');
      INSERT INTO review_records (project_id, id, kind, payload) VALUES ('p1', 'm1', 'message',
        '{"id":"m1","projectId":"p1","origin":{"promptVersion":"moke-selected-coordination-v2"}}');
      INSERT INTO packet_reviews (id, project_id, conversation_id, command_id, fingerprint, source_version,
        owner_generation, journal_id, engine, payload) VALUES ('r1', 'p1', 'c', 'cmd1', 'f', 0, 'o', 'j1', 'e',
        '{"promptVersion":"moke-packet-review-v10","name":"Moke"}');
      INSERT INTO review_commands (command_id, project_id, fingerprint, receipt)
        VALUES ('cmd1', 'p1', 'f', '{"review":{"promptVersion":"moke-packet-review-v9"}}');
      INSERT INTO review_execution_runs (run_id, project_id, finding_id, journal_id, engine, owner_generation,
        source_version, fact_version, state, version, route, provider, model, max_calls, max_input_tokens,
        max_output_tokens, prompt_version) VALUES ('run1', 'p1', 'f1', 'j2', 'e', 'o', 0, 0, 'completed', 0,
        'live', 'meta', 'm', 1, 256, 16, 'moke-selected-coordination-v2');
      INSERT INTO review_execution_commands (command_id, project_id, run_id, fingerprint, response_json)
        VALUES ('cmd2', 'p1', 'run1', 'f', '{"promptVersion":"moke-selected-coordination-v2"}');
      INSERT INTO review_events (project_id, command_id, kind, message, created_at)
        VALUES ('p1', 'cmd1', 'packet_review', 'MOKE review response saved.', '2026-11-01');
    `);
    database
      .query(
        "INSERT INTO packet_review_tools (review_id, task_id, operation, result_json) VALUES ('r1', 1, 'o', ?)",
      )
      .run(toolResult);
    database.close();

    await migrate(filename, "migrations", backups);

    const migrated = new Database(filename, { readonly: true });

    const value = (sql: string) =>
      Object.values(migrated.query<Record<string, string>, []>(sql).get() ?? {})[0];

    expect(value("SELECT payload FROM review_records")).toBe(
      '{"id":"m1","projectId":"p1","origin":{"promptVersion":"second-set-selected-coordination-v2"}}',
    );
    expect(value("SELECT payload FROM packet_reviews")).toBe(
      '{"promptVersion":"second-set-packet-review-v10","name":"Moke"}',
    );
    expect(value("SELECT receipt FROM review_commands")).toContain('"second-set-packet-review-v9"');
    expect(value("SELECT prompt_version FROM review_execution_runs")).toBe(
      "second-set-selected-coordination-v2",
    );
    expect(value("SELECT response_json FROM review_execution_commands")).toContain(
      '"second-set-selected-coordination-v2"',
    );
    expect(value("SELECT message FROM review_events")).toBe("Second Set review response saved.");
    expect(value("SELECT result_json FROM packet_review_tools")).toBe(toolResult);
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packages exported before the rename still decode, and new ones use the Second Set format", () => {
  const manifest = {
    formatVersion: 1,
    scope: "application",
    scopeLabel: "whole-application",
    createdAt: "2026-11-01T00:00:00.000Z",
    hash: "sha256",
    engine: "review-pi-1.4.0-v1",
    migrations: [],
    database: { path: "app.sqlite", sha256: "a".repeat(64), bytes: 1 },
    artifacts: [],
    journals: [],
    runs: [],
  };

  const decode = Schema.decodeUnknownSync(PackageManifest);
  expect(packageFormat).toBe("second-set-review-package");
  expect(decode({ ...manifest, format: "moke-review-package" }).format).toBe("moke-review-package");
  expect(decode({ ...manifest, format: packageFormat }).format).toBe(packageFormat);
  expect(() => decode({ ...manifest, format: "other-package" })).toThrow();
});

test("a window setting saved under its MOKE key moves to the Second Set key once", () => {
  const saved = new Map([["moke.preferredReviewModel", "muse-spark"]]);

  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  };

  expect(readStoredSetting(storedSettingKeys.preferredReviewModel, storage)).toBe("muse-spark");
  expect([...saved]).toEqual([["second-set.preferredReviewModel", "muse-spark"]]);
  expect(readStoredSetting(storedSettingKeys.dismissedCloudReview, storage)).toBeNull();
});

test("cloud jobs keep the worker folder of the protocol they were dispatched with", () => {
  expect(cloudWorkerRoot({ workerProtocol: 6 })).toBe("/second-set");
  expect(cloudWorkerRoot({ workerProtocol: 5 })).toBe("/moke");
  expect(cloudWorkerRoot({})).toBe("/moke");
});
