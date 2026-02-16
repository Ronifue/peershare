/**
 * PeerShare - WebRTC 恢复模块（ICE 重启/重建/候选监测）
 */

import {
  CANDIDATE_RACE_CONFIG,
  RECONNECT_CONFIG
} from "../common/config";
import { getCandidatePairSnapshot } from "./adaptive-chunk";
import { stringifyStructuredEvent } from "./webrtc-shared";

export function handleIceDisconnected(this: any, pc: RTCPeerConnection): void {
  if (this.isRecoveryInProgress) {
    console.log(stringifyStructuredEvent({
      event: "recovery_already_in_progress",
      timestamp: Date.now()
    }));
    return;
  }

  if (!this.canStartRecovery()) {
    return;
  }

  console.log(stringifyStructuredEvent({
    event: "ice_disconnected_grace_start",
    gracePeriodMs: RECONNECT_CONFIG.GRACE_PERIOD_MS,
    timestamp: Date.now()
  }));

  this.isRecoveryInProgress = true;

  this.clearDisconnectGraceTimer();
  this.disconnectGraceTimer = setTimeout(() => {
    this.disconnectGraceTimer = null;
    this.attemptRestartIce(pc);
  }, RECONNECT_CONFIG.GRACE_PERIOD_MS) as any;
}

export async function attemptRestartIce(this: any, pc: RTCPeerConnection): Promise<void> {
  if (!this.isInitiator) {
    console.log(stringifyStructuredEvent({
      event: "restartIce_skip_not_initiator",
      timestamp: Date.now()
    }));
    this.fallbackToRebuild();
    return;
  }

  if (this.restartIceAttempts >= RECONNECT_CONFIG.MAX_RESTART_ICE_ATTEMPTS) {
    console.log(stringifyStructuredEvent({
      event: "restartIce_exhausted",
      attempts: this.restartIceAttempts,
      maxAttempts: RECONNECT_CONFIG.MAX_RESTART_ICE_ATTEMPTS,
      timestamp: Date.now()
    }));
    this.fallbackToRebuild();
    return;
  }

  if (typeof pc.restartIce !== "function") {
    console.log(stringifyStructuredEvent({
      event: "restartIce_unsupported",
      timestamp: Date.now()
    }));
    this.fallbackToRebuild();
    return;
  }

  const pcState = pc.connectionState;
  if (pcState === "closed" || pcState === "failed") {
    console.log(stringifyStructuredEvent({
      event: "restartIce_invalid_state",
      pcState,
      timestamp: Date.now()
    }));
    this.fallbackToRebuild();
    return;
  }

  this.restartIceAttempts++;
  console.log(stringifyStructuredEvent({
    event: "restartIce_attempt",
    attempt: this.restartIceAttempts,
    maxAttempts: RECONNECT_CONFIG.MAX_RESTART_ICE_ATTEMPTS,
    timestamp: Date.now()
  }));

  try {
    pc.restartIce();
    console.log(stringifyStructuredEvent({
      event: "restartIce_success",
      attempt: this.restartIceAttempts,
      timestamp: Date.now()
    }));

    // Explicit renegotiation required: initiator must create new offer after restartIce
    // This codebase does not rely on onnegotiationneeded event
    if (this.isInitiator && this.remotePeerId) {
      console.log(stringifyStructuredEvent({
        event: "restartIce_creating_offer",
        timestamp: Date.now()
      }));

      // Give ICE a moment to start restarting before creating offer
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check PC is still valid before creating offer
      if (this.pc && this.pc.connectionState !== "closed" && this.pc.signalingState !== "closed") {
        await this.sendOffer();

        // Set up timeout to detect if restartIce + renegotiation fails to restore connection
        this.clearRestartIceRecoveryTimer();
        this.restartIceRecoveryTimer = setTimeout(() => {
          this.restartIceRecoveryTimer = null;
          if (this.isRecoveryInProgress && this.pc?.iceConnectionState !== "connected") {
            console.log(stringifyStructuredEvent({
              event: "restartIce_recovery_timeout",
              message: "Connection did not recover after restartIce and renegotiation, falling back to rebuild",
              timestamp: Date.now()
            }));
            this.fallbackToRebuild();
          }
        }, RECONNECT_CONFIG.GRACE_PERIOD_MS);
      } else {
        console.log(stringifyStructuredEvent({
          event: "restartIce_pc_invalid_for_offer",
          timestamp: Date.now()
        }));
        this.fallbackToRebuild();
      }
    }
  } catch (error) {
    console.log(stringifyStructuredEvent({
      event: "restartIce_failed",
      attempt: this.restartIceAttempts,
      error: (error as Error).message,
      timestamp: Date.now()
    }));
    this.fallbackToRebuild();
  }
}

