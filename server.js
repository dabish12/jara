'use strict';
/* =====================================================================
   DDEO-SRATMS server (Node.js 22.5+ , no packages to install)
   All security lives here and in the database file, not in the web page:
   - passwords are stored only as salted scrypt hashes in the accounts table
   - sign-in creates a random session; the browser only holds an HttpOnly cookie
   - every request is checked against the signed-in role; each role receives only the
     data it may see and may change only the data it may change
   - sign-in and student pages are rate limited in the database
   Start:  node server.js      then open http://localhost:8080
   ===================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'ddeo.db');
const SECURE = process.env.SECURE_COOKIES === '1';
const SESSION_MIN = 15, MAX_BODY = 25 * 1024 * 1024, MAX_TRIES = 5, LOCK_SECONDS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const GRADES = ['9', '10', '11', '12'], STREAMS = ['Natural Science', 'Social Science'];
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('super','school','staff')),
  ref_id TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, ref_id));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, lvl INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL);
`);

/* ---------- small helpers ---------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m) => new HttpError(400, m), forbid = (m) => new HttpError(403, m || 'You are not allowed to do this.');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const round1 = (x) => Math.round(x * 10) / 10;
const numOrNull = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const audit = (who, what) => db.prepare('INSERT INTO audit(at, who, what) VALUES (?,?,?)').run(new Date().toISOString(), who, str(what, 300));

function pwHash(pw) {
  const salt = crypto.randomBytes(16);
  return 'sc1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 32, SCRYPT).toString('hex');
}
function pwVerify(pw, stored) {
  const p = String(stored).split('$');
  if (p[0] !== 'sc1' || p.length !== 3) return false;
  const h = crypto.scryptSync(pw, Buffer.from(p[1], 'hex'), 32, SCRYPT), want = Buffer.from(p[2], 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const DUMMY_HASH = pwHash('dummy-password-1');
function pwProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'The password needs at least 8 characters.';
  if (p.length > 100) return 'The password is too long.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use both letters and numbers in the password.';
  return '';
}

/* ---------- rate limit kept in the database ---------- */
function thLocked(k) { const r = db.prepare('SELECT until FROM throttle WHERE k = ?').get(k); return r && r.until > now() ? Math.ceil((r.until - now()) / 1000) : 0; }
function thFail(k) {
  const r = db.prepare('SELECT n, lvl FROM throttle WHERE k = ?').get(k) || { n: 0, lvl: 0 };
  let n = r.n + 1, lvl = r.lvl, until = 0;
  if (n >= MAX_TRIES) { n = 0; lvl = Math.min(lvl + 1, 8); until = now() + LOCK_SECONDS * 1000 * Math.pow(2, lvl - 1); }
  db.prepare('INSERT INTO throttle(k, n, lvl, until) VALUES (?,?,?,?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, lvl = excluded.lvl, until = excluded.until').run(k, n, lvl, until);
}
function thOk(k) { db.prepare('DELETE FROM throttle WHERE k = ?').run(k); }

