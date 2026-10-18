'use strict';
// State fields that used to live only in each browser, now synced through /api/state:
//   expenses   old-style expense entries   -> vos_old_expenses (one row per entry, tombstone on delete)
//   audit      audit log                   -> vos_audit (append-only, deduplicated)
//   vgPricing  Vangarde price list         -> app_meta 'vgPricing' (higher version wins, else server copy stays)
//   salesHist  12-month sales history      -> app_meta 'salesHist' (first copy saved stays)
// These are MERGED, never replaced: a PUT can add or tombstone rows but never deletes them,
// so a stale device (or the old production app, which does not know these tables or keys)
// cannot wipe them.

const EXTRAS_SQL = `
CREATE TABLE IF NOT EXISTS vos_old_expenses (
  id TEXT PRIMARY KEY, data JSONB NOT NULL, deleted BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vos_audit (
  k TEXT PRIMARY KEY, ts TIMESTAMPTZ, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vos_audit_ts ON vos_audit(ts);
`;

const AUDIT_DAYS = 60, AUDIT_MAX = 600;   // same window the app keeps

// The same two helpers exist in public/index.html (extrasFp / extrasDupId / auditKey); keep them identical.
function expFp(e) {
  return [e.createdAt || '', e.createdBy || '', e.date || '', e.amount == null ? '' : e.amount, e.by || '', e.note || ''].join('|');
}
function expDupId(e) {
  let h = 5381;
  const s = expFp(e);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return e.id + '~' + h.toString(36);
}
function auditKey(a) { return [a.ts || '', a.uid || '', a.action || '', a.detail || ''].join('|'); }

async function readExtras(client) {
  const out = {};
  const ex = (await client.query(
    `SELECT id, data, deleted FROM vos_old_expenses ORDER BY data->>'createdAt', id`)).rows;
  out.expenses = ex.filter(r => !r.deleted).map(r => r.data);
  out.expDeleted = ex.filter(r => r.deleted).map(r => r.id);
  out.audit = (await client.query(
    `SELECT data FROM (SELECT data, ts FROM vos_audit WHERE ts >= now() - interval '${AUDIT_DAYS} days'
       ORDER BY ts DESC LIMIT ${AUDIT_MAX}) x ORDER BY ts`)).rows.map(r => r.data);
  const mm = (await client.query(`SELECT key, data FROM app_meta WHERE key IN ('vgPricing', 'salesHist')`)).rows;
  mm.forEach(r => { out[r.key] = r.data; });
  return out;
}

async function saveExtras(client, state) {
  // tombstones first, so an entry deleted on one device is never brought back by another
  const del = (Array.isArray(state.expDeleted) ? state.expDeleted : []).filter(id => typeof id === 'string' && id);
  if (del.length) {
    await client.query(
      `INSERT INTO vos_old_expenses (id, data, deleted) SELECT id, '{}'::jsonb, true FROM unnest($1::text[]) id
       ON CONFLICT (id) DO UPDATE SET deleted = true, updated_at = now()`, [del]);
  }

  const exps = (Array.isArray(state.expenses) ? state.expenses : []).filter(e => e && typeof e === 'object' && e.id);
  if (exps.length) {
    const have = {};
    (await client.query('SELECT id, data, deleted FROM vos_old_expenses WHERE id = ANY($1::text[])',
      [exps.map(e => String(e.id))])).rows.forEach(r => { have[r.id] = r; });
    const rows = [];
    for (const e of exps) {
      const cur = have[e.id];
      if (!cur) { rows.push(e); continue; }
      if (cur.deleted) continue;                                  // deleted elsewhere: stays deleted
      if (expFp(cur.data) === expFp(e)) continue;                 // already stored
      rows.push(Object.assign({}, e, { id: expDupId(e) }));       // same number, different entry (two devices offline): keep both
    }
    if (rows.length) {
      await client.query(
        `INSERT INTO vos_old_expenses (id, data) SELECT e->>'id', e FROM jsonb_array_elements($1::jsonb) e
         ON CONFLICT (id) DO NOTHING`, [JSON.stringify(rows)]);
    }
  }

  const audit = (Array.isArray(state.audit) ? state.audit : []).filter(a => a && a.ts && !isNaN(Date.parse(a.ts)));
  if (audit.length) {
    await client.query(
      `INSERT INTO vos_audit (k, ts, data) SELECT md5(x->>'k'), (x->>'ts')::timestamptz, x->'d'
       FROM jsonb_array_elements($1::jsonb) x ON CONFLICT (k) DO NOTHING`,
      [JSON.stringify(audit.map(a => ({ k: auditKey(a), ts: a.ts, d: a })))]);
  }

  const vg = state.vgPricing;
  if (vg && typeof vg === 'object' && typeof vg.v === 'number') {
    await client.query(
      `INSERT INTO app_meta (key, data, updated_at) VALUES ('vgPricing', $1, now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       WHERE COALESCE((app_meta.data->>'v')::numeric, 0) < (EXCLUDED.data->>'v')::numeric`, [JSON.stringify(vg)]);
  }
  const sh = state.salesHist;
  if (sh && typeof sh === 'object' && !Array.isArray(sh)) {
    await client.query(
      `INSERT INTO app_meta (key, data, updated_at) VALUES ('salesHist', $1, now()) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(sh)]);
  }
}

module.exports = { EXTRAS_SQL, readExtras, saveExtras, expFp, expDupId, auditKey };
