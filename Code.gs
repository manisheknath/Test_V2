/* ============================================================
   Code.gs — Quiz Platform Backend
   ============================================================
   Replaces the older per-test backend. This is now the single
   source of truth for every test: test metadata, questions,
   test-takers, site-wide settings, and submitted results all
   live in ONE Google Sheet, edited only through the Admin page
   (admin.html) — never by hand.

   ---------------------------------------------------------
   ONE-TIME SETUP
   ---------------------------------------------------------
   1. Create a new Google Sheet. Copy its ID from the URL
      (the long string between /d/ and /edit).
   2. Extensions → Apps Script. Delete any starter code and
      paste this whole file in.
   3. Go to Project Settings (gear icon) → Script Properties →
      add three properties:
         SPREADSHEET_ID   = <the ID you copied>
         ADMIN_TOKEN      = <make up a long random password>
         SESSION_SECRET   = <make up a DIFFERENT long random string>
      The ADMIN_TOKEN protects the Admin page. The SESSION_SECRET
      is used to sign test-taker login tokens — keep it secret and
      never change it casually (changing it logs everyone out).
      If SESSION_SECRET is missing the code falls back to
      ADMIN_TOKEN so logins still work, but setting a separate one
      is strongly recommended.
   4. Run the `setup` function once (select it in the dropdown
      next to Run, click Run). It creates the Tests, Questions,
      Takers, Results, and Settings tabs with the right headers,
      and migrates older sheets by adding any missing columns.
      The first run will ask you to authorize the script — that's
      expected, click through it.
   5. Deploy → New deployment → type: Web app.
         Execute as: Me
         Who has access: Anyone
      Deploy, then copy the /exec URL. Paste that URL into
      admin.html, quiz-engine.html, AND home.html.
   6. Any time you edit this file afterwards: Deploy → Manage
      deployments → pencil icon → New version → Deploy. Saving
      alone does NOT update the live URL.
   ============================================================ */

function setup() {
  const ss = SpreadsheetApp.openById(getProp_('SPREADSHEET_ID'));

  const tests = getOrCreateSheet_(ss, 'Tests');
  setHeaderIfEmpty_(tests, ['testCode','title','intro','timeLimitMinutes','startDate','deadline','shuffleQuestions','shuffleOptions','updatedAt','assignedTo']);
  // Migrate older sheets that predate the assignedTo column.
  ensureColumn_(tests, 'assignedTo');
  // Force these two columns to stay plain TEXT — otherwise Sheets can
  // silently reinterpret "2026-08-01T09:00:00" as a real Date cell in
  // the spreadsheet's timezone, which can then read back shifted if
  // the script's execution timezone differs. Keeping them as text
  // means what you wrote is exactly what you get back, always.
  tests.getRange('E2:F10000').setNumberFormat('@');

  const questions = getOrCreateSheet_(ss, 'Questions');
  setHeaderIfEmpty_(questions, ['testCode','qOrder','type','prompt','optionA','optionB','optionC','optionD','correctIndex','points','explanation','referenceAnswer']);

  // Takers — the test-taker registry. Passwords are stored only as a
  // salted SHA-256 hash; the plaintext is never written to the sheet.
  const takers = getOrCreateSheet_(ss, 'Takers');
  setHeaderIfEmpty_(takers, ['takerId','name','email','passwordHash','salt','groups']);

  const results = getOrCreateSheet_(ss, 'Results');
  setHeaderIfEmpty_(results, ['timestamp','testCode','testTitle','takerId','takerName','takerEmail','earned','possible','autoSubmitted','fullscreenExitCount','tabSwitchCount','payloadJson']);
  // Migrate older Results sheets that predate the takerId column.
  ensureColumn_(results, 'takerId');

  const settings = getOrCreateSheet_(ss, 'Settings');
  setHeaderIfEmpty_(settings, ['key','value']);
  ensureSettingRow_(settings, 'siteName', 'Test Portal');
  ensureSettingRow_(settings, 'siteTagline', '');

  Logger.log('Setup complete.');
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function setHeaderIfEmpty_(sheet, headers) {
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
}
// Append a column header if the sheet doesn't already have it. Safe to
// run repeatedly. All reads/writes below look columns up BY NAME
// (headers.indexOf), so a column added at the end never breaks them.
function ensureColumn_(sheet, colName) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(colName) === -1) {
    sheet.getRange(1, lastCol + 1).setValue(colName);
  }
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