/* ---------- application data (same shape the web page uses) ---------- */
function emptyState() { return { version: 3, schools: [], students: [], marks: {}, parts: {}, log: [], settings: { registration: { year: '', start: '', end: '' } } }; }
function loadState() {
  const r = db.prepare("SELECT value FROM kv WHERE key = 'state'").get();
  const M = r ? JSON.parse(r.value) : emptyState();
  M.settings = M.settings || { registration: { year: '', start: '', end: '' } };
  M.parts = M.parts || {};
  return M;
}
function saveState(M) { db.prepare("INSERT INTO kv(key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(M)); }
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- results maths (same rules as the web page) ---------- */
function calcStudent(M, st, subjects, year) {
  const m = (M.marks[st.id] || {})[year] || {}, a = m['1'] || {}, b = m['2'] || {}, rows = { '1': [], '2': [], AV: [] }, o = {};
  subjects.forEach((sub) => {
    const x = numOrNull(a[sub.id]), y = numOrNull(b[sub.id]);
    rows['1'].push(x); rows['2'].push(y); rows.AV.push(x !== null && y !== null ? round1((x + y) / 2) : null);
  });
  o.rows = rows;
  ['1', '2', 'AV'].forEach((k) => {
    const vals = rows[k].filter((v) => v !== null), total = vals.length ? round1(vals.reduce((p, c) => p + c, 0)) : null;
    o[k] = { total, avg: vals.length ? round1(total / vals.length) : null, rank: null };
  });
  return o;
}
function calcClass(M, list, subjects, year) {
  const out = {};
  list.forEach((st) => { out[st.id] = calcStudent(M, st, subjects, year); });
  ['1', '2', 'AV'].forEach((k) => {
    const ranked = list.map((st) => ({ id: st.id, t: out[st.id][k].total })).filter((x) => x.t !== null).sort((p, q) => q.t - p.t);
    let last = null, rank = 0;
    ranked.forEach((x, i) => { if (x.t !== last) { rank = i + 1; last = x.t; } out[x.id][k].rank = rank; });
  });
  return out;
}
function remarkRow(values, grade) {
  const v = values.filter((x) => x !== null);
  if (!v.length) return '';
  const avg = round1(v.reduce((p, c) => p + c, 0) / v.length), below = v.filter((x) => x < 50).length;
  const ok = below === 0 ? avg >= 50 : below === 1 ? avg >= 52 : below === 2 ? avg >= 54 : false;
  if (String(grade) === '12') return ok ? 'Passed' : 'Failed';
  return ok ? 'Promoted' : 'Detained';
}
function recomputeRanks(M, sc) {
  const year = sc.academicYear, groups = {};
  M.students.filter((s) => s.schoolId === sc.id).forEach((s) => { (groups[s.grade + '|' + s.section] = groups[s.grade + '|' + s.section] || []).push(s); });
  Object.keys(groups).forEach((g) => {
    const list = groups[g], calc = calcClass(M, list, sc.subjects, year);
    list.forEach((st) => {
      st.records = st.records || {};
      const rec = st.records[year] = st.records[year] || {};
      rec.rank = {};
      ['1', '2', 'AV'].forEach((k) => { if (calc[st.id][k].rank !== null) rec.rank[k] = calc[st.id][k].rank; });
      rec.conduct = rec.conduct || {}; rec.absent = rec.absent || {};
    });
  });
}
function windowState(w) {
  if (!w || !w.start || !w.end) return { open: false, text: 'Not set yet' };
  const t = now(), a = new Date(w.start).getTime(), b = new Date(w.end).getTime();
  if (t < a) return { open: false, text: 'Opens ' + w.start.replace('T', ' ') };
  if (t > b) return { open: false, text: 'Closed since ' + w.end.replace('T', ' ') };
  return { open: true, text: 'Open until ' + w.end.replace('T', ' ') };
}

/* ---------- who is signed in ---------- */
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); });
  return o;
}
function findStaff(M, id) {
  for (const sc of M.schools) { const t = (sc.staff || []).find((x) => x.id === id); if (t) return { sc, t }; }
  return null;
}
function principal(req, M) {
  const tok = parseCookies(req).sid;
  if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
  const th = sha(tok);
  const row = db.prepare('SELECT s.last_seen, a.id AS aid, a.kind, a.ref_id, a.username, a.must_change FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?').get(th);
  if (!row) return null;
  if (now() - row.last_seen > SESSION_MIN * 60000) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th); return null; }
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), th);
  const P = { accountId: row.aid, user: row.username, mustChange: !!row.must_change, tokenHash: th };
  if (row.kind === 'super') { P.role = 'super'; return P; }
  if (row.kind === 'school') {
    const sc = M.schools.find((s) => s.id === row.ref_id); if (!sc) return null;
    P.role = 'school'; P.schoolId = sc.id; return P;
  }
  const f = findStaff(M, row.ref_id); if (!f) return null;
  P.role = f.t.role; P.schoolId = f.sc.id; P.staffId = f.t.id; P.name = f.t.name; return P;
}
const meOf = (P) => ({ role: P.role, schoolId: P.schoolId || '', staffId: P.staffId || '', user: P.user, name: P.name || '', mustChange: !!P.mustChange });

/* ---------- what each role may see ---------- */
const classMatch = (st, grade, section) => st.grade === grade && (!section || st.section === section);
function staffClasses(t) { return (t.classes || []).map((k) => k.split('|')); }
const inStaffClasses = (st, t) => staffClasses(t).some((p) => classMatch(st, p[0], p[1]));
function publicSchool(sc, withStaff) {
  const o = JSON.parse(JSON.stringify(sc));
  delete o.logoLeft; delete o.logoRight;
  o.staff = (sc.staff || []).map((t) => withStaff(t));
  return o;
}
function viewFor(P, M) {
  const V = emptyState(); V.settings = { registration: M.settings.registration };
  if (P.role === 'super') {
    V.schools = M.schools.map((sc) => publicSchool(sc, (t) => ({ id: t.id, name: t.name, username: '', role: t.role, grade: t.grade, section: t.section, subjectIds: t.subjectIds, classes: t.classes, submittedAt: t.submittedAt, submittedFor: t.submittedFor })));
    V.students = M.students.map((s) => ({ id: s.id, schoolId: s.schoolId, fullName: 'Student', studentId: '', age: '', sex: s.sex, grade: s.grade, section: s.section, stream: s.stream || '', registeredFor: s.registeredFor || '', pendingReg: s.pendingReg ? { year: s.pendingReg.year } : undefined }));
    M.schools.forEach((sc) => M.students.filter((s) => s.schoolId === sc.id).forEach((s) => { const y = (M.marks[s.id] || {})[sc.academicYear]; if (y) { V.marks[s.id] = { [sc.academicYear]: y }; } }));
    V.log = M.log.filter((l) => !/student|mark|conduct|transcript|roster|result|registration/i.test(l.text || '')).slice(-1000);
    return V;
  }
  const sc = M.schools.find((s) => s.id === P.schoolId);
  if (P.role === 'school') {
    V.schools = [JSON.parse(JSON.stringify(sc))];
    V.students = M.students.filter((s) => s.schoolId === sc.id);
    V.students.forEach((s) => { if (M.marks[s.id]) V.marks[s.id] = M.marks[s.id]; if (M.parts[s.id]) V.parts[s.id] = M.parts[s.id]; });
    V.log = M.log.filter((l) => l.schoolId === sc.id).slice(-1000);
    return V;
  }
  const self = (sc.staff || []).find((t) => t.id === P.staffId);
  const vs = publicSchool(sc, (t) => (t.id === P.staffId ? t : { id: t.id, name: t.name, username: '', role: t.role, grade: t.grade, section: t.section, subjectIds: t.subjectIds, classes: t.classes }));
  V.schools = [vs];
  if (P.role === 'homeroom') {
    V.students = M.students.filter((s) => s.schoolId === sc.id && classMatch(s, self.grade, self.section));
    V.students.forEach((s) => { if (M.marks[s.id]) V.marks[s.id] = M.marks[s.id]; });
  } else {
    const subs = new Set(self.subjectIds || []);
    V.students = M.students.filter((s) => s.schoolId === sc.id && inStaffClasses(s, self)).map((s) => ({ id: s.id, schoolId: s.schoolId, fullName: s.fullName, studentId: '', age: '', sex: s.sex, grade: s.grade, section: s.section, stream: '', records: {} }));
    V.students.forEach((s) => {
      const src = M.marks[s.id] || {}, out = {};
      Object.keys(src).forEach((y) => { out[y] = {}; Object.keys(src[y]).forEach((sem) => { out[y][sem] = {}; Object.keys(src[y][sem]).forEach((sub) => { if (subs.has(sub)) out[y][sem][sub] = src[y][sem][sub]; }); }); });
      V.marks[s.id] = out;
      const ps = M.parts[s.id] || {}, po = {};
      Object.keys(ps).forEach((y) => { po[y] = {}; Object.keys(ps[y]).forEach((sem) => { po[y][sem] = {}; Object.keys(ps[y][sem]).forEach((sub) => { if (subs.has(sub)) po[y][sem][sub] = ps[y][sem][sub]; }); }); });
      V.parts[s.id] = po;
    });
  }
  return V;
}

