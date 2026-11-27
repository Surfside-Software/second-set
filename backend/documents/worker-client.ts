import { Effect, Schema } from "effect";
import { DocumentError } from "#lib/review/contracts.ts";
import type { DocumentsConfig } from "./config.ts";
import { join } from "node:path";
import {
  WorkerInspectRequest,
  WorkerRenderRequest,
  WorkerInspectResult,
  WorkerRenderResult,
  WorkerRequest,
  WorkerResponse,
  WorkerSuccess,
  WorkerTextRequest,
  WorkerTextResult,
} from "./worker-messages.ts";

/** A scoped subprocess is killed on timeout, cancellation, malformed output, or completion. */
export interface PdfWorkerSession {
  readonly call: <A>(
    request: typeof WorkerRequest.Type,
    decode: (result: (typeof WorkerSuccess.Type)["result"]) => A,
  ) => Effect.Effect<A, DocumentError>;
  readonly nextId: () => string;
}

/**
 * Variables the worker inherits. It parses untrusted PDFs, so provider keys and other backend
 * secrets stay out of its environment. Executable lookup and the home, temporary and system
 * directories pass through. The test hooks pass only when a test sets them.
 */
const inheritedWorkerVariables = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SECOND_SET_PDF_WORKER_STARTED_DIRECTORY",
  "SECOND_SET_PDF_WORKER_DELAY_MS",
] as const;

/** The minimal environment of one PDF worker process. */
export const pdfWorkerEnvironment = (config: DocumentsConfig) => {
  const environment: Record<string, string> = {};

  for (const name of inheritedWorkerVariables) {
    const value = process.env[name];

    if (value !== undefined) environment[name] = value;
  }

  return {
    ...environment,
    SECOND_SET_PDFJS_ASSETS: config.assetsDirectory,
    NAPI_RS_NATIVE_LIBRARY_PATH: config.nativeLibraryPath,
    NODE_PATH: join(config.assetsDirectory, "..", "modules"),
    BUN_OPTIONS: "",
  };
};

/** Open one process for a bounded PDF job, with explicit lifetime and exit cleanup. */
export const openPdfWorker = Effect.fn("openPdfWorker")(function* (config: DocumentsConfig) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [...config.workerCommand],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: pdfWorkerEnvironment(config),
        }),
      catch: () =>
        new DocumentError({
          reason: "unavailable",
          message: "The PDF processing worker could not start.",
        }),
    }),
    (child) =>
      Effect.promise(async () => {
        child.kill("SIGKILL");
        await child.exited;
      }),
  );

  let counter = 0;
  // Output after the last complete line, as decoded parts joined once a newline arrives, so a
  // large render's single line is copied once rather than rescanned on every pipe chunk.
  let parts: Array<string> = [];
  let partLength = 0;
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  yield* Effect.addFinalizer(() => Effect.sync(() => reader.releaseLock()));

  const session: PdfWorkerSession = {
    nextId: () => `pdf-${++counter}`,
    call: (request, decode) =>
      Effect.tryPromise({
        try: async (signal) => {
          const abort = () => child.kill("SIGKILL");
          signal.addEventListener("abort", abort, { once: true });

          try {
            await child.stdin.write(JSON.stringify(request) + "\n");
            await child.stdin.flush();

            for (;;) {
              const last = parts.at(-1) ?? "";
              const newline = last.indexOf("\n");

              if (newline >= 0) {
                const line = parts.slice(0, -1).join("") + last.slice(0, newline);
                const rest = last.slice(newline + 1);
                parts = rest === "" ? [] : [rest];
                partLength = rest.length;

                const response = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerResponse))(
                  line,
                );

                if (response.id !== request.id)
                  throw new Error("Unexpected worker response identity");

                if (!response.ok)
                  throw new DocumentError({ reason: response.reason, message: response.message });

                return decode(response.result);
              }

              const chunk = await reader.read();

              if (chunk.done) throw new Error("Worker stopped without a result");
              const decoded = decoder.decode(chunk.value, { stream: true });
              parts.push(decoded);
              partLength += decoded.length;

              if (partLength > 96 * 1024 * 1024) throw new Error("Worker output limit");
            }
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        catch: (cause) =>
          cause instanceof DocumentError
            ? cause
            : new DocumentError({
                reason: "unavailable",
                message: "The PDF worker failed or returned invalid data.",
              }),
      }),
  };

  return session;
});

/** Inventory a staged original with schema validation on the subprocess boundary. */
export function workerInspect(worker: PdfWorkerSession, pdfPath: string) {
  return worker.call(
    WorkerInspectRequest.make({ id: worker.nextId(), pdfPath }),
    Schema.decodeUnknownSync(WorkerInspectResult),
  );
}

/** Render only the bounded source region requested by the application. */
export function workerRender(
  worker: PdfWorkerSession,
  input: Omit<typeof WorkerRenderRequest.Type, "_tag" | "id">,
) {
  return worker.call(
    WorkerRenderRequest.make({ ...input, id: worker.nextId() }),
    Schema.decodeUnknownSync(WorkerRenderResult),
  );
}

/** Extract embedded page text from a stored PDF, starting at a one-based page. */
export function workerText(
  worker: PdfWorkerSession,
  input: Omit<typeof WorkerTextRequest.Type, "_tag" | "id">,
) {
  return worker.call(
    WorkerTextRequest.make({ ...input, id: worker.nextId() }),
    Schema.decodeUnknownSync(WorkerTextResult),
  );
}
