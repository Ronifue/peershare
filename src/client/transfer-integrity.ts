/**
 * PeerShare - 传输完整性与续传辅助工具
 */

const textEncoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function fnv1a32Hex(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
  if (crypto.subtle && typeof crypto.subtle.digest === "function") {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(digest);
  }

  // 兼容极端运行环境：退化到轻量哈希，确保流程可继续。
  return fnv1a32Hex(new Uint8Array(data));
}

export async function hashText(text: string): Promise<string> {
  const bytes = textEncoder.encode(text);
  return hashArrayBuffer(bytes.buffer);
}

export async function deriveFileChecksumFromChunkChecksums(chunkChecksums: string[]): Promise<string> {
  return hashText(chunkChecksums.join("\n"));
}

export function createFileFingerprint(file: Pick<File, "name" | "size" | "type" | "lastModified">): string {
  return `${file.name}::${file.size}::${file.type || "application/octet-stream"}::${file.lastModified}`;
}

export function calculateTotalChunks(fileSize: number, chunkSize: number): number {
  if (chunkSize <= 0) {
    return 0;
  }
  return Math.ceil(fileSize / chunkSize);
}

export function bytesForChunkIndex(chunkIndex: number, chunkSize: number, fileSize: number): number {
  const bytes = Math.max(0, chunkIndex) * Math.max(0, chunkSize);
  return Math.min(bytes, Math.max(0, fileSize));
}

export function normalizeChunkIndex(value: number, totalChunks: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= totalChunks) {
    return totalChunks;
  }
  return Math.floor(value);
}