/* ---------- what each role may change ---------- */
const cleanMapNum = (o) => { const r = {}; if (o && typeof o === 'object') Object.keys(o).slice(0, 5).forEach((k) => { const n = numOrNull(o[k]); if (n !== null) r[str(k, 4)] = n; }); return r; };
function cleanRecords(r) {
  const out = {};
  if (r && typeof r === 'object') {
    Object.keys(r).slice(0, 12).forEach((y) => {
      const x = r[y] || {}, c = {}, a = {};
      ['1', '2'].forEach((k) => {
        if (x.conduct && /^[ABC]$/.test(String(x.conduct[k] || ''))) c[k] = x.conduct[k];
        const n = x.absent ? numOrNull(x.absent[k]) : null;
        if (n !== null && Number.isInteger(n) && n >= 0 && n <= 366) a[k] = n;
      });
      out[str(y, 20)] = { rank: cleanMapNum(x.rank), conduct: c, absent: a };
    });
  }
  return out;
}
function cleanStudent(s, sid, old) {
  const g = String(s.grade);
  if (!GRADES.includes(g)) throw bad('A student has an invalid grade.');
  if (s.sex !== 'M' && s.sex !== 'F') throw bad('A student has an invalid sex.');
  const name = str(s.fullName, 80).trim();
  if (name.length < 3) throw bad('A student name is too short.');
  const o = {
    id: str(s.id, 40), schoolId: sid, fullName: name, age: str(String(s.age === undefined || s.age === null ? '' : s.age), 3), sex: s.sex, grade: g, section: str(s.section, 10),
    stream: STREAMS.includes(s.stream) ? s.stream : '', studentId: str(s.studentId, 30), dob: str(s.dob, 30), nationality: str(s.nationality, 40), entryYear: str(s.entryYear, 20),
    createdAt: str(s.createdAt, 40), registeredFor: str(s.registeredFor, 20), registeredAt: str(s.registeredAt, 40), gradeYears: {}, records: cleanRecords(s.records),
    registeredOn: /^\d{4}-\d{2}-\d{2}$/.test(String(s.registeredOn)) ? s.registeredOn : new Date().toISOString().slice(0, 10)
  };
  if (o.studentId && !/^DD\d{3}-\d{4}-\d{4}$/.test(o.studentId)) throw bad('The Student ID ' + o.studentId + ' is not in the form DD001-0001-2026.');
  if (g === '11' && !o.stream) throw bad('Every Grade 11 student must choose Natural Science or Social Science.');
  GRADES.forEach((k) => { const y = s.gradeYears && s.gradeYears[k]; if (y) o.gradeYears[k] = str(y, 20); });
  if (old && old.pendingReg && s.pendingReg) o.pendingReg = old.pendingReg;
  return o;
}
function cleanMarks(obj, subjectIds) {
  const out = {};
  if (obj && typeof obj === 'object') {
    Object.keys(obj).slice(0, 12).forEach((y) => {
      ['1', '2'].forEach((sem) => {
        const src = obj[y] && obj[y][sem];
        if (!src || typeof src !== 'object') return;
        Object.keys(src).forEach((sub) => {
          const n = numOrNull(src[sub]);
          if (subjectIds.has(sub) && n !== null && n >= 0 && n <= 100) { out[y] = out[y] || {}; out[y][sem] = out[y][sem] || {}; out[y][sem][sub] = n; }
        });
      });
    });
  }
  return out;
}
function cleanSubjects(a) {
  if (!Array.isArray(a)) throw bad('Invalid subjects.');
  return a.slice(0, 16).map((s) => ({ id: str(s.id, 40), name: str(s.name, 40).trim() })).filter((s) => s.id && s.name);
}
function cleanStaff(t, old) {
  const o = {
    id: str(t.id, 40), name: str(t.name, 80).trim(), username: str(t.username, 30), role: t.role === 'homeroom' ? 'homeroom' : 'subject', grade: str(t.grade, 2), section: str(t.section, 10),
    subjectIds: Array.isArray(t.subjectIds) ? t.subjectIds.slice(0, 40).map((x) => str(x, 40)) : [], classes: Array.isArray(t.classes) ? t.classes.slice(0, 80).map((x) => str(x, 20)) : [], createdAt: str(t.createdAt, 40)
  };
  if (o.name.length < 3) throw bad('A teacher name is too short.');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(o.username) || o.username.toLowerCase() === 'admin') throw bad('A teacher username is not valid.');
  if (old && old.submittedAt && t.submittedAt) { o.submittedAt = old.submittedAt; o.submittedFor = old.submittedFor; o.submittedSem = old.submittedSem; o.submittedYear = old.submittedYear; }
  o.sealed = old && Array.isArray(old.sealed) ? old.sealed : [];   // only the server adds to this list
  return o;
}
const ASSESS_DEFAULT = { test: 20, mid: 30, final: 50 };
function cleanAssess(a, old) {
  a = a || {};
  const v = [a.test, a.mid, a.final].map(Number);
  if (v.every((x) => Number.isInteger(x) && x >= 0 && x <= 100) && v[0] + v[1] + v[2] === 100) return { test: v[0], mid: v[1], final: v[2] };
  return old || ASSESS_DEFAULT;
}
const PART = { t: 'test', m: 'mid', f: 'final' };
function cleanParts(obj, subjectIds, as) {
  const out = {};
  if (obj && typeof obj === 'object') {
    Object.keys(obj).slice(0, 12).forEach((y) => ['1', '2'].forEach((sem) => {
      const src = obj[y] && obj[y][sem]; if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach((sub) => {
        if (!subjectIds.has(sub) || !src[sub]) return;
        const p = {};
        Object.keys(PART).forEach((k) => { const n = numOrNull(src[sub][k]); if (n !== null && n >= 0 && n <= as[PART[k]]) p[k] = n; });
        if (Object.keys(p).length) { out[y] = out[y] || {}; out[y][sem] = out[y][sem] || {}; out[y][sem][sub] = p; }
      });
    }));
  }
  return out;
}
/* a complete Test + Mid + Final gives the total out of 100; the server computes it, the page cannot choose it */
function totalsFromParts(parts, marks) {
  Object.keys(parts).forEach((y) => Object.keys(parts[y]).forEach((sem) => Object.keys(parts[y][sem]).forEach((sub) => {
    const p = parts[y][sem][sub];
    marks[y] = marks[y] || {}; marks[y][sem] = marks[y][sem] || {};
    if (p.t !== undefined && p.m !== undefined && p.f !== undefined) marks[y][sem][sub] = round1(p.t + p.m + p.f); else delete marks[y][sem][sub];
  })));
}
function sealedKeys(sc, st) {
  const keys = new Set();
  (sc.staff || []).forEach((t) => {
    if (t.role !== 'subject' || !inStaffClasses(st, t)) return;
    (t.sealed || []).forEach((x) => (t.subjectIds || []).forEach((sub) => keys.add(x.year + '|' + x.sem + '|' + sub)));
  });
  return keys;
}
function applySealed(sc, st, M, newMarks, newParts) {
  sealedKeys(sc, st).forEach((k) => {
    const [y, sem, sub] = k.split('|');
    const om = (((M.marks[st.id] || {})[y] || {})[sem] || {})[sub], op = (((M.parts[st.id] || {})[y] || {})[sem] || {})[sub];
    const put = (root, v) => { if (v === undefined) { if (root[y] && root[y][sem]) delete root[y][sem][sub]; } else { root[y] = root[y] || {}; root[y][sem] = root[y][sem] || {}; root[y][sem][sub] = v; } };
    put(newMarks, om); put(newParts, op === undefined ? undefined : JSON.parse(JSON.stringify(op)));
  });
}
function cleanRelease(r) {
  r = r || {};
  return { start: str(r.start, 20), end: str(r.end, 20), sem: ['all', '1', '2'].includes(r.sem) ? r.sem : 'all' };
}
function cleanLogo(v, old) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 400000) return v;
  return old;
}
function newLog(P, M, S) {
  const seen = new Set(M.log.map((l) => l.t + '|' + l.text));
  const add = (S.log || []).filter((l) => l && typeof l.text === 'string' && !seen.has(l.t + '|' + l.text)).slice(-50);
  add.forEach((l) => M.log.push({ t: new Date().toISOString(), user: P.user, schoolId: P.schoolId || str(l.schoolId, 40), text: str(l.text, 300) }));
  if (M.log.length > 1000) M.log = M.log.slice(-1000);
}
function usernameUsed(M, username, except) {
  const u = username.toLowerCase();
  if (u === 'admin') return true;
  for (const sc of M.schools) {
    if (sc.adminUser.toLowerCase() === u && except !== 's:' + sc.id) return true;
    for (const t of sc.staff || []) if (t.username.toLowerCase() === u && except !== 't:' + t.id) return true;
  }
  return false;
}
function assertUniqueIds(M) {
  const seen = new Set();
  M.students.forEach((s) => { if (seen.has(s.studentId.toLowerCase())) throw bad('The Student ID ' + s.studentId + ' is already used.'); seen.add(s.studentId.toLowerCase()); });
  const names = new Map();
  M.schools.forEach((sc) => {
    const u = sc.adminUser.toLowerCase(); if (names.has(u)) throw bad('The username ' + sc.adminUser + ' is already used.'); names.set(u, 1);
    (sc.staff || []).forEach((t) => { const x = t.username.toLowerCase(); if (names.has(x) || x === 'admin') throw bad('The username ' + t.username + ' is already used.'); names.set(x, 1); });
  });
}
function assignMissingIds(M, sc) {
  M.students.filter((s) => s.schoolId === sc.id && !s.studentId).forEach((s) => {
    let id; do { sc.nextSeq = (sc.nextSeq || 0) + 1; id = 'DD' + sc.code + '-' + ('0000' + sc.nextSeq).slice(-4) + '-' + s.registeredOn.slice(0, 4); } while (M.students.some((x) => x.studentId === id));
    s.studentId = id;
  });
}

