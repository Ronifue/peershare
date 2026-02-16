#!/usr/bin/env bun
import { createServer } from "net";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const EVIDENCE_DIR = join(process.cwd(), ".sisyphus", "evidence");
const REPORT_PATH = join(EVIDENCE_DIR, "task-7-regression-report.json");
const REGRESSION_METRICS_PATH = join(EVIDENCE_DIR, "task-7-regression-metrics.json");
const PLAYWRIGHT_RESULTS_PATH = join(EVIDENCE_DIR, "playwright-results.json");
const DOC_CONSISTENCY_REPORT_PATH = join(EVIDENCE_DIR, "doc-consistency-report.json");
const PREFERRED_BASELINE_PORTS = [3002, 3003, 3004, 3010];

type CommandVerdict = "passed" | "failed";
type EnvOverrides = Record<string, string>;

type CommandResult = {
  name: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  verdict: CommandVerdict;
};

type RegressionReport = {
  runId: string;
  timestamp: string;
  evidencePath: string;
  runtime: {
    baselinePort: number | null;
  };
  commands: CommandResult[];
  artifacts: {
    playwrightResultsPath: string;
    playwrightResultsExists: boolean;
    regressionMetricsPath: string;
    regressionMetricsExists: boolean;
    docConsistencyReportPath: string;
    docConsistencyReportExists: boolean;
  };
  verdict: {
    passed: boolean;
    failedCommands: string[];
  };
  exitCode: number;
};

function runCommand(name: string, command: string, args: string[], envOverrides: EnvOverrides = {}): CommandResult {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
    shell: false
  });
  const finished = Date.now();
  const exitCode = result.status ?? (result.error ? 127 : 1);

  return {
    name,
    command,
    args,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode,
    verdict: exitCode === 0 ? "passed" : "failed"
  };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve ephemeral port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });

    server.listen(0, "127.0.0.1");
  });
}

async function resolveBaselinePort(): Promise<number> {
  for (const port of PREFERRED_BASELINE_PORTS) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  return allocateEphemeralPort();
}

function writeReport(report: RegressionReport): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

function buildReport(commands: CommandResult[], baselinePort: number | null): RegressionReport {
  const failedCommands = commands.filter((item) => item.verdict === "failed").map((item) => item.name);
  const passed = failedCommands.length === 0;

  return {
    runId: `task7-regression-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: REPORT_PATH,
    runtime: {
      baselinePort
    },
    commands,
    artifacts: {
      playwrightResultsPath: PLAYWRIGHT_RESULTS_PATH,
      playwrightResultsExists: existsSync(PLAYWRIGHT_RESULTS_PATH),
      regressionMetricsPath: REGRESSION_METRICS_PATH,
      regressionMetricsExists: existsSync(REGRESSION_METRICS_PATH),
      docConsistencyReportPath: DOC_CONSISTENCY_REPORT_PATH,
      docConsistencyReportExists: existsSync(DOC_CONSISTENCY_REPORT_PATH)
    },
    verdict: {
      passed,
      failedCommands
    },
    exitCode: passed ? 0 : 1
  };
}

async function runRegression(): Promise<void> {
  const baselinePort = await resolveBaselinePort();
  const commands: CommandResult[] = [];

  commands.push(runCommand("docs-consistency", "bun", ["run", "docs:consistency"]));
  commands.push(
    runCommand("fixtures-quick", "bun", ["run", "fixtures:generate"], {
      FIXTURE_QUICK: "1"
    })
  );
  commands.push(
    runCommand("baseline-polling", "bun", ["run", "baseline"], {
      PORT: String(baselinePort),
      BASELINE_QUICK: "1",
      BASELINE_BACKPRESSURE_MODE: "polling",
      BASELINE_MAX_BUFFERED_AMOUNT: String(64 * 1024 * 5),
      BASELINE_LOW_THRESHOLD: String(64 * 1024 * 2)
    })
  );
  commands.push(runCommand("bun-test", "bun", ["test"]));
  commands.push(
    runCommand("playwright-regression", "bun", [
      "run",
      "test:e2e",
      "--",
      "e2e/task-7-regression.e2e.ts"
    ])
  );

  const report = buildReport(commands, baselinePort);
  writeReport(report);
  process.exit(report.exitCode);
}

try {
  await runRegression();
} catch (error) {
  const report: RegressionReport = {
    runId: `task7-regression-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: REPORT_PATH,
    runtime: {
      baselinePort: null
    },
    commands: [],
    artifacts: {
      playwrightResultsPath: PLAYWRIGHT_RESULTS_PATH,
      playwrightResultsExists: existsSync(PLAYWRIGHT_RESULTS_PATH),
      regressionMetricsPath: REGRESSION_METRICS_PATH,
      regressionMetricsExists: existsSync(REGRESSION_METRICS_PATH),
      docConsistencyReportPath: DOC_CONSISTENCY_REPORT_PATH,
      docConsistencyReportExists: existsSync(DOC_CONSISTENCY_REPORT_PATH)
    },
    verdict: {
      passed: false,
      failedCommands: ["runner-fatal"]
    },
    exitCode: 2
  };

  writeReport(report);
  console.error("[Task7 Regression] Fatal error:", error);
  process.exit(2);
}
