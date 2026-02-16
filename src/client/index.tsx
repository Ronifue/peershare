/**
 * PeerShare - 客户端入口
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

console.log('[PeerShare] 开始初始化...');

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('[PeerShare] 找不到 root 元素');
  throw new Error('Root element not found');
}

console.log('[PeerShare] 找到 root 元素，创建 React root...');

const root = createRoot(rootElement);

console.log('[PeerShare] 渲染应用...');

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

console.log('[PeerShare] 应用已启动');
