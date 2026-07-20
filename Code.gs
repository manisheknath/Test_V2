/* ============================================================
   Code.gs — Quiz Platform Backend
   ============================================================
   Replaces the older per-test backend. This is now the single
   source of truth for every test: test metadata, questions,
   site-wide settings, and submitted results all live in ONE
   Google Sheet, edited only through the Admin page (admin.html)
   — never by hand.

   ---------------------------------------------------------
   ONE-TIME SETUP
   ---------------------------------------------------------
   1. Create a new Google Sheet. Copy its ID from the URL
      (the long string between /d/ and /edit).
   2. Extensions → Apps Script. Delete any starter code and
      paste this whole file in.
   3. Go to Project Settings (gear icon) → Script Properties →
      add two properties:
         SPREADSHEET_ID   = <the ID you copied>
         ADMIN_TOKEN      = <make up a long random password>
      The ADMIN_TOKEN is what protects the Admin page — anyone
      who has it can create/edit/delete tests, so keep it like
      a password. You'll paste this same value into admin.html.
   4. Run the `setup` function once (select it in the dropdown
      next to Run, click Run). It creates the Tests, Questions,
      Results, and Settings tabs with the right headers. The
      first run will ask you to authorize the script — that's
      expected, click through it.
   5. Deploy → New deployment → type: Web app.
         Execute as: Me
         Who has access: Anyone
      Deploy, then copy the /exec URL. Paste that URL into
      BOTH admin.html and quiz-engine.html (ENGINE_CONFIG).
   6. Any time you edit this file afterwards: Deploy → Manage
      deployments → pencil icon → New version → Deploy. Saving
      alone does NOT update the live URL.
   ============================================================ */

function setup() {
  const ss = SpreadsheetApp.openById(getProp_('SPREADSHEET_ID'));

  const tests = getOrCreateSheet_(ss, 'Tests');
  setHeaderIfEmpty_(tests, ['testCode','title','intro','timeLimitMinutes','startDate','deadline','shuffleQuestions','shuffleOptions','updatedAt']);
  // Force these two columns to stay plain TEXT — otherwise Sheets can
  // silently reinterpret "2026-08-01T09:00:00" as a real Date cell in
  // the spreadsheet's timezone, which can then read back shifted if
  // the script's execution timezone differs. Keeping them as text
  // means what you wrote is exactly what you get back, always.
  tests.getRange('E2:F10000').setNumberFormat('@');

  const questions = getOrCreateSheet_(ss, 'Questions');
  setHeaderIfEmpty_(questions, ['testCode','qOrder','type','prompt','optionA','optionB','optionC','optionD','correctIndex','points','explanation','referenceAnswer']);

  const results = getOrCreateSheet_(ss, 'Results');
  setHeaderIfEmpty_(results, ['timestamp','testCode','testTitle','takerName','takerEmail','earned','possible','autoSubmitted','fullscreenExitCount','tabSwitchCount','payloadJson']);

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
   doGet — public reads (getTest, check) + admin reads (listTests,
   getTestForEdit, getSettings), gated by token.
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
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ============================================================
   doPost — two shapes land here:
   1. Admin actions: JSON body with an "action" field
      (saveTest / deleteTest / saveSettings), always token-gated.
   2. Results submissions: JSON body with NO "action" field —
      this is exactly what quiz-engine.html already sends
      (unchanged from before), so old and new engines both work.
   ============================================================ */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

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

    // No 'action' field => this is a results submission from quiz-engine.html
    recordResult_(body);
    return json_({ ok: true });

  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
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
    new Date()
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
   what quiz-engine.html's sendToBackend() already posts)
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
  sheet.appendRow([
    new Date(),
    payload.testCode || '',
    payload.testTitle || '',
    payload.takerName || '',
    payload.takerEmail || '',
    payload.score ? payload.score.earned : '',
    payload.score ? payload.score.possible : '',
    !!payload.autoSubmittedOnTimeout,
    payload.fullscreenExitCount || 0,
    payload.tabSwitchCount || 0,
    JSON.stringify(payload)
  ]);
}
