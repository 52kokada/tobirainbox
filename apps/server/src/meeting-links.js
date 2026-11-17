// apps/server/src/meeting-links.js — the video-call link a mail already carries (D11: use the link found
// in the mail; only when there is none does the confirm step create a Google Meet). Pure: text in, links out.
// Sits beside links.js, whose NOT_A_SITE already keeps these hosts out of "their site".

// URLs are ASCII; anything else (Japanese punctuation, full-width brackets, the next sentence) ends one.
const URL_RE = /https?:\/\/[!#-;=?-~]+/gi;

// Order matters only for readability; each pattern is anchored to the provider's own meeting paths, so a
// provider's marketing or download pages (zoom.us/download, teams.microsoft.com/downloads) do not match.
const PROVIDERS = [
  { kind: 'meet', re: /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(?:[/?#]|$)/i },
  { kind: 'zoom', re: /^https:\/\/(?:[\w-]+\.)?zoom\.(?:us|com)\/(?:j|w|my|s)\/[\w.-]+/i },
  { kind: 'teams', re: /^https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join\/|meet\/)\S+/i },
  { kind: 'webex', re: /^https:\/\/[\w-]+\.webex\.com\/(?:meet\/[\w.-]+|join\/[\w.-]+|[\w-]+\/j\.php\?\S*MTID=\S+|wbxmjs\/joinservice\/\S+)/i },
];

/** Undo the click-tracking wrappers mail systems put around links (Gmail, Outlook Safe Links, Proofpoint). */
export function unwrapLink(raw) {
  let u = String(raw);
  for (let i = 0; i < 3; i++) { // a link can be wrapped more than once (forwarded through two gateways)
    let next = null;
    try {
      const p = new URL(u);
      const h = p.hostname.toLowerCase();
      if ((/(^|\.)google\.[a-z.]+$/.test(h) && p.pathname === '/url')) next = p.searchParams.get('q') ?? p.searchParams.get('url');
      else if (/safelinks\.protection\.outlook\.com$/.test(h)) next = p.searchParams.get('url');
      else if (h === 'urldefense.proofpoint.com') next = p.searchParams.get('u')?.replace(/_/g, '/').replace(/-([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
      else if (h === 'urldefense.com') {
        const m = u.match(/\/v3\/__(.+?)__;?/);
        next = m ? m[1] : null;
      }
    } catch { break; }
    if (!next || next === u) break;
    u = next;
  }
  return u;
}

const tidy = (u) => {
  let s = u.replace(/&amp;/g, '&').replace(/[.,;:!?'*]+$/, '');
  if (s.endsWith(')') && !s.includes('(')) s = s.slice(0, -1); // "(https://...)" in ASCII text
  return s;
};

/** Every meeting link in the text, first occurrence first, each once. → [{ url, kind }] */
export function meetingLinks(text) {
  const out = []; const seen = new Set();
  for (const raw of String(text ?? '').match(URL_RE) ?? []) {
    const url = tidy(unwrapLink(tidy(raw)));
    const p = PROVIDERS.find((x) => x.re.test(url));
    if (!p) continue;
    const key = url.replace(/[#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, kind: p.kind });
  }
  return out;
}

/** The link to use for the meeting: the last one in the thread (a later mail may replace an earlier room). */
export function meetingLinkForThread(messages) {
  let found = null;
  for (const m of messages ?? []) {
    const links = meetingLinks(m.full ?? m.body ?? '');
    if (links.length) found = links[links.length - 1];
  }
  return found;
}
