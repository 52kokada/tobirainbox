// apps/server/src/transport.js — delivers a queued send through the mailbox's own
// Gmail (D3, D16): threaded reply, Gmail-style quote, HTML + text (or text only).
// Only deliverDue() calls this, after the undo window of a person's click.
import { buildReplyMime, toBase64Url, parseFrom, jaDateJst } from '@tobira-inbox/engine';
import { stripQuotedContent } from '@tobira-inbox/engine';
import { parseMessage } from './gmail.js';
import { gmailFor } from './mailboxes.js';
import { cockpitSendCheck } from './cockpit-check.js';

/** Name + address from a header value like `森田 <info@x.jp>`. */
function addr(value) {
  const email = parseFrom(value);
  const m = String(value ?? '').match(/^\s*"?([^"<]*?)"?\s*</);
  return { email, name: m?.[1]?.trim() || undefined };
}

export function gmailTransport(db, config, { gmailFactory, fetchImpl } = {}) {
  return {
    async send({ send, thread, mailbox }) {
      const gmail = gmailFor(mailbox, config, gmailFactory);
      const raw = await gmail.getThread(thread.gmail_thread_id);
      const own = mailbox.address.toLowerCase();
      const msgs = (raw.messages ?? []).map(parseMessage);
      const last = [...msgs].reverse().find((m) => !m.reaction && parseFrom(m.from) !== own);
      if (!last) throw new Error('no inbound message to reply to');
      // CRM decides suppression; checked on the real recipient, before anything is built.
      await cockpitSendCheck(db, config, { mailbox, thread, toEmail: addr(last.replyTo || last.from).email }, fetchImpl ? { fetchImpl } : {});
      const voice = mailbox.voice_profile_id ? db.prepare('SELECT full_name FROM voice_profiles WHERE id = ?').get(mailbox.voice_profile_id) : null;
      // Same sender name as the mailbox's own Gmail mail (else the customer sees two different senders in one thread).
      if (!mailbox.display_name && gmail.sendAsName) {
        try { const n = await gmail.sendAsName(); if (n) { db.prepare('UPDATE mailboxes SET display_name = ? WHERE id = ?').run(n, mailbox.id); mailbox.display_name = n; } } catch { /* fall back to the voice name */ }
      }
      const business = db.prepare('SELECT plain_text FROM businesses WHERE id = ?').get(mailbox.business_id);
      const subject = /^re\s*[:：]/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
      const mime = buildReplyMime({
        from: { name: mailbox.display_name || voice?.full_name?.replace(/（.*?）/g, '').trim(), email: mailbox.address },
        to: [addr(last.replyTo || last.from)],
        subject,
        text: send.body_text,
        attachments: db.prepare('SELECT filename, mime AS mimeType, data FROM thread_attachments WHERE thread_id = ? AND sent_at IS NULL ORDER BY created_at')
          .all(thread.id).map((f) => ({ filename: f.filename, mimeType: f.mimeType, data: Buffer.from(f.data).toString('base64') })),
        quote: { date: jaDateJst(last.date || last.internalDate), from: last.from, text: stripQuotedContent(last.body) },
        inReplyTo: last.messageId || null,
        references: last.references || null,
        plainText: Boolean(business?.plain_text),
      });
      const res = await gmail.sendRaw(toBase64Url(mime), thread.gmail_thread_id);
      try { await gmail.modifyThread(thread.gmail_thread_id, { remove: ['UNREAD'] }); } catch { /* best effort (D15) */ }
      // Gmail assigns the Message-ID; read it back so CRM can match the client's next reply.
      let messageIdHeader = null;
      try { messageIdHeader = parseMessage(await gmail.getMessage(res.id)).messageId || null; } catch { /* best effort */ }
      return { messageId: res.id, messageIdHeader, inReplyTo: last.messageId || null, to: addr(last.replyTo || last.from).email, replyingTo: last.id,
        incoming: stripQuotedContent(last.body), incomingFrom: last.from };
    },
  };
}
