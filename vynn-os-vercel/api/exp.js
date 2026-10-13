'use strict';
// Vercel serverless function: /api/exp — expense claims (VYNN | VANGARDE เบิกจ่าย).
// POST {a:"<action>", ...} for everything; GET ?a=file&id=... streams a receipt image.
// Permission checks live here, never in the page.
const X = require('../lib/exp');
const { pool } = X;

const MAX_FILE = 3 * 1024 * 1024;
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const STATUSES = ['pending_owner', 'approved', 'credit', 'paid', 'rejected', 'cleared'];

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) ? n : NaN; };
const nowISO = () => new Date().toISOString();
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const normRef = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

async function getCfg() {
  const r = await pool.query("SELECT data FROM exp_config WHERE key='org'");
  return (r.rows[0] && r.rows[0].data) || {};
}
function nextDeal(cfg) {
  const dd = Math.min(28, Math.max(1, Number(cfg.dealDay) || 25));
  // Bangkok date
  const now = new Date(Date.now() + 7 * 3600e3);
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (now.getUTCDate() > dd) m++;
  return ymd(new Date(y, m, dd));
}
function docNo() {
  const d = new Date(Date.now() + 7 * 3600e3);
  return 'EX' + String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + require('crypto').randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
}
async function loadClaim(id) {
  const r = await pool.query('SELECT * FROM exp_claims WHERE id=$1', [str(id, 40)]);
  return r.rows[0] || null;
}
async function saveClaim(c) {
  c.data.updatedAt = nowISO();
  await pool.query('UPDATE exp_claims SET status=$2, brand=$3, updated_at=now(), data=$4 WHERE id=$1',
    [c.id, c.data.status, c.data.brand, c.data]);
}
// files the user uploaded and has not attached yet
async function claimFiles(user, ids, kind) {
  const list = (Array.isArray(ids) ? ids : []).slice(0, 12).map(x => str(x, 40)).filter(Boolean);
  if (!list.length) return [];
  const r = await pool.query('SELECT id, mime FROM exp_files WHERE id = ANY($1) AND owner_id=$2 AND NOT attached', [list, user.id]);
  need(r.rows.length === list.length, 400, 'file not found or already used');
  await pool.query('UPDATE exp_files SET attached=true, kind=$3 WHERE id = ANY($1) AND owner_id=$2', [list, user.id, kind]);
  return list.map(id => ({ id, type: r.rows.find(x => x.id === id).mime === 'application/pdf' ? 'pdf' : 'image' }));
}

/* ---------------- actions ---------------- */
const A = {};

A.status = async (req, res, me) => {
  const n = await pool.query('SELECT count(*)::int AS n FROM exp_users');
  return { me: me ? X.publicUser(me, me) : null, needsSetup: n.rows[0].n === 0 };
};

A.setup = async (req, res, me, b) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE exp_users IN EXCLUSIVE MODE');
    const n = await client.query('SELECT count(*)::int AS n FROM exp_users');
    need(n.rows[0].n === 0, 409, 'already set up');
    const code = str(b.code, 20).toUpperCase(), name = str(b.name, 60), pin = String(b.pin || '');
    need(code && name && /^\d{6,12}$/.test(pin), 400, 'code, name and a 6-12 digit PIN are required');
    const id = X.newId('u_');
    await client.query('INSERT INTO exp_users(id,code,name,role,pin_hash,lang) VALUES($1,$2,$3,$4,$5,$6)', [id, code, name, 'owner', X.hashPin(pin), str(b.lang, 4)]);
    await client.query('COMMIT');
    await X.createSession(res, id);
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
};

A.login = async (req, res, me, b) => {
  const code = str(b.code, 20).toUpperCase(), pin = String(b.pin || '');
  const r = await pool.query('SELECT * FROM exp_users WHERE code=$1', [code]);
  const u = r.rows[0];
  const fail = () => new HttpError(401, 'wrong code or PIN');
  if (!u || !u.active) throw fail();
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'locked');
  if (!X.checkPin(pin, u.pin_hash)) {
    await pool.query("UPDATE exp_users SET fail_count=fail_count+1, locked_until=CASE WHEN fail_count+1>=5 THEN now()+interval '10 minutes' ELSE NULL END WHERE id=$1", [u.id]);
    throw fail();
  }
  await pool.query('UPDATE exp_users SET fail_count=0, locked_until=NULL WHERE id=$1', [u.id]);
  await pool.query('DELETE FROM exp_sessions WHERE expires_at<now()');
  await X.createSession(res, u.id);
  return { ok: true };
};