export async function fallbackToRebuild(this: any): Promise<void> {
  this.clearRestartIceRecoveryTimer();
  if (this.rebuildAttempts >= RECONNECT_CONFIG.MAX_REBUILD_ATTEMPTS) {
    console.log(stringifyStructuredEvent({
      event: "rebuild_exhausted",
      attempts: this.rebuildAttempts,
      maxAttempts: RECONNECT_CONFIG.MAX_REBUILD_ATTEMPTS,
      timestamp: Date.now()
    }));
    this.isRecoveryInProgress = false;
    this.callbacks.onError(new Error("连接恢复失败，请重试"));
    this.callbacks.onDataChannelClose();
    return;
  }

  this.rebuildAttempts++;

  const backoffMs = Math.min(
    this.recoveryBackoffMs * Math.pow(2, this.rebuildAttempts - 1),
    RECONNECT_CONFIG.MAX_BACKOFF_MS
  );

  console.log(stringifyStructuredEvent({
    event: "rebuild_attempt",
    attempt: this.rebuildAttempts,
    maxAttempts: RECONNECT_CONFIG.MAX_REBUILD_ATTEMPTS,
    backoffMs,
    timestamp: Date.now()
  }));

  await new Promise(resolve => setTimeout(resolve, backoffMs));

  if (!this.isRecoveryInProgress) {
    console.log(stringifyStructuredEvent({
      event: "rebuild_cancelled_already_recovered",
      timestamp: Date.now()
    }));
    return;
  }

  this.initConnection();

  // Only initiator creates data channel; joiner waits via ondatachannel
  if (this.isInitiator) {
    this.createDataChannel();
  }

  if (this.isInitiator && this.remotePeerId) {
    console.log(stringifyStructuredEvent({
      event: "rebuild_sending_offer",
      timestamp: Date.now()
    }));
    await this.sendOffer();
  }
}

export function handleIceFailure(this: any): void {
  this.iceFailureCount++;
  console.log(stringifyStructuredEvent({
    event: "ice_failure",
    failureCount: this.iceFailureCount,
    isRecoveryInProgress: this.isRecoveryInProgress,
    timestamp: Date.now()
  }));

  // Re-entry guard: prevent overlapping rebuild attempts from concurrent failed states
  if (this.isRecoveryInProgress) {
    console.log(stringifyStructuredEvent({
      event: "ice_failure_recovery_already_in_progress",
      timestamp: Date.now()
    }));
    return;
  }

  this.clearDisconnectGraceTimer();

  // Initialize recovery state for the failed path
  this.isRecoveryInProgress = true;
  this.fallbackToRebuild();
}

