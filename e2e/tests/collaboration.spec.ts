import { expect, test } from "@playwright/test";
import { createSticky, freshBoard, mirror, openBoard } from "./helpers";

test("two clients converge on the same board", async ({ browser }) => {
  const board = freshBoard();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openBoard(a, board);
  await openBoard(b, board);

  await createSticky(a, 400, 300, "from-A");
  await expect(mirror(b)).toContainText("from-A", { timeout: 10_000 });

  await createSticky(b, 700, 500, "from-B");
  await expect(mirror(a)).toContainText("from-B", { timeout: 10_000 });
});

test("concurrent edits to different table cells both survive", async ({ browser }) => {
  const board = freshBoard();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openBoard(a, board);
  await openBoard(b, board);

  // A creates a table centered at (500, 400): 3 columns × 3 rows.
  await a.keyboard.press("g");
  await a.mouse.click(500, 400);
  await a.keyboard.press("Escape");
  await expect(mirror(b)).toContainText("Table", { timeout: 10_000 });

  // A edits row 1 / column 1 while B edits row 2 / column 2.
  await a.mouse.dblclick(340, 383);
  await a.keyboard.type("alpha");
  await a.keyboard.press("Enter");
  await b.mouse.dblclick(500, 417);
  await b.keyboard.type("beta");
  await b.keyboard.press("Enter");

  for (const page of [a, b]) {
    await expect(mirror(page)).toContainText("alpha", { timeout: 10_000 });
    await expect(mirror(page)).toContainText("beta", { timeout: 10_000 });
  }
});
