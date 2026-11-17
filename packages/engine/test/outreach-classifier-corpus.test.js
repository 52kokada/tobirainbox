// Corpus test for the outreach reply classifier (shared with an optional external CRM backend).
// source: external CRM backend, hash-pinned by test/outreach-classifier-sync.test.js sha256:039932aee4ef0fd57898e740aa7b4502c13e0fa2284c2db93eda9654f3ec4bad
// END SYNC HEADER
// Pins the reply classifier over a corpus of real-shaped replies (English and
// Japanese, opt-outs first).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { classifyReply, stripQuotedContent } from '../src/outreach-classifier.js';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/classifier-corpus.json', import.meta.url), 'utf8'));

function fakeAi(text) {
  return { calls: [], async complete(args) { this.calls.push(args); return { text }; } };
}

test('corpus covers opt-outs in both languages', () => {
  const optouts = corpus.filter((c) => c.label === 'optout');
  assert.ok(optouts.some((c) => c.lang === 'ja') && optouts.some((c) => c.lang === 'en'));
});

for (const c of corpus) {
  test(`corpus ${c.id}: quote stripping is pinned`, () => {
    assert.equal(stripQuotedContent(c.body), c.stripped);
  });

  test(`corpus ${c.id}: prompt carries the prospect's own text and the OPTOUT rule; ${c.label.toUpperCase()} maps to ${c.label}`, async () => {
    const ai = fakeAi(c.label.toUpperCase());
    const res = await classifyReply({ body: c.body, ai, tenantId: 't' });
    assert.deepEqual(res, { verdict: c.label, uncertain: c.label === 'unclear' });
    const { prompt, operation, model, maxTokens } = ai.calls[0];
    assert.equal(operation, 'reply_classify');
    assert.equal(model, 'claude-sonnet-5-5');
    assert.equal(maxTokens, 8);
    assert.ok(prompt.includes(`--- PROSPECT REPLY ---\n${c.stripped}\n`));
    assert.match(prompt, /OPTOUT {4}— asks us to stop sending email/);
    assert.match(prompt, /An unsubscribe notice that is only part of OUR original email footer does not count\./);
  });
}

// What the model may answer, and what the parser makes of it. Opt-out must win
// whenever the word appears, because it is checked first.
const OUTPUTS = [
  ['OPTOUT', 'optout', false],
  ['optout', 'optout', false],
  [' OPTOUT\n', 'optout', false],
  ['OPTOUT.', 'optout', false],
  ['Label: OPTOUT', 'optout', false],
  ['NEGATIVE OPTOUT', 'optout', false],
  ['OPTOUT NEGATIVE', 'optout', false],
  ['NEGATIVE', 'negative', false],
  ['POSITIVE', 'positive', false],
  ['OOB', 'oob', false],
  ['AUTO', 'auto', false],
  ['UNCLEAR', 'unclear', true],
  ['OPT-OUT', 'unclear', true],
  ['OPT OUT', 'unclear', true],
  ['', 'unclear', true],
  ['配信停止', 'unclear', true],
];
for (const [text, verdict, uncertain] of OUTPUTS) {
  test(`model output ${JSON.stringify(text)} -> ${verdict}`, async () => {
    assert.deepEqual(await classifyReply({ body: 'x', ai: fakeAi(text), tenantId: 't' }), { verdict, uncertain });
  });
}

test('long replies are cut to 1500 characters after stripping', async () => {
  const ai = fakeAi('NEGATIVE');
  await classifyReply({ body: `${'あ'.repeat(1600)}\n> quoted`, ai, tenantId: 't' });
  assert.ok(ai.calls[0].prompt.includes(`\n${'あ'.repeat(1500)}\n---`));
  assert.ok(!ai.calls[0].prompt.includes('あ'.repeat(1501)));
});

// Text rules over the model's label (2026-11-08). The two real misreads must be
// corrected whatever the model says, and every corpus row must survive the
// rules unchanged when the model gets it right.
import { applyTextRules } from '../src/outreach-classifier.js';

const byId = Object.fromEntries(corpus.map((c) => [c.id, c]));

test('a redirect to another person the model calls OPTOUT becomes positive, flagged uncertain', async () => {
  const res = await classifyReply({ body: byId['ja-positive-redirect-to-manager'].body, ai: fakeAi('OPTOUT'), tenantId: 't' });
  assert.deepEqual(res, { verdict: 'positive', uncertain: true });
});

for (const label of ['UNCLEAR', 'NEGATIVE']) {
  test(`an explicit stop request with a reason the model calls ${label} becomes optout`, async () => {
    const res = await classifyReply({ body: byId['ja-optout-with-reason'].body, ai: fakeAi(label), tenantId: 't' });
    assert.deepEqual(res, { verdict: 'optout', uncertain: true });
  });
}

test('the text rules never change a correct corpus label', () => {
  for (const c of corpus) {
    assert.deepEqual(applyTextRules(c.label, c.body), { verdict: c.label, overridden: false }, c.id);
  }
});

test('a stop request that also gives an address stays optout', () => {
  assert.equal(applyTextRules('optout', '今後の連絡を希望しません。下記宛にも送らないでください。').verdict, 'optout');
});

test('the prompt states both rules', async () => {
  const ai = fakeAi('POSITIVE');
  await classifyReply({ body: 'x', ai, tenantId: 't' });
  assert.ok(ai.calls[0].prompt.includes('今後の連絡を希望しません'));
  assert.ok(ai.calls[0].prompt.includes('今後は下記私宛に返答してください'));
});
