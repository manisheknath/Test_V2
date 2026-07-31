/* ============================================================
   Code.gs — Quiz Platform Backend
   ============================================================
   Single source of truth for every test: test metadata,
   questions, test-takers, site-wide settings, and submitted
   results all live in ONE Google Sheet, edited only through the
   Admin page (admin.html) — never by hand.

   ---------------------------------------------------------
   HEADER-DRIVEN READS AND WRITES
   ---------------------------------------------------------
   Every read AND write goes through the header row:
     • ensureColumns_() adds any missing column to a sheet that
       already has data, so new columns (audioUrl, assignedTo,
       takerId, the whole Takers sheet) get created automatically
       instead of needing to be added by hand.
     • rowFromObject_() places each value under its own header,
       wherever that header happens to be.
   Column order in the sheet no longer matters. Adding a new
   column in the middle can no longer corrupt saves.

   ---------------------------------------------------------
   TEST-TAKER PORTAL (home.html)
   ---------------------------------------------------------
   Takers sign in at home.html with an ID + password and see only
   the tests assigned to them. Added in this version:
     • A Takers sheet (salted SHA-256 password hashes).
     • assignedTo column on Tests, takerId column on Results.
     • Signed session tokens (HMAC) so a browser can stay logged
       in without ever holding the password, and can't read
       another taker's data.
     • Endpoints: takerLogin, whoami, listTestsForMe, getMyResult,
       and admin listTakers / saveTaker / deleteTaker.

   ---------------------------------------------------------
   ONE-TIME SETUP
   ---------------------------------------------------------
   1. Create a new Google Sheet. Copy its ID from the URL
      (the long string between /d/ and /edit).
   2. Extensions → Apps Script. Delete any starter code and
      paste this whole file in.
   3. Project Settings (gear icon) → Script Properties → add:
         SPREADSHEET_ID   = <the ID you copied>
         ADMIN_TOKEN      = <a long random password>
         SESSION_SECRET   = <a DIFFERENT long random string>
      ADMIN_TOKEN protects the Admin page. SESSION_SECRET signs
      taker login tokens — keep it secret; changing it logs every
      taker out. If it's missing, the code falls back to
      ADMIN_TOKEN so logins still work, but a separate value is
      strongly recommended.
   4. Run the `setup` function once. It creates the Tests,
      Questions, Takers, Results and Settings tabs with correct
      headers. Authorize when prompted.
   5. Deploy → New deployment → type: Web app.
         Execute as: Me
         Who has access: Anyone
      Copy the /exec URL into admin.html, quiz-engine.html AND
      home.html.
   6. AFTER EVERY EDIT TO THIS FILE: Deploy → Manage deployments
      → pencil icon → Version: New version → Deploy.
      Saving alone does NOT update the live URL.

   ---------------------------------------------------------
   IF AN EXISTING SHEET IS MISSING COLUMNS
   ---------------------------------------------------------
   Select `repairHeaders` in the function dropdown and click Run.
   It adds any missing columns (and the Takers sheet) without
   touching your data, and logs what it added.
   ============================================================ */

const TESTS_HEADERS = ['testCode','title','intro','timeLimitMinutes','startDate','deadline','shuffleQuestions','shuffleOptions','updatedAt','assignedTo'];
const QUESTIONS_HEADERS = ['testCode','qOrder','type','prompt','optionA','optionB','optionC','optionD','correctIndex','points','explanation','referenceAnswer','audioUrl','sectionType','sectionTitle','sectionDesc','starterCode'];
const TAKERS_HEADERS = ['takerId','name','email','passwordHash','salt','groups'];
const RESULTS_HEADERS = ['timestamp','testCode','testTitle','takerId','takerName','takerEmail','earned','possible','autoSubmitted','fullscreenExitCount','tabSwitchCount','payloadJson','submissionId','graded','finalEarned','gradingJson'];
const SETTINGS_HEADERS = ['key','value'];

/* ============================================================
   Setup and repair
   ============================================================ */
function setup() {
  const ss = SpreadsheetApp.openById(getProp_('SPREADSHEET_ID'));

  const tests = getOrCreateSheet_(ss, 'Tests');
  const testsMap = ensureColumns_(tests, TESTS_HEADERS);
  forceTextFormat_(tests, testsMap, ['startDate','deadline']);

  const questions = getOrCreateSheet_(ss, 'Questions');
  ensureColumns_(questions, QUESTIONS_HEADERS);

  const takers = getOrCreateSheet_(ss, 'Takers');
  ensureColumns_(takers, TAKERS_HEADERS);

  const results = getOrCreateSheet_(ss, 'Results');
  ensureColumns_(results, RESULTS_HEADERS);

  const settings = getOrCreateSheet_(ss, 'Settings');
  ensureColumns_(settings, SETTINGS_HEADERS);
  ensureSettingRow_(settings, 'siteName', 'Test Portal');
  ensureSettingRow_(settings, 'siteTagline', '');

  Logger.log('Setup complete.');
}