/* ============================================================
   doGet — public reads (getTest, check) + taker reads
   (listTestsForMe, getMyResult) + admin reads (listTests,
   getTestForEdit, getSettings, listTakers), gated by token.
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
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ============================================================
   doPost — three shapes land here:
   1. Taker login: { action: 'takerLogin', id, password } — public,
      returns a signed session token on success.
   2. Admin actions: JSON body with an "action" field
      (saveTest / deleteTest / saveSettings / saveTaker /
      deleteTaker), always ADMIN_TOKEN-gated.
   3. Results submissions: JSON body with NO "action" field —
      this is exactly what quiz-engine.html sends.
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

    // No 'action' field => this is a results submission from quiz-engine.html
    recordResult_(body);
    return json_({ ok: true });

  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ============================================================
   Security helpers — password hashing + signed session tokens
   ============================================================
   Passwords: salted SHA-256. Each taker has a random per-user
   salt, so identical passwords produce different hashes and the
   sheet never contains anything reversible.

   Session tokens: "<base64(takerId|expiryMs)>.<hmac>". The HMAC
   is signed with SESSION_SECRET, so the browser can hold the
   token but cannot forge one for another taker or extend its
   expiry. Tokens are stateless — nothing is stored server-side.
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
  const data = sheet_('Takers').getDataRange().getValues();
  return { headers: data[0], rows: data.slice(1) };
}
// Case-insensitive lookup by takerId. Returns a plain object incl. hash/salt.
function findTaker_(takerId) {
  if (!takerId) return null;
  const { headers, rows } = takersData_();
  const idCol = headers.indexOf('takerId');
  const wanted = String(takerId).trim().toLowerCase();
  const row = rows.find(r => String(r[idCol]).trim().toLowerCase() === wanted);
  if (!row) return null;
  const get = (c) => row[headers.indexOf(c)];
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
  const { headers, rows } = takersData_();
  const get = (r, c) => r[headers.indexOf(c)];
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
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('takerId');
  const rowIndex = data.findIndex((r, i) => i > 0 && String(r[idCol]).trim().toLowerCase() === takerId.toLowerCase());
  const existing = rowIndex > 0 ? data[rowIndex] : null;

  let passwordHash = existing ? existing[headers.indexOf('passwordHash')] : '';
  let salt = existing ? existing[headers.indexOf('salt')] : '';
  if (taker.password && String(taker.password).length > 0) {
    salt = makeSalt_();
    passwordHash = hashPassword_(String(taker.password), salt);
  }

  const rowValues = [
    takerId,
    taker.name || '',
    taker.email || '',
    passwordHash || '',
    salt || '',
    taker.groups || ''
  ];

  if (!existing) {
    sheet.appendRow(rowValues);
  } else {
    sheet.getRange(rowIndex + 1, 1, 1, rowValues.length).setValues([rowValues]);
  }
  return { ok: true, takerId: takerId };
}
function deleteTaker_(takerId) {
  const sheet = sheet_('Takers');
  const data = sheet.getDataRange().getValues();
  const idCol = data[0].indexOf('takerId');
  const wanted = String(takerId).trim().toLowerCase();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]).trim().toLowerCase() === wanted) sheet.deleteRow(i + 1);
  }
}
// Verify credentials and hand back a session token. The error message is
// deliberately identical for "no such id" and "wrong password" so the
// endpoint doesn't reveal which IDs exist.
function takerLogin_(id, password) {
  const taker = findTaker_(id);
  const bad = { ok: false, error: 'Invalid ID or password.' };
  if (!taker || !taker.passwordHash) return bad;
  if (hashPassword_(String(password || ''), taker.salt) !== taker.passwordHash) return bad;
  return { ok: true, token: makeSessionToken_(taker.takerId), takerId: taker.takerId, name: taker.name };
}

// Resolve a login token to the taker's identity — used by quiz-engine.html
// to pre-fill and lock the name/email when a test is launched from the
// homepage. Never returns the password hash.
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

  const data = sheet_('Tests').getDataRange().getValues();
  if (data.length < 2) return { ok: true, name: taker.name, tests: [] };
  const headers = data[0];
  const get = (r, c) => r[headers.indexOf(c)];

  const submissions = submissionMapForTaker_(takerId);

  const tests = data.slice(1)
    .filter(r => String(get(r, 'testCode')).trim() !== '')
    .filter(r => testAssignedToTaker_(get(r, 'assignedTo'), taker))
    .map(r => {
      const testCode = get(r, 'testCode');
      const startDate = formatSheetDate_(get(r, 'startDate'));
      const deadline = formatSheetDate_(get(r, 'deadline'));
      const sub = submissions[testCode];
      return {
        testCode,
        title: get(r, 'title'),
        intro: get(r, 'intro'),
        timeLimitMinutes: Number(get(r, 'timeLimitMinutes')) || 0,
        startDate,
        deadline,
        status: statusFor_(startDate, deadline, !!sub),
        score: sub ? { earned: sub.earned, possible: sub.possible } : null,
        submittedAt: sub ? sub.submittedAt : null
      };
    });

  return { ok: true, name: taker.name, takerId: taker.takerId, tests };
}
// Full result payload for one of the taker's own completed tests.
function getMyResult_(token, testCode) {
  const takerId = verifySessionToken_(token);
  if (!takerId) return { ok: false, error: 'unauthorized' };
  if (!testCode) return { ok: false, error: 'missing_testCode' };

  const data = sheet_('Results').getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('takerId');
  const codeCol = headers.indexOf('testCode');
  const payloadCol = headers.indexOf('payloadJson');
  const wanted = String(takerId).trim().toLowerCase();

  // Most recent matching submission wins (scan bottom-up).
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]).trim().toLowerCase() === wanted && data[i][codeCol] === testCode) {
      try {
        return { ok: true, result: JSON.parse(data[i][payloadCol]) };
      } catch (err) {
        return { ok: false, error: 'corrupt_result' };
      }
    }
  }
  return { ok: false, error: 'not_found' };
}
// testCode -> {earned, possible, submittedAt} for a taker's submissions.
function submissionMapForTaker_(takerId) {
  const data = sheet_('Results').getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0];
  const idCol = headers.indexOf('takerId');
  const codeCol = headers.indexOf('testCode');
  const earnedCol = headers.indexOf('earned');
  const possibleCol = headers.indexOf('possible');
  const tsCol = headers.indexOf('timestamp');
  const wanted = String(takerId).trim().toLowerCase();
  const out = {};
  data.slice(1).forEach(r => {
    if (String(r[idCol]).trim().toLowerCase() === wanted) {
      out[r[codeCol]] = {
        earned: r[earnedCol],
        possible: r[possibleCol],
        submittedAt: r[tsCol] instanceof Date ? r[tsCol].toISOString() : String(r[tsCol])
      };
    }
  });
  return out;
}

/* ============================================================
   Tests / Questions
   ============================================================ */
