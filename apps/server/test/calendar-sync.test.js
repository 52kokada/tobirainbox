// Calendar plan step 6: read sync into calendar_events and what each viewer may see of it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { Calendar } from '../src/calendar.js';
import { syncCalendar, calendarPass, calendarsToSync, eventRow, zonedMidnightUtc, requestResync, ALERT_AFTER_FAILURES } from '../src/calendar-sync.js';
import { eventsForViewer, ownMailboxId } from '../src/calendar-view.js';
import { raiseAlert, resolveAlerts } from '../src/alerts.js';
import { buildApp } from '../src/app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-08T00:00:00Z');
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString();
const ev = (id, startMs, extra = {}) => ({ id, etag: `"${id}"`, status: 'confirmed', summary: `title ${id}`, start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + 30 * 60_000) }, ...extra });

let db; let biz; let leo; let gus; let info;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); gus = newId(); info = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode) VALUES (?, 'Tobira', 'active', 'delegated', 'shadow')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, ?, 'enc', 'connected', 'live')");
  m.run(leo, biz, 'leo@example.com'); m.run(gus, biz, 'gus@example.com'); m.run(info, biz, 'info@example.com');
});

/** A fake Calendar REST API over fetch, recording every events.list query. */
function fakeApi(handler) {
  const queries = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams);
    queries.push(q);
    const r = await handler(q, decodeURIComponent(u.pathname.split('/calendars/')[1].split('/')[0]));
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json ?? {} };
  };
  return { client: new Calendar({ accessToken: async () => 'AT', fetchImpl }), queries };
}
const target = () => ({ mailboxId: leo, calendarId: 'leo@example.com', mailbox: { address: 'leo@example.com' } });
const cached = () => db.prepare('SELECT * FROM calendar_events WHERE business_id = ? ORDER BY start_utc').all(biz);
const syncState = () => db.prepare('SELECT * FROM calendar_sync WHERE business_id = ?').get(biz);

test('first pass is a full -30/+120 day list with singleEvents; later passes send only the syncToken, no timeMin', async () => {
  let pass = 0;
  const api = fakeApi((q) => {
    pass++;
    if (pass === 1) return { json: { items: [ev('a', NOW + DAY)], nextSyncToken: 'tok1' } };
    return { json: { items: [ev('b', NOW + 2 * DAY)], nextSyncToken: 'tok2' } };
  });
  const r1 = await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW });
  assert.deepEqual([r1.ok, r1.full], [true, true]);
  assert.equal(api.queries[0].timeMin, iso(NOW - 30 * DAY));
  assert.equal(api.queries[0].timeMax, iso(NOW + 120 * DAY));
  assert.equal(api.queries[0].singleEvents, 'true');
  assert.equal(api.queries[0].syncToken, undefined);
  assert.equal(syncState().sync_token, 'tok1');

  const r2 = await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW + 60_000 });
  assert.deepEqual([r2.ok, r2.full], [true, false]);
  assert.equal(api.queries[1].syncToken, 'tok1');
  assert.equal(api.queries[1].timeMin, undefined);
  assert.equal(api.queries[1].timeMax, undefined);
  assert.equal(api.queries[1].singleEvents, 'true');
  assert.deepEqual(cached().map((r) => r.google_event_id), ['a', 'b']);
  assert.equal(syncState().sync_token, 'tok2');
  assert.equal(db.prepare('SELECT calendar_status FROM mailboxes WHERE id = ?').get(leo).calendar_status, 'ok');
});

test('410 Gone triggers a full resync that replaces the cache', async () => {
  let pass = 0;
  const api = fakeApi((q) => {
    pass++;
    if (pass === 1) return { json: { items: [ev('old', NOW + DAY)], nextSyncToken: 't1' } };
    if (q.syncToken) return { status: 410, json: { error: { message: 'Sync token is no longer valid' } } };
    return { json: { items: [ev('new', NOW + DAY)], nextSyncToken: 't2' } };
  });
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW });
  const r = await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW + 1000 });
  assert.deepEqual([r.ok, r.full], [true, true]);
  assert.equal(api.queries[2].timeMin, iso(NOW + 1000 - 30 * DAY));
  assert.deepEqual(cached().map((x) => x.google_event_id), ['new']);
  assert.equal(syncState().sync_token, 't2');
});

