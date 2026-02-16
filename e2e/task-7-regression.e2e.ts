import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  parseStructuredEventFromConsoleText
} from "../src/common/structured-event";

const FIXTURE_PATH = join(process.cwd(), "fixtures", "100mb.bin");
const EVIDENCE_PATH = join(process.cwd(), ".sisyphus", "evidence", "task-7-regression-metrics.json");
const RECONNECT_THRESHOLD_MS = 15000;
const REGRESSION_APP_URL = "/?psBackpressureMode=event";
const PEER_CONNECT_TIMEOUT_MS = 20000;
const PEER_CONNECT_MAX_ATTEMPTS = 2;

type StructuredEvent = {
  event?: string;
  timestamp?: number;
  [key: string]: unknown;
};

type TransferCompleteEvent = {
  event: "transfer_send_complete";
  fileId: string;
  fileName: string;
  fileSizeBytes: number;
  transferMs: number;
  avgMbps: number;
  backpressureWaitMs: number;
  eventWaitMs?: number;
  pollingIdleWaitMs?: number;
  backpressureEvents: number;
  backpressureMode: string;
  eventDrivenWaits: number;
  pollingWaits: number;
  fallbackReason?: string | null;
  timestamp: number;
};

function parseStructuredEvent(message: ConsoleMessage): StructuredEvent | null {
  const parsed = parseStructuredEventFromConsoleText(message.text());
  if (!parsed) {
    return null;
  }

  return {
    event: parsed.event,
    timestamp: parsed.timestamp,
    ...parsed.payload
  };
}

async function waitFor<T>(
  resolveValue: () => T | null,
  timeoutMs: number,
  failureReason: string
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const value = resolveValue();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(failureReason);
}

async function createRoom(page: Page): Promise<string> {
  await page.goto(REGRESSION_APP_URL);
  await page.getByTestId("create-room-button").click();
  await page.getByTestId("room-code-value").waitFor({ timeout: 10000 });

  const roomCode = (await page.getByTestId("room-code-value").textContent())?.trim() ?? "";
  if (!roomCode || !/^\d{6}$/.test(roomCode)) {
    throw new Error(`Invalid room code: ${roomCode}`);
  }

  return roomCode;
}

async function joinRoom(page: Page, roomCode: string): Promise<void> {
  await page.goto(REGRESSION_APP_URL);
  await page.getByTestId("show-join-form-button").click();
  await page.getByTestId("join-room-input").fill(roomCode);
  await page.getByTestId("join-room-submit-button").click();
  await expect(page.getByTestId("transfer-screen")).toBeVisible({ timeout: 10000 });
}

async function rejoinRoomAfterReload(page: Page, roomCode: string): Promise<void> {
  await page.reload();
  await page.getByTestId("show-join-form-button").click();
  await page.getByTestId("join-room-input").fill(roomCode);
  await page.getByTestId("join-room-submit-button").click();
  await expect(page.getByTestId("transfer-screen")).toBeVisible({ timeout: 15000 });
}

async function waitForPeerConnected(page: Page, timeoutMs: number = PEER_CONNECT_TIMEOUT_MS): Promise<void> {
  const connectionCell = page.getByTestId("p2p-status-direct");
  await expect(connectionCell).toBeVisible({ timeout: timeoutMs });
  await expect(connectionCell).toContainText("已建立", { timeout: timeoutMs });
}

async function ensurePeersConnectedWithRetry(senderPage: Page, receiverPage: Page, roomCode: string): Promise<void> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= PEER_CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      await Promise.all([
        waitForPeerConnected(senderPage),
        waitForPeerConnected(receiverPage)
      ]);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === PEER_CONNECT_MAX_ATTEMPTS) {
        break;
      }
      await rejoinRoomAfterReload(receiverPage, roomCode);
    }
  }

  throw new Error(`Peer connection did not stabilize after ${PEER_CONNECT_MAX_ATTEMPTS} attempts: ${lastError ?? "unknown"}`);
}

test.describe.configure({ mode: "serial" });

test("task7 regression path produces transfer and reconnect metrics", async ({ browser }) => {
  test.setTimeout(240000);

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  let transferSendComplete: TransferCompleteEvent | null = null;
  let transferReceiveCompleteAt: number | null = null;
  let disconnectedAt: number | null = null;
  let connectedAfterRecoveryAt: number | null = null;

  senderPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (!event?.event) {
      return;
    }

    if (event.event === "transfer_send_complete") {
      transferSendComplete = event as TransferCompleteEvent;
    }

    if (event.event === "ice_disconnected_grace_start") {
      disconnectedAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
    }

    if (event.event === "ice_connected_after_recovery") {
      connectedAfterRecoveryAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
    }
  });

  receiverPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event === "transfer_receive_complete") {
      transferReceiveCompleteAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
    }
  });

  try {
    const roomCode = await createRoom(senderPage);
    await joinRoom(receiverPage, roomCode);

    await ensurePeersConnectedWithRetry(senderPage, receiverPage, roomCode);

    await senderPage.getByTestId("file-input").setInputFiles(FIXTURE_PATH);

    transferSendComplete = await waitFor(
      () => transferSendComplete,
      180000,
      "Timed out waiting for transfer_send_complete"
    );

    await waitFor(
      () => (transferReceiveCompleteAt !== null ? transferReceiveCompleteAt : null),
      180000,
      "Timed out waiting for transfer_receive_complete"
    );

    const reconnectStartMs = Date.now();
    await rejoinRoomAfterReload(receiverPage, roomCode);
    await waitForPeerConnected(receiverPage);
    const reconnectRecoveryMs = Date.now() - reconnectStartMs;

    const reconnectEventRecoveryMs =
      disconnectedAt !== null && connectedAfterRecoveryAt !== null
        ? Math.max(0, connectedAfterRecoveryAt - disconnectedAt)
        : null;

    const evidence = {
      runId: `task7-regression-${Date.now()}`,
      timestamp: new Date().toISOString(),
      scenario: "100MB-normal-short-disconnect",
      transfer: {
        fileName: transferSendComplete.fileName,
        fileSizeBytes: transferSendComplete.fileSizeBytes,
        transferMs: transferSendComplete.transferMs,
        avgMbps: transferSendComplete.avgMbps,
        backpressureWaitMs: transferSendComplete.backpressureWaitMs,
        eventWaitMs: transferSendComplete.eventWaitMs ?? null,
        pollingIdleWaitMs: transferSendComplete.pollingIdleWaitMs ?? null,
        backpressureEvents: transferSendComplete.backpressureEvents,
        backpressureMode: transferSendComplete.backpressureMode,
        eventDrivenWaits: transferSendComplete.eventDrivenWaits,
        pollingWaits: transferSendComplete.pollingWaits,
        fallbackReason: transferSendComplete.fallbackReason ?? null
      },
      reconnect: {
        scenario: "joiner-reload-rejoin",
        reconnectRecoveryMs,
        reconnectEventRecoveryMs,
        thresholdMs: RECONNECT_THRESHOLD_MS
      }
    };

    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

    expect(transferSendComplete.transferMs).toBeGreaterThan(0);
    expect(transferSendComplete.backpressureWaitMs).toBeGreaterThanOrEqual(0);
    expect(reconnectRecoveryMs).toBeGreaterThan(0);
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});
