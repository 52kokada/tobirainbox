// @tobira-inbox/engine — pure reply logic shared by TobirAInbox and an optional external CRM backend.
// No database, no mailbox client, no web server in here.
export { stripQuotedContent, classifyReply as classifyOutreachReply } from './outreach-classifier.js';
export { parseFrom, stripReplyPrefixes, isAutoReply, isBulkMail } from './auto-reply.js';
export { BUILT_IN_LABELS, LABEL_KEYS, effectiveLabels, labelForOutreachVerdict } from './labels.js';
export { sortMessage, parseSort, gmailCategory, SORT_MODEL, UNCONFIRMED, MIN_CONFIDENCE } from './sorter.js';
export { findBlanks, hasBlanks, fillBlank, makeBlank } from './blanks.js';
export { redact, assertRedacted } from './redact.js';
export { buildDraftPrompt, enforceGrounding, draftReply, DRAFT_MODEL, DRAFT_MODEL_ESCALATED } from './drafter.js';
export { buildReplyMime, toBase64Url, textToHtml, encodeHeader, formatAddress, rfcDateJst, jaDateJst } from './mime.js';
export {
  hasDateHints, findCalendarParts, parseIcs, buildDateRequest, parseDateResult, resolveDates,
  normalizeTz, localToUtc, utcToLocal, DATE_SYSTEM_PROMPT, DATE_KINDS, DEFAULT_MEETING_MINUTES,
  hasPreviewHints, parsePreviewResult, previewDueDate, hasPreviewLink, PREVIEW_LINK_RE, PREVIEW_RULE_DAYS,
} from './dates.js';
