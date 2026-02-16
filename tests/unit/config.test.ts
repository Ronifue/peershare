/**
 * Bun Test - Configuration Tests
 * Verifies config constants and file transmission parameters
 */

import { describe, test, expect } from "bun:test";
import {
  FILE_CONFIG,
  SELECTED_STUN_SERVERS,
  ICE_SERVERS,
  DEFAULT_RTC_CONFIG,
} from "../../src/common/config";

describe("FILE_CONFIG", () => {
  test("CHUNK_SIZE is 64KB", () => {
    expect(FILE_CONFIG.CHUNK_SIZE).toBe(64 * 1024);
  });

  test("MAX_BUFFERED_AMOUNT is 12MB", () => {
    expect(FILE_CONFIG.MAX_BUFFERED_AMOUNT).toBe(12 * 1024 * 1024);
  });

  test("CONNECTION_TIMEOUT is 30 seconds", () => {
    expect(FILE_CONFIG.CONNECTION_TIMEOUT).toBe(30000);
  });

  test("SIGNALING_TIMEOUT is 10 seconds", () => {
    expect(FILE_CONFIG.SIGNALING_TIMEOUT).toBe(10000);
  });
});

describe("SELECTED_STUN_SERVERS", () => {
  test("contains at least 4 STUN servers", () => {
    expect(SELECTED_STUN_SERVERS.length).toBeGreaterThanOrEqual(4);
  });

  test("all servers have valid format", () => {
    for (const server of SELECTED_STUN_SERVERS) {
      expect(server).toMatch(/^[a-z0-9.-]+:\d+$/i);
    }
  });

  test("server list has no duplicates and keeps domain diversity", () => {
    const hosts = SELECTED_STUN_SERVERS.map((server) => server.split(":")[0].toLowerCase());
    const uniqueHosts = new Set(hosts);
    expect(uniqueHosts.size).toBe(hosts.length);

    const domainFamilies = new Set(
      hosts.map((host) => {
        const parts = host.split(".");
        return parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : host;
      })
    );
    expect(domainFamilies.size).toBeGreaterThanOrEqual(2);
  });
});

describe("ICE_SERVERS", () => {
  test("has at least one ICE server configuration", () => {
    expect(ICE_SERVERS.length).toBeGreaterThanOrEqual(1);
  });

  test("first server contains STUN URLs", () => {
    const firstServer = ICE_SERVERS[0];
    expect(firstServer.urls).toBeDefined();
    expect(Array.isArray(firstServer.urls)).toBe(true);
    expect(firstServer.urls.length).toBeGreaterThan(0);
    for (const url of firstServer.urls) {
      expect(typeof url).toBe("string");
      expect(url.startsWith("stun:")).toBe(true);
    }
  });
});

describe("DEFAULT_RTC_CONFIG", () => {
  test("has valid iceCandidatePoolSize", () => {
    expect(DEFAULT_RTC_CONFIG.iceCandidatePoolSize).toBe(10);
  });

  test("uses all transport policy", () => {
    expect(DEFAULT_RTC_CONFIG.iceTransportPolicy).toBe("all");
  });

  test("uses max-bundle policy", () => {
    expect(DEFAULT_RTC_CONFIG.bundlePolicy).toBe("max-bundle");
  });

  test("requires RTCP mux", () => {
    expect(DEFAULT_RTC_CONFIG.rtcpMuxPolicy).toBe("require");
  });

  test("has ICE servers configured", () => {
    expect(DEFAULT_RTC_CONFIG.iceServers).toBeDefined();
    expect(DEFAULT_RTC_CONFIG.iceServers.length).toBeGreaterThan(0);
  });
});