/**
 * Run this by hand from the editor if an existing sheet is missing
 * columns (for example an older sheet with no audioUrl / assignedTo /
 * takerId column, or no Takers sheet). Adds only what is missing;
 * never deletes, moves or overwrites.
 */
function repairHeaders() {
  const ss = SpreadsheetApp.openById(getProp_('SPREADSHEET_ID'));
  const report = [];

  [['Tests', TESTS_HEADERS], ['Questions', QUESTIONS_HEADERS], ['Takers', TAKERS_HEADERS],
   ['Results', RESULTS_HEADERS], ['Settings', SETTINGS_HEADERS]].forEach(pair => {
    const name = pair[0], required = pair[1];
    const sheet = getOrCreateSheet_(ss, name); // create Takers if missing
    const before = Object.keys(headerMap_(sheet));
    ensureColumns_(sheet, required);
    const after = Object.keys(headerMap_(sheet));
    const added = after.filter(h => before.indexOf(h) === -1);
    report.push(name + ': ' + (added.length ? 'added ' + added.join(', ') : 'already complete'));
  });

  const tests = ss.getSheetByName('Tests');
  if (tests) forceTextFormat_(tests, headerMap_(tests), ['startDate','deadline']);

  const msg = report.join('\n');
  Logger.log(msg);
  return msg;
}

/* ============================================================
   Header-driven sheet helpers
   ============================================================ */
function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/**
 * Returns { headerName: zeroBasedColumnIndex } for row 1.
 */
function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0 || sheet.getLastRow() === 0) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h == null ? '' : h).trim();
    if (key !== '' && !(key in map)) map[key] = i;
  });
  return map;
}

/**
 * Guarantees every required header exists on the sheet.
 * Empty sheet  → writes the full header row.
 * Sheet with data → appends only the missing headers on the right,
 * leaving existing columns and their data exactly where they are.
 * Returns the resulting header map.
 */
function ensureColumns_(sheet, required) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, required.length).setValues([required]);
    SpreadsheetApp.flush();
    return headerMap_(sheet);
  }
  const map = headerMap_(sheet);
  const missing = required.filter(h => !(h in map));
  if (missing.length) {
    const startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    SpreadsheetApp.flush();
    return headerMap_(sheet);
  }
  return map;
}

/**
 * Builds a row array by placing each object value under its own
 * header, wherever that header sits. Unknown keys are ignored;
 * headers with no matching key become empty strings.
 */
function rowFromObject_(map, obj) {
  let width = 0;
  Object.keys(map).forEach(k => { if (map[k] + 1 > width) width = map[k] + 1; });
  const row = new Array(width).fill('');
  Object.keys(obj).forEach(k => {
    if (k in map) row[map[k]] = obj[k];
  });
  return row;
}

/**
 * Keeps date-like columns as plain TEXT. Otherwise Sheets can
 * silently reinterpret "2026-08-01T09:00:00" as a real Date in the
 * spreadsheet timezone, which then reads back shifted if the
 * script timezone differs.
 */
function forceTextFormat_(sheet, map, columnNames) {
  columnNames.forEach(name => {
    if (!(name in map)) return;
    sheet.getRange(2, map[name] + 1, 10000, 1).setNumberFormat('@');
  });
}

