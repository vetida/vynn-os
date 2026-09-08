'use strict';
// Vercel serverless function: GET /api/health  (checks DB connectivity)
const { pool, ensureSchema } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    await ensureSchema();
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('/api/health', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
