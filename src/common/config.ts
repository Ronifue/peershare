/**
 * PeerShare - 客户端配置
 * 
 * 注意：此文件只包含客户端可用的配置，不能使用 process.env
 */

import type { IceServerConfig, RTCConfiguration } from './types';

// 精选的高可用 STUN 服务器列表
// 移除过多冗余服务器，保留大厂和高可用节点
export const SELECTED_STUN_SERVERS = [
  // 国内友好
  'stun.chat.bilibili.com:3478',
  'stun.miwifi.com:3478',

  // Google - 全球高可用
  'stun.l.google.com:19302',
  'stun1.l.google.com:19302',
  'stun2.l.google.com:19302',
  'stun3.l.google.com:19302',
  'stun4.l.google.com:19302',

  // 备用
  'stun.qq.com:3478'
];

// 兼容性导出
export const AVAILABLE_STUN_SERVERS = SELECTED_STUN_SERVERS;

// 构建 ICE 服务器配置
export const ICE_SERVERS: IceServerConfig[] = [
  // STUN 服务器
  {
    urls: SELECTED_STUN_SERVERS.map(url => `stun:${url}`)
  }
];

// 优化的 RTC 配置
export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all', // 允许直连和中继
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// 背压模式配置
// 'event': 优先使用 bufferedamountlow 事件驱动（高效）
// 'polling': 强制使用轮询模式（兼容性好）
// 'auto': 自动检测，事件模式失败时回退到轮询
export const BACKPRESSURE_MODE: 'event' | 'polling' | 'auto' = 'auto';

// 背压配置
export const BACKPRESSURE_CONFIG = {
  // 当 bufferedAmount 低于此阈值时触发 bufferedamountlow 事件
  LOW_THRESHOLD: 12 * 1024 * 1024, // 12MB
  // 事件等待超时（防止死锁）
  EVENT_TIMEOUT_MS: 5000,
  // 轮询间隔（回退模式）
  POLL_INTERVAL_MS: 10,
} as const;

// 文件传输配置
export const FILE_CONFIG = {
  CHUNK_SIZE: 64 * 1024, // 64KB 分块
  // 移除硬编码的 MAX_CONCURRENT_CHUNKS，改用 bufferedAmount
  MAX_BUFFERED_AMOUNT: 12 * 1024 * 1024, // 12MB 缓冲区阈值
  CONNECTION_TIMEOUT: 30000, // 30秒连接超时
  SIGNALING_TIMEOUT: 10000, // 10秒信令超时
  // 内存警戒阈值：接收超过此大小的文件时输出警告日志 (256MB)
  MEMORY_GUARD_THRESHOLD_BYTES: 256 * 1024 * 1024,
  // 协议健壮性配置 (Task 4)
  RECEIVER_READY_TIMEOUT_MS: 10000, // 等待 receiver-ready 信号的超时时间
  MAX_CHUNK_SEQUENCE_GAP: 10, // 允许的最大块序号间隔（用于验证）
} as const;

// 自适应分块配置（受 RTT 与 maxMessageSize 双重约束）
export const ADAPTIVE_CHUNK_CONFIG = {
  MIN_CHUNK_SIZE: 16 * 1024, // 16KB
  MAX_CHUNK_SIZE: FILE_CONFIG.CHUNK_SIZE, // 默认上限 64KB
  RUNTIME_RTT_CACHE_MS: 3000, // RTT 采样缓存时间
} as const;

// 断点续传持久化配置
export const RESUME_CONFIG = {
  SESSION_TTL_MS: 24 * 60 * 60 * 1000, // 24 小时
  CLEANUP_PROBABILITY: 0.05, // 每次实例初始化有 5% 概率触发过期清理
  AUTO_RESUME_MAX_WAIT_MS: 2 * 60 * 1000, // 自动续传最大等待 2 分钟
  AUTO_RESUME_POLL_INTERVAL_MS: 200, // 自动续传等待轮询间隔
} as const;

// 候选路径竞速观测/探测配置
export const CANDIDATE_RACE_CONFIG = {
  MONITOR_INTERVAL_MS: 5000, // 连接建立后的周期观测间隔
  HIGH_RTT_MS: 800, // 选中路径 RTT 过高阈值
  IMPROVEMENT_THRESHOLD_MS: 120, // 当最优候选显著更优时触发受控探测
  MAX_PROBE_ATTEMPTS: 1, // 每次连接生命周期最多触发 1 次探测
} as const;

// 分级重连恢复配置 (Tiered Reconnect Recovery - Task 5)
export const RECONNECT_CONFIG = {
  // 断开状态宽限期：等待连接自行恢复的时间 (ms)
  GRACE_PERIOD_MS: 8000, // 8秒（介于5-10秒之间）
  // restartIce 最大尝试次数
  MAX_RESTART_ICE_ATTEMPTS: 2,
  // 重建路径最大尝试次数（包含初始连接失败）
  MAX_REBUILD_ATTEMPTS: 3,
  // 重试退避基数 (ms)，每次失败后乘以2
  BACKOFF_BASE_MS: 2000,
  // 最大退避时间 (ms)
  MAX_BACKOFF_MS: 15000,
  // 恢复成功的稳定期 (ms)：连接成功后重置计数器
  RECOVERY_GRACE_PERIOD_MS: 5000,
} as const;

// 颜色配置
export const COLORS = {
  BLACK: '#000000',
  WHITE: '#FFFFFF',
  PAYNES_GREY: '#536878',
  TEAL: '#008080',
} as const;
