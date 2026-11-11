/**
 * Decide which Verify desktop lanes a change needs. The Changes job in .github/workflows/ci.yml
 * runs this before any other job, from a sparse checkout without dependencies, so it imports
 * nothing. Linux checks and unit-tests every run; each lane below runs only when a changed path
 * can affect it. The workflow passes `everything` when it cannot list the changed paths.
 *
 * Entries ending in `/` match a directory, `*.ext` matches a root-level file, and anything else
 * matches one exact path. tests/smoke/ci-changes.test.ts fails when an entry matches no tracked
 * file, so a rename cannot silently stop a lane from running.
 */

/** Paths that no build, end-to-end or packaged test reads. Release changes run only at a tag. */
export const inertPaths = [
  ".github/workflows/release.yml",
  "docs/",
  "experiments/",
  "repos/",
  "tools/",
  ".project-kit/",
  ".vscode/",
  "*.md",
  "LICENSE",
  ".env.example",
  ".gitignore",
] as const;

/**
 * Inputs of the distributable installers alone: their targets and settings. Icons and
 * dependency updates, including Electron Builder's, package the unpacked app, which embeds the
 * icons. Release tags build every installer.
 */
export const installerInputs = [
  "electron-builder.json",
  ".github/workflows/ci.yml",
  "scripts/ci-changes.ts",
] as const;

/**
 * Inputs of the packaged app: dependencies and app metadata, icons, resource paths, and the
 * bundled backend with its PDF assets.
 */
export const packagingInputs = [
  "package.json",
  "bun.lock",
  ".bun-version",
  "desktop/icons/",
  "desktop/main.ts",
  "desktop/backend.ts",
  "scripts/build-icns.ts",
  "scripts/build-icons.ts",
  "scripts/pinned-bun.ts",
  "scripts/prepare-pdf-assets.ts",
  "scripts/test-packaged.ts",
] as const;

/**
 * Code whose behavior differs between Linux, Windows and macOS: the Electron main process, files,
 * processes and SQLite databases on disk, native modules, the desktop test harness, and the
 * toolchain. Tests of those modules count as well.
 */
export const platformSensitivePaths = [
  "desktop/",
  "backend/main.ts",
  "backend/database-files.ts",
  "backend/rename.ts",
  "backend/ownership.ts",
  "backend/documents/",
  "backend/cloud/cache.ts",
  "backend/cloud/files.ts",
  "backend/cloud/transfer.ts",
  "backend/review/package-files.ts",
  "backend/review/packages.ts",
  "bunfig.toml",
  "playwright.config.ts",
  ".gitattributes",
  "scripts/desktop-test-environment.ts",
  "scripts/isolated-desktop.ts",
  "tests/e2e/isolated-electron.ts",
  "tests/e2e/rpc-boundary.ts",
  "tests/e2e/rpc-control.ts",
  "tests/e2e/workbench-fixture.ts",
  "tests/smoke/backend-logging.test.ts",
  "tests/smoke/backend-request-limits.test.ts",
  "tests/smoke/backend.test.ts",
  "tests/smoke/credential-files.test.ts",
  "tests/smoke/credentials.test.ts",
  "tests/smoke/data-directory.test.ts",
  "tests/smoke/database-files.test.ts",
  "tests/smoke/desktop-test-environment.test.ts",
  "tests/smoke/documents.test.ts",
  "tests/smoke/drop-imports.test.ts",
  "tests/smoke/icons.test.ts",
  "tests/smoke/package-files.test.ts",
  "tests/smoke/pdf-assets.test.ts",
  "tests/smoke/rename.test.ts",
] as const;

/** What started the run, which fixes some lanes before any path is considered. */
export type ChangeScope = "pull-request" | "main" | "everything";

