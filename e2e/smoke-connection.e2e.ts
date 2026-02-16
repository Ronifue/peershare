import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke Test: Two-peer page connection
 * Validates basic room creation, joining, and WebRTC connection establishment
 */

const TEST_TIMEOUT = 60000;
const CONNECTION_WAIT_MS = 5000;

test.describe.configure({ mode: "serial" });

test.describe("Two-Peer Connection Smoke", () => {
  let creatorPage: Page;
  let joinerPage: Page;
  let roomCode: string;

  test.beforeEach(async ({ browser }) => {
    // Create two separate browser contexts for each peer
    const creatorContext = await browser.newContext();
    const joinerContext = await browser.newContext();

    creatorPage = await creatorContext.newPage();
    joinerPage = await joinerContext.newPage();
  });

  test.afterEach(async () => {
    await creatorPage?.close();
    await joinerPage?.close();
  });

  test(
    "creator can create room and display room code",
    async () => {
      // Creator opens homepage
      await creatorPage.goto("/");
      await expect(creatorPage.locator(".home-screen")).toBeVisible();

      // Click "创建传输" (Create Transfer) button
      await creatorPage.click("button.btn-primary");

      // Wait for transfer screen and room code display
      await expect(creatorPage.locator(".transfer-screen")).toBeVisible({
        timeout: 10000,
      });

      // Extract room code from UI (6-digit numeric code displayed)
      const roomCodeElement = creatorPage.locator(".room-code, .room-code-display");
      await expect(roomCodeElement).toBeVisible();

      roomCode = await roomCodeElement.textContent() || "";
      expect(roomCode).toMatch(/^\d{6}$/); // 6-digit room code
    }
  );

  test(
    "joiner can join room with valid code",
    async () => {
      test.skip(!roomCode, "Requires room code from previous test");

      // Joiner opens homepage
      await joinerPage.goto("/");
      await expect(joinerPage.locator(".home-screen")).toBeVisible();

      // Click "加入传输" (Join Transfer) button
      await joinerPage.click("button.btn-secondary");

      // Enter room code in input field
      await joinerPage.fill("input.code-input", roomCode);

      // Click join button
      await joinerPage.click(".join-actions button[type='submit']");

      // Verify transfer screen loads
      await expect(joinerPage.locator(".transfer-screen")).toBeVisible({
        timeout: 10000,
      });
    }
  );

  test(
    "peers establish WebRTC connection",
    async () => {
      test.skip(!roomCode, "Requires room code from setup");

      // Wait for connection indicators on both pages
      await Promise.all([
        expect(creatorPage.locator(".info-cell.active")).toBeVisible({
          timeout: CONNECTION_WAIT_MS,
        }),
        expect(joinerPage.locator(".info-cell.active")).toBeVisible({
          timeout: CONNECTION_WAIT_MS,
        }),
      ]);

      // Verify connection status shows "已建立" (Established)
      const creatorStatus = await creatorPage
        .locator(".info-cell:has(.cell-label:has-text('直连')) .cell-value")
        .textContent();
      expect(creatorStatus).toContain("已建立");

      // Verify drop zone is enabled (indicates P2P connection ready)
      await expect(creatorPage.locator(".drop-zone:not(.disabled)")).toBeVisible();
      await expect(joinerPage.locator(".drop-zone:not(.disabled)")).toBeVisible();
    }
  );

  test(
    "connection persists across short disconnect",
    async () => {
      test.skip(!roomCode, "Requires established connection");

      // Simulate brief network interruption by reloading joiner page
      await joinerPage.reload();

      // Re-join with same room code
      await joinerPage.click("button.btn-secondary");
      await joinerPage.fill("input.code-input", roomCode);
      await joinerPage.click(".join-actions button[type='submit']");

      // Verify reconnection
      await expect(joinerPage.locator(".transfer-screen")).toBeVisible({
        timeout: 15000,
      });

      // Check connection restores
      await expect(
        joinerPage.locator(".info-cell.active")
      ).toBeVisible({ timeout: CONNECTION_WAIT_MS });
    }
  );
});
