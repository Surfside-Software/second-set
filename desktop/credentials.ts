import { safeStorage } from "electron";
import { Schema } from "effect";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceConfiguration } from "../src/lib/backend-rpc.ts";
import { reviewProviderRoutes } from "../src/lib/review/models.ts";
import {
  CredentialError,
  parseProviderConfigurations,
  readProviderConfigurations,
} from "./credential-files.ts";

const StoredCredential = Schema.Struct({
  version: Schema.Literal(1),
  encrypted: Schema.NonEmptyString,
});

const secureStorageAvailable = async () => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;

  if (process.platform !== "linux") return true;

  // With no secret service answering, Chromium still reports success and the selected backend's
  // name, then encrypts with a publicly known key. Only the v10 tag on its output reveals this.
  const probe = await safeStorage.encryptStringAsync("availability");

  return probe.subarray(0, 3).toString() !== "v10";
};

/** Packaged launches use OS-encrypted storage or an explicitly selected session-only file. */
export async function readInferenceConfigurations(directory: string, packaged: boolean) {
  const sessionFile = process.env.MOKE_SESSION_CREDENTIAL_FILE;

  if (sessionFile !== undefined) return readProviderConfigurations(sessionFile, true);
  const storedFile = join(directory, "provider-credential.json");

  if (existsSync(storedFile)) {
    if (!(await secureStorageAvailable()))
      throw new CredentialError({
        message:
          "Secure credential storage is unavailable. Select a session-only credential configuration.",
      });

    try {
      const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredCredential))(
        await readFile(storedFile, "utf8"),
      );

      const decrypted = await safeStorage.decryptStringAsync(
        Buffer.from(stored.encrypted, "base64"),
      );

      return parseProviderConfigurations(decrypted.result);
    } catch {
      throw new CredentialError({
        message: "The saved provider credential could not be unlocked.",
      });
    }
  }

  if (packaged) return [];
  const keys = {
    meta: process.env.MODEL_API_KEY,
    baseten: process.env.BASETEN_API_KEY,
    "opencode-go": process.env.OPENCODE_API_KEY,
  };

  const order = (["meta", "baseten", "opencode-go"] as const).toSorted(
    (left, right) =>
      Number(right === process.env.MOKE_PROVIDER) - Number(left === process.env.MOKE_PROVIDER),
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

/** A shell-selected configuration is encrypted before saving, and never enters renderer RPC. */
export async function storeInferenceConfiguration(directory: string, source: string) {
  const incoming = await readProviderConfigurations(source);
  const existing = await readInferenceConfigurations(directory, true);

  const configs = [
    ...incoming,
    ...existing.filter((entry) => !incoming.some((item) => item.provider === entry.provider)),
  ];

  if (!(await secureStorageAvailable()))
    throw new CredentialError({
      message:
        "OS credential encryption is unavailable. Use an explicitly selected session-only configuration.",
    });

  const encrypted = await safeStorage.encryptStringAsync(
    JSON.stringify({
      providers: configs.map((config) => Schema.encodeSync(InferenceConfiguration)(config)),
    }),
  );

  await writeFile(
    join(directory, "provider-credential.json"),
    JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }),
    { mode: 0o600, flush: true },
  );
}
