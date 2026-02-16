/**
 * PeerShare - Bun WebSocket 信令服务器
 * 
 * 极简设计，仅负责房间管理和信令中继
 */

import { type ServerWebSocket, serve } from 'bun';
import { resolve, normalize } from 'node:path';
import { randomInt } from 'node:crypto';
import { SERVER_CONFIG } from './config';
import type { SignalMessage, Room } from '../common/types';

// 房间管理
const rooms = new Map<string, Room>();
const peerToRoom = new Map<string, string>();
const connections = new Map<string, ServerWebSocket<{ peerId: string; ip: string }>>();

// IP 速率限制追踪
const ipTracking = new Map<string, { 
  concurrent: number; 
  connectionTimestamps: number[];
  messageTimestamps: Map<string, number[]>;
}>();


// 生成 6 位数字房间码（带冲突检测）
function generateRoomCode(): string {
  let code = '';
  let attempts = 0;
  const MAX_ATTEMPTS = 100;

  while (attempts < MAX_ATTEMPTS) {
    code = randomInt(100000, 999999).toString();
    if (!rooms.has(code)) {
      return code;
    }
    attempts++;
  }

  throw new Error('无法生成唯一的房间码');
}

/**
 * 生成 RFC 4122 兼容的 UUID v4
 * 使用 crypto.getRandomValues，避免依赖 crypto.randomUUID
 */
function generatePeerId(): string {
  // @ts-ignore - 复用浏览器端同款实现，保证 HTTP 环境约束一致
  return ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}


// 清理过期房间
function cleanupRooms(): void {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.createdAt > SERVER_CONFIG.ROOM_MAX_AGE) {
      for (const peerId of room.peers) {
        peerToRoom.delete(peerId);
        connections.delete(peerId);
      }
      rooms.delete(roomId);
      console.log(`[清理] 房间 ${roomId} 已过期`);
    }
  }
}

// 定期清理
setInterval(cleanupRooms, SERVER_CONFIG.ROOM_CLEANUP_INTERVAL);

// 广播消息给房间内其他对等端
function broadcast(
  sender: ServerWebSocket<{ peerId: string; ip: string }>,
  roomId: string,
  message: SignalMessage,
  excludeSelf = true
): void {

  const room = rooms.get(roomId);
  if (!room) return;
  
  const messageStr = JSON.stringify(message);
  
  for (const peerId of room.peers) {
    if (excludeSelf && peerId === sender.data.peerId) continue;
    
    const ws = connections.get(peerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  }
}

// 发送消息给特定对等端
function sendTo(targetId: string, message: SignalMessage): boolean {
  const ws = connections.get(targetId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// 处理信令消息
function handleSignal(ws: ServerWebSocket<{ peerId: string; ip: string }>, message: SignalMessage): void {

  const currentRoomId = peerToRoom.get(ws.data.peerId);
  if (!currentRoomId || currentRoomId !== message.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      roomId: message.roomId,
      peerId: 'server',
      timestamp: Date.now(),
      payload: { code: 'INVALID_ROOM', message: '房间不存在或已离开' }
    } as SignalMessage));
    return;
  }
  
  // 转发消息给目标对等端或广播
  if (message.targetId) {
    // 定向消息
    const sent = sendTo(message.targetId, message);
    if (!sent) {
      ws.send(JSON.stringify({
        type: 'error',
        roomId: message.roomId,
        peerId: 'server',
        timestamp: Date.now(),
        payload: { code: 'PEER_NOT_FOUND', message: '目标对等端不存在或已断开' }
      } as SignalMessage));
    }
  } else {
    // 广播给房间（排除自己）
    broadcast(ws, currentRoomId, message, true);
  }
}

