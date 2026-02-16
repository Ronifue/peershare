import { describe, expect, test } from "bun:test";
import {
  buildAdaptiveChunkPlan,
  chooseChunkSizeByRtt,
  clampChunkSizeByMaxMessageSize,
  normalizeMaxMessageSize
} from "../../src/client/adaptive-chunk";
import {
  bytesForChunkIndex,
  calculateTotalChunks,
  deriveFileChecksumFromChunkChecksums,
  normalizeChunkIndex
} from "../../src/client/transfer-integrity";
import {
  createRecoverableTransferError,
  isRecoverableTransferError
} from "../../src/client/transfer-recovery";

describe("adaptive-chunk", () => {
  test("maxMessageSize clamp works", () => {
    expect(normalizeMaxMessageSize(undefined)).toBeNull();
    expect(normalizeMaxMessageSize(0)).toBeNull();
    expect(normalizeMaxMessageSize(65536)).toBe(65536);
    expect(clampChunkSizeByMaxMessageSize(64 * 1024, 20 * 1024)).toBe(16 * 1024);
  });

  test("rtt based chunk choice degrades with higher rtt", () => {
    expect(chooseChunkSizeByRtt(64 * 1024, 40)).toBe(64 * 1024);
    expect(chooseChunkSizeByRtt(64 * 1024, 120)).toBe(48 * 1024);
    expect(chooseChunkSizeByRtt(64 * 1024, 220)).toBe(32 * 1024);
    expect(chooseChunkSizeByRtt(64 * 1024, 400)).toBe(16 * 1024);
  });

  test("adaptive plan reports reason", () => {
    const byRtt = buildAdaptiveChunkPlan(64 * 1024, null, 200);
    expect(byRtt.chunkSize).toBe(32 * 1024);
    expect(byRtt.reason).toBe("rtt_adaptive");

    const byMessageSize = buildAdaptiveChunkPlan(64 * 1024, 18 * 1024, 20);
    expect(byMessageSize.chunkSize).toBe(16 * 1024);
    expect(byMessageSize.reason).toBe("max_message_size");
  });
});

describe("transfer-integrity helpers", () => {
  test("chunk math helpers", () => {
    expect(calculateTotalChunks(10, 4)).toBe(3);
    expect(bytesForChunkIndex(2, 4, 10)).toBe(8);
    expect(bytesForChunkIndex(5, 4, 10)).toBe(10);
    expect(normalizeChunkIndex(-1, 100)).toBe(0);
    expect(normalizeChunkIndex(150, 100)).toBe(100);
    expect(normalizeChunkIndex(8.9, 100)).toBe(8);
  });

  test("derived checksum is deterministic", async () => {
    const a = await deriveFileChecksumFromChunkChecksums(["aa", "bb", "cc"]);
    const b = await deriveFileChecksumFromChunkChecksums(["aa", "bb", "cc"]);
    const c = await deriveFileChecksumFromChunkChecksums(["aa", "bb", "dd"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("transfer-recovery helpers", () => {
  test("recoverable error type guard works", () => {
    const recoverable = createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "channel closed");
    expect(isRecoverableTransferError(recoverable)).toBe(true);
    expect(isRecoverableTransferError(new Error("plain error"))).toBe(false);
  });
});
