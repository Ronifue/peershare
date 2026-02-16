/**
 * PeerShare - 文件传输模块（续传/完整性/背压/重传）
 */

import {
  ADAPTIVE_CHUNK_CONFIG,
  BACKPRESSURE_CONFIG,
  FILE_CONFIG,
  RESUME_CONFIG
} from "../common/config";
import type { FileMetadata, IncomingTransferState } from "../common/types";
import {
  bytesForChunkIndex,
  calculateTotalChunks,
  createFileFingerprint,
  deriveFileChecksumFromChunkChecksums,
  hashArrayBuffer,
  normalizeChunkIndex
} from "./transfer-integrity";
import { finalizeIncomingTransferFromStore } from "./transfer-finalizer";
import { createRecoverableTransferError } from "./transfer-recovery";
import { createTransferSessionKey } from "./transfer-store";
import {
  generateUUID,
  type OutgoingRuntimeSession,
  TRANSFER_ERROR_CODES,
  type TransferMessage,
  stringifyStructuredEvent
} from "./webrtc-shared";

export async function handleIncomingFileOffer(this: any, metadata: FileMetadata): Promise<void> {
  if (!metadata.id || typeof metadata.id !== "string") {
    this.sendTransferError("", TRANSFER_ERROR_CODES.INVALID_FILE_ID, "Invalid fileId");
    return;
  }
  if (
    typeof metadata.chunkSize !== "number" ||
    metadata.chunkSize <= 0 ||
    metadata.chunkSize < ADAPTIVE_CHUNK_CONFIG.MIN_CHUNK_SIZE ||
    typeof metadata.size !== "number" ||
    metadata.size < 0
  ) {
    this.sendTransferError(metadata.id, "INVALID_METADATA", "Invalid metadata");
    return;
  }

  const uploadId = metadata.uploadId || metadata.id;
  const normalizedMetadata: FileMetadata = {
    ...metadata,
    uploadId,
    protocolVersion: metadata.protocolVersion ?? 1,
    totalChunks: calculateTotalChunks(metadata.size, metadata.chunkSize)
  };

  this.currentReceivingFileId = normalizedMetadata.id;

  if (normalizedMetadata.size > FILE_CONFIG.MEMORY_GUARD_THRESHOLD_BYTES) {
    console.warn(stringifyStructuredEvent({
      event: "transfer_receive_memory_guard_warning",
      fileId: normalizedMetadata.id,
      fileName: normalizedMetadata.name,
      fileSizeBytes: normalizedMetadata.size,
      thresholdBytes: FILE_CONFIG.MEMORY_GUARD_THRESHOLD_BYTES,
      timestamp: Date.now()
    }));
  }

  let resumeFromChunk = 0;
  let bytesReceived = 0;
  if (this.transferStore.isSupported()) {
    try {
      const sessionKey = createTransferSessionKey("incoming", uploadId);
      const existing = await this.transferStore.getSession(sessionKey);
      if (
        existing &&
        existing.fileSize === normalizedMetadata.size &&
        existing.chunkSize === normalizedMetadata.chunkSize &&
        existing.totalChunks === normalizedMetadata.totalChunks &&
        existing.status !== "completed"
      ) {
        const contiguous = await this.transferStore.getContiguousChunkCount(uploadId, normalizedMetadata.totalChunks);
        resumeFromChunk = normalizeChunkIndex(Math.min(existing.nextChunkIndex, contiguous), normalizedMetadata.totalChunks);
        bytesReceived = bytesForChunkIndex(resumeFromChunk, normalizedMetadata.chunkSize, normalizedMetadata.size);
      } else {
        await this.transferStore.deleteUpload(uploadId);
      }
    } catch (error) {
      console.warn(stringifyStructuredEvent({
        event: "transfer_resume_probe_failed",
        fileId: normalizedMetadata.id,
        uploadId,
        message: (error as Error).message,
        timestamp: Date.now()
      }));
    }
  } else {
    this.inMemoryIncomingChunks.set(normalizedMetadata.id, []);
  }

  const transfer: IncomingTransferState = {
    metadata: normalizedMetadata,
    receivedChunks: resumeFromChunk,
    bytesReceived,
    expectedChunkIndex: resumeFromChunk,
    ready: false,
    uploadId,
    expectedFileChecksum: normalizedMetadata.fileChecksum,
    chunkChecksums: [],
    writeQueue: Promise.resolve(),
    hasPersistenceError: false
  };
  this.incomingTransfers.set(normalizedMetadata.id, transfer);

  if (resumeFromChunk > 0) {
    console.log(stringifyStructuredEvent({
      event: "transfer_resume_available",
      fileId: normalizedMetadata.id,
      uploadId,
      resumeFromChunk,
      totalChunks: normalizedMetadata.totalChunks,
      timestamp: Date.now()
    }));
  }

  await this.upsertPersistedSession("incoming", normalizedMetadata, "active", resumeFromChunk, bytesReceived);
  this.sendReceiverReady(normalizedMetadata.id, uploadId, resumeFromChunk);
  this.callbacks.onFileOffer(normalizedMetadata);
}

