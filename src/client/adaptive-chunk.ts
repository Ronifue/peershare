/**
 * PeerShare - 自适应分块与候选路径观测
 *
 * 目标：
 * 1) 分块大小受 maxMessageSize 约束；
 * 2) 分块大小按 RTT 分层自适应；
 * 3) 提供候选对快照，支撑“竞速连接”可观测性与受控探测。
 */

const MIN_CHUNK_SIZE_BYTES = 16 * 1024;
const CHUNK_SIZE_STEP_BYTES = 4 * 1024;
const MESSAGE_OVERHEAD_BYTES = 1024;

const RTT_FAST_MS = 60;
const RTT_MEDIUM_MS = 140;
const RTT_SLOW_MS = 280;

export interface AdaptiveChunkPlan {
  chunkSize: number;
  rttMs: number | null;
  messageLimit: number | null;
  reason: "default" | "rtt_adaptive" | "max_message_size";
}

export interface CandidatePairSnapshot {
  selectedPairId: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  selectedRttMs: number | null;
  bestObservedRttMs: number | null;
  availablePairCount: number;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundChunkSize(value: number): number {
  const rounded = Math.floor(value / CHUNK_SIZE_STEP_BYTES) * CHUNK_SIZE_STEP_BYTES;
  return Math.max(MIN_CHUNK_SIZE_BYTES, rounded);
}

export function normalizeMaxMessageSize(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return Math.floor(raw);
}

export function clampChunkSizeByMaxMessageSize(
  desiredChunkSize: number,
  maxMessageSize: number | null
): number {
  const desired = roundChunkSize(desiredChunkSize);
  if (!maxMessageSize) {
    return desired;
  }

  const safeLimit = Math.max(MIN_CHUNK_SIZE_BYTES, maxMessageSize - MESSAGE_OVERHEAD_BYTES);
  return Math.min(desired, roundChunkSize(safeLimit));
}

export function chooseChunkSizeByRtt(baseChunkSize: number, rttMs: number | null): number {
  if (rttMs === null) {
    return roundChunkSize(baseChunkSize);
  }

  if (rttMs <= RTT_FAST_MS) {
    return roundChunkSize(baseChunkSize);
  }
  if (rttMs <= RTT_MEDIUM_MS) {
    return roundChunkSize(Math.min(baseChunkSize, 48 * 1024));
  }
  if (rttMs <= RTT_SLOW_MS) {
    return roundChunkSize(Math.min(baseChunkSize, 32 * 1024));
  }
  return roundChunkSize(Math.min(baseChunkSize, MIN_CHUNK_SIZE_BYTES));
}

export function buildAdaptiveChunkPlan(
  baseChunkSize: number,
  maxMessageSize: number | null,
  rttMs: number | null
): AdaptiveChunkPlan {
  const byRtt = chooseChunkSizeByRtt(baseChunkSize, rttMs);
  const byMessageLimit = clampChunkSizeByMaxMessageSize(byRtt, maxMessageSize);

  let reason: AdaptiveChunkPlan["reason"] = "default";
  if (rttMs !== null && byRtt !== roundChunkSize(baseChunkSize)) {
    reason = "rtt_adaptive";
  }
  if (byMessageLimit < byRtt) {
    reason = "max_message_size";
  }

  return {
    chunkSize: byMessageLimit,
    rttMs,
    messageLimit: maxMessageSize,
    reason
  };
}

function getSelectedCandidatePairId(statsById: Map<string, RTCStats>): string | null {
  for (const stat of statsById.values()) {
    if (stat.type !== "transport") {
      continue;
    }
    const selectedPairId = (stat as RTCTransportStats).selectedCandidatePairId;
    if (typeof selectedPairId === "string" && selectedPairId.length > 0) {
      return selectedPairId;
    }
  }

  for (const stat of statsById.values()) {
    if (stat.type !== "candidate-pair") {
      continue;
    }
    const record = stat as RTCIceCandidatePairStats & { selected?: boolean };
    if (record.state === "succeeded" && (record.nominated || record.selected)) {
      return record.id;
    }
  }

  return null;
}

function getCandidatePairRttMs(record: RTCStats): number | null {
  if (record.type !== "candidate-pair") {
    return null;
  }
  const pair = record as RTCIceCandidatePairStats;

  const currentRoundTripTime = toFiniteNumber((pair as unknown as { currentRoundTripTime?: number }).currentRoundTripTime);
  if (currentRoundTripTime !== null && currentRoundTripTime >= 0) {
    return Math.round(currentRoundTripTime * 1000 * 1000) / 1000;
  }

  const totalRoundTripTime = toFiniteNumber((pair as unknown as { totalRoundTripTime?: number }).totalRoundTripTime);
  const responsesReceived = toFiniteNumber((pair as unknown as { responsesReceived?: number }).responsesReceived);
  if (
    totalRoundTripTime !== null &&
    responsesReceived !== null &&
    responsesReceived > 0
  ) {
    return Math.round((totalRoundTripTime / responsesReceived) * 1000 * 1000) / 1000;
  }

  return null;
}

export async function sampleSelectedCandidateRtt(pc: RTCPeerConnection): Promise<number | null> {
  const stats = await pc.getStats();
  const statsById = new Map<string, RTCStats>();
  stats.forEach((record) => statsById.set(record.id, record));

  const selectedPairId = getSelectedCandidatePairId(statsById);
  if (!selectedPairId) {
    return null;
  }

  const selectedPair = statsById.get(selectedPairId);
  if (!selectedPair) {
    return null;
  }

  return getCandidatePairRttMs(selectedPair);
}

export async function getCandidatePairSnapshot(pc: RTCPeerConnection): Promise<CandidatePairSnapshot> {
  const stats = await pc.getStats();
  const statsById = new Map<string, RTCStats>();
  stats.forEach((record) => statsById.set(record.id, record));

  const selectedPairId = getSelectedCandidatePairId(statsById);
  const selectedPair = selectedPairId ? statsById.get(selectedPairId) ?? null : null;

  let localCandidateType: string | null = null;
  let remoteCandidateType: string | null = null;
  let selectedRttMs: number | null = null;

  if (selectedPair && selectedPair.type === "candidate-pair") {
    const pair = selectedPair as RTCIceCandidatePairStats;
    selectedRttMs = getCandidatePairRttMs(selectedPair);

    const localCandidate = pair.localCandidateId ? statsById.get(pair.localCandidateId) : undefined;
    const remoteCandidate = pair.remoteCandidateId ? statsById.get(pair.remoteCandidateId) : undefined;

    if (localCandidate?.type === "local-candidate") {
      localCandidateType = (localCandidate as { candidateType?: string }).candidateType ?? null;
    }
    if (remoteCandidate?.type === "remote-candidate") {
      remoteCandidateType = (remoteCandidate as { candidateType?: string }).candidateType ?? null;
    }
  }

  let availablePairCount = 0;
  let bestObservedRttMs: number | null = null;
  for (const stat of statsById.values()) {
    if (stat.type !== "candidate-pair") {
      continue;
    }
    const pair = stat as RTCIceCandidatePairStats;
    if (pair.state !== "succeeded") {
      continue;
    }

    availablePairCount += 1;
    const rtt = getCandidatePairRttMs(stat);
    if (rtt === null) {
      continue;
    }
    if (bestObservedRttMs === null || rtt < bestObservedRttMs) {
      bestObservedRttMs = rtt;
    }
  }

  return {
    selectedPairId,
    localCandidateType,
    remoteCandidateType,
    selectedRttMs,
    bestObservedRttMs,
    availablePairCount
  };
}
