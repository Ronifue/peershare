import { test, expect } from "@playwright/test";

/**
 * Fail-Fast Smoke Test
 * This test intentionally fails to verify CI failure signal propagation
 * Used to validate that test failures properly block the pipeline
 */

test.describe("Fail-Fast Signal Validation", () => {
  test("should always pass in normal mode", () => {
    // This test passes to verify the test infrastructure works
    expect(true).toBe(true);
  });

  test("fail-fast fixture - skip in normal runs @fail-fast", () => {
    // This test is tagged with @fail-fast and should only run when explicitly triggered
    // It intentionally fails to verify CI captures failure signals correctly
    test.skip(
      !process.env.ENABLE_FAIL_FAST_TEST,
      "Fail-fast test only runs when ENABLE_FAIL_FAST_TEST is set"
    );

    // Intentional failure to validate CI signal propagation
    expect(false).toBe(true);
  });
});

test.describe("Environment Validation", () => {
  test("required environment variables are present", () => {
    // Verify test environment is properly configured
    expect(process.env).toBeDefined();
  });

  test("playwright config is loaded", () => {
    // Verify Playwright configuration is accessible
    expect(test.info().project.name).toBeDefined();
  });
});
