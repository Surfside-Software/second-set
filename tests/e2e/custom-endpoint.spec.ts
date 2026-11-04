import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ExecutionError } from "#lib/review/execution.ts";
import { StartPacketReview } from "#lib/review/packet.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { failure, installRpcControl, requests, success } from "./rpc-control.ts";
import { createProject, importPdf, offlineDesktop, openWindow } from "./workbench-fixture.ts";

test("OpenCode Go and a custom endpoint are set up in Review settings and run Initial Review on this computer", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "moke-custom-endpoint-"));
  const source = join(directory, "First set.pdf");
  await writeFile(source, createHeroPdf("A"));

  const app = await electron.launch(
    await offlineDesktop(directory, ["meta", "opencode-go", "openai-compatible"]),
  );

  try {
    const { page } = await openWindow(app);
    await createProject(page, "Custom endpoint");
    await importPdf(app, page, source);
    await installRpcControl(page);
    await page.reload();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // Until the reviewer chooses, a connected OpenCode Go key spares Meta credits.
    const initial = page.getByRole("button", { name: "Initial Review", exact: true });
    await expect(initial).toHaveAttribute("data-tip", /Muse Spark 1\.3 Contributor/);
    const model = page.getByRole("button", { name: /^Model:/ });
    await expect(model).toContainText("Muse Spark 1.3 Contributor");
    await model.click();
    await expect(page.getByRole("option", { name: /Muse Spark 1\.3 Contributor/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /GLM|MiMo|GPT-6 Luna/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });

    // The OpenCode Go key is tested in the shell; the confirmation is answered offline as declined.
    const go = settings.getByTestId("opencode-go");
    await expect(go).toContainText("OpenCode Go Connected");
    const goSave = go.getByRole("button", { name: "Test and save", exact: true });
    await expect(goSave).toBeDisabled();
    await go.getByLabel("API key", { exact: true }).fill("oc_sk_replacement_never_dispatched");

    await page.evaluate((exit) => window.rpcControl.answer("SaveOpenCodeGo", exit), success(false));

    await goSave.click();
    await expect(go.getByRole("status")).toHaveText("Not saved.");

    expect((await requests(page, "SaveOpenCodeGo"))[0]?.payload).toEqual({
      apiKey: "oc_sk_replacement_never_dispatched",
      model: "muse-spark-1.3-contributor",
    });

    const endpoint = settings.getByTestId("custom-endpoint");
    await expect(endpoint).toContainText("Custom endpoint Connected");

    // The saved address and model come back; the key never does.
    await expect(endpoint.getByLabel("Base URL", { exact: true })).toHaveValue(
      "https://llm.offline.test/v1",
    );
    await expect(endpoint.getByLabel("Model", { exact: true })).toHaveValue("offline-coder");
    await expect(endpoint.getByLabel("Context window (tokens)", { exact: true })).toHaveValue(
      "32768",
    );
    const key = endpoint.getByLabel("API key", { exact: true });
    await expect(key).toHaveValue("");
    const save = endpoint.getByRole("button", { name: "Test and save", exact: true });
    await expect(save).toBeDisabled();
    await key.fill("replacement-key-never-dispatched");
    await expect(save).toBeEnabled();

    await page.evaluate(
      (exit) => window.rpcControl.answer("SaveCustomEndpoint", exit),
      success(false),
    );

    await save.click();
    await expect(endpoint.getByRole("status")).toHaveText("Not saved.");

    expect((await requests(page, "SaveCustomEndpoint"))[0]?.payload).toEqual({
      baseUrl: "https://llm.offline.test/v1",
      model: "offline-coder",
      apiKey: "replacement-key-never-dispatched",
      images: true,
      contextWindow: 32768,
    });

    // The reviewer's choice sets Initial Review's model among the offered routes.
    const preferred = settings.getByLabel("Model for Initial Review and new conversations", {
      exact: true,
    });

    await expect(preferred).toHaveValue("muse-spark-1.3-contributor");
    await preferred.selectOption("openai-compatible");
    await expect(initial).toHaveAttribute("data-tip", /Custom endpoint/);
    await preferred.selectOption("muse-spark-1.3-contributor");
    await expect(initial).toHaveAttribute("data-tip", /Muse Spark 1\.3 Contributor/);
    await settings.getByRole("button", { name: "Done", exact: true }).click();

    await page.evaluate(
      (exit) => window.rpcControl.answer("StartPacketReview", exit),
      failure(
        Schema.encodeSync(Schema.toCodecJson(ExecutionError))(
          new ExecutionError({
            reason: "unavailable",
            message: "Offline proof: OpenCode Go was not called.",
          }),
        ),
      ),
    );

    await page.getByRole("button", { name: "Initial Review", exact: true }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "Offline proof: OpenCode Go was not called." }),
    ).toBeVisible();

    const starts = (await requests(page, "StartPacketReview")).map((request) =>
      Schema.decodeUnknownSync(StartPacketReview)(request.payload),
    );

    expect(starts.map((start) => [start.model, start.preset])).toEqual([
      ["muse-spark-1.3-contributor", "initial-review-v1"],
    ]);
    // No cloud connection is set up in this fixture, so nothing is sent to the cloud.
    expect(await requests(page, "StartCloudPacketReview")).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
