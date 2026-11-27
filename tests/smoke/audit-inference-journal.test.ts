import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalFormat, openReviewJournal } from "../../backend/inference/journal.ts";

/** Read the identity rows a journal file holds, or none when its table was never committed. */
function identity(filename: string) {
  const database = new Database(filename, { readonly: true });

  try {
    const table = database
      .query("SELECT name FROM sqlite_master WHERE name='review_journal_identity'")
      .all();

    return table.length === 0
      ? []
      : database.query("SELECT journal_id, format FROM review_journal_identity").all();
  } finally {
    database.close();
  }
}

test("a journal whose identity never committed can be created again and then reopens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audit-inference-journal-"));
  const journalId = randomUUID();
  const filename = join(directory, "execution-journals", `${journalId}.sqlite`);

  try {
    // A crash before the identity transaction commits leaves a WAL file with no tables.
    await mkdir(join(directory, "execution-journals"), { recursive: true });
    const leftover = new Database(filename, { create: true });
    leftover.exec("PRAGMA journal_mode=WAL");
    leftover.close();
    expect(identity(filename)).toEqual([]);

    const created = await openReviewJournal(directory, journalId, false);
    await created.close(BACKGROUND_CONTEXT);
    expect(identity(filename)).toEqual([{ journal_id: journalId, format: journalFormat }]);

    const reopened = await openReviewJournal(directory, journalId, true);
    await reopened.close(BACKGROUND_CONTEXT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creating a journal that already exists fails and leaves it intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audit-inference-journal-"));
  const journalId = randomUUID();
  const filename = join(directory, "execution-journals", `${journalId}.sqlite`);

  try {
    const created = await openReviewJournal(directory, journalId, false);
    await created.close(BACKGROUND_CONTEXT);

    const rejected = await openReviewJournal(directory, journalId, false).then(
      async (storage) => {
        await storage.close(BACKGROUND_CONTEXT);

        return false;
      },
      () => true,
    );

    expect(rejected).toBe(true);
    // The rolled-back attempt neither duplicated nor removed the identity.
    expect(identity(filename)).toEqual([{ journal_id: journalId, format: journalFormat }]);
    const reopened = await openReviewJournal(directory, journalId, true);
    await reopened.close(BACKGROUND_CONTEXT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
