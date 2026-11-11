import { expect, test } from "bun:test";
import {
  decideLanes,
  inertPaths,
  installerInputs,
  laneOutputs,
  pathMatches,
  platformSensitivePaths,
} from "../../scripts/ci-changes.ts";

const pullRequest = (...files: Array<string>) => decideLanes("pull-request", files).lanes;

test("pull requests run only the lanes their changed paths can affect", () => {
  expect(pullRequest("README.md", "docs/deployment.md")).toEqual({
    app: false,
    crossOs: false,
    installers: false,
  });

  expect(pullRequest("src/lib/review/Workbench.svelte", "tests/e2e/polish.spec.ts")).toEqual({
    app: true,
    crossOs: false,
    installers: false,
  });

  expect(pullRequest("backend/rename.ts")).toEqual({ app: true, crossOs: true, installers: false });
  expect(pullRequest("bun.lock")).toEqual({ app: true, crossOs: true, installers: false });

  expect(pullRequest("electron-builder.json")).toEqual({
    app: true,
    crossOs: true,
    installers: true,
  });
});

test("pushes to main run the Linux lanes and manual or unknown changes run everything", () => {
  expect(decideLanes("main", []).lanes).toEqual({ app: true, crossOs: false, installers: false });

  expect(laneOutputs(decideLanes("everything", []).lanes)).toBe(
    "app=true\ncross_os=true\ninstallers=true",
  );

  expect(decideLanes("pull-request", ["desktop/main.ts"]).reasons).toEqual([
    "Windows and macOS: desktop/main.ts",
  ]);
});

test("every lane entry still matches a tracked file", () => {
  const tracked = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe" }).stdout.toString();
  const files = tracked.split("\n").filter((line) => line !== "");

  expect(files.length).toBeGreaterThan(0);

  for (const entry of [...inertPaths, ...installerInputs, ...platformSensitivePaths])
    expect({ entry, matched: files.some((file) => pathMatches(entry, file)) }).toEqual({
      entry,
      matched: true,
    });
});
