'use strict';
// Vercel serverless function: /api/auth — VYNN·OS login, sessions and the CEO-only employee directory.
// POST {a:"<action>", ...}; GET ?a=doc&id=... streams an employee document (CEO only).
const V = require('../lib/vos');
const { pool } = V;

const ROLES = ['admin', 'sales_support', 'manager', 'sales', 'online_sales', 'installer', 'hr', 'accounting'];
const DOC_KINDS = ['idcard', 'house', 'other'];
const DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const PROFILE_FIELDS = ['birth', 'phone', 'email', 'address', 'facebook', 'instagram', 'startDate', 'salary', 'benefits', 'note', 'team', 'hrId'];

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (c, code, msg) => { if (!c) throw new HttpError(code, msg); };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

async function usersLite() {
  const r = await pool.query('SELECT * FROM vos_users ORDER BY created_at, id');
  return r.rows.map(V.lite);
}

const A = {};

A.login = async (req, res, me, b) => {
  const login = str(b.login, 40).toLowerCase(), pw = String(b.password || '');
  const u = (await pool.query('SELECT * FROM vos_users WHERE lower(login)=$1', [login])).rows[0];
  if (!u || !u.active) throw new HttpError(401, 'ไม่พบรหัสพนักงานนี้');
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'ใส่รหัสผิดหลายครั้ง ลองใหม่ใน 10 นาที');
  if (!V.checkPassword(pw, u.pw_hash)) {
    await pool.query("UPDATE vos_users SET fail_count=fail_count+1, locked_until=CASE WHEN fail_count+1>=5 THEN now()+interval '10 minutes' ELSE NULL END WHERE id=$1", [u.id]);
    throw new HttpError(401, 'รหัสผ่านไม่ถูกต้อง');
  }
  await pool.query('UPDATE vos_users SET fail_count=0, locked_until=NULL WHERE id=$1', [u.id]);
  await pool.query('DELETE FROM vos_sessions WHERE expires_at<now()');
  await V.createSession(res, u.id);
  return { me: V.lite(u), users: await usersLite() };
};

A.me = async (req, res, me) => ({ me: V.lite(me), users: await usersLite() });

A.logout = async (req, res) => {
  const tok = V.cookies(req)[V.COOKIE];
  if (tok) await pool.query('DELETE FROM vos_sessions WHERE token_hash=$1', [V.sha256(tok)]);
  V.setCookie(res, '', 0);
  return { ok: true };
};

A.verify = async (req, res, me, b) => ({ ok: V.checkPassword(String(b.password || ''), me.pw_hash) });