export function processFileChunk(this: any, data: ArrayBuffer): void {
  if (!this.currentReceivingFileId) return;
  const transfer = this.incomingTransfers.get(this.currentReceivingFileId);
  if (!transfer) return;

  const fileId = this.currentReceivingFileId;
  const chunkCopy = data.slice(0);
  transfer.writeQueue = transfer.writeQueue
    .then(() => this.processFileChunkInternal(fileId, transfer, chunkCopy))
    .catch((error: unknown) => {
      this.callbacks.onError(error as Error);
    });
}

export async function processFileChunkInternal(
  this: any,
  fileId: string,
  transfer: IncomingTransferState,
  chunkData: ArrayBuffer
): Promise<void> {
  if (transfer.receivedChunks >= transfer.metadata.totalChunks) {
    console.warn(stringifyStructuredEvent({
      event: "transfer_chunk_overflow",
      fileId,
      receivedChunks: transfer.receivedChunks,
      totalChunks: transfer.metadata.totalChunks,
      timestamp: Date.now()
    }));
    return;
  }

  const chunkIndex = transfer.receivedChunks;
  const chunkGap = chunkIndex - transfer.expectedChunkIndex;
  if (chunkGap > FILE_CONFIG.MAX_CHUNK_SEQUENCE_GAP) {
    console.warn(stringifyStructuredEvent({
      event: "transfer_chunk_sequence_warning",
      fileId,
      receivedChunk: chunkIndex,
      expectedChunk: transfer.expectedChunkIndex,
      gap: chunkGap,
      timestamp: Date.now()
    }));
  }

  const chunkChecksum = await hashArrayBuffer(chunkData);
  if (this.transferStore.isSupported()) {
    try {
      await this.transferStore.putChunk(transfer.uploadId, chunkIndex, chunkData, chunkChecksum);
    } catch (error) {
      transfer.hasPersistenceError = true;
      this.sendTransferError(transfer.metadata.id, TRANSFER_ERROR_CODES.CHUNK_PERSIST_FAILED, (error as Error).message);
      throw error;
    }
  } else {
    const chunks = this.inMemoryIncomingChunks.get(fileId) ?? [];
    chunks[chunkIndex] = chunkData;
    this.inMemoryIncomingChunks.set(fileId, chunks);
  }

  transfer.chunkChecksums[chunkIndex] = chunkChecksum;
  transfer.receivedChunks += 1;
  transfer.expectedChunkIndex = transfer.receivedChunks;
  transfer.bytesReceived += chunkData.byteLength;

  await this.upsertPersistedSession(
    "incoming",
    transfer.metadata,
    "active",
    transfer.receivedChunks,
    transfer.bytesReceived
  );

  const progress = (transfer.receivedChunks / transfer.metadata.totalChunks) * 100;
  const previousProgress = ((transfer.receivedChunks - 1) / transfer.metadata.totalChunks) * 100;
  const shouldEmitProgress =
    transfer.receivedChunks === transfer.metadata.totalChunks ||
    Math.floor(progress) > Math.floor(previousProgress);

  if (shouldEmitProgress) {
    this.callbacks.onFileProgress(progress);
  }

  if ([0.25, 0.5, 0.75, 1.0].some((p) =>
    Math.abs(progress / 100 - p) < 0.01 &&
    Math.abs((transfer.receivedChunks - 1) / transfer.metadata.totalChunks - p) >= 0.01
  )) {
    console.log(stringifyStructuredEvent({
      event: "transfer_receive_progress",
      fileId,
      receivedChunks: transfer.receivedChunks,
      totalChunks: transfer.metadata.totalChunks,
      progressPercent: Math.round(progress * 100) / 100,
      timestamp: Date.now()
    }));
  }
}