function ensureSettingRow_(sheet, key, defaultValue) {
  const data = sheet.getDataRange().getValues();
  const exists = data.some(r => r[0] === key);
  if (!exists) sheet.appendRow([key, defaultValue]);
}
function getProp_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}
function ss_() {
  return SpreadsheetApp.openById(getProp_('SPREADSHEET_ID'));
}
function sheet_(name) {
  return ss_().getSheetByName(name);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function checkToken_(token) {
  return token && token === getProp_('ADMIN_TOKEN');
}

/**
 * Test codes arrive from URLs as strings, but Sheets stores a purely
 * numeric code (e.g. 1213) as a NUMBER. A strict === between the two
 * is always false, which made numeric test codes impossible to find.
 * Normalize both sides to a trimmed string before every comparison.
 */
function codeKey_(v) {
  return String(v == null ? '' : v).trim();
}

/* ============================================================
   doGet — public reads (getTest, check) + taker reads
   (listTestsForMe, getMyResult, whoami) + admin reads
   (listTests, getTestForEdit, getSettings, listTakers).
   ============================================================ */
function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'getTest') {
      return json_(getTest_(e.parameter.testCode));
    }
    if (action === 'check') {
      return json_({ alreadySubmitted: hasSubmitted_(e.parameter.email, e.parameter.testCode) });
    }
    // ---- Test-taker reads (authenticated by a login session token) ----
    if (action === 'listTestsForMe') {
      return json_(listTestsForMe_(e.parameter.token));
    }
    if (action === 'getMyResult') {
      return json_(getMyResult_(e.parameter.token, e.parameter.testCode));
    }
    if (action === 'whoami') {
      return json_(whoami_(e.parameter.token));
    }
    // ---- Admin reads (authenticated by ADMIN_TOKEN) ----
    if (action === 'listTests') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, tests: listTests_() });
    }
    if (action === 'getTestForEdit') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, test: getTest_(e.parameter.testCode) });
    }
    if (action === 'getSettings') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, settings: getSettings_() });
    }
    if (action === 'listTakers') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, takers: listTakers_() });
    }
    if (action === 'listResults') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_({ ok: true, results: listResults_(e.parameter.testCode) });
    }
    if (action === 'getSubmission') {
      if (!checkToken_(e.parameter.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_(getSubmission_(e.parameter.row));
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ============================================================
   doPost — three shapes land here:
   1. Taker login: { action:'takerLogin', id, password } — public.
   2. Admin actions: JSON body with an "action" field (saveTest /
      deleteTest / saveSettings / saveTaker / deleteTaker),
      always ADMIN_TOKEN-gated.
   3. Results submissions: JSON body with NO "action" field —
      exactly what quiz-engine.html already sends.
   ============================================================ */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // --- Public: test-taker login ---
    if (body.action === 'takerLogin') {
      return json_(takerLogin_(body.id, body.password));
    }

    // --- Admin-gated actions ---
    if (body.action === 'saveTest') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      saveTest_(body.test);
      return json_({ ok: true });
    }
    if (body.action === 'deleteTest') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      deleteTest_(body.testCode);
      return json_({ ok: true });
    }
    if (body.action === 'saveSettings') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      saveSettings_(body.settings);
      return json_({ ok: true });
    }
    if (body.action === 'saveTaker') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_(saveTaker_(body.taker));
    }
    if (body.action === 'deleteTaker') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      deleteTaker_(body.takerId);
      return json_({ ok: true });
    }
    if (body.action === 'saveGrading') {
      if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });
      return json_(saveGrading_(body.row, body.grading));
    }

    // No 'action' field => results submission from quiz-engine.html
    recordResult_(body);
    return json_({ ok: true });

  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ============================================================
   Security helpers — password hashing + signed session tokens
   ============================================================
   Passwords: salted SHA-256, one random salt per taker. Session
   tokens: "<base64(takerId|expiryMs)>.<hmac>", signed with
   SESSION_SECRET, stateless and unforgeable.
   ============================================================ */
function sessionSecret_() {
  return getProp_('SESSION_SECRET') || getProp_('ADMIN_TOKEN') || 'CHANGE_ME_SESSION_SECRET';
}
function toHex_(bytes) {
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
function makeSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}
function hashPassword_(password, salt) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + String(password),
    Utilities.Charset.UTF_8
  );
  return toHex_(raw);
}
function sign_(str) {
  const raw = Utilities.computeHmacSha256Signature(String(str), sessionSecret_(), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(raw);
}
function makeSessionToken_(takerId) {
  const exp = Date.now() + 8 * 60 * 60 * 1000; // 8 hours
  const payload = String(takerId) + '|' + exp;
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(payload).getBytes()) + '.' + sign_(payload);
}
// Returns the takerId if the token is valid and unexpired, else null.
function verifySessionToken_(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) {
    return null;
  }
  const sep = payload.lastIndexOf('|');
  if (sep === -1) return null;
  const takerId = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (sign_(payload) !== parts[1]) return null; // tampered / wrong secret
  if (!exp || Date.now() > exp) return null;     // expired
  return takerId;
}

/* ============================================================
   Takers registry
   ============================================================ */
