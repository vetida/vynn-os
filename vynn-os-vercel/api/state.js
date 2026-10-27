'use strict';
// Vercel serverless function: GET /api/state  and  PUT /api/state
const { pool, ensureSchema, composeState, saveState } = require('../lib/db');
const { sessionUser } = require('../lib/vos');
const { redact, mergeState } = require('../lib/perm');

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
        // each role receives only what it may read (salaries, other sellers' deals)
        const state = redact(await composeState(client), user);
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
        // the server copy + only the changes this role may make (lib/perm.js); the rest is left as it was
        await client.query('LOCK TABLE leads IN EXCLUSIVE MODE');
        const before = await composeState(client);
        const merged = mergeState(before, state, user);
        await saveState(client, merged.state);
        await client.query('COMMIT');
        if (merged.denied.length) console.warn('/api/state denied', user.id, user.role, merged.denied.join(' '));
        res.status(200).json({ ok: true, savedAt: new Date().toISOString(), denied: merged.denied.length });
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