export async function completeTransfer(this: any, fileId: string, checksum?: string): Promise<void> {
  const transfer = this.incomingTransfers.get(fileId);
  if (!transfer) return;

  if (checksum) {
    transfer.expectedFileChecksum = checksum;
  }

  await transfer.writeQueue;

  const expectedChecksum = transfer.expectedFileChecksum || transfer.metadata.fileChecksum;
  let blob: Blob;
  let fileChecksum: string;
  let finalizerStorageMode: "opfs" | "memory" = "memory";

  if (this.transferStore.isSupported()) {
    const chunkCount = await this.transferStore.getChunkCount(transfer.uploadId);
    if (chunkCount < transfer.metadata.totalChunks) {
      const contiguous = await this.transferStore.getContiguousChunkCount(transfer.uploadId, transfer.metadata.totalChunks);
      await this.requestRetransmit(transfer, contiguous, "missing_chunks");
      return;
    }

    const finalized = await finalizeIncomingTransferFromStore({
      transferStore: this.transferStore,
      uploadId: transfer.uploadId,
      metadata: transfer.metadata,
      expectedChecksum
    });

    if (!finalized.ok) {
      if (finalized.reason === "missing_chunk") {
        await this.requestRetransmit(transfer, finalized.missingChunk, "missing_chunks_streaming");
        return;
      }

      console.warn(stringifyStructuredEvent({
        event: "transfer_checksum_mismatch",
        fileId,
        uploadId: transfer.uploadId,
        expectedChecksum,
        actualChecksum: finalized.fileChecksum,
        timestamp: Date.now()
      }));
      await this.requestRetransmit(transfer, 0, TRANSFER_ERROR_CODES.CHECKSUM_MISMATCH);
      return;
    }

    blob = finalized.blob;
    fileChecksum = finalized.fileChecksum;
    finalizerStorageMode = finalized.storageMode;
  } else {
    const chunkBuffers = this.inMemoryIncomingChunks.get(fileId) ?? [];
    if (chunkBuffers.length < transfer.metadata.totalChunks) {
      await this.requestRetransmit(transfer, chunkBuffers.length, "missing_chunks_memory_fallback");
      return;
    }

    const chunkChecksums = await Promise.all(
      chunkBuffers.map((buffer: ArrayBuffer) => hashArrayBuffer(buffer))
    );
    fileChecksum = await deriveFileChecksumFromChunkChecksums(chunkChecksums);
    if (expectedChecksum && fileChecksum !== expectedChecksum) {
      console.warn(stringifyStructuredEvent({
        event: "transfer_checksum_mismatch",
        fileId,
        uploadId: transfer.uploadId,
        expectedChecksum,
        actualChecksum: fileChecksum,
        timestamp: Date.now()
      }));
      await this.requestRetransmit(transfer, 0, TRANSFER_ERROR_CODES.CHECKSUM_MISMATCH);
      return;
    }

    blob = new Blob(chunkBuffers, { type: transfer.metadata.type });
  }

  this.callbacks.onFileComplete(blob, transfer.metadata);

  console.log(stringifyStructuredEvent({
    event: "transfer_receive_complete",
    fileId,
    uploadId: transfer.uploadId,
    fileName: transfer.metadata.name,
    fileSizeBytes: transfer.metadata.size,
    receivedChunks: transfer.receivedChunks,
    totalChunks: transfer.metadata.totalChunks,
    bytesReceived: transfer.bytesReceived,
    fileChecksum,
    finalizerStorageMode,
    timestamp: Date.now()
  }));

  if (this.transferStore.isSupported()) {
    await this.transferStore.deleteUpload(transfer.uploadId);
  }
  this.inMemoryIncomingChunks.delete(fileId);
  this.incomingTransfers.delete(fileId);
  if (this.currentReceivingFileId === fileId) {
    this.currentReceivingFileId = null;
  }
}

