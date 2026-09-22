/**
 * The a11y mirror is the test oracle: the canvas is pixels, but every
 * object is mirrored as a labelled ARIA tree — so these tests verify
 * features and the accessibility layer in one pass.
 */
import { expect, type Page } from "@playwright/test";

export const freshBoard = (): string =>
  `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function openBoard(page: Page, board: string): Promise<void> {
  await page.goto(`/?b=${board}`);
  await expect(page.locator("#stat-conn")).toHaveText("synced", { timeout: 15_000 });
}

export const mirror = (page: Page) => page.locator("#a11y-mirror");

export async function createSticky(
  page: Page,
  x: number,
  y: number,
  text: string,
): Promise<void> {
  await page.keyboard.press("n");
  await page.mouse.click(x, y);
  const editor = page.locator(".orim-text-editor .ProseMirror");
  await editor.waitFor();
  await editor.click(); // headless focus is unreliable without it
  await editor.pressSequentially(text);
  await editor.press("Escape");
  await expect(page.locator(".orim-text-editor")).toHaveCount(0);
}
