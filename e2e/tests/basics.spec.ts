import { expect, test } from "@playwright/test";
import { createSticky, freshBoard, mirror, openBoard } from "./helpers";

test("sticky creation shows in the a11y mirror; undo removes it", async ({ page }) => {
  await openBoard(page, freshBoard());
  await createSticky(page, 500, 400, "hello world");
  await expect(mirror(page)).toContainText("Sticky note: hello world, yellow");

  await page.keyboard.press("ControlOrMeta+z"); // text commit
  await page.keyboard.press("ControlOrMeta+z"); // creation
  await expect(mirror(page)).not.toContainText("hello world");
});

test("Tab authors a child, Enter a sibling, connectors described in prose", async ({ page }) => {
  await openBoard(page, freshBoard());
  await createSticky(page, 500, 300, "CEO");

  await page.keyboard.press("Tab");
  await page.keyboard.type("VP One");
  await page.keyboard.press("Escape");
  await expect(mirror(page)).toContainText('Connector from "CEO" to "VP One"');

  await page.keyboard.press("Enter"); // sibling of VP One
  await page.keyboard.type("VP Two");
  await page.keyboard.press("Escape");
  await expect(mirror(page)).toContainText('Connector from "CEO" to "VP Two"');
});

test("table cells edit in place and read as rows", async ({ page }) => {
  await openBoard(page, freshBoard());
  await page.keyboard.press("g");
  await page.mouse.click(500, 400); // table centered here, 480×136, 3 cols
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(500 - 160, 400 - 17); // row 1, column 1
  await page.keyboard.type("Ship it");
  await page.keyboard.press("Enter");
  await expect(mirror(page)).toContainText("Ship it");
  await expect(mirror(page)).toContainText("Row 1 of 3");
});
