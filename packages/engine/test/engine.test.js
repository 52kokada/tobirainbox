import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripQuotedContent, classifyOutreachReply, isAutoReply, isBulkMail, stripReplyPrefixes, parseFrom,
  effectiveLabels, labelForOutreachVerdict, sortMessage, parseSort,
  findBlanks, hasBlanks, fillBlank, makeBlank, redact, assertRedacted,
  buildDraftPrompt, enforceGrounding, draftReply, buildReplyMime, toBase64Url,
} from '../src/index.js';

const fakeAi = (text) => ({ calls: [], async complete(req) { this.calls.push(req); return { text, tokens_in: 10, tokens_out: 5 }; } });

test('stripQuotedContent keeps only the new text', () => {
  const body = '見てみたいです。\n\n2026年10月16日(金) 8:33 Kit Y <kit@example.com>:\n> 初めてメールを';
  assert.equal(stripQuotedContent('ありがとうございます\n> quoted\n> more'), 'ありがとうございます');
  assert.ok(stripQuotedContent(body).startsWith('見てみたいです。'));
});

test('outreach classifier keeps cockpit OPTOUT verdict', async () => {
  assert.equal((await classifyOutreachReply({ body: '配信停止してください', ai: fakeAi('OPTOUT'), tenantId: 't' })).verdict, 'optout');
  assert.equal((await classifyOutreachReply({ body: 'x', ai: fakeAi('???'), tenantId: 't' })).uncertain, true);
});

test('deterministic auto-reply and bulk detection', () => {
  assert.equal(isAutoReply({ autoSubmitted: 'auto-replied' }), true);
  assert.equal(isAutoReply({ subject: 'Re: 自動返信：不在のお知らせ' }), true);
  assert.equal(isAutoReply({ subject: 'お問い合わせ', autoSubmitted: 'no' }), false);
  assert.equal(isBulkMail({ listUnsubscribe: '<mailto:x>' }), true);
  assert.equal(stripReplyPrefixes('Re: 返信: 英語ページのご提案'), '英語ページのご提案');
  assert.equal(parseFrom('森田 <Info@Example.JP>'), 'info@example.jp');
});

test('labels: built-ins, overrides, custom, outreach mapping', () => {
  const labels = effectiveLabels([{ key: 'spam', hidden: true }, { key: 'vip', ja: '常連様', autoDraft: true }]);
  assert.equal(labels.find((l) => l.key === 'spam').hidden, true);
  assert.equal(labels.find((l) => l.key === 'vip').custom, true);
  assert.equal(labelForOutreachVerdict('positive'), 'inquiry');
  assert.equal(labelForOutreachVerdict('optout'), 'optout');
  assert.equal(labelForOutreachVerdict('unclear'), 'unconfirmed');
});

