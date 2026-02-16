#!/usr/bin/env bun
/**
 * 构建脚本 - 使用 Bun API 构建并确保 UTF-8 编码
 */

import { build } from 'bun';
import { writeFileSync, copyFileSync } from 'fs';
import { resolve } from 'path';

const outDir = resolve(import.meta.dir, '../public');

console.log('开始构建...');

// 构建 JS
const result = await build({
  entrypoints: [resolve(import.meta.dir, '../src/client/index.tsx')],
  target: 'browser',
  define: {
    'process.env.NODE_ENV': '"production"'
  }
});

if (!result.success) {
  console.error('构建失败:', result.logs);
  process.exit(1);
}

// 获取输出并写入文件
const jsOutput = result.outputs[0];
const arrayBuffer = await jsOutput.arrayBuffer();
const uint8Array = new Uint8Array(arrayBuffer);

// 直接使用 Buffer 写入，确保不转换编码
writeFileSync(resolve(outDir, 'index.js'), uint8Array);
console.log('✓ 已生成 index.js');

// 复制 CSS
copyFileSync(
  resolve(import.meta.dir, '../src/client/styles.css'),
  resolve(outDir, 'styles.css')
);
console.log('✓ 已复制 styles.css');

console.log('构建完成!');
