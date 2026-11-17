// Calendar plan step 3: migration 0019 and business calendar settings. Owners set timezone and
// free-slot hours; calendar_mode and the rest are admin-only (ADMIN_TOKEN) until Tobira is switched on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDb, migrate } from '../src/db.js';
import { newId, Store, parseFreeSlotHours, validTimezone } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', adminToken: 'ADMIN', aiDailyCapUsd: 0.5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

/** A database as production has it today: every migration before 0019, applied the way db.js records them. */
function preCalendarDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0019').sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, new Date().toISOString());
  }
  db.pragma('foreign_keys = ON');
  return db;
}

function seedFixture(db) {
  db.prepare("INSERT INTO businesses (id, name, status) VALUES ('b1', 'Example Studio', 'active'), ('b2', 'Shop', 'active')").run();
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES ('m1', 'b1', 'leo@example.com', 'enc', 'connected', 'live'), ('m2', 'b2', 'info@shop.jp', 'enc', 'connected', 'shadow')").run();
  db.prepare("INSERT INTO oauth_states (state, business_id, expires_at, purpose, return_to, oauth_client) VALUES ('s1', 'b1', '2099-01-01T00:00:00Z', 'login', '/x', 'internal'), ('s2', 'b2', '2099-01-01T00:00:00Z', 'connect', NULL, 'external')").run();
}

const tableCounts = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  .map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));

