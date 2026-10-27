'use strict';
// Server-side role permissions for /api/state (owner's tick-box sheet, 2026-10-27).
// The app sends its whole state on every save; the server keeps its own copy and takes
// only the changes this user's role may make. Anything else stays as it was on the server.
//
// VYNN·OS role keys: admin = CEO · sales_support = Admin · manager = PM · online_sales = เซลล์ออนไลน์
// sales = Sales · installer = Staff (ช่าง) · hr = Staff (สำนักงาน) · accounting = Accounts

const CEO = 'admin', ADM = 'sales_support', PM = 'manager', ONL = 'online_sales', SAL = 'sales', INS = 'installer', ACC = 'accounting';
const is = (u, ...roles) => !!u && roles.includes(u.role);

const leadMap = st => new Map(((st && st.leads) || []).filter(Boolean).map(l => [l.id, l]));
const ownLead = (u, l) => !!l && (u.role === ONL ? l.onlineBy === u.id : (l.createdBy === u.id || l.assignedTo === u.id));
// money: CEO, Admin, PM and Accounts see every deal; online / field sales only their own customers
const seesAllMoney = u => is(u, CEO, ADM, PM, ACC);
const seesHR = u => is(u, CEO, ACC);   // legacy HR tables hold salaries

/* ---------- what a role may read (GET) ---------- */
function redact(state, u) {
  if (!state) return state;
  const s = Object.assign({}, state);
  if (!seesHR(u)) { s.employees = []; s.travelClaims = []; s.attendance = []; s.advances = []; s.payroll = {}; }
  if (!seesAllMoney(u) && is(u, ONL, SAL)) {
    const leads = leadMap(s);
    const mine = q => ownLead(u, leads.get(q && q.leadId));
    s.quotes = (s.quotes || []).filter(mine);
    const keep = new Set(s.quotes.map(q => q.id));
    s.payments = Object.fromEntries(Object.entries(s.payments || {}).filter(([k]) => keep.has(k)));
  }
  return s;
}

/* ---------- what a role may change (PUT) ----------
   add(u, rec, ctx) · edit(u, before, after, ctx) · del(u, rec, ctx); missing = not allowed.
   fix(u, before, after) may put back fields the role may not touch. */
const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (o && o[k] !== undefined) r[k] = o[k]; }); return r; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keepFields(before, after, keys) {
  const out = Object.assign({}, after);
  keys.forEach(k => { if (before && k in before) out[k] = before[k]; else delete out[k]; });
  return out;
}

