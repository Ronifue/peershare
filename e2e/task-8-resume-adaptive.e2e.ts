import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { join } from "path";
import { parseStructuredEventFromConsoleText } from "../src/common/structured-event";

const PEER_CONNECT_TIMEOUT_MS = 20000;
const PEER_CONNECT_MAX_ATTEMPTS = 2;

type StructuredEvent = {
  event?: string;
  timestamp?: number;
  [key: string]: unknown;
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

async function waitFor<T>(resolveValue: () => T | null, timeoutMs: number, reason: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const value = resolveValue();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(reason);
}

async function createRoom(page: Page, appUrl: string): Promise<string> {
  await page.goto(appUrl);
  await page.getByTestId("create-room-button").click();
  await page.getByTestId("room-code-value").waitFor({ timeout: 10000 });
  const roomCode = (await page.getByTestId("room-code-value").textContent())?.trim() ?? "";
  if (!/^\d{6}$/.test(roomCode)) {
    throw new Error(`Invalid room code: ${roomCode}`);
  }
  return roomCode;
}

async function joinRoom(page: Page, appUrl: string, roomCode: string): Promise<void> {
  await page.goto(appUrl);
  await page.getByTestId("show-join-form-button").click();
  await page.getByTestId("join-room-input").fill(roomCode);
  await page.getByTestId("join-room-submit-button").click();
  await expect(page.getByTestId("transfer-screen")).toBeVisible({ timeout: 15000 });
}

async function rejoinRoomAfterReload(page: Page, appUrl: string, roomCode: string): Promise<void> {
  await page.reload();
  await page.getByTestId("show-join-form-button").click();
  await page.getByTestId("join-room-input").fill(roomCode);
  await page.getByTestId("join-room-submit-button").click();
  await expect(page.getByTestId("transfer-screen")).toBeVisible({ timeout: 20000 });
}

async function waitForPeerConnected(page: Page, timeoutMs: number = PEER_CONNECT_TIMEOUT_MS): Promise<void> {
  const directStatus = page.getByTestId("p2p-status-direct");
  await expect(directStatus).toContainText("已建立", { timeout: timeoutMs });
}

async function ensurePeersConnectedWithRetry(
  senderPage: Page,
  receiverPage: Page,
  appUrl: string,
  roomCode: string
): Promise<void> {
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
      await rejoinRoomAfterReload(receiverPage, appUrl, roomCode);
    }
  }

  throw new Error(`Peer connection did not stabilize after ${PEER_CONNECT_MAX_ATTEMPTS} attempts: ${lastError ?? "unknown"}`);
}

function buildBinaryFile(sizeMB: number, seed: number): { name: string; mimeType: string; buffer: Buffer } {
  const size = sizeMB * 1024 * 1024;
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = (i + seed) % 251;
  }
  return {
    name: `${sizeMB}mb-${seed}.bin`,
    mimeType: "application/octet-stream",
    buffer
  };
}

test.describe.configure({ mode: "serial" });

test("adaptive chunking respects low maxMessageSize", async ({ browser }) => {
  test.setTimeout(240000);
  const appUrl = "/?psBackpressureMode=event&psForceMaxMessageSize=20000";

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  const senderEvents: StructuredEvent[] = [];
  let receiverCompleted = false;

  senderPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event) {
      senderEvents.push(event);
    }
  });
  receiverPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event === "transfer_receive_complete") {
      receiverCompleted = true;
    }
  });

  try {
    const roomCode = await createRoom(senderPage, appUrl);
    await joinRoom(receiverPage, appUrl, roomCode);
    await ensurePeersConnectedWithRetry(senderPage, receiverPage, appUrl, roomCode);

    const filePayload = buildBinaryFile(5, 7);
    await senderPage.getByTestId("file-input").setInputFiles(filePayload);

    const sendComplete = await waitFor(
      () => {
        const found = senderEvents.find((item) => item.event === "transfer_send_complete");
        return found ?? null;
      },
      180000,
      "Timed out waiting for transfer_send_complete"
    );

    await waitFor(
      () => (receiverCompleted ? true : null),
      180000,
      "Timed out waiting for receiver completion"
    );

    const chunkSizeUsed = typeof sendComplete.chunkSizeUsed === "number" ? sendComplete.chunkSizeUsed : null;
    const messageLimitBytes = typeof sendComplete.messageLimitBytes === "number" ? sendComplete.messageLimitBytes : null;
    expect(chunkSizeUsed).toBe(16 * 1024);
    expect(messageLimitBytes).toBeGreaterThanOrEqual(20000);
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});