A.changePassword = async (req, res, me, b) => {
  need(V.checkPassword(String(b.old || ''), me.pw_hash), 401, 'รหัสผ่านเดิมไม่ถูกต้อง');
  need(String(b.password || '').length >= 8, 400, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัว');
  await pool.query('UPDATE vos_users SET pw_hash=$2, updated_at=now() WHERE id=$1', [me.id, V.hashPassword(b.password)]);
  return { ok: true };
};

/* ---------- employee directory: CEO edits · Admin and Accounts view (owner sheet H-01..H-06) ---------- */
const DIR_VIEW = ['admin', 'sales_support', 'accounting'];
const DOC_ROLES = ['admin', 'sales_support'];            // ID card / house registration
const PAY_ROLES = ['admin', 'accounting'];               // salary / benefits
A.dir = async (req, res, me) => {
  need(DIR_VIEW.includes(me.role), 403, 'ไม่มีสิทธิ์ดูรายชื่อพนักงาน');
  const [u, d] = await Promise.all([
    pool.query('SELECT * FROM vos_users ORDER BY created_at, id'),
    pool.query('SELECT id,user_id,kind,name,mime,size,created_at FROM vos_docs ORDER BY created_at'),
  ]);
  const pay = PAY_ROLES.includes(me.role), docs = DOC_ROLES.includes(me.role);
  return { users: u.rows.map(x => {
    const profile = Object.assign({}, x.profile || {});
    if (!pay) { delete profile.salary; delete profile.benefits; }
    return Object.assign(V.lite(x), { profile, docs: docs ? d.rows.filter(f => f.user_id === x.id && f.kind !== 'signature') : [] });
  }) };
};

A.saveUser = async (req, res, me, b) => {
  need(V.isCEO(me), 403, 'เฉพาะ CEO');
  const login = str(b.login, 40), name = str(b.name, 80), role = ROLES.includes(b.role) ? b.role : 'installer';
  need(login && /^[A-Za-z0-9._-]{2,40}$/.test(login), 400, 'username ใช้ได้เฉพาะ A-Z 0-9 . _ - (2–40 ตัว)');
  need(name, 400, 'ใส่ชื่อพนักงาน');
  const profile = {};
  PROFILE_FIELDS.forEach(k => { profile[k] = str((b.profile || {})[k], k === 'benefits' || k === 'address' || k === 'note' ? 1000 : 200); });
  const pw = b.password ? String(b.password) : '';
  need(!pw || pw.length >= 8, 400, 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว');
  const dup = await pool.query('SELECT id FROM vos_users WHERE lower(login)=lower($1) AND id<>$2', [login, String(b.id || '')]);
  need(!dup.rows.length, 409, 'username นี้มีคนใช้แล้ว');
  if (!b.id) {
    need(pw, 400, 'ตั้งรหัสผ่านสำหรับพนักงานใหม่');
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    await pool.query('INSERT INTO vos_users(id,login,name,short,color,role,pw_hash,active,profile) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8)',
      [id, login, name, str(b.short, 4) || name.slice(0, 2), str(b.color, 9) || '#73767D', role, V.hashPassword(pw), profile]);
    return { ok: true, id };
  }
  const u = (await pool.query('SELECT * FROM vos_users WHERE id=$1', [String(b.id)])).rows[0];
  need(u && !(u.profile || {}).deleted, 404, 'ไม่พบพนักงาน');
  const active = b.active === undefined ? u.active : !!b.active;
  need(!(u.id === me.id && (!active || role !== 'admin')), 400, 'ปิดใช้งานหรือลดสิทธิ์บัญชีตัวเองไม่ได้');
  await pool.query('UPDATE vos_users SET login=$2,name=$3,short=$4,color=$5,role=$6,active=$7,profile=$8,updated_at=now() WHERE id=$1',
    [u.id, login, name, str(b.short, 4) || u.short, str(b.color, 9) || u.color, role, active, profile]);
  if (pw) await pool.query('UPDATE vos_users SET pw_hash=$2, fail_count=0, locked_until=NULL WHERE id=$1', [u.id, V.hashPassword(pw)]);
  if (pw || !active) await pool.query('DELETE FROM vos_sessions WHERE user_id=$1 AND user_id<>$2', [u.id, me.id]);
  return { ok: true, id: u.id };
};

A.uploadDoc = async (req, res, me, b) => {
  need(DOC_ROLES.includes(me.role), 403, 'เฉพาะ CEO และ Admin');
  const mime = str(b.mime, 40), kind = DOC_KINDS.includes(b.kind) ? b.kind : 'other';
  need(DOC_MIMES.includes(mime), 400, 'รองรับเฉพาะ JPG / PNG / WebP / PDF');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  need(buf.length > 0 && buf.length <= 3 * 1024 * 1024, 413, 'ไฟล์ใหญ่เกิน 3MB');
  const u = await pool.query('SELECT 1 FROM vos_users WHERE id=$1', [String(b.userId || '')]);
  need(u.rows.length, 404, 'ไม่พบพนักงาน');
  const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pool.query('INSERT INTO vos_docs(id,user_id,kind,name,mime,size,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, String(b.userId), kind, str(b.name, 120), mime, buf.length, buf]);
  return { ok: true, id };
};

A.deleteDoc = async (req, res, me, b) => {
  need(DOC_ROLES.includes(me.role), 403, 'เฉพาะ CEO และ Admin');
  await pool.query("DELETE FROM vos_docs WHERE id=$1 AND kind<>'signature'", [String(b.id || '')]);
  return { ok: true };
};

// "delete" an employee: the row stays only as a name so old leads / quotes / audit still show who did what;
// login is freed, every personal field, document, signature and session is erased, and the account can never log in again.
A.deleteUser = async (req, res, me, b) => {
  need(V.isCEO(me), 403, 'เฉพาะ CEO');
  const u = (await pool.query('SELECT * FROM vos_users WHERE id=$1', [String(b.id || '')])).rows[0];
  need(u && !(u.profile || {}).deleted, 404, 'ไม่พบพนักงาน');
  need(u.id !== me.id, 400, 'ลบบัญชีของตัวเองไม่ได้');
  if (u.role === 'admin') {
    const n = (await pool.query("SELECT count(*)::int n FROM vos_users WHERE role='admin' AND active AND id<>$1", [u.id])).rows[0].n;
    need(n > 0, 400, 'ต้องมี CEO ที่ใช้งานได้อย่างน้อย 1 คน');
  }
  await pool.query('DELETE FROM vos_sessions WHERE user_id=$1', [u.id]);
  await pool.query('DELETE FROM vos_docs WHERE user_id=$1', [u.id]);
  await pool.query("UPDATE vos_users SET login=$2, active=false, pw_hash='!', profile=$3, fail_count=0, locked_until=NULL, updated_at=now() WHERE id=$1",
    [u.id, 'deleted.' + u.id, { deleted: true, deletedAt: new Date().toISOString(), deletedBy: me.id }]);
  return { ok: true };
};

/* ---------- document signatures: each signer uploads / removes ONLY their own ---------- */
const SIGNERS = ['admin', 'manager', 'sales_support'];   // CEO, PM (approvers) · Admin (preparer)
async function setSigStamp(uid, stamp) {
  await pool.query("UPDATE vos_users SET profile = jsonb_set(coalesce(profile,'{}'::jsonb), '{sigAt}', to_jsonb($2::text)), updated_at=now() WHERE id=$1", [uid, stamp]);
}
A.uploadSignature = async (req, res, me, b) => {
  need(SIGNERS.includes(me.role), 403, 'บทบาทนี้ไม่ต้องใช้ลายเซ็นในเอกสาร');
  const mime = str(b.mime, 40);
  need(mime === 'image/png' || mime === 'image/jpeg', 400, 'รองรับเฉพาะรูป PNG / JPG');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  need(buf.length > 0 && buf.length <= 400 * 1024, 413, 'ไฟล์ลายเซ็นใหญ่เกิน 400KB');
  await pool.query("DELETE FROM vos_docs WHERE user_id=$1 AND kind='signature'", [me.id]);
  await pool.query("INSERT INTO vos_docs(id,user_id,kind,name,mime,size,bytes) VALUES($1,$2,'signature','signature',$3,$4,$5)",
    ['s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), me.id, mime, buf.length, buf]);
  const stamp = Date.now().toString(36);
  await setSigStamp(me.id, stamp);
  return { ok: true, sig: stamp };
};
A.deleteSignature = async (req, res, me) => {
  await pool.query("DELETE FROM vos_docs WHERE user_id=$1 AND kind='signature'", [me.id]);
  await setSigStamp(me.id, '');
  return { ok: true };
};
// any logged-in user may draw a colleague's signature on a company document
async function sendSig(req, res) {
  const f = (await pool.query("SELECT mime, bytes FROM vos_docs WHERE user_id=$1 AND kind='signature' ORDER BY created_at DESC LIMIT 1", [String(req.query.uid || '')])).rows[0];
  need(f, 404, 'not found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.status(200).send(f.bytes);
}


/* ---------- time clock (เข้างาน / ออกงาน), presence and work-hours location ----------
   All times come from the server clock. Location is stored only while the person is clocked in,
   kept 60 days, and readable only by the CEO. */
const BKK_DAY = "(now() AT TIME ZONE 'Asia/Bangkok')::date";
const loc = b => {
  const l = b && b.loc; if (!l) return [null, null, null];
  const lat = Number(l.lat), lng = Number(l.lng), acc = Number(l.acc);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [null, null, null];
  return [lat, lng, isFinite(acc) ? Math.min(acc, 1e6) : null];
};
const openShift = async uid => (await pool.query('SELECT * FROM vos_attendance WHERE user_id=$1 AND out_at IS NULL ORDER BY in_at DESC LIMIT 1', [uid])).rows[0] || null;

A.ping = async (req, res, me, b) => {
  await pool.query('UPDATE vos_users SET last_seen=now() WHERE id=$1', [me.id]);
  const open = await openShift(me.id);
  const [lat, lng, acc] = loc(b);
  if (open && lat !== null) {
    const last = (await pool.query('SELECT at FROM vos_locations WHERE user_id=$1 ORDER BY at DESC LIMIT 1', [me.id])).rows[0];
    if (!last || Date.now() - new Date(last.at).getTime() > 60000)
      await pool.query('INSERT INTO vos_locations(user_id,lat,lng,acc) VALUES($1,$2,$3,$4)', [me.id, lat, lng, acc]);
  }
  return { open };
};
const NO_CLOCK = ['accounting'];   // owner sheet A-01 / A-02: Accounts does not use the time clock
A.clockIn = async (req, res, me, b) => {
  need(!NO_CLOCK.includes(me.role), 403, 'บทบาทนี้ไม่ต้องลงเวลาเข้า-ออกงาน');
  need(!(await openShift(me.id)), 409, 'ลงเวลาเข้างานไว้แล้ว');
  const [lat, lng, acc] = loc(b);
  const r = await pool.query(`INSERT INTO vos_attendance(user_id,day,in_lat,in_lng,in_acc) VALUES($1,${BKK_DAY},$2,$3,$4) RETURNING *`, [me.id, lat, lng, acc]);
  if (lat !== null) await pool.query('INSERT INTO vos_locations(user_id,lat,lng,acc) VALUES($1,$2,$3,$4)', [me.id, lat, lng, acc]);
  await pool.query('UPDATE vos_users SET last_seen=now() WHERE id=$1', [me.id]);
  await pool.query("DELETE FROM vos_locations WHERE at < now() - interval '60 days'");
  return { open: r.rows[0] };
};
A.clockOut = async (req, res, me, b) => {
  const open = await openShift(me.id);
  need(open, 409, 'ยังไม่ได้ลงเวลาเข้างาน');
  const [lat, lng, acc] = loc(b);
  await pool.query('UPDATE vos_attendance SET out_at=now(), out_lat=$2, out_lng=$3, out_acc=$4 WHERE id=$1', [open.id, lat, lng, acc]);
  return { open: null };
};
A.myAttendance = async (req, res, me) => (NO_CLOCK.includes(me.role) ? { rows: [] } : {
  rows: (await pool.query(`SELECT * FROM vos_attendance WHERE user_id=$1 AND day >= ${BKK_DAY} - 31 ORDER BY in_at DESC`, [me.id])).rows,
});
// CEO: everyone's presence + one day's clock records + latest location
A.attendance = async (req, res, me, b) => {
  need(V.isCEO(me), 403, 'เฉพาะ CEO');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : null;
  const [u, a, l] = await Promise.all([
    pool.query("SELECT id,name,role,last_seen FROM vos_users WHERE active AND NOT coalesce((profile->>'deleted')::boolean,false) ORDER BY name"),
    pool.query(`SELECT * FROM vos_attendance WHERE day = coalesce($1::date, ${BKK_DAY}) ORDER BY in_at`, [day]),
    pool.query(`SELECT DISTINCT ON (user_id) user_id, at, lat, lng, acc FROM vos_locations
                WHERE (at AT TIME ZONE 'Asia/Bangkok')::date = coalesce($1::date, ${BKK_DAY}) ORDER BY user_id, at DESC`, [day]),
  ]);
  return { now: new Date().toISOString(), users: u.rows, rows: a.rows, last: l.rows };
};
A.track = async (req, res, me, b) => {
  need(V.isCEO(me), 403, 'เฉพาะ CEO');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : null;
  return { points: (await pool.query(`SELECT at, lat, lng, acc FROM vos_locations WHERE user_id=$1
    AND (at AT TIME ZONE 'Asia/Bangkok')::date = coalesce($2::date, ${BKK_DAY}) ORDER BY at`, [String(b.uid || ''), day])).rows };
};
async function sendDoc(req, res, me) {
  need(DOC_ROLES.includes(me.role), 404, 'not found');
  const f = (await pool.query('SELECT * FROM vos_docs WHERE id=$1', [String(req.query.id || '')])).rows[0];
  need(f, 404, 'not found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(f.bytes);
}

const PUBLIC = new Set(['login', 'logout']);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await V.ensureVos();
    const me = await V.sessionUser(req);
    if (req.method === 'GET' && req.query.a === 'doc') { need(me, 401, 'login required'); return await sendDoc(req, res, me); }
    if (req.method === 'GET' && req.query.a === 'sig') { need(me, 401, 'login required'); return await sendSig(req, res); }
    need(req.method === 'POST', 405, 'POST only');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const fn = Object.prototype.hasOwnProperty.call(A, b.a) && A[b.a];
    need(fn, 400, 'unknown action');
    if (!PUBLIC.has(b.a)) need(me, 401, 'login required');
    res.status(200).json(await fn(req, res, me, b));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error('/api/auth', e);
    res.status(code).json({ error: e.message, code });
  }
};
