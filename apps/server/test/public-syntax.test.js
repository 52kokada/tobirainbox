// Every browser script must at least parse: one stray quote in i18n.js (2026-11-06) left the whole
// console stuck on 読み込み中… while all server tests passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('every script in public/ parses', () => {
  const files = readdirSync(pub).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(pub, f)], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
