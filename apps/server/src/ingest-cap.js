// apps/server/src/ingest-cap.js — the per-company daily AI spend cap (shared by sorting and drafting).
// The company's own setting (businesses.ai_daily_cap_usd, set in the console later) wins over the
// server default (AI_DAILY_CAP_USD). 0 means no cap.

export function dailyCap(db, businessId, defaultCap = 0.5) {
  const own = db.prepare('SELECT ai_daily_cap_usd AS c FROM businesses WHERE id = ?').get(businessId)?.c;
  return own ?? defaultCap;
}

/** True while this company's AI spend today (UTC) is below its cap. */
export function underDailyCap(db, businessId, defaultCap = 0.5) {
  const cap = dailyCap(db, businessId, defaultCap);
  if (!(cap > 0)) return true;
  const spent = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE business_id = ? AND at >= strftime('%Y-%m-%dT00:00:00Z','now')")
    .get(businessId).s;
  return spent < cap;
}