function mergeSuper(P, M, S) {
  const old = JSON.parse(JSON.stringify(M)), keep = new Map(M.schools.map((s) => [s.id, s]));
  const next = [];
  (S.schools || []).slice(0, 500).forEach((x) => {
    const ex = keep.get(x.id);
    if (ex) {
      ex.name = str(x.name, 80).trim() || ex.name; ex.academicYear = str(x.academicYear, 20) || ex.academicYear; ex.adminUser = str(x.adminUser, 30) || ex.adminUser;
      next.push(ex);
    } else {
      const name = str(x.name, 80).trim(), user = str(x.adminUser, 30);
      if (name.length < 3) throw bad('Enter the school name.');
      if (!/^[A-Za-z0-9._-]{6,30}$/.test(user)) throw bad('The admin username needs 6-30 letters or numbers.');
      next.push({
        id: str(x.id, 40), name, academicYear: str(x.academicYear, 20) || '2026/2027', adminUser: user, passMark: 50, code: str(x.code, 3), nextSeq: 0, town: str(x.town, 40), region: str(x.region, 40),
        recordOfficer: '', director: '', subjects: cleanSubjects(x.subjects || []), staff: [], release: { start: '', end: '', sem: 'all' }, assess: ASSESS_DEFAULT
      });
    }
  });
  const ids = new Set(next.map((s) => s.id));
  old.schools.forEach((s) => { if (!ids.has(s.id)) { M.students.filter((t) => t.schoolId === s.id).forEach((t) => { delete M.marks[t.id]; }); M.students = M.students.filter((t) => t.schoolId !== s.id); M.log = M.log.filter((l) => l.schoolId !== s.id); } });
  M.schools = next;
  const codes = new Set(); M.schools.forEach((s) => { if (!/^\d{3}$/.test(s.code) || codes.has(s.code)) throw bad('A school code is invalid or repeated.'); codes.add(s.code); });
  const r = S.settings && S.settings.registration;
  if (r) M.settings.registration = { year: str(r.year, 20), start: str(r.start, 20), end: str(r.end, 20) };
  newLog(P, M, S);
}
function mergeSchool(P, M, S) {
  const sc = M.schools.find((s) => s.id === P.schoolId), x = (S.schools || []).find((s) => s.id === sc.id);
  if (!x) throw bad('Missing school data.');
  sc.academicYear = str(x.academicYear, 20) || sc.academicYear; sc.town = str(x.town, 40); sc.region = str(x.region, 40);
  sc.recordOfficer = str(x.recordOfficer, 60); sc.director = str(x.director, 60);
  sc.subjects = cleanSubjects(x.subjects); sc.release = cleanRelease(x.release); sc.assess = cleanAssess(x.assess, sc.assess); sc.nextSeq = Math.max(sc.nextSeq || 0, Number(x.nextSeq) || 0);
  ['logoLeft', 'logoRight'].forEach((k) => { const v = cleanLogo(x[k], sc[k]); if (v) sc[k] = v; else delete sc[k]; });
  const oldStaff = new Map((sc.staff || []).map((t) => [t.id, t]));
  sc.staff = (x.staff || []).slice(0, 300).map((t) => cleanStaff(t, oldStaff.get(t.id)));
  const subjIds = new Set(sc.subjects.map((s) => s.id));
  sc.staff.forEach((t) => { t.subjectIds = t.subjectIds.filter((i) => subjIds.has(i)); });
  // students
  const oldById = new Map(M.students.filter((s) => s.schoolId === sc.id).map((s) => [s.id, s]));
  const mine = (S.students || []).slice(0, 20000).filter((s) => s && s.schoolId === sc.id).map((s) => cleanStudent(s, sc.id, oldById.get(s.id)));
  const keepIds = new Set(mine.map((s) => s.id));
  oldById.forEach((s, id) => { if (!keepIds.has(id)) { delete M.marks[id]; delete M.parts[id]; } });
  M.students = M.students.filter((s) => s.schoolId !== sc.id).concat(mine);
  assignMissingIds(M, sc);
  mine.forEach((s) => {
    const m = cleanMarks(S.marks && S.marks[s.id], subjIds), p = cleanParts(S.parts && S.parts[s.id], subjIds, sc.assess);
    totalsFromParts(p, m);
    applySealed(sc, s, M, m, p);          // results submitted by a subject teacher cannot be changed by the school admin
    if (Object.keys(m).length) M.marks[s.id] = m; else delete M.marks[s.id];
    if (Object.keys(p).length) M.parts[s.id] = p; else delete M.parts[s.id];
  });
  recomputeRanks(M, sc);
  newLog(P, M, S);
}
function mergeHomeroom(P, M, S) {
  const f = findStaff(M, P.staffId), sc = f.sc, t = f.t;
  M.students.filter((s) => s.schoolId === sc.id && classMatch(s, t.grade, t.section)).forEach((st) => {
    const inc = (S.students || []).find((x) => x.id === st.id); if (!inc) return;
    const rec = cleanRecords(inc.records);
    st.records = st.records || {};
    Object.keys(rec).forEach((y) => {
      const cur = st.records[y] = st.records[y] || { rank: {}, conduct: {}, absent: {} };
      cur.conduct = rec[y].conduct; cur.absent = rec[y].absent;
    });
  });
  newLog(P, M, S);
}
function mergeSubject(P, M, S) {
  const f = findStaff(M, P.staffId), sc = f.sc, t = f.t, year = sc.academicYear;
  if (t.submittedAt) throw forbid('Your results were submitted and your account is deactivated. Ask the school admin to reset it.');
  const subs = new Set((t.subjectIds || []).filter((i) => sc.subjects.some((s) => s.id === i)));
  let changed = false;
  M.students.filter((s) => s.schoolId === sc.id && inStaffClasses(s, t)).forEach((st) => {
    const incP = cleanParts(S.parts && S.parts[st.id], subs, sc.assess);
    ['1', '2'].forEach((sem) => {
      subs.forEach((sub) => {
        const p = (((incP[year] || {})[sem]) || {})[sub];
        M.parts[st.id] = M.parts[st.id] || {}; M.parts[st.id][year] = M.parts[st.id][year] || {}; M.parts[st.id][year][sem] = M.parts[st.id][year][sem] || {};
        M.marks[st.id] = M.marks[st.id] || {}; M.marks[st.id][year] = M.marks[st.id][year] || {}; M.marks[st.id][year][sem] = M.marks[st.id][year][sem] || {};
        const before = JSON.stringify([M.parts[st.id][year][sem][sub], M.marks[st.id][year][sem][sub]]);
        if (!p) { delete M.parts[st.id][year][sem][sub]; delete M.marks[st.id][year][sem][sub]; }
        else {
          M.parts[st.id][year][sem][sub] = p;
          if (p.t !== undefined && p.m !== undefined && p.f !== undefined) { M.marks[st.id][year][sem][sub] = round1(p.t + p.m + p.f); st.gradeYears = st.gradeYears || {}; st.gradeYears[st.grade] = year; }
          else delete M.marks[st.id][year][sem][sub];
        }
        if (before !== JSON.stringify([M.parts[st.id][year][sem][sub], M.marks[st.id][year][sem][sub]])) changed = true;
      });
    });
  });
  const selfIn = ((S.schools || [])[0] && (S.schools[0].staff || []).find((x) => x.id === t.id)) || null;
  if (selfIn && selfIn.submittedAt) {
    const sem = ['1', '2'].includes(selfIn.submittedSem) ? selfIn.submittedSem : '1', at = new Date().toISOString();
    t.submittedAt = at; t.submittedSem = sem; t.submittedYear = year; t.submittedFor = str(selfIn.submittedFor, 60);
    t.sealed = (t.sealed || []).filter((x) => !(x.year === year && x.sem === sem)).concat([{ year, sem, at }]);
  }
  if (changed) recomputeRanks(M, sc);
  newLog(P, M, S);
}
function syncAccounts(M) {
  const want = new Map();
  M.schools.forEach((sc) => { want.set('school|' + sc.id, sc.adminUser); (sc.staff || []).forEach((t) => want.set('staff|' + t.id, t.username)); });
  db.prepare('SELECT id, kind, ref_id, username FROM accounts WHERE kind != ?').all('super').forEach((a) => {
    const k = a.kind + '|' + a.ref_id;
    if (!want.has(k)) db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    else if (want.get(k).toLowerCase() !== a.username.toLowerCase()) db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run(want.get(k), a.id);
  });
}
function mergeFor(P, M, S) {
  if (!S || typeof S !== 'object') throw bad('No data.');
  if (P.mustChange) throw forbid('Change your password first.');
  if (P.role === 'super') mergeSuper(P, M, S);
  else if (P.role === 'school') mergeSchool(P, M, S);
  else if (P.role === 'homeroom') mergeHomeroom(P, M, S);
  else if (P.role === 'subject') mergeSubject(P, M, S);
  else throw forbid();
  assertUniqueIds(M);
}

