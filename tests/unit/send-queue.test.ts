import { describe, expect, test } from "bun:test";
import {
  createInitialSendQueueState,
  createOutgoingQueueItems,
  getSendQueueSummary,
  hasQueuedItems,
  selectNextQueuedItem,
  sendQueueReducer,
  type SendQueueState
} from "../../src/client/send-queue";

function createFakeFile(name: string, size: number): File {
  const payload = new Uint8Array(Math.max(1, size));
  return new File([payload], name, { type: "application/octet-stream" });
}

function enqueueFiles(state: SendQueueState, files: File[]): SendQueueState {
  const items = createOutgoingQueueItems(files);
  return sendQueueReducer(state, { type: "enqueue", items });
}

describe("send-queue reducer", () => {
  test("enqueues files and keeps FIFO order", () => {
    const fileA = createFakeFile("a.bin", 128);
    const fileB = createFakeFile("b.bin", 256);

    let state = createInitialSendQueueState();
    state = enqueueFiles(state, [fileA, fileB]);

    expect(state.items).toHaveLength(2);
    expect(state.items[0].file.name).toBe("a.bin");
    expect(state.items[1].file.name).toBe("b.bin");
    expect(hasQueuedItems(state)).toBe(true);
    expect(selectNextQueuedItem(state)?.file.name).toBe("a.bin");
  });

  test("serial sending lifecycle works: sending -> progress -> completed", () => {
    const fileA = createFakeFile("a.bin", 128);

    let state = createInitialSendQueueState();
    state = enqueueFiles(state, [fileA]);
    const itemId = state.items[0].id;

    state = sendQueueReducer(state, { type: "mark-sending", itemId });
    expect(state.activeItemId).toBe(itemId);
    expect(state.items[0].status).toBe("sending");
    expect(state.items[0].attempts).toBe(1);

    state = sendQueueReducer(state, {
      type: "update-progress",
      itemId,
      sentBytes: 64,
      totalBytes: 128
    });
    expect(state.items[0].progressPercent).toBe(50);

    state = sendQueueReducer(state, { type: "mark-completed", itemId });
    expect(state.activeItemId).toBeNull();
    expect(state.items[0].status).toBe("completed");
    expect(state.items[0].progressPercent).toBe(100);
  });

  test("failed item can retry and keeps attempt count on next send", () => {
    const fileA = createFakeFile("a.bin", 128);

    let state = createInitialSendQueueState();
    state = enqueueFiles(state, [fileA]);
    const itemId = state.items[0].id;

    state = sendQueueReducer(state, { type: "mark-sending", itemId });
    state = sendQueueReducer(state, {
      type: "mark-failed",
      itemId,
      errorMessage: "network down"
    });

    expect(state.items[0].status).toBe("failed");
    expect(state.items[0].errorMessage).toBe("network down");

    state = sendQueueReducer(state, { type: "retry", itemId });
    expect(state.items[0].status).toBe("queued");
    expect(state.items[0].progressPercent).toBe(0);
    expect(state.items[0].errorMessage).toBeNull();

    state = sendQueueReducer(state, { type: "mark-sending", itemId });
    expect(state.items[0].attempts).toBe(2);
  });

  test("removal and clear-completed keep sending item protected", () => {
    const fileA = createFakeFile("a.bin", 128);
    const fileB = createFakeFile("b.bin", 256);

    let state = createInitialSendQueueState();
    state = enqueueFiles(state, [fileA, fileB]);

    const firstId = state.items[0].id;
    const secondId = state.items[1].id;

    state = sendQueueReducer(state, { type: "mark-sending", itemId: firstId });
    state = sendQueueReducer(state, { type: "remove", itemId: firstId });
    expect(state.items).toHaveLength(2);

    state = sendQueueReducer(state, { type: "mark-completed", itemId: firstId });
    state = sendQueueReducer(state, { type: "remove", itemId: firstId });
    expect(state.items).toHaveLength(1);
    expect(state.items[0].id).toBe(secondId);

    state = sendQueueReducer(state, { type: "mark-sending", itemId: secondId });
    state = sendQueueReducer(state, { type: "mark-completed", itemId: secondId });
    state = sendQueueReducer(state, { type: "clear-completed" });
    expect(state.items).toHaveLength(0);
  });

  test("summary reflects queue composition", () => {
    const fileA = createFakeFile("a.bin", 128);
    const fileB = createFakeFile("b.bin", 256);
    const fileC = createFakeFile("c.bin", 512);

    let state = createInitialSendQueueState();
    state = enqueueFiles(state, [fileA, fileB, fileC]);

    const [a, b, c] = state.items.map((item) => item.id);
    state = sendQueueReducer(state, { type: "mark-sending", itemId: a });
    state = sendQueueReducer(state, { type: "mark-completed", itemId: a });
    state = sendQueueReducer(state, { type: "mark-sending", itemId: b });
    state = sendQueueReducer(state, { type: "mark-failed", itemId: b, errorMessage: "failed" });
    state = sendQueueReducer(state, { type: "mark-sending", itemId: c });

    const summary = getSendQueueSummary(state);
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.sending).toBe(1);
    expect(summary.queued).toBe(0);
  });
});

