import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, Struct } from "effect";
import { PacketReview, PacketScope, PacketSheet, ReviewPass } from "#lib/review/packet.ts";
import { CloudReviewSetup } from "#lib/review/cloud.ts";
import { floridaCodeIndex } from "../../backend/review/code-index/code-index.ts";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { installRpcControl, success } from "./rpc-control.ts";
import {
  createProject,
  importPdf,
  offlineDesktop,
  openWindow,
  seedPacketReviews,
} from "./workbench-fixture.ts";

test("coverage keeps unexplained exclusions in Needs input and clears details hidden by filters", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "second-set-coverage-ui-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const options = await offlineDesktop(directory, ["meta"]);
  let app = await electron.launch(options);

  try {
    let { page } = await openWindow(app);
    await createProject(page, "Coverage regressions");
    await importPdf(app, page, source);
    await app.close();
    seedPacketReviews(directory, "Coverage regressions", ({ conversations, review }) => {
      const conversation = conversations[0];

      if (!conversation) throw new Error("Missing conversation");
      const saved = review(conversation, Date.now() - 5000, "Coverage fixture");
      const original = saved.sheets[0];

      if (!original) throw new Error("Missing sheet");

      const sheets = Array.from({ length: 160 }, (_, index) =>
        Schema.decodeUnknownSync(PacketSheet)({
          ...original,
          id: crypto.randomUUID(),
          label: `E-${100 + index}`,
        }),
      );

      return [
        Schema.decodeUnknownSync(PacketReview)(
          Struct.assign(saved, {
            scope: PacketScope.cases.Discipline.make({ discipline: "electrical" }),
            sheets,
            citations: [
              {
                id: crypto.randomUUID(),
                sourceId: null,
                jurisdiction: "Florida",
                document: "Florida Building Code, Building",
                edition: "2020 7th Edition",
                section: "1006.2",
                quote: "",
                application: "Check the required number of exits.",
                status: "unverified",
                note: "Official text was inaccessible. Confirm the adopted subsection.",
                reference: floridaCodeIndex.find(
                  (entry) => entry.title === "1006 Number of Exits and Exit Access Doorways",
                ),
              },
              {
                id: crypto.randomUUID(),
                sourceId: null,
                jurisdiction: "Florida",
                document: "Florida Statutes",
                edition: "2026 Florida Statutes",
                section: "553.79",
                quote: "",
                application: "Permit requirement",
                status: "unverified",
                note: "Not retrieved in this review.",
                reference: floridaCodeIndex.find((entry) =>
                  entry.title.startsWith("553.79 Permits"),
                ),
              },
              {
                id: crypto.randomUUID(),
                sourceId: null,
                jurisdiction: "Florida",
                document: "Local amendment",
                edition: "2026",
                section: "A-12",
                quote: "",
                application: "Check with the AHJ",
                status: "unverified",
                note: "Unknown local text.",
              },
            ],
            sources: [
              {
                id: crypto.randomUUID(),
                url: "https://codes.iccsafe.org/content/FLBC2023P2",
                title: "Official code",
                retrievedAt: new Date().toISOString(),
                status: "unavailable",
                official: true,
                sha256: null,
                text: "HTTP 403. Official text could not be read.",
              },
              {
                id: crypto.randomUUID(),
                url: "unavailable-local-source",
                title: "Local record",
                retrievedAt: new Date().toISOString(),
                status: "unavailable",
                official: false,
                sha256: null,
                text: "No text was retrieved.",
              },
            ],
            coverage: [
              ...sheets.flatMap((sheet, index) =>
                ReviewPass.literals.map((pass): PacketReview["coverage"][number] => ({
                  sheetId: sheet.id,
                  discipline: "electrical" as const,
                  pass,
                  status: (["not_applicable", "checked"] as const)[index] ?? "unreviewed",
                  note: "",
                })),
              ),
              ...sheets.slice(0, 1).flatMap((sheet) =>
                ReviewPass.literals.map((pass) => ({
                  sheetId: sheet.id,
                  discipline: "general" as const,
                  pass,
                  status: "issue" as const,
                  note: "Earlier general review",
                })),
              ),
            ],
          }),
        ),
      ];
    });
    app = await electron.launch(options);
    ({ page } = await openWindow(app));
    const panel = page.getByTestId("packet-review-panel");
    const sources = panel.locator("summary").filter({ hasText: /^Sources and citations/ });
    await sources.click();
    const citations = panel.getByTestId("citation-row");
    const retrieved = panel.getByTestId("source-row");
    await expect(citations).toHaveCount(3);
    await expect(citations.nth(0).locator("summary")).toHaveAttribute(
      "aria-description",
      /Official text isn't available/,
    );
    await expect(citations.nth(1).locator("summary")).not.toHaveAttribute(
      "aria-description",
      /isn't available/,
    );
    await expect(retrieved.first().locator("summary")).toHaveAttribute(
      "aria-description",
      /Text was not retrieved/,
    );

    for (const rows of [citations, retrieved]) {
      const edges = await rows.evaluateAll((items) =>
        items.map((item) => item.querySelector("summary")?.getBoundingClientRect().right),
      );

      expect(new Set(edges).size).toBe(1);
    }

    await citations.first().evaluate((row) => {
      row.style.width = "330px";
    });
    await expect(citations.first().locator(".volume")).toBeHidden();
    await expect(citations.first().locator(".name")).toHaveCSS("white-space", "normal");
    await citations.first().locator("summary").click();
    await expect(citations.first().locator(".detail-volume")).toBeVisible();
    await expect(citations.first().locator(".detail")).toContainText(
      "Florida Building Code, Building · 2020 7th Edition · 1006.2",
    );
    await expect(citations.first()).toContainText("1006.2");
    await expect(citations.first()).not.toContainText("Official text was inaccessible");
    await expect(citations.first()).toContainText("Confirm the adopted subsection.");
    await citations.nth(1).evaluate((row) => {
      row.style.width = "330px";
    });
    await citations.nth(1).locator("summary").click();
    await expect(citations.nth(1).locator(".detail-volume")).toHaveCount(0);
    await expect(citations.nth(1).locator(".detail")).toContainText(
      "Florida Statutes · 2026 Florida Statutes · 553.79 · Florida",
    );
    await sources.click();
    await panel
      .locator("summary")
      .filter({ hasText: /^Coverage/ })
      .click();
    const matrix = panel.getByTestId("coverage-matrix");
    const legend = panel.getByRole("group", { name: "Show only one status" });
    await expect(matrix.locator("thead th")).toHaveCount(2);
    await expect(matrix.locator("tbody tr")).toHaveCount(160);
    await expect(legend.getByRole("button", { name: /^Needs input/ })).toContainText("4");
    await expect(legend.getByRole("button", { name: /^Not applicable/ })).toBeDisabled();
    await legend.getByRole("button", { name: /^Needs input/ }).click();
    await expect(matrix.locator("tbody tr")).toHaveCount(1);
    await panel
      .getByRole("button", { name: "E-100, Electrical: Needs input", exact: true })
      .click();
    await expect(panel.getByTestId("coverage-record")).toHaveCount(4);
    await expect(panel.getByTestId("coverage-record").first()).toContainText("reason missing");
    await legend.getByRole("button", { name: /^Checked/ }).click();
    await expect(panel.getByTestId("coverage-record")).toHaveCount(0);
    await panel.getByRole("button", { name: "E-101, Electrical: Checked", exact: true }).click();
    await panel.getByRole("searchbox", { name: "Find a sheet", exact: true }).fill("E-102");
    await expect(panel.getByTestId("coverage-record")).toHaveCount(0);
    await panel.getByRole("searchbox", { name: "Find a sheet", exact: true }).fill("");
    await legend.getByRole("button", { name: /^Checked/ }).click();
    await panel.getByRole("checkbox", { name: "Earlier reviews", exact: true }).check();
    await expect(matrix.locator("thead th")).toHaveCount(3);
    await legend.getByRole("button", { name: /^Issue/ }).click();
    await expect(matrix.locator("tbody tr")).toHaveCount(1);
    await panel.getByRole("checkbox", { name: "Earlier reviews", exact: true }).uncheck();
    await expect(matrix.locator("tbody tr")).toHaveCount(160);
    await expect(legend.getByRole("button", { name: /^Issue/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud Send blockers always explain the missing estimate, limits and active local reviews", async () => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "second-set-composer-blockers-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const app = await electron.launch(await offlineDesktop(directory, ["meta"]));

  try {
    const { page } = await openWindow(app);
    await createProject(page, "Cloud blockers");
    await importPdf(app, page, source);

    const setup = new CloudReviewSetup({
      configured: true,
      message: null,
      timeoutMinutes: 15,
      warmPool: false,
      transferScope: "whole-application",
    });

    const encoded = Schema.encodeSync(Schema.toCodecJson(CloudReviewSetup));
    await installRpcControl(page, [{ tag: "CloudReviewSetup", exit: success(encoded(setup)) }]);
    await page.reload();
    await page.getByLabel("Message", { exact: true }).fill("Review these drawings");
    await page.evaluate(
      (exit) => window.rpcControl.answer("CloudReviewSetup", exit),
      success(encoded(setup)),
    );
    await page.getByRole("button", { name: /^Execution location:/ }).click();
    await page.getByRole("option", { name: "Push to cloud", exact: true }).click();
    const send = page.getByRole("button", { name: "Send message", exact: true });
    const help = page.locator(".composer-help");
    await expect(send).toBeDisabled();
    await expect(help).toContainText("Cloud size check unavailable");
    const estimate = { bytes: 100, files: 1, projects: 1, measuredAt: Date.now() };

    for (const [workspaceEstimate, explanation] of [
      [{ ...estimate, bytes: 1024 ** 3 + 1 }, "exceeds the 1 GiB"],
      [
        { ...estimate, localReviews: ["Other project"] },
        "Finish or cancel these reviews first: Other project",
      ],
    ] as const) {
      await page.evaluate(
        (exit) => window.rpcControl.answer("CloudReviewSetup", exit),
        success(encoded(new CloudReviewSetup(Struct.assign(setup, { workspaceEstimate })))),
      );
      await page.getByRole("button", { name: "Recheck size", exact: true }).click();
      await expect(send).toBeDisabled();
      await expect(help).toContainText(explanation);
    }

    await page.evaluate(
      (exit) => window.rpcControl.answer("CloudReviewSetup", exit),
      success(encoded(new CloudReviewSetup(Struct.assign(setup, { workspaceEstimate: estimate })))),
    );
    await page.getByRole("button", { name: "Recheck size", exact: true }).click();
    await expect(send).toBeEnabled();
    await expect(help).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
