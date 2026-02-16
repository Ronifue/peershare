/**
 * PeerShare - 传输页面组件
 * 
 * 
 */

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { formatBytes } from '../utils';
import type { FileMetadata } from '../../common/types';
import type { OutgoingQueueItem } from '../send-queue';

interface Props {
  isConnected: boolean;
  incomingFile: FileMetadata | null;
  progress: number;
  outgoingQueue: OutgoingQueueItem[];
  onSendFiles: (files: File[]) => void;
  onRetryQueueItem: (itemId: string) => void;
  onRemoveQueueItem: (itemId: string) => void;
  onClearCompletedQueueItems: () => void;
  onDisconnect: () => void;
}

function getQueueStatusLabel(status: OutgoingQueueItem["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "sending") return "发送中";
  if (status === "completed") return "已完成";
  return "失败";
}

export function TransferScreen({
  isConnected,
  incomingFile,
  progress,
  outgoingQueue,
  onSendFiles,
  onRetryQueueItem,
  onRemoveQueueItem,
  onClearCompletedQueueItems,
  onDisconnect
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const activeOutgoing = outgoingQueue.find((item) => item.status === "sending") ?? null;

  const queueSummary = outgoingQueue.reduce((acc, item) => {
    acc.total += 1;
    if (item.status === "queued") acc.queued += 1;
    if (item.status === "sending") acc.sending += 1;
    if (item.status === "completed") acc.completed += 1;
    if (item.status === "failed") acc.failed += 1;
    return acc;
  }, {
    total: 0,
    queued: 0,
    sending: 0,
    completed: 0,
    failed: 0
  });

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0 && isConnected) {
      onSendFiles(files);
    }
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0 && isConnected) {
      onSendFiles(files);
    }
  };

  return (
    <div className="transfer-screen" data-testid="transfer-screen">
      {/* 文件拖放区 */}
      <section className="drop-zone-section">
        <div
          className={`drop-zone ${isDragging ? 'dragging' : ''} ${!isConnected ? 'disabled' : ''}`}
          onClick={() => isConnected && fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className="drop-zone-content">
            <div className="drop-icon">
              <div className="drop-icon-bar" />
              <div className="drop-icon-bar" />
              <div className="drop-icon-triangle" />
            </div>
            
            {isConnected ? (
              <>
                <p className="drop-text">点击或拖放文件至此处</p>
                <p className="drop-hint">支持多选，按队列串行发送</p>
              </>
            ) : (
              <p className="drop-text waiting">等待对方连接...</p>
            )}
          </div>
          
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="file-input"
            data-testid="file-input"
            disabled={!isConnected}
          />
        </div>

        {/* 发送状态 */}
        {activeOutgoing && (
          <div className="sending-indicator">
            <div className="sending-header">
              <div className="sending-geo" />
              <span className="sending-label">发送中</span>
              <span className="sending-attempt">第 {activeOutgoing.attempts} 次尝试</span>
            </div>
            <div className="sending-file">
              <div className="file-icon">◼</div>
              <div className="file-info">
                <span className="file-name">{activeOutgoing.file.name}</span>
                <span className="file-size">{formatBytes(activeOutgoing.file.size)}</span>
              </div>
            </div>
            <div className="progress-bar">
              <div 
                className="progress-fill sending" 
                style={{ width: `${activeOutgoing.progressPercent}%` }}
              />
              <span className="progress-text">{activeOutgoing.progressPercent.toFixed(0)}%</span>
            </div>
          </div>
        )}
      </section>

      {/* 串行发送队列 */}
      {outgoingQueue.length > 0 && (
        <section className="queue-section" data-testid="send-queue">
          <div className="queue-header">
            <div className="queue-title-wrap">
              <div className="queue-geo" />
              <span className="queue-title">发送队列</span>
            </div>
            <div className="queue-meta">
              <span className="queue-meta-item">总计 {queueSummary.total}</span>
              <span className="queue-meta-item">排队 {queueSummary.queued}</span>
              <span className="queue-meta-item">失败 {queueSummary.failed}</span>
            </div>
          </div>

          <div className="queue-list">
            {outgoingQueue.map((item) => (
              <article key={item.id} className={`queue-item status-${item.status}`}>
                <div className="queue-item-main">
                  <div className="queue-file-meta">
                    <span className="queue-file-name">{item.file.name}</span>
                    <span className="queue-file-size">{formatBytes(item.file.size)}</span>
                  </div>
                  <div className={`queue-status-badge status-${item.status}`}>
                    {getQueueStatusLabel(item.status)}
                  </div>
                </div>

                <div className="queue-item-sub">
                  <span className="queue-attempts">尝试次数: {item.attempts}</span>
                  {item.errorMessage && (
                    <span className="queue-error">{item.errorMessage}</span>
                  )}
                </div>

                {(item.status === "sending" || item.status === "completed" || item.progressPercent > 0) && (
                  <div className="progress-bar queue-progress">
                    <div className="progress-fill" style={{ width: `${item.progressPercent}%` }} />
                    <span className="progress-text">{item.progressPercent.toFixed(0)}%</span>
                  </div>
                )}

                <div className="queue-actions">
                  {item.status === "failed" && (
                    <button
                      type="button"
                      className="btn btn-ghost queue-action-btn"
                      onClick={() => onRetryQueueItem(item.id)}
                    >
                      重试
                    </button>
                  )}
                  {item.status !== "sending" && (
                    <button
                      type="button"
                      className="btn btn-ghost queue-action-btn"
                      onClick={() => onRemoveQueueItem(item.id)}
                    >
                      移除
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

          {queueSummary.completed > 0 && (
            <div className="queue-footer">
              <button
                type="button"
                className="btn btn-ghost queue-clear-btn"
                onClick={onClearCompletedQueueItems}
              >
                清理已完成项（{queueSummary.completed}）
              </button>
            </div>
          )}
        </section>
      )}

      {/* 接收文件提示 */}
      {incomingFile && (
        <section className="incoming-section">
          <div className="incoming-header">
            <div className="incoming-geo" />
            <span className="incoming-label">传入文件</span>
          </div>
          
          <div className="incoming-file">
            <div className="file-icon">◼</div>
            <div className="file-info">
              <span className="file-name">{incomingFile.name}</span>
              <span className="file-size">{formatBytes(incomingFile.size)}</span>
            </div>
          </div>
          
          {progress > 0 && (
            <div className="progress-bar">
              <div 
                className="progress-fill" 
                style={{ width: `${progress}%` }}
              />
              <span className="progress-text">{progress.toFixed(0)}%</span>
            </div>
          )}
        </section>
      )}

      {/* 操作按钮 */}
      <section className="actions-section">
        <button 
          className="btn btn-disconnect"
          onClick={onDisconnect}
        >
          <span className="btn-text">断开连接</span>
          <span className="btn-arrow">×</span>
        </button>
      </section>

      {/* 连接信息 */}
      <section className="connection-info">
        <div className="info-grid">
          <div className={`info-cell ${isConnected ? 'active' : ''}`}>
            <span className="cell-label">信号</span>
            <span className="cell-value">{isConnected ? '稳定' : '等待'}</span>
          </div>
          <div className={`info-cell ${isConnected ? 'active' : ''}`}>
            <span className="cell-label">加密</span>
            <span className="cell-value">DTLS 1.2</span>
          </div>
          <div className={`info-cell ${isConnected ? 'active' : ''}`}>
            <span className="cell-label">直连</span>
            <span className="cell-value" data-testid="p2p-status-direct">{isConnected ? '已建立' : '未建立'}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