/* ---------- public pages for students ---------- */
function firstName(s) { return s.fullName.trim().split(/\s+/)[0].toLowerCase(); }
function pubFind(M, id, name) {
  id = str(id, 30).trim().toLowerCase(); name = str(name, 40).trim().toLowerCase();
  if (!id || !name) return null;
  const st = M.students.find((s) => (s.studentId || '').toLowerCase() === id);
  return st && firstName(st) === name ? st : null;
}
function pubGuard(req, M, body, fn) {
  const ip = req.socket.remoteAddress || 'x', k1 = 'pub|' + ip, k2 = 'pubid|' + str(body.id, 30).toLowerCase();
  const wait = Math.max(thLocked(k1), thLocked(k2));
  if (wait) throw new HttpError(429, 'Too many wrong attempts. Try again in ' + wait + ' seconds.');
  const st = pubFind(M, body.id, body.name);
  if (!st) { thFail(k1); thFail(k2); const w = Math.max(thLocked(k1), thLocked(k2)); throw new HttpError(w ? 429 : 401, w ? 'Too many wrong attempts. Try again in ' + w + ' seconds.' : 'The Student ID and the first name do not match.'); }
  thOk(k1); thOk(k2);
  return fn(st, M.schools.find((s) => s.id === st.schoolId));
}
function resultFor(M, st, sc) {
  const ws = windowState(sc.release);
  if (!ws.open) throw new HttpError(403, 'Results are not open now. ' + ws.text + '.');
  const year = sc.academicYear, mode = (sc.release && sc.release.sem) || 'all', cols = mode === 'all' ? ['1', '2', 'AV'] : [mode];
  const peers = M.students.filter((s) => s.schoolId === sc.id && s.grade === st.grade && s.section === st.section), calc = calcClass(M, peers, sc.subjects, year), c = calc[st.id], rec = ((st.records || {})[year]) || {};
  const rows = sc.subjects.map((sub, i) => ({ name: sub.name, v: { '1': c.rows['1'][i], '2': c.rows['2'][i], AV: c.rows.AV[i] } })).filter((r) => cols.some((k) => r.v[k] !== null));
  const sum = (f) => { const o = {}; cols.forEach((k) => { o[k] = f(k); }); return o; };
  const ab = rec.absent || {};
  return {
    ok: true, student: { fullName: st.fullName, studentId: st.studentId, grade: st.grade, section: st.section }, school: sc.name, year, cols, rows,
    summary: {
      total: sum((k) => c[k].total), avg: sum((k) => c[k].avg), rank: sum((k) => c[k].rank), remark: sum((k) => (c[k].total === null ? '' : remarkRow(c.rows[k], st.grade))),
      conduct: sum((k) => (k === 'AV' ? '' : (rec.conduct || {})[k] || '')), absent: sum((k) => (k === 'AV' ? (ab['1'] === undefined && ab['2'] === undefined ? '' : (ab['1'] || 0) + (ab['2'] || 0)) : ab[k] === undefined ? '' : ab[k]))
    }
  };
}
function regInfo(M, st, sc) {
  const reg = M.settings.registration, ws = windowState(reg);
  if (!ws.open) throw new HttpError(403, 'Registration is not open now. ' + ws.text + '.');
  if (st.registeredFor === reg.year) return { message: 'You are already registered for ' + reg.year + ' in Grade ' + st.grade + '.' };
  if (st.pendingReg && st.pendingReg.year === reg.year) return { message: 'Your registration for Grade ' + st.pendingReg.grade + ' was sent. It is waiting for the school admin to approve it.' };
  const calc = calcStudent(M, st, sc.subjects, sc.academicYear), rk = remarkRow(calc.rows.AV, st.grade);
  if (!rk) return { message: 'Your results for ' + sc.academicYear + ' are not complete yet. Please see your school office.' };
  if (rk === 'Passed') return { message: 'You have completed Grade 12. Congratulations.' };
  const target = rk === 'Promoted' ? Number(st.grade) + 1 : Number(st.grade);
  if (target < 10) return { message: 'Grade 9 students are registered by the school admin. Please see your school office.' };
  return { target, remark: rk, year: reg.year, school: sc.name, fullName: st.fullName, grade: st.grade };
}

