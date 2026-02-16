/**
 * PeerShare - 发送中断恢复判定工具
 */

export class RecoverableTransferError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecoverableTransferError";
    this.code = code;
  }
}

export function createRecoverableTransferError(code: string, message: string): RecoverableTransferError {
  return new RecoverableTransferError(code, message);
}

export function isRecoverableTransferError(error: unknown): error is RecoverableTransferError {
  return error instanceof RecoverableTransferError;
}
