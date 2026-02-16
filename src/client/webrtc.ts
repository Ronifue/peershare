/**
 * PeerShare - WebRTC P2P 连接管理器
 * 
 * 基于 simple-peer 和完美协商模式简化实现
 * 核心原则：
 * 1. 创建者始终发起 offer（不依赖 onnegotiationneeded）
 * 2. 加入者始终等待 offer
 * 3. 严格的信令状态管理
 */

import {
  FILE_CONFIG,
  BACKPRESSURE_MODE,
  BACKPRESSURE_CONFIG,
  RECONNECT_CONFIG,
  ADAPTIVE_CHUNK_CONFIG,
  RESUME_CONFIG
} from '../common/config';
import type { SignalMessage, FileMetadata, IncomingTransferState, OutgoingTransferState } from '../common/types';
import {
  buildAdaptiveChunkPlan,
  normalizeMaxMessageSize,
  sampleSelectedCandidateRtt
} from './adaptive-chunk';
import {
  createTransferSessionKey,
  type PersistedTransferSession,
  type PersistedTransferStatus,
  TransferStore
} from './transfer-store';
import { isRecoverableTransferError } from './transfer-recovery';
import {
  type BackpressureRuntimeMode,
  type ConnectionCallbacks,
  type OutgoingRuntimeSession,
  type TransferMessage
} from './webrtc-shared';
import {
  handleSignalingMessage as handleSignalingMessageModule,
  initConnection as initConnectionModule,
  createDataChannel as createDataChannelModule,
  sendOffer as sendOfferModule,
  handleOffer as handleOfferModule,
  handleAnswer as handleAnswerModule,
  handleIceCandidate as handleIceCandidateModule,
  addIceCandidate as addIceCandidateModule,
  flushPendingCandidates as flushPendingCandidatesModule,
  setupDataChannel as setupDataChannelModule,
  handleDataChannelMessage as handleDataChannelMessageModule,
  sendSignal as sendSignalModule
} from './webrtc-signaling';
import {
  handleIncomingFileOffer as handleIncomingFileOfferModule,
  processFileChunk as processFileChunkModule,
  processFileChunkInternal as processFileChunkInternalModule,
  completeTransfer as completeTransferModule,
  requestRetransmit as requestRetransmitModule,
  waitForBackpressure as waitForBackpressureModule,
  sendFile as sendFileModule,
  ensureRuntimeSessionChecksum as ensureRuntimeSessionChecksumModule,
  sendReceiverReady as sendReceiverReadyModule,
  handleReceiverReady as handleReceiverReadyModule,
  handleRetransmitRequest as handleRetransmitRequestModule,
  sendTransferError as sendTransferErrorModule
} from './webrtc-transfer';
import {
  handleIceDisconnected as handleIceDisconnectedModule,
  attemptRestartIce as attemptRestartIceModule,
  fallbackToRebuild as fallbackToRebuildModule,
  handleIceFailure as handleIceFailureModule,
  handleIceConnected as handleIceConnectedModule,
  resetRecoveryCounters as resetRecoveryCountersModule,
  stopCandidateRaceMonitor as stopCandidateRaceMonitorModule,
  startCandidateRaceMonitor as startCandidateRaceMonitorModule,
  runCandidateRaceProbe as runCandidateRaceProbeModule
} from './webrtc-recovery';

const MAX_BACKPRESSURE_OVERRIDE = 64 * 1024 * 1024;
const DEFAULT_FORCED_MAX_MESSAGE_SIZE = 16 * 1024;

type TransferDirection = 'incoming' | 'outgoing';

function resolveBackpressureRuntimeMode(): BackpressureRuntimeMode {
  const mode = new URLSearchParams(window.location.search).get('psBackpressureMode');
  if (mode === 'event' || mode === 'polling' || mode === 'auto') {
    return mode;
  }
  return BACKPRESSURE_MODE;
}

function resolveBackpressureNumericOverride(param: string, fallback: number): number {
  const rawValue = new URLSearchParams(window.location.search).get(param);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_BACKPRESSURE_OVERRIDE);
}

