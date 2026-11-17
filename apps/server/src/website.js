// apps/server/src/website.js — read a business's own website for facts (D8).
// Fetches the page the owner gives plus up to 11 same-site pages that look useful
// (料金, アクセス, 予約, FAQ …), turns them into text, and asks the model for facts.
// Nothing becomes a fact until a person accepts it (fact_proposals).
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { newId, Store } from './store.js';
import { underDailyCap } from './ingest-cap.js';

export const WEBSITE_MODEL = 'claude-sonnet-5-5';
const MAX_PAGES = 12;
const PAGE_CHARS = 6000;
const TOTAL_CHARS = 42000;

// ── fetching, refusing anything that is not a public web address ──
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:') && privateIp(x.slice(7));
}

export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL の形が正しくありません'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http か https の URL を入れてください');
  if (u.username || u.password) throw new Error('この URL は読み込めません');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('この URL は読み込めません');
  return u;
}

export async function safeFetch(raw, { timeoutMs = 10_000, maxBytes = 1_500_000, hops = 3 } = {}) {
  let url = raw;
  for (let i = 0; i <= hops; i += 1) {
    const u = await assertPublicUrl(url);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'TobirAInbox/1.0 (+https://inbox.example.com)', accept: 'text/html,application/xhtml+xml' } });
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), u).toString(); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/text\/html|application\/xhtml/.test(res.headers.get('content-type') ?? '')) throw new Error('HTML ではありません');
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; if (size > maxBytes) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { url: u.toString(), html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('リダイレクトが多すぎます');
}

// ── HTML → text and links ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', copy: '©' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

export function htmlToText(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
  const desc = decode(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)?.[1] ?? '');
  let s = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/div|\/section|\/dd|\/dt)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/[ \t 　]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return [title && `# ${title}`, desc, s].filter(Boolean).join('\n');
}

const USEFUL = /price|fee|plan|menu|access|map|about|company|faq|question|reserv|book|contact|info|guide|policy|cancel|shop|store|room|course|class|service|料金|価格|メニュー|アクセス|会社|概要|よくある|質問|予約|お問い合わせ|ご案内|ガイド|キャンセル|店舗|サービス|コース|教室|プラン/i;
export function pickLinks(html, base) {
  const origin = new URL(base).origin; const seen = new Set(); const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (u.origin !== origin || /\.(pdf|jpe?g|png|gif|webp|zip|mp4)$/i.test(u.pathname)) continue;
    u.hash = ''; const key = u.toString();
    if (seen.has(key) || key === base) continue; seen.add(key);
    const text = m[2].replace(/<[^>]+>/g, ' ');
    out.push({ url: key, score: (USEFUL.test(u.pathname) ? 2 : 0) + (USEFUL.test(text) ? 2 : 0) - u.pathname.split('/').length * 0.1 });
  }
  return out.sort((a, b) => b.score - a.score).filter((l) => l.score > 0).slice(0, MAX_PAGES - 1).map((l) => l.url);
}

// ── facts from text ──
export function buildFactsPrompt(pages, existing = []) {
  return [
    'You read a small business\'s own website and list facts that help staff reply to customer emails.',
    'Write one fact per line, exactly: 項目: 内容 | 出典URL',
    '- 項目 is a short Japanese label (料金, 営業時間, 定休日, 住所, アクセス, 予約方法, 予約URL, キャンセル規定, 支払い方法, 対応言語, 定員, 電話番号, メール …). Several prices may each get their own line (料金（英語ページ）など).',
    '- 内容 copies what the page says. Never guess, round or translate numbers, dates or URLs. Skip anything not stated.',
    '- At most 40 lines. No other text.',
    existing.length ? `Facts already on file (do not repeat unless the website says something different):\n${existing.map((f) => `- ${f.key}: ${f.value}`).join('\n')}` : '',
    '',
    ...pages.map((p) => `=== ${p.url}\n${p.text}`),
  ].filter((x) => x !== '').join('\n');
}

export function parseFacts(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.replace(/^[-・*\s]+/, '').match(/^(.{1,40}?)[:：]\s*(.+?)\s*\|\s*(https?:\/\/\S+)\s*$/);
    if (m && m[2].length <= 500) out.push({ key: m[1].trim(), value: m[2].trim(), sourceUrl: m[3] });
  }
  return out.slice(0, 40);
}

/** Read the site and store new or changed facts as proposals. Returns {pages, found}. */
export async function readWebsite({ db, ai, businessId, url, readId = newId(), fetcher = safeFetch, config = {} }) {
  const exists = db.prepare('SELECT 1 FROM website_reads WHERE id = ?').get(readId);
  if (!exists) db.prepare('INSERT INTO website_reads (id, business_id, url) VALUES (?, ?, ?)').run(readId, businessId, url);
  const finish = (status, extra = {}) => db.prepare('UPDATE website_reads SET status = ?, pages = ?, found = ?, error = ?, finished_at = ? WHERE id = ?')
    .run(status, extra.pages ?? 0, extra.found ?? 0, extra.error ?? null, new Date().toISOString(), readId);
  try {
    if (!ai) throw new Error('AI が設定されていません');
    if (!underDailyCap(db, businessId, config.aiDailyCapUsd)) throw new Error('本日の AI 利用上限に達しています');
    const first = await fetcher(url);
    const pages = [{ url: first.url, text: htmlToText(first.html).slice(0, PAGE_CHARS) }];
    for (const link of pickLinks(first.html, first.url)) {
      try { const p = await fetcher(link); pages.push({ url: p.url, text: htmlToText(p.html).slice(0, PAGE_CHARS) }); } catch { /* skip a broken page */ }
    }
    let budget = TOTAL_CHARS;
    const kept = pages.filter((p) => p.text.length > 10).map((p) => { const text = p.text.slice(0, Math.max(0, budget)); budget -= text.length; return { ...p, text }; }).filter((p) => p.text);
    const store = new Store(db, businessId);
    const existing = store.facts();
    const res = await ai.complete({ operation: 'website', prompt: buildFactsPrompt(kept, existing), model: WEBSITE_MODEL, maxTokens: 3000, meter: { businessId } });
    let found = 0;
    for (const f of parseFacts(res?.text)) {
      const same = existing.find((e) => e.key === f.key && e.value === f.value);
      const pending = db.prepare("SELECT 1 FROM fact_proposals WHERE business_id = ? AND key = ? AND value = ? ").get(businessId, f.key, f.value);
      if (same || pending) continue;
      db.prepare('INSERT INTO fact_proposals (id, business_id, key, value, source_url) VALUES (?, ?, ?, ?, ?)').run(newId(), businessId, f.key, f.value, f.sourceUrl);
      found += 1;
    }
    finish('done', { pages: kept.length, found });
    return { pages: kept.length, found };
  } catch (err) {
    finish('failed', { error: String(err.message).slice(0, 300) });
    throw err;
  }
}

/** Weekly re-read for every business that gave us its website. */
export async function rereadWebsites({ db, ai, config, now = new Date(), fetcher }) {
  const due = db.prepare(`SELECT b.id, b.website_url FROM businesses b WHERE b.website_url IS NOT NULL AND b.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM website_reads r WHERE r.business_id = b.id AND r.started_at > ?)`).all(new Date(now - 7 * 86400_000).toISOString());
  for (const b of due) { try { await readWebsite({ db, ai, businessId: b.id, url: b.website_url, config, ...(fetcher ? { fetcher } : {}) }); } catch { /* recorded on the read */ } }
  return due.length;
}
