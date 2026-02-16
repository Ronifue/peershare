/**
 * PeerShare - 服务端配置
 * 
 * 服务端专用配置，可以使用 process.env
 */

// 服务器配置
export const SERVER_CONFIG = {
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 3001,
  HOST: process.env.HOST || '0.0.0.0',
  MAX_ROOM_SIZE: 2, // 每房间最多 2 人（1对1传输）
  ROOM_CLEANUP_INTERVAL: 5 * 60 * 1000, // 5分钟清理间隔
  ROOM_MAX_AGE: 30 * 60 * 1000, // 30分钟房间过期
  RATE_LIMIT: {
    CONNECTIONS_PER_MINUTE: 10,
    MESSAGES_PER_SECOND: 20,
    MAX_CONNECTIONS_PER_IP: 5,
  },
} as const;

