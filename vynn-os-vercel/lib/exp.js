'use strict';
// Expense-claim module (VYNN | VANGARDE เบิกจ่าย): own tables, own login.
// Every read is scoped on the server: staff only ever receive their own claims,
// files and profile; owner / admin / finance receive everything.
const crypto = require('crypto');
const { pool } = require('./db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exp_users (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', dept TEXT, pin_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true, lang TEXT,
  bank TEXT, acct_no TEXT, acct_name TEXT, promptpay TEXT,
  fail_count INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS exp_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_exp_sessions_user ON exp_sessions(user_id);
CREATE TABLE IF NOT EXISTS exp_claims (
  id TEXT PRIMARY KEY, doc_no TEXT NOT NULL, user_id TEXT NOT NULL, brand TEXT,
  status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_exp_claims_user ON exp_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_exp_claims_status ON exp_claims(status);
CREATE TABLE IF NOT EXISTS exp_files (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT, mime TEXT NOT NULL,
  size INT NOT NULL, bytes BYTEA NOT NULL, attached BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS exp_config (key TEXT PRIMARY KEY, data JSONB NOT NULL);
`;

let ready = null;
function ensureExpSchema() {
  if (!ready) ready = pool.query(SCHEMA_SQL).catch(e => { ready = null; throw e; });
  return ready;
}

const ROLES = ['owner', 'admin', 'finance', 'staff'];
const isManager = u => u && (u.role === 'owner' || u.role === 'admin' || u.role === 'finance');
const canApprove = u => u && (u.role === 'owner' || u.role === 'admin');
const canPay = u => isManager(u);
const canManageUsers = u => u && (u.role === 'owner' || u.role === 'admin');

const newId = (p) => (p || '') + crypto.randomBytes(9).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32);
  return salt.toString('hex') + ':' + h.toString('hex');
}
function checkPin(pin, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(String(pin), Buffer.from(s, 'hex'), 32);
  const want = Buffer.from(h, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(want, calc);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const COOKIE = 'exp_sess';
function setSessionCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = 30;
  await pool.query('INSERT INTO exp_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3||\' days\')::interval)', [sha256(token), userId, String(days)]);
  setSessionCookie(res, token, days * 86400);
}

async function currentUser(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return null;
  const r = await pool.query(
    `SELECT u.* FROM exp_sessions s JOIN exp_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`, [sha256(tok)]);
  return r.rows[0] || null;
}

/* what a viewer may see about a user */
function publicUser(u, viewer) {
  const self = viewer && viewer.id === u.id;
  const full = self || isManager(viewer);
  const o = { id: u.id, name: u.name, dept: u.dept || '', role: u.role };
  if (full) Object.assign(o, { code: u.code, active: u.active, lang: u.lang || '', bank: u.bank || '', acctNo: u.acct_no || '', acctName: u.acct_name || '', promptpay: u.promptpay || '' });
  return o;
}

module.exports = {
  pool, ensureExpSchema, ROLES, isManager, canApprove, canPay, canManageUsers,
  newId, hashPin, checkPin, createSession, currentUser, setSessionCookie, parseCookies, sha256, COOKIE, publicUser,
};