function takersData_() {
  const sheet = sheet_('Takers');
  const data = sheet.getDataRange().getValues();
  return { map: headerMap_(sheet), rows: data.length > 1 ? data.slice(1) : [] };
}
// Case-insensitive lookup by takerId. Returns a plain object incl. hash/salt.
function findTaker_(takerId) {
  if (!takerId) return null;
  const { map, rows } = takersData_();
  const idCol = map['takerId'];
  const wanted = String(takerId).trim().toLowerCase();
  const row = rows.find(r => String(r[idCol]).trim().toLowerCase() === wanted);
  if (!row) return null;
  const get = (c) => (c in map ? row[map[c]] : '');
  return {
    takerId: get('takerId'),
    name: get('name'),
    email: get('email'),
    passwordHash: get('passwordHash'),
    salt: get('salt'),
    groups: get('groups')
  };
}
// Admin listing — never exposes the hash or salt.
function listTakers_() {
  const { map, rows } = takersData_();
  const get = (r, c) => (c in map ? r[map[c]] : '');
  return rows
    .filter(r => String(get(r, 'takerId')).trim() !== '')
    .map(r => ({
      takerId: get(r, 'takerId'),
      name: get(r, 'name'),
      email: get(r, 'email'),
      groups: get(r, 'groups'),
      hasPassword: !!String(get(r, 'passwordHash')).trim()
    }));
}
// Create or update a taker. If taker.password is a non-empty string it is
// (re)hashed; otherwise the existing password is preserved on update.
function saveTaker_(taker) {
  if (!taker) return { ok: false, error: 'missing_taker' };
  let takerId = String(taker.takerId || '').trim();
  if (!takerId) takerId = 'T-' + Utilities.getUuid().slice(0, 8).toUpperCase();

  const sheet = sheet_('Takers');
  const map = ensureColumns_(sheet, TAKERS_HEADERS);
  const data = sheet.getDataRange().getValues();
  const idCol = map['takerId'];
  const rowIndex = data.findIndex((r, i) => i > 0 && String(r[idCol]).trim().toLowerCase() === takerId.toLowerCase());
  const existing = rowIndex > 0 ? data[rowIndex] : null;

  let passwordHash = existing ? existing[map['passwordHash']] : '';
  let salt = existing ? existing[map['salt']] : '';
  if (taker.password && String(taker.password).length > 0) {
    salt = makeSalt_();
    passwordHash = hashPassword_(String(taker.password), salt);
  }

  const row = rowFromObject_(map, {
    takerId: takerId,
    name: taker.name || '',
    email: taker.email || '',
    passwordHash: passwordHash || '',
    salt: salt || '',
    groups: taker.groups || ''
  });

  if (!existing) {
    sheet.appendRow(row);
  } else {
    sheet.getRange(rowIndex + 1, 1, 1, row.length).setValues([row]);
  }
  return { ok: true, takerId: takerId };
}
function deleteTaker_(takerId) {
  const sheet = sheet_('Takers');
  const map = headerMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const idCol = map['takerId'];
  const wanted = String(takerId).trim().toLowerCase();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]).trim().toLowerCase() === wanted) sheet.deleteRow(i + 1);
  }
}
// Verify credentials and hand back a session token. The error message is
// deliberately identical for "no such id" and "wrong password".
function takerLogin_(id, password) {
  const taker = findTaker_(id);
  const bad = { ok: false, error: 'Invalid ID or password.' };
  if (!taker || !taker.passwordHash) return bad;
  if (hashPassword_(String(password || ''), taker.salt) !== taker.passwordHash) return bad;
  return { ok: true, token: makeSessionToken_(taker.takerId), takerId: taker.takerId, name: taker.name };
}
// Resolve a login token to identity — used by quiz-engine.html to lock
// the taker's name/email when a test is launched from the portal.
function whoami_(token) {
  const takerId = verifySessionToken_(token);
  if (!takerId) return { ok: false, error: 'unauthorized' };
  const taker = findTaker_(takerId);
  if (!taker) return { ok: false, error: 'unauthorized' };
  return { ok: true, takerId: taker.takerId, name: taker.name, email: taker.email };
}

/* ============================================================
   Assignment + status logic (test-taker dashboard)
   ============================================================ */
