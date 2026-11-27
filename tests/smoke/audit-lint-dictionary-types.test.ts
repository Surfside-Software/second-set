import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const plugin = fileURLToPath(new URL("../../tools/oxlint/anti-slop/index.ts", import.meta.url));

/** Run the repository's pinned Oxlint with only the two dictionary rules enabled. */
async function lint(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "second-set-audit-lint-"));

  try {
    const config = join(directory, "oxlint.json");
    const file = join(directory, "aliases.ts");
    await writeFile(
      config,
      JSON.stringify({
        jsPlugins: [{ name: "anti-slop", specifier: plugin }],
        rules: {
          "anti-slop/no-unsafe-dictionary-type": "error",
          "anti-slop/no-known-value-widening": "error",
        },
      }),
    );
    await writeFile(file, source);

    const result = spawnSync(process.execPath, ["--bun", "oxlint", "--config", config, file], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a generic alias argument that reuses the callee's parameter name lints without overflowing the stack", async () => {
  const result = await lint(
    [
      "type Maybe<T> = Record<string, T>;",
      "type Wrapper<T> = Maybe<T | undefined>;",
      "type Boxed<T> = Maybe<Readonly<T>>;",
      "export const wrapped: Wrapper<string> = {};",
      "export const boxed: Boxed<number> = {};",
      "",
    ].join("\n"),
  );

  expect(result.output).not.toContain("Maximum call stack");
  expect(result.status).toBe(0);
});

test("the same aliases still report an unsafe value and an open-key widening resolved through the caller", async () => {
  const result = await lint(
    [
      "type Maybe<T> = Record<string, T>;",
      "type Wrapper<T> = Maybe<T | undefined>;",
      "export type Open = Wrapper<unknown>;",
      "type Keyed<K extends PropertyKey> = Record<K, number>;",
      "type Wider<K extends PropertyKey> = Keyed<K | 'start'>;",
      "export const counts: Wider<string> = { start: 1 };",
      "",
    ].join("\n"),
  );

  expect(result.output).not.toContain("Maximum call stack");
  expect(result.status).toBe(1);
  expect(result.output).toContain("no-unsafe-dictionary-type");
  expect(result.output).toContain("no-known-value-widening");
});
