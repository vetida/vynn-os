'use strict';
// Vercel serverless function: GET /api/state  and  PUT /api/state
const { pool, ensureSchema, composeState, saveState, readExtras } = require('../lib/db');
const { sessionUser } = require('../lib/vos');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    // all company data requires a logged-in VYNN·OS session (cookie set by /api/auth)
    if (!(await sessionUser(req))) return res.status(401).json({ error: 'login required' });

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
        const extras = await readExtras(client);   // merged result, so this device sees other devices' entries
        await client.query('COMMIT');
        res.status(200).json({ ok: true, savedAt: new Date().toISOString(), extras });
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
