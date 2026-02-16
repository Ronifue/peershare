#!/usr/bin/env bun
/**
 * 复制 CSS 文件到 public 目录
 */

import { copyFileSync } from 'fs';
import { resolve } from 'path';

const src = resolve(import.meta.dir, '../src/client/styles.css');
const dest = resolve(import.meta.dir, '../public/styles.css');

try {
  copyFileSync(src, dest);
  console.log('✓ 已复制 styles.css 到 public 目录');
} catch (error) {
  console.error('✗ 复制 CSS 失败:', error);
  process.exit(1);
}