test('sorter: rules before model, model output parsed, fallback to other', async () => {
  const labels = effectiveLabels();
  const ai = fakeAi('{"label":"booking","confidence":0.92}');
  assert.deepEqual(await sortMessage({ msg: { autoSubmitted: 'auto-replied' }, labels, ai }), { label: 'auto_reply', confidence: 1, by: 'rule' });
  assert.equal(ai.calls.length, 0);
  const r = await sortMessage({ msg: { body: '11月20日に2名で予約できますか' }, labels, ai });
  assert.equal(r.label, 'booking');
  assert.equal(ai.calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(await sortMessage({ msg: { body: 'x' }, labels, ai: fakeAi('nonsense') }), { label: 'unconfirmed', confidence: 0, by: 'fallback' });
  const low = await sortMessage({ msg: { body: 'x' }, labels, ai: fakeAi('{"label":"booking","confidence":0.4}') });
  assert.deepEqual([low.label, low.by, low.guess], ['unconfirmed', 'low_confidence', 'booking']);
  const ai2 = fakeAi('{"label":"question","confidence":0.9}');
  await sortMessage({ msg: { body: 'x' }, labels, ai: ai2, corrections: [{ fromDomain: 'sample-kitchen.jp', subject: '予約', excerpt: '［氏名］様', label: 'booking' }] });
  assert.match(ai2.calls[0].prompt, /sample-kitchen.jp \/ "予約" .* → booking/);
  assert.equal(parseSort('{"label":"nope"}', new Set(['other'])), null);
});

test('candidate slots block full and partial dates/times without blocking ordinary circles', () => {
  for (const slot of ['〇月〇日', '○月○○日', '10月〇日', '〇月20日', '１０月○日', '〇〇:〇〇', '〇〇：〇〇', '15:〇〇', '○○:30']) {
    assert.equal(hasBlanks(`候補：${slot}`), true, slot);
    assert.equal(fillBlank(slot, slot, '11月20日'), '11月20日');
  }
  assert.equal(hasBlanks('○○様、〇つのご質問。〇日で問題ございません。二〇二六年。11月20日 15:30'), false);
  assert.deepEqual(findBlanks('【要確認：〇月〇日】').map((b) => b.text), ['〇月〇日']);
});

test('blanks: find, fill, block', () => {
  const body = `料金は${makeBlank('2名の料金')}です。\n日程は【要確認：空き状況】`;
  assert.deepEqual(findBlanks(body).map((b) => b.text), ['2名の料金', '空き状況']);
  const filled = fillBlank(fillBlank(body, '2名の料金', '¥24,000'), '空き状況', '11/20 空きあり');
  assert.equal(hasBlanks(filled), false);
  assert.ok(filled.includes('¥24,000'));
});

test('redact removes contact details, assertRedacted refuses leftovers', () => {
  const t = '森田様\n連絡先 info@cooking.example / 090-1234-5678 〒150-0001\n詳細 https://example.com/u/123 と https://cooking.example/class';
  const r = redact(t, { keepHosts: ['cooking.example'] });
  assert.ok(!r.includes('@'));
  assert.ok(!r.includes('090'));
  assert.ok(r.includes('［氏名］様'));
  assert.ok(r.includes('https://cooking.example/class'));
  assert.ok(!r.includes('example.com'));
  assert.equal(assertRedacted(r), true);
  assert.throws(() => assertRedacted('call ０９０−１２３４−５６７８'));
});

test('draft prompt puts playbook before examples and marks thread as evidence', () => {
  const { prompt, stable } = buildDraftPrompt({
    business: { name: 'Acme' }, voice: { fullName: '森田', signature: '--\nTCS' },
    playbook: [{ text: '値段を聞かれたら料金表のURLを送る' }], facts: [{ key: '料金表', value: 'https://acme-shop.example/price' }],
    latest: { body: '料金を教えてください' },
  });
  assert.ok(prompt.indexOf('PLAYBOOK') < prompt.indexOf('EXAMPLES'));
  assert.ok(!stable.includes('料金を教えてください'));
});

test('the prompt asks for the sender\'s name, keeping ご担当者様 for mail with no name', () => {
  const { stable } = buildDraftPrompt({ latest: { body: 'x' } });
  assert.ok(stable.includes('Use ご担当者様 only when no person\'s name is given'));
});

test('received attachments are named in the prompt, so the draft does not ask for them again', () => {
  const { variable } = buildDraftPrompt({ latest: { body: 'お見積りを添付します。', attachments: [{ filename: 'お見積り_テスト.txt' }] } });
  assert.ok(variable.includes('Attachments (received): お見積り_テスト.txt'));
  assert.ok(!buildDraftPrompt({ latest: { body: 'x' } }).variable.includes('Attachments'));
  const earlier = buildDraftPrompt({ latest: { body: 'x' }, thread: [{ at: 't', body: '資料を送ります。', fromUs: true, files: ['ご確認資料.pdf'] }] });
  assert.ok(earlier.variable.includes('(attached: ご確認資料.pdf)'));
});

test('rewrite request goes in the per-message part only, with the current draft', () => {
  const plain = buildDraftPrompt({ latest: { body: 'x' } });
  assert.ok(!plain.prompt.includes('Rewrite request'));
  const { stable, variable } = buildDraftPrompt({ latest: { body: 'x' }, instruction: 'もっと短く', current: '佐藤様\n長い下書き' });
  assert.ok(variable.includes('Request: もっと短く'));
  assert.ok(variable.includes('長い下書き'));
  assert.ok(!stable.includes('もっと短く'));
});

test('grounding: invented price/URL become blanks, grounded ones stay, signature exempt', () => {
  const sig = '━━━━\n山田\nhttps://example.com\n03-1111-2222';
  const body = `料金は¥24,000です。詳しくは https://acme-shop.example/price と https://made.up/x をご覧ください。\n\n${sig}`;
  const { body: out, replaced } = enforceGrounding(body, { grounding: '料金表 https://acme-shop.example/price', signature: sig });
  assert.ok(out.includes('【要確認：金額】'));
  assert.ok(out.includes('https://acme-shop.example/price'));
  assert.ok(!out.includes('made.up'));
  assert.ok(out.endsWith(sig));
  assert.equal(replaced.length, 2);
});

test('draftReply uses Sonnet by default, Opus when escalated, and returns blanks', async () => {
  const ai = fakeAi(JSON.stringify({ body: 'お世話になっております。\n日程は【要確認：11/20の空き】です。', needs: [] }));
  const d = await draftReply({ ai, latest: { body: '11/20空いてますか' }, voice: {} });
  assert.equal(d.model, 'claude-sonnet-5-5');
  assert.deepEqual(d.blanks, ['11/20の空き']);
  const d2 = await draftReply({ ai, latest: { body: 'x' }, voice: {}, escalate: true });
  assert.equal(d2.model, 'claude-opus-5-5');
  await assert.rejects(draftReply({ ai: fakeAi('   '), latest: {}, voice: {} }), /empty/);
});

test('reply MIME: threading headers, encoded subject, html + text, gmail quote', () => {
  const raw = buildReplyMime({
    from: { name: '大野', email: 'leo@example.com' }, to: [{ email: 'info@x.jp' }],
    subject: 'Re: 英語ページ', text: 'ありがとうございます。\n\n大野', quote: { date: '2026年11月4日(水) 10:00', from: '森田 <info@x.jp>', text: '見てみたいです' },
    inReplyTo: '<a@x>', references: '<root@x>', boundary: 'B',
  });
  assert.match(raw, /In-Reply-To: <a@x>/);
  assert.match(raw, /References: <root@x> <a@x>/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /multipart\/alternative; boundary="B"/);
  const html = Buffer.from(raw.split('Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--B--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.ok(html.includes('gmail_quote'));
  assert.ok(html.includes('<div>ありがとうございます。</div><div><br></div>'));
  const plain = buildReplyMime({ from: { email: 'a@b.c' }, to: [{ email: 'd@e.f' }], subject: 'hi', text: 'x', plainText: true });
  assert.match(plain, /Content-Type: text\/plain/);
  assert.ok(!toBase64Url(plain).includes('='));
});

test('reply with attachments: multipart/mixed, body first, Japanese file name kept (RFC 2047 encoded word, which Gmail keeps), base64 wrapped', async () => {
  const { buildReplyMime } = await import('../src/mime.js');
  const data = Buffer.from('%PDF-1.4 hello').toString('base64');
  const raw = buildReplyMime({ from: { name: '森', email: 'mia@example.com' }, to: [{ email: 'a@b.jp' }], subject: 'Re: お見積り', text: '添付いたします。',
    attachments: [{ filename: '御見積書.pdf', mimeType: 'application/pdf', data }] });
  const [head] = raw.split('\r\n\r\n');
  assert.match(head, /Content-Type: multipart\/mixed; boundary="([^"]+)"/);
  const b = head.match(/boundary="([^"]+)"/)[1];
  const parts = raw.split(`--${b}`);
  assert.match(parts[1], /multipart\/alternative/);
  assert.ok(parts[2].includes(`filename="=?UTF-8?B?${Buffer.from('御見積書.pdf').toString('base64')}?="`));
  assert.match(parts[2], /Content-Type: application\/pdf/);
  assert.ok(parts[2].includes(data));
  assert.ok(raw.trimEnd().endsWith(`--${b}--`));
});

test('mime: Date header and quote line are in Japan time (+0900), whatever the server time zone', async () => {
  const { rfcDateJst, jaDateJst } = await import('../src/mime.js');
  assert.equal(rfcDateJst(new Date('2026-11-05T20:30:05Z')), 'Fri, 06 Nov 2026 05:30:05 +0900');
  assert.equal(jaDateJst('2026-11-05T20:30:05Z'), '2026年11月6日(金) 5:30');
  assert.equal(jaDateJst('not a date'), 'not a date');
  const raw = buildReplyMime({ from: { email: 'mia@example.com' }, to: [{ email: 'a@b.jp' }], subject: 'x', text: 'y', date: new Date('2026-11-05T20:30:05Z') });
  assert.match(raw, /^Date: Fri, 06 Nov 2026 05:30:05 \+0900\r\n/);
  assert.doesNotMatch(raw, /-0800/);
});
