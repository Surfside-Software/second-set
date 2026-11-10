import { afterEach, expect, mock, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewProviderRoutes } from "#lib/review/models.ts";
import { parseProviderConfiguration } from "../../desktop/credential-files.ts";

// A keychain whose key follows the app's name, as macOS and Linux safeStorage do.
const keychain = { name: "moke-meta-hackathon", available: true };

void mock.module("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => keychain.available,
    encryptStringAsync: async (plain: string) => Buffer.from(`${keychain.name}:${plain}`),
    decryptStringAsync: async (encrypted: Buffer) => {
      const text = encrypted.toString();

      if (!text.startsWith(`${keychain.name}:`)) throw new Error("Wrong keychain entry");

      return { result: text.slice(keychain.name.length + 1), shouldReEncrypt: false };
    },
  },
}));

const credentials = await import("../../desktop/credentials.ts");
const session = process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;

afterEach(() => {
  keychain.name = "moke-meta-hackathon";
  keychain.available = true;

  if (session === undefined) delete process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;
  else process.env.SECOND_SET_SESSION_CREDENTIAL_FILE = session;
});

const connection = (provider: "meta" | "opencode-go", apiKey: string) => ({
  provider,
  apiKey,
  baseUrl: reviewProviderRoutes[provider].endpoint,
  model: reviewProviderRoutes[provider].model,
});

const importFile = async (directory: string, apiKey: string) => {
  const source = join(directory, `import-${apiKey}.json`);
  await writeFile(source, JSON.stringify({ providers: [connection("meta", apiKey)] }), {
    mode: 0o600,
  });

  return source;
};

const providers = (configurations: ReadonlyArray<{ provider: string }>) =>
  configurations.map((entry) => entry.provider);

test("keys saved under the old app name are skipped, and new keys replace them", async () => {
  delete process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;
  const directory = await mkdtemp(join(tmpdir(), "second-set-credentials-"));

  try {
    await credentials.storeInferenceConfiguration(
      directory,
      await importFile(directory, "old-meta"),
    );
    await credentials.storeSettingsConnection(
      directory,
      parseProviderConfiguration(JSON.stringify(connection("opencode-go", "old-go"))),
    );
    expect(
      providers((await credentials.readInferenceConfigurations(directory, true)).configurations),
    ).toEqual(["meta", "opencode-go"]);

    keychain.name = "Second Set";
    const stale = await credentials.readInferenceConfigurations(directory, true);
    expect(stale.configurations).toEqual([]);
    expect(stale.unreadable.map(({ file, reason }) => [file, reason])).toEqual([
      ["provider-credential.json", "locked"],
      ["opencode-go-credential.json", "locked"],
    ]);

    // Removing another connection ignores the stale imported copy instead of failing.
    await credentials.removeSettingsConnection(directory, "openai-compatible");

    await credentials.storeInferenceConfiguration(
      directory,
      await importFile(directory, "new-meta"),
    );
    const partial = await credentials.readInferenceConfigurations(directory, true);
    expect(providers(partial.configurations)).toEqual(["meta"]);
    expect(partial.unreadable.map(({ file }) => file)).toEqual(["opencode-go-credential.json"]);

    await credentials.storeSettingsConnection(
      directory,
      parseProviderConfiguration(JSON.stringify(connection("opencode-go", "new-go"))),
    );
    const restored = await credentials.readInferenceConfigurations(directory, true);
    expect(providers(restored.configurations)).toEqual(["meta", "opencode-go"]);
    expect(restored.unreadable).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forgetting keys that no longer unlock stops the prompt after a Review settings restore", async () => {
  delete process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;
  const directory = await mkdtemp(join(tmpdir(), "second-set-credentials-"));

  try {
    await credentials.storeInferenceConfiguration(
      directory,
      await importFile(directory, "old-meta"),
    );
    keychain.name = "Second Set";
    await credentials.storeSettingsConnection(
      directory,
      parseProviderConfiguration(JSON.stringify(connection("opencode-go", "new-go"))),
    );

    const before = await credentials.readInferenceConfigurations(directory, true);
    expect(providers(before.configurations)).toEqual(["opencode-go"]);
    expect(before.unreadable.map(({ file }) => file)).toEqual(["provider-credential.json"]);

    await credentials.forgetUnreadableCredentials(directory, before.unreadable);
    const after = await credentials.readInferenceConfigurations(directory, true);
    expect(providers(after.configurations)).toEqual(["opencode-go"]);
    expect(after.unreadable).toEqual([]);

    // Files skipped only because storage is unavailable are kept for when it returns.
    keychain.available = false;
    const unavailable = await credentials.readInferenceConfigurations(directory, true);
    await credentials.forgetUnreadableCredentials(directory, unavailable.unreadable);
    keychain.available = true;
    expect(
      providers((await credentials.readInferenceConfigurations(directory, true)).configurations),
    ).toEqual(["opencode-go"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a readable key saved under another provider's file is reported but never forgotten", async () => {
  delete process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;
  const directory = await mkdtemp(join(tmpdir(), "second-set-credentials-"));

  try {
    await credentials.storeSettingsConnection(
      directory,
      parseProviderConfiguration(JSON.stringify(connection("opencode-go", "go-key"))),
    );
    await copyFile(
      join(directory, "opencode-go-credential.json"),
      join(directory, "custom-endpoint-credential.json"),
    );

    const result = await credentials.readInferenceConfigurations(directory, true);
    expect(result.unreadable.map(({ file, reason }) => [file, reason])).toEqual([
      ["custom-endpoint-credential.json", "mismatched"],
    ]);

    await credentials.forgetUnreadableCredentials(directory, result.unreadable);
    expect(await Bun.file(join(directory, "custom-endpoint-credential.json")).exists()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved keys report unavailable storage instead of stopping startup", async () => {
  delete process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;
  const directory = await mkdtemp(join(tmpdir(), "second-set-credentials-"));

  try {
    await credentials.storeInferenceConfiguration(directory, await importFile(directory, "meta"));
    keychain.available = false;
    const result = await credentials.readInferenceConfigurations(directory, true);
    expect(result.configurations).toEqual([]);
    expect(result.unreadable.map(({ reason }) => reason)).toEqual(["unavailable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