test('recurring events arrive expanded as instances; a cancelled instance deletes its cache row', async () => {
  let pass = 0;
  const weekly = [0, 7, 14].map((d) => ev(`r_2026111${d}`, NOW + (d + 1) * DAY, { recurringEventId: 'r', summary: '定例' }));
  const api = fakeApi(() => {
    pass++;
    if (pass === 1) return { json: { items: weekly, nextSyncToken: 't1' } };
    return { json: { items: [{ id: weekly[1].id, status: 'cancelled', recurringEventId: 'r' }], nextSyncToken: 't2' } };
  });
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW });
  assert.equal(api.queries[0].singleEvents, 'true');
  assert.equal(cached().length, 3);
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW + 1000 });
  assert.deepEqual(cached().map((r) => r.google_event_id), [weekly[0].id, weekly[2].id]);
});

test('incremental changes outside the window are pruned; the window slides with a weekly full resync', async () => {
  let pass = 0;
  const api = fakeApi((q) => {
    pass++;
    if (pass === 1) return { json: { items: [ev('in', NOW + DAY)], nextSyncToken: 't1' } };
    if (q.syncToken) return { json: { items: [ev('far', NOW + 200 * DAY), ev('past', NOW - 60 * DAY)], nextSyncToken: 't2' } };
    return { json: { items: [ev('slid', NOW + 8 * DAY)], nextSyncToken: 't3' } };
  });
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW });
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW + DAY });
  assert.deepEqual(cached().map((r) => r.google_event_id), ['in'], 'outside the window by start: pruned');
  const r = await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW + 7 * DAY });
  assert.equal(r.full, true, 'a week later: full resync');
  assert.equal(api.queries.at(-1).timeMin, iso(NOW + 7 * DAY - 30 * DAY));
  assert.equal(syncState().window_from, iso(NOW + 7 * DAY - 30 * DAY));
});

test('network failure is recorded, alerts after 3 failed passes, and clears on the next good pass', async () => {
  db.prepare('DELETE FROM mailboxes WHERE id IN (?, ?)').run(gus, info);
  let down = true;
  const api = fakeApi(() => {
    if (down) throw new TypeError('fetch failed');
    return { json: { items: [ev('a', NOW + DAY)], nextSyncToken: 't1' } };
  });
  const pushes = [];
  const alerts = { raise: (d, a) => raiseAlert(d, a, { push: async (...x) => { pushes.push(x); } }), resolve: resolveAlerts };
  const open = () => db.prepare("SELECT * FROM alerts WHERE business_id = ? AND kind = 'calendar_sync' AND resolved_at IS NULL").all(biz);
  for (let i = 1; i <= ALERT_AFTER_FAILURES; i++) {
    const [r] = await calendarPass({ db, clientFor: () => api.client, alerts, now: NOW + i });
    assert.equal(r.ok, false);
    assert.match(r.error, /fetch failed/);
    assert.equal(syncState().error_count, i);
    assert.equal(open().length, i < ALERT_AFTER_FAILURES ? 0 : 1);
  }
  assert.equal(db.prepare('SELECT calendar_status FROM mailboxes WHERE id = ?').get(leo).calendar_status, 'error');
  assert.match(syncState().last_error, /fetch failed/);
  down = false;
  const [ok] = await calendarPass({ db, clientFor: () => api.client, alerts, now: NOW + 10 });
  assert.equal(ok.ok, true);
  assert.deepEqual([syncState().error_count, syncState().last_error], [0, null]);
  assert.equal(open().length, 0, 'alert closed');
  assert.equal(pushes.length, 1, 'one ping for the open alert');
});

