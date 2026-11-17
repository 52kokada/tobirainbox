// Calendar plan step 8: date detection in the engine (D3, D35, D36, D38, D42).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasDateHints, findCalendarParts, parseIcs, buildDateRequest, parseDateResult, resolveDates,
  localToUtc, normalizeTz, DATE_SYSTEM_PROMPT, hasPreviewHints, parsePreviewResult, previewDueDate, hasPreviewLink,
} from '../src/index.js';
import { loadSplit, detect, grade, runEval } from '../scripts/eval-dates.js';

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const TOKYO = 'Asia/Tokyo';

test('fixtures are split by thread: no thread in both train and test, and both splits have positives and negatives', () => {
  const train = loadSplit('train'); const test_ = loadSplit('test');
  const names = (l) => new Set(l.map((t) => t.thread));
  for (const n of names(train)) assert.ok(!names(test_).has(n), `${n} in both splits`);
  for (const l of [train, test_]) {
    const msgs = l.flatMap((t) => t.messages);
    assert.ok(msgs.some((m) => m.expect.dates.length) && msgs.some((m) => !m.expect.dates.length));
    assert.ok(l.every((t) => t.synthetic === true), 'fixtures in git are synthetic');
  }
});

test('pre-filter lets no dated mail through as undated, on both splits', () => {
  for (const split of ['train', 'test']) {
    for (const t of loadSplit(split)) {
      for (const m of t.messages) {
        const hint = hasDateHints(m.text, findCalendarParts(m.payload));
        if (m.expect.dates.length) assert.equal(hint, true, `${split}/${t.thread}#${m.id}`);
        if (m.expect.hint === false) assert.equal(hint, false, `${split}/${t.thread}#${m.id}`);
      }
    }
  }
});

test('pre-filter: no-hint set stays out, every form in §5 gets in', () => {
  for (const s of ['資料ありがとうございました。社内で検討いたします。', 'お見積書を添付いたします。ご確認ください。',
    '今月のおすすめ商品をご紹介します。', 'Thanks for the files, looks great.', 'いつもご利用ありがとうございます。', '']) {
    assert.equal(hasDateHints(s), false, s);
  }
  for (const s of ['11/9はいかがですか', '１１月９日', '9日(月)', '（火）', '水曜日', '来週', '明後日', '14時', '10:30', '午後',
    'ご都合', '日程', '候補', '打ち合わせ', '打合せ', 'ミーティング', '面談', 'MTG', '3pm', '10 a.m.', 'Thursday', 'Nov 12', 'tomorrow',
    'reschedule', 'availability', 'a quick call', 'free slot', 'JST', 'PT', 'キャンセル', 'リスケ']) {
    assert.equal(hasDateHints(s), true, s);
  }
  assert.equal(hasDateHints('no words', [{ mimeType: 'text/calendar' }]), true, 'a calendar part always passes');
});

const ics = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');

test('MIME walker finds a calendar part three levels deep and inside a forwarded message', () => {
  const deep = ics(['METHOD:REQUEST', 'BEGIN:VEVENT', 'DTSTART:20261116T050000Z', 'END:VEVENT']);
  const payload = { mimeType: 'multipart/mixed', parts: [
    { partId: '0', mimeType: 'multipart/alternative', parts: [{ partId: '0.0', mimeType: 'text/plain', body: { data: b64u('hi') } }] },
    { partId: '1', mimeType: 'message/rfc822', parts: [
      { partId: '1.0', mimeType: 'multipart/mixed', parts: [
        { partId: '1.0.0', mimeType: 'multipart/alternative', parts: [
          { partId: '1.0.0.1', mimeType: 'text/calendar; method=REQUEST', body: { data: b64u(deep) } },
        ] },
        { partId: '1.0.1', mimeType: 'application/octet-stream', filename: 'invite.ics', body: { attachmentId: 'ATT1' } },
      ] },
    ] },
  ] };
  const parts = findCalendarParts(payload);
  assert.deepEqual(parts.map((p) => p.partId), ['1.0.0.1', '1.0.1']);
  assert.equal(parts[0].text, deep);
  assert.equal(parts[1].attachmentId, 'ATT1');
  assert.deepEqual(findCalendarParts(undefined), []);
  assert.deepEqual(findCalendarParts({ mimeType: 'text/plain', body: { data: b64u('x') } }), []);
});

