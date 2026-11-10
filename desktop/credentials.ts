import { safeStorage } from "electron";
import { Schema } from "effect";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { InferenceConfiguration } from "../src/lib/backend-rpc.ts";
import { reviewProviderRoutes } from "../src/lib/review/models.ts";
import {
  CredentialError,
  parseProviderConfiguration,
  parseProviderConfigurations,
  readProviderConfigurations,
} from "./credential-files.ts";

const StoredCredential = Schema.Struct({
  version: Schema.Literal(1),
  encrypted: Schema.NonEmptyString,
});

/** Imported Meta and Baseten credentials. */
const importedFile = "provider-credential.json";

/**
 * Connections saved in Review settings, one file each, so removing one leaves the others. They
 * apply even when a session-only file supplies Meta and Baseten.
 */
const settingsFiles = {
  "opencode-go": "opencode-go-credential.json",
  "openai-compatible": "custom-endpoint-credential.json",
} as const;

/** A provider whose connection is saved from Review settings. */
export type SettingsProvider = keyof typeof settingsFiles;

const isSettingsProvider = (provider: string): provider is SettingsProvider =>
  Object.hasOwn(settingsFiles, provider);

const secureStorageAvailable = async () => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;

  if (process.platform !== "linux") return true;

  // With no secret service answering, Chromium still reports success and the selected backend's
  // name, then encrypts with a publicly known key. Only the v10 tag on its output reveals this.
  const probe = await safeStorage.encryptStringAsync("availability");

  return probe.subarray(0, 3).toString() !== "v10";
};

/** Decrypt one stored credential file, or fail without revealing its contents. */
async function readStored(path: string, message: string) {
  if (!(await secureStorageAvailable()))
    throw new CredentialError({
      message:
        "Secure credential storage is unavailable. Select a session-only credential configuration.",
    });

  try {
    const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredCredential))(
      await readFile(path, "utf8"),
    );

    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored.encrypted, "base64"));

    return decrypted.result;
  } catch {
    throw new CredentialError({ message });
  }
}

/** A saved credential file the app could not read; it starts without that connection. */
export type UnreadableCredential = {
  readonly file: string;
  readonly reason: "locked" | "mismatched" | "unavailable";
  readonly message: string;
};

/**
 * Decrypt a saved credential, or record why it can't be read and treat it as missing. A key saved
 * before the rename can stop unlocking, and one stale file must not hide the others.
 */
async function readStoredOrSkip(
  path: string,
  message: string,
  unreadable: Array<UnreadableCredential>,
) {
  if (!(await secureStorageAvailable())) {
    unreadable.push({
      file: basename(path),
      reason: "unavailable",
      message:
        "Secure credential storage is unavailable. Select a session-only credential configuration.",
    });

    return null;
  }

  try {
    return await readStored(path, message);
  } catch (cause) {
    if (!(cause instanceof CredentialError)) throw cause;
    unreadable.push({ file: basename(path), reason: "locked", message });

    return null;
  }
}

/** Encrypt with the OS store and write an owner-only file; never falls back to plain text. */
async function writeStored(path: string, plain: string) {
  if (!(await secureStorageAvailable()))
    throw new CredentialError({
      message:
        "OS credential encryption is unavailable. Use an explicitly selected session-only configuration.",
    });

  const encrypted = await safeStorage.encryptStringAsync(plain);

  await writeFile(path, JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }), {
    mode: 0o600,
    flush: true,
  });
}

/** Session file, imported credentials, or (in development only) the environment. */
async function readImportedConfigurations(
  directory: string,
  packaged: boolean,
  unreadable: Array<UnreadableCredential>,
) {
  const sessionFile = process.env.SECOND_SET_SESSION_CREDENTIAL_FILE;

  if (sessionFile !== undefined) return readProviderConfigurations(sessionFile, true);
  const storedFile = join(directory, importedFile);

  if (existsSync(storedFile)) {
    const text = await readStoredOrSkip(
      storedFile,
      "The saved provider credential could not be unlocked.",
      unreadable,
    );

    if (text !== null) return parseProviderConfigurations(text);
  }

  if (packaged) return [];

  const keys = {
    meta: process.env.MODEL_API_KEY,
    baseten: process.env.BASETEN_API_KEY,
    "opencode-go": process.env.OPENCODE_API_KEY,
  };

  const order = (["meta", "baseten", "opencode-go"] as const).toSorted(
    (left, right) =>
      Number(right === process.env.SECOND_SET_PROVIDER) -
      Number(left === process.env.SECOND_SET_PROVIDER),
  );

  return order.flatMap((entry) => {
    const apiKey = keys[entry];

    if (!apiKey?.trim()) return [];

    return parseProviderConfigurations(
      JSON.stringify({
        provider: entry,
        apiKey,
        baseUrl: reviewProviderRoutes[entry].endpoint,
        model: reviewProviderRoutes[entry].model,
      }),
    );
  });
}

