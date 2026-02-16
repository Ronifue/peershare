#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

if (process.versions.bun) {
  const __filename = fileURLToPath(import.meta.url);
  const result = spawnSync('node', [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    shell: false
  });
  const exitCode = result.status ?? (result.error ? 127 : 1);
  process.exit(exitCode);
}

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import {
  parseStructuredEventFromConsoleText,
  type StructuredEventEnvelope
} from '../src/common/structured-event.ts';

const EVIDENCE_DIR = '.sisyphus/evidence';
const FIXTURES_DIR = 'fixtures';
const SERVER_PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3001;
const BASE_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_URL = `${BASE_URL}/healthz`;
const PEER_CONNECT_TIMEOUT_MS = 20000;
const PEER_CONNECT_MAX_ATTEMPTS = 2;

type BaselineBackpressureMode = 'event' | 'polling' | 'auto';
type NetworkProfile = 'normal' | 'weak';

interface BaselineScenario {
  id: string;
  name: string;
  file: string;
  network: NetworkProfile;
  sizeBytes: number;
  tags: string[];
}

const FULL_SCENARIO_MATRIX: BaselineScenario[] = [
  {
    id: 'size-100mb-network-normal',
    name: '100MB-normal',
    file: '100mb.bin',
    network: 'normal',
    sizeBytes: 100 * 1024 * 1024,
    tags: ['size:100mb', 'network:normal', 'task7:baseline-candidate']
  },
  {
    id: 'size-100mb-network-weak',
    name: '100MB-weak',
    file: '100mb.bin',
    network: 'weak',
    sizeBytes: 100 * 1024 * 1024,
    tags: ['size:100mb', 'network:weak']
  },
  {
    id: 'size-500mb-network-normal',
    name: '500MB-normal',
    file: '500mb.bin',
    network: 'normal',
    sizeBytes: 500 * 1024 * 1024,
    tags: ['size:500mb', 'network:normal']
  },
  {
    id: 'size-500mb-network-weak',
    name: '500MB-weak',
    file: '500mb.bin',
    network: 'weak',
    sizeBytes: 500 * 1024 * 1024,
    tags: ['size:500mb', 'network:weak']
  },
  {
    id: 'size-1gb-network-normal',
    name: '1GB-normal',
    file: '1gb.bin',
    network: 'normal',
    sizeBytes: 1024 * 1024 * 1024,
    tags: ['size:1gb', 'network:normal']
  },
  {
    id: 'size-1gb-network-weak',
    name: '1GB-weak',
    file: '1gb.bin',
    network: 'weak',
    sizeBytes: 1024 * 1024 * 1024,
    tags: ['size:1gb', 'network:weak']
  }
];

interface TransferMetrics {
  fileSizeBytes: number;
  transferMs: number;
  avgMbps: number;
  memoryPeakMB: number;
  reconnectMs: number | null;
  backpressureWaitMs: number;
  eventWaitMs: number | null;
  pollingIdleWaitMs: number | null;
  backpressureEvents: number;
  status: 'success' | 'failed';
  errorCode?: string;
}

interface BaselineResult {
  runId: string;
  timestamp: string;
  scenario: string;
  scenarioId: string;
  scenarioTags: string[];
  fileName: string;
  networkCondition: string;
  metrics: TransferMetrics;
  logs: string[];
}

interface BaselineReport {
  runId: string;
  timestamp: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    scenarios: string[];
  };
  results: BaselineResult[];
  matrix: {
    defined: string[];
    executed: string[];
  };
}

type TransferMetricsDraft = {
  fileSizeBytes?: number;
  transferMs?: number;
  avgMbps?: number;
  memoryPeakMB?: number;
  reconnectMs: number | null;
  backpressureWaitMs?: number;
  eventWaitMs?: number | null;
  pollingIdleWaitMs?: number | null;
  backpressureEvents?: number;
  status: 'success' | 'failed';
  errorCode?: string;
};

function generateRunId(): string {
  return `baseline-${Date.now()}`;
}

function parsePositiveIntegerEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }

  return String(Math.floor(parsed));
}

function resolveBaselineAppUrl(): string {
  const url = new URL(BASE_URL);
  const rawMode = process.env.BASELINE_BACKPRESSURE_MODE;

  if (rawMode) {
    const mode = rawMode.toLowerCase();
    if (mode !== 'event' && mode !== 'polling' && mode !== 'auto') {
      throw new Error(`Invalid BASELINE_BACKPRESSURE_MODE: ${rawMode}`);
    }

    url.searchParams.set('psBackpressureMode', mode as BaselineBackpressureMode);
  }

  const maxBufferedAmount = parsePositiveIntegerEnv('BASELINE_MAX_BUFFERED_AMOUNT');
  if (maxBufferedAmount) {
    url.searchParams.set('psMaxBufferedAmount', maxBufferedAmount);
  }

  const lowThreshold = parsePositiveIntegerEnv('BASELINE_LOW_THRESHOLD');
  if (lowThreshold) {
    url.searchParams.set('psLowThreshold', lowThreshold);
  }

  return url.toString();
}

function getScenariosToRun(): BaselineScenario[] {
  const envScenarios = process.env.BASELINE_SCENARIOS;
  const quickMode = process.env.BASELINE_QUICK === '1';

  if (quickMode) {
    return [FULL_SCENARIO_MATRIX[0]];
  }

  if (envScenarios === 'all') {
    return FULL_SCENARIO_MATRIX;
  }

  if (envScenarios) {
    const requested = envScenarios.split(',').map((item) => item.trim().toLowerCase());
    return FULL_SCENARIO_MATRIX.filter((item) => requested.includes(item.name.toLowerCase()) || requested.includes(item.id));
  }

  return [FULL_SCENARIO_MATRIX[0]];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  return asNumber(value);
}

function getPayloadNumber(
  event: StructuredEventEnvelope,
  key: string,
  required = false
): number | null {
  const value = asNumber(event.payload[key]);
  if (required && value === null) {
    throw new Error(`Structured event ${event.event} missing numeric payload: ${key}`);
  }
  return value;
}

