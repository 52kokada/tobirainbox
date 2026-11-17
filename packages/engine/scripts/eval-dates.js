#!/usr/bin/env node
// packages/engine/scripts/eval-dates.js — date detection eval (calendar plan §5, D42, D48).
//
//   npm run eval:dates -- --split=test --model=claude-haiku-5-5 --effort=low
//   npm run eval:dates -- --split=all            (no --model or no ANTHROPIC_API_KEY: deterministic parts only)
//
// Fixtures: test/fixtures/dates/{train,test}/<thread>.json, split once by thread. Tune the prompt on train;
// score test only to accept a change. Every check is pass/fail code, no model judge. Prints the pass rate
// and the cost per 100 messages; pick the cheapest model/effort that keeps the test split at >= 95%
// (D48) and 100% on "no date in our own mail makes no hold".
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  hasDateHints, findCalendarParts, parseIcs, buildDateRequest, parseDateResult, resolveDates, localToUtc,
  hasPreviewHints, parsePreviewResult, previewDueDate,
} from '../src/dates.js';
import { stripQuotedContent } from '../src/outreach-classifier.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '..', 'test', 'fixtures', 'dates');
export const QUALITY_BAR = 0.95; // D48

export function loadSplit(split) {
  const splits = split === 'all' ? ['train', 'test'] : [split];
  return splits.flatMap((s) => readdirSync(join(FIXTURES, s)).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ split: s, file: f, ...JSON.parse(readFileSync(join(FIXTURES, s, f), 'utf8')) })));
}

/**
 * The detection pipeline for one message, as ingest will run it: invite parts are parsed directly,
 * mail without hints never reaches the model, the rest goes to `complete` (or is skipped without one).
 * Mail from them that may ask for a preview (D54) also reaches the model; the same call answers both.
 * → { hint, previewHint, source: 'invite'|'ai'|'none'|'skipped', dates: resolved[], preview: {due, source}|null, cost, error? }
 */
export async function detect(msg, { businessTz, complete } = {}) {
  const parts = findCalendarParts(msg.payload);
  const inline = parts.filter((p) => p.text);
  if (inline.length) {
    const events = inline.flatMap((p) => parseIcs(p.text, { fallbackTz: businessTz }).events);
    const seen = new Set();
    const dates = events.filter((e) => !seen.has(`${e.uid}|${e.startUtc}`) && seen.add(`${e.uid}|${e.startUtc}`))
      .map((e) => ({ startUtc: e.startUtc, endUtc: e.endUtc, tz: e.tz, kind: e.kind, direction: msg.direction }));
    return { hint: true, previewHint: false, source: 'invite', dates, preview: null, cost: 0 };
  }
  const text = stripQuotedContent(msg.text ?? '');
  const hint = hasDateHints(text, parts);
  const previewHint = msg.direction === 'theirs' && hasPreviewHints(text);
  if (!hint && !previewHint) return { hint, previewHint, source: 'none', dates: [], preview: null, cost: 0 };
  if (!complete) return { hint, previewHint, source: 'skipped', dates: [], preview: null, cost: 0 };
  const req = buildDateRequest({ text, sentAt: msg.sentAt, businessTz, direction: msg.direction });
  const res = await complete(req);
  try {
    const dates = resolveDates(parseDateResult(res.text), { businessTz, direction: msg.direction });
    const p = msg.direction === 'theirs' ? parsePreviewResult(res.text) : null;
    const preview = p ? previewDueDate(p, { sentAt: msg.sentAt, businessTz }) : null;
    return { hint, previewHint, source: 'ai', dates, preview, cost: res.cost_usd ?? 0, raw: res.text };
  } catch (e) {
    return { hint, previewHint, source: 'ai', dates: [], preview: null, cost: res.cost_usd ?? 0, raw: res.text, error: e.message };
  }
}