// A test is visible to a taker if its assignedTo list contains the taker's
// id or any of the taker's groups. Empty / "all" means everyone.
function testAssignedToTaker_(assignedTo, taker) {
  const raw = String(assignedTo || '').trim();
  if (raw === '' || raw.toLowerCase() === 'all') return true;
  const tokens = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const id = String(taker.takerId).trim().toLowerCase();
  const groups = String(taker.groups || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return tokens.some(tok => tok === id || groups.indexOf(tok) !== -1);
}
function statusFor_(startDate, deadline, submitted) {
  const now = new Date();
  const start = startDate ? new Date(startDate) : null;
  const end = deadline ? new Date(deadline) : null;
  if (submitted) return 'completed';
  if (start && !isNaN(start.getTime()) && now < start) return 'scheduled';
  if (end && !isNaN(end.getTime()) && now > end) return 'closed';
  return 'available';
}
// The dashboard feed. Returns only the taker's assigned tests, each with a
// status — and deliberately NO questions, answers, or reference text.
function listTestsForMe_(token) {
  const takerId = verifySessionToken_(token);
  if (!takerId) return { ok: false, error: 'unauthorized' };
  const taker = findTaker_(takerId);
  if (!taker) return { ok: false, error: 'unauthorized' };

  const testsSheet = sheet_('Tests');
  const data = testsSheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, name: taker.name, takerId: taker.takerId, tests: [] };
  const map = headerMap_(testsSheet);
  const get = (r, c) => (c in map ? r[map[c]] : '');

  const submissions = submissionMapForTaker_(takerId);

  const tests = data.slice(1)
    .filter(r => codeKey_(get(r, 'testCode')) !== '')
    .filter(r => testAssignedToTaker_(get(r, 'assignedTo'), taker))
    .map(r => {
      const testCode = get(r, 'testCode');
      const startDate = formatSheetDate_(get(r, 'startDate'));
      const deadline = formatSheetDate_(get(r, 'deadline'));
      const sub = submissions[codeKey_(testCode)];
      return {
        testCode: testCode,
        title: get(r, 'title'),
        intro: get(r, 'intro'),
        timeLimitMinutes: Number(get(r, 'timeLimitMinutes')) || 0,
        startDate: startDate,
        deadline: deadline,
        status: statusFor_(startDate, deadline, !!sub),
        score: sub ? { earned: sub.earned, possible: sub.possible } : null,
        graded: sub ? !!sub.graded : false,
        gradedAt: sub ? (sub.gradedAt || null) : null,
        note: sub ? (sub.note || null) : null,
        updatedAt: formatSheetDate_(get(r, 'updatedAt')),
        submittedAt: sub ? sub.submittedAt : null
      };
    });

  return { ok: true, name: taker.name, takerId: taker.takerId, tests: tests };
}
// Full result payload for one of the taker's own completed tests.
function getMyResult_(token, testCode) {
  const takerId = verifySessionToken_(token);
  if (!takerId) return { ok: false, error: 'unauthorized' };
  if (!testCode) return { ok: false, error: 'missing_testCode' };

  const sheet = sheet_('Results');
  const data = sheet.getDataRange().getValues();
  const map = headerMap_(sheet);
  const idCol = map['takerId'];
  const codeCol = map['testCode'];
  const payloadCol = map['payloadJson'];
  const gradedCol = map['graded'];
  const finalCol = map['finalEarned'];
  const gjCol = map['gradingJson'];
  const wanted = String(takerId).trim().toLowerCase();

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]).trim().toLowerCase() === wanted && codeKey_(data[i][codeCol]) === codeKey_(testCode)) {
      try {
        const result = JSON.parse(data[i][payloadCol]);
        const graded = String(data[i][gradedCol]).toLowerCase() === 'yes';
        let grading = null;
        if (data[i][gjCol]) { try { grading = JSON.parse(data[i][gjCol]); } catch (e) { grading = null; } }
        return {
          ok: true,
          result: result,
          graded: graded,
          finalEarned: graded ? Number(data[i][finalCol]) : null,
          grading: grading
        };
      } catch (err) {
        return { ok: false, error: 'corrupt_result' };
      }
    }
  }
  return { ok: false, error: 'not_found' };
}
// testCode -> {earned, possible, submittedAt} for a taker's submissions.
function submissionMapForTaker_(takerId) {
  const sheet = sheet_('Results');
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const map = headerMap_(sheet);
  const idCol = map['takerId'];
  const codeCol = map['testCode'];
  const earnedCol = map['earned'];
  const possibleCol = map['possible'];
  const gradedCol = map['graded'];
  const finalCol = map['finalEarned'];
  const gjCol = map['gradingJson'];
  const tsCol = map['timestamp'];
  const wanted = String(takerId).trim().toLowerCase();
  const out = {};
  data.slice(1).forEach(r => {
    if (String(r[idCol]).trim().toLowerCase() === wanted) {
      const graded = String(r[gradedCol]).toLowerCase() === 'yes';
      let gradedAt = '', note = '';
      if (graded && r[gjCol]) {
        try { const gj = JSON.parse(r[gjCol]); gradedAt = gj.gradedAt || ''; note = gj.overallNote || ''; } catch (e) {}
      }
      out[codeKey_(r[codeCol])] = {
        earned: graded ? r[finalCol] : r[earnedCol],
        possible: r[possibleCol],
        graded: graded,
        gradedAt: gradedAt,
        note: note,
        submittedAt: r[tsCol] instanceof Date ? r[tsCol].toISOString() : String(r[tsCol])
      };
    }
  });
  return out;
}

/* ============================================================
   Grading — admin reviews a submission and adjusts points/notes
   ============================================================
   A submission is addressed by its sheet row number (returned by
   listResults_). Grading is stored on that row: graded='yes',
   finalEarned=<admin total>, gradingJson={items:{qNumber:{points,
   note}}, overallNote}.
   ============================================================ */