A.logout = async (req, res) => {
  const tok = X.parseCookies(req)[X.COOKIE];
  if (tok) await pool.query('DELETE FROM exp_sessions WHERE token_hash=$1', [X.sha256(tok)]);
  X.setSessionCookie(res, '', 0);
  return { ok: true };
};

A.sync = async (req, res, me) => {
  const mgr = X.isManager(me);
  const [claims, users, cfg] = await Promise.all([
    mgr ? pool.query('SELECT id, data FROM exp_claims ORDER BY created_at DESC LIMIT 3000')
        : pool.query('SELECT id, data FROM exp_claims WHERE user_id=$1 ORDER BY created_at DESC', [me.id]),
    mgr ? pool.query('SELECT * FROM exp_users ORDER BY name') : pool.query('SELECT * FROM exp_users WHERE id=$1', [me.id]),
    getCfg(),
  ]);
  return {
    me: X.publicUser(me, me), cfg, scan: !!process.env.ANTHROPIC_API_KEY,
    users: users.rows.map(u => X.publicUser(u, me)),
    claims: claims.rows.map(r => Object.assign({}, r.data, { id: r.id })),
  };
};

A.saveProfile = async (req, res, me, b) => {
  const pp = String(b.promptpay || '').replace(/\D/g, '');
  need(!pp || pp.length === 10 || pp.length === 13 || pp.length === 15, 400, 'bad promptpay');
  await pool.query('UPDATE exp_users SET name=$2, dept=$3, lang=$4, bank=$5, acct_no=$6, acct_name=$7, promptpay=$8 WHERE id=$1',
    [me.id, str(b.name, 60) || me.name, str(b.dept, 60), str(b.lang, 4), str(b.bank, 60), str(b.acctNo, 30), str(b.acctName, 80), pp]);
  return { ok: true };
};

A.changePin = async (req, res, me, b) => {
  need(X.checkPin(String(b.old || ''), me.pin_hash), 401, 'wrong PIN');
  need(/^\d{6,12}$/.test(String(b.pin || '')), 400, 'PIN must be 6-12 digits');
  await pool.query('UPDATE exp_users SET pin_hash=$2 WHERE id=$1', [me.id, X.hashPin(b.pin)]);
  return { ok: true };
};

A.upload = async (req, res, me, b) => {
  const mime = str(b.mime, 40);
  need(MIMES.includes(mime), 400, 'unsupported type');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  need(buf.length > 0 && buf.length <= MAX_FILE, 413, 'file too large');
  const id = X.newId('f_');
  await pool.query('INSERT INTO exp_files(id,owner_id,mime,size,bytes) VALUES($1,$2,$3,$4,$5)', [id, me.id, mime, buf.length, buf]);
  return { id, type: mime === 'application/pdf' ? 'pdf' : 'image' };
};

A.discardFile = async (req, res, me, b) => {
  await pool.query('DELETE FROM exp_files WHERE id=$1 AND owner_id=$2 AND NOT attached', [str(b.id, 40), me.id]);
  return { ok: true };
};

