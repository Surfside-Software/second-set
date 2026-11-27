import { Effect, Exit, ManagedRuntime, Redacted, Schema, Semaphore } from "effect";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";

import { migrateDatabase, restoreDatabase } from "../../backend/database-files.ts";
import { Application } from "../../backend/application.ts";
import {
  exportReviewPackage,
  recoverInterruptedRestore,
  restoreReviewPackage,
  validateReviewPackage,
  type PackagesConfig,
} from "../../backend/review/packages.ts";
import { BackendConfig, DatabaseFileError } from "#lib/backend-rpc.ts";
import { PackageError, PackageFile, PackageJournalFile } from "#lib/review/packages.ts";
import { packageEngineFormat } from "#lib/review/packages.ts";

const migrations = resolve("migrations");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const failureOf = (effect: Effect.Effect<unknown, PackageError>) => run(effect.pipe(Effect.flip));

const migrate = (dataDirectory: string, directory = migrations) =>
  run(
    Effect.scoped(
      migrateDatabase(join(dataDirectory, "app.sqlite"), directory, join(dataDirectory, "backups")),
    ),
  );

const configFor = (
  dataDirectory: string,
  extras?: Omit<Partial<PackagesConfig>, "dataDirectory" | "queries">,
): PackagesConfig => ({
  dataDirectory,
  migrationDirectory: migrations,
  queries: Semaphore.makeUnsafe(1),
  quiesce: Effect.void,
  ...extras,
});

const seedNote = (directory: string, text: string) => {
  const database = new DatabaseSync(join(directory, "app.sqlite"));
  database.prepare("INSERT INTO notes(text) VALUES (?)").run(text);
  database.close();
};

const noteTexts = (directory: string) => {
  const database = new DatabaseSync(join(directory, "app.sqlite"), { readOnly: true });

  try {
    return database.prepare("SELECT text FROM notes ORDER BY id").all();
  } finally {
    database.close();
  }
};

/** One completed count run and its closed journal; no artifacts are needed. */
const seedRun = (dataDirectory: string) => {
  const journalId = randomUUID();
  const database = new DatabaseSync(join(dataDirectory, "app.sqlite"));

  database
    .prepare(
      `INSERT INTO review_execution_runs (
      run_id, project_id, finding_id, journal_id, engine, owner_generation,
      source_version, fact_version, state, version, route, provider, model,
      max_calls, max_input_tokens, max_output_tokens,
      admitted_calls, reserved_input_tokens, reserved_output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'completed', 0, 'live', 'meta', 'muse-spark-1.3', 4, 256, 16, 0, 0, 0)`,
    )
    .run(randomUUID(), randomUUID(), randomUUID(), journalId, packageEngineFormat, randomUUID());
  database.close();

  return writeJournal(dataDirectory, journalId);
};

const writeJournal = async (dataDirectory: string, journalId: string) => {
  await mkdir(join(dataDirectory, "execution-journals"), { recursive: true });
  const path = join(dataDirectory, "execution-journals", `${journalId}.sqlite`);
  const journal = new DatabaseSync(path);

  try {
    journal.exec(
      "CREATE TABLE review_journal_identity (id INTEGER PRIMARY KEY CHECK(id = 1), journal_id TEXT NOT NULL UNIQUE, format TEXT NOT NULL)",
    );
    journal
      .prepare("INSERT INTO review_journal_identity VALUES (1, ?, ?)")
      .run(journalId, packageEngineFormat);
  } finally {
    journal.close();
  }

  return { journalId, path };
};

const withRoot = async (prefix: string, body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), prefix));

  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Export a package holding one run and journal. */
const packagedRun = async (root: string) => {
  const source = join(root, "source");
  const destination = join(root, "package");

  await migrate(source);
  seedNote(source, "incoming-note");
  const seeded = await seedRun(source);
  await run(exportReviewPackage(configFor(source), destination));

  return { ...seeded, destination };
};

test("restore refuses live journals without app.sqlite instead of stranding a complete journal", () =>
  withRoot("audit-packages-orphan-", async (root) => {
    const packaged = await packagedRun(root);
    const current = join(root, "current");
    const orphan = await writeJournal(current, packaged.journalId);
    const before = await readFile(orphan.path);

    const refused = await failureOf(restoreReviewPackage(configFor(current), packaged.destination));

    expect(refused.reason).toBe("conflict");
    expect(refused.message).toContain("no app.sqlite");
    expect(await readFile(orphan.path)).toEqual(before);
    expect(existsSync(join(current, "app.sqlite"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "journal.json"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "incoming"))).toBe(false);
    expect((await run(recoverInterruptedRestore(current))).status).toBe("idle");
  }));

