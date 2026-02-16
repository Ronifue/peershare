/**
 * PeerShare - 共享类型定义
 * 
 * 核心概念:
 * - SignalMessage: WebSocket 信令消息
 * - PeerConnection: WebRTC 连接状态
 * - FileChunk: 文件传输分块
 */

// WebSocket 信令消息类型
export type SignalType = 
  | 'register'      // 客户端注册
  | 'offer'         // SDP 提议
  | 'answer'        // SDP 应答
  | 'ice-candidate' // ICE 候选
  | 'peer-joined'   // 对端加入
  | 'peer-left'     // 对端离开
  | 'error';        // 错误

// 信令消息接口
export interface SignalMessage {
  type: SignalType;
  roomId: string;
  peerId: string;
  targetId?: string;
  payload?: RTCSessionDescriptionInit | RTCIceCandidateInit | string | ErrorPayload | { roomId: string; isCreator: boolean };
  timestamp: number;
}

// 错误负载
export interface ErrorPayload {
  code: string;
  message: string;
}

// 房间信息
export interface Room {
  id: string;
  peers: Set<string>;
  createdAt: number;
}

// 文件元数据
export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
  chunkSize: number;
  // 续传会话标识（跨重连保持稳定）
  uploadId?: string;
  // 协议版本，用于兼容旧客户端
  protocolVersion?: number;
  // 发送端生成的文件级校验和（由块级校验和派生）
  fileChecksum?: string;
  // 发送端文件指纹，用于本地断点续传会话匹配
  fingerprint?: string;
}

// 文件传输状态 - 入站传输（接收端）
// 反映 webrtc.ts 中 incomingTransfers Map 的运行时结构
export interface IncomingTransferState {
  metadata: FileMetadata;
  receivedChunks: number;
  bytesReceived: number; // 实际接收的字节数（完整性检查）
  expectedChunkIndex: number; // 下一个期望的块序号（顺序验证）
  ready: boolean; // receiver-ready 信号已发送
  uploadId: string;
  expectedFileChecksum?: string;
  chunkChecksums: string[];
  writeQueue: Promise<void>;
  hasPersistenceError: boolean;
}

// 文件传输状态 - 出站传输（发送端）
// 反映 webrtc.ts 中 outgoingTransfers Map 的运行时结构
export interface OutgoingTransferState {
  metadata: FileMetadata;
  readyReceived: boolean; // 收到 receiver-ready 信号
  timeoutId: ReturnType<typeof setTimeout> | null; // 等待 ready 的超时定时器
  startTime: number; // 传输开始时间戳
  resolve: (() => void) | null; // ready 等待的 resolve 函数
  reject: ((error: Error) => void) | null; // ready 等待的 reject 函数
  resumeFromChunk: number; // 恢复协商结果：从哪个块继续发送
  uploadId: string; // 续传会话标识
}

// 向后兼容：保留 TransferState 别名指向 IncomingTransferState
// @deprecated 使用 IncomingTransferState 或 OutgoingTransferState
export type TransferState = IncomingTransferState;

// ICE 服务器配置
export interface IceServerConfig {
  urls: string | string[];
}

// RTC 配置
export interface RTCConfiguration {
  iceServers: IceServerConfig[];
  iceCandidatePoolSize: number;
  iceTransportPolicy: 'all' | 'relay';
  bundlePolicy: 'balanced' | 'max-bundle' | 'max-compat';
  rtcpMuxPolicy: 'require';
}


// 对等连接状态
export interface PeerConnectionState {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  dataChannelState: RTCDataChannelState;
}
