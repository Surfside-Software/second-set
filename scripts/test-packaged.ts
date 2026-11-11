import { Match } from "effect";

const patterns = {
  linux: "release/linux*-unpacked/second-set",
  win32: "release/win*-unpacked/Second Set.exe",
  darwin: "release/mac*/Second Set.app/Contents/MacOS/Second Set",
};

const pattern = Match.value(process.platform).pipe(
  Match.when("linux", () => patterns.linux),
  Match.when("win32", () => patterns.win32),
  Match.when("darwin", () => patterns.darwin),
  Match.orElse(() => undefined),
);

if (pattern === undefined) {
  console.error("Packaged desktop tests require Linux, Windows, or macOS.");
  process.exit(1);
}

const executables = Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true }));
const executable = executables[0];

if (executable === undefined || executables.length !== 1) {
  console.error(
    "Expected exactly one packaged desktop application. Clean release/ and package the app first.",
  );
  process.exit(1);
}

// The packaged app differs from `bun run test:e2e` only in how it is assembled: the backend, PDF
// worker, assets and migrations load from its resources, and credentials use the packaged app's
// own OS encryption and data directory. These specs cover startup, PDF import and rendering,
// encrypted credentials and a reopen. Pull request CI runs them; main and releases run every spec.
const smokeSpecs = ["e2e/credentials.spec.ts", "e2e/polish.spec.ts", "e2e/review.spec.ts"];
const args = process.argv.slice(2);

const filters = args.includes("--smoke")
  ? [...smokeSpecs, ...args.filter((argument) => argument !== "--smoke")]
  : args;

const child = Bun.spawn([process.execPath, "run", "test:e2e", ...filters], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, PROJECT_KIT_EXECUTABLE: executable },
});

process.exitCode = await child.exited;