function getTest_(testCode) {
  if (!testCode) return { ok: false, error: 'missing_testCode' };
  const testsData = sheet_('Tests').getDataRange().getValues();
  const headers = testsData[0];
  const row = testsData.slice(1).find(r => r[headers.indexOf('testCode')] === testCode);
  if (!row) return { ok: false, error: 'not_found' };

  const get = (col) => row[headers.indexOf(col)];
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

  const qData = sheet_('Questions').getDataRange().getValues();
  const qHeaders = qData[0];
  const qRows = qData.slice(1)
    .filter(r => r[qHeaders.indexOf('testCode')] === testCode)
    .sort((a, b) => Number(a[qHeaders.indexOf('qOrder')]) - Number(b[qHeaders.indexOf('qOrder')]));

  const qGet = (r, col) => r[qHeaders.indexOf(col)];
  test.questions = qRows.map(r => {
    const type = qGet(r, 'type');
    const points = Number(qGet(r, 'points'));
    const explanation = qGet(r, 'explanation') || undefined;
    if (type === 'mc') {
      const options = [qGet(r,'optionA'), qGet(r,'optionB'), qGet(r,'optionC'), qGet(r,'optionD')].filter(v => v !== '' && v !== null && v !== undefined);
      return { type: 'mc', prompt: qGet(r, 'prompt'), points, options, correctIndex: Number(qGet(r, 'correctIndex')), explanation };
    }
    return { type: 'short', prompt: qGet(r, 'prompt'), points, answer: qGet(r, 'referenceAnswer') || undefined, explanation };
  });

  const settings = getSettings_();
  test.siteName = settings.siteName || '';
  test.siteTagline = settings.siteTagline || '';

  return test;
}

