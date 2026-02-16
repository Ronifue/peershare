/**
 * PeerShare - WebRTC 信令与数据通道模块
 */

import { DEFAULT_RTC_CONFIG } from "../common/config";
import type { SignalMessage } from "../common/types";
import {
  TRANSFER_CONTROL_PARSE_ERROR_CODE,
  type TransferMessage,
  stringifyStructuredEvent
} from "./webrtc-shared";

export async function handleSignalingMessage(
  this: any,
  message: SignalMessage,
  resolve?: (value: string) => void,
  reject?: (reason: Error) => void
): Promise<void> {
  console.log("[信令]", message.type, "from:", message.peerId);

  try {
    switch (message.type) {
      case "register": {
        if (typeof message.payload === "string") {
          // 第一步：获得 peerId
          this.peerId = message.payload;
          console.log("[信令] peerId:", this.peerId);

          // 注册到房间
          this.sendSignal({
            type: "register",
            roomId: this.roomId,
            peerId: this.peerId,
            timestamp: Date.now()
          });
        } else if (message.payload && typeof message.payload === "object") {
          // 第二步：房间注册完成
          const { roomId, isCreator } = message.payload as { roomId: string; isCreator: boolean };
          this.roomId = roomId;
          this.isInitiator = isCreator;

          console.log(`[房间] ${roomId}, 创建者: ${isCreator}`);

          this.clearConnectTimeout();

          // 初始化 WebRTC
          this.initConnection();

          // 创建者：创建数据通道并等待对方加入
          // 加入者：等待 offer
          if (isCreator) {
            this.createDataChannel();
          }

          resolve?.(roomId);
        }
        break;
      }

      case "peer-joined": {
        this.remotePeerId = message.peerId;
        this.iceFailureCount = 0;
        console.log("[P2P] 对方已加入:", this.remotePeerId);

        if (this.isInitiator) {
          this.initConnection();
          this.createDataChannel();
          console.log("[P2P] 创建者发送 offer");
          await this.sendOffer();
        }
        break;
      }

      case "peer-left": {
        console.log("[P2P] 对方离开");
        this.cleanupPeerConnection();
        this.callbacks.onDataChannelClose();
        break;
      }

      case "offer": {
        if (message.peerId) {
          this.remotePeerId = message.peerId;
          console.log("[P2P] 更新对方 peerId (from offer):", this.remotePeerId);
        }

        if (!this.isPeerConnectionValid()) {
          console.log("[WebRTC] PC 不可用，重新初始化以处理 offer");
          this.initConnection();
        }

        await this.handleOffer(message.payload as RTCSessionDescriptionInit);
        break;
      }

      case "answer": {
        await this.handleAnswer(message.payload as RTCSessionDescriptionInit);
        break;
      }

      case "ice-candidate": {
        await this.handleIceCandidate(message.payload as RTCIceCandidateInit);
        break;
      }

      case "error": {
        const err = message.payload as { message: string };
        this.clearConnectTimeout();
        reject?.(new Error(err.message));
        this.callbacks.onError(new Error(err.message));
        break;
      }
    }
  } catch (error) {
    console.error("[信令错误]", error);
    this.callbacks.onError(error as Error);
  }
}

export function initConnection(this: any): void {
  this.cleanup();
  console.log("[WebRTC] 初始化");

  const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG as RTCConfiguration);
  this.pc = pc;

  pc.onconnectionstatechange = () => {
    if (this.pc !== pc) return;
    const state = pc.connectionState;
    const signalingState = pc.signalingState;
    console.log(stringifyStructuredEvent({
      event: "connection_state_change",
      connectionState: state,
      signalingState,
      timestamp: Date.now()
    }));
    this.callbacks.onStateChange(state, signalingState);
  };

  pc.oniceconnectionstatechange = () => {
    if (this.pc !== pc) return;
    const state = pc.iceConnectionState;

    console.log(stringifyStructuredEvent({
      event: "ice_state_change",
      state,
      iceFailureCount: this.iceFailureCount,
      restartIceAttempts: this.restartIceAttempts,
      rebuildAttempts: this.rebuildAttempts,
      isInitiator: this.isInitiator,
      isRecoveryInProgress: this.isRecoveryInProgress,
      timestamp: Date.now()
    }));

    if (state === "failed") {
      this.handleIceFailure();
    } else if (state === "disconnected") {
      this.handleIceDisconnected(pc);
    } else if (state === "connected") {
      this.handleIceConnected();
    }
  };

  pc.onicecandidate = (event) => {
    if (this.pc !== pc) return;
    if (event.candidate) {
      console.log("[WebRTC] ICE 候选:", event.candidate.type);
      this.sendSignal({
        type: "ice-candidate",
        roomId: this.roomId,
        peerId: this.peerId,
        targetId: this.remotePeerId,
        payload: event.candidate.toJSON(),
        timestamp: Date.now()
      });
    } else {
      console.log("[WebRTC] ICE 收集完成");
    }
  };

  if (!this.isInitiator) {
    pc.ondatachannel = (event) => {
      if (this.pc !== pc) return;
      console.log("[WebRTC] 收到数据通道");
      this.setupDataChannel(event.channel);
    };
  }
}

export function createDataChannel(this: any): void {
  if (!this.pc) return;

  console.log("[WebRTC] 创建数据通道");
  const channel = this.pc.createDataChannel("fileTransfer", {
    ordered: true
  });
  this.setupDataChannel(channel);
}

