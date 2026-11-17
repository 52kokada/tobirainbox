// TobirAInbox console — Preact + htm, no build step, nothing loaded from other sites.
// Layout: icon rail · list · conversation with the reply composer · contact panel.
import { html, render, useState, useEffect, useLayoutEffect, useRef, useCallback } from '/vendor/htm-preact.js';
import { STRINGS } from '/i18n.js';
import { Playbook, Settings, Setup } from '/settings.js';
import { Select, Star } from '/ui.js';
import { WORDMARK } from '/logo.js';
import { zoned, fromZoned, schedulePresets } from '/time.js';
import { Calendar, SchedCard, DeadlineCard, calendarVisible } from '/calendar.js';

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || data.error || res.statusText); e.status = res.status; e.code = data.error; throw e; }
  return data;
};

const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const BLANK_RE = /【要確認[：:][^】]*】|[〇○]{1,2}月[〇○0-9０-９]{1,2}日|[〇○0-9０-９]{1,2}月[〇○]{1,2}日|[〇○]{1,2}[:：][〇○0-9０-９]{2}|[〇○0-9０-９]{1,2}[:：][〇○]{2}/g;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nameOf = (from) => String(from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || String(from ?? '');
const addrOf = (from) => (String(from ?? '').match(/<([^>]+)>/)?.[1] ?? String(from ?? '')).trim();
const local = (a) => String(a ?? '').split('@')[0] + '@';
// Motion (prompt repo review-animations standards): strong ease-out for UI, the Motion Primitives
// spring for things that move on screen, nothing on keyboard navigation, all off with reduced motion.
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const SPRING = 'linear(0, 0.043 2.6%, 0.125 5.3%, 0.226 7.9%, 0.334 10.5%, 0.44 13.2%, 0.54 15.8%, 0.629 18.4%, 0.707 21.1%, 0.773 23.7%, 0.828 26.3%, 0.873 28.9%, 0.909 31.6%, 0.937 34.2%, 0.959 36.8%, 0.975 39.5%, 0.986 42.1%, 0.995 44.7%, 1 47.4%, 1.004 50%, 1.006 52.6%, 1.007 57.9%, 1.006 63.2%, 1.004 71.1%, 1.002 78.9%, 1.001 86.8%, 1)';
const move = (el, frames, opts) => { if (!REDUCE.matches && el.animate) el.animate(frames, opts); };
// A row leaving the list: delete flashes red and slides left, archive slides right; then the gap folds shut.
const unleave = (el) => { if (el) { el.getAnimations().forEach((a) => a.cancel()); el.style.overflow = ''; } };
const leave = async (el, trash) => {
  if (!el || REDUCE.matches || !el.animate) return;
  const h = el.offsetHeight; const css = getComputedStyle(document.documentElement);
  const from = getComputedStyle(el).backgroundColor; const red = css.getPropertyValue('--danger-soft').trim() || '#fdecec';
  el.style.overflow = 'hidden';
  await el.animate(trash
    ? [{ transform: 'none', opacity: 1, backgroundColor: from }, { backgroundColor: red, offset: 0.35 }, { transform: 'translateX(-56px)', opacity: 0, backgroundColor: red }]
    : [{ transform: 'none', opacity: 1 }, { transform: 'translateX(56px)', opacity: 0 }],
  { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).finished;
  await el.animate([{ height: `${h}px` }, { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px' }],
    { duration: 200, easing: EASE_OUT, fill: 'forwards' }).finished;
};

// Rolling digits (Motion Primitives "Sliding Number", TOBIRA edition).
const Mark = ({ big } = {}) => html`<svg class=${`logo ${big ? 'big' : ''}`} viewBox="0 0 100 100" role="img" aria-label="Tobira"><rect width="100" height="100" rx="22" class="m-bg"/><clipPath id="tbm"><circle cx="50" cy="50" r="38"/></clipPath><circle cx="50" cy="50" r="38" class="m-fg"/><path d="M49.2 100V27L70.8 17.6V0H74.1V100Z" class="m-bg" clip-path="url(#tbm)"/></svg>`;
function Num({ value }) {
  const r = useRef(null);
  useLayoutEffect(() => { window.TobiraSlidingNumber?.init(r.current.parentNode); }, []);
  return html`<span class="tb-sliding-number" ref=${r} data-value=${String(value ?? 0)}>${window.TobiraSlidingNumber ? '' : value}</span>`;
}

// Thread details are cached and neighbours prefetched, so moving between emails never shows a loading state.
const threadCache = new Map();
const getThread = async (id, { fresh = false } = {}) => {
  const c = threadCache.get(id);
  if (!fresh && c && Date.now() - c.at < 60_000) return c.data;
  const data = await api(`/api/threads/${id}`);
  threadCache.set(id, { data, at: Date.now() });
  return data;
};
const putThread = (id, data) => threadCache.set(id, { data, at: Date.now() });

// Initials without the company boilerplate (株式会社, Inc …); two letters for Latin names, one for Japanese.
const CORP = /株式会社|有限会社|合同会社|一般社団法人|（株）|\(株\)|㈱|\b(inc|llc|ltd|co|corp|k\.?k)\b\.?/gi;
function initials(from) {
  let n = nameOf(from).normalize('NFKC').replace(CORP, '').replace(/[<>"'()（）［］\[\]【】「」・]/g, ' ').trim();
  if (!n || n.includes('@')) n = (addrOf(from).split('@')[0] || '?').replace(/[._-]+/g, ' ');
  const words = n.split(/\s+/).filter(Boolean);
  if (/^[a-z]/i.test(words[0] ?? '')) return ((words[0][0] ?? '') + (words.length > 1 ? words.at(-1)[0] : '')).toUpperCase();
  return [...(words[0] ?? '?')][0];
}
const HUES = [[262, 248], [152, 172], [28, 12], [340, 320], [204, 224], [190, 160], [45, 25], [282, 300]];
function Avatar({ from, size }) {
  let h = 0; for (const c of addrOf(from)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return html`<span class=${`av ${size ?? ''}`} style=${{ '--h': HUES[h % HUES.length][0] }} aria-hidden="true">${initials(from)}</span>`;
}
function when(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const loc = lang === 'ja' ? 'ja-JP' : 'en-GB';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' });
}
// 予約送信 times are always Japan time (the customers are in Japan), whatever this computer's clock says.
const TZ = 'Asia/Tokyo';
const jst = (d) => zoned(d, TZ); // read with getUTC*
const fromJst = (y, mo, d, h, mi) => fromZoned(y, mo, d, h, mi, TZ);
const pad2 = (n) => String(n).padStart(2, '0');
function fmtWhen(iso, lang) {
  const t = jst(iso); const hm = `${t.getUTCHours()}:${pad2(t.getUTCMinutes())}`;
  if (lang === 'ja') return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日(${'日月火水木金土'[t.getUTCDay()]}) ${hm}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]} ${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]}, ${hm}`;
}
const fmtShort = (iso) => { const t = jst(iso); return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${t.getUTCHours()}:${pad2(t.getUTCMinutes())}`; };
function untilText(iso, t) {
  const mins = Math.max(1, Math.round((new Date(iso) - Date.now()) / 60000));
  if (mins < 60) return t.inMin(mins);
  const h = Math.round(mins / 60);
  return h < 48 ? t.inHours(h) : t.inDays(Math.round(h / 24));
}
const Icon = {
  clock: html`<svg class="clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path class="hh" d="M12 12V7.5"/><path class="mh" d="M12 12l3.6 2.1"/></svg>`,
  inbox: html`<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/></svg>`,
  sent: html`<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-3-7z"/></svg>`,
  lang: html`<svg viewBox="0 0 24 24"><path d="M4 5h9M8.5 3v2M6 5c.6 3.5 3 6.5 6.5 8M11 5c-.7 3.8-3.4 7.2-7 9"/><path d="M13 21l4.5-10L22 21M14.6 17.5h5.8"/></svg>`,
  history: html`<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>`,
  gear: html`<svg viewBox="0 0 24 24"><path d="M10.3 3.3a1.8 1.8 0 013.4 0l.3.9a1.8 1.8 0 002.3 1l.9-.4a1.8 1.8 0 012.4 2.4l-.4.9a1.8 1.8 0 001 2.3l.9.3a1.8 1.8 0 010 3.4l-.9.3a1.8 1.8 0 00-1 2.3l.4.9a1.8 1.8 0 01-2.4 2.4l-.9-.4a1.8 1.8 0 00-2.3 1l-.3.9a1.8 1.8 0 01-3.4 0l-.3-.9a1.8 1.8 0 00-2.3-1l-.9.4a1.8 1.8 0 01-2.4-2.4l.4-.9a1.8 1.8 0 00-1-2.3l-.9-.3a1.8 1.8 0 010-3.4l.9-.3a1.8 1.8 0 001-2.3l-.4-.9a1.8 1.8 0 012.4-2.4l.9.4a1.8 1.8 0 002.3-1z"/><circle cx="12" cy="12" r="3"/></svg>`,
  book: html`<svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h11"/><path d="M9 8h6"/></svg>`,
  sun: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: html`<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg>`,
  stack: html`<svg viewBox="0 0 24 24"><path d="M4 9l8-4 8 4-8 4z"/><path d="M4 14l8 4 8-4"/></svg>`,
  clip: html`<svg viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.9-8.9a3.7 3.7 0 015.2 5.2l-8.9 8.9a1.8 1.8 0 01-2.6-2.6l8.3-8.3"/></svg>`,
  eye: html`<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
  out2: html`<svg class="ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>`,
  sync: html`<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 00-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0014.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>`,
  archive: html`<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M10 13h4"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>`,
  list: html`<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  left: html`<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>`,
  right: html`<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`,
  focus: html`<svg viewBox="0 0 24 24"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg>`,
  out: html`<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/></svg>`,
  check: html`<svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>`,
  search: html`<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/></svg>`,
  spark: html`<svg class="spark" viewBox="0 0 24 24"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>`,
  revert: html`<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  send: html`<svg viewBox="0 0 24 24"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></svg>`,
  pen: html`<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`,
  short: html`<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h6"/></svg>`,
  polite: html`<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/></svg>`,
  globe: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>`,
  wand: html`<svg viewBox="0 0 24 24"><path d="M4 20L15 9"/><path d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M11 3v2M10 4h2"/></svg>`,
  cal: html`<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  person: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>`,
};

function Login({ t }) {
  return html`<main class="login"><h1 class="wm big" dangerouslySetInnerHTML=${{ __html: WORDMARK }}></h1><p>${t.signInLead}</p>
    <a class="btn primary" href="/auth/login">${t.signIn}</a>
    <a class="login-alt" href="/auth/login?outside=1">${t.signInOutside}</a></main>`;
}

function Rail({ t, screen, setScreen, count, flip, signOut, me, dark, toggleTheme, questions }) {
  const b = (key, icon, title, n) => html`<button class=${`ri ${screen === key ? 'on' : ''}`} title=${title} aria-label=${title} onClick=${() => setScreen(key)}>
    ${icon}<span class="rl">${title}</span>${n ? html`<span class="n"><${Num} value=${Math.min(n, 99)} /></span>` : ''}</button>`;
  return html`<nav class="rail" aria-label="menu">
    <div class="brand"><span class="wm" dangerouslySetInnerHTML=${{ __html: WORDMARK }}></span><span class="brand-s"><${Star} /></span></div>
    ${b('todo', Icon.inbox, t.title.todo, count)}${b('sent', Icon.history, t.title.sent)}${calendarVisible(me) ? b('calendar', Icon.cal, t.calendar) : ''}
    ${me.user?.role === 'partner' ? '' : html`${b('playbook', Icon.book, t.playbook, questions)}${b('settings', Icon.gear, t.settings)}`}
    <span class="sp"></span>
    <button class="ri lang" title=${t.lang} aria-label=${t.lang} onClick=${flip}>
      <span class="rl lsw"><span class=${t.lang === 'English' ? 'on' : ''}>日本語</span><span class=${t.lang === 'English' ? '' : 'on'}>EN</span></span></button>
    <button class="ri theme" title=${dark ? t.light : t.dark} aria-label=${dark ? t.light : t.dark} onClick=${toggleTheme}>${dark ? Icon.sun : Icon.moon}<span class="rl">${dark ? t.light : t.dark}</span></button>
    <button class="ri" title=${t.signOut} aria-label=${t.signOut} onClick=${signOut}>${Icon.out}<span class="rl">${t.signOut}</span></button>
    ${me.businesses?.length > 1 ? html`<div class="biz-switch rl"><${Select} value=${me.businesses.find((b) => b.current)?.id} label=${t.business}
        onChange=${async (id) => { await api('/api/me/switch', { method: 'POST', body: { businessId: id } }); location.href = '/'; }}
        options=${me.businesses.map((b) => ({ value: b.id, label: b.name, hint: t.roles[b.role] ?? b.role }))} /></div>` : ''}
    <div class="who-me" title=${me.user.email}><span class="me">${(me.user.name || me.user.email)[0].toUpperCase()}</span>
      <span class="rl"><b>${me.user.name || local(me.user.email)}</b><small>${me.businesses?.length > 1 ? `${me.business.name} · ${t.roles[me.user.role] ?? me.user.role}` : me.user.email}</small></span></div>
  </nav>`;
}

const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400_000)) : null);
// 営業の返信 / フォローアップ: how long the lead has waited for us, or how long they have been quiet.
function outreachTag(o, t) {
  if (!o?.bucket) return null;
  const text = o.bucket === 'unanswered_positive' ? t.outreach.waiting(daysSince(o.positiveReplyAt)) : t.outreach.quiet(o.daysQuiet);
  return html`<span class="tag days">${text}</span>`;
}
// Leads CRM lists that have no mail in Inbox (their mailbox may not be connected): CRM's draft to copy.
function OutreachLeads({ leads, t, toast }) {
  if (!leads?.length) return null;
  const copy = (d) => navigator.clipboard?.writeText(d.subject ? `件名：${d.subject}\n\n${d.body}` : d.body).then(() => toast(t.outreach.copied)).catch(() => {});
  return html`<div class="olead-box"><div class="olead-h"><b>${t.outreach.leadsTitle}</b><span>${t.outreach.leadsHint}</span></div>
    ${leads.map((l) => html`<details class="olead" key=${l.leadId}><summary><span class="olead-n"><b>${l.company || l.email}</b><span>${l.email}</span></span>
        ${outreachTag(l, t)}</summary>
      ${l.draft ? html`<div class="olead-d"><div class="olead-dh"><b>${t.outreach.cockpitDraft}</b><button class="btn small" onClick=${() => copy(l.draft)}>${t.outreach.copy}</button></div>
        ${l.draft.subject ? html`<div class="olead-s">${l.draft.subject}</div>` : ''}<pre>${l.draft.body}</pre></div>` : ''}</details>`)}</div>`;
}
// 打ち合わせ確定 / 提案送付 / 受注 / 失注 on a thread CRM knows as an outreach lead.
function OutcomeCard({ o, id, t, lang, toast, onChanged }) {
  const [busy, setBusy] = useState('');
  const record = async (k) => {
    setBusy(k);
    try { await api(`/api/threads/${id}/outcome`, { method: 'POST', body: { outcome: k } }); toast(t.outreach.recordedToast(t.outreach.outcomes[k])); await onChanged(); } catch (e) { toast(e.message); }
    setBusy('');
  };
  return html`<div class="outcome-card"><div class="oc-t"><b>${t.outreach.outcomeTitle}</b>
      ${o.outcome ? html`<span>${t.outreach.recorded(t.outreach.outcomes[o.outcome] ?? o.outcome, new Date(o.outcomeAt).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-GB', { timeZone: 'Asia/Tokyo' }))}</span>` : ''}</div>
    <div class="oc-b">${Object.entries(t.outreach.outcomes).map(([k, label]) => html`<button class=${`btn small ${o.outcome === k ? 'on' : ''}`} aria-pressed=${o.outcome === k} disabled=${!!busy} onClick=${() => record(k)}>${label}</button>`)}</div></div>`;
}

function rowTag(i, t) {
  if (i.scheduledAt) return html`<span class="tag sched" title=${t.schedCard(fmtShort(i.scheduledAt))}>${Icon.clock}${fmtShort(i.scheduledAt)}</span>`;
  if (i.inSpam && !['sent', 'waiting', 'done', 'ignored'].includes(i.status)) return html`<span class="tag spam">${t.inSpam}</span>`;
  if (i.status === 'sent' || i.status === 'waiting') return html`<span class="tag ok">${t.sentDone}</span>`;
  if (i.status === 'done' || i.status === 'ignored') return html`<span class="tag">${t.done}</span>`;
  if (i.label === 'unconfirmed') return html`<span class="tag warn">${t.fix}</span>`;
  if (i.hasDraft && i.blanks) return html`<span class="tag warn"><${Star} />${t.blanks(i.blanks)}</span>`;
  if (i.hasDraft) return html`<span class="tag ok"><${Star} />${t.ready}</span>`;
  return null;
}

// Date dividers like Gmail/Outlook: 今日 / 昨日 / 今週 / 今月 / それ以前.
function groupByDay(list, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const day = 86400_000; const out = [];
  for (const i of list) {
    const at = new Date(i.at); const d = start - at;
    const key = at >= start ? 'today' : d <= day ? 'yesterday' : d <= 6 * day ? 'week' : d <= 30 * day ? 'month' : 'older';
    if (out.at(-1)?.key !== key) out.push({ key, items: [] });
    out.at(-1).items.push(i);
  }
  return out;
}

const OUTREACH_VIEWS = ['outreach', 'followup'];
// Tabs that only appear while they hold something (or are the one open).
const HIDE_WHEN_EMPTY = ['scheduled', ...OUTREACH_VIEWS];
function List({ onSync, syncing, onArchive, me, t, screen, view, setView, hview, setHview, mailbox, setMailbox, q, setQ, items, counts, selected, onPick, labelName, onFocus, leads, toast }) {
  const outreachView = screen !== 'sent' && OUTREACH_VIEWS.includes(view);
  const shown = (items ?? []).filter((i) => !q || `${i.from} ${i.subject} ${i.snippet}`.toLowerCase().includes(q.toLowerCase()));
  // Tab pill (Motion Primitives "Animated Background"): one surface that springs to the chosen tab.
  const segRef = useRef(null); const [pill, setPill] = useState(null);
  const [folded, setFolded] = useState(() => { try { return JSON.parse(store.get('tbi.folded', '{}')) || {}; } catch { return {}; } });
  const [open, setOpen] = useState({});
  const fold = (k) => setFolded((f) => { const n = { ...f, [k]: !f[k] }; store.set('tbi.folded', JSON.stringify(n)); return n; });
  useLayoutEffect(() => {
    const on = segRef.current?.querySelector('button.on');
    if (!on) return;
    const next = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    setPill((p) => (p && p.x === next.x && p.w === next.w && p.y === next.y ? p : { ...next, jump: !p }));
  });
  // Rows glide to their new place when mail leaves or arrives; new mail softens in. Not on tab switches.
  const rowsRef = useRef(null); const last = useRef({ key: '', tops: new Map() });
  useLayoutEffect(() => {
    const el = rowsRef.current; if (!el) return;
    const key = `${screen}|${view}|${mailbox}`;
    const tops = new Map([...el.querySelectorAll('.row')].map((r) => [r.dataset.id, r.offsetTop]));
    if (key === last.current.key && last.current.tops.size) {
      for (const r of el.querySelectorAll('.row')) {
        const before = last.current.tops.get(r.dataset.id);
        if (before == null) move(r, [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE_OUT });
        else if (Math.abs(before - tops.get(r.dataset.id)) > 1) move(r, [{ transform: `translateY(${before - tops.get(r.dataset.id)}px)` }, { transform: 'none' }], { duration: 320, easing: SPRING });
      }
    }
    last.current = { key, tops };
  });
  return html`<section class="list" aria-label="list">
    <div class="lh">
      <div class="lht"><h1>${screen === 'sent' ? t.title.sent : t.title.todo}</h1>
        <button class=${`tool sync ${syncing ? 'on' : ''}`} title=${t.sync} aria-label=${t.sync} disabled=${syncing} onClick=${onSync}>${Icon.sync}</button>
        <${Select} className="mbx" value=${mailbox} onChange=${setMailbox} label=${t.mailbox}
          options=${[{ value: '', label: t.all }, ...me.mailboxes.map((m) => ({ value: m.id, label: local(m.address) }))]} /></div>
      <label class="search">${Icon.search}<input type="search" placeholder=${t.search} value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    </div>
    ${html`<div class="seg tb-animated-background" ref=${segRef}>
      ${pill ? html`<div class=${`tb-animated-background__bg is-active seg-pill ${pill.jump ? 'is-jump' : ''}`} style=${{ transform: `translate(${pill.x + 6}px, ${pill.y + pill.h - 3}px)`, width: `${pill.w - 12}px`, height: '3px' }}></div>` : ''}
      ${Object.keys(screen === 'sent' ? t.hviews : t.views).filter((v) => screen === 'sent' || !HIDE_WHEN_EMPTY.includes(v) || counts[v] || v === view).map((v) => { const cur = screen === 'sent' ? hview : view; const names = screen === 'sent' ? t.hviews : t.views; return html`
      <button data-id=${v} class=${v === cur ? 'on' : ''} onClick=${() => (screen === 'sent' ? setHview(v) : setView(v))} title=${names[v]}><span class="lbl">${names[v]}</span>${counts[v] ? html`<b><${Num} value=${counts[v]} /></b>` : ''}</button>`; })}</div>`}
    <div class="rows" ref=${rowsRef}>
      ${items === null ? html`<div class="empty">${t.loading}</div>`
        : shown.length === 0 && !(outreachView && leads?.length) ? html`<div class="empty fade-in"><b>${q ? t.notFound : screen === 'sent' ? t.historyEmpty : t.empty}</b></div>`
        : (outreachView ? (shown.length ? [{ key: view, items: shown }] : []) : groupByDay(shown)).map((g) => html`<div class=${`day ${folded[g.key] ? 'folded' : ''}`} key=${g.key}>
          <button class="day-h" aria-expanded=${!folded[g.key]} onClick=${() => fold(g.key)}><svg class="day-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>${t.days[g.key] ?? t.views[g.key]}<span class="day-n">${g.items.length}</span></button>
          ${folded[g.key] ? '' : g.items.map((i) => html`<div key=${i.id} data-id=${i.id} class=${`row ${i.id === selected || i.copies?.some((c) => c.id === selected) ? 'on' : ''}`} role="button" tabindex="0" onClick=${() => onPick(i.id)} onKeyDown=${(e) => e.key === 'Enter' && onPick(i.id)}>
            <${Avatar} from=${i.from} />
            <div class="row-acts" onClick=${(e) => e.stopPropagation()}>
              <button title=${t.archive} aria-label=${t.archive} onClick=${() => onArchive(i.id, false)}>${Icon.archive}</button>
              <button class="danger" title=${t.trash} aria-label=${t.trash} onClick=${() => onArchive(i.id, true)}>${Icon.trash}</button></div>
            <div class="rb"><div class="rt"><b>${nameOf(i.from)}</b><time>${when(i.at, me.lang)}</time></div>
              <div class="subj">${i.subject}</div>
              <div class="tags">${outreachTag(i.outreach, t)}${rowTag(i, t)}${i.label !== 'unconfirmed' ? html`<span class="tag">${labelName(i.label)}</span>` : ''}
                ${i.copies?.length ? html`<button class=${`tag copies ${open[i.id] ? 'open' : ''}`} title=${t.copiesHint} onClick=${(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [i.id]: !o[i.id] })); }}>
                    ${Icon.stack}${t.copies(i.copies.length + 1)}<svg class="cchev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>`
                  : html`<span class="tag">${local(i.mailbox)}</span>`}</div>
              ${i.copies?.length && open[i.id] ? html`<div class="copylist" onClick=${(e) => e.stopPropagation()}>
                ${[{ id: i.id, mailbox: i.mailbox, status: i.status, hasDraft: i.hasDraft, blanks: i.blanks }, ...i.copies].map((c) => html`<button key=${c.id} class=${`copy ${c.id === selected ? 'on' : ''}`} onClick=${() => onPick(c.id)}>
                  <span class="cm">${c.mailbox}</span>${c.hasDraft ? html`<span class=${`tag ${c.blanks ? 'warn' : 'ok'}`}><${Star} />${c.blanks ? t.blanks(c.blanks) : t.ready}</span>` : ''}${c.id === selected ? html`<span class="cnow">${t.replyingFrom}</span>` : ''}</button>`)}
              </div>` : ''}</div>
          </div>`)}</div>`)}
      ${outreachView ? html`<${OutreachLeads} leads=${leads} t=${t} toast=${toast} />` : ''}
    </div>
  </section>`;
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function Message({ m, t, lang, threadId }) {
  const [full, setFull] = useState(false);
  return html`<article class=${`msg ${m.fromUs ? 'out' : ''}`}>
    <div class="mh"><${Avatar} from=${m.from} size="sm" /><b>${nameOf(m.from)}</b><time>${m.date ? new Date(m.date).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</time></div>
    <p>${full ? m.full : m.body}</p>
    ${m.hasQuote ? html`<button class="quote" onClick=${() => setFull(!full)}>${full ? '−' : '…'} ${t.showQuote}</button>` : ''}
    ${m.files?.length ? html`<div class="files">${m.files.map((f, i) => html`<a class="file" key=${i} href=${`/api/threads/${threadId}/files/${m.id}/${i}`} target="_blank" rel="noopener">
      ${Icon.clip}<span class="fn">${f.filename}</span><span class="fs">${kb(f.size)}</span></a>`)}</div>` : ''}
  </article>`;
}

// The draft is edited in place; 【要確認：…】 blanks are highlighted and select themselves on click.
function Editor({ body, version, onText, edRef }) {
  const first = useRef(true);
  useEffect(() => {
    edRef.current.innerHTML = esc(body).replace(BLANK_RE, (m) => `<mark class="blank">${m}</mark>`);
    if (!first.current) move(edRef.current, [{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(4px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 320, easing: EASE_OUT });
    first.current = false;
  }, [version]);
  const pick = (e) => {
    const m = e.target.closest('mark.blank'); if (!m) return;
    const r = document.createRange(); r.selectNodeContents(m);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const paste = (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); };
  return html`<div class="editor" ref=${edRef} contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true"
    onInput=${() => onText(edRef.current.innerText)} onClick=${pick} onPaste=${paste}></div>`;
}

// Every version of this reply: AI rewrites and the person's own edits. Read-only preview to copy from, or restore.
function Versions({ id, t, lang, current, onRestore, onClose }) {
  const [list, setList] = useState(null); const [pick, setPick] = useState(null);
  useEffect(() => { api(`/api/threads/${id}/versions`).then((r) => { setList(r.versions); setPick(r.versions[1] ?? r.versions[0] ?? null); }).catch(() => setList([])); }, [id]);
  const chip = (n) => { const k = Object.keys(t.rwText).find((x) => t.rwText[x] === n); return k ? t.rw[k] : n; };
  const label = (v) => (v.by === 'user' ? (v.note || t.vEdited) : v.note ? t.vRewrite(chip(v.note)) : t.vFirst);
  const at = (iso) => new Date(iso).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const copy = async () => { try { await navigator.clipboard.writeText(pick.body); } catch { /* selection still works */ } };
  return html`<div class="vpanel">
    <div class="vlist">${list === null ? html`<div class="vempty">…</div>` : list.length === 0 ? html`<div class="vempty">${t.vNone}</div>`
      : list.map((v, i) => html`<button key=${v.id} class=${`vitem ${pick?.id === v.id ? 'on' : ''}`} onClick=${() => setPick(v)}>
        <span class="vno">v${v.version}</span><span class="vl">${v.by === 'ai' ? html`<${Star} />` : ''}${label(v)}</span><time>${at(v.at)}${i === 0 ? html` · <b class="vnow">${t.vLatest}</b>` : ''}</time></button>`)}</div>
    <div class="vview">${pick ? html`<div class="vbody">${pick.body}</div>
      <div class="vacts"><button class="btn" onClick=${copy}>${t.vCopy}</button>${pick.body !== current ? html`<button class="btn primary" onClick=${() => onRestore(pick.body)}>${t.vRestore}</button>` : html`<span class="vsame">${t.vSame}</span>`}<span class="sp"></span><button class="btn" onClick=${onClose}>${t.close}</button></div>` : ''}</div>
  </div>`;
}

function LiveDraft({ text, since, t, target }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(h); }, []);
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [text]);
  const pct = text ? Math.min(96, 8 + (text.length / Math.max(200, target || 400)) * 88) : Math.min(8, secs * 1.5);
  return html`<div class="ld">
    <div class="live-bar"><i style=${{ transform: `scaleX(${pct / 100})` }}></i></div>
    <div class="live-head"><${Star} live />${text ? t.writing(text.length) : t.thinking}<span class="sp"></span><span class="secs">${t.secs(secs)}</span></div>
    ${text ? html`<div class="live-text">${text}<span class="caret" ref=${end}></span></div>`
      : html`<div class="live-sk"><i></i><i></i><i></i><i></i></div>`}
  </div>`;
}

// 予約送信 picker: quick slots in Japan time, or any date and time. Opens from the clock beside 送信.
function SchedulePop({ t, lang, initial, onPick, onClose, title }) {
  const root = useRef(null);
  const [closing, setClosing] = useState(false);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = jst(initial ?? schedulePresets().find((p) => p.key === 'tmrMorning').at);
  const [date, setDate] = useState(`${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}-${pad2(start.getUTCDate())}`);
  const [time, setTime] = useState(`${pad2(start.getUTCHours())}:${pad2(start.getUTCMinutes())}`);
  const presets = schedulePresets();
  const today = jst(new Date());
  const minDate = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(today.getUTCDate())}`;
  const customAt = (() => {
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    return [y, mo, d, h, mi].every(Number.isFinite) ? fromJst(y, mo - 1, d, h, mi).toISOString() : null;
  })();
  const customOk = customAt && new Date(customAt) - Date.now() >= 60_000;
  const close = useCallback(() => { if (REDUCE.matches) onClose(); else { setClosing(true); setTimeout(onClose, 130); } }, [onClose]);
  useEffect(() => {
    root.current?.querySelector('.spop-row')?.focus();
    const away = (e) => { if (!root.current?.contains(e.target) && !e.target.closest?.('.later')) close(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true); };
  }, [close]);
  const pick = async (at) => {
    setBusy(true); setErr('');
    try { await onPick(at); close(); } catch (e) { setErr(t.refused[e.code] ?? e.message); setBusy(false); }
  };
  return html`<div class=${`spop ${closing ? 'out' : ''}`} ref=${root} role="dialog" aria-label=${title ?? t.schedTitle}>
    <div class="spop-h"><b>${title ?? t.schedTitle}</b><span class="chip">${t.jst}</span></div>
    ${presets.map((p, n) => { const cur = initial && new Date(initial).getTime() === new Date(p.at).getTime(); return html`<button class=${`spop-row ${cur ? 'cur' : ''}`} style=${{ '--i': n }} disabled=${busy || cur} aria-current=${cur ? 'true' : undefined} onClick=${() => pick(p.at)}>
      <span class="sl">${t.presets[p.key]}</span><span class="st">${cur ? html`<svg class="tick" viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>` : ''}${fmtWhen(p.at, lang)}</span></button>`; })}
    <button class=${`spop-row more ${custom ? 'on' : ''}`} style=${{ '--i': presets.length }} aria-expanded=${custom} onClick=${() => setCustom(!custom)}>
      <span class="sl">${Icon.clock}${t.pickTime}</span><svg class="cchev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
    <div class=${`spop-custom ${custom ? 'open' : ''}`}><div class="spop-ci">
      <div class="spop-fields"><input type="date" aria-label=${t.date} min=${minDate} value=${date} onInput=${(e) => setDate(e.target.value)} />
        <input type="time" aria-label=${t.time} step="300" value=${time} onInput=${(e) => setTime(e.target.value)} /></div>
      <div class="spop-go"><span class=${`spop-when ${customOk ? '' : 'bad'}`}>${customAt ? (customOk ? t.schedAt(fmtWhen(customAt, lang)) : t.refused.too_soon) : '—'}</span>
        <button class="btn primary small" disabled=${!customOk || busy} onClick=${() => pick(customAt)}>${t.scheduleBtn}</button></div>
    </div></div>
    ${err ? html`<div class="spop-err" role="alert">${err}</div>` : ''}
  </div>`;
}

// A reply waiting for its time: what goes out, when, and how to change it.
function ScheduledCard({ p, t, lang, toast, files, onReload, onSendNow, onEdit }) {
  const [, tick] = useState(0);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState('');
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(h); }, []);
  const call = async (what, path, body, done) => {
    setBusy(what);
    try { const r = await api(path, { method: 'POST', body }); await done(r); } catch (e) { toast(t.refused[e.code] ?? e.message); }
    setBusy('');
  };
  const cancel = () => call('cancel', `/api/sends/${p.id}/undo`, {}, async () => {
    const card = document.querySelector('.comp.sched');
    if (card?.animate && !REDUCE.matches) await card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.985)' }], { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).finished;
    toast(t.schedCancelled); await onReload();
  });
  const now = () => call('now', `/api/sends/${p.id}/schedule`, { now: true }, (r) => onSendNow(r));
  // 内容を編集: the schedule pauses (draft back in the editor) and the composer offers the same time again.
  const edit = () => call('edit', `/api/sends/${p.id}/undo`, {}, async () => { onEdit(p.scheduledAt); await onReload(); });
  return html`<section class="comp sched" aria-live="polite">
    <div class="sq-head"><span class="sq-ic">${Icon.clock}</span>
      <div class="sq-t"><b>${t.schedCard(fmtWhen(p.scheduledAt, lang))}</b><span>${untilText(p.scheduledAt, t)} · ${t.jst}</span></div></div>
    ${p.body ? html`<div class="sq-body">${p.body}</div>` : ''}
    ${files?.length ? html`<div class="outfiles">${files.map((f) => html`<span class="file out" key=${f.id}>${Icon.clip}<span class="fn">${f.filename}</span><span class="fs">${kb(f.size)}</span></span>`)}</div>` : ''}
    <div class="sq-acts">
      <div class="sq-anchor"><button class="btn later" disabled=${!!busy} aria-expanded=${picking} onClick=${() => setPicking(!picking)}>${Icon.clock}${t.changeTime}</button>
        ${picking ? html`<${SchedulePop} t=${t} lang=${lang} initial=${p.scheduledAt} title=${t.changeTime} onClose=${() => setPicking(false)}
          onPick=${async (at) => { const r = await api(`/api/sends/${p.id}/schedule`, { method: 'POST', body: { sendAt: at } }); toast(t.rescheduled(fmtWhen(r.scheduledAt, lang))); await onReload(); }} />` : ''}</div>
      <button class="btn" disabled=${!!busy} onClick=${edit}>${Icon.pen}${t.editSched}</button>
      <button class="btn" disabled=${!!busy} onClick=${now}>${Icon.send}${t.sendNow}</button>
      <span class="sp"></span>
      <button class="btn ghost-danger" disabled=${!!busy} onClick=${cancel}>${t.cancelSched}</button>
    </div>
  </section>`;
}

function Conversation({ id, item, me, t, labelName, toast, onChanged, onSent, onScheduled, onBack, onNext, actions, pendingFor, focus, position, onExitFocus, onFocus, onPrev, onStep }) {
  const cached = threadCache.get(id)?.data ?? null;
  const [data, setDataRaw] = useState(cached);
  const [text, setText] = useState(cached?.draft?.body ?? '');
  const [ver, setVer] = useState(cached ? 1 : 0);
  const cur = useRef(cached);
  const setData = (fn) => setDataRaw((d) => { const n = typeof fn === 'function' ? fn(d) : fn; cur.current = n; if (n) putThread(id, n); return n; });
  const [busy, setBusy] = useState('');
  const [older, setOlder] = useState(false);
  const [asking, setAsking] = useState(false);
  const edRef = useRef(null);
  const load = useCallback(async () => {
    const d = await getThread(id, { fresh: true });
    const before = cur.current?.draft;
    setData(d);
    if (!before || before.id !== d.draft?.id) { setText(d.draft?.body ?? ''); setVer((v) => v + 1); }
  }, [id]);
  useEffect(() => { load().catch((e) => toast(e.message)); }, [load]);

  const pending = pendingFor(id) ?? data?.pendingSend;
  const blanks = (text.match(BLANK_RE) ?? []).length;
  // D8 partner: some mailboxes are read-and-draft only (an owner decides who may send).
  const live = data?.thread.mailboxMode === 'live' && data?.thread.canSend !== false;
  const noSend = data?.thread.mailboxMode === 'live' && data?.thread.canSend === false;

  const save = async () => {
    if (!data.draft) return null;
    if (text === data.draft.body) return data.draft;
    const r = await api(`/api/drafts/${data.draft.id}`, { method: 'PUT', body: { body: text } });
    setData((d) => ({ ...d, draft: r.draft })); return r.draft;
  };
  // sendAt (ISO) = 予約送信; the picker shows its own error, so a refused schedule is re-thrown to it.
  const send = async (sendAt) => {
    if (!data?.draft || pending || busy) return;
    if (!live) return toast(t.refused.mailbox_not_live);
    if (blanks) { toast(t.refused.blanks_left); const m = edRef.current?.querySelector('mark.blank'); if (m) { m.scrollIntoView({ block: 'center' }); m.click(); } return; }
    setBusy('send');
    try {
      const d = await save();
      const r = await api(`/api/threads/${id}/send`, { method: 'POST', body: { draftId: d.id, body: text, ...(sendAt ? { sendAt } : {}) } });
      if (r.scheduledAt) {
        const box = document.querySelector('.conv .cbody');
        const out = !REDUCE.matches && box?.animate ? box.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scale(.99)' }], { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).finished : null;
        await Promise.all([out, leave(document.querySelector(`.row[data-id="${id}"]`), false)]);
        onScheduled({ id: r.sendId, scheduledAt: r.scheduledAt, threadId: id });
      } else onSent({ id: r.sendId, undoUntil: r.undoUntil, threadId: id, name: nameOf(item?.from) });
    } catch (e) {
      setBusy('');
      if (sendAt) throw e;
      toast(t.refused[e.code] ?? e.message);
    }
    setBusy('');
  };
  const [later, setLater] = useState(false);
  // After 内容を編集: the time it was scheduled for, offered again beside 送信 while it is still ahead.
  const [resumeAt, setResumeAt] = useState(null);
  const resumable = resumeAt && new Date(resumeAt) - Date.now() >= 60_000;
  // The draft streams in as the AI writes it, so the person sees progress instead of a spinner.
  // Files attached to this reply (sent with it).
  const fileRef = useRef(null); const [dragging, setDragging] = useState(false); const [uploading, setUploading] = useState(0);
  const addFiles = async (list) => {
    for (const file of [...(list ?? [])]) {
      if (file.size > 10 * 1024 * 1024) { toast(t.tooBig(file.name)); continue; }
      setUploading((n) => n + 1);
      try {
        const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = no; r.readAsDataURL(file); });
        const res = await api(`/api/threads/${id}/attachments`, { method: 'POST', body: { filename: file.name, mimeType: file.type || 'application/octet-stream', data: b64 } });
        setData((d) => ({ ...d, outgoing: [...(d.outgoing ?? []), res.file] }));
      } catch (e) { toast(e.message); }
      setUploading((n) => n - 1);
    }
  };
  const removeFile = async (fid) => {
    setData((d) => ({ ...d, outgoing: (d.outgoing ?? []).filter((f) => f.id !== fid) }));
    try { await api(`/api/threads/${id}/attachments/${fid}`, { method: 'DELETE' }); } catch (e) { toast(e.message); }
  };
  const [stream, setStream] = useState(null); const [showV, setShowV] = useState(false); const [since, setSince] = useState(0);
  const draft = async (instruction, mode) => {
    setBusy('draft'); setStream(''); setSince(Date.now());
    try {
      const res = await fetch(`/api/threads/${id}/draft?stream=1`, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(mode ? { mode } : instruction ? { instruction, current: text } : {}) });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.message || d.error || res.statusText); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let acc = ''; let fin = null;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.t === 'd') { acc += ev.v; setStream(acc); } else if (ev.t === 'done') fin = ev.draft; else if (ev.t === 'error') throw new Error(ev.error);
        }
      }
      if (!fin) throw new Error(t.draftFailed);
      setData((d) => ({ ...d, draft: fin })); setText(fin.body); setVer((v) => v + 1); onChanged();
    } catch (e) { toast(e.message); }
    setBusy(''); setStream(null); setAsking(false);
  };
  const archive = async (trash) => {
    try {
      const body = document.querySelector('.conv .cbody');
      const out = !REDUCE.matches && body?.animate ? body.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: trash ? 'translateX(-24px) scale(.985)' : 'translateX(24px)' }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }).finished : null;
      const [r] = await Promise.all([api(`/api/threads/${id}/archive`, { method: 'POST', body: { trash } }), out, leave(document.querySelector(`.row[data-id="${id}"]`), trash)]);
      onChanged(); onNext();
      toast(trash ? t.trashed : t.archived, { label: t.undo, run: async () => { await api(`/api/threads/${id}/archive`, { method: 'POST', body: { undo: true, prevStatus: r.prevStatus } }); onChanged(); } });
    } catch (e) { document.querySelector('.conv .cbody')?.getAnimations().forEach((a) => a.cancel()); unleave(document.querySelector(`.row[data-id="${id}"]`)); toast(e.message); }
  };
  const notSpam = async () => {
    try { await api(`/api/threads/${id}/not-spam`, { method: 'POST', body: {} }); toast(t.notSpamDone); load(); onChanged(); } catch (e) { toast(e.message); }
  };
  const setStatus = async (status) => {
    await api(`/api/threads/${id}/status`, { method: 'POST', body: { status } });
    onChanged(); if (status === 'done') onNext(); else load();
  };
  const relabel = async (label) => {
    try {
      await api(`/api/threads/${id}/label`, { method: 'POST', body: { label } });
      const l = me.labels.find((x) => x.key === label);
      onChanged();
      if (l?.autoDraft && !data.draft) { await load(); await draft(); } else if (data.thread.label === 'unconfirmed' && !l?.autoDraft) onNext(); else await load();
    } catch (e) { toast(e.message); }
  };
  actions.current = { send: () => send(), done: () => data && setStatus('done'), edit: () => { const m = edRef.current?.querySelector('mark.blank'); if (m) m.click(); else edRef.current?.focus(); } };

  if (!data) return html`<main class="conv"><div class="ch"><span class="sk sk-av"></span><span class="sk sk-line"></span></div>
    <div class="scroll"><div class="thread skwrap"><div class="sk sk-msg"></div><div class="sk sk-comp"></div></div></div></main>`;
  const { thread, messages } = data;
  const closed = ['done', 'ignored'].includes(thread.status);
  const sent = ['sent', 'waiting'].includes(thread.status);
  const shown = older ? messages : messages.slice(-1);
  const guess = thread.labelGuess;
  const lang = me.lang;

  let bottom;
  if (pending?.scheduledAt) {
    bottom = html`<${ScheduledCard} key=${pending.id} p=${pending} t=${t} lang=${lang} toast=${toast} files=${data.outgoing}
      onReload=${async () => { await load(); onChanged(); }}
      onSendNow=${(r) => onSent({ id: r.sendId, undoUntil: r.undoUntil, threadId: id, name: nameOf(item?.from) })}
      onEdit=${(at) => { setResumeAt(at); toast(t.editingSched); setTimeout(() => edRef.current?.focus(), 350); }} />`;
  } else if (thread.label === 'unconfirmed' && !closed) {
    bottom = html`<section class="classify"><h3>${t.which}</h3><div class="choices">
      ${me.labels.filter((l) => l.autoDraft || ['notice', 'sales_pitch', 'other'].includes(l.key)).map((l, n) => html`<button class=${`choice ${l.key === guess ? 'guess' : ''}`} style=${{ '--i': n }} onClick=${() => relabel(l.key)}>
        ${lang === 'ja' ? l.ja : l.en}${l.key === guess ? html`<span class="aiguess"><${Star} />${t.aiGuess}</span>` : ''}</button>`)}</div>
      ${busy === 'draft' ? html`<div class="tb-border-beam beam"><div class="tb-border-beam__beam"></div></div>` : ''}</section>`;
  } else if (data.draft && (!closed && !sent || (thread.outreach && thread.status !== 'ignored' && data.draft.status === 'open'))) {
    const otherLang = /[ぁ-んァ-ン一-龯]/.test(text) ? 'en' : 'ja';
    bottom = html`<section class=${`comp ${busy === 'draft' ? 'working' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver=${(e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop=${(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
      ${dragging ? html`<div class="dropzone">${Icon.clip}<b>${t.dropHere}</b></div>` : ''}
      <div class="cbar"><span class="ai"><${Star} live=${busy === 'draft'} />${t.draft}</span>
        <div class="pills">${['short', 'polite', otherLang].map((k) => html`<button class=${`pill rw-${k === otherLang ? 'lang' : k}`} disabled=${!!busy || !!pending} onClick=${() => draft(t.rwText[k])}>${Icon[k === otherLang ? 'globe' : k]}${t.rw[k]}</button>`)}
        <button class="pill rw-ai" disabled=${!!busy || !!pending} onClick=${() => setAsking(!asking)}><${Star} />${t.ask}</button></div></div>
      ${showV ? html`<${Versions} id=${id} t=${t} lang=${lang} current=${text} onRestore=${(body) => { setText(body); setVer((v) => v + 1); setShowV(false); toast(t.restored); }} onClose=${() => setShowV(false)} />` : ''}
      ${stream !== null ? html`<${LiveDraft} text=${stream} since=${since} t=${t} target=${text.length} />` : ''}
      ${asking ? html`<form class="askrow" onSubmit=${(e) => { e.preventDefault(); const v = e.target.elements.q.value.trim(); if (v) draft(v); }}>
        <input name="q" placeholder=${t.askPh} autofocus /><button class="btn small">${t.remake}</button></form>` : ''}
      <div class=${stream !== null || showV ? 'hidden' : 'edwrap'}><${Editor} body=${text} version=${ver} onText=${setText} edRef=${edRef} /></div>
      ${(data.outgoing?.length || uploading) ? html`<div class="outfiles">${(data.outgoing ?? []).map((f) => html`<span class="file out" key=${f.id}>${Icon.clip}<span class="fn">${f.filename}</span><span class="fs">${kb(f.size)}</span>
          <button aria-label=${t.remove} onClick=${() => removeFile(f.id)}>✕</button></span>`)}${uploading ? html`<span class="file out busy"><i class="spin"></i>${t.uploading}</span>` : ''}</div>` : ''}
      <div class="cfoot">
        <button class="tool vbtn" title=${t.attach} aria-label=${t.attach} onClick=${() => fileRef.current?.click()}>${Icon.clip}<span>${t.attach}</span></button>
        <input type="file" multiple hidden ref=${fileRef} onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button class=${`tool vbtn ${showV ? 'on' : ''}`} title=${t.versions} aria-label=${t.versions} onClick=${() => setShowV(!showV)}>${Icon.history}<span>${t.versions}</span></button>
        <span class=${`hint ${blanks ? 'warn' : ''}`}>${noSend ? t.noSend : !live ? t.shadow : ''}</span>
        ${pending ? html`<span class="tag ai">${t.sending}</span>`
          : blanks > 0 && live ? html`<div class="send"><button class="fill" onClick=${() => actions.current.edit?.()}>${Icon.pen}${t.fillBlanks(blanks)}</button></div>`
          : html`${resumable ? html`<button class="btn resume" disabled=${!live || busy === 'send'} onClick=${() => send(resumeAt).catch((e) => toast(t.refused[e.code] ?? e.message))}>${Icon.clock}${t.resumeAt(fmtShort(resumeAt))}</button>` : ''}
            <div class="send split"><button class="main" disabled=${!live || busy === 'send'} title="Ctrl + Enter" onClick=${() => send()}>${Icon.send}${t.send}</button>
              <button class="later" disabled=${!live || busy === 'send'} title=${t.later} aria-label=${t.later} aria-haspopup="dialog" aria-expanded=${later} onClick=${() => setLater(!later)}>${Icon.clock}</button>
              ${later ? html`<${SchedulePop} t=${t} lang=${lang} onPick=${(at) => send(at)} onClose=${() => setLater(false)} />` : ''}</div>`}
      </div>
      ${busy === 'draft' ? html`<div class="tb-border-beam beam"><div class="tb-border-beam__beam"></div></div>` : ''}
    </section>`;
  } else if (!closed && !sent) {
    bottom = html`<section class="comp nodraft"><span>${t.noDraft}</span>
      <button class="btn primary" disabled=${busy === 'draft'} onClick=${() => draft()}><${Star} live=${busy === 'draft'} />${t.makeDraft}</button></section>`;
  } else {
    bottom = html`<div class="sentview"><div class="big">${Icon.check}</div><h3>${sent ? t.sentDone : t.done}</h3>
      ${thread.outreach?.bucket === 'gone_quiet' ? html`<p>${t.outreach.followupHint}</p>` : ''}
      <div class="sv-acts">${thread.outreach && thread.status !== 'ignored' ? html`<button class="btn primary" disabled=${busy === 'draft'} onClick=${() => draft(undefined, 'followup')}><${Star} live=${busy === 'draft'} />${t.outreach.makeFollowup}</button>` : ''}
      ${closed ? html`<button class="btn" onClick=${() => setStatus('new')}>${t.reopen}</button>` : ''}</div></div>`;
  }

  return html`<main class="conv">
    <div class="ch">
      ${focus ? html`<div class="stepper"><button class="btn" title="Esc" onClick=${onExitFocus}>${Icon.list}${t.list}</button>
          <button class="btn icon" title="K" aria-label=${t.prev} onClick=${onPrev}>${Icon.left}</button><span class="pos">${position}</span><button class="btn icon" title="J" aria-label=${t.next} onClick=${onStep}>${Icon.right}</button></div>`
        : html`<button class="btn back" onClick=${onBack}>← ${t.back}</button>`}
      <${Avatar} from=${item?.from ?? messages.at(-1)?.from} />
      <div class="chm"><h2>${thread.subject}</h2><div class="who"><b>${nameOf(item?.from ?? messages.at(-1)?.from)}</b> ${`<${addrOf(item?.from ?? messages.at(-1)?.from)}>`} → ${thread.mailbox}</div>
        ${data.links?.sites?.length || data.links?.previews?.length ? html`<div class="hlinks">
          ${(data.links.sites ?? []).map((u) => html`<a class="hl site" href=${u} target="_blank" rel="noopener noreferrer" title=${u}>${Icon.globe}<span>${u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>${Icon.out2}</a>`)}
          ${(data.links.previews ?? []).map((u) => html`<a class="hl preview" href=${u} target="_blank" rel="noopener" title=${u}>${Icon.eye}<span>${t.preview}</span>${Icon.out2}</a>`)}
        </div>` : ''}</div>
      <span class="sp"></span>
      <${Select} className="hide-sm lab" value=${thread.label} onChange=${relabel} label=${t.label}
        options=${me.labels.map((l) => ({ value: l.key, label: lang === 'ja' ? l.ja : l.en }))} />
      <button class="btn arch" title=${t.archive} aria-label=${t.archive} onClick=${() => archive(false)}>${Icon.archive}<span class="bl">${t.archive}</span></button>
      <button class="btn arch danger" title=${t.trash} aria-label=${t.trash} onClick=${() => archive(true)}>${Icon.trash}<span class="bl">${t.trashShort}</span></button>
      ${!closed ? html`<button class="btn" title="D" onClick=${() => setStatus('done')}>${Icon.check}${t.done}</button>` : ''}
      ${!focus ? html`<button class="btn icon hide-sm" title=${`${t.focus} (F)`} aria-label=${t.focus} onClick=${onFocus}>${Icon.focus}</button>` : ''}
    </div>
    <div class="cbody">
    <div class="scroll">
      <div class="thread">
        ${messages.length > 1 && !older ? html`<button class="fold" onClick=${() => setOlder(true)}>${t.older(messages.length - 1)}</button>` : ''}
        ${shown.map((m) => html`<${Message} key=${m.id} m=${m} t=${t} lang=${lang} threadId=${id} />`)}
        ${thread.label === 'unconfirmed' && !closed ? html`<div class="why"><span class="ic">!</span>${t.unsure}</div>` : ''}
        ${data.scheduling && calendarVisible(me) ? html`<${SchedCard} s=${data.scheduling} api=${api} lang=${lang} t=${t} toast=${toast} canSend=${thread.canSend !== false} onChanged=${load}
          threadId=${id} mailboxId=${me.mailboxes?.find((m) => m.address === thread.mailbox)?.id} mailboxes=${me.mailboxes ?? []} />` : ''}
        ${data.deadline && calendarVisible(me) ? html`<${DeadlineCard} d=${data.deadline} api=${api} lang=${lang} t=${t} toast=${toast} onChanged=${load} tz=${me.calendar?.timezone || 'Asia/Tokyo'} />` : ''}
        ${thread.outreach ? html`<${OutcomeCard} o=${thread.outreach} id=${id} t=${t} lang=${lang} toast=${toast} onChanged=${async () => { await load(); onChanged(); }} />` : ''}
        ${thread.inSpam ? html`<div class="spam-card" role="note"><span class="sc-ic">!</span><div class="sc-t"><b>${t.inSpam}</b><span>${t.spamWhy}</span></div><button class="btn small" onClick=${notSpam}>${t.notSpam}</button></div>` : ''}
      </div>
    </div>
    ${bottom}
    </div>
  </main>`;
}

function App() {
  const [lang, setLang] = useState(store.get('tbi.lang', 'ja'));
  const t = STRINGS[lang];
  const [me, setMe] = useState(undefined);
  const [screen, setScreen] = useState('todo');
  const [view, setView] = useState('todo');
  const [hview, setHview] = useState('all');
  const [mailbox, setMailbox] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const [leads, setLeads] = useState([]);
  const [selected, setSelected] = useState(null);
  const [reading, setReading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState([]);
  const [help, setHelp] = useState(false);
  // Things that need a person (failed send, disconnected mailbox, draft the AI gave up on).
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    if (!me?.user) return undefined;
    const pull = () => api('/api/alerts').then((r) => setAlerts(r.alerts)).catch(() => {});
    pull(); const h = setInterval(pull, 30000); return () => clearInterval(h);
  }, [me]);
  const dismiss = (a) => { setAlerts((xs) => xs.filter((x) => x.id !== a.id)); api(`/api/alerts/${a.id}/dismiss`, { method: 'POST', body: {} }).catch(() => {}); };
  // 対応待ち opens one email at a time (list tucked away); 履歴 keeps the list beside the email.
  const [focus, setFocus] = useState(true);
  const [openQs, setOpenQs] = useState(0);
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || '');
  const dark = theme ? theme === 'dark' : sysDark.matches;
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    const flipIt = () => { document.documentElement.dataset.theme = next; setTheme(next); store.set('tbi.theme', next); };
    // A soft cross-fade between themes where the browser supports it.
    if (document.startViewTransition && !REDUCE.matches) document.startViewTransition(flipIt); else flipIt();
  };
  const [, tick] = useState(0);
  const actions = useRef({});

  const toast = useCallback((text, action) => {
    const id = Math.random(); const life = action ? 6000 : 2400; setToasts((ts) => [...ts, { id, text, action }]);
    setTimeout(() => setToasts((ts) => ts.map((x) => (x.id === id ? { ...x, out: true } : x))), life);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), life + 250);
  }, []);
  useEffect(() => { api('/api/me').then((m) => { setMe(m); if (m.user?.role === 'owner' && !m.mailboxes.length) setScreen('setup'); }).catch((e) => setMe(e.status === 401 ? null : { error: e.message })); }, []);
  // Open owner questions show as a badge on プレイブック.
  useEffect(() => { if (!me?.user || me.user.role === 'partner') return undefined; const f = () => api('/api/questions').then((r) => setOpenQs(r.questions.length)).catch(() => {}); f(); const h = setInterval(f, 60000); return () => clearInterval(h); }, [me, screen]);
  useEffect(() => {
    const fromHash = () => {
      const h = location.hash;
      const m = h.match(/^#t=([\w-]+)/);
      if (m) { setScreen('todo'); setSelected(m[1]); setReading(true); history.replaceState(null, '', '/'); return; }
      const q = h.match(/^#q=([\w-]+)/);
      if (q) { setScreen('playbook'); history.replaceState(null, '', '/'); setTimeout(() => { const el = document.getElementById(`q-${q[1]}`); el?.scrollIntoView({ block: 'center' }); el?.querySelector('input')?.focus(); }, 600); return; }
      if (['#setup', '#settings', '#playbook', '#calendar'].includes(h)) { setScreen(h.slice(1)); history.replaceState(null, '', '/'); }
    };
    fromHash(); addEventListener('hashchange', fromHash); return () => removeEventListener('hashchange', fromHash);
  }, []);
  const listView = screen === 'sent' ? hview : view;
  // 履歴 can hold thousands of conversations: search runs on the server there.
  const [qServer, setQServer] = useState('');
  useEffect(() => { const h = setTimeout(() => setQServer(screen === 'sent' ? q.trim() : ''), 300); return () => clearTimeout(h); }, [q, screen]);
  const refresh = useCallback(async () => {
    const qs = new URLSearchParams({ view: listView, ...(mailbox ? { mailbox } : {}), ...(qServer ? { q: qServer } : {}) });
    const r = await api(`/api/threads?${qs}`); setItems(r.threads); setCounts(r.counts); setLeads(r.leads ?? []); return r.threads;
  }, [listView, mailbox, qServer]);
  useEffect(() => {
    if (!me?.user || !['todo', 'sent'].includes(screen)) return;
    setItems(null);
    refresh().then((list) => setSelected((s) => (s && list.some((i) => i.id === s || i.copies?.some((c) => c.id === s))) ? s : list[0]?.id ?? null)).catch((e) => toast(e.message));
  }, [me, refresh, screen]);
  useEffect(() => { if (!me?.user) return undefined; const h = setInterval(() => refresh().catch(() => {}), 30000); return () => clearInterval(h); }, [me, refresh]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  // Undo countdowns: one tick a second while anything is waiting to send.
  useEffect(() => {
    if (!pending.length) return undefined;
    const h = setInterval(() => {
      const now = Date.now();
      setPending((ps) => { const left = ps.filter((p) => new Date(p.undoUntil) > now); if (left.length !== ps.length) refresh().catch(() => {}); return left; });
      tick((x) => x + 1);
    }, 500);
    return () => clearInterval(h);
  }, [pending.length]);

  const visible = (items ?? []).filter((i) => !q || `${i.from} ${i.subject} ${i.snippet}`.toLowerCase().includes(q.toLowerCase()));
  // Prefetch the emails around the open one so J/K and clicks land instantly.
  useEffect(() => {
    const i = visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected));
    const near = [visible[i + 1], visible[i + 2], visible[i - 1], ...(i < 0 ? visible.slice(0, 3) : [])].filter(Boolean);
    const h = setTimeout(() => near.forEach((x) => getThread(x.id).catch(() => {})), 250);
    return () => clearTimeout(h);
  }, [selected, items]);
  // Inbox zero by your own hand gets a little confetti (Magic UI "Confetti"); never on first load.
  const lastTodo = useRef(null);
  useEffect(() => {
    if (lastTodo.current > 0 && counts.todo === 0 && (counts.unconfirmed ?? 0) === 0) {
      window.TobiraConfetti?.fire(null, { particleCount: 90, spread: 75, startVelocity: 38, origin: { x: 0.55, y: 0.75 }, colors: ['#3b5bfd', '#7c8dff', '#18a058', '#f5a524', '#ff7a90'] });
    }
    lastTodo.current = counts.todo ?? null;
  }, [counts.todo, counts.unconfirmed]);
  const pick = (id) => { setSelected(id); setReading(true); if (screen === 'todo') setFocus(true); };
  const next = () => {
    const i = visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected));
    const n = visible.slice(i + 1).find((x) => !pending.some((p) => p.threadId === x.id)) ?? visible.slice(0, Math.max(0, i)).reverse()[0];
    setSelected(n?.id ?? null); if (!n) setReading(false);
  };
  // 更新: pull new mail now (when the regular sync lags).
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api('/api/sync', { method: 'POST', body: {} });
      await refresh();
      toast(r.running ? t.syncRunning : r.sorted ? t.synced(r.sorted) : t.upToDate);
      if (r.errors?.length) toast(r.errors.map((e) => `${e.mailbox}: ${e.error}`).join(' / '));
    } catch (e) { toast(e.message); }
    setSyncing(false);
  };
  // Archive / delete straight from the list (same as in Gmail), with undo.
  const archiveRow = async (tid, trash) => {
    try {
      const [r] = await Promise.all([api(`/api/threads/${tid}/archive`, { method: 'POST', body: { trash } }), leave(document.querySelector(`.row[data-id="${tid}"]`), trash)]);
      if (tid === selected) next();
      setItems((xs) => (xs ?? []).filter((x) => x.id !== tid)); refresh().catch(() => {});
      toast(trash ? t.trashed : t.archived, { label: t.undo, run: async () => { await api(`/api/threads/${tid}/archive`, { method: 'POST', body: { undo: true, prevStatus: r.prevStatus } }); refresh().catch(() => {}); } });
    } catch (e) { unleave(document.querySelector(`.row[data-id="${tid}"]`)); toast(e.message); }
  };
  const onSent = (p) => { setPending((ps) => [...ps, p]); next(); refresh().catch(() => {}); };
  // 予約送信: no countdown (it may be days away); a toast that can take it back.
  const onScheduled = (p) => {
    threadCache.delete(p.threadId); next(); refresh().catch(() => {});
    toast(t.scheduledToast(fmtWhen(p.scheduledAt, lang)), { label: t.undo, run: async () => {
      try { await api(`/api/sends/${p.id}/undo`, { method: 'POST', body: {} }); threadCache.delete(p.threadId); toast(t.schedCancelled); refresh().catch(() => {}); } catch (e) { toast(t.refused[e.code] ?? e.message); }
    } });
  };
  const undo = async (p) => {
    try { await api(`/api/sends/${p.id}/undo`, { method: 'POST', body: {} }); setPending((ps) => ps.filter((x) => x.id !== p.id)); setSelected(p.threadId); setReading(true); toast(t.undone); refresh().catch(() => {}); }
    catch (e) { toast(t.refused[e.code] ?? e.message); }
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); actions.current.send?.(); return; }
      if (e.target.closest?.('input,textarea,select,[contenteditable]')) { if (e.key === 'Escape') e.target.blur(); return; }
      if (!['todo', 'sent'].includes(screen)) return;
      if (e.key === 'f') { setFocus((x) => !x); return; }
      if (e.key === 'Escape' && focus) { setFocus(false); return; }
      const i = visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected));
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); if (visible[i + 1]) pick(visible[i + 1].id); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) pick(visible[i - 1].id); }
      else if (e.key === 'e') { e.preventDefault(); actions.current.edit?.(); }
      else if (e.key === 'd') actions.current.done?.();
      else if (e.key === '?') setHelp((h) => !h);
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  });

  if (me === undefined) return html`<div class="boot"><i class="spin"></i></div>`;
  if (me === null) return html`<${Login} t=${t} />`;
  if (me.error) return html`<p class="boot">${t.error}: ${me.error}</p>`;
  const meL = { ...me, lang };
  const labelName = (k) => { const l = me.labels.find((x) => x.key === k); return l ? (lang === 'ja' ? l.ja : l.en) : k; };
  const signOut = async () => { await api('/auth/logout', { method: 'POST', body: {} }); location.href = '/'; };
  const flip = () => { const l = lang === 'ja' ? 'en' : 'ja'; setLang(l); store.set('tbi.lang', l); };
  const go = (s) => { setScreen(s); setReading(false); setFocus(s === 'todo'); if (['todo', 'sent'].includes(s)) setSelected(null); };
  const item = (items ?? []).find((i) => i.id === selected) ?? (() => { const p = (items ?? []).find((i) => i.copies?.some((c) => c.id === selected)); return p && { ...p, id: selected, mailbox: p.copies.find((c) => c.id === selected).mailbox }; })();

  if (screen === 'setup') return html`<${Setup} api=${api} lang=${lang} toast=${toast} onDone=${() => { api('/api/me').then(setMe); go('todo'); }} />
    <div class="toasts" role="status">${toasts.map((x) => html`<div class=${`toast ${x.out ? 'out' : ''}`} key=${x.id}>${x.text}</div>`)}</div>`;
  const pos = `${Math.max(1, visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected)) + 1)} / ${visible.length}`;
  return html`<div class=${`app ${reading ? 'reading' : ''} ${focus && selected ? 'focus' : ''}`}>
    <${Rail} t=${t} screen=${screen} setScreen=${go} count=${(counts.todo ?? 0) + (counts.unconfirmed ?? 0)} flip=${flip} signOut=${signOut} me=${me} dark=${dark} toggleTheme=${toggleTheme} questions=${openQs} />
    ${screen === 'calendar' && calendarVisible(me) ? html`<div class="cal-wrap"><${Calendar} api=${api} me=${meL} lang=${lang} t=${t} toast=${toast} /></div>`
      : screen === 'settings' ? html`<div class="settings-wrap"><${Settings} api=${api} lang=${lang} toast=${toast} /></div>`
      : screen === 'playbook' ? html`<div class="settings-wrap"><${Playbook} api=${api} lang=${lang} toast=${toast} /></div>` : html`
      <${List} onSync=${sync} syncing=${syncing} onArchive=${archiveRow} me=${meL} t=${t} screen=${screen} view=${view} setView=${(v) => { setView(v); setSelected(null); }} hview=${hview} setHview=${(v) => { setHview(v); setSelected(null); }} mailbox=${mailbox} setMailbox=${setMailbox}
        q=${q} setQ=${setQ} items=${items} counts=${counts} selected=${selected} onPick=${pick} labelName=${labelName} onFocus=${() => setFocus(true)} leads=${leads} toast=${toast} />
      ${selected ? html`<${Conversation} key=${selected} id=${selected} item=${item} me=${meL} t=${t} labelName=${labelName} toast=${toast}
          onChanged=${() => refresh().catch(() => {})} onSent=${onSent} onScheduled=${onScheduled} onBack=${() => setReading(false)} onNext=${next}
          actions=${actions} pendingFor=${(id) => pending.find((p) => p.threadId === id)} focus=${focus} position=${pos} onExitFocus=${() => setFocus(false)} onFocus=${() => setFocus(true)}
          onPrev=${() => { const i = visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected)); if (i > 0) pick(visible[i - 1].id); }}
          onStep=${() => { const i = visible.findIndex((x) => x.id === selected || x.copies?.some((c) => c.id === selected)); if (visible[i + 1]) pick(visible[i + 1].id); }} />`
        : html`<main class="conv"><div class="scroll center"><div class="sentview"><h3>${items && !items.length ? t.empty : t.pick}</h3></div></div></main>`}`}
    ${alerts.length ? html`<div class="alertbar" role="alert">${alerts.slice(0, 3).map((a) => html`<div class="alert" key=${a.id}>
      <span class="al-ic">!</span><div class="al-t"><b>${a.title}</b>${a.body ? html`<span>${a.body}</span>` : ''}</div>
      ${a.url && a.url !== '/' ? html`<a class="btn small" href=${a.url} onClick=${() => setTimeout(() => location.reload(), 0)}>${t.open}</a>` : ''}
      <button class="tool" aria-label=${t.close} onClick=${() => dismiss(a)}>✕</button></div>`)}</div>` : ''}
    <div class="toasts" role="status">
      ${pending.map((p) => html`<div class="toast" key=${p.id}><span class="count">${t.sendsLabel} <${Num} value=${Math.max(0, Math.ceil((new Date(p.undoUntil) - Date.now()) / 1000))} /></span><button onClick=${() => undo(p)}>${t.undo}</button></div>`)}
      ${toasts.map((x) => html`<div class=${`toast ${x.out ? 'out' : ''}`} key=${x.id}><span>${x.text}</span>${x.action ? html`<button onClick=${() => { x.action.run(); setToasts((ts) => ts.filter((y) => y.id !== x.id)); }}>${x.action.label}</button>` : ''}</div>`)}
    </div>
    ${help ? html`<div class="kbd" onClick=${() => setHelp(false)}><b>${t.keys}</b>${t.keyHelp.map(([k, v]) => html`<span><kbd>${k}</kbd> ${v}</span>`)}</div>` : ''}
  </div>`;
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
