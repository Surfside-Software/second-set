import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electron } from "./isolated-electron.ts";
import { offlineDesktop, openWindow } from "./workbench-fixture.ts";

const savedKey = "offline-saved-key-never-dispatched";
const importedKey = "offline-imported-key-never-dispatched";

const StoredCredential = Schema.fromJsonString(Schema.Struct({ encrypted: Schema.String }));

const SavedProviders = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Array(Schema.Struct({ provider: Schema.String, apiKey: Schema.String })),
  }),
);

test("importing a provider credential uses OS encryption and keeps saved providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "second-set-credentials-"));
  const source = join(directory, "baseten.json");
  const stored = join(directory, "provider-credential.json");

  await writeFile(
    source,
    JSON.stringify({
      providers: [
        {
          provider: "baseten",
          apiKey: importedKey,
          baseUrl: "https://inference.baseten.co/v1",
          model: "meta-models/muse-spark-open-1026",
        },
      ],
    }),
    { mode: 0o600 },
  );

  // Without a session credential file, the app reads and writes its encrypted store.
  const options = await offlineDesktop(directory, []);
  options.env = { PROJECT_KIT_DATA_DIRECTORY: directory };
  const app = await electron.launch(options);

  try {
    await openWindow(app);
    // Test sessions on Linux hide the OS secret service, as on a desktop whose keyring is not
    // running. Encryption then falls back to Chromium's public key, so the app must refuse to save.
    const secure = process.platform !== "linux";

    if (secure) {
      // Credentials saved by earlier builds used this synchronous API, removed in Electron 46.
      const encrypted = await app.evaluate(
        ({ safeStorage }, text) => safeStorage.encryptString(text).toString("base64"),
        JSON.stringify({
          providers: [
            {
              provider: "meta",
              apiKey: savedKey,
              baseUrl: "https://api.meta.ai/v1",
              model: "muse-spark-1.3",
            },
          ],
        }),
      );

      await writeFile(stored, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
    }

    await app.evaluate(({ app, dialog, Menu }, path) => {
      const quit = app.quit.bind(app);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });

      dialog.showErrorBox = () => {
        process.env.MOKE_E2E_CREDENTIAL = "refused";
      };

      // Stay open for the checks below; the next quit closes the app normally.
      app.relaunch = () => {
        process.env.MOKE_E2E_CREDENTIAL = "saved";

        app.quit = () => {
          app.quit = quit;
        };
      };

      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => entry.label === "Import provider credential configuration…");

      if (item === undefined) throw new Error("Missing the provider credential menu item.");
      item.click();
    }, source);

    await expect
      .poll(() => app.evaluate(() => process.env.MOKE_E2E_CREDENTIAL), { timeout: 20000 })
      .toBe(secure ? "saved" : "refused");

    if (!secure) {
      await expect(readFile(stored, "utf8")).rejects.toThrow();

      return;
    }

    const file = await readFile(stored, "utf8");
    expect(file).not.toContain(savedKey);
    expect(file).not.toContain(importedKey);

    const { encrypted } = Schema.decodeUnknownSync(StoredCredential)(file);

    const decrypted = await app.evaluate(async ({ safeStorage }, value) => {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(value, "base64"));

      return result;
    }, encrypted);

    const { providers } = Schema.decodeUnknownSync(SavedProviders)(decrypted);

    expect(providers.map(({ provider, apiKey }) => [provider, apiKey])).toEqual([
      ["baseten", importedKey],
      ["meta", savedKey],
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
