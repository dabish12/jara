/* =====================================================================
   DDEO-SRATMS - Student Roster and Transcript Management System
   Dembi Dollo Education Office - vanilla JavaScript (no PHP, no framework)

   1. Constants and helpers      5. Marks and roster calculations
   2. Storage layer              6. Views (schools, students, subjects, teachers, marks, roster, transcript, statistics)
   3. Authentication             7. Roster and transcript pages, print, PDF, Excel
   4. Shared UI                  8. Events and start-up
   ===================================================================== */
(function () {
  'use strict';

  /* ================= 1. CONSTANTS AND HELPERS ================= */
  var OFFICE = 'Dembi Dollo Education Office';
  var SUPER_USER = 'admin';
  var DEFAULT_SUPER_PW = '2291';
  var DB_NAME = 'ddeo_sratms', STORE_NAME = 'kv', LS_KEY = 'ddeo_sratms_db';
  var MAX_SUBJECTS = 16;
  var DEFAULT_SUBJECTS = ['Afan Oromo', 'Amharic', 'English', 'Maths', 'Physics', 'Chemistry', 'Biology', 'Geography', 'History', 'Civic', 'IT'];
  var GRADES = ['9', '10', '11', '12'];
  var PER_PAGE = 5;
  var MAX_TRIES = 5, LOCK_SECONDS = 30, IDLE_MINUTES = 15;
  var ROLE_LABEL = { super: 'Education Office admin', school: 'School admin', homeroom: 'Home room teacher', subject: 'Subject teacher' };
  var API = false, DEFAULT_ASSESS = { test: 20, mid: 30, final: 50 };
  var TRANSCRIPT_ROWS = 16, PASS_MARK = 50, STREAMS = ['Natural Science', 'Social Science'];
  var DEFAULT_TOWN = 'Dembi Dollo', DEFAULT_REGION = 'Oromia';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function trim(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }
  function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) { o.push(a.slice(i, i + n)); } return o; }
  function stamp() { var d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
  function currentYear() { var y = new Date().getFullYear(); return y + '/' + (y + 1); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmt(n) { return n === null || n === undefined ? '' : String(round1(n)); }
  function numOrNull(v) {
    if (v === undefined || v === null || v === '') { return null; }
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function hashPw(pw) {
    var s = 'ddeo|' + pw + '|v1', h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
    }
    return h1.toString(16) + '-' + h2.toString(16);
  }
  function downloadBlob(name, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function hasXlsx() { return typeof window.XLSX !== 'undefined'; }
  function csvEscape(v) { var s = String(v === null || v === undefined ? '' : v); return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (q) { if (c === '"') { if (text.charAt(i + 1) === '"') { cur += '"'; i++; } else { q = false; } } else { cur += c; } }
      else if (c === '"') { q = true; }
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text.charAt(i + 1) === '\n') { i++; } row.push(cur); cur = ''; rows.push(row); row = []; }
      else { cur += c; }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  /* ================= 2. STORAGE ================= */
  var Store = {
    db: null, ls: false,
    open: function () {
      var self = this;
      return new Promise(function (resolve) {
        try {
          if (!window.indexedDB) { self.ls = true; resolve(); return; }
          var rq = window.indexedDB.open(DB_NAME, 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE_NAME); };
          rq.onsuccess = function () { self.db = rq.result; resolve(); };
          rq.onerror = function () { self.ls = true; resolve(); };
          rq.onblocked = function () { self.ls = true; resolve(); };
        } catch (e) { self.ls = true; resolve(); }
      });
    },
    get: function () {
      var self = this;
      return new Promise(function (resolve) {
        if (self.ls) { try { var v = localStorage.getItem(LS_KEY); resolve(v ? JSON.parse(v) : undefined); } catch (e) { resolve(undefined); } return; }
        try {
          var rq = self.db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get('db');
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    },
    set: function (value) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (self.ls) { try { localStorage.setItem(LS_KEY, JSON.stringify(value)); resolve(); } catch (e) { reject(e); } return; }
        try {
          var tx = self.db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(value, 'db');
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('Storage error')); };
          tx.onabort = function () { reject(tx.error || new Error('Storage is blocked or full')); };
        } catch (e) { reject(e); }
      });
    }
  };

  var db = null;       // { superHash, schools:[], students:[], marks:{}, log:[] }
  var sess = null;     // { role:'super'|'school', schoolId, user }

  function emptyDb() { return { version: 3, superHash: '', schools: [], students: [], marks: {}, parts: {}, log: [], settings: { registration: { year: '', start: '', end: '' } } }; }
  function normalizeDb(d) {
    var o = emptyDb();
    if (d && typeof d === 'object') {
      o.superHash = d.superHash || '';
      o.schools = Array.isArray(d.schools) ? d.schools : [];
      o.students = Array.isArray(d.students) ? d.students : [];
      o.marks = d.marks && typeof d.marks === 'object' ? d.marks : {};
      o.log = Array.isArray(d.log) ? d.log : [];
      o.parts = d.parts && typeof d.parts === 'object' ? d.parts : {};
      o.settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
      if (!o.settings.registration) { o.settings.registration = { year: '', start: '', end: '' }; }
      var maxCode = 0;
      o.schools.forEach(function (s) { var n = parseInt(s.code, 10); if (n > maxCode) { maxCode = n; } });
      o.schools.forEach(function (s) {
        if (!s.code) { maxCode++; s.code = ('00' + maxCode).slice(-3); }
        if (!s.release) { s.release = { start: '', end: '', sem: 'all' }; }
        if (!s.nextSeq) { s.nextSeq = 0; }
        if (!s.assess) { s.assess = { test: DEFAULT_ASSESS.test, mid: DEFAULT_ASSESS.mid, final: DEFAULT_ASSESS.final }; }
        (s.staff || []).forEach(function (t) { if (!t.sealed) { t.sealed = []; } });
        if (!Array.isArray(s.staff)) { s.staff = []; }
        if (!Array.isArray(s.subjects)) { s.subjects = []; }
        if (s.town === undefined) { s.town = DEFAULT_TOWN; }
        if (s.region === undefined) { s.region = DEFAULT_REGION; }
      });
      o.students.forEach(function (st) {
        if (!st.registeredOn) { st.registeredOn = st.createdAt ? String(st.createdAt).slice(0, 10) : todayStr(); }
        if (st.studentId && /^DD\d{3}-\d{4}$/.test(st.studentId)) { st.studentId += '-' + st.registeredOn.slice(0, 4); }
        if (!st.studentId && !API) { var sc = o.schools.filter(function (x) { return x.id === st.schoolId; })[0]; if (sc) { st.studentId = newStudentId(sc, o, st.registeredOn); } }
      });
    }
    return o;
  }
  /* commit: apply a change to the data, save it, and undo it completely if saving fails */
  function commit(mutator, logText) {
    var snap = JSON.stringify(db);
    try {
      mutator();
      if (logText) {
        db.log.push({ t: new Date().toISOString(), user: sess ? sess.user : '', schoolId: sess && sess.schoolId ? sess.schoolId : '', text: logText });
        if (db.log.length > 1000) { db.log = db.log.slice(-1000); }
      }
    } catch (e) { db = JSON.parse(snap); toast(e.message || 'Could not apply the change.', 'error'); return Promise.reject(e); }
    return (API ? apiSave() : Store.set(db)).catch(function (err) {
      db = JSON.parse(snap);
      toast('Could not save: ' + (err && err.message ? err.message : 'storage is full or blocked') + '. Nothing was changed.', 'error');
      throw err;
    });
  }

  function school() { var id = curSchoolId(); return db.schools.filter(function (s) { return s.id === id; })[0] || null; }
  function schoolStudents() { var id = curSchoolId(); return db.students.filter(function (s) { return s.schoolId === id; }); }
  function sectionsOf(grade) {
    var set = {};
    schoolStudents().forEach(function (s) { if ((!grade || s.grade === grade) && s.section) { set[s.section] = 1; } });
    return Object.keys(set).sort();
  }
  function classStudents(grade, section) {
    return schoolStudents().filter(function (s) { return s.grade === grade && (!section || s.section === section); })
      .sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
  }

  /* ================= 3. AUTHENTICATION ================= */
  var failed = 0, lockedUntil = 0;
  function superHash() { return db.superHash || hashPw(DEFAULT_SUPER_PW); }
  function loginError(m) { var e = $('#loginError'); e.textContent = m; e.hidden = false; }
  function handleLogin(e) {
    if (API) { return apiLogin(e); }
    e.preventDefault();
    var wait = thLocked('login');
    if (wait) { loginError('Too many wrong attempts. Try again in ' + wait + ' seconds.'); return; }
    var user = trim($('#loginUser').value).toLowerCase(), pass = $('#loginPass').value;
    if (!user || !pass) { loginError('Enter the username and the password.'); return; }
    var cand = null;
    if (user === SUPER_USER) { cand = { stored: superHash(), ok: { role: 'super', user: SUPER_USER }, set: function (h) { db.superHash = h; } }; }
    else {
      var sc = db.schools.filter(function (s) { return s.adminUser.toLowerCase() === user; })[0];
      if (sc) { cand = { stored: sc.adminHash, ok: { role: 'school', schoolId: sc.id, user: sc.adminUser }, set: function (h) { sc.adminHash = h; } }; }
      else {
        db.schools.forEach(function (s) {
          (s.staff || []).forEach(function (t) {
            if (!cand && t.username.toLowerCase() === user) { cand = { stored: t.hash, ok: { role: t.role, schoolId: s.id, staffId: t.id, user: t.username, name: t.name }, set: function (h) { t.hash = h; } }; }
          });
        });
      }
    }
    var btn = $('#loginForm button[type=submit]'); btn.disabled = true;
    pwVerify(pass, cand ? cand.stored : 'pb2$00000000000000000000000000000000$0').then(function (good) {
      btn.disabled = false;
      if (good && cand) {
        thOk('login'); sess = cand.ok; try { sessionStorage.setItem('ddeo_sess', JSON.stringify(cand.ok)); } catch (x) { /* ignore */ }
        var upgrade = cand.stored.indexOf('pb2$') !== 0 && window.crypto && window.crypto.subtle && (user !== SUPER_USER || db.superHash);
        showApp();
        if (upgrade) { pwHash(pass).then(function (h) { return commit(function () { cand.set(h); }); }).catch(function () { /* ignore */ }); }
      } else {
        var locked = thFail('login');
        loginError(locked ? 'Too many wrong attempts. Sign-in is locked for ' + thLocked('login') + ' seconds.' : 'Wrong username or password.');
        $('#loginPass').select();
      }
    });
  }
  function checkPassword(pw) {
    if (API) { return apiCall('/api/checkpw', { password: pw }).then(function (j) { return !!j.ok; }).catch(function () { return false; }); }
    var stored = '';
    if (sess.role === 'super') { stored = superHash(); }
    else if (sess.role === 'school') { var s = school(); stored = s ? s.adminHash : ''; }
    else { var t = me(); stored = t ? t.hash : ''; }
    return pwVerify(pw, stored);
  }
  function restoreSession() {
    try {
      var s = JSON.parse(sessionStorage.getItem('ddeo_sess') || 'null');
      if (!s) { return false; }
      if (s.role === 'super') { sess = s; return true; }
      var sc = db.schools.filter(function (x) { return x.id === s.schoolId; })[0];
      if (!sc) { return false; }
      if (s.role === 'school') { sess = s; return true; }
      if ((s.role === 'homeroom' || s.role === 'subject') && (sc.staff || []).some(function (t) { return t.id === s.staffId && t.role === s.role; })) { sess = s; return true; }
    } catch (e) { /* ignore */ }
    return false;
  }
  function logout(msg) {
    if (API) { fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Ddeo': '1' }, body: '{}' }).catch(function () { /* ignore */ }); }
    sess = null; try { sessionStorage.removeItem('ddeo_sess'); } catch (e) { /* ignore */ }
    $('#main').innerHTML = ''; $('#printArea').innerHTML = ''; $('#exportStage').innerHTML = ''; $('#modalRoot').innerHTML = ''; document.body.classList.remove('modal-open');
    window.__importGood = null; cover(false); showLogin();
    if (msg && typeof msg === 'string') { loginError(msg); }
  }
  function showLogin() { $('#app').hidden = true; $('#loginScreen').hidden = false; $('#loginPass').value = ''; $('#loginError').hidden = true; setTimeout(function () { var a = document.activeElement; if (!a || a === document.body) { $('#loginUser').focus(); } }, 50); }
  function showApp() {
    $('#loginScreen').hidden = true; $('#app').hidden = false;
    ui = freshUi(); resetIdle();
    var sc = sess.role === 'super' ? null : school(), label = ROLE_LABEL[sess.role] + (sess.name ? ': ' + sess.name : '');
    $('#topTitle').textContent = sc ? sc.name : OFFICE;
    $('#topSub').textContent = sc ? OFFICE + ' - Academic year ' + sc.academicYear + ' - ' + label : label + ' - monitors all schools';
    $('#brandSub').textContent = sc ? sc.name : OFFICE;
    go(sess.role === 'super' ? 'statistics' : 'dashboard');
  }
  /* ================= 4. SHARED UI ================= */
  var ui = freshUi(), view = '';
  function freshUi() {
    return {
      st: { q: '', grade: '', section: '' },
      mk: { grade: '9', section: '', year: '', sem: '1', subject: '', dirty: false },
      ro: { grade: '9', section: '', year: '', teacher: '' },
      tr: { q: '', grade: '', section: '', sid: '' },
      mon: { schoolId: '', tab: 'overview' }
    };
  }
  function toast(msg, type) {
    var el = document.createElement('div'); el.className = 'toast ' + (type || ''); el.textContent = msg;
    $('#toastRoot').appendChild(el); setTimeout(function () { el.remove(); }, type === 'error' ? 7000 : 4000);
  }
  function busy(on, text) { $('#busy').hidden = !on; if (text) { $('#busyText').textContent = text; } }
  var onDismiss = null;
  function openModal(html) {
    $('#modalRoot').innerHTML = '<div class="modal-backdrop" data-backdrop="1"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>';
    document.body.classList.add('modal-open');
    var f = $('#modalRoot').querySelector('input:not([type=hidden]), select, textarea');
    if (f) { setTimeout(function () { var x = document.activeElement; if (!x || x === document.body || x.hasAttribute('data-close')) { f.focus(); } }, 40); }
  }
  function closeModal(silent) {
    var cb = onDismiss; onDismiss = null;
    $('#modalRoot').innerHTML = ''; document.body.classList.remove('modal-open');
    if (!sess) { clearTimeout(window.__resTimer); }
    if (cb && !silent) { cb(); }
  }
  function confirmBox(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      openModal('<div class="modal-head"><h2>' + esc(title) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div><div class="modal-body"><p>' + esc(message) + '</p></div>' +
        '<div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn ' + (danger ? 'btn-danger solid' : 'btn-primary') + '" id="confirmOk">' + esc(okLabel || 'OK') + '</button></div>');
      onDismiss = function () { resolve(false); };
      $('#confirmOk').addEventListener('click', function () { onDismiss = null; closeModal(true); resolve(true); });
    });
  }
  function passwordBox(title, message) {
    return new Promise(function (resolve) {
      openModal('<div class="modal-head"><h2>' + esc(title) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
        '<form id="pwBoxForm"><div class="modal-body"><p>' + esc(message) + '</p><label for="pwBoxInput">Your password</label><input id="pwBoxInput" type="password">' +
        '<div class="form-error" id="pwBoxErr" hidden></div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-danger solid">Confirm</button></div></form>');
      onDismiss = function () { resolve(false); };
      $('#pwBoxForm').addEventListener('submit', function (e) {
        e.preventDefault();
        checkPassword($('#pwBoxInput').value).then(function (ok) {
          if (ok) { onDismiss = null; closeModal(true); resolve(true); }
          else { var el = $('#pwBoxErr'); el.textContent = 'Wrong password.'; el.hidden = false; }
        });
      });
    });
  }

  var NAV = {
    super: [['statistics', 'Statistics'], ['schools', 'Schools'], ['registration', 'Student registration'], ['monitor', 'School statistics'], ['audit', 'Audit log'], ['settings', 'Settings and backup']],
    school: [['dashboard', 'Dashboard'], ['students', 'Students'], ['registrations', 'Registration requests'], ['subjects', 'Subjects'], ['staff', 'Teachers'], ['marks', 'Enter marks'], ['roster', 'Roster'], ['transcript', 'Transcripts'], ['release', 'Result release'], ['audit', 'Audit log'], ['settings', 'Settings and backup']],
    homeroom: [['dashboard', 'My class'], ['students', 'Students'], ['roster', 'Roster'], ['settings', 'Password']],
    subject: [['dashboard', 'Dashboard'], ['marks', 'Enter marks'], ['settings', 'Password']]
  };
  function go(v) {
    if (sess.role === 'super' && !db.superHash && v !== 'settings') { v = 'settings'; toast('Change the default Education Office password first.', 'warn'); }
    view = v;
    $('#nav').innerHTML = NAV[sess.role].map(function (n) {
      return '<button class="nav-item' + (n[0] === v ? ' active' : '') + '" data-action="nav" data-view="' + n[0] + '">' + n[1] + '</button>';
    }).join('');
    $('#sidebar').classList.remove('open');
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    var fn = { statistics: statisticsView, monitor: monitorView, schools: schoolsView, audit: auditView, settings: settingsView, dashboard: dashboardView,
      students: studentsView, subjects: subjectsView, staff: staffView, marks: marksView, roster: rosterView, transcript: transcriptView, release: releaseView, registration: registrationView, registrations: registrationsView }[view];
    $('#main').innerHTML = fn();
    afterRender();
  }
  function head(title, sub) { return '<header class="view-head"><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></header>'; }
  function opts(list, selected, allLabel) {
    return (allLabel !== undefined ? '<option value="">' + esc(allLabel) + '</option>' : '') +
      list.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  }
  function gradeOpts(sel, allLabel) { return opts(GRADES.map(function (g) { return [g, 'Grade ' + g]; }), sel, allLabel); }

  /* ================= 5. MARKS AND ROSTER CALCULATIONS ================= */
  function getMarks(studentId, year, sem) {
    var m = db.marks[studentId];
    return (m && m[year] && m[year][sem]) || {};
  }
  /* For every student of the class: marks per subject for semester 1, 2 and AV (annual average),
     plus total, average and rank for each of the three rows. */
  function computeClass(list, subjects, year) {
    var out = {}, keys = ['1', '2', 'AV'];
    list.forEach(function (st) {
      var a = getMarks(st.id, year, '1'), b = getMarks(st.id, year, '2');
      var rows = { '1': [], '2': [], 'AV': [] };
      subjects.forEach(function (sub) {
        var x = numOrNull(a[sub.id]), y = numOrNull(b[sub.id]);
        rows['1'].push(x); rows['2'].push(y);
        rows.AV.push(x !== null && y !== null ? round1((x + y) / 2) : null);
      });
      var o = { rows: rows };
      keys.forEach(function (k) {
        var vals = rows[k].filter(function (v) { return v !== null; });
        var total = vals.length ? round1(vals.reduce(function (p, c) { return p + c; }, 0)) : null;
        o[k] = { total: total, avg: vals.length ? round1(total / vals.length) : null, rank: null };
      });
      out[st.id] = o;
    });
    keys.forEach(function (k) {
      var ranked = list.map(function (st) { return { id: st.id, t: out[st.id][k].total }; })
        .filter(function (x) { return x.t !== null; }).sort(function (p, q) { return q.t - p.t; });
      var last = null, rank = 0;
      ranked.forEach(function (x, i) { if (x.t !== last) { rank = i + 1; last = x.t; } out[x.id][k].rank = rank; });
    });
    return out;
  }
  /* Promotion criteria (grade to grade; Grade 12 uses Passed / Failed):
     average below 50 or 4+ subjects below 50 = Detained; 0 below 50 and average 50+ = Promoted;
     1 below 50 and average 52+ = Promoted; 2 below 50 and average 54+ = Promoted; every other case = Detained. */
  function remarkRow(values, grade) {
    var v = values.filter(function (x) { return x !== null; });
    if (!v.length) { return ''; }
    var avg = round1(v.reduce(function (p, c) { return p + c; }, 0) / v.length), below = v.filter(function (x) { return x < PASS_MARK; }).length;
    var ok = below === 0 ? avg >= 50 : below === 1 ? avg >= 52 : below === 2 ? avg >= 54 : false;
    if (String(grade) === '12') { return ok ? 'Passed' : 'Failed'; }
    return ok ? 'Promoted' : 'Detained';
  }
  function remarkFor(st, calc) { return remarkRow(calc[st.id].rows.AV, st.grade); }

  /* ================= 6. VIEWS ================= */

  /* ---------- Schools (Education Office super admin) ---------- */
  function schoolsView() {
    var rows = db.schools.map(function (s) {
      var n = db.students.filter(function (x) { return x.schoolId === s.id; }).length;
      return '<tr><td><strong>' + esc(s.name) + '</strong><small>Academic year ' + esc(s.academicYear) + '</small></td><td class="mono">' + esc(s.adminUser) + '</td><td>' + n + '</td><td>' + (s.staff || []).length +
        '</td><td class="col-actions"><button class="link-btn" data-action="school-monitor" data-id="' + esc(s.id) + '">School statistics</button><button class="link-btn" data-action="school-edit" data-id="' + esc(s.id) + '">Edit</button>' +
        '<button class="link-btn danger" data-action="school-del" data-id="' + esc(s.id) + '">Delete</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No schools yet. Click "Register school" to add the first school and its admin account.</td></tr>';
    return head('Schools', 'Register schools and create their admin accounts. Each school sees only its own data; the Education Office sees the statistics of every school.') +
      '<div class="panel"><div class="btn-row spaced"><button class="btn btn-primary" data-action="school-add">Register school</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>School</th><th>Admin username</th><th>Students</th><th>Teachers</th><th class="col-actions">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }
  function schoolFormHtml(s) {
    var isNew = !s;
    return '<div class="modal-head"><h2>' + (isNew ? 'Register school' : 'Edit school') + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="schoolForm" novalidate data-edit-id="' + (isNew ? '' : esc(s.id)) + '"><div class="modal-body"><div class="form-grid">' +
      '<div class="full"><label for="scName">School name</label><input id="scName" type="text" maxlength="80" value="' + esc(s ? s.name : '') + '"><div class="field-error" data-err="name"></div></div>' +
      '<div><label for="scYear">Academic year</label><input id="scYear" type="text" maxlength="20" value="' + esc(s ? s.academicYear : currentYear()) + '"></div>' +
      '<div><label for="scUser">Admin username</label><input id="scUser" type="text" maxlength="30" value="' + esc(s ? s.adminUser : '') + '"><div class="field-error" data-err="user"></div></div>' +
      '<div class="full"><label for="scPass">' + (isNew ? 'Admin password' : 'New admin password (leave empty to keep the current one)') + '</label><input id="scPass" type="password" autocomplete="new-password"><div class="field-error" data-err="pass"></div></div>' +
      '</div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>';
  }
  function setErr(name, msg) { var el = $('[data-err="' + name + '"]'); if (el) { el.textContent = msg || ''; } }
  function handleSchoolSubmit(form) {
    var editId = form.getAttribute('data-edit-id');
    $$('[data-err]', form).forEach(function (e) { e.textContent = ''; });
    var name = trim($('#scName').value), year = trim($('#scYear').value) || currentYear(), user = trim($('#scUser').value), pass = $('#scPass').value, ok = true;
    if (name.length < 3) { setErr('name', 'Enter the school name.'); ok = false; }
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(user)) { setErr('user', 'Use 3-30 letters, numbers, dot, dash or underscore.'); ok = false; }
    else if (usernameTaken(user, null, editId)) { setErr('user', 'This username is already used.'); ok = false; }
    if (!editId && pwProblem(pass)) { setErr('pass', pwProblem(pass)); ok = false; }
    if (editId && pass && pwProblem(pass)) { setErr('pass', pwProblem(pass)); ok = false; }
    if (!ok) { return; }
    pwHashIf(pass).then(function (h) { return commit(function () {
      if (editId) {
        var s = db.schools.filter(function (x) { return x.id === editId; })[0];
        s.name = name; s.academicYear = year; s.adminUser = user;
        if (h) { s.adminHash = h; }
      } else {
        db.schools.push({
          id: (window.__newId = uid()), name: name, academicYear: year, adminUser: user, adminHash: h, code: nextSchoolCode(), release: { start: '', end: '', sem: 'all' }, nextSeq: 0, passMark: 50,
          recordOfficer: '', director: '', createdAt: new Date().toISOString(),
          subjects: DEFAULT_SUBJECTS.map(function (n) { return { id: uid(), name: n }; }), staff: [], town: DEFAULT_TOWN, region: DEFAULT_REGION
        });
      }
    }, (editId ? 'Edited school ' : 'Registered school ') + name); }).then(function () { return apiPw('school', editId || window.__newId, pass); }).then(function () {
      closeModal(true); toast('School saved.', 'success'); render();
    }).catch(function () { /* shown */ });
  }
  function deleteSchool(id) {
    var s = db.schools.filter(function (x) { return x.id === id; })[0];
    if (!s) { return; }
    passwordBox('Delete school', 'This permanently deletes "' + s.name + '" with all its students and marks. Type your password to continue.').then(function (ok) {
      if (!ok) { return; }
      commit(function () {
        var ids = {};
        db.students.forEach(function (st) { if (st.schoolId === id) { ids[st.id] = 1; delete db.marks[st.id]; } });
        db.students = db.students.filter(function (st) { return st.schoolId !== id; });
        db.schools = db.schools.filter(function (x) { return x.id !== id; });
      }, 'Deleted school ' + s.name).then(function () { if (ui.mon.schoolId === id) { ui.mon.schoolId = ''; } toast('School deleted.', 'success'); render(); }).catch(function () { /* shown */ });
    });
  }

  /* ---------- Dashboard ---------- */
  function dashboardView() {
    var sc = school();
    if (sess.role === 'homeroom') { return homeroomDashboard(sc); }
    if (sess.role === 'subject') { return subjectDashboard(sc); }
    var quick = '<div class="panel"><h2>Quick actions</h2><div class="btn-row"><button class="btn btn-primary" data-action="nav" data-view="students">Students</button><button class="btn" data-action="nav" data-view="subjects">Subjects</button>' +
      '<button class="btn" data-action="nav" data-view="staff">Teachers</button><button class="btn" data-action="nav" data-view="marks">Enter marks</button><button class="btn" data-action="nav" data-view="roster">Roster</button>' +
      '<button class="btn" data-action="nav" data-view="transcript">Transcripts</button></div>' +
      '<p class="hint">Each semester: subject teachers enter their marks out of 100, home room teachers print the roster, and you prepare the transcripts from the roster marks.</p></div>';
    var reg = db.settings.registration, waiting = schoolStudents().filter(function (x) { return x.pendingReg; }).length, noSec = reg.year ? schoolStudents().filter(function (x) { return x.registeredFor === reg.year && !x.section; }).length : 0;
    return head('Dashboard', sc.name + ' - academic year ' + sc.academicYear) +
      (waiting ? '<div class="notice"><b>' + waiting + ' registration request' + (waiting === 1 ? '' : 's') + '</b> waiting for your approval. Open Registration requests.</div>' : '') +
      (noSec ? '<div class="notice"><b>' + noSec + ' approved student' + (noSec === 1 ? '' : 's') + '</b> still need a section. Open Students and edit their section.</div>' : '') + overviewHtml(sc, quick);
  }
  /* ---------- Students ---------- */
  function studentsView() {
    var edit = canEdit(), hr = sess.role === 'homeroom', secs = sectionsOf(ui.st.grade);
    return head('Students', edit ? 'Add students one by one or import them from Excel.' : (hr ? 'The students of your class.' : 'The students of this school (read only).')) +
      '<div class="panel"><div class="toolbar four"><div><input type="search" id="stQ" data-ui="st.q" placeholder="Search by name or ID" value="' + esc(ui.st.q) + '" aria-label="Search"></div>' +
      '<select data-ui="st.grade" aria-label="Grade">' + gradeOpts(ui.st.grade, 'All grades') + '</select>' +
      '<select data-ui="st.section" aria-label="Section">' + opts(secs, ui.st.section, 'All sections') + '</select><div></div></div>' +
      '<div class="btn-row spaced">' + (edit ? '<button class="btn btn-primary" data-action="student-add">Add student</button><button class="btn" data-action="students-import">Import from Excel</button>' +
      '<button class="btn" data-action="students-template">Download template</button>' : '') + '<button class="btn" data-action="students-export">Export to Excel</button><span class="muted" id="stCount"></span></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Student ID</th><th>Registered</th><th>Age</th><th>Sex</th><th>Grade</th><th>Section</th><th>Stream</th>' + (edit ? '<th class="col-actions">Actions</th>' : '') + '</tr></thead><tbody id="stBody"></tbody></table></div></div>';
  }
  function filteredStudents() {
    var q = trim(ui.st.q).toLowerCase();
    return visibleStudents().filter(function (s) {
      return (!ui.st.grade || s.grade === ui.st.grade) && (!ui.st.section || s.section === ui.st.section) && (!q || s.fullName.toLowerCase().indexOf(q) !== -1 || (s.studentId || '').toLowerCase().indexOf(q) !== -1);
    }).sort(function (a, b) { return (parseInt(a.grade, 10) - parseInt(b.grade, 10)) || a.section.localeCompare(b.section) || a.fullName.localeCompare(b.fullName); });
  }
  function fillStudentRows() {
    var list = filteredStudents(), edit = canEdit();
    $('#stBody').innerHTML = list.map(function (s) {
      return '<tr><td><strong>' + esc(s.fullName) + '</strong></td><td class="mono">' + esc(s.studentId || '') + '</td><td>' + esc(s.registeredOn || '') + '</td><td>' + esc(s.age) + '</td><td>' + (s.sex === 'F' ? 'Female' : 'Male') + '</td><td>' + esc(s.grade) + '</td><td>' + esc(s.section) + '</td><td>' + (s.grade === '11' && !s.stream ? '<span class="chip err">Not chosen</span>' : esc(s.stream || '')) + '</td>' +
        (edit ? '<td class="col-actions"><button class="link-btn" data-action="student-edit" data-id="' + esc(s.id) + '">Edit</button><button class="link-btn danger" data-action="student-del" data-id="' + esc(s.id) + '">Delete</button></td>' : '') + '</tr>';
    }).join('') || '<tr><td colspan="' + (edit ? 9 : 8) + '" class="empty">' + (visibleStudents().length ? 'No students match.' : 'No students yet.' + (edit ? ' Add a student or import an Excel file.' : '')) + '</td></tr>';
    $('#stCount').textContent = list.length + ' of ' + visibleStudents().length + ' shown';
  }
  function studentFormHtml(s) {
    var isNew = !s;
    return '<div class="modal-head"><h2>' + (isNew ? 'Add student' : 'Edit student') + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="studentForm" novalidate data-edit-id="' + (isNew ? '' : esc(s.id)) + '"><div class="modal-body"><div class="form-grid">' +
      '<div class="full"><label for="fName">Student\'s full name</label><input id="fName" type="text" maxlength="80" value="' + esc(s ? s.fullName : '') + '"><div class="field-error" data-err="name"></div></div>' +
      '<div><label for="fAge">Age</label><input id="fAge" type="number" min="5" max="40" value="' + esc(s ? s.age : '') + '"><div class="field-error" data-err="age"></div></div>' +
      '<div><label for="fSex">Sex</label><select id="fSex"><option value="">Select</option><option value="M"' + (s && s.sex === 'M' ? ' selected' : '') + '>Male</option><option value="F"' + (s && s.sex === 'F' ? ' selected' : '') + '>Female</option></select><div class="field-error" data-err="sex"></div></div>' +
      '<div><label for="fGrade">Grade</label><select id="fGrade">' + gradeOpts(s ? s.grade : '', 'Select grade') + '</select><div class="field-error" data-err="grade"></div></div>' +
      '<div><label for="fSection">Section</label><input id="fSection" type="text" maxlength="10" placeholder="A" value="' + esc(s ? s.section : '') + '"></div>' +
      '<div class="full"><label for="fRegDate">Date of registration</label><input id="fRegDate" type="date" value="' + esc(s ? (s.registeredOn || '') : todayStr()) + '"><div class="field-error" data-err="regdate"></div></div>' +
      '<div class="full" id="fStreamBox"' + (s && (s.grade === '11' || s.grade === '12') ? '' : ' hidden') + '><label for="fStream">Stream (every Grade 11 student chooses one)</label><select id="fStream"><option value="">Select stream</option>' +
      STREAMS.map(function (x) { return '<option' + (s && s.stream === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select><div class="field-error" data-err="stream"></div></div>' +
      '</div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>';
  }
  function toggleStreamField() { var g = $('#fGrade').value; $('#fStreamBox').hidden = !(g === '11' || g === '12'); }
  function handleStudentSubmit(form) {
    var editId = form.getAttribute('data-edit-id');
    $$('[data-err]', form).forEach(function (e) { e.textContent = ''; });
    var rec = { fullName: trim($('#fName').value), age: trim($('#fAge').value), sex: $('#fSex').value, grade: $('#fGrade').value, section: trim($('#fSection').value).toUpperCase() }, ok = true;
    if (rec.fullName.length < 3) { setErr('name', 'Enter the full name.'); ok = false; }
    if (rec.age && (!/^\d{1,2}$/.test(rec.age) || +rec.age < 5 || +rec.age > 40)) { setErr('age', 'Age must be a number from 5 to 40.'); ok = false; }
    if (!rec.sex) { setErr('sex', 'Select the sex.'); ok = false; }
    if (!rec.grade) { setErr('grade', 'Select the grade.'); ok = false; }
    rec.registeredOn = $('#fRegDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.registeredOn)) { setErr('regdate', 'Choose the date of registration.'); ok = false; }
    rec.stream = rec.grade === '11' || rec.grade === '12' ? $('#fStream').value : '';
    if (rec.grade === '11' && !rec.stream) { setErr('stream', 'Grade 11 students choose Natural Science or Social Science.'); ok = false; }
    if (ok && duplicateStudent(rec, editId)) { setErr('name', 'A student with this name already exists in this grade and section.'); ok = false; }
    if (!ok) { return; }
    commit(function () {
      if (editId) {
        var stu = db.students.filter(function (x) { return x.id === editId; })[0];
        Object.assign(stu, rec);
        var yr = rec.registeredOn.slice(0, 4), cur = (stu.studentId.match(/-(\d{4})$/) || [])[1];
        if (cur !== yr) {
          var nid = (cur ? stu.studentId.replace(/-\d{4}$/, '') : stu.studentId) + '-' + yr;
          if (db.students.some(function (x) { return x.id !== stu.id && x.studentId === nid; })) { throw new Error('The Student ID ' + nid + ' already exists.'); }
          stu.studentId = nid;
        }
      }
      else { db.students.push(Object.assign({ id: uid(), schoolId: sess.schoolId, studentId: newStudentId(school(), null, rec.registeredOn), createdAt: new Date().toISOString() }, rec)); }
    }, (editId ? 'Edited student ' : 'Added student ') + rec.fullName).then(function () {
      closeModal(true); toast('Student saved.', 'success'); render();
    }).catch(function () { /* shown */ });
  }
  function duplicateStudent(rec, exceptId) {
    var n = rec.fullName.toLowerCase();
    return schoolStudents().some(function (s) { return s.id !== exceptId && s.fullName.toLowerCase() === n && s.grade === rec.grade && s.section === rec.section; });
  }
  function deleteStudent(id) {
    var s = db.students.filter(function (x) { return x.id === id; })[0];
    if (!s) { return; }
    confirmBox('Delete student?', s.fullName + ' and all marks of this student will be deleted permanently.', 'Delete', true).then(function (yes) {
      if (!yes) { return; }
      commit(function () { db.students = db.students.filter(function (x) { return x.id !== id; }); delete db.marks[id]; delete db.parts[id]; }, 'Deleted student ' + s.fullName)
        .then(function () { toast('Deleted.', 'success'); render(); }).catch(function () { /* shown */ });
    });
  }

  var STUDENT_HEADERS = ['Full Name', 'Age', 'Sex', 'Grade', 'Section', 'Stream'];
  var ALIASES = {
    fullName: ['fullname', 'name', 'studentname', 'studentsfullname', 'studentfullname'],
    age: ['age'], sex: ['sex', 'gender'], grade: ['grade', 'class', 'gradelevel'], section: ['section', 'sec'], stream: ['stream', 'track', 'streamtrack']
  };
  function headerKey(h) {
    var n = String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (var k in ALIASES) { if (ALIASES.hasOwnProperty(k) && ALIASES[k].indexOf(n) !== -1) { return k; } }
    return null;
  }
  function downloadStudentTemplate() {
    var sample = [['Abebe Kebede Tadesse', 15, 'Male', 9, 'A', ''], ['Almaz Bekele Gudata', 16, 'Female', 10, 'B', ''], ['Chaltu Dugasa Fayisa', 17, 'Female', 11, 'A', 'Natural Science']];
    if (hasXlsx()) {
      var X = window.XLSX, wb = X.utils.book_new(), ws = X.utils.aoa_to_sheet([STUDENT_HEADERS].concat(sample));
      ws['!cols'] = [{ wch: 34 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 18 }];
      X.utils.book_append_sheet(wb, ws, 'Students'); X.writeFile(wb, 'Student_Import_Template.xlsx');
    } else {
      downloadBlob('Student_Import_Template.csv', '\uFEFF' + [STUDENT_HEADERS].concat(sample).map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n'), 'text/csv;charset=utf-8');
      toast('Excel library not available, so a CSV template was downloaded.', 'warn');
    }
  }
  function handleStudentFile(file) {
    if (!file) { return; }
    var isCsv = /\.csv$/i.test(file.name || '');
    if (!isCsv && !hasXlsx()) { toast('The Excel reader could not be loaded (no internet?). Save the sheet as CSV and import that.', 'error'); return; }
    busy(true, 'Reading file');
    var fr = new FileReader();
    fr.onerror = function () { busy(false); toast('The file could not be read.', 'error'); };
    fr.onload = function () {
      try {
        var table;
        if (isCsv) { table = parseCSV(String(fr.result)); }
        else {
          var wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array' });
          table = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: false });
        }
        var res = parseStudentRows(table);
        busy(false);
        showImportSummary(res);
      } catch (err) { busy(false); toast(err.message || 'The file could not be understood.', 'error'); }
      finally { $('#studentFile').value = ''; }
    };
    if (isCsv) { fr.readAsText(file); } else { fr.readAsArrayBuffer(file); }
  }
  function parseStudentRows(table) {
    var hi = -1, map = {}, i, j;
    for (i = 0; i < Math.min(table.length, 10); i++) {
      var m = {}, n = 0;
      for (j = 0; j < table[i].length; j++) { var k = headerKey(table[i][j]); if (k && m[k] === undefined) { m[k] = j; n++; } }
      if (m.fullName !== undefined && m.sex !== undefined && m.grade !== undefined) { hi = i; map = m; break; }
    }
    if (hi < 0) { throw new Error('Columns "Full Name", "Sex" and "Grade" were not found. Please use the template.'); }
    var good = [], errors = [], seen = {};
    for (i = hi + 1; i < table.length; i++) {
      var line = table[i];
      if (line.every(function (c) { return trim(c) === ''; })) { continue; }
      var get = function (key) { return map[key] === undefined ? '' : trim(line[map[key]]); };
      var rec = { fullName: get('fullName'), age: get('age'), sex: '', grade: '', section: get('section').toUpperCase() }, err = [];
      if (rec.fullName.length < 3) { err.push('name missing'); }
      var sx = get('sex').toLowerCase();
      if (/^(m|male|man|boy)$/.test(sx)) { rec.sex = 'M'; } else if (/^(f|female|woman|girl)$/.test(sx)) { rec.sex = 'F'; } else { err.push('sex must be Male or Female'); }
      var gm = /(\d{1,2})/.exec(get('grade'));
      if (gm && GRADES.indexOf(String(parseInt(gm[1], 10))) !== -1) { rec.grade = String(parseInt(gm[1], 10)); } else { err.push('grade must be 9-12'); }
      var sm = get('stream');
      rec.stream = rec.grade === '11' || rec.grade === '12' ? (/social/i.test(sm) ? 'Social Science' : /natural/i.test(sm) ? 'Natural Science' : '') : '';
      if (rec.grade === '11' && !rec.stream) { err.push('Grade 11 needs a stream: Natural Science or Social Science'); }
      if (rec.age && !/^\d{1,2}$/.test(rec.age)) { rec.age = String(parseInt(rec.age, 10) || ''); }
      var key = (rec.fullName + '|' + rec.grade + '|' + rec.section).toLowerCase();
      if (!err.length) {
        if (seen[key]) { err.push('appears twice in the file'); }
        else if (duplicateStudent(rec, null)) { err.push('already exists'); }
        seen[key] = 1;
      }
      if (err.length) { errors.push('Row ' + (i + 1) + ': ' + err.join(', ')); } else { good.push(rec); }
    }
    return { good: good, errors: errors };
  }
  function showImportSummary(res) {
    window.__importGood = res.good;
    openModal('<div class="modal-head"><h2>Import students</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div><div class="modal-body">' +
      '<div class="chips"><span class="chip ok">' + res.good.length + ' ready to import</span><span class="chip err">' + res.errors.length + ' rows with problems</span></div>' +
      (res.errors.length ? '<p class="muted">Rows with problems are not imported:</p><ul>' + res.errors.slice(0, 12).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + (res.errors.length > 12 ? '<li>and ' + (res.errors.length - 12) + ' more</li>' : '') + '</ul>' : '') +
      '</div><div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-action="import-commit"' + (res.good.length ? '' : ' disabled') + '>Import ' + res.good.length + ' students</button></div>');
  }
  function commitImport() {
    var good = window.__importGood || [];
    if (!good.length) { return; }
    commit(function () {
      var now = new Date().toISOString();
      good.forEach(function (r) { db.students.push(Object.assign({ id: uid(), schoolId: sess.schoolId, studentId: newStudentId(school(), null, todayStr()), registeredOn: todayStr(), createdAt: now }, r)); });
    }, 'Imported ' + good.length + ' students').then(function () {
      window.__importGood = null; closeModal(true); toast(good.length + ' students imported and saved.', 'success'); render();
    }).catch(function () { /* shown */ });
  }
  function exportStudents() {
    var list = filteredStudents();
    if (!list.length) { toast('There are no students to export.', 'warn'); return; }
    var rows = list.map(function (s) { return [s.studentId || '', s.registeredOn || '', s.fullName, s.age, s.sex === 'F' ? 'Female' : 'Male', s.grade, s.section, s.stream || '']; });
    if (hasXlsx()) {
      var X = window.XLSX, wb = X.utils.book_new(), ws = X.utils.aoa_to_sheet([['Student ID', 'Date of registration'].concat(STUDENT_HEADERS)].concat(rows));
      X.utils.book_append_sheet(wb, ws, 'Students'); X.writeFile(wb, 'Students_' + stamp() + '.xlsx');
    } else { downloadBlob('Students_' + stamp() + '.csv', '\uFEFF' + [['Student ID', 'Date of registration'].concat(STUDENT_HEADERS)].concat(rows).map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n'), 'text/csv;charset=utf-8'); }
  }

  /* ---------- Subjects (columns of the roster) ---------- */
  function subjectsView() {
    var sc = school(), n = sc.subjects.length;
    var items = sc.subjects.map(function (s, i) {
      return '<li><span class="num">' + (i + 1) + '</span><span class="name">' + esc(s.name) + '</span>' +
        '<button class="btn btn-sm" data-action="subj-up" data-id="' + esc(s.id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move left">&uarr;</button>' +
        '<button class="btn btn-sm" data-action="subj-down" data-id="' + esc(s.id) + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move right">&darr;</button>' +
        '<button class="link-btn" data-action="subj-rename" data-id="' + esc(s.id) + '">Rename</button>' +
        '<button class="link-btn danger" data-action="subj-del" data-id="' + esc(s.id) + '">Remove</button></li>';
    }).join('') || '<li class="muted">No subjects. Add the first subject column.</li>';
    return head('Subjects', 'These are the subject columns of the roster. Add or remove columns (up to ' + MAX_SUBJECTS + ').') +
      '<div class="panel"><form id="subjectForm" class="btn-row" novalidate><input id="subjName" type="text" maxlength="30" placeholder="New subject, for example Economics" style="max-width:340px" aria-label="Subject name">' +
      '<button type="submit" class="btn btn-primary"' + (n >= MAX_SUBJECTS ? ' disabled' : '') + '>Add subject column</button><span class="muted">' + n + ' of ' + MAX_SUBJECTS + ' columns used</span></form>' +
      '<ul class="subj-list">' + items + '</ul>' +
      '<p class="hint">The order here is the order of the columns on the roster. Removing a subject also deletes the marks entered for it.</p></div>';
  }
  function addSubject(name) {
    var sc = school(); name = trim(name);
    if (!name) { toast('Enter the subject name.', 'error'); return; }
    if (sc.subjects.length >= MAX_SUBJECTS) { toast('The roster holds at most ' + MAX_SUBJECTS + ' subjects.', 'error'); return; }
    if (sc.subjects.some(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })) { toast('This subject already exists.', 'error'); return; }
    commit(function () { school().subjects.push({ id: uid(), name: name }); }, 'Added subject ' + name).then(function () { render(); }).catch(function () { /* shown */ });
  }
  function renameSubject(id) {
    var s = school().subjects.filter(function (x) { return x.id === id; })[0];
    if (!s) { return; }
    openModal('<div class="modal-head"><h2>Rename subject</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div><form id="renameForm" data-id="' + esc(id) + '" novalidate><div class="modal-body">' +
      '<label for="rnName">Subject name</label><input id="rnName" type="text" maxlength="30" value="' + esc(s.name) + '"><div class="field-error" data-err="rn"></div></div>' +
      '<div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>');
  }
  function handleRename(form) {
    var id = form.getAttribute('data-id'), name = trim($('#rnName').value);
    if (!name) { setErr('rn', 'Enter the subject name.'); return; }
    if (school().subjects.some(function (x) { return x.id !== id && x.name.toLowerCase() === name.toLowerCase(); })) { setErr('rn', 'This subject already exists.'); return; }
    commit(function () { school().subjects.filter(function (x) { return x.id === id; })[0].name = name; }, 'Renamed subject to ' + name)
      .then(function () { closeModal(true); render(); }).catch(function () { /* shown */ });
  }
  function moveSubject(id, dir) {
    commit(function () {
      var arr = school().subjects, i = -1;
      arr.forEach(function (x, k) { if (x.id === id) { i = k; } });
      var j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) { return; }
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }, 'Reordered subjects').then(function () { render(); }).catch(function () { /* shown */ });
  }
  function removeSubject(id) {
    var s = school().subjects.filter(function (x) { return x.id === id; })[0];
    if (!s) { return; }
    confirmBox('Remove subject column?', '"' + s.name + '" will be removed from the roster and all marks entered for it will be deleted.', 'Remove', true).then(function (yes) {
      if (!yes) { return; }
      commit(function () {
        var sc = school();
        sc.subjects = sc.subjects.filter(function (x) { return x.id !== id; });
        (sc.staff || []).forEach(function (t) { t.subjectIds = (t.subjectIds || []).filter(function (x) { return x !== id; }); });
        schoolStudents().forEach(function (st) {
          var m = db.marks[st.id]; if (!m) { return; }
          Object.keys(m).forEach(function (y) { Object.keys(m[y]).forEach(function (sem) { delete m[y][sem][id]; }); });
        });
      }, 'Removed subject ' + s.name).then(function () { render(); }).catch(function () { /* shown */ });
    });
  }

  /* ---------- Marks entry ---------- */
  function marksView() {
    var sc = school(), m = ui.mk, subjRole = sess.role === 'subject', t = subjRole ? me() : null, grades = GRADES, a = null, mySubs = sc.subjects, as = sc.assess || DEFAULT_ASSESS;
    if (subjRole) {
      mySubs = sc.subjects.filter(function (s) { return t && (t.subjectIds || []).indexOf(s.id) !== -1; });
      grades = allowedGrades();
      if (!mySubs.length || !grades.length) {
        return head('Enter marks', 'Submit the marks of your subject.') + '<div class="panel"><p class="muted">The school admin has not assigned a subject and a class to your account yet.</p></div>';
      }
      m.year = sc.academicYear;
      if (!mySubs.some(function (s) { return s.id === m.subject; })) { m.subject = mySubs[0].id; }
      if (grades.indexOf(m.grade) === -1) { m.grade = grades[0]; m.section = ''; }
      a = allowedSections(m.grade);
      if (!a.all && a.secs.indexOf(m.section) === -1) { m.section = a.secs[0] || ''; }
    } else if (!sc.subjects.some(function (s) { return s.id === m.subject; })) { m.subject = sc.subjects.length ? sc.subjects[0].id : ''; }
    if (!m.year) { m.year = sc.academicYear; }
    var sub = sc.subjects.filter(function (s) { return s.id === m.subject; })[0];
    if (!sub) { return head('Enter marks', '') + '<div class="panel"><p class="muted">Add subjects first (Subjects page).</p></div>'; }
    var locked = subjRole && !!(t && t.submittedAt), lockedRows = 0;
    var lockNote = locked ? '<div class="notice"><b>Your results were submitted</b> (' + esc(t.submittedFor || '') + '). Your account is deactivated for entering marks. Ask the school admin to reset it.</div>' : '';
    var list = classStudents(m.grade, m.section);
    var body = list.map(function (st, i) {
      var p = getParts(st.id, m.year, m.sem, sub.id), tot = numOrNull(getMarks(st.id, m.year, m.sem)[sub.id]);
      var lock = locked || (!subjRole && subjectLocked(sc, st, sub.id, m.year, m.sem));
      if (lock) { lockedRows++; }
      var cell = function (k, max, label) {
        var v = p[k];
        return '<td><input type="number" min="0" max="' + max + '" step="0.5" data-mark data-part="' + k + '" value="' + (v === undefined || v === null ? '' : esc(v)) + '"' + (lock ? ' disabled' : '') + ' aria-label="' + esc(st.fullName + ' ' + label) + '"></td>';
      };
      return '<tr data-row="' + esc(st.id) + '"' + (lock ? ' class="row-locked"' : '') + '><td>' + (i + 1) + '</td><td><strong>' + esc(st.fullName) + '</strong></td>' +
        cell('t', as.test, 'Test') + cell('m', as.mid, 'Mid exam') + cell('f', as.final, 'Final exam') + '<td data-total data-legacy="' + esc(tot !== null && !Object.keys(p).length ? tot : '') + '"><strong>' + esc(tot === null ? '' : tot) + '</strong></td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No students in this class. Add students first.</td></tr>';
    var gradeSel = subjRole ? opts(grades.map(function (g) { return [g, 'Grade ' + g]; }), m.grade) : gradeOpts(m.grade);
    var secSel = subjRole ? opts(a.secs, m.section, a.all ? 'All sections' : undefined) : opts(sectionsOf(m.grade), m.section, 'All sections');
    var subList = (subjRole ? mySubs : sc.subjects).map(function (s) { return [s.id, s.name]; });
    return head('Enter marks', (subjRole ? 'You see and enter the marks of your own subject only. ' : 'Choose the class, semester and subject. ') +
      'Type the Test / Assignment, Mid exam and Final exam of every student; the total is out of 100.' + (subjRole ? ' When everything is complete press Submit final results: your account is then deactivated until the school admin resets it.' : '')) + lockNote +
      '<div class="panel"><div class="toolbar five"><div><label>Grade</label><select data-ui="mk.grade">' + gradeSel + '</select></div>' +
      '<div><label>Section</label><select data-ui="mk.section">' + secSel + '</select></div>' +
      '<div><label>Subject</label><select data-ui="mk.subject">' + opts(subList, m.subject) + '</select></div>' +
      '<div><label>Academic year</label><input type="text" data-ui="mk.year" value="' + esc(m.year) + '"' + (subjRole ? ' readonly' : '') + '></div>' +
      '<div><label>Semester</label><select data-ui="mk.sem">' + opts([['1', 'Semester I'], ['2', 'Semester II']], m.sem) + '</select></div></div>' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="marks-save"' + (list.length && !locked ? '' : ' disabled') + '>Save marks</button>' +
      (subjRole ? '<button class="btn" data-action="marks-submit"' + (locked || !list.length ? ' disabled' : '') + '>Submit final results</button>' : '') +
      '<span class="muted">' + list.length + ' students - <span id="mkCount"></span></span></div>' +
      (lockedRows && !subjRole ? '<p class="hint">Grey rows were submitted by the subject teacher. The school admin cannot change them.</p>' : '') +
      '<div class="table-wrap"><table class="table marks-table"><thead><tr><th>#</th><th>Student</th><th>Test / Assignment (' + as.test + ')</th><th>Mid exam (' + as.mid + ')</th><th>Final exam (' + as.final + ')</th><th>Total (100)</th></tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }
  function saveMarks(lock) {
    var m = ui.mk, year = trim(m.year), subjRole = sess.role === 'subject', t = subjRole ? me() : null, sc = school(), as = sc.assess || DEFAULT_ASSESS;
    if (sess.role !== 'school' && !subjRole) { return; }
    if (subjRole) {
      year = sc.academicYear;
      if (t && t.submittedAt) { toast('Your results are submitted and your account is deactivated. Ask the school admin to reset it.', 'error'); return; }
      if (!t || !classAllowed(m.grade, m.section) || (t.subjectIds || []).indexOf(m.subject) === -1) { toast('You can only enter marks for the subjects and classes assigned to you.', 'error'); return; }
    }
    if (!year) { toast('Enter the academic year.', 'error'); return; }
    var sub = m.subject, names = { t: 'test', m: 'mid', f: 'final' }, classIds = {}, entries = [], bad = 0, incomplete = 0;
    classStudents(m.grade, m.section).forEach(function (s) { classIds[s.id] = s; });
    $$('tr[data-row]').forEach(function (tr) {
      var sid = tr.getAttribute('data-row'), st = classIds[sid];
      if (!st || (!subjRole && subjectLocked(sc, st, sub, year, m.sem))) { return; }
      var vals = {}, filled = 0;
      ['t', 'm', 'f'].forEach(function (k) {
        var inp = tr.querySelector('input[data-part="' + k + '"]'); inp.classList.remove('invalid');
        var raw = trim(inp.value); if (raw === '') { return; }
        var n = Number(raw);
        if (!isFinite(n) || n < 0 || n > as[names[k]]) { inp.classList.add('invalid'); bad++; return; }
        vals[k] = n; filled++;
      });
      entries.push({ sid: sid, vals: vals, filled: filled });
      if (filled < 3) { incomplete++; }
    });
    if (bad) { toast(bad + ' value' + (bad === 1 ? ' is' : 's are') + ' not valid. Test / Assignment 0-' + as.test + ', Mid exam 0-' + as.mid + ', Final exam 0-' + as.final + '.', 'error'); return; }
    if (lock && incomplete) { toast(incomplete + ' student' + (incomplete === 1 ? ' is' : 's are') + ' missing a Test, Mid or Final value. Complete them before you submit.', 'error'); return; }
    commit(function () {
      entries.forEach(function (e) {
        var had = getParts(e.sid, year, m.sem, sub);
        db.parts[e.sid] = db.parts[e.sid] || {}; db.parts[e.sid][year] = db.parts[e.sid][year] || {}; db.parts[e.sid][year][m.sem] = db.parts[e.sid][year][m.sem] || {};
        db.marks[e.sid] = db.marks[e.sid] || {}; db.marks[e.sid][year] = db.marks[e.sid][year] || {}; db.marks[e.sid][year][m.sem] = db.marks[e.sid][year][m.sem] || {};
        if (e.filled === 0) {
          if (Object.keys(had).length) { delete db.parts[e.sid][year][m.sem][sub]; delete db.marks[e.sid][year][m.sem][sub]; }
          return;
        }
        db.parts[e.sid][year][m.sem][sub] = e.vals;
        if (e.filled === 3) {
          db.marks[e.sid][year][m.sem][sub] = round1(e.vals.t + e.vals.m + e.vals.f);
          var st = db.students.filter(function (x) { return x.id === e.sid; })[0];
          if (st) { st.gradeYears = st.gradeYears || {}; st.gradeYears[st.grade] = year; }
        } else { delete db.marks[e.sid][year][m.sem][sub]; }
      });
      storeRanks(sc, m.grade, m.section, year);
      if (lock && subjRole) {
        var tt = me(), at = new Date().toISOString();
        tt.submittedAt = at; tt.submittedSem = m.sem; tt.submittedYear = year; tt.submittedFor = 'Semester ' + (m.sem === '1' ? 'I' : 'II') + ', ' + year;
        tt.sealed = (tt.sealed || []).filter(function (x) { return !(x.year === year && x.sem === m.sem); }).concat([{ year: year, sem: m.sem, at: at }]);
      }
    }, (lock ? 'Submitted final results: ' : '') + 'Saved marks' + (subjRole ? ' of ' + subjectName(sub) : ' of ' + subjectName(sub)) + ' Grade ' + m.grade + (m.section ? ' ' + m.section : '') + ' semester ' + m.sem + ' ' + year)
      .then(function () { m.dirty = false; if (lock) { toast('Results submitted. Your account is now deactivated until the school admin resets it.', 'success'); } else { toast('Marks saved.', 'success'); } render(); }).catch(function () { /* shown */ });
  }
  /* ---------- Roster view ---------- */
  function rosterView() {
    var sc = school(), r = ui.ro, hr = sess.role === 'homeroom' ? me() : null, lock = hr ? ' disabled' : '';
    if (!r.year) { r.year = sc.academicYear; }
    if (hr) { r.grade = hr.grade; r.section = hr.section; if (!r.teacher) { r.teacher = hr.name; } }
    return head('Roster', hr ? 'Roster of your class: semester I, II and annual average (AV) of every student. Print it or save it as PDF.' : 'The roster follows the Education Office format: 5 students per page, semester I, II and annual average (AV) for each student.') +
      '<div class="panel"><div class="toolbar five"><div><label>Grade</label><select data-ui="ro.grade"' + lock + '>' + gradeOpts(r.grade) + '</select></div>' +
      '<div><label>Section</label><select data-ui="ro.section"' + lock + '>' + opts(sectionsOf(r.grade), r.section, 'All sections') + '</select></div>' +
      '<div><label>Academic year</label><input type="text" data-ui="ro.year" value="' + esc(r.year) + '"></div>' +
      '<div><label>Home room teacher</label><input type="text" data-ui="ro.teacher" value="' + esc(r.teacher) + '" placeholder="Name"></div><div></div></div>' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="roster-print">Print</button><button class="btn" data-action="roster-pdf">Export PDF</button><button class="btn" data-action="roster-xlsx">Export Excel</button>' +
      '<span class="muted" id="roSummary"></span></div>' +
      '<div class="roster-preview" id="rosterPreview"></div></div>' + (sess.role === 'school' || sess.role === 'homeroom' ? conductPanelHtml() : '');
  }
  function rosterData() {
    var sc = school(), r = ui.ro, list = classStudents(r.grade, r.section);
    var year = trim(r.year) || sc.academicYear;
    return { sc: sc, list: list, year: year, subs: sc.subjects, calc: computeClass(list, sc.subjects, year) };
  }
  function renderRosterPreview() {
    var box = $('#rosterPreview'); if (!box) { return; }
    var d = rosterData();
    $('#roSummary').textContent = d.list.length + ' students, ' + Math.max(1, Math.ceil(d.list.length / PER_PAGE)) + ' page(s)';
    if (!d.list.length) { box.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No students in this class yet.</p>'; return; }
    if (!d.subs.length) { box.innerHTML = '<p class="muted" style="text-align:center;padding:20px">Add at least one subject column first (Subjects page).</p>'; return; }
    box.innerHTML = rosterPagesHtml(d, true);
    fitRoster();
  }
  function fitRoster() {
    var box = $('#rosterPreview'); if (!box || !box.clientWidth) { return; }
    box.style.setProperty('--z', Math.min(1, (box.clientWidth - 24) / (297 * 96 / 25.4)).toFixed(4));
  }

  /* ================= 7. ROSTER PAGE, PRINT, PDF, EXCEL ================= */
  function rosterPagesHtml(d, preview) {
    var r = ui.ro, sc = d.sc, subs = d.subs;
    var title = OFFICE + ' - ' + sc.name + ' - Grade ' + r.grade + (r.section ? ' ' + r.section : '') + ' - Roster and transcript - Academic year ' + d.year;
    var colgroup = '<colgroup><col style="width:8mm"><col style="width:42mm"><col style="width:8mm"><col style="width:8mm"><col style="width:9mm">' +
      subs.map(function () { return '<col>'; }).join('') + '<col style="width:12mm"><col style="width:13mm"><col style="width:10mm"><col style="width:19mm"><col style="width:15mm"><col style="width:9mm"></colgroup>';
    var vt = function (t) { return '<th><div class="vt">' + esc(t) + '</div></th>'; };
    var thead = '<thead><tr>' + vt('R.N.') + '<th class="h-h" style="vertical-align:bottom">STUDENT\'S FULL NAME</th>' + vt('AGE') + vt('SEX') + vt('SEMESTER') +
      subs.map(function (s) { return vt(s.name.toUpperCase()); }).join('') + vt('TOTAL') + vt('AVERAGE') + vt('RANK') + vt('REMARK') + vt('CONDUCT') + vt('ABSENT') + '</tr></thead>';
    var pages = chunk(d.list, PER_PAGE), offset = 0;
    var html = pages.map(function (group) {
      var body = '';
      for (var i = 0; i < PER_PAGE; i++) {
        var st = group[i];
        var blank = !st, c = st ? d.calc[st.id] : null;
        ['1', '2', 'AV'].forEach(function (k, ri) {
          body += '<tr' + (ri === 0 ? ' class="first"' : '') + '>';
          if (ri === 0) {
            body += '<td class="rn" rowspan="3">' + (blank ? '' : offset + i + 1) + '</td><td class="name" rowspan="3">' + (blank ? '' : esc(st.fullName)) + '</td>' +
              '<td class="age" rowspan="3">' + (blank ? '' : esc(st.age)) + '</td><td class="sex" rowspan="3">' + (blank ? '' : st.sex) + '</td>';
          }
          body += '<td class="sem">' + (k === '1' ? 'I' : k === '2' ? 'II' : 'AV') + '</td>';
          subs.forEach(function (s, si) { body += '<td>' + (blank ? '' : fmt(c.rows[k][si])) + '</td>'; });
          body += '<td>' + (blank ? '' : fmt(c[k].total)) + '</td><td>' + (blank ? '' : fmt(c[k].avg)) + '</td><td>' + (blank ? '' : (c[k].rank === null ? '' : c[k].rank)) + '</td>';
          if (ri === 0) { body += '<td class="remark" rowspan="3">' + (blank ? '' : esc(remarkFor(st, d.calc))) + '</td>'; }
          body += '<td class="cd">' + (blank || k === 'AV' ? '' : esc((recOf(st, d.year).conduct || {})[k] || '')) + '</td><td>' + (blank ? '' : esc(absentOf(st, d.year, k))) + '</td>';
          body += '</tr>';
        });
      }
      offset += group.length;
      var foot = '<div class="r-foot"><div>Home Room Teacher\'s<br>Name: <span class="ln">' + esc(r.teacher) + '</span><br>Sign: <span class="ln"></span></div>' +
        '<div>Record Officer\'s<br>Name: <span class="ln">' + esc(sc.recordOfficer) + '</span><br>Sign: <span class="ln"></span></div>' +
        '<div>Ass/Director\'s<br>Name: <span class="ln">' + esc(sc.director) + '</span><br>Sign: <span class="ln"></span></div></div>';
      var page = '<div class="rpage"><div class="r-title">' + esc(title) + '</div><table class="rtable">' + colgroup + thead + '<tbody>' + body + '</tbody></table>' + foot + '</div>';
      return preview ? '<div class="rpage-wrap">' + page + '</div>' : page;
    }).join('');
    return html;
  }
  function rosterReady() {
    var d = rosterData();
    if (!d.list.length) { toast('There are no students in this class.', 'warn'); return null; }
    if (!d.subs.length) { toast('Add at least one subject column first.', 'warn'); return null; }
    return d;
  }
  function printRoster() {
    var d = rosterReady(); if (!d) { return; }
    $('#printArea').innerHTML = rosterPagesHtml(d, false);
    setPageSize('landscape');
    setTimeout(function () { window.print(); }, 250);
  }
  window.addEventListener('afterprint', function () { $('#printArea').innerHTML = ''; });
  function exportRosterPdf() {
    var d = rosterReady(); if (!d) { return; }
    if (!(window.jspdf && window.jspdf.jsPDF && window.html2canvas)) {
      toast('The PDF library could not be loaded (no internet?). The print window opens - choose "Save as PDF" as the printer.', 'warn'); printRoster(); return;
    }
    busy(true, 'Creating PDF');
    var stage = $('#exportStage'); stage.innerHTML = rosterPagesHtml(d, false);
    var pages = $$('.rpage', stage), i = 0;
    var pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    function finish() { stage.innerHTML = ''; busy(false); }
    function next() {
      if (i >= pages.length) { pdf.save('Roster_Grade' + ui.ro.grade + (ui.ro.section || '') + '_' + stamp() + '.pdf'); finish(); toast('PDF created.', 'success'); return; }
      $('#busyText').textContent = 'Creating PDF - page ' + (i + 1) + ' of ' + pages.length;
      window.html2canvas(pages[i], { scale: 2.5, useCORS: true, backgroundColor: '#ffffff', logging: false }).then(function (canvas) {
        if (i > 0) { pdf.addPage(); }
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 297, 210, undefined, 'FAST');
        i++; setTimeout(next, 20);
      }).catch(function (err) { finish(); toast('PDF could not be created: ' + (err && err.message ? err.message : 'error') + '. Use Print and choose "Save as PDF".', 'error'); });
    }
    setTimeout(next, 150);
  }
  function exportRosterExcel() {
    var d = rosterReady(); if (!d) { return; }
    var rows = [['R.N.', "Student's Full Name", 'Age', 'Sex', 'Semester'].concat(d.subs.map(function (s) { return s.name; }), ['Total', 'Average', 'Rank', 'Remark', 'Conduct', 'Absent'])];
    d.list.forEach(function (st, i) {
      var c = d.calc[st.id];
      ['1', '2', 'AV'].forEach(function (k, ri) {
        var row = ri === 0 ? [i + 1, st.fullName, st.age, st.sex] : ['', '', '', ''];
        row.push(k === '1' ? 'I' : k === '2' ? 'II' : 'AV');
        c.rows[k].forEach(function (v) { row.push(v === null ? '' : v); });
        row.push(c[k].total === null ? '' : c[k].total, c[k].avg === null ? '' : c[k].avg, c[k].rank === null ? '' : c[k].rank, k === 'AV' ? remarkFor(st, d.calc) : '', k === 'AV' ? '' : ((recOf(st, d.year).conduct || {})[k] || ''), absentOf(st, d.year, k));
        rows.push(row);
      });
    });
    var name = 'Roster_Grade' + ui.ro.grade + (ui.ro.section || '') + '_' + stamp();
    if (hasXlsx()) {
      var X = window.XLSX, wb = X.utils.book_new(), ws = X.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 6 }, { wch: 32 }, { wch: 6 }, { wch: 6 }, { wch: 10 }].concat(d.subs.map(function () { return { wch: 11 }; }), [{ wch: 8 }, { wch: 9 }, { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 8 }]);
      X.utils.book_append_sheet(wb, ws, 'Roster'); X.writeFile(wb, name + '.xlsx');
    } else { downloadBlob(name + '.csv', '\uFEFF' + rows.map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n'), 'text/csv;charset=utf-8'); }
  }

  /* ---------- Audit log ---------- */
  function auditView() {
    var list = db.log.filter(function (l) { return sess.role === 'super' || l.schoolId === sess.schoolId; }).slice().reverse().slice(0, 200);
    var rows = list.map(function (l) {
      var d = new Date(l.t);
      return '<tr><td>' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '</td><td>' + esc(l.user) + '</td><td>' + esc(l.text) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="empty">No activity recorded yet.</td></tr>';
    return head('Audit log', 'The last 200 actions: who changed what and when.') +
      '<div class="panel"><div class="table-wrap"><table class="table log-list"><thead><tr><th>Time</th><th>User</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  /* ---------- Settings, password, backup ---------- */
  function settingsView() {
    var admin = sess.role === 'school', sc = admin ? school() : null, canBackup = (sess.role === 'super' && !API) || admin;
    var schoolPanel = sc ? '<div class="panel"><h2>School details</h2><label for="setName">School name (given by the Education Office)</label><input id="setName" type="text" value="' + esc(sc.name) + '" readonly>' +
      '<label for="setYear">Academic year</label><input id="setYear" type="text" maxlength="20" value="' + esc(sc.academicYear) + '">' +
      '<label for="setTown">Town / city (printed on the transcript)</label><input id="setTown" type="text" maxlength="40" value="' + esc(sc.town) + '">' +
      '<label for="setRegion">Region (printed on the transcript)</label><input id="setRegion" type="text" maxlength="40" value="' + esc(sc.region) + '">' +
      '<label>Assessment values (the three must add up to 100)</label><div class="toolbar"><div><label for="setAsT">Test / Assignment</label><input id="setAsT" type="number" min="0" max="100" value="' + esc((sc.assess || DEFAULT_ASSESS).test) + '"></div>' +
      '<div><label for="setAsM">Mid exam</label><input id="setAsM" type="number" min="0" max="100" value="' + esc((sc.assess || DEFAULT_ASSESS).mid) + '"></div>' +
      '<div><label for="setAsF">Final exam</label><input id="setAsF" type="number" min="0" max="100" value="' + esc((sc.assess || DEFAULT_ASSESS).final) + '"></div></div>' +
      '<p class="hint"><b>Promotion criteria</b> (Grade 12: passed / failed): average below 50 or 4 or more subjects below 50 = detained. 0 subjects below 50 and average 50 or more = promoted. 1 subject below 50 and average 52 or more = promoted. 2 subjects below 50 and average 54 or more = promoted. Every other case = detained.</p>' +
      '<label for="setOfficer">Record officer (printed on roster and transcript)</label><input id="setOfficer" type="text" maxlength="60" value="' + esc(sc.recordOfficer) + '">' +
      '<label for="setDirector">Assistant director / director (printed on roster and transcript)</label><input id="setDirector" type="text" maxlength="60" value="' + esc(sc.director) + '">' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="settings-save">Save settings</button></div></div>' : '';
    var logoPanel = sc ? '<div class="panel"><h2>Logos (printed on the transcript)</h2><div class="logo-row">' + ['Left', 'Right'].map(function (side) {
      var data = sc['logo' + side];
      return '<div class="logo-box"><div class="logo-prev">' + (data ? '<img src="' + esc(data) + '" alt="">' : '<span class="muted">Default</span>') + '</div><label for="setLogo' + side + '">' + side + ' logo</label>' +
        '<input id="setLogo' + side + '" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml">' + (data ? '<button class="link-btn danger" data-action="logo-clear" data-side="' + side + '">Use default</button>' : '') + '</div>';
    }).join('') + '</div><p class="hint">Choose a PNG or JPG picture. It is saved at once and shrunk to a small size.</p></div>' : '';
    return head(canBackup ? 'Settings and backup' : 'Password', sc ? 'School details, password and backup.' : (canBackup ? 'Password and backup of all data.' : 'Change your password.')) +
      (sess.role === 'super' && !db.superHash ? '<div class="notice"><b>Change the default password now.</b> The Education Office password is still the factory default. Choose a new one (8 or more characters, letters and numbers) before using the system.</div>' : '') + '<div class="grid-2">' + schoolPanel +
      '<div class="panel"><h2>Change my password</h2><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password">' +
      '<label for="pwNew">New password</label><input id="pwNew" type="password" autocomplete="new-password"><label for="pwCf">Confirm new password</label><input id="pwCf" type="password" autocomplete="new-password">' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="pass-change">Change password</button></div></div></div>' +
      logoPanel + (canBackup ? '<div class="panel"><h2>Backup</h2><p class="muted">Data is stored in this browser until you delete it. Download a backup regularly, especially before clearing the browser or moving to another computer.</p>' +
      '<div class="btn-row"><button class="btn" data-action="backup">Download backup</button><button class="btn" data-action="restore">Restore backup</button></div></div>' : '');
  }
  function saveSettings() {
    var a = Number($('#setAsT').value), b = Number($('#setAsM').value), c = Number($('#setAsF').value);
    if (![a, b, c].every(function (x) { return isFinite(x) && x >= 0 && x <= 100 && Math.floor(x) === x; }) || a + b + c !== 100) { toast('Test / Assignment, Mid exam and Final exam must be whole numbers that add up to 100.', 'error'); return; }
    commit(function () {
      var s = school();
      s.academicYear = trim($('#setYear').value) || currentYear();
      s.town = trim($('#setTown').value); s.region = trim($('#setRegion').value);
      s.recordOfficer = trim($('#setOfficer').value); s.director = trim($('#setDirector').value);
      s.assess = { test: a, mid: b, final: c };
    }, 'Updated school settings').then(function () { toast('Settings saved.', 'success'); showApp(); go('settings'); }).catch(function () { /* shown */ });
  }
  function changePassword() {
    var cur = $('#pwCur').value, nw = $('#pwNew').value, cf = $('#pwCf').value;
    if (API) {
      var prob0 = pwProblem(nw);
      if (prob0) { toast(prob0, 'error'); return; }
      if (nw !== cf) { toast('The new passwords do not match.', 'error'); return; }
      apiCall('/api/changepw', { current: cur, password: nw }).then(function () {
        $('#pwCur').value = ''; $('#pwNew').value = ''; $('#pwCf').value = ''; toast('Password changed.', 'success');
        if (sess.mustChange) { sess.mustChange = false; return loadServerState().then(showApp); }
      }).catch(function (e) { toast(e.message || 'The password could not be changed.', 'error'); });
      return;
    }
    checkPassword(cur).then(function (ok) {
      if (!ok) { toast('The current password is wrong.', 'error'); return null; }
      var prob = pwProblem(nw);
      if (prob) { toast(prob, 'error'); return null; }
      if (nw !== cf) { toast('The new passwords do not match.', 'error'); return null; }
      if (nw === cur) { toast('The new password must be different from the current one.', 'error'); return null; }
      return pwHash(nw).then(function (h) {
        return commit(function () {
          if (sess.role === 'super') { db.superHash = h; } else if (sess.role === 'school') { school().adminHash = h; } else { me().hash = h; }
        }, 'Changed password').then(function () { $('#pwCur').value = ''; $('#pwNew').value = ''; $('#pwCf').value = ''; toast('Password changed.', 'success'); render(); });
      });
    }).catch(function () { /* shown */ });
  }
  function backupData() {
    var payload;
    if (sess.role === 'super') { payload = { app: 'ddeo-sratms', scope: 'all', version: 1, exportedAt: new Date().toISOString(), db: db }; }
    else {
      var sc = JSON.parse(JSON.stringify(school())); delete sc.adminHash; (sc.staff || []).forEach(function (t) { delete t.hash; }); delete sc.staff;
      var studs = schoolStudents(), marks = {}, parts = {};
      studs.forEach(function (s) { if (db.marks[s.id]) { marks[s.id] = db.marks[s.id]; } if (db.parts[s.id]) { parts[s.id] = db.parts[s.id]; } });
      payload = { app: 'ddeo-sratms', scope: 'school', version: 1, exportedAt: new Date().toISOString(), school: sc, students: studs, marks: marks, parts: parts };
    }
    downloadBlob('sratms_backup_' + stamp() + '.json', JSON.stringify(payload), 'application/json');
    toast('Backup downloaded. Keep the file safe.', 'success');
  }
  function restoreData(file) {
    if (!file) { return; }
    var fr = new FileReader();
    fr.onerror = function () { toast('The backup file could not be read.', 'error'); };
    fr.onload = function () {
      var p;
      try { p = JSON.parse(String(fr.result)); } catch (e) { toast('This is not a valid backup file.', 'error'); return; }
      if (!p || p.app !== 'ddeo-sratms') { toast('This file is not a backup from this system.', 'error'); return; }
      if (sess.role === 'super' && p.scope === 'all' && p.db) {
        confirmBox('Restore full backup?', 'All current schools, students and marks will be replaced by the backup. Passwords come from the backup.', 'Restore', true).then(function (yes) {
          if (!yes) { return; }
          commit(function () { db = normalizeDb(p.db); }, 'Restored full backup').then(function () { toast('Backup restored.', 'success'); render(); }).catch(function () { /* shown */ });
        });
      } else if (sess.role === 'school' && p.scope === 'school' && p.school && Array.isArray(p.students)) {
        confirmBox('Restore school backup?', 'The students and marks of your school will be replaced by the backup (' + p.students.length + ' students).', 'Restore', true).then(function (yes) {
          if (!yes) { return; }
          commit(function () {
            var sc = school(), oldIds = {};
            db.students.forEach(function (s) { if (s.schoolId === sc.id) { oldIds[s.id] = 1; delete db.marks[s.id]; delete db.parts[s.id]; } });
            db.students = db.students.filter(function (s) { return s.schoolId !== sc.id; });
            p.students.forEach(function (s) { db.students.push(Object.assign({}, s, { schoolId: sc.id })); });
            Object.keys(p.marks || {}).forEach(function (id) { db.marks[id] = p.marks[id]; });
            Object.keys(p.parts || {}).forEach(function (id) { db.parts[id] = p.parts[id]; });
            if (Array.isArray(p.school.subjects)) { sc.subjects = p.school.subjects; }
            ['logoLeft', 'logoRight'].forEach(function (k) { if (p.school[k]) { sc[k] = p.school[k]; } });
            (sc.staff || []).forEach(function (t) { t.subjectIds = (t.subjectIds || []).filter(function (x) { return sc.subjects.some(function (s) { return s.id === x; }); }); });
          }, 'Restored school backup').then(function () { toast('Backup restored.', 'success'); render(); }).catch(function () { /* shown */ });
        });
      } else { toast('This backup does not match your account type.', 'error'); }
    };
    fr.readAsText(file);
  }

  function curSchoolId() { return !sess ? '' : (sess.role === 'super' ? ui.mon.schoolId : sess.schoolId); }

  /* ---------- Roles and access ----------
     super    = Education Office admin: monitors every school (read only) and sees the statistics
     school   = school admin: everything at school level, prepares the transcripts
     homeroom = home room teacher: prepares the roster of the own class
     subject  = subject teacher: enters marks (0-100) for the own subject and classes only */
  function me() {
    var sc = school();
    if (!sc || !sess.staffId) { return null; }
    return (sc.staff || []).filter(function (t) { return t.id === sess.staffId; })[0] || null;
  }

  function canEdit() { return !!sess && sess.role === 'school'; }

  function visibleStudents() {
    if (sess.role === 'homeroom') { var h = me(); return h ? classStudents(h.grade, h.section) : []; }
    return schoolStudents();
  }

  function allowedGrades() {
    var t = me(), set = {};
    ((t && t.classes) || []).forEach(function (k) { set[k.split('|')[0]] = 1; });
    return GRADES.filter(function (g) { return set[g]; });
  }

  function allowedSections(grade) {
    var t = me(), all = false, set = {};
    ((t && t.classes) || []).forEach(function (k) {
      var p = k.split('|');
      if (p[0] !== grade) { return; }
      if (p[1] === '') { all = true; } else { set[p[1]] = 1; }
    });
    if (all) { sectionsOf(grade).forEach(function (s) { set[s] = 1; }); }
    return { all: all, secs: Object.keys(set).sort() };
  }

  function classAllowed(grade, section) {
    if (sess.role === 'school') { return true; }
    if (sess.role !== 'subject') { return false; }
    var a = allowedSections(grade);
    if (a.all) { return true; }
    return !!section && a.secs.indexOf(section) !== -1;
  }

  function subjectName(id) {
    var s = (school() ? school().subjects : []).filter(function (x) { return x.id === id; })[0];
    return s ? s.name : '';
  }

  function classKeyLabel(k) { var p = k.split('|'); return 'Grade ' + p[0] + (p[1] ? ' ' + p[1] : ' (all sections)'); }

  function classChoices(selected) {
    var out = [];
    GRADES.forEach(function (g) { out.push(g + '|'); sectionsOf(g).forEach(function (s) { out.push(g + '|' + s); }); });
    (selected || []).forEach(function (k) { if (out.indexOf(k) === -1) { out.push(k); } });
    return out;
  }

  function usernameTaken(user, exceptStaffId, exceptSchoolId) {
    var u = user.toLowerCase();
    if (u === SUPER_USER) { return true; }
    return db.schools.some(function (s) {
      if (s.id !== exceptSchoolId && s.adminUser.toLowerCase() === u) { return true; }
      return (s.staff || []).some(function (t) { return t.id !== exceptStaffId && t.username.toLowerCase() === u; });
    });
  }

  function teachersOfSubject(sc, subId) {
    return (sc.staff || []).filter(function (t) { return t.role === 'subject' && (t.subjectIds || []).indexOf(subId) !== -1; }).map(function (t) { return t.name; });
  }

  function afterRender() {
    var v = view === 'monitor' ? monitorInner() : view;
    if (v === 'students') { fillStudentRows(); }
    if (v === 'roster') { renderRosterPreview(); }
    if (v === 'transcript') { fillTranscriptRows(); renderTranscriptPreview(); }
    if (v === 'marks') { updateMarkCount(); }
  }

  function statCard(n, label, cls) { return '<div class="stat ' + (cls || '') + '"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>'; }

  function bar(pct) {
    if (pct === null || pct === undefined) { return '<span class="muted">-</span>'; }
    return '<span class="bar"><i style="width:' + pct + '%"></i></span><span class="bar-n">' + pct + '%</span>';
  }

  function completion(sc, sem, list) {
    var expected = list.length * sc.subjects.length, entered = 0;
    list.forEach(function (st) {
      var cur = getMarks(st.id, sc.academicYear, sem);
      sc.subjects.forEach(function (s) { if (numOrNull(cur[s.id]) !== null) { entered++; } });
    });
    return { entered: entered, expected: expected, pct: expected ? Math.round(entered * 100 / expected) : null };
  }

  function schoolStats(sc) {
    var list = db.students.filter(function (s) { return s.schoolId === sc.id; });
    var male = list.filter(function (s) { return s.sex === 'M'; }).length, byGrade = {}, gradeAgg = {};
    GRADES.forEach(function (g) { byGrade[g] = 0; gradeAgg[g] = { n: 0, ass: 0, pass: 0, sum: 0 }; });
    var calc = computeClass(list, sc.subjects, sc.academicYear), ass = 0, pass = 0, sum = 0;
    list.forEach(function (st) {
      byGrade[st.grade]++; gradeAgg[st.grade].n++;
      var a = calc[st.id].AV.avg;
      if (a === null) { return; }
      ass++; sum += a; gradeAgg[st.grade].ass++; gradeAgg[st.grade].sum += a;
      var rk = remarkFor(st, calc);
      if (rk === 'Promoted' || rk === 'Passed') { pass++; gradeAgg[st.grade].pass++; }
    });
    var staff = sc.staff || [];
    return {
      sc: sc, list: list, male: male, female: list.length - male, byGrade: byGrade, gradeAgg: gradeAgg, assessed: ass, passed: pass,
      avg: ass ? round1(sum / ass) : null, passRate: ass ? Math.round(pass * 100 / ass) : null,
      c1: completion(sc, '1', list), c2: completion(sc, '2', list), staff: staff.length,
      homeroom: staff.filter(function (t) { return t.role === 'homeroom'; }).length, subjectT: staff.filter(function (t) { return t.role === 'subject'; }).length
    };
  }

  function progressTableHtml(sc, list, year) {
    if (!sc.subjects.length) { return '<p class="muted">No subjects yet.</p>'; }
    var rows = sc.subjects.map(function (sub) {
      var cells = ['1', '2'].map(function (sem) {
        var n = 0; list.forEach(function (st) { if (numOrNull(getMarks(st.id, year, sem)[sub.id]) !== null) { n++; } });
        return '<td>' + bar(list.length ? Math.round(n * 100 / list.length) : null) + '<small>' + n + ' of ' + list.length + ' students</small></td>';
      }).join('');
      var names = teachersOfSubject(sc, sub.id);
      return '<tr><td><strong>' + esc(sub.name) + '</strong></td><td>' + (names.length ? esc(names.join(', ')) : '<span class="muted">not assigned</span>') + '</td>' + cells + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>Subject</th><th>Subject teacher</th><th>Semester I</th><th>Semester II</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function overviewHtml(sc, quick) {
    var s = schoolStats(sc);
    var byGrade = GRADES.map(function (g) {
      var sub = '';
      if (g === '11' || g === '12') {
        var gl = s.list.filter(function (x) { return x.grade === g; }), nat = gl.filter(function (x) { return x.stream === 'Natural Science'; }).length, soc = gl.filter(function (x) { return x.stream === 'Social Science'; }).length;
        sub = '<small>Natural Science ' + nat + ', Social Science ' + soc + (gl.length - nat - soc ? ', not chosen ' + (gl.length - nat - soc) : '') + '</small>';
      }
      return '<tr><td>Grade ' + g + sub + '</td><td>' + s.byGrade[g] + '</td></tr>';
    }).join('');
    var results = '<div class="panel"><h2>Results (' + esc(sc.academicYear) + ')</h2><table class="table"><tbody><tr><td>Students with an annual average</td><td>' + s.assessed + '</td></tr>' +
      '<tr><td>Promoted / passed</td><td>' + s.passed + '</td></tr><tr><td>Average of the annual averages</td><td>' + (s.avg === null ? '-' : s.avg) + '</td></tr>' +
      '<tr><td>Home room / subject teachers</td><td>' + s.homeroom + ' / ' + s.subjectT + '</td></tr></tbody></table></div>';
    return '<div class="stats">' + statCard(s.list.length, 'Students') + statCard(s.male, 'Male', 'green') + statCard(s.female, 'Female', 'gold') +
      statCard(s.passRate === null ? '-' : s.passRate + '%', 'Pass rate', 'red') + '</div>' +
      '<div class="grid-2"><div class="panel"><h2>Students by grade</h2><table class="table"><tbody>' + byGrade + '</tbody></table></div>' + (quick || results) + '</div>' +
      '<div class="panel"><h2>Marks submitted by the subject teachers</h2>' + progressTableHtml(sc, s.list, sc.academicYear) +
      '<p class="hint">Academic year ' + esc(sc.academicYear) + '. A bar is full when every student has a mark in that subject.</p></div>';
  }

  function homeroomDashboard(sc) {
    var h = me();
    if (!h) { return head('My class', '') + '<div class="panel"><p class="muted">Your account is not linked to a class.</p></div>'; }
    var list = visibleStudents(), male = list.filter(function (s) { return s.sex === 'M'; }).length;
    return head('My class', 'Home room teacher - Grade ' + h.grade + (h.section ? ' ' + h.section : '') + ' - academic year ' + sc.academicYear) +
      '<div class="stats">' + statCard(list.length, 'Students') + statCard(male, 'Male', 'green') + statCard(list.length - male, 'Female', 'gold') + statCard(sc.subjects.length, 'Subjects', 'red') + '</div>' +
      '<div class="panel"><h2>Marks submitted by the subject teachers</h2>' + progressTableHtml(sc, list, sc.academicYear) +
      '<p class="hint">When the subjects of the semester are complete, open the Roster, check it and print it.</p>' +
      '<div class="btn-row"><button class="btn btn-primary" data-action="nav" data-view="roster">Open roster</button><button class="btn" data-action="nav" data-view="students">Students</button></div></div>';
  }

  function subjectDashboard(sc) {
    var t = me();
    if (!t) { return head('Dashboard', '') + '<div class="panel"><p class="muted">Your account was not found.</p></div>'; }
    var subs = sc.subjects.filter(function (s) { return (t.subjectIds || []).indexOf(s.id) !== -1; }), rows = [];
    (t.classes || []).forEach(function (k) {
      var p = k.split('|'), list = classStudents(p[0], p[1]);
      subs.forEach(function (sub) {
        var c = ['1', '2'].map(function (sem) {
          var n = 0; list.forEach(function (st) { if (numOrNull(getMarks(st.id, sc.academicYear, sem)[sub.id]) !== null) { n++; } });
          return '<td>' + bar(list.length ? Math.round(n * 100 / list.length) : null) + '<small>' + n + ' of ' + list.length + '</small></td>';
        }).join('');
        rows.push('<tr><td><strong>' + esc(sub.name) + '</strong></td><td>' + esc(classKeyLabel(k)) + '</td><td>' + list.length + '</td>' + c + '</tr>');
      });
    });
    return head('Dashboard', 'Subject teacher - academic year ' + sc.academicYear) +
      (t.submittedAt ? '<div class="notice"><b>Your results were submitted</b> (' + esc(t.submittedFor || '') + '). Your account is deactivated for entering marks until the school admin resets it.</div>' : '') +
      '<div class="panel"><h2>My subjects and classes</h2>' + (rows.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Subject</th><th>Class</th><th>Students</th><th>Semester I</th><th>Semester II</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' :
      '<p class="muted">The school admin has not assigned a subject and a class to your account yet.</p>') +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="nav" data-view="marks">Enter marks</button></div>' +
      '<p class="hint">You can see and change the marks of your own subject only. Marks are out of 100.</p></div>';
  }

  function updateMarkCount() {
    var el = $('#mkCount'); if (!el) { return; }
    var rows = $$('tr[data-row]'), n = rows.filter(function (tr) {
      return $$('input[data-part]', tr).every(function (i) { return trim(i.value) !== ''; });
    }).length;
    el.textContent = n + ' of ' + rows.length + ' students complete';
  }
  function updateRowTotal(tr) {
    if (!tr) { return; }
    var cell = tr.querySelector('[data-total]'); if (!cell) { return; }
    var sum = 0, n = 0;
    $$('input[data-part]', tr).forEach(function (i) { if (trim(i.value) !== '' && isFinite(Number(i.value))) { sum += Number(i.value); n++; } });
    cell.innerHTML = '<strong>' + (n === 3 ? round1(sum) : (n ? '...' : esc(cell.getAttribute('data-legacy') || ''))) + '</strong>';
  }
  function getParts(sid, year, sem, sub) {
    var p = db.parts[sid];
    return (p && p[year] && p[year][sem] && p[year][sem][sub]) || {};
  }
  /* a subject teacher's submitted result is sealed: the school admin cannot change it */
  function subjectLocked(sc, st, subId, year, sem) {
    return (sc.staff || []).some(function (t) {
      return t.role === 'subject' && (t.subjectIds || []).indexOf(subId) !== -1 && (t.sealed || []).some(function (x) { return x.year === year && x.sem === sem; }) &&
        (t.classes || []).some(function (k) { var p = k.split('|'); return st.grade === p[0] && (!p[1] || st.section === p[1]); });
    });
  }
  /* ---------- Teachers (home room teachers and subject teachers) ---------- */
  function staffView() {
    var sc = school(), edit = canEdit(), list = (sc.staff || []).slice().sort(function (a, b) { return a.role.localeCompare(b.role) || a.name.localeCompare(b.name); });
    var rows = list.map(function (t) {
      var what = t.role === 'homeroom' ? 'Grade ' + esc(t.grade) + (t.section ? ' ' + esc(t.section) : '') :
        esc((t.subjectIds || []).map(subjectName).filter(Boolean).join(', ') || 'no subject') + '<small>' + esc((t.classes || []).map(classKeyLabel).join('; ') || 'no class') + '</small>';
      var status = t.role === 'subject' && t.submittedAt ? '<span class="chip">Submitted - deactivated</span><small>' + esc(t.submittedFor || '') + '</small>' : '<span class="chip ok">Active</span>';
      return '<tr><td><strong>' + esc(t.name) + '</strong></td><td class="mono">' + esc(t.username) + '</td><td>' + (t.role === 'homeroom' ? 'Home room teacher' : 'Subject teacher') + '</td><td>' + what + '</td><td>' + status + '</td>' +
        (edit ? '<td class="col-actions">' + (t.role === 'subject' && t.submittedAt ? '<button class="link-btn" data-action="staff-reset" data-id="' + esc(t.id) + '">Reset</button>' : '') + '<button class="link-btn" data-action="staff-edit" data-id="' + esc(t.id) + '">Edit</button><button class="link-btn danger" data-action="staff-del" data-id="' + esc(t.id) + '">Delete</button></td>' : '') + '</tr>';
    }).join('') || '<tr><td colspan="' + (edit ? 6 : 5) + '" class="empty">No teacher accounts yet.</td></tr>';
    return head('Teachers', 'Home room teachers prepare the roster of their class. Subject teachers submit the marks (out of 100) of their own subject only; after they submit, their account is deactivated until you press Reset.') +
      '<div class="panel">' + (edit ? '<div class="btn-row spaced"><button class="btn btn-primary" data-action="staff-add">Add teacher account</button></div>' : '') +
      '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Assigned to</th><th>Status</th>' + (edit ? '<th class="col-actions">Actions</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (edit ? '<p class="hint">Every class can have one home room teacher. A subject teacher can be given several subjects and classes. Teachers sign in with the username and password you create here.</p>' : '') + '</div>';
  }

  function staffFormHtml(t) {
    var sc = school(), isNew = !t, role = t ? t.role : 'subject', sel = t && t.classes ? t.classes : [];
    var subs = sc.subjects.map(function (s) {
      return '<label><input type="checkbox" name="sfSub" value="' + esc(s.id) + '"' + (t && (t.subjectIds || []).indexOf(s.id) !== -1 ? ' checked' : '') + '> ' + esc(s.name) + '</label>';
    }).join('') || '<span class="muted">Add subjects first (Subjects page).</span>';
    var cls = classChoices(sel).map(function (k) {
      return '<label><input type="checkbox" name="sfCls" value="' + esc(k) + '"' + (sel.indexOf(k) !== -1 ? ' checked' : '') + '> ' + esc(classKeyLabel(k)) + '</label>';
    }).join('');
    return '<div class="modal-head"><h2>' + (isNew ? 'Add teacher account' : 'Edit teacher account') + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="staffForm" novalidate data-edit-id="' + (isNew ? '' : esc(t.id)) + '"><div class="modal-body"><div class="form-grid">' +
      '<div class="full"><label for="sfName">Full name</label><input id="sfName" type="text" maxlength="80" value="' + esc(t ? t.name : '') + '"><div class="field-error" data-err="name"></div></div>' +
      '<div><label for="sfUser">Username</label><input id="sfUser" type="text" maxlength="30" autocomplete="off" value="' + esc(t ? t.username : '') + '"><div class="field-error" data-err="user"></div></div>' +
      '<div><label for="sfPass">' + (isNew ? 'Password' : 'New password (empty = keep)') + '</label><input id="sfPass" type="password" autocomplete="new-password"><div class="field-error" data-err="pass"></div></div>' +
      '<div class="full"><label for="sfRole">Role</label><select id="sfRole"><option value="subject"' + (role === 'subject' ? ' selected' : '') + '>Subject teacher (enters marks of own subject)</option>' +
      '<option value="homeroom"' + (role === 'homeroom' ? ' selected' : '') + '>Home room teacher (prepares the roster of a class)</option></select></div>' +
      '<div class="full" id="grpHr"' + (role === 'homeroom' ? '' : ' hidden') + '><div class="form-grid"><div><label for="sfGrade">Grade</label><select id="sfGrade">' + gradeOpts(t ? t.grade : '', 'Select grade') + '</select></div>' +
      '<div><label for="sfSection">Section</label><input id="sfSection" type="text" maxlength="10" list="secList" placeholder="A" value="' + esc(t ? t.section : '') + '"><datalist id="secList">' + sectionsOf('').map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></div></div>' +
      '<div class="field-error" data-err="hr"></div></div>' +
      '<div class="full" id="grpSub"' + (role === 'subject' ? '' : ' hidden') + '><label>Subjects</label><div class="check-list">' + subs + '</div><div class="field-error" data-err="sub"></div>' +
      '<label>Classes</label><div class="check-list">' + cls + '</div><div class="field-error" data-err="cls"></div></div>' +
      '</div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>';
  }

  function toggleStaffRole() {
    var r = $('#sfRole').value;
    $('#grpHr').hidden = r !== 'homeroom'; $('#grpSub').hidden = r !== 'subject';
  }

  function handleStaffSubmit(form) {
    var editId = form.getAttribute('data-edit-id'), sc = school();
    $$('[data-err]', form).forEach(function (e) { e.textContent = ''; });
    var name = trim($('#sfName').value), user = trim($('#sfUser').value), pass = $('#sfPass').value, role = $('#sfRole').value, ok = true;
    if (name.length < 3) { setErr('name', 'Enter the full name.'); ok = false; }
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(user)) { setErr('user', 'Use 3-30 letters, numbers, dot, dash or underscore.'); ok = false; }
    else if (usernameTaken(user, editId, null)) { setErr('user', 'This username is already used.'); ok = false; }
    if ((!editId && pwProblem(pass)) || (editId && pass && pwProblem(pass))) { setErr('pass', pwProblem(pass)); ok = false; }
    var rec = { name: name, username: user, role: role, grade: '', section: '', subjectIds: [], classes: [] };
    if (role === 'homeroom') {
      rec.grade = $('#sfGrade').value; rec.section = trim($('#sfSection').value).toUpperCase();
      if (!rec.grade) { setErr('hr', 'Select the grade of the class.'); ok = false; }
      else if ((sc.staff || []).some(function (t) { return t.id !== editId && t.role === 'homeroom' && t.grade === rec.grade && t.section === rec.section; })) { setErr('hr', 'This class already has a home room teacher.'); ok = false; }
    } else {
      rec.subjectIds = $$('input[name="sfSub"]:checked', form).map(function (i) { return i.value; });
      rec.classes = $$('input[name="sfCls"]:checked', form).map(function (i) { return i.value; });
      if (!rec.subjectIds.length) { setErr('sub', 'Select at least one subject.'); ok = false; }
      if (!rec.classes.length) { setErr('cls', 'Select at least one class.'); ok = false; }
    }
    if (!ok) { return; }
    pwHashIf(pass).then(function (h) { return commit(function () {
      var s = school();
      if (editId) {
        var t = s.staff.filter(function (x) { return x.id === editId; })[0];
        Object.assign(t, rec); if (h) { t.hash = h; }
      } else {
        s.staff.push(Object.assign({ id: (window.__newId = uid()), hash: h, createdAt: new Date().toISOString() }, rec));
      }
    }, (editId ? 'Edited teacher account ' : 'Added teacher account ') + name + ' (' + (role === 'homeroom' ? 'home room' : 'subject') + ')'); }).then(function () { return apiPw('staff', editId || window.__newId, pass); }).then(function () {
      closeModal(true); toast('Teacher account saved.', 'success'); render();
    }).catch(function () { /* shown */ });
  }

  function resetStaff(id) {
    var t = (school().staff || []).filter(function (x) { return x.id === id; })[0];
    if (!t) { return; }
    commit(function () { var x = school().staff.filter(function (y) { return y.id === id; })[0]; delete x.submittedAt; delete x.submittedFor; }, 'Reset subject teacher account ' + t.name + ' (can enter marks again)')
      .then(function () { toast(t.name + ' can enter marks again.', 'success'); render(); }).catch(function () { /* shown */ });
  }
  function deleteStaff(id) {
    var t = (school().staff || []).filter(function (x) { return x.id === id; })[0];
    if (!t) { return; }
    confirmBox('Delete teacher account?', t.name + ' will not be able to sign in any more. The marks this teacher entered stay.', 'Delete', true).then(function (yes) {
      if (!yes) { return; }
      commit(function () { var s = school(); s.staff = s.staff.filter(function (x) { return x.id !== id; }); }, 'Deleted teacher account ' + t.name)
        .then(function () { toast('Deleted.', 'success'); render(); }).catch(function () { /* shown */ });
    });
  }

  /* ---------- Education Office: monitor one school (read only) ---------- */
  function monitorInner() { return ui.mon.schoolId ? ui.mon.tab : ''; }

  function monitorView() {
    var m = ui.mon, sc = school();
    var picker = '<div class="panel"><div class="toolbar"><div><label>School</label><select data-ui="mon.schoolId">' + opts(db.schools.map(function (s) { return [s.id, s.name]; }), m.schoolId, 'Select a school') + '</select></div></div></div>';
    if (!sc) {
      return head('School statistics', 'Choose a school to see its statistics. The Education Office sees statistics only; students, rosters and transcripts stay with the school.') + picker +
        (db.schools.length ? '' : '<div class="panel"><p class="muted">No schools are registered yet.</p></div>');
    }
    return head(sc.name, 'Statistics - academic year ' + sc.academicYear) + picker + overviewHtml(sc);
  }

  function pctCell(p) { return p === null || p === undefined ? '<span class="muted">-</span>' : bar(p); }

  /* ---------- Education Office statistics ---------- */
  function statisticsView() {
    if (!db.schools.length) { return head('Statistics', 'Figures from all schools of the Education Office.') + '<div class="panel"><p class="muted">No schools are registered yet. Register a school on the Schools page.</p></div>'; }
    var all = db.schools.map(schoolStats), T = { n: 0, m: 0, f: 0, staff: 0, e1: 0, x1: 0, e2: 0, x2: 0, ass: 0, pass: 0 }, G = {};
    GRADES.forEach(function (g) { G[g] = { n: 0, ass: 0, pass: 0, sum: 0 }; });
    all.forEach(function (s) {
      T.n += s.list.length; T.m += s.male; T.f += s.female; T.staff += s.staff;
      T.e1 += s.c1.entered; T.x1 += s.c1.expected; T.e2 += s.c2.entered; T.x2 += s.c2.expected; T.ass += s.assessed; T.pass += s.passed;
      GRADES.forEach(function (g) { var a = s.gradeAgg[g]; G[g].n += a.n; G[g].ass += a.ass; G[g].pass += a.pass; G[g].sum += a.sum; });
    });
    var pc = function (a, b) { return b ? Math.round(a * 100 / b) : null; };
    var schoolRows = all.map(function (s) {
      return '<tr><td><strong>' + esc(s.sc.name) + '</strong><small>Academic year ' + esc(s.sc.academicYear) + '</small></td><td>' + s.list.length + '</td><td>' + s.male + '</td><td>' + s.female + '</td>' +
        GRADES.map(function (g) { return '<td>' + s.byGrade[g] + '</td>'; }).join('') + '<td>' + s.staff + '</td><td>' + pctCell(s.c1.pct) + '</td><td>' + pctCell(s.c2.pct) + '</td>' +
        '<td>' + (s.avg === null ? '-' : s.avg) + '</td><td>' + pctCell(s.passRate) + '</td><td class="col-actions"><button class="link-btn" data-action="school-monitor" data-id="' + esc(s.sc.id) + '">School statistics</button></td></tr>';
    }).join('');
    var gradeRows = GRADES.map(function (g) {
      return '<tr><td>Grade ' + g + '</td><td>' + G[g].n + '</td><td>' + G[g].ass + '</td><td>' + (G[g].ass ? round1(G[g].sum / G[g].ass) : '-') + '</td><td>' + pctCell(pc(G[g].pass, G[g].ass)) + '</td></tr>';
    }).join('');
    var subjRows = subjectAgg().map(function (o) {
      return '<tr><td><strong>' + esc(o.name) + '</strong></td><td>' + (o.n1 ? round1(o.s1 / o.n1) : '-') + '</td><td>' + (o.n2 ? round1(o.s2 / o.n2) : '-') + '</td><td>' + o.n1 + ' / ' + o.n2 + '</td><td>' + pctCell(pc(o.ap, o.an)) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No marks entered yet.</td></tr>';
    return head('Statistics', 'All schools of the Education Office. Figures use each school\'s current academic year.') +
      '<div class="stats">' + statCard(all.length, 'Schools') + statCard(T.n, 'Students', 'green') + statCard(pc(T.f, T.n) === null ? '-' : pc(T.f, T.n) + '%', 'Female students', 'gold') +
      statCard(T.staff, 'Teacher accounts', 'red') + statCard(pc(T.e1, T.x1) === null ? '-' : pc(T.e1, T.x1) + '%', 'Semester I marks entered') + statCard(pc(T.e2, T.x2) === null ? '-' : pc(T.e2, T.x2) + '%', 'Semester II marks entered', 'green') +
      statCard(pc(T.pass, T.ass) === null ? '-' : pc(T.pass, T.ass) + '%', 'Pass rate (annual average)', 'gold') + '</div>' +
      '<div class="panel"><h2>Schools compared</h2><div class="btn-row spaced"><button class="btn" data-action="stats-xlsx">Export to Excel</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>School</th><th>Students</th><th>Male</th><th>Female</th><th>G9</th><th>G10</th><th>G11</th><th>G12</th><th>Teachers</th><th>Sem I marks</th><th>Sem II marks</th><th>Average</th><th>Pass rate</th><th class="col-actions"></th></tr></thead><tbody>' + schoolRows + '</tbody></table></div>' +
      '<p class="hint">"Sem I / Sem II marks" show how many of the expected marks (students x subjects) the teachers have entered. Average uses the annual average (semester I + II) / 2. Pass rate = students promoted or passed under the promotion criteria.</p></div>' +
      '<div class="grid-2"><div class="panel"><h2>By grade</h2><div class="table-wrap"><table class="table"><thead><tr><th>Grade</th><th>Students</th><th>With annual average</th><th>Average</th><th>Pass rate</th></tr></thead><tbody>' + gradeRows + '</tbody></table></div></div>' +
      '<div class="panel"><h2>By subject (all schools)</h2><div class="table-wrap"><table class="table"><thead><tr><th>Subject</th><th>Sem I average</th><th>Sem II average</th><th>Marks (I / II)</th><th>Passing</th></tr></thead><tbody>' + subjRows + '</tbody></table></div></div></div>';
  }

  function subjectAgg() {
    var m = {};
    db.schools.forEach(function (sc) {
      var list = db.students.filter(function (s) { return s.schoolId === sc.id; }), mark = PASS_MARK;
      sc.subjects.forEach(function (sub) {
        var key = sub.name.toLowerCase(), o = m[key] = m[key] || { name: sub.name, n1: 0, s1: 0, n2: 0, s2: 0, an: 0, ap: 0 };
        list.forEach(function (st) {
          var x = numOrNull(getMarks(st.id, sc.academicYear, '1')[sub.id]), y = numOrNull(getMarks(st.id, sc.academicYear, '2')[sub.id]);
          if (x !== null) { o.n1++; o.s1 += x; }
          if (y !== null) { o.n2++; o.s2 += y; }
          if (x !== null && y !== null) { o.an++; if ((x + y) / 2 >= mark) { o.ap++; } }
        });
      });
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  function exportStatsExcel() {
    var rows = [['School', 'Academic year', 'Students', 'Male', 'Female', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12', 'Teachers', 'Semester I marks entered %', 'Semester II marks entered %', 'Average (annual)', 'Pass rate %']];
    db.schools.map(schoolStats).forEach(function (s) {
      rows.push([s.sc.name, s.sc.academicYear, s.list.length, s.male, s.female, s.byGrade['9'], s.byGrade['10'], s.byGrade['11'], s.byGrade['12'], s.staff,
        s.c1.pct === null ? '' : s.c1.pct, s.c2.pct === null ? '' : s.c2.pct, s.avg === null ? '' : s.avg, s.passRate === null ? '' : s.passRate]);
    });
    var name = 'Statistics_' + stamp();
    if (hasXlsx()) {
      var X = window.XLSX, wb = X.utils.book_new(), ws = X.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 34 }, { wch: 12 }].concat(rows[0].slice(2).map(function () { return { wch: 14 }; }));
      X.utils.book_append_sheet(wb, ws, 'Schools'); X.writeFile(wb, name + '.xlsx');
    } else { downloadBlob(name + '.csv', '\uFEFF' + rows.map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n'), 'text/csv;charset=utf-8'); }
  }

  /* ---------- Transcript (Grades 9-12) ---------- */
  function hasAny(o) { return !!o && Object.keys(o).some(function (k) { return numOrNull(o[k]) !== null; }); }

  /* Which academic year the student studied each grade in. It is saved when the marks are saved;
     for older data the years are assigned backwards from the current grade. */
  function gradeYearMap(st) {
    var map = {}, used = {}, g;
    GRADES.forEach(function (k) { var y = st.gradeYears && st.gradeYears[k]; if (y) { map[k] = y; used[y] = 1; } });
    var years = Object.keys(db.marks[st.id] || {}).filter(function (y) { return !used[y]; }).sort().reverse();
    g = parseInt(st.grade, 10);
    years.forEach(function (y) {
      while (g >= 9 && map[String(g)]) { g--; }
      if (g >= 9) { map[String(g)] = y; g--; }
    });
    return map;
  }

  function coverage(st) {
    var map = gradeYearMap(st), marks = db.marks[st.id] || {}, o = {};
    GRADES.forEach(function (g) { var m = map[g] && marks[map[g]]; o[g] = !!(m && (hasAny(m['1']) || hasAny(m['2']))); });
    return o;
  }

  function transcriptData(st, sc) {
    var map = gradeYearMap(st), marks = db.marks[st.id] || {}, cells = {}, used = {};
    GRADES.forEach(function (g) {
      var y = map[g], a = (y && marks[y] && marks[y]['1']) || {}, b = (y && marks[y] && marks[y]['2']) || {};
      cells[g] = {};
      sc.subjects.forEach(function (sub) {
        var x = numOrNull(a[sub.id]), z = numOrNull(b[sub.id]);
        cells[g][sub.id] = { s1: x, s2: z, ave: x !== null && z !== null ? round1((x + z) / 2) : null };
        if (x !== null || z !== null) { used[sub.id] = 1; }
      });
    });
    var subs = sc.subjects.filter(function (s) { return used[s.id]; });
    if (!subs.length) { subs = sc.subjects.slice(); }
    return { st: st, sc: sc, map: map, cells: cells, subs: subs };
  }

  function academicRange(map, fallback) {
    var ys = GRADES.map(function (g) { return map[g]; }).filter(Boolean).sort();
    if (!ys.length) { return fallback; }
    var first = ys[0], last = ys[ys.length - 1];
    if (first === last) { return first; }
    var a = /^(\d{4})\s*\/\s*(\d{4})$/.exec(first), b = /^(\d{4})\s*\/\s*(\d{4})$/.exec(last);
    return a && b ? a[1] + '/' + b[2] : first + ' - ' + last;
  }

  var LOGO_LEFT = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="48" fill="#1d5fa8"/><circle cx="50" cy="50" r="41" fill="none" stroke="#e3a817" stroke-width="3" stroke-dasharray="2 4"/><circle cx="50" cy="50" r="31" fill="#fff"/>' +
    '<path d="M27 54 C37 47 46 49 50 55 C54 49 63 47 73 54 V68 C63 62 54 64 50 70 C46 64 37 62 27 68 Z" fill="#e8f0fb" stroke="#12335c" stroke-width="2"/><path d="M50 55 V70" stroke="#12335c" stroke-width="2"/><path d="M50 27 C43 36 43 42 50 46 C57 42 57 36 50 27 Z" fill="#e8841a"/></svg>';
  var LOGO_RIGHT = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="48" fill="#fff" stroke="#1d4e9a" stroke-width="3"/><circle cx="50" cy="50" r="31" fill="none" stroke="#1d4e9a" stroke-width="1.5"/>' +
    '<defs><path id="tcArcB" d="M 6 50 A 44 44 0 0 0 94 50"/></defs>' +
    '<text font-size="7.5" font-weight="700" fill="#1d4e9a" font-family="Arial, sans-serif"><textPath href="#tcArcB" startOffset="50%" text-anchor="middle">EDUCATION FOR ALL</textPath></text>' +
    '<path d="M30 55 C38 49 46 51 50 57 C54 51 62 49 70 55 V69 C62 63 54 65 50 71 C46 65 38 63 30 69 Z" fill="#fff" stroke="#111" stroke-width="2"/><path d="M50 57 V71" stroke="#111" stroke-width="2"/><path d="M50 30 C44 38 44 43 50 47 C56 43 56 38 50 30 Z" fill="#e8841a"/></svg>';

  function logoHtml(data, svg) { return data ? '<img src="' + esc(data) + '" alt="">' : svg; }
  function transcriptPageHtml(st, sc) {
    var d = transcriptData(st, sc), g9 = d.map['9'];
    var fld = function (label, val) { return '<div class="t-f"><span class="t-l">' + label + '</span><span class="t-v">' + esc(val) + '</span></div>'; };
    var cb = function (on) { return '<span class="cb">' + (on ? '\u2713' : '') + '</span>'; };
    var info = '<div class="t-box t-info"><div class="t-col">' + fld('Student Name:', st.fullName) + fld('Student ID:', st.studentId || '') +
      '<div class="t-f"><span class="t-l">Sex:</span><span class="t-l">Male</span>' + cb(st.sex === 'M') + '<span class="t-l">Female</span>' + cb(st.sex === 'F') + '<span class="t-l">Date of Birth:</span><span class="t-v">' + esc(st.dob || '') + '</span></div>' +
      fld('School Name:', sc.name) + '<div class="t-f"><span class="t-l">Town/City:</span><span class="t-v">' + esc(sc.town || '') + '</span><span class="t-l">Region:</span><span class="t-v">' + esc(sc.region || '') + '</span></div></div>' +
      '<div class="t-col t-col2">' + fld('Year of Entry (Grade 9):', st.entryYear || g9 || '') + fld('Stream/Track (if applicable):', st.stream || '') +
      fld('Academic Year:', academicRange(d.map, sc.academicYear)) + fld('Nationality:', st.nationality || 'Ethiopian') + '</div></div>';
    var head1 = '<th rowspan="2" class="t-sub">Subject</th>' + GRADES.map(function (g) { return '<th colspan="3" class="gh g' + g + ' gs">GRADE ' + g + '</th>'; }).join('');
    var head2 = GRADES.map(function (g) { return '<th class="sh g' + g + ' gs">1st Sem</th><th class="sh g' + g + '">2nd Sem</th><th class="sh g' + g + '">Ave</th>'; }).join('');
    var body = '', nrows = Math.max(1, d.subs.length), rh = Math.round(Math.max(5.4, Math.min(8, 128 / (nrows + 6))) * 100) / 100;
    for (var i = 0; i < nrows; i++) {
      var sub = d.subs[i];
      body += '<tr><td class="sub">' + (sub ? esc(sub.name) : '') + '</td>' + GRADES.map(function (g) {
        var c = sub ? d.cells[g][sub.id] : null;
        return '<td class="gs">' + (c ? fmt(c.s1) : '') + '</td><td>' + (c ? fmt(c.s2) : '') + '</td><td class="ave">' + (c ? fmt(c.ave) : '') + '</td>';
      }).join('') + '</tr>';
    }
    var summ = {};
    GRADES.forEach(function (g) { summ[g] = d.map[g] ? transcriptSummary(st, sc, g, d.map[g]) : null; });
    [['Total', 'total'], ['Average', 'avg'], ['Rank', 'rank'], ['Remark', 'remark'], ['Conduct', 'cd'], ['Absent', 'ab']].forEach(function (sr, ri) {
      body += '<tr class="srow' + (ri === 0 ? ' sfirst' : '') + '"><td class="sub">' + sr[0] + '</td>' + GRADES.map(function (g) {
        var sm = summ[g];
        return ['1', '2', 'AV'].map(function (k, ci) {
          var v = '';
          if (sm) {
            if (sr[1] === 'cd') { v = k === 'AV' ? '' : (sm.cd[k] || ''); }
            else if (sr[1] === 'ab') { v = sm.ab[k === 'AV' ? 2 : Number(k) - 1]; }
            else if (sr[1] === 'rank') { v = sm[k].rank === null ? '' : sm[k].rank; }
            else if (sr[1] === 'remark') { v = sm[k].remark; }
            else { v = fmt(sm[k][sr[1]]); }
          }
          return '<td class="' + (ci === 0 ? 'gs ' : '') + (ci === 2 ? 'ave ' : '') + (sr[1] === 'remark' ? 'sm' : '') + '">' + esc(v) + '</td>';
        }).join('');
      }).join('') + '</tr>';
    });
    var table = '<div class="t-tablebox"><table class="t-table" style="--rh:' + rh + 'mm"><colgroup><col style="width:38mm"></colgroup><thead><tr>' + head1 + '</tr><tr>' + head2 + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    var sign = function (title, name, pos) {
      var row = function (l, v) { return '<div class="t-f"><span class="t-l">' + l + '</span><span class="t-v">' + esc(v || '') + '</span></div>'; };
      return '<div>' + row(title, name) + row('Position:', name ? pos : '') + row('Signature:', '') + row('Date:', '') + '</div>';
    };
    var bottom = '<div class="t-box t-bottom"><div class="t-legend"><h4>TRANSCRIPT LEGEND (INFORMATION ONLY)</h4><div class="t-lg"><p><b>1st Sem:</b> First semester</p><p><b>Total:</b> Total score of all subjects</p><p><b>2nd Sem:</b> Second semester</p><p><b>Average:</b> Overall average of all subjects</p>' +
      '<p><b>Ave:</b> Average of the two semesters</p><p><b>Rank:</b> Student\'s position in class</p><p><b>Remark:</b> Student\'s academic remark</p><p><b>Conduct:</b> Student behavior and attitude (A, B or C)</p><p><b>Absent:</b> Total days absent in the semester</p></div></div>' +
      '<div class="t-sign">' + sign('Prepared by:', sc.recordOfficer, 'Record Officer') + sign('Checked by:', sc.director, 'Director') + '</div></div>';
    return '<div class="tpage"><div class="t-sheet"><div class="t-head"><div class="t-logo t-logo-l">' + logoHtml(sc.logoLeft, LOGO_LEFT) + '</div>' +
      '<div class="t-center"><div class="l1 office">DEMBI DOLLO EDUCATION OFFICE</div>' +
      '<div class="t-title">STUDENT TRANSCRIPT</div><div class="t-subt">GRADES 9\u201312</div></div><div class="t-logo t-logo-r">' + logoHtml(sc.logoRight, LOGO_RIGHT) + '</div></div>' +
      info + table + bottom + '<div class="t-note"><b>Note:</b> This transcript shows student performance for Grades 9\u201312. It does not include letter grades.</div></div></div>';
  }

  function currentTrStudent() {
    var id = ui.tr.sid, sid = curSchoolId();
    return id ? db.students.filter(function (s) { return s.id === id && s.schoolId === sid; })[0] || null : null;
  }

  function filteredTr() {
    var q = trim(ui.tr.q).toLowerCase();
    return schoolStudents().filter(function (s) {
      return (!ui.tr.grade || s.grade === ui.tr.grade) && (!ui.tr.section || s.section === ui.tr.section) && (!q || s.fullName.toLowerCase().indexOf(q) !== -1 || (s.studentId || '').toLowerCase().indexOf(q) !== -1);
    }).sort(function (a, b) { return (parseInt(a.grade, 10) - parseInt(b.grade, 10)) || a.section.localeCompare(b.section) || a.fullName.localeCompare(b.fullName); });
  }

  function transcriptView() {
    var t = ui.tr, st = currentTrStudent();
    if (t.sid && !st) { t.sid = ''; }
    if (!st) {
      return head('Transcripts', 'Prepare the Grades 9-12 transcript of a student from the roster marks. Open a student to see the transcript, then print it or save it as PDF.') +
        '<div class="panel"><div class="toolbar four"><div><input type="search" data-ui="tr.q" placeholder="Search by name or ID" value="' + esc(t.q) + '" aria-label="Search"></div>' +
        '<select data-ui="tr.grade" aria-label="Grade">' + gradeOpts(t.grade, 'All grades') + '</select>' +
        '<select data-ui="tr.section" aria-label="Section">' + opts(sectionsOf(t.grade), t.section, 'All sections') + '</select><div></div></div>' +
        '<div class="btn-row spaced"><button class="btn btn-primary" data-action="tr-print-all">Print all listed</button><span class="muted" id="trCount"></span></div>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Grade</th><th>Section</th><th>Marks found for</th><th class="col-actions">Actions</th></tr></thead><tbody id="trBody"></tbody></table></div></div>';
    }
    var cov = coverage(st), none = !GRADES.some(function (g) { return cov[g]; });
    return head('Transcript', st.fullName + ' - Grade ' + st.grade + (st.section ? ' ' + st.section : '')) +
      '<div class="panel"><div class="btn-row"><button class="btn" data-action="tr-back">Back to list</button>' + (canEdit() ? '<button class="btn" data-action="tr-edit">Transcript details</button>' : '') +
      '<button class="btn btn-primary" data-action="tr-print">Print</button><button class="btn" data-action="tr-pdf">Export PDF</button></div>' +
      (none ? '<p class="hint">No marks were found for this student yet. Marks entered by the teachers fill the grade panels automatically.</p>' : '') +
      '<div class="tr-preview" id="trPreview"></div></div>';
  }

  function fillTranscriptRows() {
    var body = $('#trBody'); if (!body) { return; }
    var list = filteredTr();
    body.innerHTML = list.map(function (s) {
      var cov = coverage(s);
      return '<tr><td><strong>' + esc(s.fullName) + '</strong></td><td>' + esc(s.grade) + '</td><td>' + esc(s.section) + '</td><td>' +
        GRADES.map(function (g) { return '<span class="chip' + (cov[g] ? ' ok' : '') + '">G' + g + '</span>'; }).join(' ') +
        '</td><td class="col-actions"><button class="link-btn" data-action="tr-open" data-id="' + esc(s.id) + '">Open transcript</button></td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No students match.</td></tr>';
    $('#trCount').textContent = list.length + ' students listed';
  }

  function renderTranscriptPreview() {
    var box = $('#trPreview'), st = currentTrStudent(); if (!box || !st) { return; }
    box.innerHTML = '<div class="tpage-wrap">' + transcriptPageHtml(st, school()) + '</div>';
    fitTranscript();
  }

  function fitTranscript() {
    var box = $('#trPreview'); if (!box || !box.clientWidth) { return; }
    box.style.setProperty('--z', Math.min(1, (box.clientWidth - 24) / (210 * 96 / 25.4)).toFixed(4));
  }

  function fitAll() { fitRoster(); fitTranscript(); }

  function tcFormHtml(st) {
    var sc = school(), map = gradeYearMap(st);
    return '<div class="modal-head"><h2>Transcript details</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="tcForm" novalidate data-id="' + esc(st.id) + '"><div class="modal-body"><p class="muted">' + esc(st.fullName) + '</p><div class="form-grid">' +
      '<div><label for="tcId">Student ID</label><input id="tcId" type="text" maxlength="30" value="' + esc(st.studentId || '') + '"></div>' +
      '<div><label for="tcDob">Date of birth</label><input id="tcDob" type="text" maxlength="30" placeholder="dd/mm/yyyy" value="' + esc(st.dob || '') + '"></div>' +
      '<div><label for="tcNat">Nationality</label><input id="tcNat" type="text" maxlength="40" value="' + esc(st.nationality || 'Ethiopian') + '"></div>' +
      '<div><label for="tcStream">Stream/Track (if applicable)</label><select id="tcStream"><option value="">None</option>' +
      STREAMS.concat(st.stream && STREAMS.indexOf(st.stream) === -1 ? [st.stream] : []).map(function (x) { return '<option' + (st.stream === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></div>' +
      '<div class="full"><label for="tcEntry">Year of entry (Grade 9)</label><input id="tcEntry" type="text" maxlength="20" placeholder="' + esc(map['9'] || sc.academicYear) + '" value="' + esc(st.entryYear || '') + '"></div>' +
      '<div class="full"><label>Academic year in which the student studied each grade</label></div>' +
      GRADES.map(function (g) { return '<div><label for="tcY' + g + '">Grade ' + g + '</label><input id="tcY' + g + '" type="text" maxlength="20" placeholder="' + esc(sc.academicYear) + '" value="' + esc(map[g] || '') + '"></div>'; }).join('') +
      '</div><p class="hint">The marks of that academic year fill the grade panel. Use the same year text that was used when the marks were entered, for example 2025/2026.</p></div>' +
      '<div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>';
  }

  function handleTcSubmit(form) {
    var st = db.students.filter(function (s) { return s.id === form.getAttribute('data-id'); })[0];
    if (!st) { return; }
    var rec = { studentId: trim($('#tcId').value), dob: trim($('#tcDob').value), nationality: trim($('#tcNat').value), stream: trim($('#tcStream').value), entryYear: trim($('#tcEntry').value) }, years = {};
    GRADES.forEach(function (g) { var y = trim($('#tcY' + g).value); if (y) { years[g] = y; } });
    if (!rec.studentId) { toast('Enter the Student ID.', 'error'); return; }
    if (db.students.some(function (x) { return x.id !== st.id && (x.studentId || '').toLowerCase() === rec.studentId.toLowerCase(); })) { toast('This Student ID is already used by another student.', 'error'); return; }
    commit(function () { Object.assign(st, rec); st.gradeYears = years; }, 'Updated transcript details of ' + st.fullName)
      .then(function () { closeModal(true); toast('Saved.', 'success'); render(); }).catch(function () { /* shown */ });
  }

  function setPageSize(orient) {
    var el = document.getElementById('pageSizeStyle');
    if (!el) { el = document.createElement('style'); el.id = 'pageSizeStyle'; document.head.appendChild(el); }
    el.textContent = '@page { size: A4 ' + orient + '; margin: 0; }';
  }

  function printTranscripts(list) {
    if (!list.length) { toast('There are no transcripts to print.', 'warn'); return; }
    if (list.length > 120) { toast('Print at most 120 transcripts at a time. Filter by grade or section.', 'warn'); return; }
    var sc = school();
    $('#printArea').innerHTML = list.map(function (st) { return transcriptPageHtml(st, sc); }).join('');
    setPageSize('portrait');
    setTimeout(function () { window.print(); }, 250);
  }

  function exportTranscriptPdf(st) {
    if (!(window.jspdf && window.jspdf.jsPDF && window.html2canvas)) {
      toast('The PDF library could not be loaded (no internet?). The print window opens - choose "Save as PDF" as the printer.', 'warn'); printTranscripts([st]); return;
    }
    busy(true, 'Creating PDF');
    var stage = $('#exportStage'); stage.innerHTML = transcriptPageHtml(st, school());
    var page = $('.tpage', stage), pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    var done = function () { stage.innerHTML = ''; busy(false); };
    setTimeout(function () {
      window.html2canvas(page, { scale: 2.5, useCORS: true, backgroundColor: '#ffffff', logging: false }).then(function (canvas) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
        pdf.save('Transcript_' + st.fullName.replace(/[^A-Za-z0-9]+/g, '_') + '_' + stamp() + '.pdf'); done(); toast('PDF created.', 'success');
      }).catch(function (err) { done(); toast('PDF could not be created: ' + (err && err.message ? err.message : 'error') + '. Use Print and choose "Save as PDF".', 'error'); });
    }, 150);
  }

  function handleLogoFile(inp) {
    var f = inp.files && inp.files[0]; if (!f || sess.role !== 'school') { return; }
    var side = inp.id === 'setLogoLeft' ? 'Left' : 'Right';
    if (!/^image\//.test(f.type)) { toast('Choose a picture file (PNG or JPG).', 'error'); return; }
    if (f.size > 4 * 1024 * 1024) { toast('The picture is too big. Use a file under 4 MB.', 'error'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 300 / Math.max(img.width || 300, img.height || 300)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.width || 300) * k)); c.height = Math.max(1, Math.round((img.height || 300) * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var url = c.toDataURL('image/png');
        commit(function () { school()['logo' + side] = url; }, 'Changed the ' + side.toLowerCase() + ' logo').then(function () { toast('Logo saved.', 'success'); render(); }).catch(function () { /* shown */ });
      };
      img.onerror = function () { toast('This picture could not be read.', 'error'); };
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  }
  function clearLogo(side) {
    if (sess.role !== 'school') { return; }
    commit(function () { delete school()['logo' + side]; }, 'Reset the ' + side.toLowerCase() + ' logo').then(function () { toast('Default logo restored.', 'success'); render(); }).catch(function () { /* shown */ });
  }
  /* ---------- conduct and absent days (entered with the roster, printed on roster and transcript) ---------- */
  function recOf(st, year) { return (st.records && st.records[year]) || {}; }
  function absentOf(st, year, k) {
    var ab = recOf(st, year).absent || {};
    if (k !== 'AV') { return ab[k] === undefined ? '' : ab[k]; }
    return ab['1'] === undefined && ab['2'] === undefined ? '' : (Number(ab['1']) || 0) + (Number(ab['2']) || 0);
  }
  function conductPanelHtml() {
    var r = ui.ro, list = classStudents(r.grade, r.section), yr = trim(r.year) || school().academicYear;
    var rows = list.map(function (st) {
      var rec = recOf(st, yr), cd = rec.conduct || {}, ab = rec.absent || {};
      return '<tr><td><strong>' + esc(st.fullName) + '</strong></td>' + ['1', '2'].map(function (sem) {
        return '<td><select data-cd data-field="conduct" data-sid="' + esc(st.id) + '" data-sem="' + sem + '" aria-label="Conduct">' + ['', 'A', 'B', 'C'].map(function (x) { return '<option value="' + x + '"' + (cd[sem] === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></td>' +
          '<td><input type="number" min="0" max="366" step="1" data-cd data-field="absent" data-sid="' + esc(st.id) + '" data-sem="' + sem + '" value="' + (ab[sem] === undefined ? '' : esc(ab[sem])) + '" aria-label="Absent days"></td>';
      }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No students in this class.</td></tr>';
    return '<div class="panel"><h2>Conduct and absent days</h2><p class="muted">Choose the conduct (A, B or C) and type the days absent of every student for each semester. They are printed on the roster and on the transcript.</p>' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="conduct-save"' + (list.length ? '' : ' disabled') + '>Save conduct and absent</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th rowspan="2">Student</th><th colspan="2">Semester I</th><th colspan="2">Semester II</th></tr><tr><th>Conduct</th><th>Absent (days)</th><th>Conduct</th><th>Absent (days)</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }
  function saveConduct() {
    if (sess.role !== 'school' && sess.role !== 'homeroom') { return; }
    var r = ui.ro, yr = trim(r.year), ents = [], bad = 0, ids = {};
    if (!yr) { toast('Enter the academic year.', 'error'); return; }
    classStudents(r.grade, r.section).forEach(function (st) { ids[st.id] = 1; });
    $$('input[data-cd], select[data-cd]').forEach(function (inp) {
      inp.classList.remove('invalid');
      var sid = inp.getAttribute('data-sid'), v = trim(inp.value), f = inp.getAttribute('data-field');
      if (!ids[sid]) { return; }
      if (f === 'conduct' && v !== '' && !/^[ABC]$/.test(v)) { inp.classList.add('invalid'); bad++; return; }
      if (f === 'absent' && v !== '') {
        var n = Number(v);
        if (!isFinite(n) || n < 0 || n > 366 || Math.floor(n) !== n) { inp.classList.add('invalid'); bad++; return; }
        v = n;
      }
      ents.push([sid, inp.getAttribute('data-sem'), f, v]);
    });
    if (bad) { toast('Conduct must be A, B or C and absent days a whole number from 0 to 366.', 'error'); return; }
    commit(function () {
      ents.forEach(function (e) {
        var st = db.students.filter(function (x) { return x.id === e[0]; })[0]; if (!st) { return; }
        st.records = st.records || {};
        var rec = st.records[yr] = st.records[yr] || {};
        rec.rank = rec.rank || {}; rec.conduct = rec.conduct || {}; rec.absent = rec.absent || {};
        var tgt = e[2] === 'conduct' ? rec.conduct : rec.absent;
        if (e[3] === '') { delete tgt[e[1]]; } else { tgt[e[1]] = e[3]; }
      });
    }, 'Saved conduct and absent days Grade ' + r.grade + (r.section ? ' ' + r.section : '') + ' ' + yr)
      .then(function () { toast('Saved.', 'success'); renderRosterPreview(); }).catch(function () { /* shown */ });
  }
  /* class ranks are kept with each student (per academic year) so the transcript can show them later */
  function storeRanks(sc, grade, section, year) {
    var secs = {};
    classStudents(grade, section).forEach(function (s) { secs[s.section] = 1; });
    Object.keys(secs).forEach(function (sec) {
      var grp = db.students.filter(function (x) { return x.schoolId === sc.id && x.grade === grade && x.section === sec; }), calc = computeClass(grp, sc.subjects, year);
      grp.forEach(function (st) {
        st.records = st.records || {};
        var rec = st.records[year] = st.records[year] || {}; rec.rank = rec.rank || {};
        ['1', '2', 'AV'].forEach(function (k) { rec.rank[k] = calc[st.id][k].rank; });
      });
    });
  }
  function rankLive(st, sc, g, y, k) {
    if (st.grade !== g) { return null; }
    var grp = db.students.filter(function (x) { return x.schoolId === sc.id && x.grade === g && x.section === st.section; });
    return computeClass(grp, sc.subjects, y)[st.id][k].rank;
  }
  function transcriptSummary(st, sc, g, y) {
    var calc = computeClass([st], sc.subjects, y)[st.id], rec = recOf(st, y), rk = rec.rank || {}, out = { cd: rec.conduct || {}, ab: [absentOf(st, y, '1'), absentOf(st, y, '2'), absentOf(st, y, 'AV')] };
    ['1', '2', 'AV'].forEach(function (k) {
      var has = calc[k].total !== null;
      out[k] = { total: calc[k].total, avg: calc[k].avg, rank: has ? (rk[k] !== undefined && rk[k] !== null ? rk[k] : rankLive(st, sc, g, y, k)) : null, remark: has ? remarkRow(calc.rows[k], g) : '' };
    });
    return out;
  }

  /* ================= SECURITY ================= */
  function b2h(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function h2b(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) { a[i] = parseInt(h.substr(i * 2, 2), 16); } return a; }
  function pbkdf2(pw, salt) {
    return window.crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return window.crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, k, 256); });
  }
  /* new passwords: salted PBKDF2-SHA256 (150 000 rounds). Old simple hashes still work once and are upgraded at sign-in. */
  function pwHash(pw) {
    if (!(window.crypto && window.crypto.subtle)) { return Promise.resolve(hashPw(pw)); }
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    return pbkdf2(pw, salt).then(function (bits) { return 'pb2$' + b2h(salt) + '$' + b2h(bits); });
  }
  function pwHashIf(pw) { return API || !pw ? Promise.resolve('') : pwHash(pw); }
  function pwVerify(pw, stored) {
    if (!stored) { return Promise.resolve(false); }
    if (stored.indexOf('pb2$') !== 0) { return Promise.resolve(hashPw(pw) === stored); }
    if (!(window.crypto && window.crypto.subtle)) { return Promise.resolve(false); }
    var p = stored.split('$');
    return pbkdf2(pw, h2b(p[1])).then(function (bits) { return b2h(bits) === p[2]; }).catch(function () { return false; });
  }
  function pwProblem(p) {
    if (p.length < 8) { return 'The password needs at least 8 characters.'; }
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) { return 'Use both letters and numbers in the password.'; }
    return '';
  }
  /* sign-in and student pages: wrong attempts are counted in the browser and lock the form for longer each time */
  function thState(k) { try { return JSON.parse(localStorage.getItem('ddeo_th_' + k) || '{}'); } catch (e) { return {}; } }
  function thSave(k, o) { try { localStorage.setItem('ddeo_th_' + k, JSON.stringify(o)); } catch (e) { /* ignore */ } }
  function thLocked(k) { var o = thState(k); return o.until && Date.now() < o.until ? Math.ceil((o.until - Date.now()) / 1000) : 0; }
  function thFail(k) {
    var o = thState(k); o.n = (o.n || 0) + 1;
    if (o.n >= MAX_TRIES) { o.n = 0; o.lvl = Math.min((o.lvl || 0) + 1, 6); o.until = Date.now() + LOCK_SECONDS * 1000 * Math.pow(2, o.lvl - 1); thSave(k, o); return true; }
    thSave(k, o); return false;
  }
  function thOk(k) { thSave(k, {}); }

  var lastActive = Date.now();
  function resetIdle() { lastActive = Date.now(); }
  function cover(on) { document.documentElement.classList.toggle('privacy-cover', !!on); }
  function sensitiveOnScreen() { return !!sess || !!$('#resultView'); }
  function isField(t) { var n = t && t.nodeType === 3 ? t.parentNode : t; return !!(n && n.closest && n.closest('input, textarea, select')); }
  /* Browsers cannot truly block screenshots. These steps make capturing harder and traceable:
     content is hidden when the window loses focus or a capture key is used, and copying is blocked. */
  function securityInit() {
    try { if (window.top !== window.self) { document.documentElement.innerHTML = ''; return; } } catch (e) { document.documentElement.innerHTML = ''; return; }
    var cv = document.createElement('div'); cv.id = 'coverMsg';
    cv.innerHTML = '<div><b>Content hidden for privacy</b><span>Click here or return to this window to continue.</span></div>';
    cv.addEventListener('click', function () { cover(false); });
    document.body.appendChild(cv);
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('selectstart', function (e) { if (!isField(e.target)) { e.preventDefault(); } });
    document.addEventListener('dragstart', function (e) { e.preventDefault(); });
    ['copy', 'cut'].forEach(function (ev) { document.addEventListener(ev, function (e) { if (!isField(document.activeElement)) { e.preventDefault(); } }); });
    document.addEventListener('keydown', function (e) {
      var k = String(e.key || '').toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (k === 'printscreen' || (e.metaKey && e.shiftKey && ['3', '4', '5'].indexOf(k) !== -1) || (e.metaKey && e.shiftKey && k === 's')) {
        if (sensitiveOnScreen()) { cover(true); setTimeout(function () { cover(false); }, 2500); }
        try { navigator.clipboard.writeText(' '); } catch (x) { /* ignore */ }
        e.preventDefault(); return;
      }
      if ((ctrl && ['s', 'u', 'p'].indexOf(k) !== -1) || (ctrl && e.shiftKey && ['i', 'j', 'c'].indexOf(k) !== -1) || k === 'f12') { e.preventDefault(); }
    });
    document.addEventListener('keyup', function (e) {
      if (String(e.key || '').toLowerCase() === 'printscreen') { try { navigator.clipboard.writeText(' '); } catch (x) { /* ignore */ } }
    });
    window.addEventListener('blur', function () { if (sensitiveOnScreen()) { cover(true); } });
    window.addEventListener('focus', function () { cover(false); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { if (sensitiveOnScreen()) { cover(true); } } else { cover(false); } });
    window.addEventListener('beforeprint', function () { cover(false); });
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });
    setInterval(function () { if (API && sess && Date.now() - lastActive < 4 * 60000) { apiCall('/api/me').catch(function () { /* ignore */ }); } }, 240000);
    setInterval(function () { if (sess && Date.now() - lastActive > IDLE_MINUTES * 60000) { logout('You were signed out after ' + IDLE_MINUTES + ' minutes without activity.'); } }, 15000);
  }

  /* ================= STUDENT ID, RESULT RELEASE, SELF-REGISTRATION ================= */
  function newStudentId(sc, d, date) {
    var all = (d || db).students, id, y = String(date || todayStr()).slice(0, 4);
    do { sc.nextSeq = (sc.nextSeq || 0) + 1; id = 'DD' + sc.code + '-' + ('0000' + sc.nextSeq).slice(-4) + '-' + y; } while (all.some(function (x) { return x.studentId === id; }));
    return id;
  }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function nextSchoolCode() { var m = 0; db.schools.forEach(function (s) { var n = parseInt(s.code, 10) || 0; if (n > m) { m = n; } }); return ('00' + (m + 1)).slice(-3); }
  function fmtDT(v) { var d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function windowState(w) {
    if (!w || !w.start || !w.end) { return { open: false, text: 'Not set yet' }; }
    var now = Date.now(), a = new Date(w.start).getTime(), b = new Date(w.end).getTime();
    if (now < a) { return { open: false, text: 'Opens ' + fmtDT(w.start) }; }
    if (now > b) { return { open: false, text: 'Closed since ' + fmtDT(w.end) }; }
    return { open: true, text: 'Open until ' + fmtDT(w.end) };
  }
  function releaseView() {
    var sc = school(), r = sc.release || {}, ws = windowState(r);
    return head('Result release', 'Set the date and time when students can see their results with their Student ID and first name.') +
      '<div class="panel"><div class="toolbar four"><div><label for="relStart">Opens (date and time)</label><input id="relStart" type="datetime-local" value="' + esc(r.start || '') + '"></div>' +
      '<div><label for="relEnd">Closes (date and time)</label><input id="relEnd" type="datetime-local" value="' + esc(r.end || '') + '"></div>' +
      '<div><label for="relSem">Results to show</label><select id="relSem">' + opts([['all', 'Semester I, II and average'], ['1', 'Semester I only'], ['2', 'Semester II only']], r.sem || 'all') + '</select></div><div></div></div>' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="release-save">Save</button><span class="muted">Status: <b>' + esc(ws.text) + '</b></span></div>' +
      '<p class="hint">Students open "Students: view my result" on the sign-in page and enter their Student ID (for example DD' + esc(sc.code) + '-0001-2026) and first name. The results of academic year ' + esc(sc.academicYear) + ' are shown. Students receive their ID when you register them on the Students page.</p></div>';
  }
  function saveRelease() {
    var a = $('#relStart').value, b = $('#relEnd').value, sem = $('#relSem').value;
    if (!a || !b) { toast('Choose the opening and the closing date and time.', 'error'); return; }
    if (new Date(b).getTime() <= new Date(a).getTime()) { toast('The closing time must be after the opening time.', 'error'); return; }
    commit(function () { school().release = { start: a, end: b, sem: sem }; }, 'Set result release ' + a + ' to ' + b)
      .then(function () { toast('Saved.', 'success'); render(); }).catch(function () { /* shown */ });
  }
  function registrationView() {
    var r = db.settings.registration, ws = windowState(r), count = r.year ? db.students.filter(function (s) { return s.registeredFor === r.year; }).length : 0, waiting = db.students.filter(function (s) { return s.pendingReg; }).length;
    var rows = db.schools.map(function (sc) {
      var n = r.year ? db.students.filter(function (s) { return s.schoolId === sc.id && s.registeredFor === r.year; }).length : 0;
      return '<tr><td><strong>' + esc(sc.name) + '</strong></td><td>' + n + '</td><td>' + db.students.filter(function (s) { return s.schoolId === sc.id; }).length + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="empty">No schools yet.</td></tr>';
    return head('Student registration', 'Set when students from Grade 10 up register themselves with their Student ID. Grade 9 students are registered by the school admin, who gives them their ID.') +
      '<div class="panel"><div class="toolbar four"><div><label for="regYear">Academic year to register for</label><input id="regYear" type="text" maxlength="20" placeholder="2027/2028" value="' + esc(r.year || '') + '"></div>' +
      '<div><label for="regStart">Opens (date and time)</label><input id="regStart" type="datetime-local" value="' + esc(r.start || '') + '"></div>' +
      '<div><label for="regEnd">Closes (date and time)</label><input id="regEnd" type="datetime-local" value="' + esc(r.end || '') + '"></div><div></div></div>' +
      '<div class="btn-row spaced"><button class="btn btn-primary" data-action="registration-save">Save</button><span class="muted">Status: <b>' + esc(ws.text) + '</b> - ' + count + ' approved, ' + waiting + ' waiting for the school admin</span></div>' +
      '<p class="hint">A student opens "Students: register for the new year" on the sign-in page, enters the Student ID and first name, and is moved to the next grade (promoted) or stays in the same grade (detained or failed) according to the results. Grade 11 students choose their stream. The school admin must approve every request and gives the section.</p></div>' +
      '<div class="panel"><h2>Registered so far</h2><div class="table-wrap"><table class="table"><thead><tr><th>School</th><th>Approved</th><th>Students</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }
  function saveRegistration() {
    var y = trim($('#regYear').value), a = $('#regStart').value, b = $('#regEnd').value;
    if (!y) { toast('Enter the academic year to register for.', 'error'); return; }
    if (!a || !b) { toast('Choose the opening and the closing date and time.', 'error'); return; }
    if (new Date(b).getTime() <= new Date(a).getTime()) { toast('The closing time must be after the opening time.', 'error'); return; }
    commit(function () { db.settings.registration = { year: y, start: a, end: b }; }, 'Set student registration for ' + y + ': ' + a + ' to ' + b)
      .then(function () { toast('Saved.', 'success'); render(); }).catch(function () { /* shown */ });
  }
  function findStudent(id, first) {
    id = trim(id).toLowerCase(); first = trim(first).toLowerCase();
    if (!id || !first) { return null; }
    var st = db.students.filter(function (s) { return (s.studentId || '').toLowerCase() === id; })[0];
    if (!st) { return null; }
    return st.fullName.trim().split(/\s+/)[0].toLowerCase() === first ? st : null;
  }
  function pubFormHtml(kind) {
    var res = kind === 'result';
    return '<div class="modal-head"><h2>' + (res ? 'View my result' : 'Register for the new academic year') + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="' + (res ? 'pubResultForm' : 'pubRegForm') + '" novalidate autocomplete="off"><div class="modal-body"><p class="muted">' +
      (res ? 'Enter your Student ID and your first name.' : 'Enter your Student ID and your first name. Registration is open only on the dates set by the Education Office. Grade 9 students are registered by the school admin.') +
      '</p><label for="pubId">Student ID</label><input id="pubId" type="text" maxlength="30" autocomplete="off" placeholder="DD001-0001-2026"><label for="pubName">First name</label><input id="pubName" type="text" maxlength="40" autocomplete="off">' +
      '<div class="form-error" id="pubErr" hidden role="alert"></div></div><div class="modal-foot"><button type="button" class="btn" data-close>Close</button><button type="submit" class="btn btn-primary">Continue</button></div></form>';
  }
  function pubError(m) { var e = $('#pubErr'); e.textContent = m; e.hidden = false; }
  function pubLookup() {
    var wait = thLocked('pub');
    if (wait) { pubError('Too many wrong attempts. Try again in ' + wait + ' seconds.'); return null; }
    var st = findStudent($('#pubId').value, $('#pubName').value);
    if (!st) { thFail('pub'); pubError(thLocked('pub') ? 'Too many wrong attempts. Try again in ' + thLocked('pub') + ' seconds.' : 'The Student ID and the first name do not match.'); return null; }
    thOk('pub'); return st;
  }
  function handlePubResult() {
    if (API) { return apiPubResult(); }
    var st = pubLookup(); if (!st) { return; }
    var sc = db.schools.filter(function (x) { return x.id === st.schoolId; })[0], ws = windowState(sc && sc.release);
    if (!sc || !ws.open) { pubError('Results are not open now. ' + (sc ? ws.text + '.' : '')); return; }
    openModal('<div class="modal-head"><h2>My result</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div><div class="modal-body" id="resultView">' + studentResultHtml(st, sc) +
      '</div><div class="modal-foot"><button type="button" class="btn btn-primary" data-close>Close</button></div>');
    clearTimeout(window.__resTimer); window.__resTimer = setTimeout(function () { if ($('#resultView')) { closeModal(true); } }, 5 * 60000);
  }
  function studentResultHtml(st, sc) {
    var y = sc.academicYear, mode = (sc.release && sc.release.sem) || 'all', cols = mode === 'all' ? ['1', '2', 'AV'] : [mode];
    var names = { '1': 'Semester I', '2': 'Semester II', 'AV': 'Average' }, m1 = getMarks(st.id, y, '1'), m2 = getMarks(st.id, y, '2');
    var val = function (sub, k) {
      var a = numOrNull(m1[sub.id]), b = numOrNull(m2[sub.id]);
      return k === '1' ? a : k === '2' ? b : (a !== null && b !== null ? round1((a + b) / 2) : null);
    };
    var subs = sc.subjects.filter(function (sub) { return cols.some(function (k) { return val(sub, k) !== null; }); });
    var head1 = '<p><strong>' + esc(st.fullName) + '</strong><br><span class="muted">Student ID ' + esc(st.studentId) + ' - Grade ' + esc(st.grade) + (st.section ? ' ' + esc(st.section) : '') + ' - ' + esc(sc.name) + ' - Academic year ' + esc(y) + '</span></p>';
    if (!subs.length) { return head1 + '<p class="muted">No marks have been entered yet.</p>'; }
    var sm = transcriptSummary(st, sc, st.grade, y);
    var body = subs.map(function (sub) { return '<tr><td>' + esc(sub.name) + '</td>' + cols.map(function (k) { return '<td>' + esc(fmt(val(sub, k))) + '</td>'; }).join('') + '</tr>'; }).join('');
    [['Total', 'total'], ['Average', 'avg'], ['Rank', 'rank'], ['Remark', 'remark'], ['Conduct', 'cd'], ['Absent (days)', 'ab']].forEach(function (sr) {
      body += '<tr class="sum-row"><td><strong>' + sr[0] + '</strong></td>' + cols.map(function (k) {
        var v = '';
        if (sr[1] === 'cd') { v = k === 'AV' ? '' : (sm.cd[k] || ''); }
        else if (sr[1] === 'ab') { v = sm.ab[k === 'AV' ? 2 : Number(k) - 1]; }
        else if (sr[1] === 'rank') { v = sm[k].rank === null ? '' : sm[k].rank; }
        else if (sr[1] === 'remark') { v = sm[k].remark; }
        else { v = fmt(sm[k][sr[1]]); }
        return '<td><strong>' + esc(v) + '</strong></td>';
      }).join('') + '</tr>';
    });
    return head1 + '<div class="table-wrap"><table class="table"><thead><tr><th>Subject</th>' + cols.map(function (k) { return '<th>' + names[k] + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="hint">Conduct is A, B or C. This screen closes by itself after a few minutes.</p>';
  }
  function regTarget(st, sc, year) {
    var g = parseInt(st.grade, 10);
    if (st.registeredFor === year) { return { message: 'You are already registered for ' + year + ' in Grade ' + st.grade + '.' }; }
    if (st.pendingReg && st.pendingReg.year === year) { return { message: 'Your registration for Grade ' + st.pendingReg.grade + ' was sent. It is waiting for the school admin to approve it.' }; }
    var rk = remarkFor(st, computeClass([st], sc.subjects, sc.academicYear));
    if (!rk) { return { message: 'Your results for ' + sc.academicYear + ' are not complete yet. Please see your school office.' }; }
    if (rk === 'Passed') { return { message: 'You have completed Grade 12. Congratulations.' }; }
    var target = rk === 'Promoted' ? g + 1 : g;
    if (target < 10) { return { message: 'Grade 9 students are registered by the school admin. Please see your school office.' }; }
    return { target: target, remark: rk };
  }
  function handlePubRegister() {
    if (API) { return apiPubRegister(); }
    var reg = db.settings.registration, ws = windowState(reg);
    if (!ws.open) { pubError('Registration is not open now. ' + ws.text + '.'); return; }
    var st = pubLookup(); if (!st) { return; }
    var sc = db.schools.filter(function (x) { return x.id === st.schoolId; })[0], info = sc ? regTarget(st, sc, reg.year) : { message: 'Your school was not found.' };
    if (info.message) { pubError(info.message); return; }
    openModal('<div class="modal-head"><h2>Register for ' + esc(reg.year) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="pubRegConfirm" novalidate data-id="' + esc(st.id) + '"><div class="modal-body"><p><strong>' + esc(st.fullName) + '</strong><br><span class="muted">' + esc(sc.name) + ' - now in Grade ' + esc(st.grade) + ' - result: ' + esc(info.remark) + '</span></p>' +
      '<p>You ask to be registered for <strong>Grade ' + info.target + '</strong> for ' + esc(reg.year) + '. The school admin must approve your request.</p>' +
      (info.target === 11 ? '<label for="pubStream">Choose your stream</label><select id="pubStream"><option value="">Select stream</option>' + STREAMS.map(function (x) { return '<option' + (st.stream === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>' : '') +
      '<div class="form-error" id="pubErr" hidden role="alert"></div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Send request</button></div></form>');
  }
  function handlePubRegConfirm(form) {
    if (API) { return apiPubRegConfirm(); }
    var reg = db.settings.registration, id = form.getAttribute('data-id'), st = db.students.filter(function (x) { return x.id === id; })[0];
    if (!st || !windowState(reg).open) { pubError('Registration is not open now.'); return; }
    var sc = db.schools.filter(function (x) { return x.id === st.schoolId; })[0], info = regTarget(st, sc, reg.year);
    if (info.message) { pubError(info.message); return; }
    var stream = info.target === 11 ? $('#pubStream').value : st.stream || '';
    if (info.target === 11 && STREAMS.indexOf(stream) === -1) { pubError('Choose Natural Science or Social Science.'); return; }
    commit(function () {
      st.pendingReg = { year: reg.year, grade: String(info.target), stream: info.target >= 11 ? stream : '', at: new Date().toISOString() };
      db.log.push({ t: new Date().toISOString(), user: 'student ' + st.studentId, schoolId: st.schoolId, text: 'Student asked to register for ' + reg.year + ' in Grade ' + info.target + ' (waiting for approval)' });
    }, '').then(function () {
      $('#modalRoot').querySelector('.modal-body').innerHTML = '<p><strong>Your request was sent.</strong></p><p>Grade ' + esc(String(info.target)) + ' - ' + esc(reg.year) + '. The school admin will approve it and give your section.</p>';
      $('#modalRoot').querySelector('.modal-foot').innerHTML = '<button type="button" class="btn btn-primary" data-close>Close</button>';
    }).catch(function () { /* shown */ });
  }

  /* ---------- registration requests (the school admin approves) ---------- */
  function registrationsView() {
    var sc = school(), reg = db.settings.registration, list = schoolStudents().filter(function (x) { return x.pendingReg; }).sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
    var rows = list.map(function (x) {
      var p = x.pendingReg;
      return '<tr><td><strong>' + esc(x.fullName) + '</strong></td><td class="mono">' + esc(x.studentId || '') + '</td><td>Grade ' + esc(x.grade) + (x.section ? ' ' + esc(x.section) : '') + '</td><td>Grade ' + esc(p.grade) + '</td><td>' + esc(p.stream || '') + '</td><td>' + esc(p.year) + '</td>' +
        '<td><input type="text" maxlength="10" placeholder="Section" data-regsec="' + esc(x.id) + '" style="width:90px"></td>' +
        '<td class="col-actions"><button class="link-btn" data-action="reg-approve" data-id="' + esc(x.id) + '">Approve</button><button class="link-btn danger" data-action="reg-reject" data-id="' + esc(x.id) + '">Reject</button></td></tr>';
    }).join('') || '<tr><td colspan="8" class="empty">No registration requests are waiting.</td></tr>';
    return head('Registration requests', 'Students from Grade 10 up ask to be registered for the new academic year with their Student ID. Approve the request and give the section, or reject it.') +
      '<div class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Student</th><th>Student ID</th><th>Now</th><th>Asks for</th><th>Stream</th><th>Year</th><th>Section</th><th class="col-actions">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hint">Approving moves the student to the new grade. Rosters and transcripts of the earlier grade keep their marks. Registration window: ' + esc(windowState(reg).text) + '.</p></div>';
  }
  function approveReg(id) {
    var st = db.students.filter(function (x) { return x.id === id && x.schoolId === sess.schoolId; })[0];
    if (!st || !st.pendingReg || sess.role !== 'school') { return; }
    var box = document.querySelector('[data-regsec="' + id + '"]'), sec = box ? trim(box.value).toUpperCase() : '';
    commit(function () {
      var p = st.pendingReg, old = st.grade;
      st.gradeYears = gradeYearMap(st);
      st.grade = String(p.grade); st.section = sec; st.stream = p.stream || (p.grade === '12' ? st.stream || '' : '');
      st.registeredFor = p.year; st.registeredAt = new Date().toISOString();
      delete st.pendingReg;
    }, 'Approved registration of ' + st.fullName + ' for Grade ' + st.pendingReg.grade).then(function () { toast('Registration approved.', 'success'); render(); }).catch(function () { /* shown */ });
  }
  function rejectReg(id) {
    var st = db.students.filter(function (x) { return x.id === id && x.schoolId === sess.schoolId; })[0];
    if (!st || !st.pendingReg || sess.role !== 'school') { return; }
    confirmBox('Reject this request?', st.fullName + ' will stay in Grade ' + st.grade + ' and can send a new request while registration is open.', 'Reject', true).then(function (yes) {
      if (!yes) { return; }
      commit(function () { delete st.pendingReg; }, 'Rejected registration request of ' + st.fullName).then(function () { toast('Request rejected.', 'success'); render(); }).catch(function () { /* shown */ });
    });
  }

  /* ================= SERVER MODE (data, passwords and permissions live on the server) ================= */
  function apiCall(p, body) {
    var opt = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Ddeo': '1' }, body: JSON.stringify(body) };
    return fetch(p, opt).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Server error.' }; }).then(function (j) {
        if (!r.ok) {
          if (r.status === 401 && sess && !/^\/api\/(login|public)/.test(p)) { logout('Your session ended. Please sign in again.'); }
          var e = new Error(j.error || 'Server error.'); e.status = r.status; throw e;
        }
        return j;
      });
    });
  }
  function applyServerState(state) {
    db = normalizeDb(state); db.superHash = sess && sess.mustChange ? '' : 'server';
  }
  function apiSave() { return apiCall('/api/state/save', { state: db }).then(function (j) { applyServerState(j.state); }); }
  function loadServerState() {
    if (sess.mustChange) { db = emptyDb(); db.superHash = ''; return Promise.resolve(); }
    return apiCall('/api/state').then(function (j) { applyServerState(j.state); });
  }
  function apiPw(kind, id, pass) {
    if (!API || !pass) { return Promise.resolve(); }
    return apiCall('/api/setpw', { kind: kind, id: id, password: pass }).catch(function (e) { toast('The password could not be set: ' + e.message, 'error'); throw e; });
  }
  function apiLogin(e) {
    e.preventDefault();
    var user = trim($('#loginUser').value), pass = $('#loginPass').value;
    if (!user || !pass) { loginError('Enter the username and the password.'); return; }
    var btn = $('#loginForm button[type=submit]'); btn.disabled = true;
    apiCall('/api/login', { username: user, password: pass }).then(function (j) { sess = j.me; return loadServerState(); })
      .then(function () { btn.disabled = false; showApp(); })
      .catch(function (err) { btn.disabled = false; sess = null; loginError(err.message || 'Sign-in failed.'); $('#loginPass').select(); });
  }
  function apiResultHtml(j) {
    var names = { '1': 'Semester I', '2': 'Semester II', 'AV': 'Average' }, st = j.student;
    var head1 = '<p><strong>' + esc(st.fullName) + '</strong><br><span class="muted">Student ID ' + esc(st.studentId) + ' - Grade ' + esc(st.grade) + (st.section ? ' ' + esc(st.section) : '') + ' - ' + esc(j.school) + ' - Academic year ' + esc(j.year) + '</span></p>';
    if (!j.rows.length) { return head1 + '<p class="muted">No marks have been entered yet.</p>'; }
    var body = j.rows.map(function (r) { return '<tr><td>' + esc(r.name) + '</td>' + j.cols.map(function (k) { return '<td>' + esc(fmt(r.v[k])) + '</td>'; }).join('') + '</tr>'; }).join('');
    [['Total', 'total'], ['Average', 'avg'], ['Rank', 'rank'], ['Remark', 'remark'], ['Conduct', 'conduct'], ['Absent (days)', 'absent']].forEach(function (sr) {
      body += '<tr class="sum-row"><td><strong>' + sr[0] + '</strong></td>' + j.cols.map(function (k) { var v = j.summary[sr[1]][k]; return '<td><strong>' + esc(v === null || v === undefined ? '' : (typeof v === 'number' && sr[1] !== 'rank' && sr[1] !== 'absent' ? fmt(v) : v)) + '</strong></td>'; }).join('') + '</tr>';
    });
    return head1 + '<div class="table-wrap"><table class="table"><thead><tr><th>Subject</th>' + j.cols.map(function (k) { return '<th>' + names[k] + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div><p class="hint">Conduct is A, B or C. This screen closes by itself after a few minutes.</p>';
  }
  function apiPubResult() {
    apiCall('/api/public/result', { id: $('#pubId').value, name: $('#pubName').value }).then(function (j) {
      openModal('<div class="modal-head"><h2>My result</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div><div class="modal-body" id="resultView">' + apiResultHtml(j) +
        '</div><div class="modal-foot"><button type="button" class="btn btn-primary" data-close>Close</button></div>');
      clearTimeout(window.__resTimer); window.__resTimer = setTimeout(function () { if ($('#resultView')) { closeModal(true); } }, 5 * 60000);
    }).catch(function (e) { pubError(e.message); });
  }
  function apiPubRegister() {
    var cred = { id: $('#pubId').value, name: $('#pubName').value };
    apiCall('/api/public/reg-check', cred).then(function (j) {
      if (j.message) { pubError(j.message); return; }
      window.__pubCred = cred;
      openModal('<div class="modal-head"><h2>Register for ' + esc(j.year) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
        '<form id="pubRegConfirm" novalidate><div class="modal-body"><p><strong>' + esc(j.fullName) + '</strong><br><span class="muted">' + esc(j.school) + ' - now in Grade ' + esc(j.grade) + ' - result: ' + esc(j.remark) + '</span></p>' +
        '<p>You ask to be registered for <strong>Grade ' + j.target + '</strong> for ' + esc(j.year) + '. The school admin must approve your request.</p>' +
        (j.target === 11 ? '<label for="pubStream">Choose your stream</label><select id="pubStream"><option value="">Select stream</option>' + STREAMS.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select>' : '') +
        '<div class="form-error" id="pubErr" hidden role="alert"></div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Send request</button></div></form>');
    }).catch(function (e) { pubError(e.message); });
  }
  function apiPubRegConfirm() {
    var c = window.__pubCred || {}, sm = $('#pubStream');
    apiCall('/api/public/reg-submit', { id: c.id, name: c.name, stream: sm ? sm.value : '' }).then(function (j) {
      $('#modalRoot').querySelector('.modal-body').innerHTML = '<p><strong>Your request was sent.</strong></p><p>Grade ' + esc(String(j.grade)) + ' - ' + esc(j.year) + '. The school admin will approve it and give your section.</p>';
      $('#modalRoot').querySelector('.modal-foot').innerHTML = '<button type="button" class="btn btn-primary" data-close>Close</button>';
      window.__pubCred = null;
    }).catch(function (e) { pubError(e.message); });
  }

  /* ================= 8. EVENTS AND START-UP ================= */
  function setUi(path, value) {
    var p = path.split('.'); ui[p[0]][p[1]] = value;
    if (p[1] === 'grade') { ui[p[0]].section = ''; }
    if (path === 'mon.schoolId') { var f = freshUi(); ui.st = f.st; ui.ro = f.ro; ui.tr = f.tr; ui.mon.tab = 'overview'; }
  }
  function bindEvents() {
    $('#loginForm').addEventListener('submit', handleLogin);
    $('#pwToggle').addEventListener('click', function () { var i = $('#loginPass'), s = i.type === 'password'; i.type = s ? 'text' : 'password'; this.textContent = s ? 'Hide' : 'Show'; });

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-backdrop')) { closeModal(); return; }
      if (t.closest && t.closest('[data-close]')) { closeModal(); return; }
      var el = t.closest ? t.closest('[data-action]') : null;
      if (!el || el.disabled) { return; }
      var a = el.getAttribute('data-action'), id = el.getAttribute('data-id');
      switch (a) {
        case 'menu': $('#sidebar').classList.toggle('open'); break;
        case 'logout': logout(); break;
        case 'nav': go(el.getAttribute('data-view')); break;
        case 'school-add': openModal(schoolFormHtml(null)); break;
        case 'school-edit': openModal(schoolFormHtml(db.schools.filter(function (s) { return s.id === id; })[0])); break;
        case 'school-del': deleteSchool(id); break;
        case 'student-add': openModal(studentFormHtml(null)); break;
        case 'student-edit': openModal(studentFormHtml(db.students.filter(function (s) { return s.id === id; })[0])); break;
        case 'student-del': deleteStudent(id); break;
        case 'students-import': $('#studentFile').click(); break;
        case 'students-template': downloadStudentTemplate(); break;
        case 'students-export': exportStudents(); break;
        case 'import-commit': commitImport(); break;
        case 'subj-rename': renameSubject(id); break;
        case 'subj-del': removeSubject(id); break;
        case 'subj-up': moveSubject(id, -1); break;
        case 'subj-down': moveSubject(id, 1); break;
        case 'marks-save': saveMarks(); break;
        case 'roster-print': printRoster(); break;
        case 'roster-pdf': exportRosterPdf(); break;
        case 'roster-xlsx': exportRosterExcel(); break;
        case 'settings-save': saveSettings(); break;
        case 'pass-change': changePassword(); break;
        case 'backup': backupData(); break;
        case 'restore': $('#restoreFile').click(); break;
        case 'conduct-save': saveConduct(); break;
        case 'pub-result': openModal(pubFormHtml('result')); break;
        case 'pub-register': openModal(pubFormHtml('reg')); break;
        case 'release-save': saveRelease(); break;
        case 'registration-save': saveRegistration(); break;
        case 'reg-approve': approveReg(id); break;
        case 'reg-reject': rejectReg(id); break;
        case 'marks-submit': confirmBox('Submit final results?', 'Your marks on this page are saved and your account is deactivated. Only the school admin can reset it. Make sure the marks of all your classes are saved first.', 'Submit', false).then(function (yes) { if (yes) { saveMarks(true); } }); break;
        case 'staff-reset': resetStaff(id); break;
        case 'logo-clear': clearLogo(el.getAttribute('data-side')); break;
        case 'school-monitor': ui.mon.schoolId = id; ui.mon.tab = 'overview'; go('monitor'); break;
        case 'mon-tab': ui.mon.tab = el.getAttribute('data-tab'); render(); break;
        case 'stats-xlsx': exportStatsExcel(); break;
        case 'staff-add': openModal(staffFormHtml(null)); break;
        case 'staff-edit': openModal(staffFormHtml((school().staff || []).filter(function (t) { return t.id === id; })[0])); break;
        case 'staff-del': deleteStaff(id); break;
        case 'tr-open': ui.tr.sid = id; render(); window.scrollTo(0, 0); break;
        case 'tr-back': ui.tr.sid = ''; render(); break;
        case 'tr-edit': var tcs = currentTrStudent(); if (tcs) { openModal(tcFormHtml(tcs)); } break;
        case 'tr-print': var tp = currentTrStudent(); if (tp) { printTranscripts([tp]); } break;
        case 'tr-pdf': var tq = currentTrStudent(); if (tq) { exportTranscriptPdf(tq); } break;
        case 'tr-print-all': printTranscripts(filteredTr()); break;
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('#modalRoot').innerHTML !== '') { closeModal(); } });
    document.addEventListener('submit', function (e) {
      var id = e.target && e.target.id;
      if (id === 'studentForm') { e.preventDefault(); handleStudentSubmit(e.target); }
      else if (id === 'schoolForm') { e.preventDefault(); handleSchoolSubmit(e.target); }
      else if (id === 'renameForm') { e.preventDefault(); handleRename(e.target); }
      else if (id === 'subjectForm') { e.preventDefault(); addSubject($('#subjName').value); }
      else if (id === 'staffForm') { e.preventDefault(); handleStaffSubmit(e.target); }
      else if (id === 'pubResultForm') { e.preventDefault(); handlePubResult(); }
      else if (id === 'pubRegForm') { e.preventDefault(); handlePubRegister(); }
      else if (id === 'pubRegConfirm') { e.preventDefault(); handlePubRegConfirm(e.target); }
      else if (id === 'tcForm') { e.preventDefault(); handleTcSubmit(e.target); }
    });
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-mark')) { ui.mk.dirty = true; t.classList.remove('invalid'); updateMarkCount(); updateRowTotal(t.closest('tr')); return; }
      var path = t.getAttribute && t.getAttribute('data-ui');
      if (path && path === 'st.q') { setUi(path, t.value); fillStudentRows(); }
      else if (path && path === 'tr.q') { setUi(path, t.value); fillTranscriptRows(); }
    });
    document.addEventListener('change', function (e) {
      var t = e.target, path = t.getAttribute && t.getAttribute('data-ui');
      if (t.id === 'sfRole') { toggleStaffRole(); return; }
      if (t.id === 'fGrade') { toggleStreamField(); return; }
      if (t.id === 'setLogoLeft' || t.id === 'setLogoRight') { handleLogoFile(t); return; }
      if (!path) { return; }
      var group = path.split('.')[0];
      if (group === 'st') { setUi(path, t.value); if (path === 'st.grade') { render(); } else { fillStudentRows(); } return; }
      var apply = function () { setUi(path, t.value); ui.mk.dirty = false; if (group === 'ro' && path === 'ro.teacher') { renderRosterPreview(); } else { render(); } };
      if (group === 'mk' && ui.mk.dirty) {
        confirmBox('Discard unsaved marks?', 'You changed marks that are not saved yet. Changing the class or semester will discard them.', 'Discard', true).then(function (yes) { if (yes) { apply(); } else { render(); } });
      } else { apply(); }
    });
    $('#studentFile').addEventListener('change', function () { handleStudentFile(this.files[0]); });
    $('#restoreFile').addEventListener('change', function () { restoreData(this.files[0]); this.value = ''; });
    window.addEventListener('resize', fitAll);
  }

  function init() {
    securityInit();
    bindEvents();
    var ping = location.protocol === 'file:' ? Promise.reject(new Error('local')) : fetch('/api/ping', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) { throw new Error('no api'); } return r.json(); });
    ping.then(function (j) { API = !!(j && j.server); }).catch(function () { API = false; }).then(function () { if (API) { startApi(); } else { startLocal(); } });
  }
  function startApi() {
    db = emptyDb();
    apiCall('/api/me').then(function (m) { sess = m.me; return loadServerState().then(showApp); }).catch(function () { sess = null; showLogin(); });
  }
  function startLocal() {
    Store.open().then(Store.get.bind(Store)).then(function (d) {
      db = normalizeDb(d);
      if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* ignore */ }); }
      if (restoreSession()) { showApp(); } else { showLogin(); }
    }).catch(function (err) {
      db = emptyDb(); showLogin();
      loginError('The local database could not be opened: ' + (err && err.message ? err.message : 'unknown error') + '. Try another browser.');
    });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
