// apps/server/src/links.js — the two links a person wants on top of a conversation: the customer's own site
// (from their email domain or the URLs in their signature) and any Tobira preview we sent them.
import { parseFrom } from '@tobira-inbox/engine';
import { FREE_MAIL } from './ingest.js';

const URL_RE = /https?:\/\/[^\s<>"'）)」』\]]+|(?<![@\w.])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'）)」』\]]*/gi;
const NOT_A_SITE = /google\.|goo\.gl|gstatic|youtube|youtu\.be|zoom\.us|calendly|cal\.com|facebook\.com\/(?:sharer|dialog)|twitter\.com\/intent|x\.com\/intent|line\.me|bit\.ly|tinyurl|forms\.|docs\.|drive\.|mailchimp|list-manage|sendgrid|unsubscribe|maps\.|apple\.com|microsoft\.com|outlook\.|example\.com/i;
const clean = (u) => (u.startsWith('http') ? u : `https://${u}`).replace(/[.,。、]+$/, '');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function threadLinks(messages, { isOwn = () => false } = {}) {
  const previews = new Set(); const sites = new Map();
  for (const m of messages) {
    const text = `${m.full ?? m.body ?? ''}`;
    for (const raw of text.match(URL_RE) ?? []) {
      const u = clean(raw);
      if (/\/\/(?:www\.)?example\.com\/[\w-]+-preview\b/i.test(u)) { previews.add(u.replace(/[?#].*$/, '').replace(/\/?$/, '/')); continue; }
      if (isOwn(parseFrom(m.from))) continue; // only the customer's own links count as "their site"
      if (NOT_A_SITE.test(u)) continue;
      const h = host(u); if (!h) continue;
      if (!sites.has(h)) sites.set(h, `https://${h}/`);
    }
  }
  // Their email domain is their site too, unless it is shared webmail.
  for (const m of messages) {
    const from = parseFrom(m.from); const d = String(from ?? '').split('@')[1];
    if (d && !isOwn(from) && !FREE_MAIL.has(d) && !sites.has(d) && ![...sites.keys()].some((h) => h.endsWith(d) || d.endsWith(h))) sites.set(d, `https://${d}/`);
  }
  return { sites: [...sites.values()].slice(0, 3), previews: [...previews].slice(0, 3) };
}
