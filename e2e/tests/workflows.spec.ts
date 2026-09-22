import { expect, test } from "@playwright/test";
import { createSticky, freshBoard, mirror, openBoard } from "./helpers";

test("present mode walks template frames as slides", async ({ page }) => {
  const board = freshBoard();
  await page.goto(`/?b=${board}&template=retro`);
  await expect(page.locator("#stat-conn")).toHaveText("synced", { timeout: 15_000 });
  await expect(mirror(page)).toContainText("Frame", { timeout: 10_000 });

  await page.click("#menu-toggle");
  await page.click("#btn-present");
  await expect(page.locator("body")).toHaveClass(/presenting/);
  await expect(page.locator("#present-label")).toContainText("1 / 3");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#present-label")).toContainText("2 / 3");

  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/presenting/);
});

test("history: labelled version restores earlier content, undoably", async ({ page, request }) => {
  const board = freshBoard();
  await openBoard(page, board);
  await createSticky(page, 400, 300, "keep me");
  await expect(mirror(page)).toContainText("keep me");

  // Snapshots copy the persisted board row; persistence is debounced.
  await expect
    .poll(async () => {
      const boards = (await (await request.get("/boards")).json()) as { name: string }[];
      return boards.some((b) => b.name === board);
    }, { timeout: 10_000 })
    .toBe(true);

  await page.click("#menu-toggle");
  await page.click("#btn-history");
  await page.click("#history-save");
  await page.locator(".dialog-backdrop input").first().fill("baseline");
  await page.locator("#dlg-ok").click();
  await expect(page.locator("#history-list")).toContainText("baseline");

  await createSticky(page, 700, 500, "temporary");
  await expect(mirror(page)).toContainText("temporary");

  await page.locator(".history-row", { hasText: "baseline" }).click();
  await page.click("#history-restore");
  await page.locator("#dlg-ok").click();

  await expect(mirror(page)).toContainText("keep me");
  await expect(mirror(page)).not.toContainText("temporary");
});

test("a view-only link is read-only", async ({ page, request }) => {
  const board = freshBoard();
  await openBoard(page, board);
  await createSticky(page, 500, 400, "owner content");
  await expect(mirror(page)).toContainText("owner content");

  await request.post("/boards/share", { data: { board, mode: "link-view" } });
  await page.reload();
  await expect(page.locator("#stat-conn")).toHaveText("synced", { timeout: 15_000 });

  await page.keyboard.press("n");
  await page.mouse.click(700, 300);
  await page.keyboard.type("should not exist");
  await page.keyboard.press("Escape");
  await expect(mirror(page)).toContainText("owner content");
  await expect(mirror(page)).not.toContainText("should not exist");
});