function resolveDebugNumericOverride(param: string): number | null {
  const rawValue = new URLSearchParams(window.location.search).get(param);
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

// 检查浏览器支持
function checkWebRTCSupport(): { supported: boolean; error?: string } {
  if (typeof window.RTCPeerConnection === 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('wechat')) {
      return { supported: false, error: '微信内置浏览器不支持 WebRTC，请使用 Chrome、Edge 或 Safari' };
    }
    if (ua.includes('qq')) {
      return { supported: false, error: 'QQ 浏览器不支持 WebRTC，请使用 Chrome、Edge 或 Safari' };
    }
    return { supported: false, error: '浏览器不支持 WebRTC，请使用 Chrome、Edge、Firefox 或 Safari' };
  }

  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    if (typeof pc.createDataChannel !== 'function') {
      return { supported: false, error: '浏览器不支持 RTCDataChannel' };
    }
    pc.close();
  } catch (e) {
    return { supported: false, error: `创建 RTCPeerConnection 失败: ${(e as Error).message}` };
  }

  return { supported: true };
}

export class P2PConnection {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private peerId: string = '';
  public roomId: string = '';
  private remotePeerId: string = '';
  public callbacks: ConnectionCallbacks;
  
  // 角色：true = 创建者（发起方），false = 加入者（应答方）
  public isInitiator = false;
  public currentReceivingFileId: string | null = null;
  private connectTimeoutId: Timer | null = null;
  
  // 候选缓冲
  public pendingCandidates: RTCIceCandidateInit[] = [];
  public remoteDescriptionSet = false;
  
  // ICE 重连计数
  public iceFailureCount = 0;

  // 分级重连恢复状态 (Task 5)
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private restartIceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryCounterResetTimer: ReturnType<typeof setTimeout> | null = null;
  public restartIceAttempts = 0;
  public rebuildAttempts = 0;
  private isRecoveryInProgress = false;
  public recoveryBackoffMs = RECONNECT_CONFIG.BACKOFF_BASE_MS;

  public backpressureMode: 'event' | 'polling' = 'polling';
  private backpressureFallbackReason?: string;
  private backpressureRuntimeMode: BackpressureRuntimeMode = BACKPRESSURE_MODE;
  private backpressureMaxBufferedAmount = FILE_CONFIG.MAX_BUFFERED_AMOUNT;
  private backpressureLowThreshold = BACKPRESSURE_CONFIG.LOW_THRESHOLD;

  // 文件传输 - 使用预分配缓冲区减少拷贝开销
  private incomingTransfers = new Map<string, IncomingTransferState>();
  private inMemoryIncomingChunks = new Map<string, ArrayBuffer[]>();

  // 发送状态跟踪 (Task 4)
  private outgoingTransfers = new Map<string, OutgoingTransferState>();

  // 出站运行时会话（用于重传与断点恢复）
  private outgoingRuntimeSessions = new Map<string, OutgoingRuntimeSession>();

  // 持久化存储（IndexedDB）
  private transferStore = new TransferStore();

  // 候选对竞速监测
  public candidateRaceMonitorTimer: ReturnType<typeof setInterval> | null = null;
  public candidateRaceProbeAttempts = 0;

  // 自适应分块采样缓存
  private cachedRttMs: number | null = null;
  private cachedRttSampleAt = 0;

  // 调试覆盖：用于验证低 maxMessageSize/高 RTT 的降级路径
  private forcedMaxMessageSizeOverride: number | null = null;
  private forcedRttOverrideMs: number | null = null;

  private isDataChannelReady(): boolean {
    return this.dataChannel !== null && this.dataChannel.readyState === 'open';
  }

  public isPeerConnectionValid(): boolean {
    if (!this.pc) return false;
    const state = this.pc.connectionState;
    return state !== 'failed' && state !== 'closed';
  }