test('ICS: TZID, Z, DURATION, CANCEL, folded lines, Windows zone names', () => {
  const tzid = parseIcs(ics(['METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Asia/Tokyo:20261113T110000', 'DTEND;TZID=Asia/Tokyo:20261113T120000',
    'SUMMARY:定例ミーティン', ' グ', 'END:VEVENT']));
  assert.equal(tzid.method, 'REQUEST');
  assert.deepEqual(tzid.events.map((e) => [e.kind, e.startUtc, e.endUtc, e.tz, e.summary]),
    [['confirm', '2026-11-13T02:00:00.000Z', '2026-11-13T03:00:00.000Z', TOKYO, '定例ミーティング']]);

  const z = parseIcs(ics(['METHOD:CANCEL', 'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261116T050000Z', 'DURATION:PT1H30M', 'SEQUENCE:2', 'END:VEVENT']));
  assert.deepEqual(z.events.map((e) => [e.kind, e.startUtc, e.endUtc, e.tz]), [['cancel', '2026-11-16T05:00:00.000Z', '2026-11-16T06:30:00.000Z', 'UTC']]);

  const outlook = parseIcs(ics(['METHOD:REQUEST', 'BEGIN:VEVENT', 'DTSTART;TZID="Pacific Standard Time":20261103T150000', 'SEQUENCE:1', 'STATUS:CONFIRMED', 'END:VEVENT']));
  assert.deepEqual(outlook.events.map((e) => [e.kind, e.startUtc, e.endUtc]), [['change', '2026-11-03T23:00:00.000Z', '2026-11-03T23:30:00.000Z']], 'PST after DST ends; no end = 30 min');

  const cancelled = parseIcs(ics(['METHOD:REQUEST', 'BEGIN:VEVENT', 'DTSTART:20261116T050000', 'STATUS:CANCELLED', 'END:VEVENT']), { fallbackTz: TOKYO });
  assert.deepEqual(cancelled.events.map((e) => [e.kind, e.startUtc]), [['cancel', '2026-11-15T20:00:00.000Z']], 'floating time read in the business zone');

  assert.deepEqual(parseIcs('not a calendar').events, []);
});

