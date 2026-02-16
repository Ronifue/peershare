/**
 * PeerShare - 结构化事件日志协议
 *
 * 用于统一客户端控制台事件、E2E 采集和脚本解析，避免耦合具体日志文本格式。
 */

export const STRUCTURED_EVENT_KIND = 'peershare.event' as const;
export const STRUCTURED_EVENT_VERSION = 1 as const;

export interface StructuredEventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  kind: typeof STRUCTURED_EVENT_KIND;
  version: typeof STRUCTURED_EVENT_VERSION;
  event: string;
  timestamp: number;
  payload: TPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createStructuredEventEnvelope<TPayload extends Record<string, unknown>>(
  event: string,
  payload: TPayload,
  timestamp: number = Date.now()
): StructuredEventEnvelope<TPayload> {
  return {
    kind: STRUCTURED_EVENT_KIND,
    version: STRUCTURED_EVENT_VERSION,
    event,
    timestamp,
    payload
  };
}

/**
 * 解析结构化事件：
 * 1) 优先解析标准 envelope；
 * 2) 兼容历史日志：{ event, timestamp, ...payload }。
 */
export function parseStructuredEventEnvelope(raw: unknown): StructuredEventEnvelope | null {
  if (!isRecord(raw)) {
    return null;
  }

  const kind = raw.kind;
  const version = raw.version;
  const event = raw.event;
  const timestamp = raw.timestamp;
  const payload = raw.payload;

  if (
    kind === STRUCTURED_EVENT_KIND &&
    version === STRUCTURED_EVENT_VERSION &&
    typeof event === 'string' &&
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    isRecord(payload)
  ) {
    return {
      kind,
      version,
      event,
      timestamp,
      payload
    };
  }

  // 历史兼容路径
  if (typeof event === 'string' && typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const { event: _event, timestamp: _timestamp, ...legacyPayload } = raw;
    return createStructuredEventEnvelope(event, legacyPayload, timestamp);
  }

  return null;
}

export function parseStructuredEventFromConsoleText(text: string): StructuredEventEnvelope | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parseStructuredEventEnvelope(parsed);
  } catch {
    return null;
  }
}
