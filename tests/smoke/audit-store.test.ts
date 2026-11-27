import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateDatabase } from "../../backend/database-files.ts";
import { ImportedPdf } from "../../backend/documents/types.ts";
import { ReviewStore } from "../../backend/review/store.ts";
import {
  CommandId,
  FindingId,
  ReviewCommand,
  ReviewError,
  ReviewInputError,
  ReviewStorageError,
  RevisionId,
} from "#lib/review/contracts.ts";

const id = () => Schema.decodeUnknownSync(CommandId)(crypto.randomUUID());

const page = (pageIndex: number) => ({
  pageIndex,
  label: `Page ${pageIndex + 1}`,
  box: { x: 0, y: 0, width: 100, height: 100 },
  rotation: 0 as const,
  userUnit: 1,
});

const pdf = (pages: number) =>
  new ImportedPdf({
    sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    byteLength: 100,
    pages: Array.from({ length: pages }, (_, index) => page(index)),
  });

/** A migrated workbench database whose store calls each use a fresh connection. */
async function workbench(directory: string) {
  const filename = join(directory, "app.sqlite");
  await Effect.runPromise(
    Effect.scoped(migrateDatabase(filename, resolve("migrations"), join(directory, "backups"))),
  );

  const run = <A>(
    operation: (store: ReviewStore["Service"]) => Effect.Effect<A, typeof ReviewError.Type>,
  ) =>
    Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA foreign_keys=ON`;

            return yield* Effect.flatMap(ReviewStore, operation).pipe(
              Effect.provide(ReviewStore.layer),
            );
          }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
        ).pipe(
          Effect.mapError((cause) =>
            Schema.is(ReviewError)(cause)
              ? cause
              : new ReviewStorageError({ message: "Test SQL failed." }),
          ),
        ),
      ),
    );

  const value = async <A>(
    operation: (store: ReviewStore["Service"]) => Effect.Effect<A, typeof ReviewError.Type>,
  ) => {
    const result = await run(operation);

    if (Result.isFailure(result)) throw new Error(result.failure.message);

    return result.success;
  };

  /** Copies one stored record of a kind until the project holds `total` of that kind. */
  const fill = (projectId: string, kind: string, total: number) => {
    const database = new Database(filename);

    try {
      const template = database
        .query<{ payload: string }, [string, string]>(
          "SELECT payload FROM review_records WHERE project_id=? AND kind=? LIMIT 1",
        )
        .get(projectId, kind);

      const count = database
        .query<{ n: number }, [string, string]>(
          "SELECT count(*) AS n FROM review_records WHERE project_id=? AND kind=?",
        )
        .get(projectId, kind);

      if (template === null || count === null) throw new Error(`No ${kind} record to copy.`);

      const insert = database.query(
        "INSERT INTO review_records (project_id,id,kind,payload) VALUES (?,?,?,json_set(?,'$.id',?))",
      );

      database.transaction(() => {
        for (let index = count.n; index < total; index++) {
          const next = crypto.randomUUID();
          insert.run(projectId, next, kind, template.payload, next);
        }
      })();
    } finally {
      database.close();
    }
  };

  return { run, value, fill };
}

const inputError = (result: Result.Result<unknown, typeof ReviewError.Type>) =>
  Result.isFailure(result) && Schema.is(ReviewInputError)(result.failure);

test("CreateProject stops at the 100 projects a snapshot can read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-store-projects-"));

  try {
    const { run, value } = await workbench(directory);

    for (let index = 0; index < 100; index++)
      await value((store) =>
        store.execute(
          ReviewCommand.cases.CreateProject.make({ commandId: id(), name: `Project ${index}` }),
        ),
      );

    const extra = await run((store) =>
      store.execute(ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Extra" })),
    );

    expect(inputError(extra)).toBe(true);
    const snapshot = await value((store) => store.snapshot(null, 0));
    expect(snapshot.projects).toHaveLength(100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("writes that would exceed the per-kind read limit fail before commit and keep the project readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-store-records-"));

  try {
    const { run, value, fill } = await workbench(directory);

    const created = await value((store) =>
      store.execute(ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Large" })),
    );

    const projectId = created.projectId;
    const snapshot = () => value((store) => store.snapshot(projectId, 0));

    const importPages = (pages: number, expectedVersion: number) =>
      run((store) =>
        store.importPdf({ commandId: id(), projectId, expectedVersion, name: "Set" }, pdf(pages)),
      );

    await importPages(1, created.version);
    fill(projectId, "sheet", 1999);

    // Two more pages would leave 2001 sheets, which every later snapshot rejects.
    let state = await snapshot();
    expect(inputError(await importPages(2, state.project?.version ?? -1))).toBe(true);
    state = await snapshot();
    expect(state.sheets).toHaveLength(1999);
    expect(state.revisions).toHaveLength(1);

    // Exactly reaching the limit is still allowed and readable.
    expect(Result.isSuccess(await importPages(1, state.project?.version ?? -1))).toBe(true);
    state = await snapshot();
    expect(state.sheets).toHaveLength(2000);

    const conversation = state.conversations[0];

    if (conversation === undefined) throw new Error("Missing project conversation.");

    const post = (expectedVersion: number) =>
      run((store) =>
        store.execute(
          ReviewCommand.cases.PostMessage.make({
            commandId: id(),
            projectId,
            expectedVersion,
            conversationId: conversation.id,
            text: "Check the schedule.",
          }),
        ),
      );

    expect(Result.isSuccess(await post(state.project?.version ?? -1))).toBe(true);
    fill(projectId, "message", 2000);
    state = await snapshot();
    expect(inputError(await post(state.project?.version ?? -1))).toBe(true);
    state = await snapshot();
    expect(state.messages).toHaveLength(2000);

    // Updating an existing record does not count as a new one.
    const sheet = state.sheets[0];

    if (sheet === undefined) throw new Error("Missing sheet.");

    const confirmed = await run((store) =>
      store.execute(
        ReviewCommand.cases.ConfirmSheet.make({
          commandId: id(),
          projectId,
          expectedVersion: state.project?.version ?? -1,
          sheetId: sheet.id,
          label: "A-101",
          coverage: "reviewer_complete",
        }),
      ),
    );

    expect(Result.isSuccess(confirmed)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

/** A project whose revisions are imported directly, so tests control every sheet. */
async function revisedProject(directory: string, revisions: ReadonlyArray<number>) {
  const workbench_ = await workbench(directory);
  const { value } = workbench_;

  const created = await value((store) =>
    store.execute(ReviewCommand.cases.CreateProject.make({ commandId: id(), name: "Revisions" })),
  );

  const projectId = created.projectId;
  const snapshot = () => value((store) => store.snapshot(projectId, 0));

  for (const pages of revisions) {
    const state = await snapshot();
    await value((store) =>
      store.importPdf(
        {
          commandId: id(),
          projectId,
          expectedVersion: state.project?.version ?? -1,
          name: "Set",
        },
        pdf(pages),
      ),
    );
  }

  const state = await snapshot();

  const sheetsOf = (revision: number) =>
    state.sheets.filter((sheet) => sheet.revisionId === state.revisions[revision]?.id);

  const command = async (
    make: (expectedVersion: number) => typeof ReviewCommand.Type,
  ): Promise<Result.Result<unknown, typeof ReviewError.Type>> => {
    const current = await snapshot();

    return workbench_.run((store) => store.execute(make(current.project?.version ?? -1)));
  };

  const confirm = (sheetId: (typeof state.sheets)[number]["id"]) =>
    command((expectedVersion) =>
      ReviewCommand.cases.ConfirmSheet.make({
        commandId: id(),
        projectId,
        expectedVersion,
        sheetId,
        label: "Confirmed",
        coverage: "reviewer_complete",
      }),
    );

  const finding = async (
    drawnSheetId: (typeof state.sheets)[number]["id"],
    scheduledSheetId: (typeof state.sheets)[number]["id"],
  ) => {
    const result = await command((expectedVersion) =>
      ReviewCommand.cases.CreateFinding.make({
        commandId: id(),
        projectId,
        expectedVersion,
        title: "Count",
        objectClass: "Fixtures",
        drawnSheetId,
        scheduledSheetId,
        applicabilityConfirmed: true,
      }),
    );

    if (Result.isFailure(result)) throw new Error(result.failure.message);

    return Schema.decodeUnknownSync(Schema.Struct({ entityId: FindingId }))(result.success)
      .entityId;
  };

  const associate = (
    revision: number,
    correspondence: typeof ReviewCommand.cases.AssociateRevision.Type.correspondence,
  ) =>
    command((expectedVersion) =>
      ReviewCommand.cases.AssociateRevision.make({
        commandId: id(),
        projectId,
        expectedVersion,
        revisionId: Schema.decodeUnknownSync(RevisionId)(state.revisions[revision]?.id),
        correspondence,
      }),
    );

  return { projectId, snapshot, sheetsOf, command, confirm, finding, associate };
}

test("a later AssociateRevision keeps sheets confirmed by an earlier one and leaves unmapped findings alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-store-associate-"));

  try {
    // Revision 0 is a plan and its schedule, revision 1 a separate schedule document,
    // revision 2 the revised plan and schedule.
    const project = await revisedProject(directory, [2, 1, 2]);
    const [plan, schedule] = project.sheetsOf(0);
    const [separate] = project.sheetsOf(1);
    const [newPlan, newSchedule] = project.sheetsOf(2);

    if (!plan || !schedule || !separate || !newPlan || !newSchedule)
      throw new Error("Missing fixture sheets.");

    for (const sheet of [plan, schedule, separate]) await project.confirm(sheet.id);
    const mapped = await project.finding(plan.id, schedule.id);
    const control = await project.finding(separate.id, separate.id);

    // A control check on the separate document has a real outcome to preserve.
    for (const side of ["drawn", "scheduled"] as const)
      await project.command((expectedVersion) =>
        ReviewCommand.cases.AcceptCount.make({
          commandId: id(),
          projectId: project.projectId,
          expectedVersion,
          findingId: control,
          side,
          value: 2,
          unit: "count",
          coverageConfirmed: true,
          evidence: { sheetId: separate.id, region: separate.box, statement: "Two fixtures." },
          rationale: "Reviewed.",
        }),
      );

    await project.command((expectedVersion) =>
      ReviewCommand.cases.EvaluateFinding.make({
        commandId: id(),
        projectId: project.projectId,
        expectedVersion,
        findingId: control,
      }),
    );

    // Command 1 maps the drawn plan; the schedule is left unresolved for now.
    expect(
      Result.isSuccess(
        await project.associate(2, [
          { oldSheetId: plan.id, newSheetId: newPlan.id, confirmed: true, content: "changed" },
          { oldSheetId: schedule.id, newSheetId: null, confirmed: false, content: "unresolved" },
        ]),
      ),
    ).toBe(true);

    let state = await project.snapshot();
    const sheet = (sheetId: string) => state.sheets.find((item) => item.id === sheetId);
    const findingOf = (findingId: string) => state.findings.find((item) => item.id === findingId);
    expect(findingOf(mapped)).toMatchObject({ drawnSheetId: newPlan.id, outcome: "stale" });
    expect(sheet(newPlan.id)?.confirmed).toBe(true);
    expect(sheet(schedule.id)?.confirmed).toBe(false);
    // The separate schedule document was not part of either decision.
    expect(findingOf(control)?.outcome).toBe("checked_no_issue");
    expect(sheet(separate.id)?.confirmed).toBe(true);

    // Command 2 maps the schedule; it must not unconfirm the plan command 1 confirmed.
    expect(
      Result.isSuccess(
        await project.associate(2, [
          {
            oldSheetId: schedule.id,
            newSheetId: newSchedule.id,
            confirmed: true,
            content: "unchanged",
          },
        ]),
      ),
    ).toBe(true);

    state = await project.snapshot();
    expect(findingOf(mapped)).toMatchObject({
      drawnSheetId: newPlan.id,
      scheduledSheetId: newSchedule.id,
    });
    expect(sheet(newPlan.id)?.confirmed).toBe(true);
    expect(sheet(newSchedule.id)?.confirmed).toBe(true);
    expect(findingOf(control)?.outcome).toBe("checked_no_issue");
    expect(sheet(separate.id)?.confirmed).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("a sheet confirmed as removed cannot later be linked or given another decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-store-removed-"));

  try {
    const project = await revisedProject(directory, [1, 1]);
    const [old] = project.sheetsOf(0);
    const [next] = project.sheetsOf(1);

    if (!old || !next) throw new Error("Missing fixture sheets.");

    expect(
      Result.isSuccess(
        await project.associate(1, [
          { oldSheetId: old.id, newSheetId: null, confirmed: true, content: "removed" },
        ]),
      ),
    ).toBe(true);

    for (const correspondence of [
      [{ oldSheetId: old.id, newSheetId: next.id, confirmed: true, content: "unchanged" }],
      [{ oldSheetId: old.id, newSheetId: next.id, confirmed: false, content: "changed" }],
      [{ oldSheetId: old.id, newSheetId: null, confirmed: false, content: "unresolved" }],
    ] as const)
      expect(inputError(await project.associate(1, correspondence))).toBe(true);

    const state = await project.snapshot();
    expect(state.sheetCorrespondence).toEqual([
      expect.objectContaining({ oldSheetId: old.id, newSheetId: null, content: "removed" }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
