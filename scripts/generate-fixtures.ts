#!/usr/bin/env bun
/**
 * Generate test fixture files for WebRTC baseline testing.
 * Uses streaming writes to keep memory usage stable for large files.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "fs";
import { once } from "events";
import { join } from "path";

const FIXTURES_DIR = "fixtures";
const CHUNK_SIZE = 1024 * 1024; // 1MB

const FIXTURES = [
  { name: "100mb.bin", size: 100 * 1024 * 1024 },
  { name: "500mb.bin", size: 500 * 1024 * 1024 },
  { name: "1gb.bin", size: 1024 * 1024 * 1024 }
];

function resolveFixtures(): { name: string; size: number }[] {
  if (process.env.FIXTURE_QUICK === "1") {
    return [FIXTURES[0]];
  }

  const requested = process.env.FIXTURE_FILES;
  if (!requested) {
    return FIXTURES;
  }

  const names = requested
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const selected = FIXTURES.filter((fixture) => names.includes(fixture.name.toLowerCase()));

  if (selected.length === 0) {
    throw new Error(`No fixtures matched FIXTURE_FILES=${requested}`);
  }

  return selected;
}

function generateChunk(size: number): Uint8Array {
  const chunk = new Uint8Array(size);
  let seed = 12345;

  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    chunk[i] = seed & 0xff;
  }

  return chunk;
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  const ok = stream.write(chunk);
  if (!ok) {
    await once(stream, "drain");
  }
}

async function generateFile(name: string, size: number): Promise<void> {
  const filepath = join(FIXTURES_DIR, name);

  if (existsSync(filepath)) {
    const existing = statSync(filepath);
    if (existing.size === size) {
      console.log(`[SKIP] ${name} already exists with correct size`);
      return;
    }
    console.log(`[REGEN] ${name} exists but size mismatch, regenerating...`);
  }

  console.log(`[GEN] Creating ${name} (${(size / (1024 * 1024)).toFixed(0)}MB)...`);
  const startedAt = performance.now();
  const stream = createWriteStream(filepath, { flags: "w" });

  try {
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      const currentChunkSize = Math.min(CHUNK_SIZE, size - offset);
      const chunk = generateChunk(currentChunkSize);
      await writeChunk(stream, chunk);

      if (offset > 0 && offset % (100 * 1024 * 1024) === 0) {
        const progress = ((offset / size) * 100).toFixed(0);
        console.log(`  ${progress}% (${(offset / (1024 * 1024)).toFixed(0)}MB)`);
      }
    }

    stream.end();
    await once(stream, "finish");
  } finally {
    if (!stream.closed) {
      stream.destroy();
    }
  }

  const duration = performance.now() - startedAt;
  console.log(`[DONE] ${name} created in ${(duration / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  console.log("[Fixture Generator] Starting...");
  console.log(`[Target] ${FIXTURES_DIR}/`);

  const fixtures = resolveFixtures();
  console.log(`[Fixtures] ${fixtures.map((fixture) => fixture.name).join(", ")}`);

  for (const fixture of fixtures) {
    // eslint-disable-next-line no-await-in-loop
    await generateFile(fixture.name, fixture.size);
  }

  console.log("[Fixture Generator] Complete");
}

main().catch((error) => {
  console.error("[ERROR]", error);
  process.exit(1);
});