test('a client that cannot be built (no signer) counts as a failed pass', async () => {
  db.prepare('DELETE FROM mailboxes WHERE id IN (?, ?)').run(gus, info);
  const [r] = await calendarPass({ db, clientFor: () => { throw new Error('service account not configured'); }, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(syncState().error_count, 1);
});

test('calendar_mode off syncs nothing and never builds a client; shadow reads the shadow 調整中 calendar', async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'off', hold_calendar_owner_mailbox_id = ?, hold_calendar_id = 'hold@g', shadow_calendar_id = 'test@g' WHERE id = ?").run(info, biz);
  let built = 0;
  assert.deepEqual(await calendarPass({ db, clientFor: () => { built++; return null; }, now: NOW }), []);
  assert.equal(built, 0);
  assert.deepEqual(calendarsToSync(db, biz), []);
  db.prepare("UPDATE businesses SET calendar_mode = 'shadow' WHERE id = ?").run(biz);
  assert.deepEqual(calendarsToSync(db, biz).map((t) => [t.mailboxId, t.calendarId, t.mailbox.address]), [
    [gus, 'gus@example.com', 'gus@example.com'], [info, 'info@example.com', 'info@example.com'],
    [leo, 'leo@example.com', 'leo@example.com'], [null, 'test@g', 'info@example.com']]);
  db.prepare("UPDATE businesses SET calendar_mode = 'on' WHERE id = ?").run(biz);
  assert.equal(calendarsToSync(db, biz).at(-1).calendarId, 'hold@g');
  db.prepare("UPDATE businesses SET calendar_access = 'per_mailbox' WHERE id = ?").run(biz);
  db.prepare("UPDATE mailboxes SET calendar_token_enc = 'x' WHERE id = ?").run(gus);
  assert.deepEqual(calendarsToSync(db, biz).map((t) => t.calendarId), ['gus@example.com'], 'per_mailbox: only consented mailboxes; owner without consent reads no hold calendar');
});

test('event rows: all-day in the business timezone, Meet link, our hidden tag', () => {
  assert.equal(zonedMidnightUtc('2026-11-10', 'Asia/Tokyo'), '2026-11-09T15:00:00.000Z');
  assert.equal(zonedMidnightUtc('2026-11-01', 'America/Los_Angeles'), '2026-11-01T07:00:00.000Z');
  const allDay = eventRow({ id: 'd', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }, 'Asia/Tokyo');
  assert.deepEqual([allDay.start_utc, allDay.end_utc, allDay.all_day], ['2026-11-09T15:00:00.000Z', '2026-11-10T15:00:00.000Z', 1]);
  assert.equal(eventRow(ev('m', NOW, { hangoutLink: 'https://meet.google.com/abc-defg-hij' }), 'Asia/Tokyo').meet_url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(eventRow(ev('z', NOW, { location: 'https://us02web.zoom.us/j/123456789' }), 'Asia/Tokyo').meet_url, 'https://us02web.zoom.us/j/123456789');
  const ours = eventRow(ev('h', NOW, { extendedProperties: { private: { tobiraInbox: '1', tbiKind: 'hold', tbiId: 'h1', tbiBusiness: biz } } }), 'Asia/Tokyo');
  assert.equal(ours.ours_tag, 'hold:h1');
  assert.equal(eventRow(ev('x', NOW), 'Asia/Tokyo').ours_tag, null);
});

test('a private event is full to its owner and busy-only to another member and to a partner', async () => {
  const api = fakeApi(() => ({ json: { items: [
    ev('p', NOW + DAY, { visibility: 'private', summary: '歯医者', location: '渋谷', description: 'secret', hangoutLink: 'https://meet.google.com/abc-defg-hij' }),
    ev('w', NOW + 2 * DAY, { summary: '打ち合わせ' }),
  ], nextSyncToken: 't' } }));
  await syncCalendar({ db, businessId: biz, target: target(), client: api.client, now: NOW });
  const rows = cached();
  const mine = eventsForViewer(rows, { ownMailboxId: ownMailboxId(db, biz, 'Leo@example.com') });
  assert.equal(mine.find((e) => e.google_event_id === 'p').title, '歯医者');
  assert.equal(mine.find((e) => e.google_event_id === 'p').meet_url, 'https://meet.google.com/abc-defg-hij');

  for (const viewer of [{ ownMailboxId: ownMailboxId(db, biz, 'gus@example.com') }, { ownMailboxId: ownMailboxId(db, biz, 'p@partner.jp') }]) {
    const seen = eventsForViewer(rows, viewer);
    const p = seen.find((e) => e.start_utc === rows[0].start_utc);
    assert.equal(p.busy, true);
    const json = JSON.stringify(p);
    for (const leak of ['歯医者', '渋谷', 'secret', 'meet.google.com', '"p"']) assert.ok(!json.includes(leak), `leaks ${leak}`);
    assert.deepEqual(Object.keys(p).sort(), ['all_day', 'busy', 'end_utc', 'google_calendar_id', 'id', 'mailbox_id', 'start_utc']);
    assert.equal(seen.find((e) => e.google_event_id === 'w').title, '打ち合わせ', 'non-private events stay visible');
  }
  assert.equal(ownMailboxId(db, biz, 'p@partner.jp'), null);
});

test('admin manual sync: 409 while off, otherwise the next pass is a full resync', async () => {
  const app = buildApp({ db, config: { adminToken: 'ADMIN', masterKey: Buffer.alloc(32).toString('base64') } });
  db.prepare("INSERT INTO calendar_sync (business_id, mailbox_id, google_calendar_id, sync_token, window_from) VALUES (?, ?, 'leo@example.com', 't', 'x')").run(biz, leo);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/businesses/${biz}/calendar/sync?key=nope` })).statusCode, 403);
  const r = await app.inject({ method: 'POST', url: `/admin/businesses/${biz}/calendar/sync?key=ADMIN` });
  assert.deepEqual(r.json(), { ok: true, calendars: 1 });
  assert.deepEqual([syncState().sync_token, syncState().window_from], [null, null]);
  db.prepare("UPDATE businesses SET calendar_mode = 'off' WHERE id = ?").run(biz);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/businesses/${biz}/calendar/sync?key=ADMIN` })).statusCode, 409);
  assert.equal(requestResync(db, 'nobody'), 0);
});