A.submit = async (req, res, me, b) => {
  const type = b.type === 'advance' ? 'advance' : 'reimburse';
  const amount = num(b.amount);
  need(amount > 0 && amount < 1e8, 400, 'bad amount');
  need(/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')), 400, 'bad date');
  const job = str(b.job, 80); need(job, 400, 'job required');
  const recIds = Array.isArray(b.receipts) ? b.receipts : [], slipIds = Array.isArray(b.slips) ? b.slips : [];
  need(type === 'advance' || recIds.length + slipIds.length > 0, 400, 'attach a bill or slip');
  const slipRef = str(b.slipRef, 40);
  if (normRef(slipRef).length >= 6 && !b.confirmDup) {
    const d = await pool.query("SELECT count(*)::int AS n FROM exp_claims WHERE regexp_replace(upper(data->>'slipRef'),'[^0-9A-Z]','','g')=$1", [normRef(slipRef)]);
    if (d.rows[0].n) return { needConfirm: true, dupCount: d.rows[0].n };
  }
  const receipts = await claimFiles(me, recIds, 'receipt');
  const slips = await claimFiles(me, slipIds, 'slip');
  const now = nowISO(), auto = me.role === 'owner';
  const cat = str(b.category, 60);
  const data = {
    type, title: str(b.title, 120) || cat, category: cat, date: b.date, vendor: str(b.vendor, 80), amount,
    vatIncl: !!b.vatIncl, note: str(b.note, 500), job, receipts, slips, slipRef, slipAmount: num(b.slipAmount) > 0 ? num(b.slipAmount) : 0,
    brand: b.brand === 'vangarde' ? 'vangarde' : 'vynn', status: auto ? 'approved' : 'pending_owner', dept: me.dept || '',
    by: me.id, createdAt: now, updatedAt: now, docNo: docNo(), history: [{ at: now, by: me.id, a: 'submit' }],
  };
  if (auto) { data.history.push({ at: now, by: me.id, a: 'auto' }); data.approvedAt = now; }
  const id = X.newId('c_');
  await pool.query('INSERT INTO exp_claims(id,doc_no,user_id,brand,status,data) VALUES($1,$2,$3,$4,$5,$6)', [id, data.docNo, me.id, data.brand, data.status, data]);
  return { ok: true, id, status: data.status };
};

A.decide = async (req, res, me, b) => {
  need(X.canApprove(me), 403, 'forbidden');
  const c = await loadClaim(b.id); need(c, 404, 'not found');
  need(c.data.status === 'pending_owner' || c.data.status === 'pending_head', 409, 'already decided');
  const note = str(b.note, 300), now = nowISO(), d = c.data;
  if (b.kind === 'reject') { need(note, 400, 'reason required'); d.status = 'rejected'; d.history.push({ at: now, by: me.id, a: 'reject', note }); }
  else if (b.kind === 'approve') { d.status = 'approved'; d.approvedAt = now; d.history.push({ at: now, by: me.id, a: 'approve_final', note }); }
  else if (b.kind === 'credit') { const cfg = await getCfg(); d.status = 'credit'; d.approvedAt = now; d.dueDate = nextDeal(cfg); d.history.push({ at: now, by: me.id, a: 'credit', note: note ? note + ' · ' + d.dueDate : d.dueDate }); }
  else throw new HttpError(400, 'bad kind');
  await saveClaim(c);
  return { ok: true, status: d.status, dueDate: d.dueDate };
};

A.pay = async (req, res, me, b) => {
  need(X.canPay(me), 403, 'forbidden');
  const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 200);
  need(ids.length, 400, 'nothing to pay');
  const slips = await claimFiles(me, b.slips, 'payslip');
  const ref = str(b.payRef, 60), now = nowISO(), note = str(b.note, 120);
  let n = 0;
  for (const id of ids) {
    const c = await loadClaim(id);
    if (!c || !(c.data.status === 'approved' || c.data.status === 'credit')) continue;
    Object.assign(c.data, { status: 'paid', paidAt: now, payRef: ref, paySlips: slips });
    c.data.history.push({ at: now, by: me.id, a: 'paid', note: [ref, note].filter(Boolean).join(' · ') });
    await saveClaim(c); n++;
  }
  return { ok: true, paid: n };
};

A.clear = async (req, res, me, b) => {
  const c = await loadClaim(b.id); need(c && c.user_id === me.id, 404, 'not found');
  need(c.data.type === 'advance' && c.data.status === 'paid', 409, 'not clearable');
  const amt = num(b.amount); need(amt >= 0, 400, 'bad amount');
  const files = await claimFiles(me, b.receipts, 'clear'); need(files.length, 400, 'attach receipts');
  const now = nowISO();
  Object.assign(c.data, { status: 'cleared', clearedAmount: amt, clearedAt: now, clearReceipts: files });
  c.data.history.push({ at: now, by: me.id, a: 'clear', note: '฿' + amt.toFixed(2) });
  await saveClaim(c);
  return { ok: true };
};

A.cancel = async (req, res, me, b) => {
  const c = await loadClaim(b.id); need(c && c.user_id === me.id, 404, 'not found');
  need(String(c.data.status).startsWith('pending') && c.data.history.every(h => h.by === me.id), 409, 'cannot cancel');
  const ids = [...(c.data.receipts || []), ...(c.data.slips || [])].map(f => f.id);
  await pool.query('DELETE FROM exp_claims WHERE id=$1', [c.id]);
  if (ids.length) await pool.query('DELETE FROM exp_files WHERE id = ANY($1) AND owner_id=$2', [ids, me.id]);
  return { ok: true };
};

A.saveCfg = async (req, res, me, b) => {
  need(X.canManageUsers(me), 403, 'forbidden');
  const list = (v, n) => (Array.isArray(v) ? v : []).map(x => str(x, 60)).filter(Boolean).slice(0, n);
  const cfg = { departments: list(b.departments, 40), categories: list(b.categories, 40), dealDay: Math.min(28, Math.max(1, parseInt(b.dealDay, 10) || 25)) };
  need(cfg.departments.length && cfg.categories.length, 400, 'need at least one');
  await pool.query("INSERT INTO exp_config(key,data) VALUES('org',$1) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data", [cfg]);
  return { ok: true };
};