const RULES = {
  leads: {
    add: u => is(u, CEO, ADM, PM, ONL, SAL),
    edit: (u, b) => is(u, CEO, ADM, PM) || (is(u, ONL, SAL) && ownLead(u, b)),
    del: u => is(u, CEO, PM),
    fix(u, b, a) {
      let r = a;
      if (!is(u, CEO, ADM)) {
        // เซลล์ออนไลน์ผู้รับลีด: CEO / Admin only (an online seller's own new lead is stamped with their id)
        if (!b && is(u, ONL)) r = Object.assign({}, r, { onlineBy: u.id });
        else r = keepFields(b, r, ['onlineBy']);
      }
      if (b && !is(u, CEO, ADM, PM)) r = keepFields(b, r, ['pmId']);
      if (b && !is(u, CEO, ADM, PM, ONL)) r = keepFields(b, r, ['assignedTo']);
      if (b && !is(u, CEO)) r = keepFields(b, r, ['createdBy']);
      else if (!b && is(u, ONL, SAL)) r = Object.assign({}, r, { createdBy: u.id });
      return r;
    },
  },
  surveys: {
    add: (u, a, c) => is(u, CEO, PM) || (is(u, SAL) && ownLead(u, c.lead(a.leadId))),
    edit: (u, b, a, c) => is(u, CEO, PM) || (is(u, SAL) && ownLead(u, c.lead(b.leadId))),
    del: u => is(u, CEO, PM),
  },
  quotes: {
    add: u => is(u, CEO, ADM, PM),
    edit: u => is(u, CEO, ADM, PM),
    del: u => is(u, CEO, PM),
    fix(u, b, a) {
      // only CEO and PM approve a quotation
      if (is(u, CEO, PM)) return a;
      const was = (b && b.status) || 'draft', now = a.status;
      const approving = (now === 'approved' && was !== 'approved') || !same((b || {}).approvedBy || null, a.approvedBy || null);
      return approving ? keepFields(b, a, ['status', 'approvedBy', 'approvedAt']) : a;
    },
  },
  installs: {
    add: u => is(u, CEO, ADM, PM),
    // ช่าง: record unfinished work (sign-off "not finished") only, never close the job
    edit: (u, b, a) => is(u, CEO, ADM, PM) ||
      (is(u, INS) && b.status !== 'done' && (a.status === b.status || a.status === 'incomplete') &&
        (!a.signOff || a.signOff.mode === 'incomplete') &&
        same(Object.assign({}, b, pick(a, ['signOff', 'status'])), a)),
    del: u => is(u, CEO, ADM, PM),
  },
  tickets: {
    add: (u, a) => is(u, CEO, ADM, PM, ONL) || (is(u, INS) && a.type === 'punch'),
    edit: u => is(u, CEO, ADM, PM, ONL),
    del: u => is(u, CEO),
  },
  fabricOrders: 'ops', sewing: 'ops', chinaLots: 'ops',
  employees: 'ceo', accounts: 'ceo', travelClaims: 'ceo',
};
const OPS = { add: u => is(u, CEO, ADM, PM), edit: u => is(u, CEO, ADM, PM), del: u => is(u, CEO, ADM, PM) };
const ONLY_CEO = { add: u => is(u, CEO), edit: u => is(u, CEO), del: u => is(u, CEO) };
const ruleOf = k => { const r = RULES[k]; return r === 'ops' ? OPS : r === 'ceo' ? ONLY_CEO : r; };

function mergeById(key, before, after, u, ctx, report) {
  const rule = ruleOf(key);
  const b = new Map((before || []).filter(Boolean).map(r => [r.id, r]));
  const a = new Map((Array.isArray(after) ? after : []).filter(r => r && r.id != null).map(r => [r.id, r]));
  const out = (Array.isArray(after) ? after : []).filter(r => r && r.id == null && rule.add && rule.add(u, r, ctx));
  for (const [id, rec] of a) {
    const old = b.get(id);
    if (old && same(old, rec)) { out.push(old); continue; }
    const ok = old ? rule.edit && rule.edit(u, old, rec, ctx) : rule.add && rule.add(u, rec, ctx);
    if (!ok) { report(key, id, old ? 'edit' : 'add'); if (old) out.push(old); continue; }
    const fixed = rule.fix ? rule.fix(u, old, rec) : rec;
    if (!same(fixed, rec)) report(key, id, 'field');
    out.push(fixed);
  }
  for (const [id, old] of b) {
    if (a.has(id)) continue;
    if (rule.del && rule.del(u, old, ctx)) continue;
    // a record this role cannot see (or may not delete) is never removed by its save
    if (!(ctx.hidden[key] && ctx.hidden[key].has(id))) report(key, id, 'delete');
    out.push(old);
  }
  return out;
}

function mergeMapByKey(name, before, after, canWrite, report, canSee) {
  if (canWrite) return after || (Array.isArray(before) ? [] : {});
  if (canSee && !same(before || {}, after || {})) report(name, '*', 'edit');
  return before || {};
}