test('migration 0021 lets alerts take calendar_sync and keeps refusing junk kinds', () => {
  raiseAlert(db, { businessId: biz, kind: 'calendar_sync', key: 'k', title: 't' }, { push: async () => {} });
  assert.throws(() => db.prepare("INSERT INTO alerts (id, business_id, kind, key, title) VALUES ('x', ?, 'other', 'k', 't')").run(biz), /CHECK/);
});

test('the worker runs the calendar pass in its own block, and bin/calendar-sync-check reaches no send/outbox/ingest module', () => {
  const worker = readFileSync(join(HERE, '..', 'worker.js'), 'utf8');
  const block = worker.slice(worker.indexOf('if (Date.now() >= nextCalendar)'), worker.indexOf('for (let waited'));
  assert.ok(block.includes('calendarPass('));
  for (const bad of ['deliverDue', 'flushOutbox', 'ingestAll', 'transport']) assert.ok(!block.includes(bad), `calendar block uses ${bad}`);
  const seen = new Set();
  const walk = (file) => {
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const next = resolve(dirname(file), m[1]);
      if (!seen.has(next)) { seen.add(next); walk(next); }
    }
  };
  walk(join(HERE, '..', 'bin', 'calendar-sync-check.js'));
  const reached = [...seen].map((p) => basename(p));
  for (const mod of ['send-queue.js', 'cockpit-outbox.js', 'ingest.js', 'mailboxes.js', 'gmail.js', 'app.js', 'alerts.js']) assert.ok(!reached.includes(mod), `reaches ${mod}`);
});
