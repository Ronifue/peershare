/**
 * Bun Test - Utility Functions
 * Pure function tests for client utilities
 */

import { describe, test, expect } from "bun:test";
import { formatBytes } from "../../src/client/utils";

describe("formatBytes", () => {
  test("formats 0 bytes correctly", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  test("formats bytes correctly", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  test("formats kilobytes correctly", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10240)).toBe("10 KB");
  });

  test("formats megabytes correctly", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  test("formats gigabytes correctly", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  test("handles edge cases", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });
});
