#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY_DENY_LIST } from '../src/lib/copy-lint';

const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const EXTS = new Set(['.ts', '.tsx']);
const SKIP = new Set(['copy-lint.ts']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full);
    if (st.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (EXTS.has(extname(e)) && !SKIP.has(e)) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(ROOT);
const offences: { file: string; line: number; word: string; text: string }[] = [];

for (const file of files) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const word of COPY_DENY_LIST) {
      if (lower.includes(word)) {
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
