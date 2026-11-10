import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electron } from "./isolated-electron.ts";
import { offlineDesktop } from "./workbench-fixture.ts";

// Captures the README screenshots from a disposable copy of a real workspace. It never runs
// without one, and it edits only that copy. See docs/screenshots/README.md.
const workspace = process.env.SECOND_SET_SCREENSHOT_WORKSPACE;

test.skip(workspace === undefined, "Set SECOND_SET_SCREENSHOT_WORKSPACE to a workspace copy.");

// Playwright's screenshot keeps CSS pixels, so read the frame through CDP at the device scale.
const capture = async (cdp: CDPSession, page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(test.info().outputPath(`${name}.png`), Buffer.from(data, "base64"));
};

test("README screenshots from the drainage review", async () => {
  const directory = workspace ?? "";

  // The copy's one empty project still carried the old name; nothing else is changed.
  const database = new DatabaseSync(join(directory, "app.sqlite"));
  database
    .prepare(
      "UPDATE review_projects SET payload = json_set(payload, '$.name', 'Second Set Demo') WHERE json_extract(payload, '$.name') = 'MOKE Demo'",
    )
    .run();
  database.close();

  const options = await offlineDesktop(directory, ["opencode-go", "meta"]);
  const app = await electron.launch(options);

  try {
    const page = await app.firstWindow();
    // 1600 x 900 at 1.6x matches the 2560 x 1440 frames of the narrated demo.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1.6,
      mobile: false,
    });
    await expect(page.getByTestId("review-workbench")).toBeVisible({ timeout: 60_000 });

    const projects = page.getByRole("navigation", { name: "Projects" });
    const opened = projects.getByRole("button", { name: "Test Project", exact: true });

    if ((await opened.getAttribute("aria-expanded")) === "true") await opened.click();

    const project = projects.getByRole("region", {
      name: "Single Family Lot Drainage and Grading Set",
      exact: true,
    });

    await project
      .getByRole("button", { name: "Single Family Lot Drainage and Grading Set", exact: true })
      .click();
    await project.getByRole("button", { name: "Drawing coordination", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Review finished with coverage gaps" }),
    ).toBeVisible();
    await page
      .getByRole("heading", { name: "Review finished with coverage gaps" })
      .scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Open findings" }).click();
    await page.waitForTimeout(1500);
    await capture(cdp, page, "workbench");

    await page
      .getByRole("region", { name: "Workspace findings" })
      .getByRole("button", { name: /Project identity blank on C-2/ })
      .click();
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toHaveJSProperty("complete", true, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await capture(cdp, page, "correction");
  } finally {
    await app.close();
  }
});
