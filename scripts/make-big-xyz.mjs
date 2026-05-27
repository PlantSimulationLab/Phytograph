// Generates a synthetic point cloud large enough to surface the
// getDisplayData allocator OOM. Default: 10M points (~280 MB ASCII), no
// colors or intensities (keeps the file tractable but still triggers the
// JS-array intermediate when crop preview runs).
//
// Output is written to tmp/big.xyz, which is gitignored.

import { mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const N = parseInt(process.env.N ?? '10000000', 10);

const outDir = join(repoRoot, 'tmp');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'big.xyz');

const stream = createWriteStream(outPath);
// Header lines are skipped by the parser (lines starting with `#`).
stream.write(`# synthetic ${N}-point cloud for memory stress testing\n`);
stream.write(`# x y z\n`);

// Distribute points in a unit cube with a deterministic LCG so the file
// is reproducible. Buffering chunks of 100k lines keeps Node's stream
// healthy without ballooning memory in the generator itself.
let seed = 0x9e3779b1;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

const CHUNK = 100_000;
let written = 0;
function writeChunk() {
  if (written >= N) {
    stream.end();
    console.log(`wrote ${written.toLocaleString()} points to ${outPath}`);
    return;
  }
  let buf = '';
  const count = Math.min(CHUNK, N - written);
  for (let i = 0; i < count; i++) {
    const x = (rand() * 10 - 5).toFixed(4);
    const y = (rand() * 10 - 5).toFixed(4);
    const z = (rand() * 10 - 5).toFixed(4);
    buf += `${x} ${y} ${z}\n`;
  }
  written += count;
  if (stream.write(buf)) {
    setImmediate(writeChunk);
  } else {
    stream.once('drain', writeChunk);
  }
}
writeChunk();