export function handleIceConnected(this: any): void {
  this.clearDisconnectGraceTimer();
  this.clearRestartIceRecoveryTimer();
  this.clearRecoveryCounterResetTimer();

  if (this.isRecoveryInProgress) {
    this.isRecoveryInProgress = false;

    console.log(stringifyStructuredEvent({
      event: "ice_connected_after_recovery",
      restartIceAttempts: this.restartIceAttempts,
      rebuildAttempts: this.rebuildAttempts,
      timestamp: Date.now()
    }));

    this.recoveryCounterResetTimer = setTimeout(() => {
      this.recoveryCounterResetTimer = null;
      this.resetRecoveryCounters();
    }, RECONNECT_CONFIG.RECOVERY_GRACE_PERIOD_MS);
  } else {
    console.log(stringifyStructuredEvent({
      event: "ice_connected",
      timestamp: Date.now()
    }));

    this.resetRecoveryCounters();
  }

  this.startCandidateRaceMonitor();
}

export function resetRecoveryCounters(this: any): void {
  this.clearDisconnectGraceTimer();
  this.clearRestartIceRecoveryTimer();
  this.clearRecoveryCounterResetTimer();
  this.iceFailureCount = 0;
  this.restartIceAttempts = 0;
  this.rebuildAttempts = 0;
  this.recoveryBackoffMs = RECONNECT_CONFIG.BACKOFF_BASE_MS;
  this.isRecoveryInProgress = false;

  console.log(stringifyStructuredEvent({
    event: "recovery_counters_reset",
    timestamp: Date.now()
  }));
}

export function stopCandidateRaceMonitor(this: any): void {
  if (this.candidateRaceMonitorTimer) {
    clearInterval(this.candidateRaceMonitorTimer);
    this.candidateRaceMonitorTimer = null;
  }
}

export function startCandidateRaceMonitor(this: any): void {
  this.stopCandidateRaceMonitor();

  if (!this.pc || !this.isInitiator) {
    return;
  }

  this.candidateRaceProbeAttempts = 0;
  this.candidateRaceMonitorTimer = setInterval(() => {
    void this.runCandidateRaceProbe();
  }, CANDIDATE_RACE_CONFIG.MONITOR_INTERVAL_MS);
}

export async function runCandidateRaceProbe(this: any): Promise<void> {
  if (!this.pc || this.pc.iceConnectionState !== "connected") {
    return;
  }

  try {
    const snapshot = await getCandidatePairSnapshot(this.pc);
    console.log(stringifyStructuredEvent({
      event: "candidate_pair_snapshot",
      selectedPairId: snapshot.selectedPairId,
      localCandidateType: snapshot.localCandidateType,
      remoteCandidateType: snapshot.remoteCandidateType,
      selectedRttMs: snapshot.selectedRttMs,
      bestObservedRttMs: snapshot.bestObservedRttMs,
      availablePairCount: snapshot.availablePairCount,
      timestamp: Date.now()
    }));

    if (this.isRecoveryInProgress) {
      return;
    }

    const selectedRttMs = snapshot.selectedRttMs;
    const bestObservedRttMs = snapshot.bestObservedRttMs;
    const isProbeNeeded =
      selectedRttMs !== null &&
      bestObservedRttMs !== null &&
      selectedRttMs >= CANDIDATE_RACE_CONFIG.HIGH_RTT_MS &&
      selectedRttMs - bestObservedRttMs >= CANDIDATE_RACE_CONFIG.IMPROVEMENT_THRESHOLD_MS &&
      this.candidateRaceProbeAttempts < CANDIDATE_RACE_CONFIG.MAX_PROBE_ATTEMPTS;

    if (!isProbeNeeded) {
      return;
    }

    this.candidateRaceProbeAttempts++;
    this.isRecoveryInProgress = true;
    console.log(stringifyStructuredEvent({
      event: "candidate_race_probe_triggered",
      probeAttempt: this.candidateRaceProbeAttempts,
      selectedRttMs,
      bestObservedRttMs,
      timestamp: Date.now()
    }));
    await this.attemptRestartIce(this.pc);
  } catch (error) {
    console.warn(stringifyStructuredEvent({
      event: "candidate_pair_snapshot_failed",
      message: (error as Error).message,
      timestamp: Date.now()
    }));
  }
}
