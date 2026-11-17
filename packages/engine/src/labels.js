// packages/engine/src/labels.js
// Built-in label set for small businesses (decision D7, plan §4). Businesses can
// rename, hide and add labels; `key` is stable, names are display only.

export const BUILT_IN_LABELS = Object.freeze([
  { key: 'inquiry', ja: '新規問い合わせ', en: 'New inquiry', autoDraft: true,
    hint: 'A new customer or prospect asking about services, prices or availability, or a positive reply to our outreach.' },
  { key: 'booking', ja: '予約', en: 'Booking', autoDraft: true,
    hint: 'A request to book, or a booking confirmation written by a person.' },
  { key: 'booking_change', ja: '予約変更・キャンセル', en: 'Change / cancel', autoDraft: true,
    hint: 'A request to change, move or cancel an existing booking.' },
  { key: 'question', ja: '質問', en: 'Question', autoDraft: true,
    hint: 'An existing customer or partner asking a question that needs an answer.' },
  { key: 'complaint', ja: 'クレーム', en: 'Complaint', autoDraft: true,
    hint: 'Dissatisfaction, a problem, a refund request.' },
  { key: 'decline', ja: 'お断り', en: 'Declined', autoDraft: false,
    hint: 'They decline or are not interested, without asking us to stop emailing.' },
  { key: 'optout', ja: '配信停止', en: 'Unsubscribe', autoDraft: false,
    hint: 'They ask us to stop sending email / unsubscribe.' },
  { key: 'sales_pitch', ja: '営業メール', en: 'Sales pitch to us', autoDraft: false,
    hint: 'Someone trying to sell something to this business.' },
  { key: 'notice', ja: 'お知らせ・ニュースレター', en: 'Notice / newsletter', autoDraft: false,
    hint: 'Newsletters, service notices, receipts, system notifications; nobody expects a reply.' },
  { key: 'spam', ja: '迷惑メール', en: 'Spam', autoDraft: false,
    hint: 'Spam, phishing, scams.' },
  { key: 'auto_reply', ja: '自動返信', en: 'Auto-reply', autoDraft: false,
    hint: 'Out-of-office, bounce, mailer-daemon, any message no human wrote.' },
  { key: 'unconfirmed', ja: '要確認', en: 'Needs a person', autoDraft: false,
    hint: 'Choose this only when you genuinely cannot tell which label fits. A person will sort it.' },
  { key: 'other', ja: 'その他', en: 'Other', autoDraft: false,
    hint: 'Anything that fits none of the above.' },
]);

export const LABEL_KEYS = new Set(BUILT_IN_LABELS.map((l) => l.key));

/**
 * Map a CRM outreach verdict onto a business label (plan §4).
 * @param {'positive'|'negative'|'optout'|'oob'|'auto'|'unclear'} verdict
 */
export function labelForOutreachVerdict(verdict) {
  switch (verdict) {
    case 'positive': return 'inquiry';
    case 'negative': return 'decline';
    case 'optout': return 'optout';
    case 'oob':
    case 'auto': return 'auto_reply';
    case 'unclear': return 'unconfirmed';
    default: return 'unconfirmed';
  }
}

/**
 * Merge built-ins with a business's overrides and custom labels.
 * @param {Array<{key:string, ja?:string, en?:string, hidden?:boolean, autoDraft?:boolean, hint?:string}>} overrides
 */
export function effectiveLabels(overrides = []) {
  const byKey = new Map(BUILT_IN_LABELS.map((l) => [l.key, { ...l, hidden: false, custom: false }]));
  for (const o of overrides) {
    if (!o?.key) continue;
    const base = byKey.get(o.key) ?? { key: o.key, ja: o.key, en: o.key, autoDraft: false, hint: '', hidden: false, custom: true };
    byKey.set(o.key, { ...base, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) });
  }
  return [...byKey.values()];
}
