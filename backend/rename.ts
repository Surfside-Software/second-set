import { rename } from "node:fs/promises";

/** Codes Windows returns while antivirus, indexing or a reader briefly holds either path open. */
const transientCodes: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

const transient = (cause: unknown) =>
  cause instanceof Error && "code" in cause && transientCodes.has(String(cause.code));

/**
 * Rename, replacing an existing target. On Windows a file written a moment ago is often held open
 * by antivirus or the search indexer, and replacing it fails until they let go; a cloud restore
 * left its journal unreplaced this way. Retry there for about ten seconds; elsewhere these codes
 * are real permission errors.
 */
export async function renameReplacing(
  from: string,
  to: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly rename?: (from: string, to: string) => Promise<void>;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const move = options.rename ?? rename;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let attempt = 0; ; attempt++) {
    try {
      return await move(from, to);
    } catch (cause) {
      if ((options.platform ?? process.platform) !== "win32" || attempt >= 12 || !transient(cause))
        throw cause;
      await sleep(Math.min(2000, 25 * 2 ** attempt));
    }
  }
}
