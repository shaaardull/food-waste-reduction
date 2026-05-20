#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY_DENY_LIST } from '../src/lib/copy-lint';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const EXTS = new Set(['.tsx']); // .tsx only — that's where user-facing copy lives
// Only scan directories that hold user-facing screens / components.
const INCLUDE_DIRS = ['screens', 'components'];
const SKIP_FILES = new Set(['copy-lint.ts']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full);
    if (st.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (EXTS.has(extname(e)) && !SKIP_FILES.has(e)) {
      out.push(full);
    }
  }
  return out;
}

const roots = await Promise.all(INCLUDE_DIRS.map((d) => walk(join(SRC, d))));
// Also lint App.tsx at the src root (chrome / nav copy).
const appFile = join(SRC, 'App.tsx');
const files = [...roots.flat(), appFile];

const offences: { file: string; line: number; word: string; text: string }[] = [];

// Only flag words inside string literals (' " or `) or JSX text — not random identifier
// fragments. Word boundaries (\b) keep "body" from matching "bodyA" etc.
function shouldFlag(line: string, word: string): boolean {
  const re = new RegExp(`\\b${word}\\b`, 'i');
  if (!re.test(line)) return false;
  // Require the line to contain a string literal or JSX text content.
  // (cheap heuristic: a quote or > delimiter present)
  return /["'`]/.test(line) || /^[^<>{}]*[a-z]/i.test(line.trim());
}

for (const file of files) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const word of COPY_DENY_LIST) {
      if (shouldFlag(line, word)) {
        offences.push({ file, line: i + 1, word, text: line.trim() });
      }
    }
  });
}

if (offences.length > 0) {
  console.error('copy-lint failed: deny-list terms found in user-facing strings:');
  for (const o of offences) {
    console.error(`  ${o.file}:${o.line}  "${o.word}"  ${o.text}`);
  }
  process.exit(1);
}
console.log('copy-lint passed.');