export async function sendOffer(this: any): Promise<void> {
  if (!this.pc) return;

  try {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.sendSignal({
      type: "offer",
      roomId: this.roomId,
      peerId: this.peerId,
      targetId: this.remotePeerId,
      payload: offer,
      timestamp: Date.now()
    });

    console.log("[WebRTC] offer 已发送");
  } catch (error) {
    console.error("[WebRTC] 创建 offer 失败:", error);
    throw error;
  }
}

export async function handleOffer(this: any, offer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;

  console.log("[WebRTC] 收到 offer");

  try {
    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;

    // 处理缓冲的候选
    await this.flushPendingCandidates();

    // 创建 answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.sendSignal({
      type: "answer",
      roomId: this.roomId,
      peerId: this.peerId,
      targetId: this.remotePeerId,
      payload: answer,
      timestamp: Date.now()
    });

    console.log("[WebRTC] answer 已发送");
  } catch (error) {
    console.error("[WebRTC] 处理 offer 失败:", error);
    throw error;
  }
}

export async function handleAnswer(this: any, answer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;

  console.log("[WebRTC] 收到 answer");

  try {
    await this.pc.setRemoteDescription(answer);
    this.remoteDescriptionSet = true;

    // 处理缓冲的候选
    await this.flushPendingCandidates();

    console.log("[WebRTC] 协商完成");
  } catch (error) {
    console.error("[WebRTC] 处理 answer 失败:", error);
    throw error;
  }
}

export async function handleIceCandidate(this: any, candidate: RTCIceCandidateInit): Promise<void> {
  if (!this.remoteDescriptionSet) {
    this.pendingCandidates.push(candidate);
    return;
  }

  await this.addIceCandidate(candidate);
}

export async function addIceCandidate(this: any, candidate: RTCIceCandidateInit): Promise<void> {
  if (!this.pc) return;

  try {
    await this.pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn("[WebRTC] 添加候选失败:", err);
  }
}

export async function flushPendingCandidates(this: any): Promise<void> {
  for (const candidate of this.pendingCandidates) {
    await this.addIceCandidate(candidate);
  }
  this.pendingCandidates = [];
}

export function setupDataChannel(this: any, channel: RTCDataChannel): void {
  this.dataChannel = channel;

  // 设置 bufferedAmountLowThreshold 用于事件驱动背压控制
  try {
    channel.bufferedAmountLowThreshold = this.backpressureLowThreshold;
  } catch (e) {
    console.log(stringifyStructuredEvent({
      event: "backpressure_threshold_setup_failed",
      error: (e as Error).message,
      timestamp: Date.now()
    }));
  }

  channel.onopen = () => {
    console.log(stringifyStructuredEvent({
      event: "datachannel_open",
      maxMessageSize: this.resolveMaxMessageSize(),
      timestamp: Date.now()
    }));
    this.callbacks.onDataChannelOpen();
  };

  channel.onclose = () => {
    console.log(stringifyStructuredEvent({
      event: "datachannel_close",
      timestamp: Date.now()
    }));
    this.callbacks.onDataChannelClose();
  };

  channel.onerror = (_error) => {
    console.log(stringifyStructuredEvent({
      event: "datachannel_error",
      timestamp: Date.now()
    }));
    this.callbacks.onError(new Error("数据通道错误"));
  };

  channel.binaryType = "arraybuffer";

  channel.onmessage = (event) => {
    this.handleDataChannelMessage(event.data);
  };
}

export function handleDataChannelMessage(this: any, data: string | ArrayBuffer): void {
  if (typeof data === "string") {
    try {
      const message: TransferMessage = JSON.parse(data);

      switch (message.type) {
        case "file-offer": {
          if (message.metadata) {
            void this.handleIncomingFileOffer(message.metadata);
          }
          break;
        }

        case "transfer-complete": {
          if (message.fileId) {
            void this.completeTransfer(message.fileId, message.checksum);
          }
          break;
        }

        case "receiver-ready": {
          if (message.fileId) {
            this.handleReceiverReady(message.fileId, message.resumeFromChunk, message.uploadId);
          }
          break;
        }

        case "request-retransmit": {
          if (message.fileId) {
            void this.handleRetransmitRequest(message);
          }
          break;
        }

        case "transfer-error": {
          if (message.error) {
            console.error(stringifyStructuredEvent({
              event: "transfer_remote_error",
              errorCode: message.error.code,
              message: message.error.message,
              timestamp: Date.now()
            }));
            this.callbacks.onError(new Error(`Transfer error: ${message.error.code} - ${message.error.message}`));
          }
          break;
        }
      }
    } catch (e) {
      const sampleLength = Math.min(200, data.length);
      const dataSample = data.slice(0, sampleLength);
      console.error(stringifyStructuredEvent({
        event: "transfer_control_message_parse_error",
        errorCode: TRANSFER_CONTROL_PARSE_ERROR_CODE,
        parseError: (e as Error).message,
        sampleLength,
        dataSample,
        timestamp: Date.now()
      }));
    }
  } else if (data instanceof ArrayBuffer) {
    this.processFileChunk(data);
  }
}

export function sendSignal(this: any, message: SignalMessage): void {
  this.ws?.send(JSON.stringify(message));
}