/* the state to save = the server copy + this user's permitted changes */
function mergeState(before, after, u) {
  const denied = [];
  const report = (k, id, what) => { if (denied.length < 50) denied.push(k + ':' + id + ':' + what); };
  before = before || {};
  const vis = redact(before, u);
  const hidden = {};
  ['quotes', 'employees', 'travelClaims'].forEach(k => {
    const shown = new Set((vis[k] || []).map(r => r && r.id));
    hidden[k] = new Set((before[k] || []).filter(r => r && !shown.has(r.id)).map(r => r.id));
  });
  const beforeLeads = leadMap(before), afterLeads = leadMap(after);
  const ctx = { hidden, lead: id => beforeLeads.get(id) || afterLeads.get(id) };
  const out = Object.assign({}, after);

  for (const key of ['leads', 'surveys', 'quotes', 'installs', 'tickets', 'fabricOrders', 'sewing', 'chinaLots', 'employees', 'accounts', 'travelClaims'])
    out[key] = mergeById(key, before[key], after[key], u, ctx, report);
  for (const key of ['attendance', 'advances', 'monthly']) out[key] = mergeMapByKey(key, before[key], after[key], is(u, CEO), report, key === 'monthly' || seesHR(u));
  out.payroll = mergeMapByKey('payroll', before.payroll, after.payroll, is(u, CEO), report, seesHR(u));

  // payments (งวดชำระ): CEO / Admin / PM; a role that cannot see a quote never touches its payments
  if (is(u, CEO, ADM, PM)) out.payments = after.payments || {};
  else {
    out.payments = before.payments || {};
    if (!same(redact(before, u).payments || {}, after.payments || {})) report('payments', '*', 'edit');
  }

  // app_meta
  out.prices = is(u, CEO, ADM, PM) || after.prices === undefined ? after.prices : (report('prices', '*', 'edit'), before.prices);
  if (out.prices === undefined) delete out.prices;
  out.company = is(u, CEO) ? after.company : before.company;
  if (!is(u, CEO) && after.company !== undefined && !same(before.company, after.company)) report('company', '*', 'edit');
  if (out.company === undefined) delete out.company;
  // id counters only move forward, whoever saves
  if (after.seq || before.seq) {
    const sq = Object.assign({}, before.seq || {});
    Object.entries(after.seq || {}).forEach(([k, v]) => { if (typeof v === 'number' && !(sq[k] >= v)) sq[k] = v; });
    out.seq = sq;
  }
  // แผนงาน: each person their own tasks; CEO everyone's
  if (after.agenda !== undefined || before.agenda !== undefined) {
    if (is(u, CEO)) out.agenda = after.agenda || [];
    else {
      const mine = t => t && t.uid === u.id;
      const a = (Array.isArray(after.agenda) ? after.agenda : []).filter(mine);
      const others = (before.agenda || []).filter(t => !mine(t));
      if ((Array.isArray(after.agenda) ? after.agenda : []).some(t => !mine(t) && !(before.agenda || []).some(o => same(o, t)))) report('agenda', '*', 'edit');
      out.agenda = others.concat(a);
    }
  }
  // รูปโปรไฟล์: own entry only; CEO everyone's
  if (after.profiles !== undefined || before.profiles !== undefined) {
    if (is(u, CEO)) out.profiles = after.profiles || {};
    else {
      const p = Object.assign({}, before.profiles || {});
      if (after.profiles && after.profiles[u.id] !== undefined) p[u.id] = after.profiles[u.id];
      out.profiles = p;
    }
  }
  // keys PR #3 adds to app_meta: audit log only grows; Vangarde prices CEO / Admin / PM; the rest CEO
  if (before.audit !== undefined || after.audit !== undefined) {
    const seen = new Set((before.audit || []).map(e => JSON.stringify(e)));
    out.audit = (before.audit || []).concat((Array.isArray(after.audit) ? after.audit : []).filter(e => !seen.has(JSON.stringify(e))));
  }
  for (const [k, ok] of [['vgPricing', is(u, CEO, ADM, PM)], ['salesHist', is(u, CEO)], ['expenses', is(u, CEO)]]) {
    if (ok || (before[k] === undefined && after[k] === undefined)) continue;
    if (after[k] !== undefined && !same(before[k], after[k])) report(k, '*', 'edit');
    if (before[k] === undefined) delete out[k]; else out[k] = before[k];
  }
  return { state: out, denied };
}

module.exports = { redact, mergeState };
