'use strict';
// Neon serverless Postgres client + schema + state <-> tables mapping.
// Uses the @neondatabase/serverless Pool (WebSocket) so the same pg-style
// transaction code works inside Vercel serverless functions.
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ---- idempotent schema (runs once per cold start; safe to re-run) ---- */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, cust_code TEXT, name TEXT, brand TEXT, stage TEXT,
  source TEXT, assigned_to TEXT, created TEXT, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_brand ON leads(brand);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE TABLE IF NOT EXISTS surveys (id TEXT PRIMARY KEY, lead_id TEXT, date TEXT, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_surveys_lead ON surveys(lead_id);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, lead_id TEXT, survey_id TEXT, status TEXT, date TEXT,
  account_id TEXT, discount NUMERIC, adjust NUMERIC, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_quotes_lead ON quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE TABLE IF NOT EXISTS fabric_orders (id TEXT PRIMARY KEY, quote_id TEXT, status TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS sewing (id TEXT PRIMARY KEY, quote_id TEXT, status TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS china_lots (id TEXT PRIMARY KEY, status TEXT, closed BOOLEAN, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY, quote_id TEXT, lead_id TEXT, status TEXT, scheduled TEXT, team TEXT, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_installs_status ON installs(status);
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, lead_id TEXT, quote_id TEXT, type TEXT, status TEXT, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, name TEXT, nick TEXT, pos TEXT, dept TEXT, salary NUMERIC, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, label TEXT, vat BOOLEAN, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS travel_claims (
  id TEXT PRIMARY KEY, emp_id TEXT, lead_id TEXT, quote_id TEXT, cust_code TEXT,
  amount NUMERIC, date TEXT, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_travel_lead ON travel_claims(lead_id);
CREATE INDEX IF NOT EXISTS idx_travel_emp ON travel_claims(emp_id);
CREATE TABLE IF NOT EXISTS attendance (ord INT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS advances   (ord INT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS monthly    (ord INT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS payments (quote_id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS payroll  (k TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
`;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) schemaReady = pool.query(SCHEMA_SQL).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---- state <-> tables mapping (same as the Docker server) ---- */
const ID_TABLES = [
  { key: 'leads',        table: 'leads',         cols: { cust_code: r => r.custCode, name: r => r.name, brand: r => r.brand, stage: r => r.stage, source: r => r.source, assigned_to: r => r.assignedTo, created: r => r.created } },
  { key: 'surveys',      table: 'surveys',       cols: { lead_id: r => r.leadId, date: r => r.date } },
  { key: 'quotes',       table: 'quotes',        cols: { lead_id: r => r.leadId, survey_id: r => r.surveyId, status: r => r.status, date: r => r.date, account_id: r => r.accountId, discount: r => r.discount, adjust: r => r.adjust } },
  { key: 'fabricOrders', table: 'fabric_orders', cols: { quote_id: r => r.quoteId, status: r => r.status } },
  { key: 'sewing',       table: 'sewing',        cols: { quote_id: r => r.quoteId, status: r => r.status } },
  { key: 'chinaLots',    table: 'china_lots',    cols: { status: r => r.status, closed: r => !!r.closed } },
  { key: 'installs',     table: 'installs',      cols: { quote_id: r => r.quoteId, lead_id: r => r.leadId, status: r => r.status, scheduled: r => r.scheduled, team: r => r.team } },
  { key: 'tickets',      table: 'tickets',       cols: { lead_id: r => r.leadId, quote_id: r => r.quoteId, type: r => r.type, status: r => r.status } },
  { key: 'employees',    table: 'employees',     cols: { name: r => r.name, nick: r => r.nick, pos: r => r.pos, dept: r => r.dept, salary: r => r.salary } },
  { key: 'accounts',     table: 'accounts',      cols: { label: r => r.label, vat: r => !!r.vat } },
  { key: 'travelClaims', table: 'travel_claims', cols: { emp_id: r => r.empId, lead_id: r => r.leadId, quote_id: r => r.quoteId, cust_code: r => r.custCode, amount: r => r.amount, date: r => r.date } },
];
const LIST_TABLES = [
  { key: 'attendance', table: 'attendance' },
  { key: 'advances',   table: 'advances' },
  { key: 'monthly',    table: 'monthly' },
];
const META_KEYS = ['prices', 'seq', 'company'];

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (v === '') return null;
  return v;
}

async function composeState(client) {
  const state = {};
  let any = false;
  for (const t of ID_TABLES) {
    const { rows } = await client.query(`SELECT data FROM ${t.table} ORDER BY id`);
    state[t.key] = rows.map(r => r.data);
    if (rows.length) any = true;
  }
  for (const t of LIST_TABLES) {
    const { rows } = await client.query(`SELECT data FROM ${t.table} ORDER BY ord`);
    state[t.key] = rows.map(r => r.data);
    if (rows.length) any = true;
  }
  const pay = {};
  (await client.query('SELECT quote_id, data FROM payments')).rows.forEach(r => { pay[r.quote_id] = r.data; });
  state.payments = pay; if (Object.keys(pay).length) any = true;

  const prl = {};
  (await client.query('SELECT k, data FROM payroll')).rows.forEach(r => { prl[r.k] = r.data; });
  state.payroll = prl; if (Object.keys(prl).length) any = true;

  const mm = {};
  (await client.query('SELECT key, data FROM app_meta')).rows.forEach(r => { mm[r.key] = r.data; });
  for (const k of META_KEYS) if (mm[k] !== undefined) { state[k] = mm[k]; any = true; }

  return any ? state : null;
}

async function saveState(client, state) {
  for (const t of ID_TABLES) {
    await client.query(`DELETE FROM ${t.table}`);
    const arr = Array.isArray(state[t.key]) ? state[t.key] : [];
    const colNames = Object.keys(t.cols);
    let idx = 0;
    for (const row of arr) {
      const obj = row || {};
      const id = (obj.id != null && obj.id !== '') ? obj.id : `${t.key}#${idx}`;
      idx++;
      const values = [id, ...colNames.map(c => norm(t.cols[c](obj))), JSON.stringify(obj)];
      const ph = values.map((_, i) => '$' + (i + 1)).join(', ');
      await client.query(`INSERT INTO ${t.table} (id, ${colNames.join(', ')}, data) VALUES (${ph})`, values);
    }
  }
  for (const t of LIST_TABLES) {
    await client.query(`DELETE FROM ${t.table}`);
    const arr = Array.isArray(state[t.key]) ? state[t.key] : [];
    for (let i = 0; i < arr.length; i++) {
      await client.query(`INSERT INTO ${t.table} (ord, data) VALUES ($1, $2)`, [i, JSON.stringify(arr[i])]);
    }
  }
  await client.query('DELETE FROM payments');
  const pay = state.payments || {};
  for (const qid of Object.keys(pay)) {
    await client.query('INSERT INTO payments (quote_id, data) VALUES ($1, $2)', [qid, JSON.stringify(pay[qid])]);
  }
  await client.query('DELETE FROM payroll');
  const prl = state.payroll || {};
  for (const k of Object.keys(prl)) {
    await client.query('INSERT INTO payroll (k, data) VALUES ($1, $2)', [k, JSON.stringify(prl[k])]);
  }
  for (const k of META_KEYS) {
    if (state[k] !== undefined) {
      await client.query(
        `INSERT INTO app_meta (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [k, JSON.stringify(state[k])]
      );
    }
  }
}

module.exports = { pool, ensureSchema, composeState, saveState };
