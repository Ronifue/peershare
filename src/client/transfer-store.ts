/**
 * PeerShare - 续传状态与分块持久化（IndexedDB）
 */

const DB_NAME = "peershare-transfer-db";
const DB_VERSION = 1;

const SESSION_STORE = "transfer_sessions";
const CHUNK_STORE = "transfer_chunks";

export type PersistedTransferDirection = "incoming" | "outgoing";
export type PersistedTransferStatus = "active" | "completed" | "failed";

export interface PersistedTransferSession {
  sessionKey: string;
  direction: PersistedTransferDirection;
  status: PersistedTransferStatus;
  uploadId: string;
  fileId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  nextChunkIndex: number;
  bytesTransferred: number;
  remotePeerId: string;
  fingerprint?: string;
  fileChecksum?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedChunkRecord {
  uploadId: string;
  chunkIndex: number;
  data: ArrayBuffer;
  checksum: string;
  size: number;
  updatedAt: number;
}

export function createTransferSessionKey(direction: PersistedTransferDirection, uploadId: string): string {
  return `${direction}:${uploadId}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function createObjectStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(SESSION_STORE)) {
    const store = db.createObjectStore(SESSION_STORE, { keyPath: "sessionKey" });
    store.createIndex("by_upload_id", "uploadId", { unique: false });
    store.createIndex("by_fingerprint", "fingerprint", { unique: false });
    store.createIndex("by_updated_at", "updatedAt", { unique: false });
  }

  if (!db.objectStoreNames.contains(CHUNK_STORE)) {
    const store = db.createObjectStore(CHUNK_STORE, { keyPath: ["uploadId", "chunkIndex"] });
    store.createIndex("by_upload_id", "uploadId", { unique: false });
  }
}

export class TransferStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  isSupported(): boolean {
    return typeof globalThis !== "undefined" && typeof globalThis.indexedDB !== "undefined";
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.isSupported()) {
      throw new Error("IndexedDB is not available in current runtime");
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          createObjectStores(request.result);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
      });
    }

    return this.dbPromise;
  }

  async putSession(session: PersistedTransferSession): Promise<void> {
    if (!this.isSupported()) {
      return;
    }

    const db = await this.getDb();
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).put(session);
    await waitTransaction(tx);
  }

  async getSession(sessionKey: string): Promise<PersistedTransferSession | null> {
    if (!this.isSupported()) {
      return null;
    }

    const db = await this.getDb();
    const tx = db.transaction(SESSION_STORE, "readonly");
    const result = await requestToPromise(tx.objectStore(SESSION_STORE).get(sessionKey));
    await waitTransaction(tx);
    return (result as PersistedTransferSession | undefined) ?? null;
  }

  async findOutgoingSessionByFingerprint(
    fingerprint: string,
    remotePeerId: string
  ): Promise<PersistedTransferSession | null> {
    if (!this.isSupported() || !fingerprint) {
      return null;
    }

    const db = await this.getDb();
    const tx = db.transaction(SESSION_STORE, "readonly");
    const index = tx.objectStore(SESSION_STORE).index("by_fingerprint");
    const matched = await requestToPromise(index.getAll(fingerprint));
    await waitTransaction(tx);

    const candidates = (matched as PersistedTransferSession[])
      .filter((item) => item.direction === "outgoing" && item.status !== "completed")
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (candidates.length === 0) {
      return null;
    }

    const samePeer = candidates.find((item) => item.remotePeerId === remotePeerId);
    return samePeer ?? candidates[0] ?? null;
  }

  async getSessionsByUploadId(uploadId: string): Promise<PersistedTransferSession[]> {
    if (!this.isSupported()) {
      return [];
    }

    const db = await this.getDb();
    const tx = db.transaction(SESSION_STORE, "readonly");
    const index = tx.objectStore(SESSION_STORE).index("by_upload_id");
    const result = await requestToPromise(index.getAll(uploadId));
    await waitTransaction(tx);
    return (result as PersistedTransferSession[]) ?? [];
  }

  async putChunk(uploadId: string, chunkIndex: number, data: ArrayBuffer, checksum: string): Promise<void> {
    if (!this.isSupported()) {
      return;
    }

    const db = await this.getDb();
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const record: PersistedChunkRecord = {
      uploadId,
      chunkIndex,
      data,
      checksum,
      size: data.byteLength,
      updatedAt: Date.now()
    };
    tx.objectStore(CHUNK_STORE).put(record);
    await waitTransaction(tx);
  }

  async getChunks(uploadId: string): Promise<PersistedChunkRecord[]> {
    if (!this.isSupported()) {
      return [];
    }

    const db = await this.getDb();
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const range = IDBKeyRange.bound([uploadId, 0], [uploadId, Number.MAX_SAFE_INTEGER]);
    const chunks: PersistedChunkRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        chunks.push(cursor.value as PersistedChunkRecord);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to iterate chunk store"));
    });

    await waitTransaction(tx);
    return chunks;
  }

  async getChunk(uploadId: string, chunkIndex: number): Promise<PersistedChunkRecord | null> {
    if (!this.isSupported()) {
      return null;
    }

    const db = await this.getDb();
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const result = await requestToPromise(tx.objectStore(CHUNK_STORE).get([uploadId, chunkIndex]));
    await waitTransaction(tx);
    return (result as PersistedChunkRecord | undefined) ?? null;
  }

  async getChunkCount(uploadId: string): Promise<number> {
    if (!this.isSupported()) {
      return 0;
    }

    const db = await this.getDb();
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const range = IDBKeyRange.bound([uploadId, 0], [uploadId, Number.MAX_SAFE_INTEGER]);
    const result = await requestToPromise(store.count(range));
    await waitTransaction(tx);
    return typeof result === "number" ? result : 0;
  }

  async getContiguousChunkCount(uploadId: string, totalChunks: number): Promise<number> {
    let contiguous = 0;
    while (contiguous < totalChunks) {
      // 顺序读取避免一次性将所有 chunk 拉入内存。
      // eslint-disable-next-line no-await-in-loop
      const chunk = await this.getChunk(uploadId, contiguous);
      if (!chunk) {
        break;
      }
      contiguous += 1;
    }
    return contiguous;
  }

  async deleteChunksFrom(uploadId: string, fromChunk: number): Promise<void> {
    if (!this.isSupported()) {
      return;
    }

    const db = await this.getDb();
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    const range = IDBKeyRange.bound(
      [uploadId, Math.max(0, fromChunk)],
      [uploadId, Number.MAX_SAFE_INTEGER]
    );

    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to delete chunk range"));
    });

    await waitTransaction(tx);
  }

  async deleteUpload(uploadId: string): Promise<void> {
    if (!this.isSupported()) {
      return;
    }

    const db = await this.getDb();
    const sessions = await this.getSessionsByUploadId(uploadId);

    const tx = db.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
    const sessionStore = tx.objectStore(SESSION_STORE);
    for (const session of sessions) {
      sessionStore.delete(session.sessionKey);
    }

    const chunkStore = tx.objectStore(CHUNK_STORE);
    const range = IDBKeyRange.bound([uploadId, 0], [uploadId, Number.MAX_SAFE_INTEGER]);
    await new Promise<void>((resolve, reject) => {
      const request = chunkStore.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to delete upload chunks"));
    });

    await waitTransaction(tx);
  }

  async pruneStaleSessions(maxAgeMs: number): Promise<void> {
    if (!this.isSupported()) {
      return;
    }

    const db = await this.getDb();
    const now = Date.now();
    const tx = db.transaction(SESSION_STORE, "readonly");
    const allSessions = await requestToPromise(tx.objectStore(SESSION_STORE).getAll());
    await waitTransaction(tx);

    const staleUploads = new Set<string>();
    for (const session of allSessions as PersistedTransferSession[]) {
      if (now - session.updatedAt > maxAgeMs) {
        staleUploads.add(session.uploadId);
      }
    }

    for (const uploadId of staleUploads) {
      // eslint-disable-next-line no-await-in-loop
      await this.deleteUpload(uploadId);
    }
  }
}
