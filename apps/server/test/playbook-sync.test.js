// An outside playbook loads as rules, re-syncs in place, retires what was dropped,
// and never touches owner-written rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { buildApp } from '../src/app.js';

const config = { clientId: 'c', clientSecret: 's', masterKey: Buffer.alloc(32).toString('base64'), adminToken: 'tok', publicUrl: 'https://x' };

function setup() {
  const db = openDb(':memory:');
  const biz = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Example Studio', 'active')").run(biz);
  db.prepare("INSERT INTO playbook_rules (id, business_id, text) VALUES (?, ?, '既存のオーナーのルール')").run(newId(), biz);
  return { db, biz, app: buildApp({ db, config }) };
}
const put = (app, body, key = 'tok') => app.inject({ method: 'PUT', url: `/admin/playbook-sync?key=${key}`, payload: body });

test('loads, updates in place, retires dropped rules, leaves owner rules alone', async () => {
  const { db, biz, app } = setup();
  let r = await put(app, { business: 'Example Studio', prefix: 'tobira-playbook:', rules: [
    { key: 'A1', text: '「見てみたい」には書き直し案を作ると返す', phase: 'first' },
    { key: 'F2', text: 'イメージと違うと言われたら1回だけ作り直す', phase: 'sample' },
  ] });
  assert.deepEqual(r.json(), { ok: true, added: 2, updated: 0, unchanged: 0, retired: 0 });
  r = await put(app, { business: 'Example Studio', prefix: 'tobira-playbook:', rules: [
    { key: 'A1', text: '「見てみたい」には3営業日で書き直し案を送ると返す', phase: 'first' },
  ] });
  assert.deepEqual(r.json(), { ok: true, added: 0, updated: 1, unchanged: 0, retired: 1 });
  const active = new Store(db, biz).playbook().map((x) => x.text).sort();
  assert.deepEqual(active, ['「見てみたい」には3営業日で書き直し案を送ると返す', '既存のオーナーのルール'].sort());
  assert.equal(new Store(db, biz).playbook().find((x) => x.text.startsWith('「見てみたい」')).phase, 'first');
});

test('refuses without the admin key, unknown business, bad rules', async () => {
  const { app } = setup();
  assert.equal((await put(app, { business: 'Example Studio', prefix: 'p:', rules: [] }, 'nope')).statusCode, 403);
  assert.equal((await put(app, { business: 'Nobody', prefix: 'p:', rules: [] })).statusCode, 404);
  assert.equal((await put(app, { business: 'Example Studio', prefix: 'p:', rules: [{ key: 'x', text: 'あ'.repeat(1001) }] })).statusCode, 400);
  assert.equal((await put(app, { business: 'Example Studio', prefix: 'bad', rules: [] })).statusCode, 400);
});