// 创建 HTTP 服务器和 WebSocket 服务器
const server = serve<{ peerId: string; ip: string }>({
  port: SERVER_CONFIG.PORT,
  hostname: SERVER_CONFIG.HOST,
  
  // 静态文件服务
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address || 'unknown';

    if (url.pathname === '/healthz') {
      return Response.json({
        status: 'ok',
        timestamp: Date.now()
      });
    }
    
    // WebSocket 升级
    if (url.pathname === '/ws') {
      // 速率限制检查
      const now = Date.now();
      let tracking = ipTracking.get(ip);
      
      if (!tracking) {
        tracking = {
          concurrent: 0,
          connectionTimestamps: [],
          messageTimestamps: new Map()
        };
        ipTracking.set(ip, tracking);
      }
      
      // 清理旧的时间戳 (1分钟前)
      tracking.connectionTimestamps = tracking.connectionTimestamps.filter(t => now - t < 60000);
      
      // 检查并发连接数
      if (tracking.concurrent >= SERVER_CONFIG.RATE_LIMIT.MAX_CONNECTIONS_PER_IP) {
        console.warn(`[拒绝] IP ${ip} 并发连接过多`);
        return new Response('Too Many Connections', { status: 429 });
      }
      
      // 检查连接速率
      if (tracking.connectionTimestamps.length >= SERVER_CONFIG.RATE_LIMIT.CONNECTIONS_PER_MINUTE) {
        console.warn(`[拒绝] IP ${ip} 连接频率过快`);
        return new Response('Rate Limit Exceeded', { status: 429 });
      }
      
      const upgraded = server.upgrade(req, {
        data: { 
          peerId: generatePeerId(),
          ip
        }
      });
      if (upgraded) {
        tracking.concurrent++;
        tracking.connectionTimestamps.push(now);
        return undefined;
      }
    }

    
    // 静态文件
    if (url.pathname === '/') {
      return new Response(Bun.file('public/index.html'));
    }
    
    const publicDir = resolve('public');
    const safePath = resolve('public', '.' + normalize(url.pathname));
    
    if (!safePath.startsWith(publicDir)) {
      return new Response('Forbidden', { status: 403 });
    }
    
    const file = Bun.file(safePath);
    const exists = await file.exists();
    if (exists) {
      return new Response(file);
    }
    
    return new Response('Not Found', { status: 404 });
  },
  
  // WebSocket 处理器
  websocket: {
    open(ws: ServerWebSocket<{ peerId: string; ip: string }>) {
      const { peerId } = ws.data;
      connections.set(peerId, ws);
      console.log(`[连接] 对等端 ${peerId} 已连接 (IP: ${ws.data.ip})`);
      
      // 发送 peerId 给客户端
      ws.send(JSON.stringify({
        type: 'register',
        roomId: '',
        peerId: 'server',
        timestamp: Date.now(),
        payload: peerId
      } as SignalMessage));
    },
    
    message(ws: ServerWebSocket<{ peerId: string; ip: string }>, message: string | Buffer) {
      const { peerId, ip } = ws.data;
      const now = Date.now();
      
      // 消息速率限制
      const tracking = ipTracking.get(ip);
      if (tracking) {
        let peerMessageTimestamps = tracking.messageTimestamps.get(peerId);
        if (!peerMessageTimestamps) {
          peerMessageTimestamps = [];
          tracking.messageTimestamps.set(peerId, peerMessageTimestamps);
        }
        
        // 清理旧的时间戳 (1秒前)
        const oneSecondAgo = now - 1000;
        const recentTimestamps = peerMessageTimestamps.filter(t => t > oneSecondAgo);
        
        if (recentTimestamps.length >= SERVER_CONFIG.RATE_LIMIT.MESSAGES_PER_SECOND) {
          console.warn(`[拒绝] 对等端 ${peerId} 消息频率过快`);
          return;
        }
        
        recentTimestamps.push(now);
        tracking.messageTimestamps.set(peerId, recentTimestamps);
      }

      try {
        const data = JSON.parse(message.toString()) as SignalMessage;

        
        console.log(`[消息] 类型: ${data.type}, 来自: ${peerId}`);
        
        switch (data.type) {
          case 'register': {
            // 创建或加入房间
            let roomId = data.roomId;
            
            if (!roomId) {
              // 创建新房间
              roomId = generateRoomCode();
              rooms.set(roomId, {
                id: roomId,
                peers: new Set([peerId]),
                createdAt: Date.now()
              });
              peerToRoom.set(peerId, roomId);
              
              // 通知客户端房间码
              ws.send(JSON.stringify({
                type: 'register',
                roomId,
                peerId: 'server',
                timestamp: Date.now(),
                payload: { roomId, isCreator: true }
              } as SignalMessage));
              
              console.log(`[房间] 创建房间 ${roomId}, 创建者: ${peerId}`);
            } else {
              // 加入现有房间
              const room = rooms.get(roomId);
              if (!room) {
                ws.send(JSON.stringify({
                  type: 'error',
                  roomId,
                  peerId: 'server',
                  timestamp: Date.now(),
                  payload: { code: 'ROOM_NOT_FOUND', message: '房间不存在' }
                } as SignalMessage));
                return;
              }
              
              // 清理已断开但未及时移除的残留连接
              for (const existingPeerId of room.peers) {
                const peerWs = connections.get(existingPeerId);
                if (!peerWs || peerWs.readyState !== WebSocket.OPEN) {
                  room.peers.delete(existingPeerId);
                  peerToRoom.delete(existingPeerId);
                  connections.delete(existingPeerId);
                  console.log(`[清理] 移除残留连接 ${existingPeerId} (房间 ${roomId})`);
                }
              }
              
              if (room.peers.size >= SERVER_CONFIG.MAX_ROOM_SIZE) {
                ws.send(JSON.stringify({
                  type: 'error',
                  roomId,
                  peerId: 'server',
                  timestamp: Date.now(),
                  payload: { code: 'ROOM_FULL', message: '房间已满' }
                } as SignalMessage));
                return;
              }
              
              room.peers.add(peerId);
              peerToRoom.set(peerId, roomId);
              
              // 通知加入者
              ws.send(JSON.stringify({
                type: 'register',
                roomId,
                peerId: 'server',
                timestamp: Date.now(),
                payload: { roomId, isCreator: false }
              } as SignalMessage));
              
              // 通知房间内其他对等端
              broadcast(ws, roomId, {
                type: 'peer-joined',
                roomId,
                peerId,
                timestamp: Date.now()
              } as SignalMessage, true);
              
              console.log(`[房间] 房间 ${roomId} 有新成员: ${peerId}`);
            }
            break;
          }
          
          case 'offer':
          case 'answer':
          case 'ice-candidate': {
            handleSignal(ws, data);
            break;
          }
          
          default: {
            console.warn(`[警告] 未知消息类型: ${data.type}`);
          }
        }
      } catch (error) {
        console.error('[错误] 消息处理失败:', error);
        ws.send(JSON.stringify({
          type: 'error',
          roomId: '',
          peerId: 'server',
          timestamp: Date.now(),
          payload: { code: 'PARSE_ERROR', message: '消息格式错误' }
        } as SignalMessage));
      }
    },
    
    close(ws: ServerWebSocket<{ peerId: string; ip: string }>) {
      const { peerId, ip } = ws.data;
      const roomId = peerToRoom.get(peerId);
      
      // 减少并发连接数
      const tracking = ipTracking.get(ip);
      if (tracking) {
        tracking.concurrent = Math.max(0, tracking.concurrent - 1);
        tracking.messageTimestamps.delete(peerId);
        
        // 如果没有任何追踪数据了，可以清理 Map
        if (tracking.concurrent === 0 && tracking.connectionTimestamps.length === 0) {
          ipTracking.delete(ip);
        }
      }

      if (roomId) {

        const room = rooms.get(roomId);
        if (room) {
          room.peers.delete(peerId);
          
          // 通知其他对等端
          broadcast(ws, roomId, {
            type: 'peer-left',
            roomId,
            peerId,
            timestamp: Date.now()
          } as SignalMessage, true);
          
          // 如果房间空了，删除房间
          if (room.peers.size === 0) {
            rooms.delete(roomId);
            console.log(`[房间] 房间 ${roomId} 已删除（空房间）`);
          }
        }
        
        peerToRoom.delete(peerId);
      }
      
      connections.delete(peerId);
      console.log(`[断开] 对等端 ${peerId} 已断开`);
    },
    
    drain(ws: ServerWebSocket<{ peerId: string; ip: string }>) {

      console.log(`[缓冲] 对等端 ${ws.data.peerId} 缓冲区已清空`);
    }
  }
});

void server;
console.log(`[启动] PeerShare 服务器运行于 http://${SERVER_CONFIG.HOST}:${SERVER_CONFIG.PORT}`);
