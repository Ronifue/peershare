#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const EVIDENCE_DIR = join(process.cwd(), ".sisyphus", "evidence");
const BASELINE_PATH = join(EVIDENCE_DIR, "task-0-baseline.json");
const CURRENT_PATH = join(EVIDENCE_DIR, "task-7-regression-metrics.json");
const REPORT_PATH = join(EVIDENCE_DIR, "task-7-performance-diff.json");

const THRESHOLDS = {
  cpuIdleWaitReductionPctMin: 15,
  reconnectRecoveryMsMax: 15000
} as const;

const EXIT_CODES = {
  success: 0,
  baselineMissing: 10,
  baselineInvalid: 11,
  currentMissing: 12,
  currentInvalid: 13,
  thresholdFailed: 20,
  fatal: 99
} as const;

type GateVerdict = {
  metric: string;
  operator: ">=" | "<=";
  threshold: number;
  actual: number | null;
  passed: boolean;
};

type CpuIdleMetricSource = "pollingIdleWaitMs" | "backpressureWaitMs";
const BASELINE_SELECTION_TAGS = ["task7:baseline-candidate", "size:100mb", "network:normal"];

type PerformanceDiffReport = {
  runId: string;
  timestamp: string;
  evidencePath: string;
  inputs: {
    baselinePath: string;
    baselineExists: boolean;
    currentPath: string;
    currentExists: boolean;
  };
  thresholds: {
    cpuIdleWaitReductionPctMin: number;
    reconnectRecoveryMsMax: number;
  };
  comparison: {
    baselineScenario: string | null;
    baselineScenarioId: string | null;
    baselineScenarioTags: string[] | null;
    baselineBackpressureWaitMs: number | null;
    baselinePollingIdleWaitMs: number | null;
    currentScenario: string | null;
    currentBackpressureWaitMs: number | null;
    currentPollingIdleWaitMs: number | null;
    cpuIdleMetricSource: CpuIdleMetricSource | null;
    reconnectRecoveryMs: number | null;
  };
  metrics: {
    cpuIdleWaitReductionPct: number | null;
    reconnectRecoveryMs: number | null;
  };
  verdicts: {
    cpuIdleWaitReductionPct: GateVerdict;
    reconnectRecoveryMs: GateVerdict;
  };
  verdict: {
    status: "passed" | "failed" | "error";
    passed: boolean;
    failedGates: string[];
    errorCode: string | null;
    errorMessage: string | null;
  };
  exitCode: number;
};

type BaselineResultRecord = {
  scenario?: unknown;
  scenarioId?: unknown;
  scenarioTags?: unknown;
  metrics?: {
    status?: unknown;
    backpressureWaitMs?: unknown;
    pollingIdleWaitMs?: unknown;
  };
};