export async function requestRetransmit(
  this: any,
  transfer: IncomingTransferState,
  fromChunk: number,
  reason: string
): Promise<void> {
  const startChunk = normalizeChunkIndex(fromChunk, transfer.metadata.totalChunks);
  transfer.receivedChunks = startChunk;
  transfer.expectedChunkIndex = startChunk;
  transfer.bytesReceived = bytesForChunkIndex(startChunk, transfer.metadata.chunkSize, transfer.metadata.size);
  transfer.chunkChecksums = transfer.chunkChecksums.slice(0, startChunk);

  if (this.transferStore.isSupported()) {
    await this.transferStore.deleteChunksFrom(transfer.uploadId, startChunk);
  } else {
    const chunks = this.inMemoryIncomingChunks.get(transfer.metadata.id) ?? [];
    chunks.length = startChunk;
    this.inMemoryIncomingChunks.set(transfer.metadata.id, chunks);
  }

  await this.upsertPersistedSession(
    "incoming",
    transfer.metadata,
    "active",
    startChunk,
    transfer.bytesReceived
  );

  if (this.isDataChannelReady()) {
    this.dataChannel!.send(JSON.stringify({
      type: "request-retransmit",
      fileId: transfer.metadata.id,
      uploadId: transfer.uploadId,
      fromChunk: startChunk,
      reason
    } satisfies TransferMessage));
  }

  console.warn(stringifyStructuredEvent({
    event: "transfer_retransmit_requested",
    fileId: transfer.metadata.id,
    uploadId: transfer.uploadId,
    fromChunk: startChunk,
    reason,
    timestamp: Date.now()
  }));
}

/**
 * 等待背压解除（事件驱动 + 轮询回退）
 * @returns 使用的模式：'event' 或 'polling'
 */
export async function waitForBackpressure(this: any): Promise<"event" | "polling"> {
  if (!this.isDataChannelReady()) {
    throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
  }

  const runtimeMode = this.backpressureRuntimeMode;

  // 强制轮询模式
  if (runtimeMode === "polling") {
    while ((this.dataChannel?.bufferedAmount ?? 0) > this.backpressureMaxBufferedAmount) {
      if (!this.isDataChannelReady()) {
        throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
      }
      await new Promise(resolve => setTimeout(resolve, BACKPRESSURE_CONFIG.POLL_INTERVAL_MS));
    }
    return "polling";
  }

  // 事件驱动模式（优先）或自动模式
  if (runtimeMode === "event" || runtimeMode === "auto") {
    // 检查是否支持 bufferedamountlow 事件
    const supportsEvent = this.dataChannel ? "onbufferedamountlow" in this.dataChannel : false;

    if (supportsEvent && !this.backpressureFallbackReason) {
      try {
        const result = await new Promise<"event">((resolve, reject) => {
          const channel = this.dataChannel!;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          const cleanup = () => {
            channel.onbufferedamountlow = null;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
          };

          channel.onbufferedamountlow = () => {
            cleanup();
            resolve("event");
          };

          timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("event_timeout"));
          }, BACKPRESSURE_CONFIG.EVENT_TIMEOUT_MS);

          if (channel.bufferedAmount <= this.backpressureMaxBufferedAmount) {
            cleanup();
            resolve("event");
          }
        });

        // 如果首次成功使用事件模式，记录日志
        if (this.backpressureMode === "polling" && result === "event") {
          this.backpressureMode = "event";
          console.log(stringifyStructuredEvent({
            event: "backpressure_mode_active",
            mode: "event",
            threshold: this.backpressureLowThreshold,
            timestamp: Date.now()
          }));
        }

        return result;
      } catch (e) {
        // 事件模式失败，回退到轮询
        this.backpressureFallbackReason = (e as Error).message;
        this.backpressureMode = "polling";
        console.log(stringifyStructuredEvent({
          event: "backpressure_fallback",
          fromMode: "event",
          toMode: "polling",
          reason: this.backpressureFallbackReason,
          timestamp: Date.now()
        }));
      }
    }
  }

  // 轮询回退（通用路径）
  while ((this.dataChannel?.bufferedAmount ?? 0) > this.backpressureMaxBufferedAmount) {
    if (!this.isDataChannelReady()) {
      throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
    }
    await new Promise(resolve => setTimeout(resolve, BACKPRESSURE_CONFIG.POLL_INTERVAL_MS));
  }

  return "polling";
}

