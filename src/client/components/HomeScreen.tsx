/**
 * PeerShare - 首页组件
 * 
 * 
 */

import { useState } from 'react';
import type { FormEvent } from 'react';

interface Props {
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
}

export function HomeScreen({ onCreateRoom, onJoinRoom }: Props) {
  const [joinCode, setJoinCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (joinCode.length === 6) {
      onJoinRoom(joinCode);
    }
  };

  return (
    <div className="home-screen">
      {/* 主操作区 - 创建房间 */}
      <section className="action-section primary">
        <div className="section-geo">
          <div className="geo-line" />
          <div className="geo-dot" />
        </div>
        
        <button 
          className="btn btn-primary"
          data-testid="create-room-button"
          onClick={onCreateRoom}
        >
          <span className="btn-text">创建传输</span>
          <span className="btn-arrow">→</span>
        </button>
        
        <p className="action-desc">生成新的 6 位房间码</p>
      </section>

      {/* 分隔 */}
      <div className="divider">
        <div className="divider-line" />
        <span className="divider-text">或</span>
        <div className="divider-line" />
      </div>

      {/* 次操作区 - 加入房间 */}
      <section className="action-section secondary">
        <div className="section-geo">
          <div className="geo-line geo-line-alt" />
        </div>

        {!isJoining ? (
          <button 
            className="btn btn-secondary"
            data-testid="show-join-form-button"
            onClick={() => setIsJoining(true)}
          >
            <span className="btn-text">加入传输</span>
            <span className="btn-arrow">↓</span>
          </button>
        ) : (
          <form onSubmit={handleJoinSubmit} className="join-form">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="输入 6 位房间码"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="code-input"
              data-testid="join-room-input"
              autoFocus
            />
            <div className="join-actions">
              <button 
                type="button" 
                className="btn btn-ghost"
                onClick={() => {
                  setIsJoining(false);
                  setJoinCode('');
                }}
              >
                取消
              </button>
              <button 
                type="submit" 
                className="btn btn-primary"
                data-testid="join-room-submit-button"
                disabled={joinCode.length !== 6}
              >
                加入
              </button>
            </div>
          </form>
        )}
      </section>

      {/* 说明文字 */}
      <div className="info-section">
        <div className="info-item">
          <span className="info-number">01</span>
          <span className="info-text">创建或加入房间</span>
        </div>
        <div className="info-item">
          <span className="info-number">02</span>
          <span className="info-text">建立 P2P 直连</span>
        </div>
        <div className="info-item">
          <span className="info-number">03</span>
          <span className="info-text">安全传输文件</span>
        </div>
      </div>
    </div>
  );
}
