'use strict';
// Vercel serverless function: /api/booth — cloud backup for the standalone booth lead form (booth.html).
// Completely separate from VYNN·OS: own tables, no Lead Intake. Each event has a shared booth code;
// sales join with the code + their real name. A manager code (set once) creates events and reads everything.
const crypto = require('crypto');
const { pool } = require('../lib/db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS booth_admin (id INT PRIMARY KEY, code_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS booth_events (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, start_d DATE, end_d DATE,
  code TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS booth_tokens (
  token_hash TEXT PRIMARY KEY, event_id TEXT, sales_name TEXT, admin BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS booth_entries (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, sales_name TEXT NOT NULL, data JSONB NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_booth_entries_ev ON booth_entries(event_id, lower(sales_name));
CREATE TABLE IF NOT EXISTS booth_fails (ip TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
`;
let ready = null;
const ensure = () => (ready = ready || pool.query(SCHEMA).catch(e => { ready = null; throw e; }));

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (c, code, msg) => { if (!c) throw new HttpError(code, msg); };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashCode = c => { const salt = crypto.randomBytes(16); return 'pbkdf2$150000$' + salt.toString('hex') + '$' + crypto.pbkdf2Sync(c, salt, 150000, 32, 'sha256').toString('hex'); };
const checkCode = (c, h) => { const [, it, s, x] = String(h || '').split('$'); if (!s) return false; const a = crypto.pbkdf2Sync(c, Buffer.from(s, 'hex'), +it, 32, 'sha256'), b = Buffer.from(x, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'na';

async function guardFails(req) {
  const n = (await pool.query("SELECT count(*)::int n FROM booth_fails WHERE ip=$1 AND at > now() - interval '10 minutes'", [ipOf(req)])).rows[0].n;
  need(n < 10, 429, 'ใส่รหัสผิดหลายครั้ง ลองใหม่ใน 10 นาที');
}
const fail = async (req, msg) => { await pool.query('INSERT INTO booth_fails(ip) VALUES($1)', [ipOf(req)]); throw new HttpError(401, msg); };
async function issue(eventId, salesName, admin) {
  const tok = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO booth_tokens(token_hash,event_id,sales_name,admin,expires_at) VALUES($1,$2,$3,$4,now()+interval '120 days')", [sha(tok), eventId, salesName, admin]);
  return tok;
}
async function who(b) {
  const t = str(b.token, 100);
  need(t, 401, 'ยังไม่ได้เข้าสู่ระบบ');
  const r = (await pool.query('SELECT * FROM booth_tokens WHERE token_hash=$1 AND expires_at>now()', [sha(t)])).rows[0];
  need(r, 401, 'หมดเวลาเข้าระบบ ใส่รหัสใหม่');
  return r;
}
const evOut = e => ({ id: e.id, name: e.name, source: e.source, start: e.start_d ? String(e.start_d.toISOString ? e.start_d.toISOString() : e.start_d).slice(0, 10) : '', end: e.end_d ? String(e.end_d.toISOString ? e.end_d.toISOString() : e.end_d).slice(0, 10) : '', code: e.code, active: e.active });
const rowsOut = rs => rs.map(r => Object.assign({}, r.data, { id: r.id, sales: r.data.sales || r.sales_name }));

const A = {};
A.status = async () => ({ adminSet: !!(await pool.query('SELECT 1 FROM booth_admin WHERE id=1')).rows.length });
A.adminSetup = async (req, b) => {
  const code = String(b.code || '');
  need(code.length >= 6, 400, 'รหัสหัวหน้าต้องยาวอย่างน้อย 6 ตัว');
  const r = await pool.query('INSERT INTO booth_admin(id,code_hash) VALUES(1,$1) ON CONFLICT (id) DO NOTHING RETURNING id', [hashCode(code)]);
  need(r.rows.length, 409, 'ตั้งรหัสหัวหน้าไว้แล้ว ใช้ "เข้าสู่ระบบหัวหน้า"');
  return { token: await issue(null, null, true) };
};
A.adminLogin = async (req, b) => {
  await guardFails(req);
  const a = (await pool.query('SELECT code_hash FROM booth_admin WHERE id=1')).rows[0];
  need(a, 404, 'ยังไม่ได้ตั้งรหัสหัวหน้า');
  if (!checkCode(String(b.code || ''), a.code_hash)) await fail(req, 'รหัสหัวหน้าไม่ถูกต้อง');
  return { token: await issue(null, null, true) };
};
A.events = async (req, b) => {
  const me = await who(b); need(me.admin, 403, 'เฉพาะหัวหน้า');
  const ev = (await pool.query('SELECT * FROM booth_events ORDER BY created_at DESC')).rows;
  const cnt = (await pool.query('SELECT event_id, count(*)::int n, count(DISTINCT lower(sales_name))::int s FROM booth_entries WHERE NOT deleted GROUP BY event_id')).rows;
  return { events: ev.map(e => Object.assign(evOut(e), { leads: (cnt.find(c => c.event_id === e.id) || {}).n || 0, sales: (cnt.find(c => c.event_id === e.id) || {}).s || 0 })) };
};
A.createEvent = async (req, b) => {
  const me = await who(b); need(me.admin, 403, 'เฉพาะหัวหน้า');
  const name = str(b.name, 120); need(name, 400, 'ใส่ชื่องาน');
  let code = str(b.code, 12).toUpperCase();
  need(!code || /^[A-Z0-9]{4,12}$/.test(code), 400, 'รหัสบูธใช้ A-Z / 0-9 ยาว 4–12 ตัว');
  for (let i = 0; !code && i < 20; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!(await pool.query('SELECT 1 FROM booth_events WHERE active AND code=$1', [c])).rows.length) code = c;
  }
  need(!(await pool.query('SELECT 1 FROM booth_events WHERE active AND code=$1', [code])).rows.length, 409, 'รหัสนี้มีงานอื่นใช้อยู่');
  const d = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  const id = 'ev' + Date.now().toString(36);
  await pool.query('INSERT INTO booth_events(id,name,source,start_d,end_d,code) VALUES($1,$2,$3,$4,$5,$6)', [id, name, str(b.source, 30) || null, d(b.start), d(b.end), code]);
  return { id, code };
};
A.setEvent = async (req, b) => {
  const me = await who(b); need(me.admin, 403, 'เฉพาะหัวหน้า');
  await pool.query('UPDATE booth_events SET active=$2 WHERE id=$1', [str(b.id, 40), !!b.active]);
  return { ok: true };
};
A.join = async (req, b) => {
  await guardFails(req);
  const code = str(b.code, 12).toUpperCase(), name = str(b.name, 80);
  need(name.length >= 2, 400, 'ใส่ชื่อจริงของคุณ');
  const e = (await pool.query('SELECT * FROM booth_events WHERE active AND code=$1', [code])).rows[0];
  if (!e) await fail(req, 'ไม่พบรหัสบูธนี้ (หรืองานปิดแล้ว)');
  const mine = (await pool.query('SELECT * FROM booth_entries WHERE event_id=$1 AND lower(sales_name)=lower($2) AND NOT deleted ORDER BY created_at', [e.id, name])).rows;
  return { token: await issue(e.id, name, false), event: evOut(e), leads: rowsOut(mine) };
};
// push this phone's new / changed / deleted records; returns what the server holds for this person
A.sync = async (req, b) => {
  const me = await who(b); need(!me.admin, 400, 'ใช้รหัสบูธของงาน');
  const ev = (await pool.query('SELECT active FROM booth_events WHERE id=$1', [me.event_id])).rows[0];
  need(ev, 404, 'ไม่พบงานนี้');
  const saved = [];
  for (const r of (Array.isArray(b.push) ? b.push : []).slice(0, 100)) {
    const id = str(r && r.id, 60);
    if (!/^[A-Za-z0-9_-]{4,60}$/.test(id) || !r.data || typeof r.data !== 'object') continue;
    const json = JSON.stringify(r.data); if (json.length > 3 * 1024 * 1024) continue;
    const cur = (await pool.query('SELECT event_id, sales_name FROM booth_entries WHERE id=$1', [id])).rows[0];
    if (cur && (cur.event_id !== me.event_id || cur.sales_name.toLowerCase() !== me.sales_name.toLowerCase())) continue;
    await pool.query(`INSERT INTO booth_entries(id,event_id,sales_name,data,deleted) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, deleted=EXCLUDED.deleted, updated_at=now()`, [id, me.event_id, me.sales_name, json, !!r.deleted]);
    saved.push(id);
  }
  return { saved, active: ev.active };
};
A.entries = async (req, b) => {
  const me = await who(b); need(me.admin, 403, 'เฉพาะหัวหน้า');
  const e = (await pool.query('SELECT * FROM booth_events WHERE id=$1', [str(b.eventId, 40)])).rows[0];
  need(e, 404, 'ไม่พบงาน');
  const rs = (await pool.query('SELECT * FROM booth_entries WHERE event_id=$1 AND NOT deleted ORDER BY created_at', [e.id])).rows;
  return { event: evOut(e), leads: rowsOut(rs) };
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    need(req.method === 'POST', 405, 'POST only');
    await ensure();
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
    const fn = Object.prototype.hasOwnProperty.call(A, b.a) && A[b.a];
    need(fn, 400, 'unknown action');
    res.status(200).json(await fn(req, b));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error('/api/booth', e);
    res.status(code).json({ error: e.message, code });
  }
};