export async function sendFile(this: any, file: File): Promise<void> {
  if (!this.isDataChannelReady()) {
    throw new Error("数据通道未就绪");
  }

  const fingerprint = createFileFingerprint(file);
  const transferStartTime = performance.now();
  let backpressureWaitMs = 0;
  let backpressureEvents = 0;
  let eventWaitMs = 0;
  let pollingIdleWaitMs = 0;
  let eventDrivenWaits = 0;
  let pollingWaits = 0;
  let didEmitStart = false;
  let attempt = 0;
  const resumeDeadline = Date.now() + RESUME_CONFIG.AUTO_RESUME_MAX_WAIT_MS;

  while (true) {
    attempt += 1;
    let uploadId = generateUUID();
    let localResumeChunk = 0;
    let configuredChunkSize = FILE_CONFIG.CHUNK_SIZE;

    if (this.transferStore.isSupported()) {
      const resumableSession = await this.transferStore.findOutgoingSessionByFingerprint(fingerprint, this.remotePeerId);
      console.log(stringifyStructuredEvent({
        event: "transfer_resume_lookup",
        fingerprint,
        remotePeerId: this.remotePeerId,
        found: Boolean(resumableSession),
        foundUploadId: resumableSession?.uploadId ?? null,
        foundNextChunkIndex: resumableSession?.nextChunkIndex ?? null,
        foundStatus: resumableSession?.status ?? null,
        attempt,
        timestamp: Date.now()
      }));
      if (
        resumableSession &&
        resumableSession.fileSize === file.size &&
        resumableSession.status !== "completed"
      ) {
        uploadId = resumableSession.uploadId;
        configuredChunkSize = resumableSession.chunkSize;
        localResumeChunk = resumableSession.nextChunkIndex;
      }
    }

    const chunkPlan = await this.resolveChunkPlan(configuredChunkSize);
    const chunkSize = Math.max(ADAPTIVE_CHUNK_CONFIG.MIN_CHUNK_SIZE, chunkPlan.chunkSize);
    const totalChunks = calculateTotalChunks(file.size, chunkSize);
    const metadata: FileMetadata = {
      id: uploadId,
      uploadId,
      protocolVersion: 2,
      name: file.name,
      size: file.size,
      type: file.type,
      totalChunks,
      chunkSize,
      fingerprint
    };

    if (!didEmitStart) {
      didEmitStart = true;
      console.log(stringifyStructuredEvent({
        event: "transfer_send_start",
        fileId: metadata.id,
        uploadId,
        fileName: file.name,
        fileSizeBytes: file.size,
        totalChunks,
        chunkSizeUsed: chunkSize,
        selectedRttMs: chunkPlan.rttMs,
        messageLimitBytes: chunkPlan.messageLimit,
        chunkPlanReason: chunkPlan.reason,
        attempt,
        timestamp: Date.now()
      }));
    } else {
      console.log(stringifyStructuredEvent({
        event: "transfer_auto_resume_attempt",
        fileId: metadata.id,
        uploadId,
        attempt,
        localResumeChunk,
        totalChunks,
        timestamp: Date.now()
      }));
    }

    // Task 4: 注册发送传输并等待 receiver-ready
    let readyResolver: (() => void) | null = null;
    let readyRejecter: ((error: Error) => void) | null = null;

    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolver = resolve;
      readyRejecter = reject;
    });

    const timeoutId = setTimeout(() => {
      const outgoing = this.outgoingTransfers.get(metadata.id);
      if (outgoing && !outgoing.readyReceived) {
        console.error(stringifyStructuredEvent({
          event: "transfer_timeout",
          errorCode: TRANSFER_ERROR_CODES.TRANSFER_TIMEOUT,
          fileId: metadata.id,
          uploadId,
          timeoutMs: FILE_CONFIG.RECEIVER_READY_TIMEOUT_MS,
          attempt,
          timestamp: Date.now()
        }));
        this.outgoingTransfers.delete(metadata.id);
        readyRejecter?.(new Error(`${TRANSFER_ERROR_CODES.TRANSFER_TIMEOUT}: Receiver did not respond with ready signal within ${FILE_CONFIG.RECEIVER_READY_TIMEOUT_MS}ms`));
      }
    }, FILE_CONFIG.RECEIVER_READY_TIMEOUT_MS);

    this.outgoingTransfers.set(metadata.id, {
      metadata,
      readyReceived: false,
      timeoutId,
      startTime: performance.now(),
      resolve: readyResolver,
      reject: readyRejecter,
      resumeFromChunk: 0,
      uploadId
    });

    const existingRuntimeSession = this.outgoingRuntimeSessions.get(uploadId);
    if (existingRuntimeSession) {
      existingRuntimeSession.file = file;
      existingRuntimeSession.metadata = metadata;
      existingRuntimeSession.status = "active";
      existingRuntimeSession.remotePeerId = this.remotePeerId;
      existingRuntimeSession.fingerprint = fingerprint;
      existingRuntimeSession.fileChecksum = null;
      existingRuntimeSession.attemptCount = attempt;
    } else {
      this.outgoingRuntimeSessions.set(uploadId, {
        uploadId,
        file,
        metadata,
        chunkChecksums: [],
        fileChecksum: null,
        status: "active",
        remotePeerId: this.remotePeerId,
        fingerprint,
        attemptCount: attempt
      });
    }

    await this.upsertPersistedSession(
      "outgoing",
      metadata,
      "active",
      localResumeChunk,
      bytesForChunkIndex(localResumeChunk, chunkSize, file.size),
      { fingerprint }
    );

    try {
      if (!this.isDataChannelReady()) {
        throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
      }

      const channel = this.dataChannel!;
      try {
        channel.send(JSON.stringify({ type: "file-offer", metadata }));
      } catch {
        throw createRecoverableTransferError("DATA_CHANNEL_SEND_FAILED", "数据通道断开，进度已保存，可重连后继续续传");
      }

      // 等待 receiver-ready 或超时
      let negotiatedResumeChunk = 0;
      await readyPromise;
      const outgoing = this.outgoingTransfers.get(metadata.id);
      negotiatedResumeChunk = outgoing?.resumeFromChunk ?? 0;

      const startChunk = normalizeChunkIndex(
        Math.max(localResumeChunk, negotiatedResumeChunk),
        totalChunks
      );
      let sentBytes = bytesForChunkIndex(startChunk, chunkSize, file.size);
      let lastSendProgressPercent = 0;

      console.log(stringifyStructuredEvent({
        event: "transfer_resume_negotiated",
        fileId: metadata.id,
        uploadId,
        localResumeChunk,
        remoteResumeChunk: negotiatedResumeChunk,
        startChunk,
        totalChunks,
        attempt,
        timestamp: Date.now()
      }));

      for (let i = startChunk; i < totalChunks; i++) {
        if (!this.isDataChannelReady()) {
          throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const buffer = await file.slice(start, end).arrayBuffer();

        const maxMessageSize = this.resolveMaxMessageSize();
        if (maxMessageSize !== null && buffer.byteLength > maxMessageSize) {
          throw new Error(`${TRANSFER_ERROR_CODES.MESSAGE_TOO_LARGE}: chunk=${buffer.byteLength}, max=${maxMessageSize}`);
        }

        if (channel.bufferedAmount > this.getBackpressureWaitThreshold()) {
          const waitStart = performance.now();
          const mode = await this.waitForBackpressure();
          const waitDuration = performance.now() - waitStart;

          backpressureWaitMs += waitDuration;
          backpressureEvents++;

          if (mode === "event") {
            eventDrivenWaits++;
            eventWaitMs += waitDuration;
          } else {
            pollingWaits++;
            pollingIdleWaitMs += waitDuration;
          }
        }

        try {
          channel.send(buffer);
        } catch {
          throw createRecoverableTransferError("DATA_CHANNEL_SEND_FAILED", "数据通道断开，进度已保存，可重连后继续续传");
        }

        sentBytes += buffer.byteLength;

        const runtimeSession = this.outgoingRuntimeSessions.get(uploadId);
        if (runtimeSession) {
          runtimeSession.chunkChecksums[i] = await hashArrayBuffer(buffer);
        }

        await this.upsertPersistedSession("outgoing", metadata, "active", i + 1, sentBytes, { fingerprint });

        const currentProgressPercent = (sentBytes / file.size) * 100;
        const shouldEmitSendProgress =
          i === totalChunks - 1 ||
          Math.floor(currentProgressPercent) > Math.floor(lastSendProgressPercent);

        if (shouldEmitSendProgress) {
          this.callbacks.onSendProgress(metadata, sentBytes, file.size);
          lastSendProgressPercent = currentProgressPercent;
        }
      }

      const runtimeSession = this.outgoingRuntimeSessions.get(uploadId);
      const fileChecksum = runtimeSession
        ? await this.ensureRuntimeSessionChecksum(runtimeSession)
        : await deriveFileChecksumFromChunkChecksums([]);

      if (!this.isDataChannelReady()) {
        throw createRecoverableTransferError("DATA_CHANNEL_NOT_READY", "数据通道断开，进度已保存，可重连后继续续传");
      }

      try {
        this.dataChannel!.send(JSON.stringify({
          type: "transfer-complete",
          fileId: metadata.id,
          uploadId,
          checksum: fileChecksum
        } satisfies TransferMessage));
      } catch {
        throw createRecoverableTransferError("DATA_CHANNEL_SEND_FAILED", "数据通道断开，进度已保存，可重连后继续续传");
      }

      if (runtimeSession) {
        runtimeSession.fileChecksum = fileChecksum;
        runtimeSession.status = "completed";
      }

      await this.upsertPersistedSession("outgoing", metadata, "completed", totalChunks, file.size, {
        fingerprint,
        fileChecksum
      });

      this.callbacks.onSendComplete(metadata);

      const transferEndTime = performance.now();
      const transferMs = Math.round(transferEndTime - transferStartTime);
      const avgMbps = ((file.size * 8) / (transferMs / 1000)) / (1024 * 1024);

      console.log(stringifyStructuredEvent({
        event: "transfer_send_complete",
        fileId: metadata.id,
        uploadId,
        fileName: file.name,
        fileSizeBytes: file.size,
        transferMs,
        avgMbps: Math.round(avgMbps * 100) / 100,
        backpressureWaitMs: Math.round(backpressureWaitMs),
        eventWaitMs: Math.round(eventWaitMs),
        pollingIdleWaitMs: Math.round(pollingIdleWaitMs),
        backpressureEvents,
        backpressureMode: this.backpressureMode,
        eventDrivenWaits,
        pollingWaits,
        fallbackReason: this.backpressureFallbackReason,
        chunkSizeUsed: chunkSize,
        selectedRttMs: chunkPlan.rttMs,
        messageLimitBytes: chunkPlan.messageLimit,
        resumedFromChunk: startChunk,
        attemptCount: attempt,
        timestamp: Date.now()
      }));
      return;
    } catch (error) {
      const isTransferTimeout =
        error instanceof Error && error.message.startsWith(TRANSFER_ERROR_CODES.TRANSFER_TIMEOUT);
      const recoverable = this.isRecoverableSendInterruption(error) || isTransferTimeout;
      console.error(stringifyStructuredEvent({
        event: "transfer_send_interrupted",
        fileId: metadata.id,
        uploadId,
        message: (error as Error).message,
        recoverable,
        attempt,
        timestamp: Date.now()
      }));

      if (!recoverable) {
        const runtime = this.outgoingRuntimeSessions.get(uploadId);
        if (runtime) {
          runtime.status = "failed";
        }
        throw error;
      }

      const remainingMs = resumeDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("AUTO_RESUME_TIMEOUT: 重连等待超时，请重新选择文件发送");
      }

      console.log(stringifyStructuredEvent({
        event: "transfer_auto_resume_waiting",
        fileId: metadata.id,
        uploadId,
        remainingMs,
        attempt,
        timestamp: Date.now()
      }));
      await this.waitForDataChannelReady(remainingMs);
    } finally {
      const outgoing = this.outgoingTransfers.get(metadata.id);
      if (outgoing?.timeoutId) {
        clearTimeout(outgoing.timeoutId);
        outgoing.timeoutId = null;
      }
      this.outgoingTransfers.delete(metadata.id);
    }
  }
}

