// apps/server/src/gmail.js — minimal Gmail REST client over fetch.
// Holds the access token in memory only; refreshes it via the stored
// (encrypted) refresh token when it expires.
import { refreshAccessToken } from './google.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {
  constructor(status, body) { super(`gmail ${status}: ${body?.error?.message ?? ''}`); this.status = status; }
}

export class Gmail {
  /**
   * @param {{clientId:string, clientSecret:string, refreshToken:string, fetchImpl?:typeof fetch}} o
   */
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
    Object.assign(this, { clientId, clientSecret, refreshToken, fetchImpl });
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const t = await refreshAccessToken({
      clientId: this.clientId, clientSecret: this.clientSecret, refreshToken: this.refreshToken, fetchImpl: this.fetchImpl,
    });
    this.accessToken = t.access_token;
    this.expiresAt = Date.now() + (t.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async call(method, path, body) {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new GmailError(res.status, json);
    return json;
  }

  profile() { return this.call('GET', '/profile'); }

  /** All history since startHistoryId (paged). Throws GmailError 404 when the id is too old. */
  async historySince(startHistoryId) {
    const out = { messageIds: [], historyId: startHistoryId };
    let pageToken;
    do {
      // New mail, plus mail that newly lands in the inbox (rescued from spam, un-archived); seen ones are skipped later.
      const q = new URLSearchParams({ startHistoryId, labelId: 'INBOX' });
      q.append('historyTypes', 'messageAdded'); q.append('historyTypes', 'labelAdded');
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.call('GET', `/history?${q}`);
      for (const h of r.history ?? []) {
        for (const m of h.messagesAdded ?? []) out.messageIds.push(m.message.id);
        for (const m of h.labelsAdded ?? []) if ((m.labelIds ?? []).includes('INBOX')) out.messageIds.push(m.message.id);
      }
      out.historyId = r.historyId ?? out.historyId;
      pageToken = r.nextPageToken;
    } while (pageToken);
    out.messageIds = [...new Set(out.messageIds)];
    return out;
  }

  /**
   * Mail we sent since startHistoryId (calendar §5, D36: our own offers are read for dates too). Same
   * history call as historySince, filtered to SENT. Ingest calls it only when calendar_mode is not 'off'.
   */
  async sentHistorySince(startHistoryId) {
    const out = { messageIds: [], historyId: startHistoryId };
    let pageToken;
    do {
      const q = new URLSearchParams({ startHistoryId, labelId: 'SENT', historyTypes: 'messageAdded' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.call('GET', `/history?${q}`);
      for (const h of r.history ?? []) for (const m of h.messagesAdded ?? []) out.messageIds.push(m.message.id);
      out.historyId = r.historyId ?? out.historyId;
      pageToken = r.nextPageToken;
    } while (pageToken);
    out.messageIds = [...new Set(out.messageIds)];
    return out;
  }

  /** One attachment's bytes as text (an .ics invite not sent inline). */
  async getAttachmentText(messageId, attachmentId) {
    const r = await this.call('GET', `/messages/${messageId}/attachments/${attachmentId}`);
    return r.data ? Buffer.from(r.data, 'base64url').toString('utf8') : '';
  }

  async listInbox({ newerThanDays = 7, max = 100 } = {}) {
    const q = new URLSearchParams({ q: `in:inbox newer_than:${newerThanDays}d`, maxResults: String(max) });
    const r = await this.call('GET', `/messages?${q}`);
    return (r.messages ?? []).map((m) => m.id);
  }

  /** Recent mail Gmail filed as spam (checked for customers Gmail got wrong). */
  async listSpam({ newerThanDays = 3, max = 25 } = {}) {
    const q = new URLSearchParams({ q: `in:spam newer_than:${newerThanDays}d`, maxResults: String(max) });
    const r = await this.call('GET', `/messages?${q}`);
    return (r.messages ?? []).map((m) => m.id);
  }

  /** Ids of threads with mail we sent (for learning from past replies, D4). */
  async listSentThreads({ newerThanDays = 365, max = 60 } = {}) {
    const q = new URLSearchParams({ q: `in:sent newer_than:${newerThanDays}d`, maxResults: String(max) });
    const r = await this.call('GET', `/threads?${q}`);
    return (r.threads ?? []).map((t) => t.id);
  }

  getMessage(id) { return this.call('GET', `/messages/${id}?format=full`); }

  getThread(id) { return this.call('GET', `/threads/${id}?format=full`); }

  /** The name this mailbox normally sends as (Gmail "Send mail as"), so our replies match its other mail. */
  async sendAsName() {
    const r = await this.call('GET', '/settings/sendAs');
    return (r.sendAs ?? []).find((x) => x.isPrimary)?.displayName || null;
  }

  async labels() { return (await this.call('GET', '/labels')).labels ?? []; }

  createLabel(name) {
    return this.call('POST', '/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
  }

  /** Send a raw RFC 822 message in a thread. Only the send queue calls this, after a person clicked Send. */
  sendRaw(raw, threadId) { return this.call('POST', '/messages/send', { raw, ...(threadId ? { threadId } : {}) }); }

  sendAs() { return this.call('GET', '/settings/sendAs'); }

  modifyThread(threadId, { add = [], remove = [] }) {
    return this.call('POST', `/threads/${threadId}/modify`, { addLabelIds: add, removeLabelIds: remove });
  }
}

function header(headers, name) {
  const h = (headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decode(data) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

/** Attached files (name, type, size, Gmail attachment id); inline images without a name are skipped. */
function fileParts(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push({ id: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size ?? 0 });
  for (const p of part.parts ?? []) fileParts(p, out);
  return out;
}

function hasMime(part, type) {
  if (!part) return false;
  return part.mimeType === type || (part.parts ?? []).some((p) => hasMime(p, type));
}

function textPart(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = textPart(p);
    if (t) return t;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return decode(part.body.data).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  return '';
}

/** Gmail API message → the shape the engine sorter reads. Body stays in memory only. */
export function parseMessage(m) {
  const h = m.payload?.headers ?? [];
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    snippet: m.snippet ?? '',
    internalDate: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    subject: header(h, 'Subject'),
    replyTo: header(h, 'Reply-To'),
    date: header(h, 'Date'),
    messageId: header(h, 'Message-ID') || header(h, 'Message-Id'),
    inReplyTo: header(h, 'In-Reply-To'),
    references: header(h, 'References'),
    autoSubmitted: header(h, 'Auto-Submitted'),
    autoReply: header(h, 'X-Autoreply'),
    precedence: header(h, 'Precedence'),
    listUnsubscribe: header(h, 'List-Unsubscribe'),
    // A Gmail emoji reaction travels as a reply email; it is never a message to answer or an answer itself.
    reaction: hasMime(m.payload, 'text/vnd.google.email-reaction+json'),
    listId: header(h, 'List-Id'),
    body: textPart(m.payload),
    attachments: fileParts(m.payload),
  };
}
