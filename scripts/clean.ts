#!/usr/bin/env bun
/**
 * 清理构建输出
 */

import { readdirSync, unlinkSync, statSync } from 'fs';
import { resolve } from 'path';

const publicDir = resolve(import.meta.dir, '../public');

try {
  const files = readdirSync(publicDir);
  let count = 0;
  
  for (const file of files) {
    if (file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.map')) {
      const filepath = resolve(publicDir, file);
      const stat = statSync(filepath);
      if (stat.isFile()) {
        unlinkSync(filepath);
        count++;
        console.log(`✓ 已删除: ${file}`);
      }
    }
  }
  
  console.log(`\n共清理 ${count} 个文件`);
} catch (error) {
  console.error('✗ 清理失败:', error);
  process.exit(1);
}
