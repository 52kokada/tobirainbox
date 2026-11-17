#!/usr/bin/env node
// Delete events TobirAInbox wrote to Google Calendar (plan step 11: rollback and shadow cleanup).
// Dry run by default: prints what it would delete and writes nothing (no Google write, no DB write).
// --apply deletes. Only events that carry our tag AND whose tbiId matches a row of this business are
// touched, each with If-Match on the etag we stored; a hand-edited event is skipped (D26). Meetings only
// by explicit id, never "all meetings". Starts no server or worker; imports no send, outbox, ingest,
// mailbox or label module.
//
//   node bin/calendar-release.js <businessId> --holds [--shadow] [--apply] [--db path]
//   node bin/calendar-release.js <businessId> --meetings <id,id,...> [--apply] [--db path]
//   node bin/calendar-release.js <businessId> --delete-calendar [--shadow] [--apply] [--db path]
//     (refuses while the calendar holds any event without our tag)
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { calendarFor } from '../src/calendar.js';
import { SaTokens, signerFromConfig } from '../src/sa-token.js';
import { isOurs, handEdited, holdTarget, releaseHold, releaseMeeting } from '../src/calendar-writes.js';

/**
 * → { apply, deleted: [...], wouldDelete: [...], skipped: [{eventId|id, reason}], calendarDeleted?, refused? }
 */
export async function release({ db, businessId, holds = false, meetings = null, deleteCalendar = false, shadow = false, apply = false, clientFor }) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!b) throw new Error('no such business');
  if (meetings != null && (!Array.isArray(meetings) || !meetings.length || meetings.some((m) => !m || m === 'all' || m === '*'))) {
    throw new Error('--meetings needs explicit ids');
  }
  const out = { apply, deleted: [], wouldDelete: [], skipped: [] };
  const calendarId = shadow ? b.shadow_calendar_id : b.hold_calendar_id;

  const listHoldCalendar = async () => {
    if (!calendarId) throw new Error(`${shadow ? 'shadow_calendar_id' : 'hold_calendar_id'} is not set`);
    const t = holdTarget(db, businessId, clientFor, { calendarId, allowOff: true });
    const { items } = await t.client.listEvents(calendarId, {});
    return items.filter((e) => e.status !== 'cancelled');
  };

  if (holds) {
    for (const ev of await listHoldCalendar()) {
      const tbiId = ev.extendedProperties?.private?.tbiId;
      const row = isOurs(ev, { kind: 'hold', businessId }) && db.prepare('SELECT * FROM holds WHERE id = ? AND business_id = ?').get(tbiId, businessId);
      if (!isOurs(ev)) { out.skipped.push({ eventId: ev.id, reason: 'untagged' }); continue; }
      if (!row || row.google_event_id !== ev.id || row.google_calendar_id !== calendarId) { out.skipped.push({ eventId: ev.id, reason: 'no matching hold row' }); continue; }
      if (handEdited(row, ev)) { out.skipped.push({ eventId: ev.id, holdId: row.id, reason: 'edited in Google' }); continue; }
      const item = { holdId: row.id, eventId: ev.id, summary: ev.summary ?? '' };
      if (!apply) { out.wouldDelete.push(item); continue; }
      try {
        await releaseHold({ db, businessId, hold: row, clientFor, reason: 'release-script', allowOff: true });
        db.prepare("UPDATE holds SET state = 'removed' WHERE id = ?").run(row.id);
        out.deleted.push(item);
      } catch (err) { out.skipped.push({ ...item, reason: err.code ?? err.message }); }
    }
  }

  for (const id of meetings ?? []) {
    const row = db.prepare('SELECT * FROM meetings WHERE id = ? AND business_id = ?').get(id, businessId);
    if (!row?.google_event_id) { out.skipped.push({ id, reason: 'no such meeting with an event' }); continue; }
    const item = { meetingId: row.id, eventId: row.google_event_id, calendarId: row.google_calendar_id };
    if (!apply) {
      // Read-only check, so the dry run shows what --apply would refuse.
      const target = row.google_calendar_id === b.shadow_calendar_id
        ? holdTarget(db, businessId, clientFor, { calendarId: row.google_calendar_id, allowOff: true }).client
        : clientFor(db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(row.mailbox_id));
      let ev = null;
      try { ev = await target.getEvent(row.google_calendar_id, row.google_event_id); } catch { /* gone */ }
      if (!ev || ev.status === 'cancelled') out.skipped.push({ ...item, reason: 'already gone' });
      else if (!isOurs(ev, { id: row.id, kind: 'meeting', businessId })) out.skipped.push({ ...item, reason: 'untagged or another tbiId' });
      else if (handEdited(row, ev)) out.skipped.push({ ...item, reason: 'edited in Google' });
      else out.wouldDelete.push(item);
      continue;
    }
    try {
      await releaseMeeting({ db, businessId, meeting: row, clientFor, allowOff: true });
      db.prepare("UPDATE meetings SET state = 'cancelled' WHERE id = ?").run(row.id);
      out.deleted.push(item);
    } catch (err) { out.skipped.push({ ...item, reason: err.code ?? err.message }); }
  }

  if (deleteCalendar) {
    const remaining = await listHoldCalendar();
    const untagged = remaining.filter((e) => !isOurs(e, { businessId }));
    if (untagged.length) {
      out.refused = `calendar holds ${untagged.length} event(s) without our tag; not deleted`;
    } else if (!apply) {
      out.wouldDeleteCalendar = calendarId;
    } else {
      const t = holdTarget(db, businessId, clientFor, { calendarId, allowOff: true });
      await t.client.deleteCalendar(calendarId);
      db.prepare(`UPDATE businesses SET ${shadow ? 'shadow_calendar_id' : 'hold_calendar_id'} = NULL WHERE id = ?`).run(businessId);
      db.prepare("INSERT INTO audit_log (business_id, action, target) VALUES (?, 'hold_calendar_deleted', ?)").run(businessId, calendarId);
      out.calendarDeleted = calendarId;
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const businessId = args.find((a, i) => !a.startsWith('--') && !['--db', '--meetings'].includes(args[i - 1]));
  const meetingsArg = val('--meetings');
  const holds = args.includes('--holds'); const deleteCalendar = args.includes('--delete-calendar');
  if (!businessId || (!holds && meetingsArg === undefined && !deleteCalendar)) {
    console.error('usage: node bin/calendar-release.js <businessId> (--holds [--shadow] | --meetings <id,id,...> | --delete-calendar [--shadow]) [--apply] [--db path]');
    process.exit(2);
  }
  const config = loadConfig();
  const db = new Database(val('--db') ?? join(config.dataDir, 'tobira-inbox.db'), { fileMustExist: true });
  const signer = signerFromConfig({ db, config });
  const saTokens = signer ? new SaTokens({ db, config, signer }) : null;
  try {
    const r = await release({
      db, businessId, holds, deleteCalendar, shadow: args.includes('--shadow'), apply: args.includes('--apply'),
      meetings: meetingsArg === undefined ? null : meetingsArg.split(',').map((s) => s.trim()).filter(Boolean),
      clientFor: (m) => calendarFor(m, { db, config, saTokens }),
    });
    console.log(JSON.stringify(r, null, 2));
    if (!r.apply) console.log('dry run: nothing was written. Add --apply to delete.');
    process.exitCode = r.refused ? 1 : 0;
  } catch (err) {
    console.error(JSON.stringify({ error: err.code ?? 'error', message: err.message }));
    process.exitCode = 1;
  } finally { db.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
