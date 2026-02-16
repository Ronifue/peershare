/**
 * PeerShare - WebRTC 共享类型与工具
 */

import { createStructuredEventEnvelope } from "../common/structured-event";
import type {
  FileMetadata,
  IncomingTransferState,
  OutgoingTransferState
} from "../common/types";
import type { PersistedTransferStatus } from "./transfer-store";

export type BackpressureRuntimeMode = "event" | "polling" | "auto";

export const TRANSFER_CONTROL_PARSE_ERROR_CODE = "TRANSFER_CONTROL_PARSE_ERROR";

export const TRANSFER_ERROR_CODES = {
  TRANSFER_TIMEOUT: "TRANSFER_TIMEOUT",
  RECEIVER_NOT_READY: "RECEIVER_NOT_READY",
  INVALID_FILE_ID: "INVALID_FILE_ID",
  INVALID_CHUNK_SEQUENCE: "INVALID_CHUNK_SEQUENCE",
  RECEIVER_BUFFER_EXHAUSTED: "RECEIVER_BUFFER_EXHAUSTED",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  CHUNK_PERSIST_FAILED: "CHUNK_PERSIST_FAILED",
  MESSAGE_TOO_LARGE: "MESSAGE_TOO_LARGE",
  RETRANSMIT_NOT_SUPPORTED: "RETRANSMIT_NOT_SUPPORTED"
} as const;

export interface ConnectionCallbacks {
  onStateChange: (state: RTCPeerConnectionState, iceState: RTCSignalingState) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onFileOffer: (metadata: FileMetadata) => void;
  onFileProgress: (progress: number) => void;
  onFileComplete: (blob: Blob, metadata: FileMetadata) => void;
  onSendProgress: (metadata: FileMetadata, sentBytes: number, totalBytes: number) => void;
  onSendComplete: (metadata: FileMetadata) => void;
  onError: (error: Error) => void;
}

export interface TransferMessage {
  type:
    | "file-offer"
    | "receiver-ready"
    | "transfer-complete"
    | "transfer-error"
    | "request-retransmit";
  metadata?: FileMetadata;
  fileId?: string;
  uploadId?: string;
  resumeFromChunk?: number;
  fromChunk?: number;
  checksum?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface OutgoingRuntimeSession {
  uploadId: string;
  file: File;
  metadata: FileMetadata;
  chunkChecksums: string[];
  fileChecksum: string | null;
  status: PersistedTransferStatus;
  remotePeerId: string;
  fingerprint: string;
  attemptCount: number;
}

export interface P2PTransferState {
  incomingTransfers: Map<string, IncomingTransferState>;
  inMemoryIncomingChunks: Map<string, ArrayBuffer[]>;
  outgoingTransfers: Map<string, OutgoingTransferState>;
  outgoingRuntimeSessions: Map<string, OutgoingRuntimeSession>;
}

export function stringifyStructuredEvent(payload: {
  event: string;
  timestamp?: number;
  [key: string]: unknown;
}): string {
  const { event, timestamp = Date.now(), ...eventPayload } = payload;
  return JSON.stringify(createStructuredEventEnvelope(event, eventPayload, timestamp));
}

/**
 * 生成 RFC 4122 兼容的 UUID v4
 * 使用 crypto.getRandomValues 以确保在非安全上下文（HTTP）下也能工作
 */
export function generateUUID(): string {
  // @ts-ignore - 兼容旧版浏览器或非安全上下文
  return ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}