function formatSheetDate_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    // Sheets stores this as a real Date object — convert back to the
    // "YYYY-MM-DDTHH:MM:SS" string format the engine expects.
    const pad = n => String(n).padStart(2, '0');
    return val.getFullYear() + '-' + pad(val.getMonth()+1) + '-' + pad(val.getDate())
      + 'T' + pad(val.getHours()) + ':' + pad(val.getMinutes()) + ':' + pad(val.getSeconds());
  }
  return String(val);
}

function listTests_() {
  const data = sheet_('Tests').getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const qData = sheet_('Questions').getDataRange().getValues();
  const qHeaders = qData[0];
  return data.slice(1).map(row => {
    const get = (col) => row[headers.indexOf(col)];
    const testCode = get('testCode');
    const qCount = qData.slice(1).filter(r => r[qHeaders.indexOf('testCode')] === testCode).length;
    return {
      testCode,
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

function saveTest_(test) {
  if (!test || !test.testCode) throw new Error('test.testCode is required');
  const testsSheet = sheet_('Tests');
  const data = testsSheet.getDataRange().getValues();
  const headers = data[0];
  const codeCol = headers.indexOf('testCode');
  let rowIndex = data.findIndex((r, i) => i > 0 && r[codeCol] === test.testCode);

  const rowValues = [
    test.testCode,
    test.title || '',
    test.intro || '',
    test.timeLimitMinutes || 0,
    test.startDate || '',
    test.deadline || '',
    !!test.shuffleQuestions,
    !!test.shuffleOptions,
    new Date(),
    test.assignedTo || ''
  ];

  if (rowIndex === -1) {
    testsSheet.appendRow(rowValues);
  } else {
    testsSheet.getRange(rowIndex + 1, 1, 1, rowValues.length).setValues([rowValues]);
  }

  // Replace all questions for this test — simplest correct approach:
  // delete existing rows for this testCode, then append fresh ones
  // in the order given.
  const qSheet = sheet_('Questions');
  const qData = qSheet.getDataRange().getValues();
  const qHeaders = qData[0];
  const qCodeCol = qHeaders.indexOf('testCode');
  // Delete bottom-up so row indices don't shift under us
  for (let i = qData.length - 1; i >= 1; i--) {
    if (qData[i][qCodeCol] === test.testCode) qSheet.deleteRow(i + 1);
  }

  (test.questions || []).forEach((q, i) => {
    const options = q.type === 'mc' ? (q.options || []) : [];
    qSheet.appendRow([
      test.testCode,
      i,
      q.type,
      q.prompt || '',
      options[0] || '',
      options[1] || '',
      options[2] || '',
      options[3] || '',
      q.type === 'mc' ? q.correctIndex : '',
      q.points || 0,
      q.explanation || '',
      q.type === 'short' ? (q.answer || '') : ''
    ]);
  });
}

function deleteTest_(testCode) {
  const testsSheet = sheet_('Tests');
  const data = testsSheet.getDataRange().getValues();
  const codeCol = data[0].indexOf('testCode');
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][codeCol] === testCode) testsSheet.deleteRow(i + 1);
  }
  const qSheet = sheet_('Questions');
  const qData = qSheet.getDataRange().getValues();
  const qCodeCol = qData[0].indexOf('testCode');
  for (let i = qData.length - 1; i >= 1; i--) {
    if (qData[i][qCodeCol] === testCode) qSheet.deleteRow(i + 1);
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
   Results (unchanged in spirit from the old backend — this is
   what quiz-engine.html's sendToBackend() posts). Now also
   records takerId so the taker homepage can find a person's
   own past results reliably.
   ============================================================ */
function hasSubmitted_(email, testCode) {
  if (!email || !testCode) return false;
  const data = sheet_('Results').getDataRange().getValues();
  const headers = data[0];
  const emailCol = headers.indexOf('takerEmail');
  const codeCol = headers.indexOf('testCode');
  return data.slice(1).some(r =>
    String(r[emailCol]).toLowerCase() === String(email).toLowerCase() && r[codeCol] === testCode
  );
}
function recordResult_(payload) {
  const sheet = sheet_('Results');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  // Build the row by header name so column order/additions never misalign.
  const values = {
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
    payloadJson: JSON.stringify(payload)
  };
  const row = headers.map(h => (h in values ? values[h] : ''));
  sheet.appendRow(row);
}
