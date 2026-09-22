import { expect, test } from "@playwright/test";
import { createSticky, freshBoard, mirror, openBoard } from "./helpers";

const TEAM_CSV = `Name,Role,Manager
Dana,CEO,
Alex,VP Product,Dana
Sam,VP Engineering,Dana
Rae,Design Lead,Alex`;

test("dropping a CSV builds an org chart", async ({ page }) => {
  await openBoard(page, freshBoard());
  await page.evaluate((csv) => {
    const dt = new DataTransfer();
    dt.items.add(new File([csv], "team.csv", { type: "text/csv" }));
    window.dispatchEvent(new DragEvent("drop", {
      dataTransfer: dt, clientX: 640, clientY: 400, bubbles: true, cancelable: true,
    }));
  }, TEAM_CSV);
  await expect(mirror(page)).toContainText("Dana");
  await expect(mirror(page)).toContainText("Connections, 3 items");
});

test("pasting a URL creates a live embed", async ({ page }) => {
  await openBoard(page, freshBoard());
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "https://example.com/page");
    window.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  });
  await expect(mirror(page)).toContainText("Embedded page: example.com");
});

test("an Orim board file drops back in whole", async ({ page }) => {
  await openBoard(page, freshBoard());
  await page.evaluate(() => {
    const board = {
      nodes: [{
        id: "n1", type: "sticky", parent: null, x: 0, y: 0, w: 180, h: 120,
        rotation: 0, index: "a0", locked: false, data: {},
        text: "round-trip", color: "green",
      }],
      connectors: [],
    };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(board)], "board.orim.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("drop", {
      dataTransfer: dt, clientX: 640, clientY: 400, bubbles: true, cancelable: true,
    }));
  });
  await expect(mirror(page)).toContainText("Sticky note: round-trip, green");
});