test('0019 on an existing database keeps every row and sets the defaults', () => {
  const db = preCalendarDb();
  seedFixture(db);
  const before = tableCounts(db);
  const oauthBefore = db.prepare('SELECT * FROM oauth_states ORDER BY state').all();
  migrate(db);
  const after = tableCounts(db);
  for (const [t, n] of Object.entries(before)) {
    // 0019 and every migration merged after it (0020 playbook key landed alongside step 3).
    if (t === 'schema_migrations') assert.equal(after[t], n + readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f >= '0019').length);
    else assert.equal(after[t], n, `${t} row count`);
  }
  for (const t of ['calendar_sync', 'calendar_events', 'suggestions', 'meetings', 'holds', 'calendar_writes', 'manager_undo_tokens', 'date_detections']) assert.equal(after[t], 0, t);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get('b1');
  assert.equal(b.calendar_mode, 'off');
  assert.equal(b.timezone, 'Asia/Tokyo');
  assert.equal(b.calendar_access, 'per_mailbox');
  assert.equal(b.hold_silence_days, 7);
  assert.equal(b.hold_calendar_owner_mailbox_id, null);
  assert.equal(b.shadow_calendar_id, null);
  assert.deepEqual(new Store(db, 'b1').calendarSettings().freeSlotHours, { days: [1, 2, 3, 4, 5], from: '10:00', to: '18:00' });
  const m = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get('m1');
  assert.equal(m.calendar_status, 'none');
  assert.equal(m.calendar_token_enc, null);
  assert.equal(m.token_enc, 'enc', 'the Gmail token is untouched');

  // oauth_states rebuilt: rows identical, new mailbox_id column, purpose accepts 'calendar' and still refuses junk.
  assert.deepEqual(db.prepare('SELECT state, business_id, login_hint, expires_at, used_at, purpose, return_to, oauth_client FROM oauth_states ORDER BY state').all(), oauthBefore);
  db.prepare("INSERT INTO oauth_states (state, business_id, expires_at, purpose, mailbox_id) VALUES ('s3', 'b1', '2099-01-01T00:00:00Z', 'calendar', 'm1')").run();
  assert.throws(() => db.prepare("INSERT INTO oauth_states (state, business_id, expires_at, purpose) VALUES ('s4', 'b1', '2099-01-01T00:00:00Z', 'other')").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE businesses SET calendar_mode = 'maybe' WHERE id = 'b1'").run(), /CHECK/);

  // Applied once: a second run is a no-op.
  migrate(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '0019_calendar.sql'").get().n, 1);
});

test('bin/migrate-check applies 0019 to a copy and leaves the source alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbi-migrate-'));
  try {
    const src = join(dir, 'src.db');
    const db = preCalendarDb(src); seedFixture(db); db.close();
    const out = JSON.parse(execFileSync(process.execPath, [join(HERE, '..', 'bin', 'migrate-check.js'), src, join(dir, 'copy.db')], { encoding: 'utf8', windowsHide: true }));
    assert.ok(out.appliedNow.includes('0019_calendar.sql'), 'copy has 0019');
    assert.deepEqual(out.changedCounts, []);
    assert.equal(out.foreignKeyProblems, 0);
    const again = new Database(src, { readonly: true });
    assert.equal(again.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '0019_calendar.sql'").get().n, 0, 'source not migrated');
    again.close();
    const source = readFileSync(join(HERE, '..', 'bin', 'migrate-check.js'), 'utf8');
    for (const mod of ['send-queue', 'cockpit-outbox', 'ingest', 'mailboxes', 'gmail', 'app.js']) assert.ok(!source.includes(`/${mod}`), `imports ${mod}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('calendar accessors never return another business\'s rows', () => {
  const db = openDb(':memory:');
  seedFixture(db);
  const ins = db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind)
    VALUES (?, ?, ?, 'GT', 'GM', 'theirs', 'ai', ?, 'offer')`);
  ins.run('sg1', 'b1', 'm1', '2026-11-10T01:00:00Z');
  ins.run('sg2', 'b2', 'm2', '2026-11-10T02:00:00Z');
  db.prepare(`INSERT INTO meetings (id, business_id, mailbox_id, start_utc, end_utc, confirmed_via, idem_key) VALUES
    ('mt1', 'b1', 'm1', '2026-11-11T01:00:00Z', '2026-11-11T02:00:00Z', 'console', 'k1'),
    ('mt2', 'b2', 'm2', '2026-11-11T01:00:00Z', '2026-11-11T02:00:00Z', 'console', 'k2')`).run();
  db.prepare("INSERT INTO holds (id, business_id, suggestion_id) VALUES ('h1', 'b1', 'sg1'), ('h2', 'b2', 'sg2')").run();
  db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, start_utc) VALUES
    ('b1', 'm1', 'c', 'e1', '2026-11-12T00:00:00Z'), ('b2', 'm2', 'c', 'e1', '2026-11-12T00:00:00Z')`).run();
  db.prepare("INSERT INTO calendar_writes (id, business_id, kind, idem_key) VALUES ('w1', 'b1', 'hold_create', 'i1'), ('w2', 'b2', 'hold_create', 'i2')").run();
  db.prepare("INSERT INTO calendar_sync (business_id, google_calendar_id) VALUES ('b1', 'c'), ('b2', 'c')").run();

  const s = new Store(db, 'b1');
  assert.deepEqual(s.suggestions().map((r) => r.id), ['sg1']);
  assert.equal(s.suggestion('sg2'), null);
  assert.deepEqual(s.suggestions({ from: '2026-11-11T00:00:00Z' }), []);
  assert.deepEqual(s.meetings({ state: 'confirmed' }).map((r) => r.id), ['mt1']);
  assert.equal(s.meeting('mt2'), null);
  assert.deepEqual(s.holds({ state: 'active' }).map((r) => r.id), ['h1']);
  assert.equal(s.hold('h2'), null);
  assert.equal(s.calendarEvents().length, 1);
  assert.deepEqual(s.calendarWrites({ status: 'pending' }).map((r) => r.id), ['w1']);
  assert.equal(s.calendarSync().length, 1);
  assert.throws(() => db.prepare("INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind, quote_redacted) VALUES ('x', 'b1', 'm1', 'g', 'g', 'ours', 'ai', 't', 'offer', ?)").run('あ'.repeat(121)), /CHECK/);
});

test('free-slot hours and timezone validation', () => {
  assert.deepEqual(parseFreeSlotHours({ days: [5, 1, 1], from: '09:30', to: '17:00' }), { days: [1, 5], from: '09:30', to: '17:00' });
  assert.equal(parseFreeSlotHours({ days: [7], from: '10:00', to: '18:00' }), null);
  assert.equal(parseFreeSlotHours({ days: [1], from: '18:00', to: '10:00' }), null);
  assert.equal(parseFreeSlotHours({ days: [], from: '10:00', to: '18:00' }), null);
  assert.equal(parseFreeSlotHours('not json'), null);
  assert.ok(validTimezone('America/Los_Angeles'));
  assert.ok(!validTimezone('Mars/Olympus'));
  assert.ok(!validTimezone(''));
});

async function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO businesses (id, name, status) VALUES ('b1', 'Example Studio', 'active'), ('b2', 'Shop', 'active')").run();
  for (const [email, role] of [['owner@example.com', 'owner'], ['staff@example.com', 'staff'], ['p@partner.jp', 'partner']]) {
    db.prepare('INSERT INTO users (id, business_id, email, role) VALUES (?, ?, ?, ?)').run(newId(), 'b1', email, role);
  }
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES ('m1', 'b1', 'info@example.com', ?, 'connected', 'paused'), ('m2', 'b2', 'info@shop.jp', ?, 'connected', 'live')")
    .run(encrypt('r', masterKey), encrypt('r', masterKey));
  let who = '';
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(who) }) });
  const as = async (email) => {
    who = email;
    const start = await app.inject('/auth/login');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
    const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
    return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  };
  return { db, app, as };
}

test('owner sets timezone and free-slot hours; calendar_mode and the rest are refused with 403', async () => {
  const { db, as } = await setup();
  const owner = await as('owner@example.com');
  assert.equal((await owner('PUT', '/api/settings/business', { timezone: 'America/Los_Angeles', freeSlotHours: { days: [1, 2, 3], from: '09:00', to: '17:00' } })).statusCode, 200);
  const b = db.prepare("SELECT timezone, free_slot_hours FROM businesses WHERE id = 'b1'").get();
  assert.equal(b.timezone, 'America/Los_Angeles');
  assert.deepEqual(JSON.parse(b.free_slot_hours), { days: [1, 2, 3], from: '09:00', to: '17:00' });
  assert.equal((await owner('PUT', '/api/settings/business', { timezone: 'Nowhere/City' })).statusCode, 400);
  assert.equal((await owner('PUT', '/api/settings/business', { freeSlotHours: { days: [1], from: '18:00', to: '09:00' } })).statusCode, 400);

  for (const body of [{ calendarMode: 'on' }, { calendarAccess: 'delegated' }, { holdCalendarOwnerMailboxId: 'm1' }, { shadowCalendarId: 'x' }, { holdSilenceDays: 3 }, { timezone: 'Asia/Tokyo', calendarMode: 'shadow' }]) {
    const r = await owner('PUT', '/api/settings/business', body);
    assert.equal(r.statusCode, 403, JSON.stringify(body));
  }
  const after = db.prepare("SELECT calendar_mode, calendar_access, timezone, hold_silence_days FROM businesses WHERE id = 'b1'").get();
  assert.deepEqual(after, { calendar_mode: 'off', calendar_access: 'per_mailbox', timezone: 'America/Los_Angeles', hold_silence_days: 7 }, 'a refused request changes nothing');

  const g = JSON.parse((await owner('GET', '/api/settings')).body);
  assert.equal(g.calendar.mode, 'off');
  assert.equal(g.calendar.timezone, 'America/Los_Angeles');
  assert.equal(g.calendar.holdSilenceDays, 7);
  assert.deepEqual(g.calendar.freeSlotHours, { days: [1, 2, 3], from: '09:00', to: '17:00' });
});

test('staff and partners cannot change timezone or free-slot hours', async () => {
  const { db, as } = await setup();
  const staff = await as('staff@example.com');
  assert.equal((await staff('PUT', '/api/settings/business', { timezone: 'Europe/London' })).statusCode, 403);
  assert.equal((await staff('PUT', '/api/settings/business', { freeSlotHours: { days: [0], from: '10:00', to: '11:00' } })).statusCode, 403);
  assert.equal(JSON.parse((await staff('GET', '/api/settings')).body).calendar.timezone, 'Asia/Tokyo', 'staff read the settings');
  const partner = await as('p@partner.jp');
  assert.equal((await partner('PUT', '/api/settings/business', { timezone: 'Europe/London' })).statusCode, 403);
  assert.equal(db.prepare("SELECT timezone FROM businesses WHERE id = 'b1'").get().timezone, 'Asia/Tokyo');
});

test('admin route sets the calendar mode and owner mailbox; needs ADMIN_TOKEN; stays inside the business', async () => {
  const { db, app } = await setup();
  const put = (payload, key = 'ADMIN', id = 'b1') => app.inject({ method: 'PUT', url: `/admin/businesses/${id}/calendar?key=${key}`, payload });
  assert.equal((await put({ calendarMode: 'on' }, 'WRONG')).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/admin/businesses/b1/calendar', payload: { calendarMode: 'on' } })).statusCode, 403);
  assert.equal(db.prepare("SELECT calendar_mode FROM businesses WHERE id = 'b1'").get().calendar_mode, 'off');

  const r = await put({ calendarMode: 'shadow', calendarAccess: 'delegated', holdCalendarOwnerMailboxId: 'm1', shadowCalendarId: 'test@group.calendar.google.com', holdSilenceDays: 10 });
  assert.equal(r.statusCode, 200);
  const s = JSON.parse(r.body);
  assert.equal(s.mode, 'shadow');
  assert.equal(s.access, 'delegated');
  assert.equal(s.holdCalendarOwnerMailboxId, 'm1');
  assert.equal(s.shadowCalendarId, 'test@group.calendar.google.com');
  assert.equal(s.holdSilenceDays, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin_calendar_settings'").get().n, 1);

  assert.equal((await put({ holdCalendarOwnerMailboxId: 'm2' })).statusCode, 400, 'a mailbox of another business');
  assert.equal((await put({ calendarMode: 'maybe' })).statusCode, 400);
  assert.equal((await put({ holdSilenceDays: 0 })).statusCode, 400);
  assert.equal((await put({ calendarMode: 'on' }, 'ADMIN', 'nope')).statusCode, 404);
  assert.equal((await put({ calendarMode: 'on' })).statusCode, 200);
  assert.equal(JSON.parse((await app.inject(`/admin/businesses/b1/calendar?key=ADMIN`)).body).mode, 'on');
  assert.equal(db.prepare("SELECT calendar_mode FROM businesses WHERE id = 'b2'").get().calendar_mode, 'off', 'other business untouched');
});