A.saveUser = async (req, res, me, b) => {
  need(X.canManageUsers(me), 403, 'forbidden');
  const role = X.ROLES.includes(b.role) ? b.role : 'staff';
  // only the owner hands out owner/admin rights
  need(me.role === 'owner' || (role !== 'owner' && role !== 'admin'), 403, 'only the owner can grant this role');
  const pin = b.pin ? String(b.pin) : '';
  need(!pin || /^\d{6,12}$/.test(pin), 400, 'PIN must be 6-12 digits');
  if (!b.id) {
    const code = str(b.code, 20).toUpperCase(), name = str(b.name, 60);
    need(code && name && pin, 400, 'code, name and PIN required');
    const dup = await pool.query('SELECT 1 FROM exp_users WHERE code=$1', [code]);
    need(!dup.rows.length, 409, 'code already used');
    await pool.query('INSERT INTO exp_users(id,code,name,role,dept,pin_hash) VALUES($1,$2,$3,$4,$5,$6)', [X.newId('u_'), code, name, role, str(b.dept, 60), X.hashPin(pin)]);
    return { ok: true };
  }
  const r = await pool.query('SELECT * FROM exp_users WHERE id=$1', [str(b.id, 40)]); const u = r.rows[0];
  need(u, 404, 'not found');
  need(me.role === 'owner' || (u.role !== 'owner' && u.role !== 'admin'), 403, 'only the owner can change this user');
  need(!(u.id === me.id && role !== u.role), 400, 'you cannot change your own role');
  const active = b.active === undefined ? u.active : !!b.active;
  need(!(u.id === me.id && !active), 400, 'you cannot deactivate yourself');
  await pool.query('UPDATE exp_users SET name=$2, role=$3, dept=$4, active=$5 WHERE id=$1', [u.id, str(b.name, 60) || u.name, role, str(b.dept, 60), active]);
  if (pin) await pool.query('UPDATE exp_users SET pin_hash=$2, fail_count=0, locked_until=NULL WHERE id=$1', [u.id, X.hashPin(pin)]);
  if (!active || pin) await pool.query('DELETE FROM exp_sessions WHERE user_id=$1', [u.id]);
  return { ok: true };
};

A.scan = async (req, res, me, b) => {
  need(process.env.ANTHROPIC_API_KEY, 501, 'scan not configured');
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 4).filter(i => i && MIMES.slice(0, 3).includes(i.mime) && typeof i.data === 'string' && i.data.length < 4.5e6);
  need(imgs.length, 400, 'no images');
  const content = imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }));
  content.push({ type: 'text', text: str(b.prompt, 4000) });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.EXP_SCAN_MODEL || 'claude-haiku-5-5', max_tokens: 600, messages: [{ role: 'user', content }] }),
  });
  need(r.ok, 502, 'scan failed');
  const j = await r.json();
  const text = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  need(m, 502, 'unreadable');
  return { result: JSON.parse(m[0]) };
};

/* ---------------- file download ---------------- */
async function sendFile(req, res, me) {
  const id = str(req.query.id, 40);
  const f = (await pool.query('SELECT * FROM exp_files WHERE id=$1', [id])).rows[0];
  need(f, 404, 'not found');
  let ok = X.isManager(me) || f.owner_id === me.id;
  if (!ok) { // staff may see files attached to their own claims (e.g. the company's transfer slip)
    const r = await pool.query('SELECT 1 FROM exp_claims WHERE user_id=$1 AND position($2 in data::text)>0 LIMIT 1', [me.id, id]);
    ok = r.rows.length > 0;
  }
  need(ok, 404, 'not found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(f.bytes);
}

const PUBLIC = new Set(['status', 'setup', 'login', 'logout']);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await X.ensureExpSchema();
    const me = await X.currentUser(req);
    if (req.method === 'GET' && req.query.a === 'file') { need(me, 401, 'login required'); return await sendFile(req, res, me); }
    need(req.method === 'POST', 405, 'POST only');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const fn = Object.prototype.hasOwnProperty.call(A, b.a) && A[b.a];
    need(fn, 400, 'unknown action');
    if (!PUBLIC.has(b.a)) need(me, 401, 'login required');
    const out = await fn(req, res, me, b);
    res.status(200).json(out);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error('/api/exp', e);
    res.status(code).json({ error: e.message, code });
  }
};
