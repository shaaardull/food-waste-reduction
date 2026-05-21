#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY_DENY_LIST } from '../src/lib/copy-lint';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const EXTS = new Set(['.tsx']);
// Staff-facing screens + the chrome live here. AdminOnboard, ValidationDetail,
// etc. are all inside `screens/`; the header copy is in App.tsx.
const INCLUDE_DIRS = ['screens'];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full);
    if (st.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (EXTS.has(extname(e))) {
      out.push(full);
    }
  }
  return out;
}

const LOCALES_DIR = join(SRC, 'locales');
async function localeFiles(): Promise<string[]> {
  try {
    const entries = await readdir(LOCALES_DIR);
    return entries.filter((e) => extname(e) === '.json').map((e) => join(LOCALES_DIR, e));
  } catch {
    return [];
  }
}

const roots = await Promise.all(INCLUDE_DIRS.map((d) => walk(join(SRC, d))));
const appFile = join(SRC, 'App.tsx');
const sourceFiles = [...roots.flat(), appFile];
const localeJsonFiles = await localeFiles();

const offences: { file: string; line: number; word: string; text: string }[] = [];

// All user-facing copy now lives in src/locales/*.json (the JSON walker
// below catches that). The source-file scan is a backstop: it should only
// flag a deny word that escaped i18n into raw JSX text content, not an
// identifier or a t('key') argument. Match `>some text with WORD<` on one
// line — that's JSX text.
function shouldFlag(line: string, word: string): boolean {
  return new RegExp(`>[^<>]*\\b${word}\\b[^<>]*<`, 'i').test(line);
}

for (const file of sourceFiles) {
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

function walkJsonStrings(node: unknown, file: string, path: string[]) {
  if (typeof node === 'string') {
    for (const word of COPY_DENY_LIST) {
      const re = new RegExp(`\\b${word}\\b`, 'i');
      if (re.test(node)) {
        offences.push({ file, line: 0, word, text: `${path.join('.')}: ${node}` });
      }
    }
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => walkJsonStrings(v, file, [...path, String(i)]));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      walkJsonStrings(v, file, [...path, k]);
    }
  }
}

for (const file of localeJsonFiles) {
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  walkJsonStrings(parsed, file, []);
}

if (offences.length > 0) {
  console.error('copy-lint failed: deny-list terms found in staff-facing strings:');
  for (const o of offences) {
    console.error(`  ${o.file}:${o.line}  "${o.word}"  ${o.text}`);
  }
  process.exit(1);
}
console.log('copy-lint passed.');
