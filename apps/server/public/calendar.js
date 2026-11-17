// public/calendar.js — the Calendar tab (plan step 17) and the thread scheduling card (step 16).
// Hand-built with Preact + htm, no build step. Patterns from Google Calendar / Outlook (D22): month
// view by default (D19), week one click away, today + prev/next, colour per person, person/team switch
// (D2), 仮 holds hatched, others' private events as plain busy (D16, D34), event popover with time,
// attendees and a join button; the inbox-only parts are the 調整中 panel and the AI suggestions.
// 締切 (D54-D58): all-day deadline items in their own colour (not a person's, not the hold hatch), a 締切
// section in the panel, a 完了 button in the popover, and the 「プレビュー締切を設定」 card on the thread.
import { html, useState, useEffect, useLayoutEffect, useRef, useCallback } from '/vendor/htm-preact.js';
import { Select, Star } from '/ui.js';
import { zoned, fromZoned } from '/time.js';

const pad2 = (n) => String(n).padStart(2, '0');
const DAY = 86400_000;
const local = (a) => String(a ?? '').split('@')[0];
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/** Who may see the tab: the server decides (calendarVisibleFor: on, or shadow for owners; D45). */
export const calendarVisible = (me) => me?.calendar?.visible ?? (me?.calendar?.mode === 'on' || (me?.calendar?.mode === 'shadow' && me?.user?.role === 'owner'));

/** The calendar write routes (steps 11-15). Each call is one POST; errors surface as toasts. */
export const calApi = (api) => ({
  hold: (id) => api(`/api/suggestions/${encodeURIComponent(id)}/hold`, { method: 'POST', body: {} }),
  dismiss: (id) => api(`/api/suggestions/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} }),
  confirm: (body) => api('/api/meetings/confirm', { method: 'POST', body }),
  undo: (id) => api(`/api/meetings/${encodeURIComponent(id)}/undo`, { method: 'POST', body: {} }),
  applyChange: (id) => api(`/api/meetings/${encodeURIComponent(id)}/apply-change`, { method: 'POST', body: {} }),
  invite: (id, want) => api(`/api/meetings/${encodeURIComponent(id)}/invite`, { method: 'POST', body: { want } }),
  deadline: (id, action) => api(`/api/deadlines/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} }),
  slots: (threadId, attendeeMailboxIds) => api(`/api/threads/${encodeURIComponent(threadId)}/draft-slots`, { method: 'POST', body: { attendeeMailboxIds } }),
});

// Wall-clock helpers in the business timezone. A "day" is {y, m, d} with m 0-based.
const wall = (iso, tz) => zoned(iso, tz);
const dayKey = (y, m, d) => { const x = new Date(Date.UTC(y, m, d)); return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`; };
const keyOf = (iso, tz) => { const w = wall(iso, tz); return dayKey(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()); };
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m: m - 1, d }; };
const addDays = (k, n) => { const { y, m, d } = parseKey(k); return dayKey(y, m, d + n); };
const dow = (k) => { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m, d)).getUTCDay(); };
const startOf = (k, tz) => { const { y, m, d } = parseKey(k); return fromZoned(y, m, d, 0, 0, tz); };
const hm = (iso, tz) => { const w = wall(iso, tz); return `${w.getUTCHours()}:${pad2(w.getUTCMinutes())}`; };
const WD = { ja: '日月火水木金土', en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const wd = (k, lang) => (lang === 'ja' ? WD.ja[dow(k)] : WD.en[dow(k)]);

/** "11月12日(木) 14:00–15:00" in tz. */
export function fmtRange(start, end, tz, lang, { allDay } = {}) {
  const w = wall(start, tz); const k = keyOf(start, tz);
  const date = lang === 'ja' ? `${w.getUTCMonth() + 1}月${w.getUTCDate()}日(${wd(k, lang)})` : `${wd(k, lang)} ${w.getUTCDate()} ${MON[w.getUTCMonth()]}`;
  if (allDay) return date;
  return `${date} ${hm(start, tz)}–${end ? hm(end, tz) : ''}`;
}
const tzShort = (tz, lang) => ({ 'Asia/Tokyo': lang === 'ja' ? '日本時間' : 'JST' }[tz] ?? tz.split('/').pop().replace(/_/g, ' '));

// Colour per person: a hue per mailbox, stable across reloads (same hash idea as the console avatars).
const HUES = [221, 152, 28, 340, 262, 190, 45, 300];
const hueOf = (id, people) => { const i = people.findIndex((p) => p.mailboxId === id); return HUES[(i < 0 ? 0 : i) % HUES.length]; };

const linkKind = (u) => (/zoom\.us/.test(u ?? '') ? 'Zoom' : /meet\.google\.com/.test(u ?? '') ? 'Meet' : /teams\.microsoft|teams\.live/.test(u ?? '') ? 'Teams' : null);
const threadHref = (x) => (x.threadId ? `/#t=${x.threadId}` : x.gmailUrl ?? null);

const I = {
  left: html`<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>`,
  right: html`<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`,
  plus: html`<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  video: html`<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>`,
  pin: html`<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0119 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  people: html`<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14a6.5 6.5 0 013.5 6"/></svg>`,
  mail: html`<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  lock: html`<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>`,
  x: html`<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  check: html`<svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>`,
  panel: html`<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>`,
  flag: html`<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`,
};

// Lay timed events of one day into side-by-side lanes when they overlap (Google's week view).
function lanes(evs) {
  const sorted = [...evs].sort((a, b) => new Date(a.start) - new Date(b.start) || new Date(b.end) - new Date(a.end));
  const out = []; let cluster = []; let clusterEnd = 0;
  const flush = () => { const n = Math.max(...cluster.map((c) => c.lane)) + 1; for (const c of cluster) out.push({ ...c, lanes: n }); cluster = []; };
  for (const e of sorted) {
    const s = new Date(e.start).getTime(); const en = new Date(e.end).getTime();
    if (cluster.length && s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => new Date(c.e.end).getTime() > s).map((c) => c.lane));
    let lane = 0; while (used.has(lane)) lane += 1;
    cluster.push({ e, lane }); clusterEnd = Math.max(clusterEnd, en);
  }
  if (cluster.length) flush();
  return out;
}