/**
 * Packaged launches use OS-encrypted storage or an explicitly selected session-only file.
 * Connections saved in Review settings replace the same provider from those sources and are listed
 * after them, so Meta or Baseten stays the startup default when present. A file that can't be read
 * is reported and skipped, so the others still load and it can be saved again.
 */
export async function readInferenceConfigurations(directory: string, packaged: boolean) {
  const unreadable: Array<UnreadableCredential> = [];
  let configurations = await readImportedConfigurations(directory, packaged, unreadable);

  // A session-only launch must still start when the keyring is down.
  if (
    process.env.SECOND_SET_SESSION_CREDENTIAL_FILE !== undefined &&
    !(await secureStorageAvailable())
  )
    return { configurations, unreadable };

  for (const [provider, file] of Object.entries(settingsFiles)) {
    const stored = join(directory, file);

    if (!existsSync(stored)) continue;

    const text = await readStoredOrSkip(
      stored,
      "A connection saved in Review settings could not be unlocked.",
      unreadable,
    );

    if (text === null) continue;
    const saved = parseProviderConfiguration(text);

    if (saved.provider !== provider) {
      unreadable.push({
        file,
        reason: "mismatched",
        message: "A connection saved in Review settings is for another provider.",
      });
      continue;
    }

    configurations = [...configurations.filter((entry) => entry.provider !== provider), saved];
  }

  return { configurations, unreadable };
}

/**
 * Delete saved copies that no longer unlock, so a key replaced only in Review settings stops
 * prompting at every launch. They can't be decrypted, so nothing readable is lost; files skipped
 * because storage itself is unavailable are kept.
 */
export async function forgetUnreadableCredentials(
  directory: string,
  unreadable: ReadonlyArray<UnreadableCredential>,
) {
  const known = new Set<string>([importedFile, ...Object.values(settingsFiles)]);

  for (const entry of unreadable)
    if (entry.reason === "locked" && known.has(entry.file))
      await rm(join(directory, entry.file), { force: true });
}

/** Save a Review settings connection; the next launch passes it to the backend. */
export async function storeSettingsConnection(
  directory: string,
  config: typeof InferenceConfiguration.Type,
) {
  const parsed = parseProviderConfiguration(
    JSON.stringify(Schema.encodeSync(InferenceConfiguration)(config)),
  );

  if (!isSettingsProvider(parsed.provider))
    throw new CredentialError({
      message: "Meta and Baseten keys are imported from the File menu.",
    });

  await writeStored(
    join(directory, settingsFiles[parsed.provider]),
    JSON.stringify(Schema.encodeSync(InferenceConfiguration)(parsed)),
  );
}

/**
 * Forget a saved Review settings connection, including a copy imported from the File menu by an
 * earlier version; a session-only file can still supply one.
 */
export async function removeSettingsConnection(directory: string, provider: SettingsProvider) {
  await rm(join(directory, settingsFiles[provider]), { force: true });
  const imported = join(directory, importedFile);

  if (!existsSync(imported)) return;

  // A copy that no longer unlocks has nothing to remove; it is replaced when a key is imported.
  const text = await readStoredOrSkip(
    imported,
    "The saved provider credential could not be unlocked.",
    [],
  );

  if (text === null) return;
  const configs = parseProviderConfigurations(text);

  const kept = configs.filter((entry) => entry.provider !== provider);

  if (kept.length === configs.length) return;

  if (kept.length === 0) return await rm(imported, { force: true });

  await writeStored(
    imported,
    JSON.stringify({
      providers: kept.map((config) => Schema.encodeSync(InferenceConfiguration)(config)),
    }),
  );
}

/** A shell-selected configuration is encrypted before saving, and never enters renderer RPC. */
export async function storeInferenceConfiguration(directory: string, source: string) {
  const incoming = await readProviderConfigurations(source);
  const saved = incoming.filter((entry) => isSettingsProvider(entry.provider));
  const imported = incoming.filter((entry) => !isSettingsProvider(entry.provider));

  if (imported.length > 0) {
    // An earlier copy that no longer unlocks is replaced rather than blocking the import.
    const existing = await readImportedConfigurations(directory, true, []);

    const configs = [
      ...imported,
      ...existing.filter((entry) => !imported.some((item) => item.provider === entry.provider)),
    ];

    await writeStored(
      join(directory, importedFile),
      JSON.stringify({
        providers: configs.map((config) => Schema.encodeSync(InferenceConfiguration)(config)),
      }),
    );
  }

  for (const entry of saved) await storeSettingsConnection(directory, entry);
}