function resultRowSummary_(map, r, rowNum) {
  const g = (c) => (c in map ? r[map[c]] : '');
  const graded = String(g('graded')).toLowerCase() === 'yes';
  const ts = g('timestamp');
  return {
    row: rowNum,
    submissionId: g('submissionId'),
    testCode: g('testCode'),
    testTitle: g('testTitle'),
    takerId: g('takerId'),
    takerName: g('takerName'),
    takerEmail: g('takerEmail'),
    submittedAt: ts instanceof Date ? ts.toISOString() : String(ts),
    autoEarned: g('earned'),
    possible: g('possible'),
    graded: graded,
    finalEarned: graded ? Number(g('finalEarned')) : null
  };
}
// List submissions, newest first, optionally filtered to one testCode.
function listResults_(testCode) {
  const sheet = sheet_('Results');
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const map = headerMap_(sheet);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (codeKey_(r[map['testCode']]) === '') continue;
    if (testCode && codeKey_(r[map['testCode']]) !== codeKey_(testCode)) continue;
    out.push(resultRowSummary_(map, r, i + 1)); // i+1 = 1-based sheet row
  }
  return out.reverse();
}
// Full submission payload + any saved grading, for one sheet row.
function getSubmission_(row) {
  row = Number(row);
  const sheet = sheet_('Results');
  const map = headerMap_(sheet);
  if (!row || row < 2 || row > sheet.getLastRow()) return { ok: false, error: 'not_found' };
  const r = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  let submission;
  try { submission = JSON.parse(r[map['payloadJson']]); } catch (e) { return { ok: false, error: 'corrupt_result' }; }
  let grading = null;
  if (r[map['gradingJson']]) { try { grading = JSON.parse(r[map['gradingJson']]); } catch (e) { grading = null; } }
  return { ok: true, meta: resultRowSummary_(map, r, row), submission: submission, grading: grading };
}
// Save admin grading for a row. grading = { items:{qNumber:{points,note}},
// overallNote, finalEarned }. Marks the row graded and records the total.
function saveGrading_(row, grading) {
  row = Number(row);
  if (!row || !grading) return { ok: false, error: 'bad_request' };
  const sheet = sheet_('Results');
  const map = ensureColumns_(sheet, RESULTS_HEADERS);
  if (row < 2 || row > sheet.getLastRow()) return { ok: false, error: 'not_found' };
  const finalEarned = Number(grading.finalEarned) || 0;
  grading.gradedAt = new Date().toISOString(); // stamped server-side, drives taker notifications
  sheet.getRange(row, map['graded'] + 1).setValue('yes');
  sheet.getRange(row, map['finalEarned'] + 1).setValue(finalEarned);
  sheet.getRange(row, map['gradingJson'] + 1).setValue(JSON.stringify(grading));
  return { ok: true, finalEarned: finalEarned };
}

/* ============================================================
   Tests / Questions — reads
   ============================================================ */
function getTest_(testCode) {
  if (!testCode) return { ok: false, error: 'missing_testCode' };

  const testsSheet = sheet_('Tests');
  const testsData = testsSheet.getDataRange().getValues();
  if (testsData.length < 2) return { ok: false, error: 'not_found' };
  const tMap = headerMap_(testsSheet);
  const row = testsData.slice(1).find(r => codeKey_(r[tMap['testCode']]) === codeKey_(testCode));
  if (!row) return { ok: false, error: 'not_found' };

  const get = (col) => (col in tMap ? row[tMap[col]] : '');
  const test = {
    ok: true,
    testCode: get('testCode'),
    title: get('title'),
    intro: get('intro'),
    timeLimitMinutes: Number(get('timeLimitMinutes')),
    startDate: formatSheetDate_(get('startDate')),
    deadline: formatSheetDate_(get('deadline')),
    shuffleQuestions: !!get('shuffleQuestions'),
    shuffleOptions: !!get('shuffleOptions'),
    assignedTo: get('assignedTo') || '',
    questions: []
  };

  const qSheet = sheet_('Questions');
  const qData = qSheet.getDataRange().getValues();
  const qMap = headerMap_(qSheet);
  const qGet = (r, col) => (col in qMap ? r[qMap[col]] : '');

  const qRows = qData.slice(1)
    .filter(r => codeKey_(qGet(r, 'testCode')) === codeKey_(testCode))
    .sort((a, b) => Number(qGet(a, 'qOrder')) - Number(qGet(b, 'qOrder')));

  test.questions = qRows.map(r => {
    const type = qGet(r, 'type');
    const points = Number(qGet(r, 'points'));
    const explanation = qGet(r, 'explanation') || undefined;
    const audioUrl = qGet(r, 'audioUrl') || undefined;

    // A 'passage' row is a SECTION marker (context block, not a question):
    // no points, no answer. It carries the section's type/header/description
    // plus its block content (reading paragraph in prompt, listening audio
    // in audioUrl). It groups the questions that follow it.
    if (type === 'passage') {
      return {
        type: 'passage',
        sectionType: qGet(r, 'sectionType') || '',
        sectionTitle: qGet(r, 'sectionTitle') || '',
        sectionDesc: qGet(r, 'sectionDesc') || '',
        prompt: qGet(r, 'prompt'),
        audioUrl: audioUrl,
        points: 0
      };
    }
    if (type === 'mc') {
      const options = [qGet(r,'optionA'), qGet(r,'optionB'), qGet(r,'optionC'), qGet(r,'optionD')]
        .filter(v => v !== '' && v !== null && v !== undefined);
      return {
        type: 'mc',
        prompt: qGet(r, 'prompt'),
        points: points,
        options: options,
        correctIndex: Number(qGet(r, 'correctIndex')),
        explanation: explanation,
        audioUrl: audioUrl
      };
    }
    if (type === 'code') {
      // A coding question: prompt + optional starter code + reference
      // solution (referenceAnswer). Graded manually, like a short answer.
      return {
        type: 'code',
        prompt: qGet(r, 'prompt'),
        points: points,
        starterCode: qGet(r, 'starterCode') || '',
        answer: qGet(r, 'referenceAnswer') || undefined,
        explanation: explanation
      };
    }
    return {
      type: 'short',
      prompt: qGet(r, 'prompt'),
      points: points,
      answer: qGet(r, 'referenceAnswer') || undefined,
      explanation: explanation,
      audioUrl: audioUrl
    };
  });

  const settings = getSettings_();
  test.siteName = settings.siteName || '';
  test.siteTagline = settings.siteTagline || '';

  return test;
}

function formatSheetDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return val.getFullYear() + '-' + pad(val.getMonth()+1) + '-' + pad(val.getDate())
      + 'T' + pad(val.getHours()) + ':' + pad(val.getMinutes()) + ':' + pad(val.getSeconds());
  }
  return String(val);
}

function listTests_() {
  const testsSheet = sheet_('Tests');
  const data = testsSheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const tMap = headerMap_(testsSheet);

  const qSheet = sheet_('Questions');
  const qData = qSheet.getDataRange().getValues();
  const qMap = headerMap_(qSheet);
  const qCodeCol = qMap['testCode'];

  return data.slice(1).map(row => {
    const get = (col) => (col in tMap ? row[tMap[col]] : '');
    const testCode = get('testCode');
    const qCount = qData.slice(1).filter(r => codeKey_(r[qCodeCol]) === codeKey_(testCode)).length;
    return {
      testCode: testCode,
      title: get('title'),
      timeLimitMinutes: get('timeLimitMinutes'),
      startDate: formatSheetDate_(get('startDate')),
      deadline: formatSheetDate_(get('deadline')),
      assignedTo: get('assignedTo') || '',
      questionCount: qCount,
      updatedAt: formatSheetDate_(get('updatedAt'))
    };
  });
}

/* ============================================================
   Tests / Questions — writes (header-driven)
   ============================================================ */