/** Binary checks for one message. → [{ name, pass }] ; model-dependent checks are left out when skipped. */
export function grade(msg, got) {
  const exp = msg.expect;
  const want = exp.dates.map((d) => ({ ...d, startUtc: localToUtc(d.start, d.tz), endUtc: localToUtc(d.end, d.tz) }));
  const checks = [];
  if (want.length) checks.push({ name: 'prefilter passes a dated mail', pass: got.hint === true });
  if (exp.hint === false) checks.push({ name: 'prefilter drops an undated mail', pass: got.hint === false });
  if (exp.source) checks.push({ name: 'source', pass: got.source === exp.source });
  // Preview deadlines (D54, D55): only where the fixture says what to expect.
  if (exp.preview?.wanted) checks.push({ name: 'prefilter passes a preview request', pass: got.hint === true || got.previewHint === true });
  if (got.source === 'skipped') return checks;
  if (exp.preview) {
    checks.push({ name: 'preview flagged (yes/no)', pass: Boolean(got.preview) === Boolean(exp.preview.wanted) });
    if (exp.preview.wanted && got.preview) {
      checks.push({ name: 'preview due date', pass: got.preview.due === exp.preview.due });
      checks.push({ name: 'preview due source', pass: got.preview.source === exp.preview.source });
    }
  }
  const g = new Map(got.dates.map((d) => [d.startUtc, d]));
  const startsMatch = want.length === got.dates.length && want.every((w) => g.has(w.startUtc));
  checks.push({ name: 'dates found (every start, no extra)', pass: startsMatch });
  for (const w of want) {
    const d = g.get(w.startUtc);
    if (!d) continue;
    checks.push({ name: 'timezone', pass: d.tz === w.tz });
    checks.push({ name: 'kind', pass: d.kind === w.kind });
    checks.push({ name: 'end (stated, else start + 30 min)', pass: d.endUtc === w.endUtc });
    checks.push({ name: 'direction', pass: d.direction === msg.direction });
  }
  if (msg.direction === 'ours' && !want.length) checks.push({ name: 'no hold from our undated mail', pass: got.dates.length === 0, strict: true });
  return checks;
}

export async function runEval({ split = 'test', complete } = {}) {
  const rows = [];
  for (const t of loadSplit(split)) {
    for (const msg of t.messages) {
      const got = await detect(msg, { businessTz: t.businessTz, complete });
      rows.push({ split: t.split, thread: t.thread, id: msg.id, got, checks: grade(msg, got) });
    }
  }
  const checks = rows.flatMap((r) => r.checks);
  const passed = checks.filter((c) => c.pass).length;
  const strict = checks.filter((c) => c.strict);
  const cost = rows.reduce((s, r) => s + (r.got.cost ?? 0), 0);
  return {
    rows, messages: rows.length, checks: checks.length, passed, passRate: checks.length ? passed / checks.length : 1,
    strictOk: strict.every((c) => c.pass), aiCalls: rows.filter((r) => r.got.source === 'ai').length,
    skipped: rows.filter((r) => r.got.source === 'skipped').length, costPer100: rows.length ? (cost / rows.length) * 100 : 0,
  };
}

/** ai.complete-shaped call on the Anthropic API with an explicit model and effort (eval only). */
async function apiComplete({ model, effort }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { costUsd } = await import(pathToFileURL(join(HERE, '..', '..', '..', 'apps', 'server', 'src', 'ai.js')).href);
  const client = new Anthropic();
  return async ({ cacheable, variable, maxTokens }) => {
    const res = await client.messages.create({
      model, max_tokens: maxTokens,
      system: [{ type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: variable }],
      ...(effort ? { output_config: { effort } } : {}),
    });
    return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), cost_usd: costUsd(model, res.usage) };
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const split = args.split ?? 'test';
  const model = args.model && args.model !== 'none' ? args.model : null;
  let complete = null;
  if (model && !process.env.ANTHROPIC_API_KEY) console.log('ANTHROPIC_API_KEY is not set: running the deterministic parts only.');
  else if (model) complete = await apiComplete({ model, effort: args.effort });
  const r = await runEval({ split, complete });
  for (const row of r.rows) {
    const bad = row.checks.filter((c) => !c.pass);
    if (bad.length || args.verbose) {
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${row.split}/${row.thread}#${row.id} [${row.got.source}] ${bad.map((c) => c.name).join('; ')}`);
      if (bad.length && row.got.raw) console.log(`     model: ${row.got.raw.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (row.got.error) console.log(`     error: ${row.got.error}`);
    }
  }
  console.log(`split=${split} model=${model ?? 'none'} effort=${args.effort ?? 'default'}`);
  console.log(`messages ${r.messages}, model calls ${r.aiCalls}, skipped (no model) ${r.skipped}`);
  console.log(`checks ${r.passed}/${r.checks} = ${(r.passRate * 100).toFixed(1)}% (bar ${QUALITY_BAR * 100}%), no-hold-for-our-undated-mail ${r.strictOk ? 'ok' : 'FAILED'}`);
  if (r.skipped) console.log(`not a model score: ${r.skipped} dated messages had no model, so only pre-filter and invite checks ran`);
  console.log(`cost per 100 messages $${r.costPer100.toFixed(4)}`);
  if (complete && (r.passRate < QUALITY_BAR || !r.strictOk)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