test('the system prompt has no ritual phrases and the system block is byte-stable across calls', () => {
  const rituals = [/step by step/i, /thorough/i, /carefully/i, /you are an? /i, /expert/i, /important/i, /\bmust\b/i, /\bnever\b/i,
    /\balways\b/i, /make sure/i, /double.?check/i, /take a deep breath/i, /!/, /\*\*/, /\b(?!JSON\b|IANA\b|YYYY\b|DDTHH\b|JST\b|PT\b|ET\b|GMT\b|UTC\b|MTG\b)[A-Z]{3,}\b/];
  for (const r of rituals) assert.ok(!r.test(DATE_SYSTEM_PROMPT), `prompt matches ${r}`);
  const a = buildDateRequest({ text: '来週火曜14時はいかがですか', sentAt: '2026-11-06T01:00:00Z', businessTz: TOKYO, direction: 'theirs' });
  const b = buildDateRequest({ text: 'Monday 3pm PT?', sentAt: '2026-10-29T17:00:00Z', businessTz: 'America/Los_Angeles', direction: 'ours' });
  assert.equal(a.cacheable, DATE_SYSTEM_PROMPT);
  assert.equal(Buffer.compare(Buffer.from(a.cacheable), Buffer.from(b.cacheable)), 0);
  assert.equal(a.operation, 'dates');
  assert.match(a.variable, /^Sent: 2026-11-06 10:00 \(Fri \/ 金\)\nBusiness time zone: Asia\/Tokyo\nWritten by: them\nEmail:\n来週火曜14時/);
  assert.match(b.variable, /Sent: 2026-10-29 10:00 \(Thu/);
  assert.throws(() => buildDateRequest({ text: 'x', sentAt: '2026-11-06T01:00:00Z', businessTz: 'Mars/Base', direction: 'ours' }));
});

test('result parser rejects malformed JSON and off-schema entries', () => {
  for (const bad of ['', 'not json', '{"dates":', '{}', '{"dates":{}}', '{"dates":[{"start":"11/9 10:00","kind":"offer"}]}',
    '{"dates":[{"start":"2026-11-09T10:00","kind":"maybe"}]}', '{"dates":[{"start":"2026-11-09T10:00","end":"soon","kind":"offer"}]}',
    '{"dates":[{"start":"2026-11-09T10:00","tz":"Mars/Base","kind":"offer"}]}', '{"dates":[null]}']) {
    assert.throws(() => parseDateResult(bad), undefined, bad);
  }
  assert.deepEqual(parseDateResult('```json\n{"dates":[{"start":"2026-11-09T10:00","end":null,"tz":"PT","kind":"offer","quote":"10am PT"}]}\n```'),
    [{ startLocal: '2026-11-09T10:00', endLocal: null, statedTz: 'America/Los_Angeles', kind: 'offer', quote: '10am PT' }]);
  assert.deepEqual(parseDateResult({ dates: [] }), []);
});

test('timezone: sender-stated zone wins, else the business zone; end defaults to 30 minutes; DST-safe', () => {
  const r = resolveDates([
    { startLocal: '2026-11-10T14:00', endLocal: null, statedTz: null, kind: 'offer', quote: '来週火曜14時' },
    { startLocal: '2026-11-03T15:00', endLocal: null, statedTz: 'America/Los_Angeles', kind: 'change', quote: '3pm PT' },
    { startLocal: '2026-10-27T15:00', endLocal: '2026-10-27T16:00', statedTz: 'America/Los_Angeles', kind: 'offer', quote: '3-4pm PT' },
  ], { businessTz: TOKYO, direction: 'theirs' });
  assert.deepEqual(r.map((d) => [d.startUtc, d.endUtc, d.tz, d.tzSource]), [
    ['2026-11-10T05:00:00.000Z', '2026-11-10T05:30:00.000Z', TOKYO, 'business'],
    ['2026-11-03T23:00:00.000Z', '2026-11-03T23:30:00.000Z', 'America/Los_Angeles', 'stated'], // PST, after DST ended 11/1
    ['2026-10-27T22:00:00.000Z', '2026-10-27T23:00:00.000Z', 'America/Los_Angeles', 'stated'], // PDT
  ]);
  assert.equal(localToUtc('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z', 'just after the spring-forward gap');
  assert.equal(normalizeTz('JST'), TOKYO);
  assert.equal(normalizeTz('Tokyo Standard Time'), TOKYO);
  assert.equal(normalizeTz('nowhere'), null);
});

// The model's answers for the step's named cases, as the prompt asks for them: checks the pipeline
// (request -> parse -> resolve -> grade) end to end without an API call.
const CASES = [
  { text: '来週火曜14時はいかがでしょうか。', sentAt: '2026-11-05T03:00:00Z', direction: 'theirs',
    reply: '{"dates":[{"start":"2026-11-10T14:00","end":null,"tz":null,"kind":"offer","quote":"来週火曜14時"}]}',
    want: [['2026-11-10T05:00:00.000Z', '2026-11-10T05:30:00.000Z', 'offer']] },
  { text: '11/9(月)10:00〜でお願いいたします。', sentAt: '2026-11-06T01:00:00Z', direction: 'ours',
    reply: '{"dates":[{"start":"2026-11-09T10:00","end":null,"tz":null,"kind":"confirm","quote":"11/9(月)10:00〜"}]}',
    want: [['2026-11-09T01:00:00.000Z', '2026-11-09T01:30:00.000Z', 'confirm']] },
  { text: 'Would 3pm PT on Tuesday work?', sentAt: '2026-10-29T17:00:00Z', direction: 'theirs',
    reply: '{"dates":[{"start":"2026-11-03T15:00","end":null,"tz":"America/Los_Angeles","kind":"offer","quote":"3pm PT on Tuesday"}]}',
    want: [['2026-11-03T23:00:00.000Z', '2026-11-03T23:30:00.000Z', 'offer']] },
  { text: 'We could do either Mon or Tue afternoon.', sentAt: '2026-11-06T01:00:00Z', direction: 'ours',
    reply: '{"dates":[{"start":"2026-11-09T13:00","end":"2026-11-09T18:00","tz":null,"kind":"offer","quote":"Mon"},{"start":"2026-11-10T13:00","end":"2026-11-10T18:00","tz":null,"kind":"offer","quote":"Tue afternoon"}]}',
    want: [['2026-11-09T04:00:00.000Z', '2026-11-09T09:00:00.000Z', 'offer'], ['2026-11-10T04:00:00.000Z', '2026-11-10T09:00:00.000Z', 'offer']] },
  { text: '明日のMTGですが、来週月曜の同じ時間（11時）に変更できますか。', sentAt: '2026-11-11T09:00:00Z', direction: 'theirs',
    reply: '{"dates":[{"start":"2026-11-16T11:00","end":null,"tz":null,"kind":"change","quote":"来週月曜の同じ時間（11時）"}]}',
    want: [['2026-11-16T02:00:00.000Z', '2026-11-16T02:30:00.000Z', 'change']] },
  { text: '本日15時からのお打ち合わせはキャンセルさせてください。', sentAt: '2026-11-09T00:15:00Z', direction: 'theirs',
    reply: '{"dates":[{"start":"2026-11-09T15:00","end":null,"tz":null,"kind":"cancel","quote":"本日15時から"}]}',
    want: [['2026-11-09T06:00:00.000Z', '2026-11-09T06:30:00.000Z', 'cancel']] },
];

test('named cases: 来週火曜14時, 11/9(月)10:00〜, 3pm PT, Mon or Tue afternoon, change and cancel wording', async () => {
  for (const c of CASES) {
    assert.equal(hasDateHints(c.text), true, c.text);
    const calls = [];
    const got = await detect({ text: c.text, sentAt: c.sentAt, direction: c.direction }, {
      businessTz: TOKYO, complete: async (req) => { calls.push(req); return { text: c.reply, cost_usd: 0.0001 }; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cacheable, DATE_SYSTEM_PROMPT);
    assert.deepEqual(got.dates.map((d) => [d.startUtc, d.endUtc, d.kind]), c.want, c.text);
    assert.ok(got.dates.every((d) => d.direction === c.direction));
  }
});

test('pipeline: invites and undated mail never reach the model; graders are binary', async () => {
  let calls = 0;
  const complete = async () => { calls++; return { text: '{"dates":[]}' }; };
  const r = await runEval({ split: 'all', complete });
  const modelFree = r.rows.filter((row) => row.got.source === 'invite' || row.got.source === 'none');
  assert.ok(modelFree.length >= 4);
  assert.equal(calls, r.rows.length - modelFree.length);
  for (const row of r.rows) for (const c of row.checks) assert.equal(typeof c.pass, 'boolean');
  for (const row of r.rows.filter((x) => x.got.source === 'invite')) assert.ok(row.checks.every((c) => c.pass), `${row.thread} invite`);

  const msg = { direction: 'ours', text: '資料をお送りします', expect: { hint: false, dates: [] } };
  assert.deepEqual(grade(msg, { hint: false, source: 'none', dates: [] }).map((c) => c.pass), [true, true, true]);
  assert.equal(grade(msg, { hint: true, source: 'ai', dates: [{ startUtc: 'x' }] }).filter((c) => !c.pass).length, 3);
});

test('deterministic eval run with no model passes every check it can make', async () => {
  const r = await runEval({ split: 'all' });
  assert.equal(r.aiCalls, 0);
  assert.equal(r.passed, r.checks);
});

// ---- preview deadlines (D54, D55, D57) ----------------------------------------------------------

test('preview pre-filter: JA and EN interest words get in, plain mail stays out', () => {
  for (const s of ['プレビューを見てみたいです', 'サンプルサイトをお願いします', '試作を拝見したいです', 'イメージだけでも見せていただけますか',
    "We'd love to see a sample site", 'Could you make a quick mock-up?', 'happy to look at a demo', 'Please send the preview']) {
    assert.equal(hasPreviewHints(s), true, s);
  }
  for (const s of ['資料ありがとうございました。社内で検討いたします。', 'お見積書を添付いたします。', 'Thanks for the files, looks great.', 'Examples of pricing']) {
    assert.equal(hasPreviewHints(s), false, s);
  }
});

test('preview field: parsed leniently, absent or wanted:false is none, a bad due is read as none', () => {
  assert.equal(parsePreviewResult('{"dates":[]}'), null);
  assert.equal(parsePreviewResult({ dates: [], preview: { wanted: false } }), null);
  assert.deepEqual(parsePreviewResult('{"dates":[],"preview":{"due":"2026-11-20","quote":"サンプル"}}'), { due: '2026-11-20', quote: 'サンプル' });
  assert.deepEqual(parsePreviewResult({ dates: [], preview: { due: 'Friday' } }), { due: null, quote: '' });
  assert.deepEqual(parsePreviewResult({ dates: [], preview: { due: null } }), { due: null, quote: '' });
});

test('D55 due date: named date, else 3 calendar days after the sent date in the business zone', () => {
  // Fri 2026-11-06 23:30 JST = 14:30Z: the business day is the 6th, so the rule date is Mon 9th (calendar days).
  assert.deepEqual(previewDueDate(null, { sentAt: '2026-11-06T14:30:00Z', businessTz: TOKYO }), { due: '2026-11-09', source: 'rule' });
  // 2026-11-06 16:00Z is already Sat 7th in Tokyo.
  assert.deepEqual(previewDueDate({ due: null }, { sentAt: '2026-11-06T16:00:00Z', businessTz: TOKYO }), { due: '2026-11-10', source: 'rule' });
  assert.deepEqual(previewDueDate({ due: '2026-11-20' }, { sentAt: '2026-11-10T03:00:00Z', businessTz: TOKYO }), { due: '2026-11-20', source: 'mail_date' });
  assert.deepEqual(previewDueDate({ due: '2026-11-01' }, { sentAt: '2026-11-10T03:00:00Z', businessTz: TOKYO }), { due: '2026-11-13', source: 'rule' }, 'a past date is a slip');
  assert.deepEqual(previewDueDate(null, { sentAt: '2026-12-30T03:00:00Z', businessTz: TOKYO }), { due: '2027-01-02', source: 'rule' }, 'across a year');
});

test('preview link: only https://example.com/<something>-preview/... counts', () => {
  for (const s of ['こちらです https://example.com/kikuna-preview/ よろしくお願いします', 'https://example.com/acme-site-preview/?feedback=1',
    '(https://www.example.com/wagou-preview/index.html)', 'https://example.com/anocado-preview']) assert.equal(hasPreviewLink(s), true, s);
  for (const s of ['https://example.com/', 'https://example.com/preview/', 'https://evil.example/kikuna-preview/', 'https://example.com.example.com/x-preview/', 'example.com/x-preview/']) {
    assert.equal(hasPreviewLink(s), false, s);
  }
});

test('the date call answers the preview question too: one model call, the due date resolved', async () => {
  const calls = [];
  const got = await detect({ direction: 'theirs', sentAt: '2026-11-06T01:00:00Z', text: 'プレビューを見てみたいです。あわせて来週火曜14時に打ち合わせできますか。' }, {
    businessTz: TOKYO,
    complete: async (req) => { calls.push(req); return { text: '{"dates":[{"start":"2026-11-10T14:00","end":null,"tz":null,"kind":"offer","quote":"来週火曜14時"}],"preview":{"due":null,"quote":"プレビューを見てみたい"}}' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'dates');
  assert.match(DATE_SYSTEM_PROMPT, /"preview"/);
  assert.equal(got.dates.length, 1);
  assert.deepEqual(got.preview, { due: '2026-11-09', source: 'rule' });
  // A preview request without any date words still reaches the model; our own mail never sets a preview.
  const noDate = await detect({ direction: 'theirs', sentAt: '2026-11-06T01:00:00Z', text: 'サンプルサイトをお願いします' }, { businessTz: TOKYO, complete: async () => ({ text: '{"dates":[],"preview":{"due":null}}' }) });
  assert.equal(noDate.source, 'ai'); assert.ok(noDate.preview);
  const ours = await detect({ direction: 'ours', sentAt: '2026-11-06T01:00:00Z', text: 'サンプルを来週火曜にお送りします' }, { businessTz: TOKYO, complete: async () => ({ text: '{"dates":[],"preview":{"due":null}}' }) });
  assert.equal(ours.preview, null);
});

test('preview fixtures: both splits have a yes and a no, graded with binary checks', async () => {
  for (const split of ['train', 'test']) {
    const msgs = loadSplit(split).flatMap((t) => t.messages).filter((m) => m.expect.preview);
    assert.ok(msgs.some((m) => m.expect.preview.wanted) && msgs.some((m) => !m.expect.preview.wanted), split);
  }
  const want = { direction: 'theirs', expect: { dates: [], preview: { wanted: true, due: '2026-11-09', source: 'rule' } } };
  assert.deepEqual(grade(want, { hint: false, previewHint: true, source: 'ai', dates: [], preview: { due: '2026-11-09', source: 'rule' } }).map((c) => c.pass), [true, true, true, true, true]);
  assert.equal(grade(want, { hint: false, previewHint: true, source: 'ai', dates: [], preview: null }).filter((c) => !c.pass).length, 1);
  assert.equal(grade(want, { hint: false, previewHint: true, source: 'ai', dates: [], preview: { due: '2026-11-10', source: 'mail_date' } }).filter((c) => !c.pass).length, 2);
});
