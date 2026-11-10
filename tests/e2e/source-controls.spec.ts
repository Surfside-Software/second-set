import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeroPdf } from "../fixtures/hero-case.ts";
import { electron } from "./isolated-electron.ts";
import { createProject, importPdf, offlineDesktop, openWindow } from "./workbench-fixture.ts";

test("the sheet view zooms with Ctrl and a pinch, rotates both ways and explains its controls", async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "second-set-source-controls-"));
  const source = join(directory, "Drawing set.pdf");
  await writeFile(source, createHeroPdf("A"));
  const app = await electron.launch(await offlineDesktop(directory, ["meta"]));

  try {
    const { page } = await openWindow(app);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, "Sheet controls");
    await importPdf(app, page, source);

    // A control that isn't self-explanatory says what it does, including while it is disabled.
    const tooltip = page.getByTestId("review-tooltip");
    await expect(tooltip).toBeHidden();
    const countCheck = page.getByTestId("open-create-finding");
    await countCheck.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("New count check");
    await expect(tooltip).toContainText("how many of something are drawn");
    await expect(countCheck).toHaveAttribute("aria-description", /how many of something are drawn/);
    const anchor = await countCheck.boundingBox();
    const bubble = await tooltip.boundingBox();

    if (!anchor || !bubble) throw new Error("Missing tooltip geometry");
    expect(bubble.x).toBeGreaterThanOrEqual(0);
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(1440);
    expect(bubble.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    await page.screenshot({ path: test.info().outputPath("tooltip.png") });
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await page.mouse.move(700, 500);

    // Blur and visibility changes dismiss immediately even when animation frames are suspended.
    await countCheck.hover();
    await expect(tooltip).toBeVisible();
    expect(
      await page.evaluate(() => {
        const requestFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = () => 0;
        window.dispatchEvent(new Event("blur"));
        const hidden = !document.querySelector("[role=tooltip]")?.matches(":popover-open");
        window.requestAnimationFrame = requestFrame;

        return hidden;
      }),
    ).toBe(true);
    await page.mouse.move(700, 500);
    await countCheck.hover();
    await expect(tooltip).toBeVisible();
    expect(
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        const hidden = !document.querySelector("[role=tooltip]")?.matches(":popover-open");
        Reflect.deleteProperty(document, "visibilityState");

        return hidden;
      }),
    ).toBe(true);
    await page.mouse.move(700, 500);

    // A target removed without a pointer event must take its open tooltip with it.
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "temporary-tooltip-target";
      target.dataset.tip = "Temporary target";
      target.textContent = "Temporary target";
      target.style.cssText = "position:fixed;left:700px;top:500px;z-index:9999";
      document.body.append(target);
    });
    await page.locator("#temporary-tooltip-target").hover();
    await expect(tooltip).toHaveText("Temporary target");
    await page.locator("#temporary-tooltip-target").evaluate((target) => target.remove());
    await expect(tooltip).toBeHidden();

    // Keyboard focus uses the same tooltip, and hovering a disabled selector still explains it.
    await countCheck.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(countCheck).toBeFocused();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("New count check");
    const reviewer = page.getByRole("button", { name: /^Reviewer:/ });
    await expect(reviewer).toBeDisabled();
    await reviewer.hover();
    await expect(tooltip).toContainText("Set Scope to Selected discipline");

    // The tooltip stays in the top layer above a selector's menu and a modal dialog.
    const scope = page.getByRole("button", { name: /^Scope:/ });
    await scope.click();
    await expect(page.getByRole("listbox", { name: "Scope", exact: true })).toBeVisible();
    await page.mouse.move(700, 500);
    await scope.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText("Which sheets the next review covers.");
    await page.screenshot({ path: test.info().outputPath("tooltip-menu.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Review settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Review settings", exact: true });
    await settings.getByText("Optional call budget", { exact: true }).click();
    const budget = settings.getByRole("spinbutton", { name: "Maximum provider calls" });
    await budget.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(budget).toBeFocused();
    // Layout changes may move a plain element under the pointer without moving keyboard focus.
    await settings.getByRole("heading", { name: "Model connections", exact: true }).hover();
    await expect(budget).toBeFocused();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Applies to the next review");

    const scrollTop = await settings.evaluate(
      (element) =>
        new Promise<number>((resolve) => {
          element.addEventListener(
            "scroll",
            () => requestAnimationFrame(() => resolve(element.scrollTop)),
            { once: true },
          );
          element.scrollTop = 12;
        }),
    );

    expect(scrollTop).toBeGreaterThan(0);
    await expect(budget).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("tooltip-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await page.locator(".sheets-trigger").click();
    await page.getByRole("button", { name: "View sheet", exact: true }).first().click();
    const image = page.locator(".viewer img");

    await expect(image).toBeVisible();

    // Zoom sits around its reset; a divider sets rotation apart.
    await expect(
      page.getByRole("toolbar", { name: "Sheet view" }).locator("button, [role=separator]"),
    ).toHaveCount(6);

    const order = await page
      .getByRole("toolbar", { name: "Sheet view" })
      .locator("button, [role=separator]")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label") ?? item.getAttribute("role")),
      );

    expect(order).toEqual([
      "Zoom out",
      "Reset zoom",
      "Zoom in",
      "separator",
      "Rotate sheet counterclockwise",
      "Rotate sheet clockwise",
    ]);

    const level = page.getByTestId("zoom-level");
    await expect(level).toHaveText("100%");
    const viewport = page.getByRole("application", { name: "Pan and zoom source canvas" });
    const bounds = await viewport.boundingBox();

    if (!bounds) throw new Error("Missing viewport");
    const cursor = { x: bounds.x + bounds.width * 0.3, y: bounds.y + bounds.height * 0.4 };
    await page.mouse.move(cursor.x, cursor.y);
    await page.screenshot({ path: test.info().outputPath("sheet-toolbar.png") });

    // The point of the sheet under the cursor, as a fraction of the image.
    const pointUnderCursor = async () => {
      const box = await image.boundingBox();

      if (!box) throw new Error("Missing image");

      return { x: (cursor.x - box.x) / box.width, y: (cursor.y - box.y) / box.height };
    };

    // A plain wheel leaves the zoom alone.
    await page.mouse.wheel(0, -120);
    await expect(level).toHaveText("100%");

    // Holding Ctrl zooms toward the cursor, one notch at about one button press.
    const before = await pointUnderCursor();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect(level).not.toHaveText("100%");
    const zoomed = Number.parseInt((await level.textContent()) ?? "", 10);
    expect(zoomed).toBeGreaterThan(115);
    expect(zoomed).toBeLessThan(135);
    const after = await pointUnderCursor();
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);

    // A trackpad pinch is a wheel event with ctrlKey and a small delta, and it applies smoothly.
    const pinch = async (deltaY: number) =>
      viewport.evaluate((element, delta) => {
        const box = element.getBoundingClientRect();

        element.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: delta,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            clientX: box.left + box.width * 0.3,
            clientY: box.top + box.height * 0.4,
          }),
        );
      }, deltaY);

    await pinch(-5);
    const pinched = Number.parseInt((await level.textContent()) ?? "", 10);
    expect(pinched).toBeGreaterThan(zoomed);
    expect(pinched).toBeLessThan(zoomed * 1.1);
    const pinchPoint = await pointUnderCursor();
    expect(pinchPoint.x).toBeCloseTo(before.x, 2);
    expect(pinchPoint.y).toBeCloseTo(before.y, 2);

    // The page itself never zooms under the gesture.
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);

    await level.click();
    await expect(level).toHaveText("100%");

    // Rotation goes both ways, and keeps a fitted sheet fitted.
    const layer = page.locator(".transform-layer");
    await page.getByRole("button", { name: "Rotate sheet clockwise", exact: true }).click();
    await expect(layer).toHaveAttribute("style", /rotate\(90deg\)/);
    await expect(level).toHaveText("100%");
    const turned = await image.boundingBox();

    if (!turned) throw new Error("Missing rotated image");
    expect(turned.x).toBeGreaterThanOrEqual(bounds.x - 1);
    expect(turned.y).toBeGreaterThanOrEqual(bounds.y - 1);
    expect(turned.x + turned.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(turned.y + turned.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    await page.getByRole("button", { name: "Rotate sheet counterclockwise", exact: true }).click();
    await expect(layer).toHaveAttribute("style", /rotate\(0deg\)/);
    await page.getByRole("button", { name: "Rotate sheet counterclockwise", exact: true }).click();
    await expect(layer).toHaveAttribute("style", /rotate\(270deg\)/);

    // Resetting zoom leaves the rotation the reviewer chose.
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await level.click();
    await expect(layer).toHaveAttribute("style", /rotate\(270deg\)/);
    await expect(level).toHaveText("100%");

    // Cursor anchoring works with both a quarter turn and a pan.
    await viewport.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    const panned = await pointUnderCursor();
    await pinch(-10);
    const anchored = await pointUnderCursor();
    expect(anchored.x).toBeCloseTo(panned.x, 2);
    expect(anchored.y).toBeCloseTo(panned.y, 2);

    // Panning at 100% means the view is no longer fitted. Rotation must retain its center point.
    await level.click();
    await viewport.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");

    const centerPoint = () =>
      layer.evaluate((element) => {
        const viewport = element.parentElement;
        const image = element.querySelector("img");

        if (!viewport || !image) throw new Error("Missing source geometry");
        const inverse = new DOMMatrix(getComputedStyle(element).transform).inverse();

        const point = new DOMPoint(
          viewport.clientWidth / 2,
          viewport.clientHeight / 2,
        ).matrixTransform(inverse);

        return { x: point.x / image.naturalWidth, y: point.y / image.naturalHeight };
      });

    const beforeTurn = await centerPoint();
    await page.getByRole("button", { name: "Rotate sheet clockwise", exact: true }).click();
    const afterTurn = await centerPoint();
    expect(afterTurn.x).toBeCloseTo(beforeTurn.x, 3);
    expect(afterTurn.y).toBeCloseTo(beforeTurn.y, 3);

    // A collapsed viewport must not set scale to zero or poison subsequent zooms with NaN.
    await viewport.evaluate((element) => {
      element.style.width = "0px";
      element.style.height = "0px";
      element.style.minHeight = "0px";
      element.style.flex = "none";
    });
    await expect(viewport).toHaveJSProperty("clientWidth", 0);
    await expect(viewport).toHaveJSProperty("clientHeight", 0);
    await level.click();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await viewport.evaluate((element) => element.removeAttribute("style"));
    await expect(viewport).not.toHaveJSProperty("clientWidth", 0);
    await level.click();
    await pinch(-5);
    await expect(layer).not.toHaveAttribute("style", /NaN|Infinity|scale\(0\)/);
    await expect(level).not.toHaveText(/NaN|Infinity/);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
