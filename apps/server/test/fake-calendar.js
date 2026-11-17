// Shared by the calendar step 11 tests: a fake Google Calendar REST API under the real Calendar client.
import { Calendar } from '../src/calendar.js';

/** Fake Calendar REST API (events per calendar, 409 on duplicate id, If-Match, etag per write). */
// meetReadyAfter: GETs of an event before its Meet turns from pending to ready (Infinity = never).
// failInserts: number of event inserts that fail with 500 before inserts work.
export function fakeGoogle({ busy = {}, unreadable = [], meetReadyAfter = 0, failInserts = 0 } = {}) {
  const gets = new Map(); let insertFailures = failInserts;
  const cals = new Map(); const calls = []; let n = 0;
  const cal = (id) => { if (!cals.has(id)) cals.set(id, new Map()); return cals.get(id); };
  const res = (status, json) => ({ ok: status < 400, status, json: async () => json });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/freeBusy')) {
      const body = JSON.parse(init.body);
      calls.push({ method: init.method, freeBusy: true, body });
      const calendars = Object.fromEntries(body.items.map(({ id }) => [id, unreadable.includes(id) ? { errors: [{ reason: 'notFound' }] } : { busy: busy[id] ?? [] }]));
      return res(200, { calendars });
    }
    const [calId, sub, evId] = u.pathname.replace('/calendar/v3/calendars/', '').split('/').map(decodeURIComponent);
    const q = Object.fromEntries(u.searchParams);
    const ifMatch = init.headers['if-match'] ?? null;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, calId, evId, q, ifMatch, body, as: init.as });
    if (!sub && init.method === 'DELETE') { cals.delete(calId); return res(204, {}); }
    const events = cal(calId);
    if (init.method === 'GET' && !evId) return res(200, { items: [...events.values()] });
    if (init.method === 'POST') {
      if (insertFailures > 0) { insertFailures -= 1; return res(500, { error: { message: 'backend error' } }); }
      if (events.has(body.id)) return res(409, { error: { message: 'exists' } });
      const ev = { ...body, status: 'confirmed', etag: `"e${++n}"` };
      if (q.conferenceDataVersion === '1' && body.conferenceData?.createRequest) {
        ev.conferenceData = { createRequest: { ...body.conferenceData.createRequest, status: { statusCode: meetReadyAfter === 0 ? 'success' : 'pending' } } };
        if (meetReadyAfter === 0) ev.hangoutLink = `https://meet.google.com/${body.id.slice(0, 3)}-abcd-efg`;
      }
      events.set(body.id, ev);
      return res(200, ev);
    }
    const ev = events.get(evId);
    if (!ev) return res(404, { error: { message: 'Not Found' } });
    if (init.method === 'GET') {
      const k = gets.get(evId) ?? 0; gets.set(evId, k + 1);
      if (ev.conferenceData?.createRequest?.status?.statusCode === 'pending' && k + 1 >= meetReadyAfter) {
        ev.conferenceData.createRequest.status.statusCode = 'success'; ev.hangoutLink = `https://meet.google.com/${evId.slice(0, 3)}-abcd-efg`;
      }
      return res(200, ev);
    }
    if (ifMatch && ifMatch !== ev.etag) return res(412, { error: { message: 'Precondition Failed' } });
    if (init.method === 'PATCH') { Object.assign(ev, body, { etag: `"e${++n}"` }); return res(200, ev); }
    if (init.method === 'DELETE') { events.delete(evId); return res(204, {}); }
    return res(400, {});
  };
  const asked = [];
  const clientFor = (mb) => { asked.push(mb.address); return new Calendar({ accessToken: async () => 'AT', fetchImpl }); };
  return { clientFor, calls, cal, asked, writes: () => calls.filter((c) => c.method !== 'GET' && !c.freeBusy), handEdit: (calId, evId) => { const e = cal(calId).get(evId); e.summary = 'moved by hand'; e.etag = `"hand${++n}"`; return e; } };
}
