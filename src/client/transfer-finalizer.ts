/**
 * PeerShare - 接收端终态组装（优先流式写入 OPFS，回退内存组装）
 */

import type { FileMetadata } from "../common/types";
import { deriveFileChecksumFromChunkChecksums } from "./transfer-integrity";
import type { TransferStore } from "./transfer-store";

type FinalizeStorageMode = "opfs" | "memory";

type FinalizeMissingChunk = {
  ok: false;
  reason: "missing_chunk";
  missingChunk: number;
};

type FinalizeChecksumMismatch = {
  ok: false;
  reason: "checksum_mismatch";
  fileChecksum: string;
};

type FinalizeSuccess = {
  ok: true;
  blob: Blob;
  fileChecksum: string;
  storageMode: FinalizeStorageMode;
};

export type FinalizeFromStoreResult =
  | FinalizeMissingChunk
  | FinalizeChecksumMismatch
  | FinalizeSuccess;

interface ChunkSink {
  mode: FinalizeStorageMode;
  write: (chunk: ArrayBuffer) => Promise<void>;
  close: () => Promise<Blob>;
  abort: () => Promise<void>;
}

interface StorageManagerWithDirectory {
  getDirectory?: () => Promise<{
    getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
      createWritable: () => Promise<{
        write: (data: BufferSource | Blob | string) => Promise<void>;
        abort?: () => Promise<void>;
        close: () => Promise<void>;
      }>;
      getFile: () => Promise<File>;
    }>;
    removeEntry?: (name: string) => Promise<void>;
  }>;
}

function createInMemoryChunkSink(mimeType: string): ChunkSink {
  const chunks: ArrayBuffer[] = [];
  return {
    mode: "memory",
    async write(chunk: ArrayBuffer): Promise<void> {
      chunks.push(chunk);
    },
    async close(): Promise<Blob> {
      return new Blob(chunks, { type: mimeType });
    },
    async abort(): Promise<void> {
      chunks.length = 0;
    }
  };
}

async function createOpfsChunkSink(uploadId: string): Promise<ChunkSink | null> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return null;
  }

  const storage = navigator.storage as StorageManagerWithDirectory;
  if (typeof storage.getDirectory !== "function") {
    return null;
  }

  try {
    const root = await storage.getDirectory();
    const tempName = `peershare-download-${uploadId}-${Date.now()}.part`;
    const handle = await root.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    const writableWithAbort = writable as {
      write: (data: BufferSource | Blob | string) => Promise<void>;
      abort?: () => Promise<void>;
      close: () => Promise<void>;
    };
    let isReleased = false;

    const releaseWriter = async (preferAbort: boolean): Promise<void> => {
      if (isReleased) {
        return;
      }
      isReleased = true;

      if (preferAbort && typeof writableWithAbort.abort === "function") {
        try {
          await writableWithAbort.abort();
          return;
        } catch {
          // Fallback to close when abort is unsupported or fails.
        }
      }

      try {
        await writableWithAbort.close();
      } catch {
        // Ignore close failures on cleanup path.
      }
    };

    const cleanupTempFile = async (): Promise<void> => {
      if (typeof root.removeEntry !== "function") {
        return;
      }
      try {
        await root.removeEntry(tempName);
      } catch {
        // Ignore temp cleanup failures to avoid masking transfer result.
      }
    };

    return {
      mode: "opfs",
      async write(chunk: ArrayBuffer): Promise<void> {
        await writable.write(new Uint8Array(chunk));
      },
      async close(): Promise<Blob> {
        await releaseWriter(false);
        const file = await handle.getFile();
        await cleanupTempFile();
        return file;
      },
      async abort(): Promise<void> {
        await releaseWriter(true);
        await cleanupTempFile();
      }
    };
  } catch {
    return null;
  }
}

export async function finalizeIncomingTransferFromStore(params: {
  transferStore: TransferStore;
  uploadId: string;
  metadata: FileMetadata;
  expectedChecksum?: string;
}): Promise<FinalizeFromStoreResult> {
  const { transferStore, uploadId, metadata, expectedChecksum } = params;

  const sink = (await createOpfsChunkSink(uploadId)) ?? createInMemoryChunkSink(metadata.type);
  const chunkChecksums: string[] = [];
  const fail = async <T extends FinalizeMissingChunk | FinalizeChecksumMismatch>(result: T): Promise<T> => {
    await sink.abort();
    return result;
  };

  try {
    for (let i = 0; i < metadata.totalChunks; i++) {
      // 顺序读取，避免一次性将所有块加载进内存。
      // eslint-disable-next-line no-await-in-loop
      const chunk = await transferStore.getChunk(uploadId, i);
      if (!chunk) {
        return fail({
          ok: false,
          reason: "missing_chunk",
          missingChunk: i
        });
      }

      chunkChecksums.push(chunk.checksum);
      // eslint-disable-next-line no-await-in-loop
      await sink.write(chunk.data);
    }

    const fileChecksum = await deriveFileChecksumFromChunkChecksums(chunkChecksums);
    if (expectedChecksum && fileChecksum !== expectedChecksum) {
      return fail({
        ok: false,
        reason: "checksum_mismatch",
        fileChecksum
      });
    }

    const blob = await sink.close();
    return {
      ok: true,
      blob,
      fileChecksum,
      storageMode: sink.mode
    };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}
