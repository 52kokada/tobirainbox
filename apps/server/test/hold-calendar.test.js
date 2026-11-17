// Calendar plan step 5: the shared 調整中 calendar, owned by one mailbox per business (D28, D43, D52).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import {
  CalendarError, ensureHoldCalendar, shareHoldCalendar, holdCalendarTag, holdCalendarName, holdTitle,
} from '../src/calendar.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let db; let biz; let info; let leo; let gus;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); info = newId(); leo = newId(); gus = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access) VALUES (?, 'Tobira', 'active', 'delegated')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, ?, 'enc', ?, ?)");
  m.run(info, biz, 'info@example.com', 'connected', 'paused');
  m.run(leo, biz, 'leo@example.com', 'connected', 'live');
  m.run(gus, biz, 'gus@example.com', 'connected', 'live');
  m.run(newId(), biz, 'old@example.com', 'disconnected', 'live');
});

/** Fake Google: one calendar list per account; every call records the account it was made as. */
function fakeGoogle({ aclStatus = 200 } = {}) {
  const lists = new Map(); const calls = []; let n = 0;
  const clientFor = (mailbox) => {
    const as = mailbox.address;
    const rec = (op, extra = {}) => calls.push({ as, op, ...extra });
    return {
      async calendarList() { rec('calendarList'); return [...(lists.get(as) ?? [])]; },
      async insertCalendar(body) {
        rec('insertCalendar', { body });
        const c = { id: `cal${++n}@group.calendar.google.com`, ...body };
        lists.set(as, [...(lists.get(as) ?? []), c]);
        return c;
      },
      async insertAcl(calendarId, rule) {
        rec('insertAcl', { calendarId, rule });
        if (aclStatus !== 200) throw new CalendarError(aclStatus, { error: { message: 'Insufficient Permission' } });
        return { id: `user:${rule.email}` };
      },
    };
  };
  return { clientFor, calls, lists };
}

const setOwner = (id) => db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(id, biz);
const bizRow = () => db.prepare('SELECT * FROM businesses WHERE id = ?').get(biz);

test('creates "<business> 調整中" in the business timezone as the owner, stores it, and a second run is a no-op', async () => {
  setOwner(info);
  db.prepare("UPDATE businesses SET timezone = 'America/Los_Angeles' WHERE id = ?").run(biz);
  const g = fakeGoogle();
  const first = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  assert.equal(first.created, true);
  assert.equal(bizRow().hold_calendar_id, first.id);
  const ins = g.calls.filter((c) => c.op === 'insertCalendar');
  assert.equal(ins.length, 1);
  assert.deepEqual(ins[0].body, { summary: 'Tobira 調整中', description: `TobirAInbox ${holdCalendarTag(biz)}`, timeZone: 'America/Los_Angeles' });

  const second = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  assert.deepEqual([second.id, second.created], [first.id, false]);
  assert.equal(g.calls.filter((c) => c.op === 'insertCalendar').length, 1, 'idempotent');
});

test('after a lost id it finds our calendar by name and tag, never a same-named one without the tag', async () => {
  setOwner(info);
  const g = fakeGoogle();
  g.lists.set('info@example.com', [
    { id: 'theirs', summary: 'Tobira 調整中', description: 'made by hand' },
    { id: 'ours', summary: 'Tobira 調整中', description: `TobirAInbox ${holdCalendarTag(biz)}` },
  ]);
  db.prepare("UPDATE businesses SET hold_calendar_id = 'deleted-in-google' WHERE id = ?").run(biz);
  const r = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  assert.deepEqual([r.id, r.created], ['ours', false]);
  assert.equal(bizRow().hold_calendar_id, 'ours');
  assert.equal(g.calls.filter((c) => c.op === 'insertCalendar').length, 0);
});