test("serial multi-file queue sends files in enqueue order", async ({ browser }) => {
  test.setTimeout(240000);
  const appUrl = "/?psBackpressureMode=event&psForceMaxMessageSize=20000";

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  const senderEvents: StructuredEvent[] = [];
  const receiverCompleteEvents: StructuredEvent[] = [];

  senderPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event) {
      senderEvents.push(event);
    }
  });

  receiverPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event === "transfer_receive_complete") {
      receiverCompleteEvents.push(event);
    }
  });

  try {
    const roomCode = await createRoom(senderPage, appUrl);
    await joinRoom(receiverPage, appUrl, roomCode);
    await ensurePeersConnectedWithRetry(senderPage, receiverPage, appUrl, roomCode);

    const queuedFiles = [
      buildBinaryFile(1, 11),
      buildBinaryFile(1, 23),
      buildBinaryFile(1, 37)
    ];

    await senderPage.getByTestId("file-input").setInputFiles(queuedFiles);

    await waitFor(
      () => {
        const completed = senderEvents.filter((item) => item.event === "transfer_send_complete");
        return completed.length >= queuedFiles.length ? completed : null;
      },
      180000,
      "Timed out waiting for queued transfer completion"
    );

    await waitFor(
      () => (receiverCompleteEvents.length >= queuedFiles.length ? receiverCompleteEvents : null),
      180000,
      "Timed out waiting for receiver queue completion"
    );

    const senderCompleted = senderEvents
      .filter((item) => item.event === "transfer_send_complete")
      .slice(0, queuedFiles.length);

    const senderFileNames = senderCompleted.map((event) => String(event.fileName ?? ""));
    const expectedOrder = queuedFiles.map((item) => item.name);
    expect(senderFileNames).toEqual(expectedOrder);
    expect(receiverCompleteEvents.length).toBeGreaterThanOrEqual(queuedFiles.length);
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});

test("resume negotiation continues from non-zero chunk after reconnect", async ({ browser }) => {
  test.setTimeout(360000);
  const appUrl = "/?psBackpressureMode=event&psForceMaxMessageSize=20000";

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  const senderEvents: StructuredEvent[] = [];
  const senderConsoleTexts: string[] = [];
  let receiverCompleteCount = 0;

  senderPage.on("console", (message) => {
    senderConsoleTexts.push(message.text());
    const event = parseStructuredEvent(message);
    if (event?.event) {
      senderEvents.push(event);
    }
  });
  receiverPage.on("console", (message) => {
    const event = parseStructuredEvent(message);
    if (event?.event === "transfer_receive_complete") {
      receiverCompleteCount += 1;
    }
  });

  try {
    const roomCode = await createRoom(senderPage, appUrl);
    await joinRoom(receiverPage, appUrl, roomCode);
    await ensurePeersConnectedWithRetry(senderPage, receiverPage, appUrl, roomCode);

    const senderIdbSupported = await senderPage.evaluate(() => typeof indexedDB !== "undefined");
    const receiverIdbSupported = await receiverPage.evaluate(() => typeof indexedDB !== "undefined");
    expect(senderIdbSupported).toBe(true);
    expect(receiverIdbSupported).toBe(true);

    await senderPage.getByTestId("file-input").setInputFiles(LARGE_FIXTURE_PATH);

    await waitFor(
      () => {
        const started = senderEvents.find((item) => item.event === "transfer_send_start");
        return started ?? null;
      },
      20000,
      "Initial transfer did not start"
    );

    await receiverPage.waitForFunction(() => {
      const el = document.querySelector(".incoming-section .progress-text");
      if (!el) return false;
      const value = Number.parseFloat(el.textContent || "0");
      return Number.isFinite(value) && value >= 5;
    }, { timeout: 120000 });

    await receiverPage.reload();
    await joinRoom(receiverPage, appUrl, roomCode);
    await waitForPeerConnected(receiverPage);

    const resumed = await waitFor(
      () => {
        const found = senderEvents.find((item) => {
          if (item.event !== "transfer_resume_negotiated") {
            return false;
          }
          return typeof item.startChunk === "number" && item.startChunk > 0;
        });
        return found ?? null;
      },
      240000,
      "No non-zero resume negotiation observed"
    ).catch((error) => {
      const resumeEvents = senderEvents
        .filter((item) => item.event === "transfer_resume_negotiated")
        .slice(-5);
      const lookupEvents = senderEvents
        .filter((item) => item.event === "transfer_resume_lookup")
        .slice(-5);
      const interruptionEvents = senderEvents
        .filter((item) => item.event === "transfer_send_interrupted" || item.event === "transfer_auto_resume_waiting" || item.event === "transfer_auto_resume_attempt")
        .slice(-10);
      const rawLookupLogs = senderConsoleTexts
        .filter((text) => text.includes("transfer_resume_lookup"))
        .slice(-5);
      throw new Error(
        `${(error as Error).message}; recent resume events=${JSON.stringify(resumeEvents)}; lookup=${JSON.stringify(lookupEvents)}; interruptions=${JSON.stringify(interruptionEvents)}; raw=${JSON.stringify(rawLookupLogs)}`
      );
    });

    expect(typeof resumed.startChunk).toBe("number");
    expect((resumed.startChunk as number)).toBeGreaterThan(0);

    const autoResumeEvent = senderEvents.find((item) => item.event === "transfer_auto_resume_attempt");
    expect(autoResumeEvent).toBeTruthy();

    await waitFor(
      () => {
        const completed = senderEvents.find((item) => item.event === "transfer_send_complete");
        return completed ?? null;
      },
      240000,
      "Resumed transfer did not complete"
    );

    await waitFor(
      () => (receiverCompleteCount > 0 ? receiverCompleteCount : null),
      240000,
      "Receiver did not complete resumed transfer"
    );
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});
const LARGE_FIXTURE_PATH = join(process.cwd(), "fixtures", "100mb.bin");
