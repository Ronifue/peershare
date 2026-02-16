#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const EVIDENCE_DIR = join(process.cwd(), ".sisyphus", "evidence");
const REPORT_PATH = join(EVIDENCE_DIR, "doc-consistency-report.json");
const DOC_PATHS = ["OPTIMIZATION_GUIDE.md", "AGENTS.md", "PROGRESS.md"] as const;
const CLIENT_SOURCE_DIR = join(process.cwd(), "src", "client");

type CheckResult = {
  id: string;
  description: string;
  passed: boolean;
  details: string[];
};

type DocConsistencyReport = {
  runId: string;
  timestamp: string;
  evidencePath: string;
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  verdict: {
    passed: boolean;
    failedChecks: string[];
  };
};

function readText(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8");
}

function getAllFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...getAllFiles(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function checkTurnConstraints(docTexts: Map<string, string>): CheckResult {
  const required = [/不引入\s*TURN/i, /不启用\s*TURN/i, /STUN-only/i, /不规划\s*TURN/i];
  const details: string[] = [];

  for (const path of DOC_PATHS) {
    const text = docTexts.get(path) ?? "";
    const matched = required.some((pattern) => pattern.test(text));
    if (!matched) {
      details.push(`${path}: 缺少“禁用 TURN”约束描述`);
    }
  }

  return {
    id: "no-turn-constraint",
    description: "文档必须明确不引入 TURN",
    passed: details.length === 0,
    details
  };
}

function checkRebuildPrimaryConstraints(docTexts: Map<string, string>): CheckResult {
  const required = [/销毁重建.*主路径/i, /重建为主路径/i, /重建主路径/i, /rebuild.*主路径/i];
  const details: string[] = [];

  for (const path of DOC_PATHS) {
    const text = docTexts.get(path) ?? "";
    const matched = required.some((pattern) => pattern.test(text));
    if (!matched) {
      details.push(`${path}: 缺少“销毁重建主路径”约束描述`);
    }
  }

  return {
    id: "rebuild-primary-constraint",
    description: "文档必须声明重连策略以销毁重建为主路径",
    passed: details.length === 0,
    details
  };
}

function checkTurnConflictingStatements(docTexts: Map<string, string>): CheckResult {
  const safeTokens = ["不引入", "不启用", "不纳入", "非目标", "约束", "成本"];
  const details: string[] = [];

  for (const path of DOC_PATHS) {
    const text = docTexts.get(path) ?? "";
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const normalized = line.trim();
      if (!normalized.includes("TURN")) {
        return;
      }

      if (safeTokens.some((token) => normalized.includes(token))) {
        return;
      }

      const hasConflictClaim = /启用\s*TURN/i.test(normalized) || /引入\s*TURN/i.test(normalized);
      if (hasConflictClaim) {
        details.push(`${path}:${index + 1} 存在潜在冲突表述 -> ${normalized}`);
      }
    });
  }

  return {
    id: "no-turn-conflict",
    description: "文档不能出现与“禁用 TURN”冲突的正向描述",
    passed: details.length === 0,
    details
  };
}

function checkClientRandomUuidUsage(): CheckResult {
  const details: string[] = [];

  if (!existsSync(CLIENT_SOURCE_DIR)) {
    details.push("src/client 目录不存在");
    return {
      id: "no-client-randomuuid",
      description: "客户端代码不能使用 crypto.randomUUID()",
      passed: false,
      details
    };
  }

  const files = getAllFiles(CLIENT_SOURCE_DIR).filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    if (/crypto\.randomUUID\s*\(/.test(text)) {
      details.push(file.replace(`${process.cwd()}\\`, ""));
    }
  }

  return {
    id: "no-client-randomuuid",
    description: "客户端代码不能使用 crypto.randomUUID()",
    passed: details.length === 0,
    details
  };
}

function writeReport(report: DocConsistencyReport): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

function runDocConsistencyCheck(): void {
  const docTexts = new Map<string, string>();
  for (const path of DOC_PATHS) {
    docTexts.set(path, readText(path));
  }

  const checks: CheckResult[] = [
    checkTurnConstraints(docTexts),
    checkRebuildPrimaryConstraints(docTexts),
    checkTurnConflictingStatements(docTexts),
    checkClientRandomUuidUsage()
  ];

  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id);
  const report: DocConsistencyReport = {
    runId: `docs-consistency-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: REPORT_PATH,
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length
    },
    verdict: {
      passed: failedChecks.length === 0,
      failedChecks
    }
  };

  writeReport(report);

  if (failedChecks.length > 0) {
    console.error("[DocConsistency] Failed checks:", failedChecks.join(", "));
    for (const check of checks.filter((item) => !item.passed)) {
      console.error(`[DocConsistency] ${check.id}`);
      check.details.forEach((detail) => console.error(`  - ${detail}`));
    }
    process.exit(1);
  }

  console.log("[DocConsistency] All checks passed");
}

try {
  runDocConsistencyCheck();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const report: DocConsistencyReport = {
    runId: `docs-consistency-${Date.now()}`,
    timestamp: new Date().toISOString(),
    evidencePath: REPORT_PATH,
    checks: [],
    summary: { total: 0, passed: 0, failed: 1 },
    verdict: {
      passed: false,
      failedChecks: ["runner-fatal"]
    }
  };

  writeReport(report);
  console.error("[DocConsistency] Fatal error:", message);
  process.exit(1);
}
