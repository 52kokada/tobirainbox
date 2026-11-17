// The outreach classifier, its corpus and corpus test are hash-pinned in
// fixtures/classifier-sync.json. This fails when one of them is edited without updating the manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MARK = '// END SYNC HEADER\n';
const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('packages/engine/test/fixtures/classifier-sync.json', root), 'utf8'));
const lf = (s) => s.replace(/\r\n/g, '\n');
const body = (s) => { const i = s.indexOf(MARK); return i >= 0 ? s.slice(i + MARK.length) : s; };
const sha = (s) => createHash('sha256').update(s).digest('hex');

for (const [path, want] of Object.entries(manifest.sha256)) {
  test(`${path} matches the synced ${manifest.source}`, () => {
    const text = lf(readFileSync(new URL(path, root), 'utf8'));
    const b = body(text);
    assert.equal(sha(b), want, `${path} changed; update fixtures/classifier-sync.json if intended`);
    const header = text.slice(0, text.length - b.length);
    if (header) assert.ok(header.includes(`sha256:${want}`), 'header hash matches body');
  });
}
