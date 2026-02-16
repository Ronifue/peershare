/**
 * PeerShare - 主应用组件
 */

import { useState, useCallback, useEffect, useReducer, useRef } from 'react';
import { P2PConnection } from './webrtc';
import { HomeScreen } from './components/HomeScreen';
import { TransferScreen } from './components/TransferScreen';
import { formatBytes } from './utils';
import type { FileMetadata } from '../common/types';
import {
  createInitialSendQueueState,
  createOutgoingQueueItems,
  hasQueuedItems,
  selectNextQueuedItem,
  sendQueueReducer
} from './send-queue';

// 应用状态
type AppState = 'home' | 'creating' | 'joining' | 'connected' | 'error' | 'unsupported';

export default function App() {
  // 状态
  const [appState, setAppState] = useState<AppState>('home');
  const [connection, setConnection] = useState<P2PConnection | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [incomingFile, setIncomingFile] = useState<FileMetadata | null>(null);
  const [transferProgress, setTransferProgress] = useState(0);
  const [sendQueueState, dispatchSendQueue] = useReducer(sendQueueReducer, createInitialSendQueueState());
  const [logs, setLogs] = useState<string[]>([]);
  const sendQueueStateRef = useRef(sendQueueState);
  const sendQueueProcessorActiveRef = useRef(false);

  // 检查浏览器兼容性
  useEffect(() => {
    const support = P2PConnection.checkSupport();
    if (!support.supported) {
      setBrowserError(support.error || '浏览器不支持 WebRTC');
      setAppState('unsupported');
    }
  }, []);

  // 添加日志
  const addLog = useCallback((msg: string) => {
    setLogs(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    sendQueueStateRef.current = sendQueueState;
  }, [sendQueueState]);

  const processSendQueue = useCallback(async () => {
    if (sendQueueProcessorActiveRef.current) {
      return;
    }
    if (!connection || !isConnected) {
      return;
    }

    sendQueueProcessorActiveRef.current = true;
    try {
      while (true) {
        if (!connection || !isConnected) {
          return;
        }

        const nextItem = selectNextQueuedItem(sendQueueStateRef.current);
        if (!nextItem) {
          return;
        }

        dispatchSendQueue({ type: 'mark-sending', itemId: nextItem.id });
        addLog(`队列发送开始: ${nextItem.file.name}`);

        try {
          await connection.sendFile(nextItem.file);
          dispatchSendQueue({ type: 'mark-completed', itemId: nextItem.id });
          addLog(`队列发送完成: ${nextItem.file.name}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          dispatchSendQueue({
            type: 'mark-failed',
            itemId: nextItem.id,
            errorMessage
          });
          addLog(`队列发送失败: ${nextItem.file.name}（${errorMessage}）`);

          if (!connection || !isConnected) {
            return;
          }
        }
      }
    } finally {
      sendQueueProcessorActiveRef.current = false;
    }
  }, [addLog, connection, isConnected]);

  useEffect(() => {
    if (!connection || !isConnected) {
      return;
    }
    if (!hasQueuedItems(sendQueueState)) {
      return;
    }
    void processSendQueue();
  }, [connection, isConnected, processSendQueue, sendQueueState]);

  // 创建连接回调
  const createConnection = useCallback(() => {
    return new P2PConnection({
      onStateChange: (state, signalState) => {
        addLog(`连接: ${state}, 信令: ${signalState}`);
      },
      onDataChannelOpen: () => {
        addLog('连接成功！');
        setIsConnected(true);
      },
      onDataChannelClose: () => {
        addLog('连接断开');
        setIsConnected(false);
        setIncomingFile(null);
        setTransferProgress(0);
      },
      onFileOffer: (metadata) => {
        addLog(`收到文件: ${metadata.name} (${formatBytes(metadata.size)})`);
        setIncomingFile(metadata);
      },
      onFileProgress: (progress) => {
        setTransferProgress(progress);
      },
      onFileComplete: (blob, metadata) => {
        addLog(`文件接收完成: ${metadata.name}`);
        downloadFile(blob, metadata.name);
        setIncomingFile(null);
        setTransferProgress(0);
      },
      onSendProgress: (_metadata, sentBytes, totalBytes) => {
        const activeItemId = sendQueueStateRef.current.activeItemId;
        if (!activeItemId) {
          return;
        }
        dispatchSendQueue({
          type: 'update-progress',
          itemId: activeItemId,
          sentBytes,
          totalBytes
        });
      },
      onSendComplete: (metadata) => {
        const activeItemId = sendQueueStateRef.current.activeItemId;
        if (activeItemId) {
          dispatchSendQueue({
            type: 'update-progress',
            itemId: activeItemId,
            sentBytes: metadata.size,
            totalBytes: metadata.size
          });
        }
      },
      onError: (err) => {
        addLog(`错误: ${err.message}`);
        setError(err.message);
      }
    });
  }, [addLog]);

  // 创建房间
  const handleCreateRoom = async () => {
    // 再次检查浏览器支持
    const support = P2PConnection.checkSupport();
    if (!support.supported) {
      setError(support.error || '浏览器不支持 WebRTC');
      return;
    }

    setAppState('creating');
    setError('');
    
    try {
      const conn = createConnection();
      const code = await conn.connect();
      setConnection(conn);
      setRoomCode(code);
      setAppState('connected');
      addLog(`房间创建成功: ${code}`);
    } catch (err) {
      setError((err as Error).message);
      setAppState('error');
    }
  };

  // 加入房间
  const handleJoinRoom = async (code: string) => {
    // 再次检查浏览器支持
    const support = P2PConnection.checkSupport();
    if (!support.supported) {
      setError(support.error || '浏览器不支持 WebRTC');
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      setError('请输入有效的 6 位数字房间码');
      return;
    }
    
    setAppState('joining');
    setError('');
    
    try {
      const conn = createConnection();
      await conn.connect(code);
      setConnection(conn);
      setRoomCode(code);
      setAppState('connected');
      addLog(`已加入房间: ${code}`);
    } catch (err) {
      setError((err as Error).message);
      setAppState('error');
    }
  };

  // 入队发送文件（串行队列）
  const handleSendFiles = (files: File[]) => {
    if (!isConnected) {
      addLog('当前未连接，无法加入发送队列');
      return;
    }

    if (files.length === 0) {
      return;
    }

    const queueItems = createOutgoingQueueItems(files);
    dispatchSendQueue({ type: 'enqueue', items: queueItems });
    addLog(`已加入发送队列: ${files.length} 个文件`);
  };

  const handleRetryQueueItem = (itemId: string) => {
    const target = sendQueueStateRef.current.items.find((item) => item.id === itemId);
    if (!target) {
      return;
    }
    dispatchSendQueue({ type: 'retry', itemId });
    addLog(`已重新排队: ${target.file.name}`);
  };

  const handleRemoveQueueItem = (itemId: string) => {
    const target = sendQueueStateRef.current.items.find((item) => item.id === itemId);
    if (!target) {
      return;
    }
    dispatchSendQueue({ type: 'remove', itemId });
    addLog(`已移除队列项: ${target.file.name}`);
  };

  const handleClearCompletedQueueItems = () => {
    const completedCount = sendQueueStateRef.current.items.filter((item) => item.status === 'completed').length;
    if (completedCount <= 0) {
      return;
    }
    dispatchSendQueue({ type: 'clear-completed' });
    addLog(`已清理已完成项: ${completedCount} 个`);
  };

  // 断开连接
  const handleDisconnect = () => {
    sendQueueProcessorActiveRef.current = false;
    connection?.disconnect();
    setConnection(null);
    setRoomCode('');
    setIsConnected(false);
    setIncomingFile(null);
    setTransferProgress(0);
    dispatchSendQueue({ type: 'reset' });
    setAppState('home');
    setLogs([]);
  };

  // 下载文件
  const downloadFile = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 清理
  useEffect(() => {
    return () => {
      connection?.disconnect();
    };
  }, [connection]);

  // 如果不支持，显示错误页面
  if (appState === 'unsupported' && browserError) {
    return (
      <div className="app">
        <div className="geo-top">
          <div className="geo-bar geo-bar-1" />
          <div className="geo-bar geo-bar-2" />
          <div className="geo-bar geo-bar-3" />
        </div>

        <main className="main">
          <header className="header">
            <h1 className="title">
              <span className="title-main">PEER</span>
              <span className="title-accent">SHARE</span>
            </h1>
            <p className="subtitle">点对点文件传输</p>
          </header>

          <div className="unsupported-banner">
            <div className="unsupported-icon">⚠</div>
            <h2 className="unsupported-title">浏览器不兼容</h2>
            <p className="unsupported-message">{browserError}</p>
            <div className="unsupported-browsers">
              <p>推荐使用以下浏览器：</p>
              <div className="browser-list">
                <span className="browser-item">Chrome</span>
                <span className="browser-item">Edge</span>
                <span className="browser-item">Firefox</span>
                <span className="browser-item">Safari</span>
              </div>
            </div>
          </div>
        </main>

        <footer className="footer">
          <div className="footer-geo">
            <div className="footer-bar" />
            <div className="footer-triangle" />
          </div>
          <p className="footer-text">P2P · DTLS 加密 · 无服务器存储</p>
        </footer>
      </div>
    );
  }

  return (
    <div className="app">
      {/* 顶部几何装饰 */}
      <div className="geo-top">
        <div className="geo-bar geo-bar-1" />
        <div className="geo-bar geo-bar-2" />
        <div className="geo-bar geo-bar-3" />
      </div>

      {/* 主内容 */}
      <main className="main">
        {/* 标题区域 */}
        <header className="header">
          <h1 className="title">
            <span className="title-main">PEER</span>
            <span className="title-accent">SHARE</span>
          </h1>
          <p className="subtitle">点对点文件传输</p>
        </header>

        {/* 状态指示器 */}
        {appState !== 'home' && (
          <div className="status-bar">
            <div className={`status-indicator ${isConnected ? 'connected' : 'waiting'}`} />
            <span className="status-text">
              {isConnected ? '已连接' : '等待连接...'}
            </span>
            {roomCode && (
              <span className="room-code-display">房间码: <strong data-testid="room-code-value">{roomCode}</strong></span>
            )}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError('')} className="error-close">×</button>
          </div>
        )}

        {/* 屏幕切换 */}
        {appState === 'home' && (
          <HomeScreen 
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
          />
        )}

        {(appState === 'creating' || appState === 'joining' || appState === 'connected') && (
          <TransferScreen
            isConnected={isConnected}
            incomingFile={incomingFile}
            progress={transferProgress}
            outgoingQueue={sendQueueState.items}
            onSendFiles={handleSendFiles}
            onRetryQueueItem={handleRetryQueueItem}
            onRemoveQueueItem={handleRemoveQueueItem}
            onClearCompletedQueueItems={handleClearCompletedQueueItems}
            onDisconnect={handleDisconnect}
          />
        )}
      </main>

      {/* 日志区域 */}
      {logs.length > 0 && (
        <aside className="log-panel">
          <div className="log-header">
            <span>系统日志</span>
            <button onClick={() => setLogs([])} className="log-clear">清空</button>
          </div>
          <div className="log-content">
            {logs.map((log, i) => (
              <div key={i} className="log-line">{log}</div>
            ))}
          </div>
        </aside>
      )}

      {/* 底部装饰 */}
      <footer className="footer">
        <div className="footer-geo">
          <div className="footer-bar" />
          <div className="footer-triangle" />
        </div>
        <p className="footer-text">P2P · DTLS 加密 · 无服务器存储</p>
      </footer>
    </div>
  );
}