function createEmptyReport(): PerformanceDiffReport {
  return {
    runId: `task7-performance-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: REPORT_PATH,
    inputs: {
      baselinePath: BASELINE_PATH,
      baselineExists: existsSync(BASELINE_PATH),
      currentPath: CURRENT_PATH,
      currentExists: existsSync(CURRENT_PATH)
    },
    thresholds: {
      cpuIdleWaitReductionPctMin: THRESHOLDS.cpuIdleWaitReductionPctMin,
      reconnectRecoveryMsMax: THRESHOLDS.reconnectRecoveryMsMax
    },
    comparison: {
      baselineScenario: null,
      baselineScenarioId: null,
      baselineScenarioTags: null,
      baselineBackpressureWaitMs: null,
      baselinePollingIdleWaitMs: null,
      currentScenario: null,
      currentBackpressureWaitMs: null,
      currentPollingIdleWaitMs: null,
      cpuIdleMetricSource: null,
      reconnectRecoveryMs: null
    },
    metrics: {
      cpuIdleWaitReductionPct: null,
      reconnectRecoveryMs: null
    },
    verdicts: {
      cpuIdleWaitReductionPct: {
        metric: "cpuIdleWaitReductionPct",
        operator: ">=",
        threshold: THRESHOLDS.cpuIdleWaitReductionPctMin,
        actual: null,
        passed: false
      },
      reconnectRecoveryMs: {
        metric: "reconnectRecoveryMs",
        operator: "<=",
        threshold: THRESHOLDS.reconnectRecoveryMsMax,
        actual: null,
        passed: false
      }
    },
    verdict: {
      status: "error",
      passed: false,
      failedGates: [],
      errorCode: null,
      errorMessage: null
    },
    exitCode: EXIT_CODES.fatal
  };
}

function writeReport(report: PerformanceDiffReport): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

function parseJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as unknown;
}

function selectBaselineResult(results: BaselineResultRecord[]): BaselineResultRecord | null {
  const successRecords = results.filter((item) => item.metrics?.status === "success");
  if (successRecords.length === 0) {
    return null;
  }

  const preferred = successRecords.find((item) => {
    if (!Array.isArray(item.scenarioTags)) {
      return false;
    }

    const tags = item.scenarioTags.filter((tag): tag is string => typeof tag === "string");
    return BASELINE_SELECTION_TAGS.every((tag) => tags.includes(tag));
  });

  return preferred ?? successRecords[0] ?? null;
}

function getBaselineBackpressureWaitMs(data: unknown): {
  scenario: string;
  scenarioId: string;
  scenarioTags: string[];
  backpressureWaitMs: number;
  pollingIdleWaitMs: number | null;
} {
  if (!data || typeof data !== "object") {
    throw new Error("Baseline evidence is not an object");
  }

  const candidate = data as { results?: unknown };
  if (!Array.isArray(candidate.results)) {
    throw new Error("Baseline evidence missing results array");
  }

  const selected = selectBaselineResult(candidate.results as BaselineResultRecord[]);
  if (!selected) {
    throw new Error("Baseline evidence has no successful scenario");
  }

  const scenario = selected.scenario;
  const scenarioId = selected.scenarioId;
  const scenarioTags = selected.scenarioTags;
  const backpressureWaitMs = selected.metrics?.backpressureWaitMs;
  if (typeof scenario !== "string" || !scenario) {
    throw new Error("Baseline scenario is invalid");
  }
  if (typeof scenarioId !== "string" || !scenarioId) {
    throw new Error("Baseline scenarioId is invalid");
  }
  if (!Array.isArray(scenarioTags) || scenarioTags.some((tag) => typeof tag !== "string")) {
    throw new Error("Baseline scenarioTags is invalid");
  }

  if (typeof backpressureWaitMs !== "number" || !Number.isFinite(backpressureWaitMs) || backpressureWaitMs <= 0) {
    throw new Error("Baseline backpressureWaitMs must be a finite number greater than 0");
  }

  const pollingIdleWaitMs = selected.metrics?.pollingIdleWaitMs;
  return {
    scenario,
    scenarioId,
    scenarioTags: [...scenarioTags],
    backpressureWaitMs,
    pollingIdleWaitMs:
      typeof pollingIdleWaitMs === "number" && Number.isFinite(pollingIdleWaitMs) && pollingIdleWaitMs >= 0
        ? pollingIdleWaitMs
        : null
  };
}

function getCurrentMetrics(data: unknown): {
  scenario: string;
  backpressureWaitMs: number;
  pollingIdleWaitMs: number | null;
  reconnectRecoveryMs: number;
} {
  if (!data || typeof data !== "object") {
    throw new Error("Current regression metrics are not an object");
  }

  const candidate = data as {
    scenario?: unknown;
    transfer?: { backpressureWaitMs?: unknown; pollingIdleWaitMs?: unknown };
    reconnect?: { reconnectRecoveryMs?: unknown };
  };

  if (typeof candidate.scenario !== "string" || !candidate.scenario) {
    throw new Error("Current regression metrics missing scenario");
  }

  const backpressureWaitMs = candidate.transfer?.backpressureWaitMs;
  if (typeof backpressureWaitMs !== "number" || !Number.isFinite(backpressureWaitMs) || backpressureWaitMs < 0) {
    throw new Error("Current transfer.backpressureWaitMs must be a finite number >= 0");
  }

  const reconnectRecoveryMs = candidate.reconnect?.reconnectRecoveryMs;
  if (typeof reconnectRecoveryMs !== "number" || !Number.isFinite(reconnectRecoveryMs) || reconnectRecoveryMs < 0) {
    throw new Error("Current reconnect.reconnectRecoveryMs must be a finite number >= 0");
  }

  const pollingIdleWaitMs = candidate.transfer?.pollingIdleWaitMs;

  return {
    scenario: candidate.scenario,
    backpressureWaitMs,
    pollingIdleWaitMs:
      typeof pollingIdleWaitMs === "number" && Number.isFinite(pollingIdleWaitMs) && pollingIdleWaitMs >= 0
        ? pollingIdleWaitMs
        : null,
    reconnectRecoveryMs
  };
}

function selectCpuIdleMetricSource(
  baselineMetrics: { backpressureWaitMs: number; pollingIdleWaitMs: number | null },
  currentMetrics: { backpressureWaitMs: number; pollingIdleWaitMs: number | null }
): { source: CpuIdleMetricSource; baselineValue: number; currentValue: number } {
  if (
    baselineMetrics.pollingIdleWaitMs !== null &&
    currentMetrics.pollingIdleWaitMs !== null &&
    baselineMetrics.pollingIdleWaitMs > 0
  ) {
    return {
      source: "pollingIdleWaitMs",
      baselineValue: baselineMetrics.pollingIdleWaitMs,
      currentValue: currentMetrics.pollingIdleWaitMs
    };
  }

  return {
    source: "backpressureWaitMs",
    baselineValue: baselineMetrics.backpressureWaitMs,
    currentValue: currentMetrics.backpressureWaitMs
  };
}

function finalizeError(
  report: PerformanceDiffReport,
  errorCode: string,
  errorMessage: string,
  exitCode: number
): PerformanceDiffReport {
  report.verdict = {
    status: "error",
    passed: false,
    failedGates: [],
    errorCode,
    errorMessage
  };
  report.exitCode = exitCode;
  return report;
}

function runDiff(): void {
  const report = createEmptyReport();

  if (!existsSync(BASELINE_PATH)) {
    writeReport(finalizeError(report, "BASELINE_MISSING", `Missing baseline evidence: ${BASELINE_PATH}`, EXIT_CODES.baselineMissing));
    process.exit(EXIT_CODES.baselineMissing);
  }

  if (!existsSync(CURRENT_PATH)) {
    writeReport(finalizeError(report, "CURRENT_METRICS_MISSING", `Missing current metrics evidence: ${CURRENT_PATH}`, EXIT_CODES.currentMissing));
    process.exit(EXIT_CODES.currentMissing);
  }

  let baselineMetrics: {
    scenario: string;
    scenarioId: string;
    scenarioTags: string[];
    backpressureWaitMs: number;
    pollingIdleWaitMs: number | null;
  };
  let currentMetrics: { scenario: string; backpressureWaitMs: number; pollingIdleWaitMs: number | null; reconnectRecoveryMs: number };

  try {
    baselineMetrics = getBaselineBackpressureWaitMs(parseJsonFile(BASELINE_PATH));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeReport(finalizeError(report, "BASELINE_INVALID", message, EXIT_CODES.baselineInvalid));
    process.exit(EXIT_CODES.baselineInvalid);
    return;
  }

  try {
    currentMetrics = getCurrentMetrics(parseJsonFile(CURRENT_PATH));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeReport(finalizeError(report, "CURRENT_METRICS_INVALID", message, EXIT_CODES.currentInvalid));
    process.exit(EXIT_CODES.currentInvalid);
    return;
  }

  const cpuIdleMetric = selectCpuIdleMetricSource(baselineMetrics, currentMetrics);
  const cpuIdleWaitReductionPct =
    ((cpuIdleMetric.baselineValue - cpuIdleMetric.currentValue) / cpuIdleMetric.baselineValue) * 100;
  const roundedCpuIdleWaitReductionPct = Math.round(cpuIdleWaitReductionPct * 100) / 100;
  const reconnectRecoveryMs = currentMetrics.reconnectRecoveryMs;

  report.comparison = {
    baselineScenario: baselineMetrics.scenario,
    baselineScenarioId: baselineMetrics.scenarioId,
    baselineScenarioTags: baselineMetrics.scenarioTags,
    baselineBackpressureWaitMs: baselineMetrics.backpressureWaitMs,
    baselinePollingIdleWaitMs: baselineMetrics.pollingIdleWaitMs,
    currentScenario: currentMetrics.scenario,
    currentBackpressureWaitMs: currentMetrics.backpressureWaitMs,
    currentPollingIdleWaitMs: currentMetrics.pollingIdleWaitMs,
    cpuIdleMetricSource: cpuIdleMetric.source,
    reconnectRecoveryMs
  };

  report.metrics = {
    cpuIdleWaitReductionPct: roundedCpuIdleWaitReductionPct,
    reconnectRecoveryMs
  };

  report.verdicts.cpuIdleWaitReductionPct.actual = roundedCpuIdleWaitReductionPct;
  report.verdicts.cpuIdleWaitReductionPct.passed =
    roundedCpuIdleWaitReductionPct >= THRESHOLDS.cpuIdleWaitReductionPctMin;

  report.verdicts.reconnectRecoveryMs.actual = reconnectRecoveryMs;
  report.verdicts.reconnectRecoveryMs.passed = reconnectRecoveryMs <= THRESHOLDS.reconnectRecoveryMsMax;

  const failedGates: string[] = [];
  if (!report.verdicts.cpuIdleWaitReductionPct.passed) {
    failedGates.push("cpuIdleWaitReductionPct");
  }
  if (!report.verdicts.reconnectRecoveryMs.passed) {
    failedGates.push("reconnectRecoveryMs");
  }

  const passed = failedGates.length === 0;
  report.verdict = {
    status: passed ? "passed" : "failed",
    passed,
    failedGates,
    errorCode: null,
    errorMessage: null
  };
  report.exitCode = passed ? EXIT_CODES.success : EXIT_CODES.thresholdFailed;

  writeReport(report);
  process.exit(report.exitCode);
}

try {
  runDiff();
} catch (error) {
  const report = createEmptyReport();
  const message = error instanceof Error ? error.message : String(error);
  writeReport(finalizeError(report, "RUNNER_FATAL", message, EXIT_CODES.fatal));
  console.error("[Task7 Performance Diff] Fatal error:", error);
  process.exit(EXIT_CODES.fatal);
}