export async function ensureRuntimeSessionChecksum(this: any, session: OutgoingRuntimeSession): Promise<string> {
  if (session.fileChecksum) {
    return session.fileChecksum;
  }

  if (session.chunkChecksums.filter(Boolean).length < session.metadata.totalChunks) {
    for (let i = 0; i < session.metadata.totalChunks; i++) {
      if (session.chunkChecksums[i]) continue;
      const start = i * session.metadata.chunkSize;
      const end = Math.min(start + session.metadata.chunkSize, session.file.size);
      const buffer = await session.file.slice(start, end).arrayBuffer();
      session.chunkChecksums[i] = await hashArrayBuffer(buffer);
    }
  }

  session.fileChecksum = await deriveFileChecksumFromChunkChecksums(session.chunkChecksums);
  return session.fileChecksum;
}

export function sendReceiverReady(this: any, fileId: string, uploadId: string, resumeFromChunk: number): void {
  if (!this.isDataChannelReady()) return;

  const transfer = this.incomingTransfers.get(fileId);
  if (transfer) {
    transfer.ready = true;
  }

  this.dataChannel!.send(JSON.stringify({
    type: "receiver-ready",
    fileId,
    uploadId,
    resumeFromChunk
  }));

  console.log(stringifyStructuredEvent({
    event: "transfer_receiver_ready_sent",
    fileId,
    uploadId,
    resumeFromChunk,
    timestamp: Date.now()
  }));
}

