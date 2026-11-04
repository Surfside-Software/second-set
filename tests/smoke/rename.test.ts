import { expect, test } from "bun:test";
import { renameReplacing } from "../../backend/rename.ts";

const failing = (codes: ReadonlyArray<string>) => {
  const calls: Array<string> = [];

  const rename = async (from: string, to: string) => {
    calls.push(`${from}->${to}`);
    const code = codes[calls.length - 1];

    if (code !== undefined) throw Object.assign(new Error(code), { code });
  };

  return { calls, rename };
};

const sleep = async () => undefined;

test("a Windows rename held open briefly by another process is retried until it succeeds", async () => {
  const { calls, rename } = failing(["EPERM", "EBUSY"]);

  await renameReplacing("journal.tmp", "journal.json", { platform: "win32", rename, sleep });

  expect(calls).toHaveLength(3);
});

test("permission errors elsewhere and other codes fail at once", async () => {
  for (const [platform, code] of [
    ["linux", "EACCES"],
    ["win32", "ENOENT"],
  ] as const) {
    const { calls, rename } = failing([code]);

    await expect(renameReplacing("a", "b", { platform, rename, sleep })).rejects.toMatchObject({
      code,
    });
    expect(calls).toHaveLength(1);
  }
});

test("a lock that never clears still fails after the retries", async () => {
  const { calls, rename } = failing(Array.from({ length: 20 }, () => "EPERM"));

  await expect(
    renameReplacing("a", "b", { platform: "win32", rename, sleep }),
  ).rejects.toMatchObject({ code: "EPERM" });
  expect(calls).toHaveLength(13);
});