/** Chip text for one event, per kind. Busy shows no title at all (D16). */
const label = (e, c) => (e.kind === 'busy' ? c.busy : e.kind === 'hold' ? `${c.holdMark} ${String(e.title ?? '').replace(/^仮[:：]\s*/, '')}`
  : e.kind === 'deadline' ? `${c.deadlineMark}: ${c.deadlineType[e.deadlineType] ?? ''} ${e.title ?? ''}`.trim() : e.title);

function EventChip({ e, tz, people, c, onOpen, compact }) {
  return html`<button type="button" class=${`cev k-${e.kind} ${compact ? 'compact' : ''}`} style=${{ '--h': hueOf(e.mailboxId, people) }}
    onClick=${(ev) => { ev.stopPropagation(); onOpen(e, ev.currentTarget); }}>
    ${e.kind === 'suggested' ? html`<${Star} />` : e.kind === 'busy' ? I.lock : e.kind === 'deadline' ? I.flag : html`<i class="cdot"></i>`}
    ${e.allDay ? '' : html`<span class="ct">${hm(e.start, tz)}</span>`}<span class="cl">${label(e, c)}</span></button>`;
}

// ── popover: one event, anchored like Google's (bottom sheet on a phone) ──
function Popover({ e, anchor, tz, lang, people, c, onClose, onAct }) {
  const root = useRef(null); const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (matchMedia('(max-width: 760px)').matches) { setPos({ sheet: true }); return; }
    const r = anchor.getBoundingClientRect(); const w = 340; const h = root.current.offsetHeight;
    let left = r.right + 8; if (left + w > innerWidth - 12) left = Math.max(12, r.left - w - 8);
    const top = Math.min(Math.max(12, r.top - 8), innerHeight - h - 12);
    setPos({ left, top });
  }, [e, anchor]);
  useEffect(() => {
    const away = (ev) => { if (!root.current?.contains(ev.target)) onClose(); };
    const key = (ev) => { if (ev.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const person = people.find((p) => p.mailboxId === e.mailboxId);
  const kind = linkKind(e.meetUrl); const href = threadHref(e);
  return html`<div class=${`cpop ${pos?.sheet ? 'sheet' : ''}`} ref=${root} role="dialog" aria-label=${label(e, c)}
      style=${pos && !pos.sheet ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: pos ? 'visible' : 'hidden' }}>
    <div class="cpop-h"><span class=${`csw k-${e.kind}`} style=${{ '--h': hueOf(e.mailboxId, people) }}></span>
      <div class="cpop-t"><b>${label(e, c)}</b>
        <span>${fmtRange(e.start, e.end, tz, lang, { allDay: e.allDay })}</span></div>
      <button class="tool" aria-label=${c.close} onClick=${onClose}>${I.x}</button></div>
    ${e.kind === 'hold' ? html`<div class="cpop-note hold">${c.holdNote}</div>` : ''}
    ${e.kind === 'suggested' ? html`<div class="cpop-note ai"><${Star} />${c.suggestedNote}</div>` : ''}
    ${e.kind === 'busy' ? html`<div class="cpop-note">${c.busyNote(person ? local(person.address) : '')}</div>` : ''}
    ${e.kind === 'deadline' ? html`<div class=${`cpop-note dl ${e.overdue ? 'over' : ''}`}>${e.overdue ? c.deadlineOverdue : c.deadlineNote}</div>` : ''}
    <div class="cpop-rows">
      ${person ? html`<div class="cpop-r"><i class="cdot" style=${{ '--h': hueOf(e.mailboxId, people) }}></i><span>${person.name || local(person.address)} · ${c.calOf}</span></div>` : ''}
      ${e.location ? html`<div class="cpop-r">${I.pin}<span>${e.location}</span></div>` : ''}
      ${e.attendees?.length ? html`<div class="cpop-r top">${I.people}<span class="catt">${e.attendees.map((a) => html`<span key=${a.email ?? a.name}><b>${a.name ?? a.email}</b>${a.name && a.email ? html` ${a.email}` : ''}${a.response === 'accepted' ? html` <em class="ok">${c.accepted}</em>` : a.response === 'needsAction' ? html` <em>${c.noReply}</em>` : ''}</span>`)}</span></div>` : ''}
    </div>
    ${(e.meetUrl || href || e.kind === 'suggested' || e.meetingId || e.deadlineId) ? html`<div class="cpop-acts">
      ${e.meetUrl ? html`<a class="btn primary" href=${e.meetUrl} target="_blank" rel="noopener noreferrer">${I.video}${c.join(kind ?? '')}</a>` : ''}
      ${href ? html`<a class="btn" href=${href} target=${e.threadId ? undefined : '_blank'} rel="noopener" onClick=${() => e.threadId && onClose()}>${I.mail}${e.threadId ? c.openThread : c.openGmail}</a>` : ''}
      ${e.kind === 'suggested' ? html`<span class="sp"></span><button class="btn" onClick=${() => onAct(e, 'dismiss')}>${c.dismiss}</button>
        <button class="btn primary" onClick=${() => onAct(e, 'hold')}>${c.hold}</button>` : ''}
      ${e.meetingId ? html`<span class="sp"></span><button class="btn" onClick=${() => onAct(e, 'undo')}>${c.undo}</button>` : ''}
      ${e.deadlineId ? html`<span class="sp"></span><button class="btn primary" onClick=${() => onAct(e, 'done')}>${I.check}${c.deadlineDone}</button>` : ''}
    </div>` : ''}
  </div>`;
}

// ── month view ──
function Month({ anchorKey, todayKey, tz, lang, byDay, people, c, onOpen, onDay }) {
  const { y, m } = parseKey(anchorKey);
  const first = dayKey(y, m, 1); const start = addDays(first, -dow(first));
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
  const rows = parseKey(weeks[5][0]).m !== m ?weeks.slice(0, 5) : weeks;
  const MAX = 4;
  return html`<div class="cmonth" style=${{ '--rows': rows.length }}>
    <div class="cm-head">${Array.from({ length: 7 }, (_, d) => html`<span class=${`d${d}`}>${lang === 'ja' ? WD.ja[d] : WD.en[d]}</span>`)}</div>
    <div class="cm-grid">${rows.flat().map((k) => {
      const evs = byDay.get(k) ?? []; const out = parseKey(k).m !== m;
      return html`<div key=${k} class=${`cm-cell ${out ? 'out' : ''} ${k === todayKey ? 'today' : ''} d${dow(k)}`} onClick=${(ev) => onDay(k, null, ev.currentTarget)}>
        <span class="cm-n">${parseKey(k).d === 1 && out ? `${parseKey(k).m + 1}/` : ''}${parseKey(k).d}</span>
        <div class="cm-evs">${evs.slice(0, evs.length > MAX ? MAX - 1 : MAX).map((e) => html`<${EventChip} key=${e.id} e=${e} tz=${tz} people=${people} c=${c} onOpen=${onOpen} compact />`)}
          ${evs.length > MAX ? html`<button type="button" class="cm-more" onClick=${(ev) => { ev.stopPropagation(); onDay(k, ev.currentTarget); }}>${c.more(evs.length - MAX + 1)}</button>` : ''}</div>
        <span class="cm-dots" aria-hidden="true">${evs.slice(0, 4).map((e) => html`<i class=${`k-${e.kind}`} style=${{ '--h': hueOf(e.mailboxId, people) }}></i>`)}</span>
      </div>`; })}</div>
  </div>`;
}

// ── week view: all-day row on top, hours below, now line on today ──
const H0 = 0; const H1 = 24; const ROW = 44;
function Week({ anchorKey, todayKey, tz, lang, byDay, people, c, onOpen, onDay }) {
  const start = addDays(anchorKey, -dow(anchorKey));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scroller = useRef(null);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = (8 - H0) * ROW; }, [start]);
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(h); }, []);
  const now = wall(new Date(), tz); const nowTop = (now.getUTCHours() + now.getUTCMinutes() / 60 - H0) * ROW;
  return html`<div class="cweek">
    <div class="cw-head"><span class="cw-gut">${tzShort(tz, lang)}</span>${days.map((k) => html`<button type="button" key=${k} class=${`cw-day ${k === todayKey ? 'today' : ''} d${dow(k)}`} onClick=${() => onDay(k)}>
      <span>${wd(k, lang)}</span><b>${parseKey(k).d}</b></button>`)}</div>
    <div class="cw-all"><span class="cw-gut">${c.allDay}</span>${days.map((k) => html`<div key=${k} class="cw-allc">
      ${(byDay.get(k) ?? []).filter((e) => e.allDay).map((e) => html`<${EventChip} key=${e.id} e=${e} tz=${tz} people=${people} c=${c} onOpen=${onOpen} compact />`)}</div>`)}</div>
    <div class="cw-scroll" ref=${scroller}><div class="cw-body" style=${{ height: `${(H1 - H0) * ROW}px` }}>
      <div class="cw-hours">${Array.from({ length: H1 - H0 }, (_, i) => html`<span style=${{ top: `${i * ROW}px` }}>${i ? `${H0 + i}:00` : ''}</span>`)}</div>
      ${days.map((k) => {
        const s0 = startOf(k, tz).getTime();
        return html`<div key=${k} class=${`cw-col ${k === todayKey ? 'today' : ''}`}>
          ${lanes((byDay.get(k) ?? []).filter((e) => !e.allDay)).map(({ e, lane, lanes: n }) => {
            const top = Math.max(0, (new Date(e.start) - s0) / 3600_000 - H0) * ROW;
            const h = Math.max(22, ((new Date(e.end) - new Date(e.start)) / 3600_000) * ROW - 2);
            return html`<button type="button" key=${e.id} class=${`cw-ev k-${e.kind} ${h < 40 ? 'short' : ''}`} style=${{ '--h': hueOf(e.mailboxId, people), top: `${top}px`, height: `${h}px`, left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` }}
              onClick=${(ev) => onOpen(e, ev.currentTarget)}>
              <span class="cl">${e.kind === 'suggested' ? html`<${Star} />` : e.kind === 'busy' ? I.lock : ''}${label(e, c)}</span>
              <span class="ct">${hm(e.start, tz)}–${hm(e.end, tz)}${e.meetUrl ? html` · ${linkKind(e.meetUrl)}` : e.location ? html` · ${e.location}` : ''}</span></button>`;
          })}
          ${k === todayKey ? html`<i class="cw-now" style=${{ top: `${nowTop}px` }}></i>` : ''}
        </div>`; })}
    </div></div>
  </div>`;
}

// ── 調整中 panel: every negotiation with its offered dates and their state ──
function Negotiations({ list, deadlines = [], tz, lang, people, c, onAct, onClose }) {
  return html`<aside class="cneg" aria-label=${c.negTitle}>
    <div class="cneg-h"><h2>${c.negTitle}</h2><span class="cneg-n">${list.length}</span><span class="sp"></span>
      ${onClose ? html`<button class="tool" aria-label=${c.close} onClick=${onClose}>${I.x}</button>` : ''}</div>
    ${deadlines.length ? html`<section class="cdl" aria-label=${c.deadlineTitle}>
      <h3 class="cdl-h">${I.flag}${c.deadlineTitle}<span class="cneg-n">${deadlines.length}</span></h3>
      ${deadlines.map((d) => { const href = threadHref(d); return html`<article key=${d.id} class=${`cdl-i ${d.overdue ? 'over' : ''}`}>
        <div class="cdl-t"><b>${d.client || (c.deadlineType[d.type] ?? d.type)}</b><span>${c.deadlineType[d.type] ?? d.type} · ${fmtRange(d.start, d.end, tz, lang, { allDay: true })}${d.overdue ? ` · ${c.deadlineLate}` : ''}</span></div>
        <div class="cdl-a">${href ? html`<a class="btn small" href=${href} target=${d.threadId ? undefined : '_blank'} rel="noopener">${d.threadId ? c.openThread : c.openGmail}</a>` : ''}
        <button class="btn small primary" onClick=${() => onAct({ deadlineId: d.id }, 'done')}>${c.deadlineDone}</button></div></article>`; })}
    </section>` : ''}
    <div class="cneg-list">${list.length === 0 ? html`<div class="cneg-empty">${c.negEmpty}</div>` : list.map((n) => {
      const href = threadHref(n);
      return html`<article key=${n.id} class=${`cn ${n.state === 'suggested' ? 'ai' : ''}`} style=${{ '--h': hueOf(n.mailboxId, people) }}>
        <div class="cn-h"><i class="cdot"></i><b class="cn-who">${n.counterpart}</b><span class=${`chip st-${n.state}`}>${n.state === 'suggested' ? html`<${Star} />` : ''}${c.negState[n.state] ?? n.state}</span></div>
        <div class="cn-subj">${n.subject}</div>
        <ol class="cn-offers">${n.offers.map((o) => html`<li key=${o.start} class=${`o-${o.state}`}>
          <span class="cn-when">${fmtRange(o.start, o.end, tz, lang)}</span><span class=${`cn-os os-${o.state}`}>${c.offerState[o.state] ?? o.state}</span></li>`)}</ol>
        <div class="cn-f"><span class="cn-mb">${local(people.find((p) => p.mailboxId === n.mailboxId)?.address)}@ · ${n.direction === 'ours' ? c.byUs : c.byThem}</span><span class="sp"></span>
          ${n.state === 'suggested' ? html`<button class="btn small" onClick=${() => onAct(n, 'dismiss')}>${c.dismiss}</button><button class="btn small primary" onClick=${() => onAct(n, 'hold')}>${c.hold}</button>` : ''}
          ${href ? html`<a class="btn small" href=${href} target=${n.threadId ? undefined : '_blank'} rel="noopener">${n.threadId ? c.openThread : c.openGmail}</a>` : ''}</div>
      </article>`; })}</div>
  </aside>`;
}

/** The tab. Reads GET /api/calendar?from&to&view=person:<mailboxId>|team. */
export function Calendar({ api, me, lang, t, toast }) {
  const c = t.cal; const tz = me.calendar?.timezone || 'Asia/Tokyo';
  const todayKey = keyOf(new Date(), tz);
  const [mode, setMode] = useState(store.get('tbi.cal.mode', 'month'));
  const [anchor, setAnchor] = useState(todayKey);
  const [who, setWho] = useState(store.get('tbi.cal.who', ''));
  const [data, setData] = useState(null);
  const [pop, setPop] = useState(null);
  const [dayPop, setDayPop] = useState(null);
  const [panel, setPanel] = useState(() => !matchMedia('(max-width: 1100px)').matches);

  const range = (() => {
    if (mode === 'week') { const s = addDays(anchor, -dow(anchor)); return [s, addDays(s, 7)]; }
    const { y, m } = parseKey(anchor); const first = dayKey(y, m, 1); const s = addDays(first, -dow(first)); return [s, addDays(s, 42)];
  })();
  const load = useCallback(async () => {
    const qs = new URLSearchParams({ from: startOf(range[0], tz).toISOString(), to: startOf(range[1], tz).toISOString(), ...(who ? { view: who } : {}) });
    try { setData(await api(`/api/calendar?${qs}`)); } catch (e) { toast(e.message); setData((d) => d ?? { events: [], negotiations: [], people: [] }); }
  }, [range[0], range[1], who]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = setInterval(load, 60_000); return () => clearInterval(h); }, [load]);
  // The server answers with the view it used (D39: own mailbox by default, team when there is none).
  useEffect(() => { if (!who && data?.view) setWho(data.view); }, [data?.view]);
  useEffect(() => {
    const key = (e) => {
      if (e.target.closest?.('input,textarea,[contenteditable]') || e.ctrlKey || e.metaKey) return;
      if (e.key === 't') setAnchor(todayKey); else if (e.key === 'm') setView('month'); else if (e.key === 'w') setView('week');
      else if (e.key === 'ArrowLeft' || e.key === 'j') step(-1); else if (e.key === 'ArrowRight' || e.key === 'k') step(1);
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  });

  const setView = (v) => { setMode(v); store.set('tbi.cal.mode', v); };
  const pickWho = (v) => { setWho(v); store.set('tbi.cal.who', v); };
  const step = (n) => setAnchor((a) => { if (mode === 'week') return addDays(a, 7 * n); const { y, m } = parseKey(a); return dayKey(y, m + n, 1); });
  const people = data?.people ?? [];
  const byDay = new Map();
  for (const e of data?.events ?? []) {
    // Multi-day and all-day events sit on every day they cover.
    let k = keyOf(e.start, tz); const last = keyOf(new Date(new Date(e.end).getTime() - 1).toISOString(), tz);
    for (let i = 0; i < 62 && k <= last; i += 1, k = addDays(k, 1)) { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  }
  for (const evs of byDay.values()) evs.sort((a, b) => (b.allDay - a.allDay) || new Date(a.start) - new Date(b.start));

  const title = (() => {
    const { y, m } = parseKey(anchor);
    if (mode === 'month') return lang === 'ja' ? `${y}年${m + 1}月` : `${MON[m]} ${y}`;
    const s = parseKey(range[0]); const e = parseKey(addDays(range[1], -1));
    if (lang === 'ja') return s.m === e.m ? `${s.y}年${s.m + 1}月${s.d}日〜${e.d}日` : `${s.y}年${s.m + 1}月${s.d}日〜${e.m + 1}月${e.d}日`;
    return s.m === e.m ? `${s.d}–${e.d} ${MON[s.m]} ${s.y}` : `${s.d} ${MON[s.m]} – ${e.d} ${MON[e.m]} ${e.y}`;
  })();
  const cal = calApi(api);
  const act = async (x, action) => {
    // A negotiation holds or dismisses every open date it lists; an event acts on its own suggestion.
    const ids = x.suggestionIds?.length ? x.suggestionIds : [x.suggestionId].filter(Boolean);
    try {
      if (action === 'undo') { if (!confirm(c.undoAsk)) return; await cal.undo(x.meetingId); toast(c.undoneToast); }
      else if (action === 'done') { await cal.deadline(x.deadlineId, 'done'); toast(c.deadlineDoneToast); }
      else { for (const id of ids) await cal[action](id); toast(action === 'hold' ? c.heldToast : c.dismissedToast); }
      setPop(null); load();
    } catch (e) { toast(e.message); }
  };
  const [adding, setAdding] = useState(false);
  const sync = data?.sync;
  const whoOpts = [{ value: 'team', label: c.team }, ...people.map((p) => ({ value: `person:${p.mailboxId}`, label: `${p.name || local(p.address)}${p.own ? ` (${c.me})` : ''}` }))];
  const neg = data?.negotiations ?? [];
  const dls = data?.deadlines ?? [];

  return html`<section class=${`cal ${panel ? 'with-panel' : ''}`} aria-label=${c.title}>
    <header class="cal-h">
      <h1>${c.title}</h1>
      <button class="btn" title="T" onClick=${() => setAnchor(todayKey)}>${c.today}</button>
      <div class="cal-step"><button class="btn icon" aria-label=${c.prev} onClick=${() => step(-1)}>${I.left}</button><button class="btn icon" aria-label=${c.next} onClick=${() => step(1)}>${I.right}</button></div>
      <h2 class="cal-title">${title}</h2>
      <span class="sp"></span>
      ${sync ? html`<span class=${`cal-sync ${sync.ok ? 'ok' : 'bad'}`} title=${sync.error ?? ''}><i></i>${sync.ok ? c.synced(hm(sync.lastAt, tz)) : c.syncBad}</span>` : ''}
      <${Select} className="cal-who" value=${who || 'team'} onChange=${pickWho} label=${c.whose} options=${whoOpts} />
      <div class="cal-seg" role="tablist">${['month', 'week'].map((v) => html`<button role="tab" aria-selected=${mode === v} class=${mode === v ? 'on' : ''} title=${v === 'month' ? 'M' : 'W'} onClick=${() => setView(v)}>${c.views[v]}</button>`)}</div>
      <button class="btn primary cal-add" onClick=${() => setAdding(true)}>${I.plus}<span>${c.add}</span></button>
      <button class=${`btn icon cal-pt ${panel ? 'on' : ''}`} aria-label=${c.negTitle} aria-pressed=${panel} onClick=${() => setPanel(!panel)}>${I.panel}${neg.length + dls.length ? html`<span class="n">${neg.length + dls.length}</span>` : ''}</button>
    </header>
    <div class="cal-legend">${people.map((p) => html`<span key=${p.mailboxId} class="lg" style=${{ '--h': hueOf(p.mailboxId, people) }}><i class="cdot"></i>${p.name || local(p.address)}</span>`)}
      <span class="lg kind"><i class="lk k-hold"></i>${c.legend.hold}</span><span class="lg kind"><i class="lk k-suggested"></i>${c.legend.suggested}</span><span class="lg kind"><i class="lk k-busy"></i>${c.legend.busy}</span><span class="lg kind"><i class="lk k-deadline"></i>${c.legend.deadline}</span></div>
    <div class="cal-body">
      <div class="cal-grid">${data === null ? html`<div class="cal-load"><i class="spin"></i></div>`
        : mode === 'month' ? html`<${Month} anchorKey=${anchor} todayKey=${todayKey} tz=${tz} lang=${lang} byDay=${byDay} people=${people} c=${c}
            onOpen=${(e, el) => { setDayPop(null); setPop({ e, el }); }} onDay=${(k, el, cell) => (el || (cell && matchMedia('(max-width: 760px)').matches) ? setDayPop({ k, el: el ?? cell }) : (setAnchor(k), setView('week')))} />`
        : html`<${Week} anchorKey=${anchor} todayKey=${todayKey} tz=${tz} lang=${lang} byDay=${byDay} people=${people} c=${c}
            onOpen=${(e, el) => setPop({ e, el })} onDay=${(k) => setAnchor(k)} />`}</div>
      ${panel ? html`<${Negotiations} list=${neg} deadlines=${dls} tz=${tz} lang=${lang} people=${people} c=${c} onAct=${act} onClose=${() => setPanel(false)} />` : ''}
    </div>
    ${dayPop ? html`<${DayList} k=${dayPop.k} anchor=${dayPop.el} evs=${byDay.get(dayPop.k) ?? []} tz=${tz} lang=${lang} people=${people} c=${c}
      onClose=${() => setDayPop(null)} onOpen=${(e, el) => setPop({ e, el })} />` : ''}
    ${pop ? html`<${Popover} e=${pop.e} anchor=${pop.el} tz=${tz} lang=${lang} people=${people} c=${c} onClose=${() => setPop(null)} onAct=${act} />` : ''}
    ${adding ? html`<${AddEvent} people=${people.filter((p) => me.mailboxes?.find((m) => m.id === p.mailboxId)?.canSend !== false)} own=${people.find((p) => p.own)?.mailboxId}
      day=${anchor} tz=${tz} c=${c} onClose=${() => setAdding(false)} onSave=${async (body) => {
        try { await cal.confirm(body); toast(c.addedToast); setAdding(false); load(); } catch (e) { toast(e.message); }
      }} />` : ''}
  </section>`;
}

/** D5: add a confirmed meeting without a thread. It goes through the same confirm route (one write path). */
function AddEvent({ people, own, day, tz, c, onClose, onSave }) {
  const [who, setWho] = useState(own ?? people[0]?.mailboxId ?? '');
  const [date, setDate] = useState(day); const [time, setTime] = useState('10:00'); const [mins, setMins] = useState('30');
  const [title, setTitle] = useState(''); const [place, setPlace] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (ev) => {
    ev.preventDefault();
    const { y, m, d } = parseKey(date); const [h, mi] = time.split(':').map(Number);
    const start = fromZoned(y, m, d, h, mi, tz);
    setBusy(true);
    await onSave({ mailboxId: who, start: start.toISOString(), end: new Date(start.getTime() + Number(mins) * 60_000).toISOString(), title: title || undefined, place: place || undefined });
    setBusy(false);
  };
  return html`<div class="cadd-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="cadd" role="dialog" aria-label=${c.add} onSubmit=${save}>
      <div class="cday-h"><b>${c.add}</b><span class="sp"></span><button type="button" class="tool" aria-label=${c.close} onClick=${onClose}>${I.x}</button></div>
      <label>${c.addWho}<select value=${who} onChange=${(e) => setWho(e.target.value)}>${people.map((p) => html`<option value=${p.mailboxId}>${p.name || local(p.address)}</option>`)}</select></label>
      <div class="cadd-row"><label>${c.addDate}<input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} required /></label>
        <label>${c.addTime}<input type="time" value=${time} onInput=${(e) => setTime(e.target.value)} required /></label>
        <label>${c.addLen}<select value=${mins} onChange=${(e) => setMins(e.target.value)}>${['30', '60', '90', '120'].map((v) => html`<option value=${v}>${c.minutes(v)}</option>`)}</select></label></div>
      <label>${c.addTitle}<input value=${title} onInput=${(e) => setTitle(e.target.value)} /></label>
      <label>${c.addPlace}<input value=${place} onInput=${(e) => setPlace(e.target.value)} /></label>
      <div class="sd-acts"><span class="sp"></span><button type="button" class="btn" onClick=${onClose}>${c.close}</button>
        <button class="btn primary" disabled=${busy || !who}>${I.check}${c.confirm}</button></div>
    </form></div>`;
}

// "+N 件" opens the whole day as a small list (Google's day popover).
function DayList({ k, anchor, evs, tz, lang, people, c, onClose, onOpen }) {
  const root = useRef(null); const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const cell = anchor.closest('.cm-cell') ?? anchor; const r = cell.getBoundingClientRect();
    setPos({ left: Math.min(Math.max(8, r.left - 8), innerWidth - 268), top: Math.min(Math.max(8, r.top - 8), innerHeight - root.current.offsetHeight - 8) });
  }, [k]);
  useEffect(() => {
    const away = (ev) => { if (!root.current?.contains(ev.target) && !ev.target.closest?.('.cpop')) onClose(); };
    document.addEventListener('pointerdown', away, true); return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const { m, d } = parseKey(k);
  return html`<div class="cday" ref=${root} role="dialog" style=${pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
    <div class="cday-h"><span>${wd(k, lang)}</span><b>${lang === 'ja' ? `${m + 1}月${d}日` : `${d} ${MON[m]}`}</b><span class="sp"></span><button class="tool" aria-label=${c.close} onClick=${onClose}>${I.x}</button></div>
    ${evs.map((e) => html`<${EventChip} key=${e.id} e=${e} tz=${tz} people=${people} c=${c} onOpen=${onOpen} compact />`)}
  </div>`;
}

/**
 * Thread scheduling card (step 16): offered times in the stated and the business timezone, Hold (dates
 * offered to us, D23), Confirm (D15), Pick another (a reply offering free slots, step 12), Dismiss, the change
 * badge (D13), the meeting link and the invite tick (D41). s = /api/threads/:id → scheduling.
 * Buttons show only when this viewer may send from the thread's mailbox (D40).
 */
export function SchedCard({ s, api, lang, t, toast, canSend, onChanged, threadId, mailboxes = [], mailboxId }) {
  const c = t.cal; const tz = s.timezone || 'Asia/Tokyo'; const cal = calApi(api);
  const offers = s.offers ?? [];
  const [pick, setPick] = useState(() => Math.max(0, offers.findIndex((o) => o.state !== 'declined')));
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState('');
  const [slotsOpen, setSlotsOpen] = useState(false);
  const [ticks, setTicks] = useState([]);
  const run = async (key, fn, done) => {
    setBusy(key);
    try { await fn(); toast(done); onChanged?.(); } catch (e) { toast(e.message); }
    setBusy('');
  };
  const open = offers.filter((o) => o.state !== 'held' || s.direction === 'theirs');
  const other = s.statedTz && s.statedTz !== tz ? s.statedTz : null;
  if (s.meeting) {
    const m = s.meeting; const kind = linkKind(m.meetUrl);
    return html`<section class="schedc done" aria-label=${c.cardTitle}>
      <div class="sd-h"><span class="sd-ic ok">${I.check}</span><div class="sd-t"><b>${c.confirmedAs}</b><span>${fmtRange(m.start, m.end, tz, lang)} · ${tzShort(tz, lang)}</span></div></div>
      ${s.change ? html`<div class="sd-change"><span class="chip warn">${s.change.kind === 'cancel' ? c.cancelBadge : c.changeBadge}</span>
        <span>${s.change.kind === 'cancel' ? '' : fmtRange(s.change.start, s.change.end, tz, lang)}</span><span class="sp"></span>
        ${canSend ? html`<button class="btn small" disabled=${!!busy} onClick=${() => run('dismiss', () => cal.dismiss(s.change.suggestionId), c.dismissedToast)}>${c.dismiss}</button>
          <button class="btn small primary" disabled=${!!busy} onClick=${() => run('apply', () => cal.applyChange(m.id), c.cardDone.apply_change)}>${s.change.kind === 'cancel' ? c.applyCancel : c.applyChange}</button>` : ''}</div>` : ''}
      ${m.conference === 'pending' ? html`<div class="sd-link">${I.clock}<span>${c.meetPending}</span></div>` : ''}
      ${canSend && m.invite !== 'sent' ? html`<label class="sd-inv"><input type="checkbox" checked=${m.invite === 'queued'} disabled=${!!busy}
        onChange=${(e) => run('invite', () => cal.invite(m.id, e.target.checked), e.target.checked ? c.inviteQueued : c.inviteOff)} />${c.inviteTick}</label>` : ''}
      ${m.invite === 'sent' ? html`<div class="sd-link">${I.mail}<span>${c.inviteSent}</span></div>` : ''}
      <div class="sd-acts">${m.meetUrl ? html`<a class="btn primary" href=${m.meetUrl} target="_blank" rel="noopener noreferrer">${I.video}${c.join(kind ?? '')}</a>` : ''}
        ${m.location ? html`<span class="sd-loc">${I.pin}${m.location}</span>` : ''}
        ${canSend ? html`<span class="sp"></span><button class="btn" disabled=${!!busy} onClick=${() => confirm(c.undoAsk) && run('undo', () => cal.undo(m.id), c.undoneToast)}>${c.undo}</button>` : ''}</div>
    </section>`;
  }
  const chosen = offers[pick];
  const others = mailboxes.filter((x) => x.id !== mailboxId && x.status === 'connected');
  return html`<section class=${`schedc ${s.source === 'ai' ? 'ai' : ''}`} aria-label=${c.cardTitle}>
    <div class="sd-h"><span class="sd-ic">${s.source === 'ai' ? html`<${Star} />` : I.clock}</span>
      <div class="sd-t"><b>${s.direction === 'ours' ? c.cardOurs : c.cardTheirs}</b><span>${s.source === 'ai' ? c.cardAi : ''}${other ? `${s.source === 'ai' ? ' · ' : ''}${c.statedIn(tzShort(other, lang))}` : ''}</span></div></div>
    <div class="sd-offers" role="radiogroup">${offers.map((o, i) => html`<label key=${o.start} class=${`sd-o ${pick === i ? 'on' : ''} os-${o.state}`}>
      <input type="radio" name="sd-offer" checked=${pick === i} onChange=${() => setPick(i)} />
      <span class="sd-when"><b>${fmtRange(o.start, o.end, tz, lang)} (${tzShort(tz, lang)})</b>${other ? html`<span>${fmtRange(o.start, o.end, other, lang)} (${tzShort(other, lang)})</span>` : ''}</span>
      <span class=${`cn-os os-${o.state}`}>${c.offerState[o.state] ?? ''}</span></label>`)}</div>
    ${s.meetUrl ? html`<div class="sd-link">${I.video}<span>${c.linkFound(linkKind(s.meetUrl) ?? '')}</span></div>` : ''}
    ${canSend ? html`<label class="sd-inv"><input type="checkbox" checked=${invite} onChange=${(e) => setInvite(e.target.checked)} />${c.inviteTick}</label>
    <div class="sd-acts">
      <button class="btn primary" disabled=${!!busy || !chosen} onClick=${() => run('confirm', () => cal.confirm({ suggestionId: chosen.suggestionId, wantInvite: invite }), c.cardDone.confirm)}>${I.check}${c.confirm}</button>
      ${s.direction === 'theirs' && offers.some((o) => o.state === 'suggested') ? html`<button class="btn" disabled=${!!busy}
        onClick=${() => run('hold', async () => { for (const o of offers.filter((x) => x.state === 'suggested')) await cal.hold(o.suggestionId); }, c.heldToast)}>${c.hold}</button>` : ''}
      <button class=${`btn ${slotsOpen ? 'on' : ''}`} disabled=${!!busy} onClick=${() => setSlotsOpen(!slotsOpen)}>${c.pickAnother}</button>
      <span class="sp"></span><button class="btn" disabled=${!!busy}
        onClick=${() => run('dismiss', async () => { for (const o of open) await cal.dismiss(o.suggestionId); }, c.dismissedToast)}>${c.dismiss}</button></div>
    ${slotsOpen ? html`<div class="sd-slots">
      <span class="sd-slots-t">${c.slotsWho}</span>
      ${others.map((x) => html`<label key=${x.id} class="sd-inv"><input type="checkbox" checked=${ticks.includes(x.id)}
        onChange=${(e) => setTicks(e.target.checked ? [...ticks, x.id] : ticks.filter((y) => y !== x.id))} />${local(x.address)}</label>`)}
      <div class="sd-acts"><span class="sp"></span><button class="btn primary" disabled=${!!busy}
        onClick=${() => run('slots', () => cal.slots(threadId, ticks), c.slotsDone)}>${c.slotsGo}</button></div></div>` : ''}`
    : html`<div class="sd-ro">${c.noConfirm}</div>`}
  </section>`;
}

/**
 * The thread's 締切 card (D54): the AI read that the client wants a preview. One click sets the deadline
 * (the date in the mail, else 3 days after their reply, D55); once set it shows the date and 完了.
 * d = /api/threads/:id → deadline. Shown to whoever may see the thread (same rule as Hold).
 */
export function DeadlineCard({ d, api, lang, t, toast, onChanged, tz = 'Asia/Tokyo' }) {
  const c = t.cal; const cal = calApi(api);
  const [busy, setBusy] = useState(false);
  const run = async (action, done) => {
    setBusy(true);
    try { await cal.deadline(d.id, action); toast(done); onChanged?.(); } catch (e) { toast(e.message); }
    setBusy(false);
  };
  const when = fmtRange(d.start, d.end, tz, lang, { allDay: true });
  const type = c.deadlineType[d.type] ?? '';
  return html`<section class=${`dlc ${d.confirmed ? 'set' : 'ai'} ${d.overdue ? 'over' : ''}`} aria-label=${c.deadlineTitle}>
    <div class="sd-h"><span class="dlc-ic">${d.confirmed ? I.flag : html`<${Star} />`}</span>
      <div class="sd-t"><b>${d.confirmed ? c.deadlineSetAs(type, when) : c.deadlineAsk(when)}</b>
        <span>${d.confirmed ? (d.overdue ? c.deadlineLate : c.deadlineAuto) : `${c.deadlineFound} · ${d.source === 'mail_date' ? c.deadlineFromMail : c.deadlineRule}`}</span></div></div>
    ${!d.confirmed && d.quote ? html`<div class="dlc-q">「${d.quote}」</div>` : ''}
    <div class="sd-acts">${d.confirmed
      ? html`<span class="sp"></span><button class="btn primary" disabled=${busy} onClick=${() => run('done', c.deadlineDoneToast)}>${I.check}${c.deadlineDone}</button>`
      : html`<button class="btn primary" disabled=${busy} onClick=${() => run('confirm', c.deadlineSetToast)}>${I.flag}${c.deadlineSet}</button>
        <span class="sp"></span><button class="btn" disabled=${busy} onClick=${() => run('dismiss', c.dismissedToast)}>${c.dismiss}</button>`}</div>
  </section>`;
}