// Task 4: 处理 receiver-ready 信号（发送方）
export function handleReceiverReady(this: any, fileId: string, resumeFromChunk?: number, uploadId?: string): void {
  const outgoing = this.outgoingTransfers.get(fileId);
  if (!outgoing) return;

  if (uploadId && uploadId !== outgoing.uploadId) {
    console.warn(stringifyStructuredEvent({
      event: "transfer_receiver_ready_upload_mismatch",
      fileId,
      expectedUploadId: outgoing.uploadId,
      actualUploadId: uploadId,
      timestamp: Date.now()
    }));
    return;
  }

  // 清除超时定时器
  if (outgoing.timeoutId) {
    clearTimeout(outgoing.timeoutId);
    outgoing.timeoutId = null;
  }

  const normalizedResumeChunk = normalizeChunkIndex(
    resumeFromChunk ?? 0,
    outgoing.metadata.totalChunks
  );
  outgoing.readyReceived = true;
  outgoing.resumeFromChunk = normalizedResumeChunk;
  outgoing.resolve?.();
  console.log(stringifyStructuredEvent({
    event: "transfer_receiver_ready_received",
    fileId,
    uploadId: outgoing.uploadId,
    resumeFromChunk: normalizedResumeChunk,
    waitTimeMs: Math.round(performance.now() - outgoing.startTime),
    timestamp: Date.now()
  }));
}

