#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const EVIDENCE_DIR = join(process.cwd(), ".sisyphus", "evidence");
const RELEASE_GATE_PATH = join(EVIDENCE_DIR, "task-8-release-gate.json");
const DOC_CONSISTENCY_REPORT_PATH = join(EVIDENCE_DIR, "doc-consistency-report.json");
const TASK7_REGRESSION_REPORT_PATH = join(EVIDENCE_DIR, "task-7-regression-report.json");
const TASK7_PERF_DIFF_PATH = join(EVIDENCE_DIR, "task-7-performance-diff.json");

type Verdict = "passed" | "failed";

type CommandResult = {
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  verdict: Verdict;
};

type GateStatus = {
  name: string;
  command: string;
  status: "completed" | "inherited" | "failed";
  exitCode: number;
  verdict: Verdict;
  evidence?: string;
  notes?: string;
  metrics?: Record<string, unknown>;
  checks?: Record<string, unknown>;
};

type ReleaseGateReport = {
  runId: string;
  timestamp: string;
  evidencePath: string;
  version: string;
  gates: {
    build: GateStatus;
    typecheck: GateStatus;
    unitTest: GateStatus;
    e2eRegression: GateStatus;
    performanceGate: GateStatus;
    resumeAdaptiveE2E: GateStatus;
    docConsistency: GateStatus;
  };
  blockingGates: string[];
  warningGates: string[];
  commands: Record<string, CommandResult>;
  summary: {
    totalGates: number;
    passed: number;
    failed: number;
    warnings: number;
  };
  verdict: {
    READY_FOR_RELEASE: boolean;
    reason: string;
  };
};

function runCommand(command: string, args: string[]): CommandResult {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    shell: false
  });
  const finished = Date.now();
  const exitCode = result.status ?? (result.error ? 127 : 1);

  return {
    command,
    args,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode,
    verdict: exitCode === 0 ? "passed" : "failed"
  };
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function createGateStatus(name: string, command: string, result: CommandResult): GateStatus {
  return {
    name,
    command,
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    verdict: result.exitCode === 0 ? "passed" : "failed"
  };
}

function writeReport(report: ReleaseGateReport): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(RELEASE_GATE_PATH, JSON.stringify(report, null, 2));
}

function toMetricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildReleaseReport(): ReleaseGateReport {
  const buildResult = runCommand("bun", ["run", "build"]);
  const typecheckResult = runCommand("bun", ["run", "typecheck"]);
  const unitResult = runCommand("bun", ["test"]);
  const acceptanceResult = runCommand("bun", ["run", "task7:acceptance"]);
  const resumeAdaptiveResult = runCommand("bun", ["run", "test:e2e", "--", "e2e/task-8-resume-adaptive.e2e.ts"]);
  const docsResult = runCommand("bun", ["run", "docs:consistency"]);

  const perfDiff = readJsonFile(TASK7_PERF_DIFF_PATH) as
    | { verdict?: { passed?: unknown }; metrics?: { cpuIdleWaitReductionPct?: unknown; reconnectRecoveryMs?: unknown } }
    | null;
  const regressionReport = readJsonFile(TASK7_REGRESSION_REPORT_PATH) as
    | { verdict?: { passed?: unknown } }
    | null;
  const docReport = readJsonFile(DOC_CONSISTENCY_REPORT_PATH) as
    | { summary?: { total?: unknown; passed?: unknown; failed?: unknown }; verdict?: { passed?: unknown } }
    | null;

  const buildGate = createGateStatus("TypeScript Build", "bun run build", buildResult);
  const typecheckGate = createGateStatus("TypeScript Typecheck", "bun run typecheck", typecheckResult);
  const unitGate = createGateStatus("Unit Tests", "bun test", unitResult);

  const e2ePassed =
    acceptanceResult.exitCode === 0 &&
    regressionReport?.verdict &&
    regressionReport.verdict.passed === true;
  const e2eGate: GateStatus = {
    name: "E2E Regression",
    command: "bun run task7:acceptance",
    status: e2ePassed ? "inherited" : "failed",
    exitCode: acceptanceResult.exitCode,
    verdict: e2ePassed ? "passed" : "failed",
    evidence: TASK7_REGRESSION_REPORT_PATH,
    notes: e2ePassed ? "Inherited from Task7 regression report" : "Task7 regression failed"
  };

  const perfPassed =
    acceptanceResult.exitCode === 0 &&
    perfDiff?.verdict &&
    perfDiff.verdict.passed === true;
  const perfGate: GateStatus = {
    name: "Performance Gate",
    command: "bun run task7:acceptance",
    status: perfPassed ? "inherited" : "failed",
    exitCode: acceptanceResult.exitCode,
    verdict: perfPassed ? "passed" : "failed",
    evidence: TASK7_PERF_DIFF_PATH,
    metrics: {
      cpuIdleWaitReductionPct: toMetricValue(perfDiff?.metrics?.cpuIdleWaitReductionPct),
      reconnectRecoveryMs: toMetricValue(perfDiff?.metrics?.reconnectRecoveryMs)
    }
  };

  const resumeAdaptiveGate = createGateStatus(
    "Resume + Adaptive E2E",
    "bun run test:e2e -- e2e/task-8-resume-adaptive.e2e.ts",
    resumeAdaptiveResult
  );
  resumeAdaptiveGate.evidence = ".sisyphus/evidence/playwright-results.json";

  const docPassed =
    docsResult.exitCode === 0 &&
    docReport?.verdict &&
    docReport.verdict.passed === true;
  const docGate: GateStatus = {
    name: "Documentation Consistency",
    command: "bun run docs:consistency",
    status: docPassed ? "completed" : "failed",
    exitCode: docsResult.exitCode,
    verdict: docPassed ? "passed" : "failed",
    evidence: DOC_CONSISTENCY_REPORT_PATH,
    checks: {
      total: toMetricValue(docReport?.summary?.total),
      passed: toMetricValue(docReport?.summary?.passed),
      failed: toMetricValue(docReport?.summary?.failed)
    }
  };

  const blockingGates = ["build", "typecheck", "unitTest", "e2eRegression", "performanceGate", "resumeAdaptiveE2E", "docConsistency"];
  const warningGates: string[] = [];
  const gates = {
    build: buildGate,
    typecheck: typecheckGate,
    unitTest: unitGate,
    e2eRegression: e2eGate,
    performanceGate: perfGate,
    resumeAdaptiveE2E: resumeAdaptiveGate,
    docConsistency: docGate
  };

  const failedBlocking = blockingGates.filter((key) => gates[key as keyof typeof gates].verdict !== "passed");
  const allPassed = failedBlocking.length === 0;
  const passedCount = Object.values(gates).filter((gate) => gate.verdict === "passed").length;
  const failedCount = Object.values(gates).filter((gate) => gate.verdict === "failed").length;

  return {
    runId: `task8-release-gate-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: RELEASE_GATE_PATH,
    version: "1.0.0",
    gates,
    blockingGates,
    warningGates,
    commands: {
      build: buildResult,
      typecheck: typecheckResult,
      unitTest: unitResult,
      task7Acceptance: acceptanceResult,
      resumeAdaptiveE2E: resumeAdaptiveResult,
      docsConsistency: docsResult
    },
    summary: {
      totalGates: Object.keys(gates).length,
      passed: passedCount,
      failed: failedCount,
      warnings: warningGates.filter((key) => gates[key as keyof typeof gates].verdict !== "passed").length
    },
    verdict: {
      READY_FOR_RELEASE: allPassed,
      reason: allPassed ? "all_blocking_gates_passed" : `blocking_failed:${failedBlocking.join(",")}`
    }
  };
}

try {
  const report = buildReleaseReport();
  writeReport(report);
  process.exit(report.verdict.READY_FOR_RELEASE ? 0 : 1);
} catch (error) {
  const fallback: ReleaseGateReport = {
    runId: `task8-release-gate-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: RELEASE_GATE_PATH,
    version: "1.0.0",
    gates: {
      build: { name: "TypeScript Build", command: "bun run build", status: "failed", exitCode: 99, verdict: "failed" },
      typecheck: { name: "TypeScript Typecheck", command: "bun run typecheck", status: "failed", exitCode: 99, verdict: "failed" },
      unitTest: { name: "Unit Tests", command: "bun test", status: "failed", exitCode: 99, verdict: "failed" },
      e2eRegression: { name: "E2E Regression", command: "bun run task7:acceptance", status: "failed", exitCode: 99, verdict: "failed" },
      performanceGate: { name: "Performance Gate", command: "bun run task7:acceptance", status: "failed", exitCode: 99, verdict: "failed" },
      resumeAdaptiveE2E: { name: "Resume + Adaptive E2E", command: "bun run test:e2e -- e2e/task-8-resume-adaptive.e2e.ts", status: "failed", exitCode: 99, verdict: "failed" },
      docConsistency: { name: "Documentation Consistency", command: "bun run docs:consistency", status: "failed", exitCode: 99, verdict: "failed" }
    },
    blockingGates: ["build", "typecheck", "unitTest", "e2eRegression", "performanceGate", "resumeAdaptiveE2E", "docConsistency"],
    warningGates: [],
    commands: {},
    summary: {
      totalGates: 7,
      passed: 0,
      failed: 7,
      warnings: 0
    },
    verdict: {
      READY_FOR_RELEASE: false,
      reason: `fatal:${error instanceof Error ? error.message : String(error)}`
    }
  };
  writeReport(fallback);
  process.exit(2);
}
