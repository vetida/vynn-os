'use strict';
// Vercel serverless function: GET /api/state  and  PUT /api/state
const { pool, ensureSchema, composeState, saveState } = require('../lib/db');
const { sessionUser } = require('../lib/vos');

// field Sales (role 'sales') may add leads, but never online-channel ones: those belong to online sales
const ONLINE_SRC = ['line', 'fb', 'ig', 'tiktok'];
async function salesLeadViolation(client, user, leads) {
  if (user.role !== 'sales') return null;
  const r = await client.query('SELECT id, source FROM leads');
  const before = new Map(r.rows.map(x => [x.id, x.source]));
  for (const l of leads) {
    if (!l || !ONLINE_SRC.includes(l.source)) continue;
    if (!before.has(l.id)) return 'sales cannot add online-channel leads';
    if (!ONLINE_SRC.includes(before.get(l.id))) return 'sales cannot move a lead to an online channel';
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    // all company data requires a logged-in VYNN·OS session (cookie set by /api/auth)
    const user = await sessionUser(req);
    if (!user) return res.status(401).json({ error: 'login required' });

    if (req.method === 'GET') {
      const client = await pool.connect();
      try {
        const state = await composeState(client);
        res.status(200).json({ state });
      } finally {
        client.release();
      }
      return;
    }

    if (req.method === 'PUT') {
      let state = req.body && req.body.state;
      // Vercel usually parses JSON, but guard for string bodies just in case
      if (typeof req.body === 'string') {
        try { state = JSON.parse(req.body).state; } catch (e) { /* ignore */ }
      }
      if (!state || typeof state !== 'object' || !Array.isArray(state.leads)) {
        return res.status(400).json({ error: 'invalid state payload' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const bad = await salesLeadViolation(client, user, state.leads);
        if (bad) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: bad });
        }
        await saveState(client, state);
        await client.query('COMMIT');
        res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return;
    }

    res.setHeader('Allow', 'GET, PUT');
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('/api/state', e);
    res.status(500).json({ error: e.message });
  }
};