test("a manifest that lists one journal twice is refused before any file moves", () =>
  withRoot("audit-packages-duplicate-", async (root) => {
    const packaged = await packagedRun(root);
    const current = join(root, "current");

    await migrate(current);
    seedNote(current, "current-note");
    const original = await writeJournal(current, packaged.journalId);
    const before = await readFile(original.path);
    const manifestPath = join(packaged.destination, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    manifest.journals = [...manifest.journals, ...manifest.journals];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const invalid = await failureOf(
      validateReviewPackage(configFor(current), packaged.destination),
    );

    expect(invalid.reason).toBe("corrupt");

    const refused = await failureOf(restoreReviewPackage(configFor(current), packaged.destination));

    expect(refused.reason).toBe("corrupt");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect(await readFile(original.path)).toEqual(before);
    expect(existsSync(join(current, ".package-restore", "journal.json"))).toBe(false);
  }));

test("manifest file paths must stay package-relative", () => {
  const sha256 = "a".repeat(64);
  const journalId = randomUUID();

  const decodesFile = (path: string) =>
    Exit.isSuccess(Schema.decodeUnknownExit(PackageFile)({ path, sha256, bytes: 1 }));

  const decodesJournal = (path: string) =>
    Exit.isSuccess(
      Schema.decodeUnknownExit(PackageJournalFile)({
        path,
        sha256,
        bytes: 1,
        journalId,
        format: packageEngineFormat,
      }),
    );

  expect(decodesFile(`artifacts/${sha256}.pdf`)).toBe(true);
  expect(decodesFile("app.sqlite")).toBe(true);
  expect(decodesJournal(`journals/${journalId}.sqlite`)).toBe(true);

  for (const path of [
    "../../../.ssh/authorized_keys",
    "artifacts/../../escape.pdf",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "C:/Windows/win.ini",
    "artifacts\\file.pdf",
    "artifacts/./file.pdf",
    "artifacts//file.pdf",
    "artifacts/",
    "artifacts/a\0b.pdf",
  ]) {
    expect(decodesFile(path)).toBe(false);
    expect(decodesJournal(path)).toBe(false);
  }
});

test("rollback removes discarded package copies and the emptied save directory", () =>
  withRoot("audit-packages-rollback-", async (root) => {
    const source = join(root, "source");
    const current = join(root, "current");
    const destination = join(root, "package");

    await migrate(source);
    await migrate(current);
    seedNote(source, "incoming-note");
    seedNote(current, "original-note");
    await run(exportReviewPackage(configFor(source), destination));

    const stopped = await failureOf(
      restoreReviewPackage(
        configFor(current, { interruptAfter: "database-replaced" }),
        destination,
      ),
    );

    expect(stopped.reason).toBe("interrupted");
    expect((await run(recoverInterruptedRestore(current))).status).toBe("rolled-back");
    expect(noteTexts(current)).toEqual([{ text: "original-note" }]);
    expect(existsSync(join(current, ".package-restore", "discarded"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "saved"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "incoming"))).toBe(false);
  }));

test("a failed live checkpoint removes the snapshot written for that attempt", () =>
  withRoot("audit-packages-checkpoint-", async (root) => {
    const packaged = await packagedRun(root);
    const current = join(root, "current");

    await migrate(current);
    seedNote(current, "current-note");
    await mkdir(join(current, "execution-journals"), { recursive: true });
    // An unreferenced live file at the incoming journal's name that SQLite cannot checkpoint.
    const unreadable = join(current, "execution-journals", `${packaged.journalId}.sqlite`);
    await writeFile(unreadable, "not a database");

    const failed = await failureOf(restoreReviewPackage(configFor(current), packaged.destination));

    expect(failed.reason).toBe("unavailable");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect(await readFile(unreadable, "utf8")).toBe("not a database");
    expect(await readdir(join(current, ".package-restore", "retained"))).toEqual([]);
    expect(existsSync(join(current, ".package-restore", "journal.json"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "incoming"))).toBe(false);
  }));

test("a restore that fails before its journal removes the staged copy", () =>
  withRoot("audit-packages-staging-", async (root) => {
    const packaged = await packagedRun(root);
    const current = join(root, "current");

    await migrate(current);
    seedNote(current, "current-note");
    // The current workspace cannot be packaged because its run journal is missing.
    await rm((await seedRun(current)).path);

    const failed = await failureOf(restoreReviewPackage(configFor(current), packaged.destination));

    expect(failed.reason).toBe("incomplete");
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect(existsSync(join(current, ".package-restore", "incoming"))).toBe(false);
    expect(existsSync(join(current, ".package-restore", "journal.json"))).toBe(false);
  }));

const notesMigrations = async (root: string) => {
  const directory = join(root, "migrations");
  await mkdir(directory);
  await copyFile(join(migrations, "0001_notes.sql"), join(directory, "0001_notes.sql"));

  return directory;
};

const historyOf = (filename: string) => {
  const database = new DatabaseSync(filename, { readOnly: true });

  try {
    return database.prepare("SELECT name FROM __project_kit_migrations ORDER BY name").all();
  } finally {
    database.close();
  }
};

test("database restore migrates an older backup before it replaces the live file", () =>
  withRoot("audit-packages-old-backup-", async (root) => {
    const directory = await notesMigrations(root);
    const old = join(root, "old");
    const current = join(root, "current");

    await migrate(old, directory);
    seedNote(old, "older-note");
    await writeFile(
      join(directory, "0002_settings.sql"),
      "CREATE TABLE settings (name TEXT PRIMARY KEY);",
    );
    await migrate(current, directory);
    seedNote(current, "current-note");

    await run(
      Effect.scoped(
        restoreDatabase(
          join(current, "app.sqlite"),
          join(old, "app.sqlite"),
          directory,
          join(current, "backups"),
        ),
      ),
    );

    expect(noteTexts(current)).toEqual([{ text: "older-note" }]);
    expect(historyOf(join(current, "app.sqlite"))).toEqual([
      { name: "0001_notes.sql" },
      { name: "0002_settings.sql" },
    ]);
    // The selected backup stays as it was.
    expect(historyOf(join(old, "app.sqlite"))).toEqual([{ name: "0001_notes.sql" }]);
    expect((await readdir(current)).filter((name) => name.endsWith(".restore"))).toEqual([]);
  }));

test("a backup whose migration fails leaves the live database and backups unchanged", () =>
  withRoot("audit-packages-failed-backup-", async (root) => {
    const directory = await notesMigrations(root);
    const old = join(root, "old");
    const current = join(root, "current");

    await migrate(old, directory);
    seedNote(old, "duplicate");
    seedNote(old, "duplicate");
    await writeFile(
      join(directory, "0002_unique_notes.sql"),
      "CREATE UNIQUE INDEX notes_unique_text ON notes(text);",
    );
    await migrate(current, directory);
    seedNote(current, "current-note");
    const backups = join(current, "backups");
    const before = existsSync(backups) ? await readdir(backups) : [];

    const failed = await run(
      Effect.scoped(
        restoreDatabase(join(current, "app.sqlite"), join(old, "app.sqlite"), directory, backups),
      ).pipe(Effect.flip),
    );

    expect(failed).toBeInstanceOf(DatabaseFileError);
    expect(noteTexts(current)).toEqual([{ text: "current-note" }]);
    expect(existsSync(backups) ? await readdir(backups) : []).toEqual(before);
    expect((await readdir(current)).filter((name) => name.endsWith(".restore"))).toEqual([]);
  }));

test("a committed migration still starts when an old backup cannot be pruned", () =>
  withRoot("audit-packages-prune-", async (root) => {
    const directory = await notesMigrations(root);
    const data = join(root, "data");
    const backups = join(data, "backups");

    await migrate(data, directory);
    await mkdir(backups, { recursive: true });

    for (const day of [1, 2, 3, 4, 5])
      await writeFile(join(backups, `1999-01-0${day}-before-migration-${randomUUID()}.sqlite`), "");

    // A directory cannot be removed by a plain rm, like a backup a sync client holds open.
    const locked = join(backups, `0000-01-01-before-migration-${randomUUID()}.sqlite`);
    await mkdir(locked);
    await writeFile(join(locked, "held"), "");
    await writeFile(
      join(directory, "0002_settings.sql"),
      "CREATE TABLE settings (name TEXT PRIMARY KEY);",
    );

    await migrate(data, directory);

    expect(historyOf(join(data, "app.sqlite"))).toHaveLength(2);
    expect(existsSync(locked)).toBe(true);
    expect((await readdir(backups)).filter((name) => name.startsWith("1999-01-01"))).toHaveLength(
      0,
    );
  }));

test("database restore reports the specific reason it was refused", () =>
  withRoot("audit-packages-restore-reason-", async (root) => {
    const current = join(root, "current");
    const future = join(root, "future");

    await migrate(future);
    const database = new DatabaseSync(join(future, "app.sqlite"));
    database
      .prepare("INSERT INTO __project_kit_migrations (name, sha256) VALUES (?, ?)")
      .run("9999_future.sql", "0".repeat(64));
    database.close();

    const runtime: ManagedRuntime.ManagedRuntime<Application, unknown> = ManagedRuntime.make(
      Application.layer(
        new BackendConfig({
          dataDirectory: current,
          migrationDirectory: migrations,
          token: Redacted.make("t".repeat(32)),
        }),
        { runPromise: (effect, options) => runtime.runPromise(effect, options) },
      ),
    );

    try {
      const application = await runtime.runPromise(Application);

      const failed = await runtime.runPromise(
        application.restore(join(future, "app.sqlite")).pipe(Effect.flip),
      );

      expect(failed.message).toBe("This backup uses incompatible migrations.");
    } finally {
      await runtime.dispose();
    }
  }));