function saveTest_(test) {
  if (!test || !test.testCode) throw new Error('test.testCode is required');

  // --- Tests sheet ---
  const testsSheet = sheet_('Tests');
  const tMap = ensureColumns_(testsSheet, TESTS_HEADERS);
  forceTextFormat_(testsSheet, tMap, ['startDate','deadline']);

  const testsData = testsSheet.getDataRange().getValues();
  const codeCol = tMap['testCode'];
  const rowIndex = testsData.findIndex((r, i) => i > 0 && codeKey_(r[codeCol]) === codeKey_(test.testCode));

  const testRow = rowFromObject_(tMap, {
    testCode: test.testCode,
    title: test.title || '',
    intro: test.intro || '',
    timeLimitMinutes: test.timeLimitMinutes || 0,
    startDate: test.startDate || '',
    deadline: test.deadline || '',
    shuffleQuestions: !!test.shuffleQuestions,
    shuffleOptions: !!test.shuffleOptions,
    updatedAt: new Date(),
    assignedTo: test.assignedTo || ''
  });

  if (rowIndex === -1) {
    testsSheet.appendRow(testRow);
  } else {
    testsSheet.getRange(rowIndex + 1, 1, 1, testRow.length).setValues([testRow]);
  }

  // --- Questions sheet ---
  // Replace all questions for this test: delete existing rows, then
  // write the new set in the order given.
  const qSheet = sheet_('Questions');
  const qMap = ensureColumns_(qSheet, QUESTIONS_HEADERS);
  const qCodeCol = qMap['testCode'];

  const qData = qSheet.getDataRange().getValues();
  const doomed = [];
  for (let i = 1; i < qData.length; i++) {
    if (codeKey_(qData[i][qCodeCol]) === codeKey_(test.testCode)) doomed.push(i + 1); // 1-based row
  }
  // Delete bottom-up, collapsing contiguous runs into single calls so a
  // 30-question test does not cost 30 separate API round trips.
  for (let i = doomed.length - 1; i >= 0; i--) {
    let end = doomed[i];
    let start = end;
    while (i > 0 && doomed[i - 1] === start - 1) { start = doomed[i - 1]; i--; }
    qSheet.deleteRows(start, end - start + 1);
  }

  const questions = test.questions || [];
  if (questions.length) {
    const rows = questions.map((q, i) => {
      const options = q.type === 'mc' ? (q.options || []) : [];
      return rowFromObject_(qMap, {
        testCode: test.testCode,
        qOrder: i,
        type: q.type,
        prompt: q.prompt || '',
        optionA: options[0] || '',
        optionB: options[1] || '',
        optionC: options[2] || '',
        optionD: options[3] || '',
        correctIndex: q.type === 'mc' ? q.correctIndex : '',
        points: q.type === 'passage' ? 0 : (q.points || 0),
        explanation: q.explanation || '',
        referenceAnswer: (q.type === 'short' || q.type === 'code') ? (q.answer || '') : '',
        audioUrl: q.audioUrl || '',
        sectionType: q.type === 'passage' ? (q.sectionType || '') : '',
        sectionTitle: q.type === 'passage' ? (q.sectionTitle || '') : '',
        sectionDesc: q.type === 'passage' ? (q.sectionDesc || '') : '',
        starterCode: q.type === 'code' ? (q.starterCode || '') : ''
      });
    });
    // Single batched write instead of one appendRow per question.
    const startRow = qSheet.getLastRow() + 1;
    qSheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function deleteTest_(testCode) {
  const testsSheet = sheet_('Tests');
  const tMap = headerMap_(testsSheet);
  const testsData = testsSheet.getDataRange().getValues();
  const codeCol = tMap['testCode'];
  for (let i = testsData.length - 1; i >= 1; i--) {
    if (codeKey_(testsData[i][codeCol]) === codeKey_(testCode)) testsSheet.deleteRow(i + 1);
  }

  const qSheet = sheet_('Questions');
  const qMap = headerMap_(qSheet);
  const qData = qSheet.getDataRange().getValues();
  const qCodeCol = qMap['testCode'];
  for (let i = qData.length - 1; i >= 1; i--) {
    if (codeKey_(qData[i][qCodeCol]) === codeKey_(testCode)) qSheet.deleteRow(i + 1);
  }
}

/* ============================================================
   Settings (site-wide header/branding)
   ============================================================ */
function getSettings_() {
  const data = sheet_('Settings').getDataRange().getValues();
  const out = {};
  data.slice(1).forEach(r => { out[r[0]] = r[1]; });
  return out;
}
function saveSettings_(settings) {
  const sheet = sheet_('Settings');
  ensureColumns_(sheet, SETTINGS_HEADERS);
  Object.keys(settings || {}).forEach(key => {
    const data = sheet.getDataRange().getValues();
    const rowIndex = data.findIndex((r, i) => i > 0 && r[0] === key);
    if (rowIndex === -1) {
      sheet.appendRow([key, settings[key]]);
    } else {
      sheet.getRange(rowIndex + 1, 2).setValue(settings[key]);
    }
  });
}

/* ============================================================
   Results — what quiz-engine.html's sendToBackend() posts.
   Now also records takerId so the taker portal can find a
   person's own past results reliably.
   ============================================================ */
function hasSubmitted_(email, testCode) {
  if (!email || !testCode) return false;
  const sheet = sheet_('Results');
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return false;
  const map = headerMap_(sheet);
  const emailCol = map['takerEmail'];
  const codeCol = map['testCode'];
  return data.slice(1).some(r =>
    String(r[emailCol]).toLowerCase() === String(email).toLowerCase() &&
    codeKey_(r[codeCol]) === codeKey_(testCode)
  );
}

function recordResult_(payload) {
  const sheet = sheet_('Results');
  const map = ensureColumns_(sheet, RESULTS_HEADERS);
  const row = rowFromObject_(map, {
    timestamp: new Date(),
    testCode: payload.testCode || '',
    testTitle: payload.testTitle || '',
    takerId: payload.takerId || '',
    takerName: payload.takerName || '',
    takerEmail: payload.takerEmail || '',
    earned: payload.score ? payload.score.earned : '',
    possible: payload.score ? payload.score.possible : '',
    autoSubmitted: !!payload.autoSubmittedOnTimeout,
    fullscreenExitCount: payload.fullscreenExitCount || 0,
    tabSwitchCount: payload.tabSwitchCount || 0,
    payloadJson: JSON.stringify(payload),
    submissionId: Utilities.getUuid(),
    graded: '',        // set to 'yes' by saveGrading_
    finalEarned: '',   // admin-adjusted total once graded
    gradingJson: ''    // per-question points + notes once graded
  });
  sheet.appendRow(row);
}