  public canStartRecovery(): boolean {
    return !this.isRecoveryInProgress && this.disconnectGraceTimer === null;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = null;
    }
  }

  private clearDisconnectGraceTimer(): void {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  private clearRestartIceRecoveryTimer(): void {
    if (this.restartIceRecoveryTimer) {
      clearTimeout(this.restartIceRecoveryTimer);
      this.restartIceRecoveryTimer = null;
    }
  }

  private clearRecoveryCounterResetTimer(): void {
    if (this.recoveryCounterResetTimer) {
      clearTimeout(this.recoveryCounterResetTimer);
      this.recoveryCounterResetTimer = null;
    }
  }

  public async waitForDataChannelReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      if (this.isDataChannelReady()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RESUME_CONFIG.AUTO_RESUME_POLL_INTERVAL_MS));
    }

    throw new Error(`AUTO_RESUME_TIMEOUT: data channel not ready within ${timeoutMs}ms`);
  }

  public isRecoverableSendInterruption(error: unknown): boolean {
    if (isRecoverableTransferError(error)) {
      return true;
    }
    const rawMessage = typeof error === 'string'
      ? error
      : (error && typeof error === 'object' && 'message' in error)
        ? String((error as { message?: unknown }).message ?? '')
        : '';

    if (!rawMessage) {
      return false;
    }

    const message = rawMessage.toLowerCase();
    return (
      rawMessage.includes('数据通道断开') ||
      message.includes('readyState is not') ||
      message.includes('datachannel') && message.includes('not open') ||
      message.includes('connection closed')
    );
  }

  public getBackpressureWaitThreshold(): number {
    if (this.backpressureRuntimeMode === 'polling' || this.backpressureFallbackReason) {
      return this.backpressureMaxBufferedAmount;
    }

    return Math.max(this.backpressureMaxBufferedAmount, this.backpressureLowThreshold);
  }

  private getUploadId(metadata: FileMetadata): string {
    return metadata.uploadId || metadata.id;
  }

  private resolveMaxMessageSize(): number | null {
    if (this.forcedMaxMessageSizeOverride !== null) {
      return Math.max(DEFAULT_FORCED_MAX_MESSAGE_SIZE, this.forcedMaxMessageSizeOverride);
    }

    const runtimeValue = normalizeMaxMessageSize(this.pc?.sctp?.maxMessageSize);
    return runtimeValue;
  }

  private async getCurrentRttMs(): Promise<number | null> {
    if (this.forcedRttOverrideMs !== null) {
      return this.forcedRttOverrideMs;
    }

    if (!this.pc) {
      return null;
    }

    const now = Date.now();
    if (now - this.cachedRttSampleAt <= ADAPTIVE_CHUNK_CONFIG.RUNTIME_RTT_CACHE_MS) {
      return this.cachedRttMs;
    }

    try {
      this.cachedRttMs = await sampleSelectedCandidateRtt(this.pc);
      this.cachedRttSampleAt = now;
    } catch {
      this.cachedRttMs = null;
      this.cachedRttSampleAt = now;
    }

    return this.cachedRttMs;
  }

  public async resolveChunkPlan(baseChunkSize: number): Promise<{
    chunkSize: number;
    rttMs: number | null;
    messageLimit: number | null;
    reason: string;
  }> {
    const maxMessageSize = this.resolveMaxMessageSize();
    const rttMs = await this.getCurrentRttMs();
    const plan = buildAdaptiveChunkPlan(baseChunkSize, maxMessageSize, rttMs);
    return {
      chunkSize: plan.chunkSize,
      rttMs: plan.rttMs,
      messageLimit: plan.messageLimit,
      reason: plan.reason
    };
  }

  private buildPersistedSession(
    direction: TransferDirection,
    metadata: FileMetadata,
    remotePeerId: string,
    status: PersistedTransferStatus,
    nextChunkIndex: number,
    bytesTransferred: number,
    fingerprint?: string,
    fileChecksum?: string
  ): PersistedTransferSession {
    const uploadId = this.getUploadId(metadata);
    const now = Date.now();
    const sessionKey = createTransferSessionKey(direction, uploadId);

    return {
      sessionKey,
      direction,
      status,
      uploadId,
      fileId: metadata.id,
      fileName: metadata.name,
      fileType: metadata.type,
      fileSize: metadata.size,
      chunkSize: metadata.chunkSize,
      totalChunks: metadata.totalChunks,
      nextChunkIndex,
      bytesTransferred,
      remotePeerId,
      fingerprint,
      fileChecksum,
      createdAt: now,
      updatedAt: now
    };
  }

  public async upsertPersistedSession(
    direction: TransferDirection,
    metadata: FileMetadata,
    status: PersistedTransferStatus,
    nextChunkIndex: number,
    bytesTransferred: number,
    options: { fingerprint?: string; fileChecksum?: string } = {}
  ): Promise<void> {
    if (!this.transferStore.isSupported()) {
      return;
    }

    const existing = await this.transferStore.getSession(createTransferSessionKey(direction, this.getUploadId(metadata)));
    const session = this.buildPersistedSession(
      direction,
      metadata,
      this.remotePeerId,
      status,
      nextChunkIndex,
      bytesTransferred,
      options.fingerprint ?? existing?.fingerprint,
      options.fileChecksum ?? existing?.fileChecksum
    );
    if (existing) {
      session.createdAt = existing.createdAt;
    }
    await this.transferStore.putSession(session);
  }

  constructor(callbacks: ConnectionCallbacks) {
    this.callbacks = callbacks;
    this.backpressureRuntimeMode = resolveBackpressureRuntimeMode();
    this.backpressureMaxBufferedAmount = resolveBackpressureNumericOverride('psMaxBufferedAmount', FILE_CONFIG.MAX_BUFFERED_AMOUNT);
    this.backpressureLowThreshold = resolveBackpressureNumericOverride('psLowThreshold', BACKPRESSURE_CONFIG.LOW_THRESHOLD);
    this.forcedMaxMessageSizeOverride = resolveDebugNumericOverride('psForceMaxMessageSize');
    this.forcedRttOverrideMs = resolveDebugNumericOverride('psForceRttMs');

    if (this.transferStore.isSupported() && Math.random() < RESUME_CONFIG.CLEANUP_PROBABILITY) {
      void this.transferStore.pruneStaleSessions(RESUME_CONFIG.SESSION_TTL_MS);
    }
  }

  static checkSupport = checkWebRTCSupport;

  connect(roomId: string = ''): Promise<string> {
    return new Promise((resolve, reject) => {
      const support = checkWebRTCSupport();
      if (!support.supported) {
        reject(new Error(support.error || '浏览器不支持 WebRTC'));
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log('[WebSocket] 已连接');
      };
      
      this.ws.onmessage = (event) => {
        const message: SignalMessage = JSON.parse(event.data);
        this.handleSignalingMessage(message, resolve, reject);
      };
      
      this.ws.onerror = () => {
        this.clearConnectTimeout();
        reject(new Error('WebSocket 连接失败'));
      };
      
      this.ws.onclose = () => {
        this.clearConnectTimeout();
        console.log('[WebSocket] 已关闭');
        if (!this.peerId) {
          reject(new Error('WebSocket 连接已关闭'));
        }
      };
      
      if (roomId) {
        this.roomId = roomId;
      }
      
      this.connectTimeoutId = setTimeout(() => {
        if (!this.peerId) {
          reject(new Error('连接超时'));
        }
        this.clearConnectTimeout();
      }, 10000) as any;
    });
  }

  private async handleSignalingMessage(
    message: SignalMessage,
    resolve?: (value: string) => void,
    reject?: (reason: Error) => void
  ): Promise<void> {
    return handleSignalingMessageModule.call(this, message, resolve, reject);
  }

  public initConnection(): void {
    return initConnectionModule.call(this);
  }

  // 分级重连恢复 - 处理 ICE 'disconnected' 状态
  public handleIceDisconnected(pc: RTCPeerConnection): void {
    return handleIceDisconnectedModule.call(this, pc);
  }

  public async attemptRestartIce(pc: RTCPeerConnection): Promise<void> {
    return attemptRestartIceModule.call(this, pc);
  }

  public async fallbackToRebuild(): Promise<void> {
    return fallbackToRebuildModule.call(this);
  }

  public handleIceFailure(): void {
    return handleIceFailureModule.call(this);
  }

  public handleIceConnected(): void {
    return handleIceConnectedModule.call(this);
  }

  public resetRecoveryCounters(): void {
    return resetRecoveryCountersModule.call(this);
  }

  private stopCandidateRaceMonitor(): void {
    return stopCandidateRaceMonitorModule.call(this);
  }

  public startCandidateRaceMonitor(): void {
    return startCandidateRaceMonitorModule.call(this);
  }

  public async runCandidateRaceProbe(): Promise<void> {
    return runCandidateRaceProbeModule.call(this);
  }

  public createDataChannel(): void {
    return createDataChannelModule.call(this);
  }

  public async sendOffer(): Promise<void> {
    return sendOfferModule.call(this);
  }

  public async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    return handleOfferModule.call(this, offer);
  }

  public async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    return handleAnswerModule.call(this, answer);
  }

  public async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    return handleIceCandidateModule.call(this, candidate);
  }

  public async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    return addIceCandidateModule.call(this, candidate);
  }

  public async flushPendingCandidates(): Promise<void> {
    return flushPendingCandidatesModule.call(this);
  }

  public setupDataChannel(channel: RTCDataChannel): void {
    return setupDataChannelModule.call(this, channel);
  }

  public handleDataChannelMessage(data: string | ArrayBuffer): void {
    return handleDataChannelMessageModule.call(this, data);
  }

  public async handleIncomingFileOffer(metadata: FileMetadata): Promise<void> {
    return handleIncomingFileOfferModule.call(this, metadata);
  }

  public processFileChunk(data: ArrayBuffer): void {
    return processFileChunkModule.call(this, data);
  }

  public async processFileChunkInternal(
    fileId: string,
    transfer: IncomingTransferState,
    chunkData: ArrayBuffer
  ): Promise<void> {
    return processFileChunkInternalModule.call(this, fileId, transfer, chunkData);
  }

  public async completeTransfer(fileId: string, checksum?: string): Promise<void> {
    return completeTransferModule.call(this, fileId, checksum);
  }

  public async requestRetransmit(
    transfer: IncomingTransferState,
    fromChunk: number,
    reason: string
  ): Promise<void> {
    return requestRetransmitModule.call(this, transfer, fromChunk, reason);
  }

  /**
   * 等待背压解除（事件驱动 + 轮询回退）
   * @returns 使用的模式：'event' 或 'polling'
   */
  public async waitForBackpressure(): Promise<'event' | 'polling'> {
    return waitForBackpressureModule.call(this);
  }

  async sendFile(file: File): Promise<void> {
    return sendFileModule.call(this, file);
  }

  public async ensureRuntimeSessionChecksum(session: OutgoingRuntimeSession): Promise<string> {
    return ensureRuntimeSessionChecksumModule.call(this, session);
  }

  public sendSignal(message: SignalMessage): void {
    return sendSignalModule.call(this, message);
  }

  disconnect(): void {
    this.clearConnectTimeout();
    this.cleanup();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  public sendReceiverReady(fileId: string, uploadId: string, resumeFromChunk: number): void {
    return sendReceiverReadyModule.call(this, fileId, uploadId, resumeFromChunk);
  }

  // Task 4: 处理 receiver-ready 信号（发送方）
  public handleReceiverReady(fileId: string, resumeFromChunk?: number, uploadId?: string): void {
    return handleReceiverReadyModule.call(this, fileId, resumeFromChunk, uploadId);
  }

  public async handleRetransmitRequest(message: TransferMessage): Promise<void> {
    return handleRetransmitRequestModule.call(this, message);
  }

  public sendTransferError(fileId: string, code: string, message: string): void {
    return sendTransferErrorModule.call(this, fileId, code, message);
  }

  private cleanupPeerConnection(): void {
    this.stopCandidateRaceMonitor();
    this.clearDisconnectGraceTimer();
    this.clearRestartIceRecoveryTimer();
    this.clearRecoveryCounterResetTimer();
    this.cachedRttMs = null;
    this.cachedRttSampleAt = 0;
    this.iceFailureCount = 0;
    this.restartIceAttempts = 0;
    this.rebuildAttempts = 0;
    this.isRecoveryInProgress = false;
    this.recoveryBackoffMs = RECONNECT_CONFIG.BACKOFF_BASE_MS;

    // 先清理发送超时定时器（Task 4）
    for (const [, outgoing] of this.outgoingTransfers) {
      if (outgoing.timeoutId) {
        clearTimeout(outgoing.timeoutId);
        outgoing.timeoutId = null;
      }
    }
    this.outgoingTransfers.clear();
    this.outgoingRuntimeSessions.clear();

    // 先移除事件处理器，防止关闭时触发残留回调
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onbufferedamountlow = null;
      this.dataChannel.close();
    }
    if (this.pc) {
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ondatachannel = null;
      this.pc.close();
    }
    this.dataChannel = null;
    this.pc = null;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.incomingTransfers.clear();
    this.inMemoryIncomingChunks.clear();
    this.currentReceivingFileId = null;
  }

  private cleanup(): void {
    this.cleanupPeerConnection();
  }
}
