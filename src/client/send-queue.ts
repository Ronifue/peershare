/**
 * PeerShare - 串行发送队列状态机
 *
 * 职责：
 * - 维护发送队列项生命周期（queued/sending/completed/failed）
 * - 提供纯函数 reducer，便于测试与 UI 解耦
 * - 保证同一时刻最多一个 sending 项
 */

export type OutgoingQueueItemStatus = "queued" | "sending" | "completed" | "failed";

export interface OutgoingQueueItem {
  id: string;
  file: File;
  status: OutgoingQueueItemStatus;
  sentBytes: number;
  totalBytes: number;
  progressPercent: number;
  attempts: number;
  errorMessage: string | null;
  addedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SendQueueState {
  items: OutgoingQueueItem[];
  activeItemId: string | null;
  revision: number;
}

export type SendQueueAction =
  | { type: "enqueue"; items: OutgoingQueueItem[] }
  | { type: "mark-sending"; itemId: string }
  | { type: "update-progress"; itemId: string; sentBytes: number; totalBytes: number }
  | { type: "mark-completed"; itemId: string }
  | { type: "mark-failed"; itemId: string; errorMessage: string }
  | { type: "retry"; itemId: string }
  | { type: "remove"; itemId: string }
  | { type: "clear-completed" }
  | { type: "reset" };

export interface SendQueueSummary {
  total: number;
  queued: number;
  sending: number;
  completed: number;
  failed: number;
}

function createQueueItemId(): string {
  const random = Math.floor(Math.random() * 1_000_000_000).toString(16);
  return `queue-${Date.now()}-${random}`;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 0;
  }
  return Math.max(0, Math.min(100, progress));
}

function withRevision(state: SendQueueState, items: OutgoingQueueItem[], activeItemId: string | null = state.activeItemId): SendQueueState {
  const itemsChanged = items !== state.items;
  const activeChanged = activeItemId !== state.activeItemId;
  if (!itemsChanged && !activeChanged) {
    return state;
  }
  return {
    items,
    activeItemId,
    revision: state.revision + 1
  };
}

export function createInitialSendQueueState(): SendQueueState {
  return {
    items: [],
    activeItemId: null,
    revision: 0
  };
}

export function createOutgoingQueueItems(files: readonly File[]): OutgoingQueueItem[] {
  const now = Date.now();
  return files.map((file, index) => ({
    id: createQueueItemId(),
    file,
    status: "queued",
    sentBytes: 0,
    totalBytes: file.size,
    progressPercent: 0,
    attempts: 0,
    errorMessage: null,
    addedAt: now + index,
    startedAt: null,
    finishedAt: null
  }));
}

export function selectNextQueuedItem(state: SendQueueState): OutgoingQueueItem | null {
  for (const item of state.items) {
    if (item.status === "queued") {
      return item;
    }
  }
  return null;
}

export function hasQueuedItems(state: SendQueueState): boolean {
  return state.items.some((item) => item.status === "queued");
}

export function getSendQueueSummary(state: SendQueueState): SendQueueSummary {
  const summary: SendQueueSummary = {
    total: state.items.length,
    queued: 0,
    sending: 0,
    completed: 0,
    failed: 0
  };

  for (const item of state.items) {
    if (item.status === "queued") summary.queued++;
    if (item.status === "sending") summary.sending++;
    if (item.status === "completed") summary.completed++;
    if (item.status === "failed") summary.failed++;
  }

  return summary;
}

export function sendQueueReducer(state: SendQueueState, action: SendQueueAction): SendQueueState {
  switch (action.type) {
    case "enqueue": {
      if (action.items.length === 0) {
        return state;
      }
      return withRevision(state, [...state.items, ...action.items]);
    }

    case "mark-sending": {
      let found = false;
      const now = Date.now();
      const items: OutgoingQueueItem[] = state.items.map((item): OutgoingQueueItem => {
        if (item.id === action.itemId) {
          found = true;
          return {
            ...item,
            status: "sending",
            attempts: item.attempts + 1,
            errorMessage: null,
            startedAt: now,
            finishedAt: null
          };
        }

        if (item.status === "sending") {
          return {
            ...item,
            status: "queued",
            errorMessage: null,
            startedAt: null,
            finishedAt: null
          };
        }

        return item;
      });

      if (!found) {
        return state;
      }

      return withRevision(state, items, action.itemId);
    }

    case "update-progress": {
      const items: OutgoingQueueItem[] = state.items.map((item): OutgoingQueueItem => {
        if (item.id !== action.itemId || item.status !== "sending") {
          return item;
        }

        const normalizedTotalBytes = Math.max(0, action.totalBytes);
        const normalizedSentBytes = Math.max(0, Math.min(action.sentBytes, normalizedTotalBytes));
        const progressPercent = normalizedTotalBytes > 0
          ? clampProgress((normalizedSentBytes / normalizedTotalBytes) * 100)
          : 0;

        return {
          ...item,
          sentBytes: normalizedSentBytes,
          totalBytes: normalizedTotalBytes,
          progressPercent
        };
      });

      return withRevision(state, items);
    }

    case "mark-completed": {
      const now = Date.now();
      let found = false;
      const items: OutgoingQueueItem[] = state.items.map((item): OutgoingQueueItem => {
        if (item.id !== action.itemId) {
          return item;
        }

        found = true;
        return {
          ...item,
          status: "completed",
          sentBytes: item.totalBytes,
          progressPercent: 100,
          errorMessage: null,
          finishedAt: now
        };
      });

      if (!found) {
        return state;
      }

      const activeItemId = state.activeItemId === action.itemId ? null : state.activeItemId;
      return withRevision(state, items, activeItemId);
    }

    case "mark-failed": {
      const now = Date.now();
      let found = false;
      const items: OutgoingQueueItem[] = state.items.map((item): OutgoingQueueItem => {
        if (item.id !== action.itemId) {
          return item;
        }

        found = true;
        return {
          ...item,
          status: "failed",
          errorMessage: action.errorMessage,
          finishedAt: now
        };
      });

      if (!found) {
        return state;
      }

      const activeItemId = state.activeItemId === action.itemId ? null : state.activeItemId;
      return withRevision(state, items, activeItemId);
    }

    case "retry": {
      let found = false;
      const items: OutgoingQueueItem[] = state.items.map((item): OutgoingQueueItem => {
        if (item.id !== action.itemId || item.status !== "failed") {
          return item;
        }

        found = true;
        return {
          ...item,
          status: "queued",
          sentBytes: 0,
          progressPercent: 0,
          errorMessage: null,
          startedAt: null,
          finishedAt: null
        };
      });

      if (!found) {
        return state;
      }

      return withRevision(state, items);
    }

    case "remove": {
      const target = state.items.find((item) => item.id === action.itemId);
      if (!target || target.status === "sending") {
        return state;
      }

      const items = state.items.filter((item) => item.id !== action.itemId);
      const activeItemId = state.activeItemId === action.itemId ? null : state.activeItemId;
      return withRevision(state, items, activeItemId);
    }

    case "clear-completed": {
      const items = state.items.filter((item) => item.status !== "completed");
      if (items.length === state.items.length) {
        return state;
      }
      return withRevision(state, items);
    }

    case "reset": {
      if (state.items.length === 0 && state.activeItemId === null) {
        return state;
      }
      return {
        items: [],
        activeItemId: null,
        revision: state.revision + 1
      };
    }

    default: {
      return state;
    }
  }
}