test('refuses with a NULL owner, or an owner that is disconnected or of another business, and calls Google not at all', async () => {
  const g = fakeGoogle();
  await assert.rejects(ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor }), (e) => e.code === 'no_owner');
  db.prepare("UPDATE mailboxes SET status = 'error' WHERE id = ?").run(info);
  setOwner(info);
  await assert.rejects(ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor }), (e) => e.code === 'owner_unavailable');
  const other = newId(); const otherBox = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Shop', 'active')").run(other);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, status) VALUES (?, ?, 'x@shop.jp', 'connected')").run(otherBox, other);
  db.pragma('foreign_keys = OFF'); setOwner(otherBox); db.pragma('foreign_keys = ON');
  await assert.rejects(ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor }), (e) => e.code === 'owner_unavailable');
  assert.equal(g.calls.length, 0);
  assert.equal(bizRow().hold_calendar_id, null);
});

test('never calls calendars.insert or acl with a non-owner token; shares as writer with each other connected mailbox', async () => {
  setOwner(info);
  const g = fakeGoogle();
  const r = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  const share = await shareHoldCalendar({ db, businessId: biz, calendarId: r.id, owner: r.owner, clientFor: g.clientFor });
  assert.deepEqual(share, { shared: ['gus@example.com', 'leo@example.com'], failed: [], aclDenied: false });
  assert.ok(g.calls.every((c) => c.as === 'info@example.com'), 'every call made as the owner');
  assert.deepEqual(g.calls.filter((c) => c.op === 'insertAcl').map((c) => c.rule), [
    { role: 'writer', email: 'gus@example.com' }, { role: 'writer', email: 'leo@example.com' }]);
});

test('a refused ACL write is reported (Leo shares by hand, D51) and the calendar is still stored', async () => {
  setOwner(info);
  const g = fakeGoogle({ aclStatus: 403 });
  const r = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  const share = await shareHoldCalendar({ db, businessId: biz, calendarId: r.id, owner: r.owner, clientFor: g.clientFor });
  assert.equal(share.aclDenied, true);
  assert.deepEqual(share.shared, []);
  assert.equal(g.calls.filter((c) => c.op === 'insertAcl').length, 1, 'stops at the first refusal');
  assert.equal(bizRow().hold_calendar_id, r.id);
});

test('--shadow makes a separate "(test)" calendar stored as shadow_calendar_id', async () => {
  setOwner(info);
  const g = fakeGoogle();
  const live = await ensureHoldCalendar({ db, businessId: biz, clientFor: g.clientFor });
  const test1 = await ensureHoldCalendar({ db, businessId: biz, shadow: true, clientFor: g.clientFor });
  assert.notEqual(test1.id, live.id);
  assert.equal(bizRow().shadow_calendar_id, test1.id);
  assert.equal(bizRow().hold_calendar_id, live.id);
  assert.equal(g.calls.filter((c) => c.op === 'insertCalendar').at(-1).body.summary, 'Tobira 調整中 (test)');
  assert.equal((await ensureHoldCalendar({ db, businessId: biz, shadow: true, clientFor: g.clientFor })).created, false);
  assert.equal(holdCalendarName('Tobira', { shadow: true }), 'Tobira 調整中 (test)');
  assert.notEqual(holdCalendarTag(biz, { shadow: true }), holdCalendarTag(biz));
});

test('hold titles read "仮: <client>" (D7)', () => {
  assert.equal(holdTitle('株式会社サンプル'), '仮: 株式会社サンプル');
  assert.equal(holdTitle(''), '仮: 調整中');
});

test('bin/calendar-setup imports no send, outbox, ingest, label or Gmail module, even transitively', () => {
  const seen = new Set();
  const walk = (file) => {
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const next = resolve(dirname(file), m[1]);
      if (!seen.has(next)) { seen.add(next); walk(next); }
    }
  };
  walk(join(HERE, '..', 'bin', 'calendar-setup.js'));
  const reached = [...seen].map((p) => basename(p));
  for (const mod of ['send-queue.js', 'cockpit-outbox.js', 'ingest.js', 'mailboxes.js', 'gmail.js', 'app.js', 'worker.js']) assert.ok(!reached.includes(mod), `reaches ${mod}`);
});
