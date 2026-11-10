import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electron } from "./isolated-electron.ts";
import { offlineDesktop } from "./workbench-fixture.ts";

// Silent demo footage from a disposable workspace copy. Uncommitted helper; never sends or reviews.
const workspace = process.env.DEMO_WORKSPACE;
const out = process.env.DEMO_OUT ?? "";
const report = join(out, "second-set-demo-report.html");

test.skip(workspace === undefined || out === "", "Set DEMO_WORKSPACE and DEMO_OUT.");
test.describe.configure({ mode: "serial" });

// A light arrow with a dark outline that follows the mouse and pulses on press.
const cursorScript = () => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;width:28px;height:28px;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;inset:auto;transform:translate(-100px,-100px);z-index:2147483647}
      #demo-cursor svg{position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
      #demo-cursor .ring{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:3px solid #ff7a3d;opacity:0}
      #demo-cursor.pulse .ring{animation:demo-pulse .55s ease-out}
      @keyframes demo-pulse{0%{opacity:.95;transform:scale(.4)}100%{opacity:0;transform:scale(1.7)}}`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.setAttribute("popover", "manual");
    cursor.innerHTML =
      '<div class="ring"></div><svg width="24" height="30" viewBox="0 0 24 30"><path d="M2 2 L2 23 L7.5 18 L11.5 27 L15 25.5 L11 16.8 L18.5 16.8 Z" fill="#f4f4f2" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
    const top = () => {
      try {
        cursor.hidePopover();
        cursor.showPopover();
      } catch {
        /* popover unsupported */
      }
    };
    top();
    let dialogs = 0;
    window.addEventListener(
      "mousemove",
      (event) => {
        cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
        const open = document.querySelectorAll("dialog[open]").length;
        if (open !== dialogs) {
          dialogs = open;
          top();
        }
      },
      true,
    );
    window.addEventListener(
      "mousedown",
      () => {
        cursor.classList.remove("pulse");
        void cursor.offsetWidth;
        cursor.classList.add("pulse");
      },
      true,
    );
    (window as unknown as { demoCursorTop: () => void }).demoCursorTop = top;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
};

interface Shot {
  readonly id: number;
  readonly title: string;
  start: number;
  end: number;
  readonly marks: Array<{ label: string; at: number }>;
}

const director = (page: Page) => {
  const shots: Array<Shot> = [];
  let mouse = { x: 800, y: 450 };
  const now = () => Date.now();

  const move = async (x: number, y: number, steps = 20) => {
    await page.mouse.move(x, y, { steps });
    mouse = { x, y };
  };

  const center = async (target: Locator) => {
    await target.waitFor({ state: "visible" });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("Target has no box");
    return { x: Math.round(box.x + Math.min(box.width / 2, 120)), y: Math.round(box.y + box.height / 2) };
  };

  return {
    shots,
    hold: (ms: number) => page.waitForTimeout(ms),
    mark: (label: string) => shots.at(-1)?.marks.push({ label, at: now() }),
    begin: (id: number, title: string) => {
      shots.push({ id, title, start: now(), end: 0, marks: [] });
    },
    end: () => {
      const shot = shots.at(-1);
      if (shot) shot.end = now();
    },
    move,
    hover: async (target: Locator, steps = 20) => {
      const point = await center(target);
      await move(point.x, point.y, steps);
    },
    click: async (target: Locator, steps = 20) => {
      const point = await center(target);
      await move(point.x, point.y, steps);
      await page.waitForTimeout(350);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
    },
    // Small wheel steps with pauses so the motion stays readable.
    scroll: async (delta: number, count: number, pause = 260) => {
      for (let index = 0; index < count; index++) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(pause);
      }
    },
    position: () => mouse,
  };
};

test("app footage", async () => {
  test.setTimeout(600_000);
  const directory = workspace ?? "";

  // The copy's one empty project still carried the old name; nothing else is changed.
  const database = new DatabaseSync(join(directory, "app.sqlite"));
  database
    .prepare(
      "UPDATE review_projects SET payload = json_set(payload, '$.name', 'Second Set Demo') WHERE json_extract(payload, '$.name') = 'MOKE Demo'",
    )
    .run();
  database.close();

  const videoDirectory = join(out, "video-app");
  await mkdir(videoDirectory, { recursive: true });
  const options = await offlineDesktop(directory, ["opencode-go", "meta"]);
  const app = await electron.launch({
    ...options,
    args: [...(options.args ?? []), "--force-device-scale-factor=1.6"],
    recordVideo: { dir: videoDirectory, size: { width: 2560, height: 1440 } },
  });

  let sync = 0;
  let closing = 0;
  let shots: Array<Shot> = [];
  const errors: Array<string> = [];

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900);
    });
    await page.addInitScript(cursorScript);
    await page.evaluate(cursorScript);
    await expect(page.getByTestId("review-workbench")).toBeVisible({ timeout: 60_000 });
    const d = director(page);
    shots = d.shots;

    // Navigate to the review before the first shot.
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
    const heading = page.getByRole("heading", { name: "Review finished with coverage gaps" });
    await expect(heading).toBeVisible();
    await page.waitForTimeout(1200);
    await page.mouse.move(900, 400);
    for (let index = 0; index < 30; index++) await page.mouse.wheel(0, -500);
    await page.waitForTimeout(800);
    await page.evaluate(() => document.fonts.ready);

    // Magenta sync frame: its first video frame anchors every logged time.
    await page.evaluate(() => {
      const flash = document.createElement("div");
      flash.id = "demo-sync";
      flash.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483646";
      document.body.append(flash);
    });
    sync = Date.now();
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById("demo-sync")?.remove());
    await page.mouse.move(1150, 480, { steps: 5 });
    await page.waitForTimeout(1200);

    const conversation = page.getByRole("region", { name: "Conversation" });
    const card = page.getByRole("region", { name: "Whole set review" });
    const back = page.getByRole("button", { name: "Close source panel" });

    // 1. Workbench overview.
    d.begin(1, "Workbench open on the drainage review");
    d.mark("overview");
    await d.hold(4000);
    await d.hover(project.getByRole("button", { name: "Single Family Lot Drainage and Grading Set", exact: true }));
    d.mark("sidebar project");
    await d.hold(2500);
    await d.hover(conversation.getByText("Initial Review", { exact: true }).first(), 28);
    d.mark("request bubble");
    await d.hold(3000);
    await d.hover(card.getByRole("status").first(), 24);
    d.mark("review card heading and progress");
    await d.hold(3500);
    d.end();

    // 2. Scroll the review card.
    d.begin(2, "Scroll the review card: summary and findings");
    await d.move(1100, 400);
    d.mark("summary");
    await d.hold(3500);
    await d.scroll(90, 4, 300);
    d.mark("findings top");
    await d.hold(3500);
    await d.scroll(90, 5, 300);
    d.mark("findings middle");
    await d.hold(3000);
    await d.scroll(90, 6, 300);
    d.mark("findings end and records");
    await d.hold(3500);
    d.end();

    // 3. Sheets.
    d.begin(3, "Sheets panel");
    await d.click(page.getByRole("button", { name: "Sheets 5" }), 28);
    await page.getByRole("heading", { name: "Project sheets" }).waitFor().catch(() => undefined);
    await d.hold(700);
    await d.move(1000, 232);
    d.mark("five sheets");
    await d.hold(4000);
    await d.click(back);
    await d.hold(1200);
    d.end();

    // 4. Coverage.
    d.begin(4, "Coverage grid and one pass");
    const coverage = page.locator("summary").filter({ hasText: /^Coverage/ });
    await coverage.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "smooth" }));
    await d.hold(1200);
    await d.click(coverage);
    await d.hold(600);
    await page
      .getByRole("region", { name: "Coverage by sheet and discipline" })
      .evaluate((element) => element.scrollIntoView({ block: "end", behavior: "smooth" }));
    await d.hold(1200);
    await d.move(1000, 520);
    d.mark("grid");
    await d.hold(4000);
    const cell = page.getByRole("button", { name: "C-2 · Page 3, Civil: Issue", exact: true });
    await d.click(cell);
    await d.hold(900);
    const passes = page.getByRole("region", { name: /C-2 · Page 3 Civil passes/ });
    await passes.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "smooth" }));
    await d.hold(1200);
    d.mark("passes for C-2 civil");
    await d.hold(2500);
    const pass = passes.locator("details.pass summary").first();
    await d.click(pass);
    await d.hold(600);
    d.mark("pass open");
    await d.hold(4000);
    d.end();

    // 5. Project identity finding with its saved decision.
    d.begin(5, "Evidence: Project identity blank on C-2");
    await d.click(page.getByRole("button", { name: "Open findings" }), 28);
    d.mark("findings menu");
    await d.hold(2500);
    const menu = page.getByRole("region", { name: "Workspace findings" });
    await d.click(menu.getByRole("button", { name: /Project identity blank on C-2/ }));
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toHaveJSProperty("complete", true, { timeout: 30_000 });
    await d.hold(600);
    await d.move(1200, 480);
    d.mark("evidence open");
    await d.hold(3000);
    await d.hover(page.getByText("Correction", { exact: true }).first(), 24);
    d.mark("observation and correction");
    await d.hold(3000);
    await d.hover(page.getByRole("button", { name: "Decision: False alarm" }));
    d.mark("decision");
    await d.hold(1500);
    await d.hover(page.getByRole("textbox", { name: "Reason" }), 15);
    await d.hold(3000);
    await d.click(page.getByRole("button", { name: "Zoom in" }), 28);
    await d.hold(400);
    d.mark("zoomed in");
    await d.hold(3000);
    await d.click(page.getByRole("button", { name: "Zoom out" }));
    await d.hold(400);
    d.mark("zoomed out");
    await d.hold(2500);
    d.end();

    // 6. A second finding with a calculated conflict.
    d.begin(6, "Evidence: FFE basis note conflicts with shown grades");
    await d.click(back);
    await d.hold(1500);
    await d.click(page.getByRole("button", { name: "Open findings" }), 28);
    await d.hold(1500);
    await d.click(menu.getByRole("button", { name: /FFE basis note conflicts/ }));
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toHaveJSProperty("complete", true, { timeout: 30_000 });
    await d.hold(600);
    await d.hover(page.getByText(/C-4 Sections AA and BB state/).first(), 24);
    d.mark("evidence open");
    await d.hold(3500);
    await d.move(1300, 520);
    d.mark("section highlight");
    await d.hold(3500);
    d.end();

    // 7. Search findings.
    d.begin(7, "Search findings for flood");
    await d.hover(page.getByRole("button", { name: /Search findings/ }), 28);
    await d.hold(1000);
    await page.keyboard.press("Control+k");
    d.mark("search open");
    await d.hold(2000);
    await page.keyboard.type("flood", { delay: 320 });
    d.mark("typed flood");
    await d.hold(3000);
    await d.click(
      page.getByRole("region", { name: "Search findings" }).getByText("Flood zone blank in land-use table"),
    );
    await expect(
      page.getByRole("region", { name: "Original source render" }).locator("img"),
    ).toHaveJSProperty("complete", true, { timeout: 30_000 });
    await d.hold(600);
    await d.move(1250, 520);
    d.mark("flood evidence");
    await d.hold(4000);
    d.end();

    // 8. Review settings.
    d.begin(8, "Review settings: model and providers");
    await d.click(back);
    await d.hold(1200);
    await d.click(page.getByRole("button", { name: "Review settings" }), 28);
    const settings = page.getByRole("dialog", { name: "Review settings" });
    await settings.waitFor();
    await page.evaluate(() => (window as unknown as { demoCursorTop?: () => void }).demoCursorTop?.());
    await d.move(800, 450, 15);
    d.mark("settings open");
    await d.hold(2500);
    await d.scroll(100, 4, 320);
    await d.hold(600);
    await d.hover(settings.getByRole("combobox", { name: "Model for Initial Review and new conversations" }));
    d.mark("model connections and model");
    await d.hold(3500);
    await d.scroll(100, 3, 320);
    d.mark("OpenCode Go section");
    await d.hold(3500);
    await d.click(settings.getByRole("button", { name: "Done" }), 28);
    await expect(settings).toBeHidden();
    await d.hold(1200);
    d.end();

    // 9. Composer pickers, hover only.
    d.begin(9, "Composer: scope, model, reviewer and message field");
    await d.hover(page.getByRole("button", { name: /^Scope:/ }), 28);
    d.mark("scope");
    await d.hold(2500);
    await d.hover(page.getByRole("button", { name: /^Execution location:/ }));
    d.mark("execution location");
    await d.hold(2500);
    await d.hover(page.getByRole("button", { name: /^Model:/ }));
    d.mark("model");
    await d.hold(2500);
    await d.hover(page.getByRole("button", { name: /^Reviewer:/ }));
    d.mark("reviewer");
    await d.hold(2500);
    await d.hover(page.getByRole("textbox", { name: "Message" }));
    d.mark("message field");
    await d.hold(3000);
    d.end();

    // 10. Export the report with the native dialog stubbed.
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, report);
    d.begin(10, "Export review report");
    await d.move(1100, 450);
    await d.scroll(-120, 22, 150);
    await d.hold(900);
    const exportButton = page.getByRole("button", { name: "Export review report" });
    await exportButton.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "smooth" }));
    await d.hold(1000);
    await d.hover(exportButton, 24);
    d.mark("export button");
    await d.hold(1500);
    await d.click(exportButton, 5);
    await expect(page.getByText("Review report exported.")).toBeVisible({ timeout: 30_000 });
    d.mark("exported notice");
    await d.hold(4000);
    d.end();

    closing = Date.now();
  } finally {
    await app.close();
    await writeFile(
      join(out, "app-log.json"),
      JSON.stringify({ sync, closing, shots, errors }, null, 2),
    );
  }
  const files = await readdir(videoDirectory);
  const video = files.find((file) => file.endsWith(".webm"));
  if (video) await rename(join(videoDirectory, video), join(out, "second-set-demo-app.webm"));
});

test("report footage", async () => {
  test.setTimeout(300_000);
  const videoDirectory = join(out, "video-report");
  await mkdir(videoDirectory, { recursive: true });
  const browser = await chromium.launch({ args: ["--force-device-scale-factor=1.6"] });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1.6,
    recordVideo: { dir: videoDirectory, size: { width: 2560, height: 1440 } },
  });
  const page = await context.newPage();
  await page.addInitScript(cursorScript);
  const marks: Array<{ label: string; at: number }> = [];
  const mark = (label: string) => marks.push({ label, at: Date.now() });
  let sync = 0;
  let closing = 0;
  try {
    await page.goto(`file://${report}`);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const flash = document.createElement("div");
      flash.id = "demo-sync";
      flash.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483646";
      document.body.append(flash);
    });
    sync = Date.now();
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById("demo-sync")?.remove());
    await page.mouse.move(800, 450, { steps: 5 });
    await page.waitForTimeout(1200);

    const scrollTo = async (selector: string, label: string, hold = 4500) => {
      const target = await page.evaluate((query) => {
        const element = document.querySelector(query);
        return element ? element.getBoundingClientRect().top + window.scrollY - 40 : null;
      }, selector);
      if (target === null) throw new Error(`Missing ${selector}`);
      // Scroll in small steps.
      for (;;) {
        const y = await page.evaluate(() => window.scrollY);
        const remaining = target - y;
        if (Math.abs(remaining) < 4) break;
        const step = Math.sign(remaining) * Math.min(Math.abs(remaining), 110);
        await page.mouse.wheel(0, step);
        await page.waitForTimeout(220);
        if ((await page.evaluate(() => window.scrollY)) === y) break;
      }
      mark(label);
      await page.waitForTimeout(hold);
    };
    const gentle = async (count: number, label: string, hold = 4000) => {
      for (let index = 0; index < count; index++) {
        await page.mouse.wheel(0, 110);
        await page.waitForTimeout(220);
      }
      mark(label);
      await page.waitForTimeout(hold);
    };

    // A hard cut between distant sections keeps the clip short; each cut is logged.
    const cut = async (selector: string, label: string, hold = 4500) => {
      await page.evaluate((query) => {
        const element = document.querySelector(query);
        if (!element) throw new Error(`Missing ${query}`);
        window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 40, behavior: "instant" });
      }, selector);
      mark(`cut: ${label}`);
      await page.waitForTimeout(hold);
    };

    mark("header");
    await page.waitForTimeout(5000);
    await gentle(4, "summary and missing inputs");
    await scrollTo("#findings", "findings table", 3500);
    await gentle(5, "findings table rows", 4000);
    await cut("#finding-b2c3d4e5-f6a1-42b2-9c22-222222222222", "flood zone finding", 4000);
    await gentle(4, "flood zone observation and correction", 4000);
    await gentle(5, "flood zone evidence", 4500);
    await cut("#coverage", "coverage", 5000);
    await gentle(4, "coverage table", 4000);
    await scrollTo("#citations", "citation log", 5000);
    await gentle(4, "citation entries", 4000);
    await scrollTo("#calculations", "calculations", 4500);
    closing = Date.now();
  } finally {
    await context.close();
    await browser.close();
    await writeFile(join(out, "report-log.json"), JSON.stringify({ sync, closing, marks }, null, 2));
  }
  const files = await readdir(videoDirectory);
  const video = files.find((file) => file.endsWith(".webm"));
  if (video) await rename(join(videoDirectory, video), join(out, "second-set-demo-report.webm"));
});