function ensureRequiredNumber(name: string, value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing required metrics field: ${name}`);
  }
  return value;
}

function buildValidatedMetrics(draft: TransferMetricsDraft): TransferMetrics {
  if (draft.status === 'success') {
    return {
      fileSizeBytes: ensureRequiredNumber('fileSizeBytes', draft.fileSizeBytes),
      transferMs: ensureRequiredNumber('transferMs', draft.transferMs),
      avgMbps: ensureRequiredNumber('avgMbps', draft.avgMbps),
      memoryPeakMB: ensureRequiredNumber('memoryPeakMB', draft.memoryPeakMB),
      reconnectMs: draft.reconnectMs,
      backpressureWaitMs: ensureRequiredNumber('backpressureWaitMs', draft.backpressureWaitMs),
      eventWaitMs: draft.eventWaitMs ?? null,
      pollingIdleWaitMs: draft.pollingIdleWaitMs ?? null,
      backpressureEvents: ensureRequiredNumber('backpressureEvents', draft.backpressureEvents),
      status: 'success'
    };
  }

  return {
    fileSizeBytes: draft.fileSizeBytes ?? 0,
    transferMs: draft.transferMs ?? 0,
    avgMbps: draft.avgMbps ?? 0,
    memoryPeakMB: draft.memoryPeakMB ?? 0,
    reconnectMs: draft.reconnectMs,
    backpressureWaitMs: draft.backpressureWaitMs ?? 0,
    eventWaitMs: draft.eventWaitMs ?? null,
    pollingIdleWaitMs: draft.pollingIdleWaitMs ?? null,
    backpressureEvents: draft.backpressureEvents ?? 0,
    status: 'failed',
    errorCode: draft.errorCode ?? 'UNKNOWN_ERROR'
  };
}

async function waitFor<T>(
  resolveValue: () => T | null,
  timeoutMs: number,
  failureReason: string
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const value = resolveValue();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(failureReason);
}

function startServer(): ChildProcess {
  const server = spawn('bun', ['run', 'dev'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(SERVER_PORT)
    },
    shell: false
  });

  server.stderr?.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.log(`[Server] ${text}`);
    }
  });

  return server;
}

async function waitForServerHealth(server: ChildProcess, healthUrl: string, maxAttempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before healthy (exitCode=${server.exitCode})`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore connection errors and retry.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Server not healthy after ${maxAttempts} attempts: ${healthUrl}`);
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.killed || server.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    };

    server.once('exit', done);
    server.kill();

    setTimeout(() => {
      if (!finished) {
        server.kill('SIGKILL');
      }
    }, 3000);

    setTimeout(done, 5000);
  });
}

async function applyNetworkThrottling(page: Page, network: NetworkProfile): Promise<void> {
  if (network === 'normal') {
    return;
  }

  const client = await page.context().newCDPSession(page);
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: 125000,
    uploadThroughput: 62500,
    latency: 100
  });
}

async function createRoom(page: Page, appUrl: string): Promise<string> {
  await page.goto(appUrl);
  await page.getByTestId('create-room-button').click();
  await page.getByTestId('room-code-value').waitFor({ timeout: 10000 });
  const roomCode = (await page.getByTestId('room-code-value').textContent())?.trim() ?? '';

  if (!/^\d{6}$/.test(roomCode)) {
    throw new Error(`Invalid room code: ${roomCode}`);
  }

  return roomCode;
}

async function joinRoom(page: Page, appUrl: string, roomCode: string): Promise<void> {
  await page.goto(appUrl);
  await page.getByTestId('show-join-form-button').click();
  await page.getByTestId('join-room-input').fill(roomCode);
  await page.getByTestId('join-room-submit-button').click();
  await page.getByTestId('transfer-screen').waitFor({ timeout: 10000 });
}

async function rejoinRoomAfterReload(page: Page, appUrl: string, roomCode: string): Promise<void> {
  await page.reload();
  await page.getByTestId('show-join-form-button').click();
  await page.getByTestId('join-room-input').fill(roomCode);
  await page.getByTestId('join-room-submit-button').click();
  await page.getByTestId('transfer-screen').waitFor({ timeout: 15000 });
}

async function waitForPeerConnected(page: Page, timeoutMs: number = PEER_CONNECT_TIMEOUT_MS): Promise<void> {
  await page.getByTestId('p2p-status-direct').waitFor({ timeout: timeoutMs });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="p2p-status-direct"]');
    return Boolean(el && (el.textContent || '').includes('已建立'));
  }, undefined, { timeout: timeoutMs });
}

async function ensurePeersConnectedWithRetry(
  senderPage: Page,
  receiverPage: Page,
  appUrl: string,
  roomCode: string,
  logs: string[]
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
      logs.push(`[WARN] Peer connection attempt ${attempt} failed: ${lastError}`);
      if (attempt === PEER_CONNECT_MAX_ATTEMPTS) {
        break;
      }
      await rejoinRoomAfterReload(receiverPage, appUrl, roomCode);
    }
  }

  throw new Error(`Peer connection did not stabilize after ${PEER_CONNECT_MAX_ATTEMPTS} attempts: ${lastError ?? 'unknown'}`);
}

function collectStructuredLogs(
  page: Page,
  logs: string[],
  metricsDraft: TransferMetricsDraft,
  state: { transferSendCompleteSeen: boolean; transferReceiveCompleteSeen: boolean }
): void {
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    logs.push(text);

    const event = parseStructuredEventFromConsoleText(text);
    if (!event) {
      return;
    }

    if (event.event === 'transfer_send_complete') {
      metricsDraft.fileSizeBytes = getPayloadNumber(event, 'fileSizeBytes', true) ?? metricsDraft.fileSizeBytes;
      metricsDraft.transferMs = getPayloadNumber(event, 'transferMs', true) ?? metricsDraft.transferMs;
      metricsDraft.avgMbps = getPayloadNumber(event, 'avgMbps', true) ?? metricsDraft.avgMbps;
      metricsDraft.backpressureWaitMs = getPayloadNumber(event, 'backpressureWaitMs', true) ?? metricsDraft.backpressureWaitMs;
      metricsDraft.eventWaitMs = asNullableNumber(event.payload.eventWaitMs);
      metricsDraft.pollingIdleWaitMs = asNullableNumber(event.payload.pollingIdleWaitMs);
      metricsDraft.backpressureEvents = getPayloadNumber(event, 'backpressureEvents', true) ?? metricsDraft.backpressureEvents;
      state.transferSendCompleteSeen = true;
      return;
    }

    if (event.event === 'transfer_receive_complete') {
      metricsDraft.status = 'success';
      state.transferReceiveCompleteSeen = true;
    }
  });
}

async function runTransferScenario(
  browser: Browser,
  scenario: BaselineScenario,
  appUrl: string
): Promise<BaselineResult> {
  const logs: string[] = [];
  const runId = generateRunId();
  const metricsDraft: TransferMetricsDraft = {
    reconnectMs: null,
    status: 'failed'
  };
  const state = {
    transferSendCompleteSeen: false,
    transferReceiveCompleteSeen: false
  };

  const headless = process.env.BASELINE_HEADLESS !== '0';
  const contextOptions = headless ? {} : { viewport: { width: 1280, height: 720 } };

  const senderContext = await browser.newContext(contextOptions);
  const receiverContext = await browser.newContext(contextOptions);
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  collectStructuredLogs(senderPage, logs, metricsDraft, state);
  collectStructuredLogs(receiverPage, logs, metricsDraft, state);

  if (scenario.network === 'weak') {
    await applyNetworkThrottling(senderPage, scenario.network);
    await applyNetworkThrottling(receiverPage, scenario.network);
    logs.push('[NETWORK] Applied weak profile: 1Mbps down, 0.5Mbps up, 100ms latency');
  }

  try {
    const roomCode = await createRoom(senderPage, appUrl);
    await joinRoom(receiverPage, appUrl, roomCode);
    await ensurePeersConnectedWithRetry(senderPage, receiverPage, appUrl, roomCode, logs);

    const fixturePath = join(process.cwd(), FIXTURES_DIR, scenario.file);
    await senderPage.getByTestId('file-input').setInputFiles(fixturePath);

    const networkMultiplier = scenario.network === 'weak' ? 8 : 1;
    const timeoutMs = Math.max(60000, (scenario.sizeBytes / (1024 * 1024)) * 1000 * networkMultiplier);

    await waitFor(
      () => (state.transferSendCompleteSeen ? true : null),
      timeoutMs,
      'Timed out waiting for transfer_send_complete'
    );

    await waitFor(
      () => (state.transferReceiveCompleteSeen ? true : null),
      timeoutMs,
      'Timed out waiting for transfer_receive_complete'
    );

    const memoryPeakMB = await senderPage.evaluate(() => {
      if ('memory' in performance) {
        const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
        if (memory?.usedJSHeapSize) {
          return Math.round((memory.usedJSHeapSize / (1024 * 1024)) * 100) / 100;
        }
      }
      return 0;
    });
    metricsDraft.memoryPeakMB = memoryPeakMB;
  } catch (error) {
    metricsDraft.status = 'failed';
    metricsDraft.errorCode = error instanceof Error ? error.name : 'UNKNOWN_ERROR';
    logs.push(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }

  let metrics: TransferMetrics;
  try {
    metrics = buildValidatedMetrics(metricsDraft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logs.push(`[ERROR] Metrics validation failed: ${message}`);
    metrics = buildValidatedMetrics({
      ...metricsDraft,
      status: 'failed',
      errorCode: 'METRICS_VALIDATION_FAILED'
    });
  }

  return {
    runId,
    timestamp: new Date().toISOString(),
    scenario: scenario.name,
    scenarioId: scenario.id,
    scenarioTags: [...scenario.tags],
    fileName: scenario.file,
    networkCondition: scenario.network,
    metrics,
    logs
  };
}

function writeBaselineFailureReport(runId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const report: BaselineReport = {
    runId,
    timestamp: new Date().toISOString(),
    summary: {
      total: 0,
      passed: 0,
      failed: 1,
      scenarios: []
    },
    results: [
      {
        runId,
        timestamp: new Date().toISOString(),
        scenario: 'baseline-failure',
        scenarioId: 'baseline-failure',
        scenarioTags: ['fatal'],
        fileName: 'N/A',
        networkCondition: 'N/A',
        metrics: {
          fileSizeBytes: 0,
          transferMs: 0,
          avgMbps: 0,
          memoryPeakMB: 0,
          reconnectMs: null,
          backpressureWaitMs: 0,
          eventWaitMs: null,
          pollingIdleWaitMs: null,
          backpressureEvents: 0,
          status: 'failed',
          errorCode: error instanceof Error ? error.name : 'FATAL_ERROR'
        },
        logs: [message]
      }
    ],
    matrix: {
      defined: FULL_SCENARIO_MATRIX.map((item) => item.id),
      executed: []
    }
  };

  const failurePath = join(EVIDENCE_DIR, 'task-0-baseline-failure.json');
  writeFileSync(failurePath, JSON.stringify(report, null, 2));
}

async function runBaseline(): Promise<void> {
  if (!Number.isFinite(SERVER_PORT) || SERVER_PORT <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const runId = generateRunId();
  const appUrl = resolveBaselineAppUrl();
  const scenariosToRun = getScenariosToRun();

  if (!existsSync(EVIDENCE_DIR)) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  console.log(`[Baseline] Starting run: ${runId}`);
  console.log(`[Baseline] Target: ${BASE_URL}`);
  console.log(`[Baseline] Health URL: ${HEALTH_URL}`);
  console.log(`[Baseline] App URL: ${appUrl}`);
  console.log(`[Baseline] Scenarios: ${scenariosToRun.map((item) => item.id).join(', ')}`);
  console.log(`[Baseline] Full matrix: ${FULL_SCENARIO_MATRIX.map((item) => item.id).join(', ')}`);

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    server = startServer();
    await waitForServerHealth(server, HEALTH_URL);
    console.log('[Baseline] Server healthy');

    browser = await chromium.launch({ headless: process.env.BASELINE_HEADLESS !== '0' });
    console.log('[Baseline] Browser launched');

    const results: BaselineResult[] = [];
    for (const scenario of scenariosToRun) {
      console.log(`[Baseline] Running scenario: ${scenario.id}`);
      const result = await runTransferScenario(browser, scenario, appUrl);
      results.push(result);

      if (result.metrics.status === 'success') {
        console.log(
          `[Baseline] ${result.scenario}: success - ${result.metrics.transferMs}ms, ${result.metrics.avgMbps}Mbps`
        );
      } else {
        console.log(`[Baseline] ${result.scenario}: failed - ${result.metrics.errorCode ?? 'UNKNOWN_ERROR'}`);
      }
    }

    const report: BaselineReport = {
      runId,
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        passed: results.filter((item) => item.metrics.status === 'success').length,
        failed: results.filter((item) => item.metrics.status === 'failed').length,
        scenarios: results.map((item) => item.scenarioId)
      },
      results,
      matrix: {
        defined: FULL_SCENARIO_MATRIX.map((item) => item.id),
        executed: scenariosToRun.map((item) => item.id)
      }
    };

    const evidencePath = join(EVIDENCE_DIR, 'task-0-baseline.json');
    writeFileSync(evidencePath, JSON.stringify(report, null, 2));
    console.log(`[Baseline] Evidence written to: ${evidencePath}`);

    process.exit(report.summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('[Baseline] Fatal error:', error);
    writeBaselineFailureReport(runId, error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await stopServer(server);
    }
  }
}

runBaseline();