/* ---------- http plumbing ---------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'Too much data.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(bad('Invalid data.')); } });
    req.on('error', reject);
  });
}
function secHeaders(extra) {
  const h = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
  if (SECURE) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return Object.assign(h, extra || {});
}
const cookie = (tok, maxAge) => 'sid=' + tok + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge + (SECURE ? '; Secure' : '');

async function api(req, res, url) {
  if (req.method === 'GET' && url === '/api/ping') return send(res, 200, { server: true }, secHeaders());
  if (req.method !== 'POST' && !(req.method === 'GET' && (url === '/api/me' || url === '/api/state'))) throw new HttpError(405, 'Method not allowed.');
  if (req.method === 'POST') {
    if (req.headers['x-ddeo'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) throw forbid('Blocked request.');
    const o = req.headers.origin; if (o && o.replace(/^https?:\/\//, '') !== req.headers.host) throw forbid('Blocked request.');
  }
  const body = req.method === 'POST' ? await readBody(req) : {};
  const hdr = secHeaders();

  if (url === '/api/login') {
    const username = str(body.username, 40).trim(), password = str(body.password, 200), ip = req.socket.remoteAddress || 'x';
    const k1 = 'login|' + ip, k2 = 'loginu|' + username.toLowerCase(), wait = Math.max(thLocked(k1), thLocked(k2));
    if (wait) throw new HttpError(429, 'Too many wrong attempts. Try again in ' + wait + ' seconds.');
    const a = username ? db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) : null;
    const good = pwVerify(password, a ? a.hash : DUMMY_HASH) && !!a;
    if (!good) { thFail(k1); thFail(k2); audit(username || '-', 'failed sign-in from ' + ip); const w = Math.max(thLocked(k1), thLocked(k2)); throw new HttpError(w ? 429 : 401, w ? 'Too many wrong attempts. Try again in ' + w + ' seconds.' : 'Wrong username or password.'); }
    thOk(k1); thOk(k2);
    const M = loadState();
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash, account_id, created_at, last_seen) VALUES (?,?,?,?)').run(sha(tok), a.id, now(), now());
    db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(now() - SESSION_MIN * 60000);
    const P = principal({ headers: { cookie: 'sid=' + tok } }, M);
    if (!P) throw new HttpError(401, 'This account is not linked to a school any more.');
    audit(a.username, 'signed in');
    return send(res, 200, { ok: true, me: meOf(P) }, secHeaders({ 'Set-Cookie': cookie(tok, SESSION_MIN * 60) }));
  }
  if (url === '/api/logout') {
    const tok = parseCookies(req).sid; if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(tok));
    return send(res, 200, { ok: true }, secHeaders({ 'Set-Cookie': cookie('', 0) }));
  }
  if (url.startsWith('/api/public/')) {
    const M = loadState();
    if (url === '/api/public/result') return send(res, 200, pubGuard(req, M, body, (st, sc) => resultFor(M, st, sc)), hdr);
    if (url === '/api/public/reg-check') return send(res, 200, pubGuard(req, M, body, (st, sc) => Object.assign({ ok: true }, regInfo(M, st, sc))), hdr);
    if (url === '/api/public/reg-submit') {
      const who = pubGuard(req, M, body, (st) => st.id);   // wrong ID / name is counted and answered here, outside the transaction
      return send(res, 200, tx(() => {
        const M2 = loadState(), st = M2.students.find((s) => s.id === who), sc = M2.schools.find((s) => s.id === st.schoolId);
        const info = regInfo(M2, st, sc); if (info.message) throw bad(info.message);
        let stream = info.target >= 11 ? str(body.stream, 20) : '';
        if (info.target === 11 && !STREAMS.includes(stream)) throw bad('Choose Natural Science or Social Science.');
        if (info.target === 12 && !STREAMS.includes(stream)) stream = st.stream || '';
        st.pendingReg = { year: info.year, grade: String(info.target), stream, at: new Date().toISOString() };
        M2.log.push({ t: new Date().toISOString(), user: 'student ' + st.studentId, schoolId: st.schoolId, text: 'Student asked to register for ' + info.year + ' in Grade ' + info.target + ' (waiting for approval)' });
        saveState(M2); return { ok: true, grade: info.target, year: info.year };
      }), hdr);
    }
    throw new HttpError(404, 'Not found.');
  }

  const M = loadState(), P = principal(req, M);
  if (!P) throw new HttpError(401, 'Please sign in.');
  if (url === '/api/me') return send(res, 200, { ok: true, me: meOf(P) }, hdr);
  if (url === '/api/state') {
    if (P.mustChange) throw forbid('Change your password first.');
    return send(res, 200, { ok: true, state: viewFor(P, M) }, hdr);
  }
  if (url === '/api/checkpw') {
    const a = db.prepare('SELECT hash FROM accounts WHERE id = ?').get(P.accountId);
    return send(res, 200, { ok: pwVerify(str(body.password, 200), a.hash) }, hdr);
  }
  if (url === '/api/changepw') {
    const a = db.prepare('SELECT hash FROM accounts WHERE id = ?').get(P.accountId);
    if (!pwVerify(str(body.current, 200), a.hash)) throw new HttpError(403, 'The current password is wrong.');
    const prob = pwProblem(body.password); if (prob) throw bad(prob);
    if (body.password === body.current) throw bad('The new password must be different from the current one.');
    db.prepare('UPDATE accounts SET hash = ?, must_change = 0 WHERE id = ?').run(pwHash(body.password), P.accountId);
    db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?').run(P.accountId, P.tokenHash);
    audit(P.user, 'changed own password');
    return send(res, 200, { ok: true }, hdr);
  }
  if (url === '/api/setpw') {
    if (P.mustChange) throw forbid('Change your password first.');
    const kind = body.kind, id = str(body.id, 40), pw = body.password, prob = pwProblem(pw); if (prob) throw bad(prob);
    let username = '';
    if (kind === 'school' && P.role === 'super') { const sc = M.schools.find((s) => s.id === id); if (!sc) throw bad('School not found.'); username = sc.adminUser; }
    else if (kind === 'staff' && P.role === 'school') { const sc = M.schools.find((s) => s.id === P.schoolId), t = (sc.staff || []).find((x) => x.id === id); if (!t) throw bad('Teacher not found.'); username = t.username; }
    else throw forbid();
    tx(() => {
      const ex = db.prepare('SELECT id FROM accounts WHERE kind = ? AND ref_id = ?').get(kind, id), other = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username);
      if (other && (!ex || other.id !== ex.id)) throw new HttpError(409, 'This username is already used.');
      if (ex) { db.prepare('UPDATE accounts SET hash = ?, username = ?, must_change = 0 WHERE id = ?').run(pwHash(pw), username, ex.id); db.prepare('DELETE FROM sessions WHERE account_id = ?').run(ex.id); }
      else db.prepare('INSERT INTO accounts(kind, ref_id, username, hash, must_change) VALUES (?,?,?,?,0)').run(kind, id, username, pwHash(pw));
      audit(P.user, 'set the password of ' + kind + ' account ' + username);
    });
    return send(res, 200, { ok: true }, hdr);
  }
  if (url === '/api/state/save') {
    return send(res, 200, tx(() => {
      const M2 = loadState(), P2 = principal(req, M2);
      if (!P2) throw new HttpError(401, 'Please sign in.');
      mergeFor(P2, M2, body.state);
      syncAccounts(M2); saveState(M2);
      audit(P2.user, 'saved changes');
      return { ok: true, state: viewFor(P2, M2) };
    }), hdr);
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(req, res, url) {
  const f = STATIC[url];
  if (!f || req.method !== 'GET') { res.writeHead(404, secHeaders({ 'Content-Type': 'text/plain' })); return res.end('Not found'); }
  const p = path.join(ROOT, f);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404, secHeaders({ 'Content-Type': 'text/plain' })); return res.end('Not found'); }
    res.writeHead(200, secHeaders({ 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache' }));
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    api(req, res, url).catch((e) => {
      if (e instanceof HttpError) return send(res, e.code, { ok: false, error: e.message }, secHeaders());
      console.error(e); send(res, 500, { ok: false, error: 'Server error.' }, secHeaders());
    });
  } else serveStatic(req, res, url);
});

/* ---------- first start: create the Education Office account ---------- */
if (!db.prepare("SELECT id FROM accounts WHERE kind = 'super'").get()) {
  const pw = process.env.ADMIN_PASSWORD || (crypto.randomBytes(6).toString('hex') + 'A1');
  db.prepare("INSERT INTO accounts(kind, ref_id, username, hash, must_change) VALUES ('super','super','admin',?,1)").run(pwHash(pw));
  console.log('\n  First start. Education Office account created.\n  Username: admin\n  Password: ' + pw + '\n  You must change this password at the first sign-in.\n');
}
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log('DDEO-SRATMS server running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '  (database: ' + DB_FILE + ')'));
}
module.exports = { server, db };
