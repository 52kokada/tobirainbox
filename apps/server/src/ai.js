// apps/server/src/ai.js — the engine's `ai.complete(...)` bound to the Claude API
// (plan §2.3: API key only, never the Claude subscription). Logs real cost per
// business into ai_usage.
import Anthropic from '@anthropic-ai/sdk';

// USD per 1M tokens (claude-api skill table, cached 2026-10-06). cacheWrite = 1.25x input.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00, cacheRead: 0.20 },
  'claude-opus-5-5': { input: 4.00, output: 20.00, cacheRead: 0.20 },
};

export function costUsd(model, usage = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  const m = 1e6;
  return ((usage.input_tokens ?? 0) * p.input
    + (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead
    + (usage.output_tokens ?? 0) * p.output) / m;
}

// Low effort for these: sorting is a short classification; drafts at default effort cost ~$0.04 each in the
// first live run; date detection (calendar §5) reads one short mail. A caller may pass `effort` to override
// (the date model/effort is picked by eval:dates on cost at fixed quality, D42).
export const EFFORT = { sort: 'low', draft: 'low', dates: 'low' };

export const PRICE_VERSION = 'claude-api-2026-10-06';

/** Write one billed call to ai_usage. Every response is recorded, including refusals. */
export function recordUsage(db, { meter = {}, operation, model, usage = {}, cost, requestId, outcome }) {
  if (!db || !meter.businessId) return;
  db.prepare(`INSERT INTO ai_usage (business_id, mailbox_id, thread_id, operation, model, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cost_usd, request_id, price_version, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    meter.businessId, meter.mailboxId ?? null, meter.threadId ?? null, operation, model,
    usage.input_tokens ?? 0, usage.output_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0,
    cost, requestId ?? null, PRICE_VERSION, outcome);
}

/**
 * @param {{apiKey?:string, client?:object, db?:object, onUsage?:(u:object)=>void}} opts
 *   db: when given, every call with a `meter` ({businessId, mailboxId?, threadId?}) is recorded in ai_usage here,
 *   so callers never have to (and cannot forget to) log spend.
 */
export function createAi({ apiKey = process.env.ANTHROPIC_API_KEY, client, db, onUsage } = {}) {
  const anthropic = client ?? new Anthropic({ apiKey });
  return {
    async complete({ operation, prompt, cacheable, variable, model, effort, maxTokens = 2000, meter, onText }) {
      // Stable part (voice, playbook, facts, examples) goes in a cached system
      // block; the per-message part is the user turn.
      const system = cacheable
        ? [{ type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } }]
        : undefined;
      const userText = cacheable ? variable : prompt;
      const params = {
        model,
        max_tokens: Math.max(maxTokens, 256),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: userText }],
        ...((effort ?? EFFORT[operation]) ? { output_config: { effort: effort ?? EFFORT[operation] } } : {}),
      };
      // Sonnet/Opus: server-side fallback on a refusal. Haiku has none.
      const useFallback = model !== 'claude-haiku-5-5';
      // onText: stream the reply as it is written (console shows it live); same final message either way.
      let res;
      if (onText) {
        const s = useFallback
          ? anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : anthropic.messages.stream(params);
        s.on('text', (d) => { try { onText(d); } catch { /* a closed browser must not break the draft */ } });
        res = await s.finalMessage();
      } else {
        res = useFallback
          ? await anthropic.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await anthropic.messages.create(params);
      }
      const usage = res.usage ?? {};
      const billedModel = PRICES[res.model] ? res.model : model; // a fallback may have answered on another model
      const cost = costUsd(billedModel, usage);
      const refused = res.stop_reason === 'refusal';
      recordUsage(db, { meter, operation, model: billedModel, usage, cost, requestId: res.id, outcome: refused ? 'refused' : 'ok' });
      if (refused) throw new Error(`model refused (${res.stop_details?.category ?? 'unknown'})`);
      const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const out = {
        text,
        model: billedModel,
        tokens_in: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        tokens_out: usage.output_tokens ?? 0,
        cost_usd: cost,
        metered: Boolean(db && meter?.businessId),
      };
      onUsage?.({ operation, ...out });
      return out;
    },
  };
}
