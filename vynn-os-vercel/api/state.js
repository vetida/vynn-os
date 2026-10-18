'use strict';
// Vercel serverless function: GET /api/state  and  PUT /api/state
const { pool, ensureSchema, composeState, saveState } = require('../lib/db');

module.exports = async (req, res) => {
  // HOTFIX: this old version has no server-side login, so anyone on the internet
  // could read or overwrite all company data here. Closed until the
  // vangarde-launcher version (which requires a login session) is merged.
  // The page is offline-first and keeps working from each device's local cache.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(403).json({ error: 'disabled: login required (upgrade pending)' });
  // eslint-disable-next-line no-unreachable
  try {
    await ensureSchema();

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