/** Verify desktop lanes beyond the Linux checks and unit tests that every run performs. */
export interface Lanes {
  /** Build the app and drive it unpackaged through the end-to-end suite. */
  readonly app: boolean;
  /** Repeat the unit tests, build and end-to-end suite on Windows and macOS. */
  readonly crossOs: boolean;
  /** Package the app and test the packaged executable. */
  readonly packaged: boolean;
  /** Build the distributable installers instead of only the unpacked app. */
  readonly installers: boolean;
  /** Run every packaged spec instead of the packaged smoke subset. */
  readonly fullPackagedSuite: boolean;
}

/** The lanes to run and the changed paths that selected them. */
export interface LaneDecision {
  readonly lanes: Lanes;
  readonly reasons: ReadonlyArray<string>;
}

/** Whether a path entry from the lists above matches a repository-relative file path. */
export function pathMatches(entry: string, file: string) {
  if (entry.endsWith("/")) return file.startsWith(entry);

  if (entry.startsWith("*.")) return !file.includes("/") && file.endsWith(entry.slice(1));

  return file === entry;
}

const matching = (entries: ReadonlyArray<string>, files: ReadonlyArray<string>) =>
  files.filter((file) => entries.some((entry) => pathMatches(entry, file)));

const allLanes: Lanes = {
  app: true,
  crossOs: true,
  packaged: true,
  installers: true,
  fullPackagedSuite: true,
};

/**
 * Choose the lanes for a run. A pull request runs what its changed paths can affect; each tier
 * includes the ones below it. Pushes to main run every Linux lane and the full packaged suite as
 * the backstop; Windows and macOS ran on the pull request when they were needed, and release tags
 * run them again before publishing.
 */
export function decideLanes(scope: ChangeScope, files: ReadonlyArray<string>): LaneDecision {
  if (scope === "everything") return { lanes: allLanes, reasons: ["Running every lane."] };

  if (scope === "main")
    return {
      lanes: { ...allLanes, crossOs: false, installers: false },
      reasons: ["A push to main runs every Linux lane."],
    };

  const installerPaths = matching(installerInputs, files);
  const packagingPaths = matching(packagingInputs, files);
  const platformPaths = matching(platformSensitivePaths, files);
  const installers = installerPaths.length > 0;
  const packaged = installers || packagingPaths.length > 0;
  const crossOs = packaged || platformPaths.length > 0;

  const app =
    crossOs || files.some((file) => !inertPaths.some((entry) => pathMatches(entry, file)));

  const reasons = [
    ["installers", installerPaths],
    ["packaged app", packagingPaths],
    ["Windows and macOS", platformPaths],
  ] as const;

  return {
    lanes: { app, crossOs, packaged, installers, fullPackagedSuite: false },
    reasons: reasons.flatMap(([lane, paths]) =>
      paths.length > 0 ? [`${lane}: ${paths.slice(0, 5).join(", ")}`] : [],
    ),
  };
}

/** Format lanes as GITHUB_OUTPUT lines. */
export function laneOutputs(lanes: Lanes) {
  return [
    `app=${lanes.app}`,
    `cross_os=${lanes.crossOs}`,
    `packaged=${lanes.packaged}`,
    `installers=${lanes.installers}`,
    `packaged_suite=${lanes.fullPackagedSuite ? "full" : "smoke"}`,
  ].join("\n");
}

const scopes: ReadonlyArray<ChangeScope> = ["pull-request", "main", "everything"];

if (import.meta.main) {
  const [scopeArgument, pathsFile] = process.argv.slice(2);
  const scope = scopes.find((candidate) => candidate === scopeArgument);

  if (scope === undefined || (scope === "pull-request" && pathsFile === undefined)) {
    console.error("Usage: bun scripts/ci-changes.ts pull-request <paths-file> | main | everything");
    process.exit(1);
  }

  const files =
    pathsFile === undefined
      ? []
      : (await Bun.file(pathsFile).text()).split("\n").filter((line) => line !== "");

  const decision = decideLanes(scope, files);

  for (const reason of decision.reasons) console.error(reason);
  console.log(laneOutputs(decision.lanes));
}
