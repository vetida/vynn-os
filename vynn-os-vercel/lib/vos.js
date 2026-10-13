'use strict';
// VYNN·OS server-side login + employee directory.
// Passwords are PBKDF2-SHA256 hashes; sessions are random tokens in an HttpOnly cookie
// (only their SHA-256 is stored). Employee documents (ID card, house registration) live
// in vos_docs and are served only to the CEO.
const crypto = require('crypto');
const { pool } = require('./db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vos_users (
  id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, short TEXT, color TEXT,
  role TEXT NOT NULL, pw_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  fail_count INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vos_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vos_sessions_user ON vos_sessions(user_id);
CREATE TABLE IF NOT EXISTS vos_docs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, mime TEXT NOT NULL,
  size INT NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_vos_docs_user ON vos_docs(user_id);
`;

// accounts that existed in the page source before 2026-10 (passwords carried over as hashes)
const SEED = [
  { id: 'a1', login: 'CEO', name: 'Vetida', short: 'Ve', color: '#7A4FB5', role: 'admin', active: true, phone: '0889659244', hash: 'pbkdf2$210000$34d973ef64145ddc439ddfbf32f41023$0f28cbb53178ce09c425fc1b01614bfcf51c921fd237e47cf0ed3e0530846de7' },
  { id: 'a2', login: 'A002', name: 'Thanasarn', short: 'Th', color: '#7A4FB5', role: 'admin', active: true, hash: 'pbkdf2$210000$fb8071a67ae19fd6f20cd6a4585b1d39$71287bb54eecac022f76cca98a401eaf0738bec5a18a5ea513d17f7a95e0edb5' },
  { id: 'sp1', login: 'SP01', name: 'Hanan', short: 'Ha', color: '#0E7C86', role: 'sales_support', active: true, hash: 'pbkdf2$210000$8dcc58ca3b2e2f3c0c6263447fdb470c$a2382c06d2654d85adb476fe5eb05c4cc546218c0a331e9eaf864629b9b2f6e0' },
  { id: 'sp2', login: 'SP02', name: 'Oraya', short: 'Or', color: '#0E7C86', role: 'sales_support', active: true, hash: 'pbkdf2$210000$ac905b90229688bf9297600953a62846$52ec5a4b877f6a2c8bd7fae919dac82169003c4db1981a43b2c19a62e316a965' },
  { id: 'ac1', login: 'AC01', name: 'Kunyanuch', short: 'Ku', color: '#2C6BB3', role: 'accounting', active: true, hash: 'pbkdf2$210000$1a409339af62cbcc1d53aee5fd4322e1$19022c58fd0314cfebad2a9673d207fd293277c3415b946d0a0590740baf403e' },
  { id: 's1', login: 'E101', name: 'Atikarn', short: 'At', color: '#0F6E68', role: 'sales', active: true, hash: 'pbkdf2$210000$eeb7e7680eca3d3685d059f7b010caee$4c3b2164cbad20de6ccedc3c9ab5da8d4a19f40866dc4664aa47e542c8fd80e3' },
  { id: 's2', login: 'E102', name: 'Chuchart', short: 'Ch', color: '#B65C36', role: 'sales', active: false, hash: 'pbkdf2$210000$7288bafa792779e4bc4fd1d5ba99eea5$e8b93403a332969a422fce5c0ac39db2246087b2f481b6fc0de478845bb31d98' },
  { id: 'mg', login: 'M001', name: 'Preechaya', short: 'Pr', color: '#B77504', role: 'manager', active: true, hash: 'pbkdf2$210000$d173396e3aefbfc7253aa0b8f160f5a6$da3fa3fe7de1e90fdb4a3ffbac8114f5c7b9816d52bcd2ec5c00e8251f20a0a6' },
  { id: 'mg2', login: 'M002', name: 'Nichkarn', short: 'Ni', color: '#B77504', role: 'manager', active: true, hash: 'pbkdf2$210000$dc95143d4e3c7e7fad0b5cc4b9976cdd$4643cecb60c2df87d1e69995059828a5aadac6527343f534f9437ebc91167ceb' },
  { id: 'in1', login: 'IN01', name: 'Suradit', short: 'Su', color: '#C0392B', role: 'installer', active: true, hash: 'pbkdf2$210000$5196d424d824e6bda95484ab5c0233c8$c8df48e8f5d90b088dd6cb1fbf7f2eaca36947e672d7d9c9458d11549f890654' },
  { id: 'in2', login: 'IN02', name: 'Roytawan', short: 'Ro', color: '#C0392B', role: 'installer', active: true, hash: 'pbkdf2$210000$5704144a3962546e07103d67cb8a06bf$b8d6cd27a865c7012b0c838b4c5d07954e2ceea31bd21cc4f9e08765f05aed62' },
  { id: 'in3', login: 'IN03', name: 'Bounma', short: 'Bo', color: '#C0392B', role: 'installer', active: true, hash: 'pbkdf2$210000$6829cdb940cce924811f202df45eba73$adb80280dd54977f6f9ca0ead91e6392e2540566c7e6dece77df41c2f231222c' },
  { id: 'in4', login: 'IN04', name: 'Pantamit', short: 'Pa', color: '#C0392B', role: 'installer', active: true, hash: 'pbkdf2$210000$8781011277b3f349d0c30b226bb51701$310c574bf9d82e380b0e5bea4a63e68221995a1a3eadbe9fb3eee8a83a0d7774' },
  { id: 'in5', login: 'IN05', name: 'Yea', short: 'Ye', color: '#C0392B', role: 'installer', active: true, hash: 'pbkdf2$210000$de09b9190cac73735222ffa6ce6be337$08bf5541ffb649344e93972fbc6e4072b5b1f42d02a166c59ac870ccc4d22349' },
];

let ready = null;
function ensureVos() {
  if (!ready) ready = (async () => {
    await pool.query(SCHEMA_SQL);
    const n = await pool.query('SELECT count(*)::int AS n FROM vos_users');
    if (n.rows[0].n === 0) {
      for (const u of SEED) {
        await pool.query(
          'INSERT INTO vos_users(id,login,name,short,color,role,pw_hash,active,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING',
          [u.id, u.login, u.name, u.short, u.color, u.role, u.hash, u.active, { phone: u.phone || '' }]);
      }
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const ITER = 210000;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.pbkdf2Sync(String(pw), salt, ITER, 32, 'sha256');
  return `pbkdf2$${ITER}$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !salt || !hash) return false;
  const calc = crypto.pbkdf2Sync(String(pw), Buffer.from(salt, 'hex'), Number(iter), 32, 'sha256');
  const want = Buffer.from(hash, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(want, calc);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const COOKIE = 'vos_sess';
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO vos_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [sha256(token), userId]);
  setCookie(res, token, 30 * 86400);
}
async function sessionUser(req) {
  const tok = cookies(req)[COOKIE];
  if (!tok) return null;
  await ensureVos();
  const r = await pool.query(
    `SELECT u.* FROM vos_sessions s JOIN vos_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`, [sha256(tok)]);
  return r.rows[0] || null;
}
const isCEO = u => !!u && u.role === 'admin';
// what every logged-in user may know about a colleague (names for lists, colours, roles)
const lite = u => ({ id: u.id, login: u.login, name: u.name, short: u.short || '', color: u.color || '', role: u.role, active: u.active });

module.exports = { pool, ensureVos, hashPassword, checkPassword, sha256, cookies, setCookie, createSession, sessionUser, isCEO, lite, COOKIE };
