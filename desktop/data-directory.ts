import { existsSync } from "node:fs";
import { join } from "node:path";

/** Releases through 0.2.2 shipped as moke-meta-hackathon and kept their data under that name. */
export const legacyDataFolder = "moke-meta-hackathon";

/**
 * The userData directory to keep using after the Second Set rename, or null for Electron's own.
 * A workspace saved under the old name stays in place until the new location holds a database.
 */
export function legacyUserData(
  appData: string,
  userData: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const legacy = join(appData, legacyDataFolder);

  return !exists(join(userData, "app.sqlite")) && exists(join(legacy, "app.sqlite"))
    ? legacy
    : null;
}