export async function handleRetransmitRequest(this: any, message: TransferMessage): Promise<void> {
  const fileId = message.fileId;
  if (!fileId) return;

  const uploadId = message.uploadId || fileId;
  const runtimeSession = this.outgoingRuntimeSessions.get(uploadId);
  if (!runtimeSession) {
    this.sendTransferError(fileId, TRANSFER_ERROR_CODES.RETRANSMIT_NOT_SUPPORTED, "Session not found");
    return;
  }
  if (!this.isDataChannelReady()) {
    this.sendTransferError(fileId, TRANSFER_ERROR_CODES.RECEIVER_NOT_READY, "Data channel not open");
    return;
  }

  const startChunk = normalizeChunkIndex(
    message.fromChunk ?? 0,
    runtimeSession.metadata.totalChunks
  );
  const channel = this.dataChannel!;

  console.log(stringifyStructuredEvent({
    event: "transfer_retransmit_start",
    fileId,
    uploadId,
    fromChunk: startChunk,
    reason: message.reason,
    timestamp: Date.now()
  }));

  for (let i = startChunk; i < runtimeSession.metadata.totalChunks; i++) {
    const start = i * runtimeSession.metadata.chunkSize;
    const end = Math.min(start + runtimeSession.metadata.chunkSize, runtimeSession.file.size);
    const buffer = await runtimeSession.file.slice(start, end).arrayBuffer();

    if (channel.bufferedAmount > this.getBackpressureWaitThreshold()) {
      await this.waitForBackpressure();
    }
    channel.send(buffer);
  }

  const fileChecksum = await this.ensureRuntimeSessionChecksum(runtimeSession);
  channel.send(JSON.stringify({
    type: "transfer-complete",
    fileId: runtimeSession.metadata.id,
    uploadId,
    checksum: fileChecksum
  } satisfies TransferMessage));

  console.log(stringifyStructuredEvent({
    event: "transfer_retransmit_complete",
    fileId,
    uploadId,
    fromChunk: startChunk,
    timestamp: Date.now()
  }));
}

export function sendTransferError(this: any, fileId: string, code: string, message: string): void {
  if (!this.isDataChannelReady()) return;

  this.dataChannel!.send(JSON.stringify({
    type: "transfer-error",
    fileId,
    error: { code, message }
  }));
}
