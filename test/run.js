/* Apps Script stubs so the real logic can be exercised locally. */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

function fmt(date, tz, pattern) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const isoDay = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  const hh = p.hour === '24' ? '00' : p.hour;
  if (pattern === 'u') return String(isoDay);
  if (pattern === 'H') return String(Number(hh));
  if (pattern === 'EEE HH:mm') return `${p.weekday} ${hh}:${p.minute}`;
  if (pattern === 'yyyy-MM-dd HH:mm:ss') return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}Z`;
}

class FakeSheet {
  constructor(name, data, gid) {
    this.name = name; this.data = data; this.gid = gid ?? 0;
    this._maxRows = 1000; this._maxCols = 26;
  }
  getName() { return this.name; }
  getSheetId() { return this.gid; }
  getMaxRows() { return this._maxRows; }
  getMaxColumns() { return this._maxCols; }
  insertRowsAfter(_a, n) { this._maxRows += n; }
  insertColumnsAfter(_a, n) { this._maxCols += n; }
  clearContents() { this.data = []; }
  clear() { this.data = []; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {} hideSheet() {} hideColumns(c) { this.hidden = c; }
  appendRow(row) { this.data.push(row.slice()); }
  deleteRows(start, n) { this.data.splice(start - 1, n); }
  getRange(r, c, nr = 1, nc = 1) {
    const s = this;
    const win = () => Array.from({ length: nr }, (_, i) => {
      const row = s.data[r - 1 + i] || [];
      return Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '');
    });
    return {
      getValues: win,
      getDisplayValues: () => win().map(rw => rw.map(v => String(v ?? ''))),
      setValue: v => { (s.data[r - 1] ||= [])[c - 1] = v; },
      setValues: vals => vals.forEach((rw, i) => rw.forEach((v, j) => {
        (s.data[r - 1 + i] ||= [])[c - 1 + j] = v;
      }))
    };
  }
}

const sheets = {
  'מיפוי': new FakeSheet('מיפוי', [
    ['מקור', 'מייל', 'וואטספ', 'פעיל'],
    ['מטאור - אריאל יואב דביר', 'ariel@example.com', '', 'כן'],
    ['  מטאור   שני  ', 'shani@example.com', '', ''],          // messy spacing
    ['סוכן מושתק', 'muted@example.com', '', 'לא'],
    ['בלי מייל', '', '+97250', 'כן']
  ]),
  'מצב': new FakeSheet('מצב', [['מספר ליד', 'סטטוס אחרון שדווח', 'תאריך דיווח']]),
  'יומן': new FakeSheet('יומן', [['תאריך', 'רמה', 'הודעה', 'פירוט']]),
  'לידים': new FakeSheet('לידים', [], 737522327)
};

const props = { SURENSE_CLIENT_ID: 'cid', SURENSE_CLIENT_SECRET: 'shh' };
const sent = [];
let fetchImpl = () => { throw new Error('no fetch stub'); };

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  Utilities: {
    formatDate: fmt,
    DigestAlgorithm: { MD5: 'MD5' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_a, text) =>
      Array.from(crypto.createHash('md5').update(text, 'utf8').digest())
        .map(b => (b > 127 ? b - 256 : b))
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => props[k] ?? null,
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: k => { delete props[k]; }
    })
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  SpreadsheetApp: {
    openById: () => ({
      getSheets: () => Object.values(sheets),
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = new FakeSheet(n, []))
    })
  },
  MailApp: { sendEmail: o => sent.push(o) },
  UrlFetchApp: { fetch: (...a) => fetchImpl(...a) }
};
vm.createContext(sandbox);

// `--bundle` runs the same suite against dist/Code.gs, which is what actually
// gets pasted into the Apps Script editor — so a bad concatenation order or a
// stale bundle fails the build rather than reaching the editor.
const sources = process.argv.includes('--bundle')
  ? [__dirname + '/../dist/Code.gs']
  : ['Config', 'Statuses', 'Log', 'Sheets', 'Surense', 'Notify', 'Main',
     'Mirror', 'Diff', 'Triggers']
      .map(f => `${__dirname}/../apps-script/${f}.gs`);

for (const file of sources) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

const run = src => vm.runInContext(src, sandbox);
let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n        got=${JSON.stringify(got)}\n       want=${JSON.stringify(want)}`));
};
sandbox.D = d => new Date(d);

// ---------------------------------------------------------------- schedule
check('Saturday skipped', run('isWithinSchedule_(D("2026-08-15T09:00:00+03:00"))'), false);
check('Sunday runs',      run('isWithinSchedule_(D("2026-08-16T09:00:00+03:00"))'), true);
check('Friday runs',      run('isWithinSchedule_(D("2026-08-21T09:00:00+03:00"))'), true);
// 21:30Z Fri = 00:30 Sat in Jerusalem: the timezone, not UTC, decides the day.
check('tz decides the day', run('isWithinSchedule_(D("2026-08-14T21:30:00Z"))'), false);

// the configured working window is 08:00-20:00 local, inclusive at both ends
check('07:00 is before the window',
  run('isWithinSchedule_(D("2026-08-16T07:00:00+03:00"))'), false);
check('08:00 opens the window',
  run('isWithinSchedule_(D("2026-08-16T08:00:00+03:00"))'), true);
check('20:00 is still inside',
  run('isWithinSchedule_(D("2026-08-16T20:30:00+03:00"))'), true);
check('21:00 is past the window',
  run('isWithinSchedule_(D("2026-08-16T21:00:00+03:00"))'), false);
// the window is read in CONFIG.timezone, not UTC: 06:00Z is 09:00 local
check('window is evaluated in the local timezone',
  run('isWithinSchedule_(D("2026-08-16T06:00:00Z"))'), true);

// ------------------------------------------------------------- status table
check('mapped status returns wording',
  run('messageForStatus_("לא עונה 2")'), 'ניסינו ליצור קשר עם הלקוח אין מענה 2');
check('"חדש" sends nothing', run('messageForStatus_("חדש")'), null);
check('"רלוונטי ל2025" sends nothing', run('messageForStatus_("רלוונטי ל2025")'), null);
check('undefined status sends nothing', run('messageForStatus_("בחתימה")'), null);
check('unknown status sends nothing', run('messageForStatus_("משהו חדש לגמרי")'), null);
check('status matched despite spacing', run('messageForStatus_("  לא   ענה ")'),
  'ניסינו ליצור קשר עם הלקוח אין מענה 1');

// ------------------------------------------------------------- source lookup
const mapping = run('loadSourceMapping_()');
check('mapping loaded', Object.keys(mapping).length, 4);
check('messy spacing normalized',
  run('loadSourceMapping_()[normalizeText_("מטאור שני")].email'), 'shani@example.com');
check('blank "פעיל" counts as active',
  run('loadSourceMapping_()[normalizeText_("מטאור שני")].active'), true);
check('"לא" mutes a source',
  run('loadSourceMapping_()[normalizeText_("סוכן מושתק")].active'), false);

// ------------------------------------------------------------------- queue
const lead = (id, status, source) => ({
  id, displayId: 'L' + id, clientName: 'לקוח ' + id,
  statusName: status, statusDate: '2026-08-17T10:00:00Z', sourceName: source
});
sandbox.leads = [
  lead('1', 'לא ענה', 'מטאור - אריאל יואב דביר'),   // send
  lead('2', 'חדש', 'מטאור - אריאל יואב דביר'),      // never-send status
  lead('3', 'בחתימה', 'מטאור - אריאל יואב דביר'),   // undefined status
  lead('4', 'לא ענה', 'קמפיין'),                     // category, not a person
  lead('5', 'לא ענה', 'סוכן מושתק'),                 // muted
  lead('6', 'לא ענה', 'בלי מייל'),                   // no address
  lead('7', 'לא עונה 3', '  מטאור   שני  ')          // send, messy source name
];
sandbox.stats = { scanned: 0, sent: 0, skipped: 0, pending: 0, errors: 0 };
let queue = run('buildQueue_(leads, loadSourceMapping_(), {}, stats)');
check('only allowlisted+contactable queued',
  queue.map(q => q.lead.id), ['1', '7']);
check('non-sending statuses skipped', sandbox.stats.skipped, 2);
check('unreachable sources counted as pending', sandbox.stats.pending, 3);
check('wording attached to queue item', queue[1].message,
  'ניסינו ליצור קשר עם הלקוח אין מענה 3');

// dedupe: a lead already reported at this status is not re-sent
sandbox.stats = { scanned: 0, sent: 0, skipped: 0, pending: 0, errors: 0 };
queue = run('buildQueue_(leads, loadSourceMapping_(), {"1": "לא ענה"}, stats)');
check('already-reported status skipped', queue.map(q => q.lead.id), ['7']);
// ...but a *new* status on the same lead does send
sandbox.stats = { scanned: 0, sent: 0, skipped: 0, pending: 0, errors: 0 };
queue = run('buildQueue_(leads, loadSourceMapping_(), {"1": "לא עונה 2"}, stats)');
check('new status on same lead sends', queue.map(q => q.lead.id), ['1', '7']);

// --------------------------------------------------------------- state table
run('recordReportedStatus_("1", "לא ענה")');
check('state row written', run('loadReportedStatuses_()["1"]'), 'לא ענה');
run('recordReportedStatus_("1", "לא עונה 2")');
check('state row updated in place', run('loadReportedStatuses_()["1"]'), 'לא עונה 2');
check('state not duplicated', sheets['מצב'].data.length, 2);

// ------------------------------------------------------------------- email
const mail = run(`composeNotification_(
  {displayId:'L9', clientName:'ישראל ישראלי'},
  {source:'אריאל'}, 'ניסינו ליצור קשר עם הלקוח אין מענה 1')`);
check('subject', mail.subject, 'עדכון סטטוס ליד — ישראל ישראלי');
check('body carries name, id and wording',
  /ישראל ישראלי/.test(mail.body) && /L9/.test(mail.body) &&
  /אין מענה 1/.test(mail.body), true);

// ------------------------------------------------------- pagination + brake
const makeLeads = (n, from) => Array.from({ length: n }, (_, i) => ({
  id: String(from + i), leadNumber: 'L' + (from + i), name: 'c' + i,
  statusName: 'לא ענה', statusDate: '2026-08-17T10:00:00Z',
  sourceName: 'מטאור - אריאל יואב דביר'
}));
let pages = 0;
fetchImpl = (url) => {
  if (/oauth/.test(url)) return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ access_token: 't', expires_in: 3600 })
  };
  const page = pages++;
  const rows = page === 0 ? makeLeads(50, 0) : makeLeads(10, 50);
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ rows, hasNextPage: page === 0 })
  };
};
check('pagination follows hasNextPage',
  run('fetchLeadsChangedSince_(new Date(0)).length'), 60);

props.LAST_RUN_AT = '2026-08-17T09:00:00Z';
pages = 0;
sent.length = 0;
run('CONFIG.dryRun = false; CONFIG.operatorEmail = "ops@example.com"');
run('runAutomation_({trigger:"test"})');
check('flood brake blocks the mail-out', sent.filter(m => m.to !== 'ops@example.com').length, 0);
check('flood brake alerts the operator once',
  sent.filter(m => m.to === 'ops@example.com').length, 1);
check('watermark held for manual review', props.LAST_RUN_AT, '2026-08-17T09:00:00Z');

// under the limit, sending proceeds
pages = 0;
sent.length = 0;
fetchImpl = (url) => /oauth/.test(url)
  ? { getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ access_token: 't', expires_in: 3600 }) }
  : { getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ rows: makeLeads(3, 900), hasNextPage: false }) };
run('runAutomation_({trigger:"test"})');
check('under the limit, mail goes out', sent.length, 3);
check('recipient is the referring source', sent[0].to, 'ariel@example.com');
check('watermark advanced', props.LAST_RUN_AT !== '2026-08-17T09:00:00Z', true);
check('sends recorded for dedupe', run('loadReportedStatuses_()["900"]'), 'לא ענה');

// a re-run of the same window sends nothing
pages = 0;
sent.length = 0;
run('runAutomation_({trigger:"test"})');
check('re-run does not re-send', sent.length, 0);

// dry run sends nothing at all
sent.length = 0;
run('CONFIG.dryRun = true');
run('resetWatermark(); runAutomation_({trigger:"dry-run"})');
check('dry run sends nothing', sent.length, 0);

// a failing token request must not advance the watermark
props.LAST_RUN_AT = '2026-08-17T09:00:00Z';
fetchImpl = () => ({ getResponseCode: () => 401, getContentText: () => 'denied' });
try { run('runAutomation_({trigger:"test"})'); } catch (e) { /* expected */ }
check('failed run keeps the watermark', props.LAST_RUN_AT, '2026-08-17T09:00:00Z');


// ------------------------------------------------------------------ mirror
const json = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
const crmStub = (fields, rows) => (url, options) => {
  if (/oauth/.test(url)) return json({ access_token: 't', expires_in: 3600 });
  if (/\/leads\/fields/.test(url)) return json({ fields });
  if (/\/leads\/search/.test(url)) {
    const body = JSON.parse(options.payload);
    return json({
      rows: rows.slice(body.startRow, body.endRow),
      hasNextPage: body.endRow < rows.length
    });
  }
  throw new Error('unexpected url: ' + url);
};

const FIELDS = [
  { key: 'name', label: 'שם' },
  { key: 'id', label: 'מזהה' },            // deliberately not first
  { key: 'status', label: 'סטטוס' }
];
const crmLead = (id, status) => ({
  id: String(id), name: 'לקוח ' + id,
  status: { id: 's' + id, name: status || 'לא ענה' }   // nested, as CRMs send
});

const mirror = sheets['לידים'];
// column indexes in the written sheet: id, name, status, stamp, type, hash
const COL = { id: 0, name: 1, status: 2, stamp: 3, type: 4, hash: 5 };
const rowById = id => mirror.data.slice(1).find(r => String(r[COL.id]) === id);

// --- first run: a baseline, not "3000 new leads" ---
fetchImpl = crmStub(FIELDS, [crmLead(1), crmLead(2)]);
let stats = run('syncLeads()');
check('id column forced first', mirror.data[0][COL.id], 'מזהה');
check('meta columns appended',
  mirror.data[0].slice(COL.stamp), ['עודכן בגיליון', 'סוג שינוי', '_hash']);
check('nested object flattened to its name', rowById('1')[COL.status], 'לא ענה');
check('first run reports a baseline', stats.baseline, true);
check('baseline does not claim leads are new', stats.added, 0);
check('rows marked as baseline', rowById('1')[COL.type], 'בסיס');
check('hash column hidden', mirror.hidden, 6);
check('baseline writes no change-log lines',
  !sheets['שינויים'] || sheets['שינויים'].data.length <= 1, true);

// age the stamps so carry-forward is observable
mirror.data.slice(1).forEach(r => { r[COL.stamp] = '2020-01-01 00:00:00'; });

// --- second run, nothing changed ---
stats = run('syncLeads()');
check('unchanged leads counted', stats.unchanged, 2);
check('no phantom updates', stats.updated, 0);
check('unchanged row keeps its original stamp',
  rowById('1')[COL.stamp], '2020-01-01 00:00:00');

// --- one lead changes, one is added ---
fetchImpl = crmStub(FIELDS,
  [crmLead(1), crmLead(2, 'לא עונה 3'), crmLead(3)]);
stats = run('syncLeads()');
check('changed lead detected', stats.updated, 1);
check('new lead detected', stats.added, 1);
check('changed row marked', rowById('2')[COL.type], 'עודכן');
check('changed row restamped', rowById('2')[COL.stamp] !== '2020-01-01 00:00:00', true);
check('untouched row keeps its old stamp',
  rowById('1')[COL.stamp], '2020-01-01 00:00:00');
check('untouched row keeps its old label', rowById('1')[COL.type], 'בסיס');
check('new row marked', rowById('3')[COL.type], 'חדש');
check('changed value actually written', rowById('2')[COL.status], 'לא עונה 3');

// the change log records which field moved, not just that the row did
const changeRows = () => (sheets['שינויים'] || { data: [[]] }).data.slice(1);
const statusChange = changeRows().find(
  r => r[1] === '2' && r[3] === 'סטטוס');
check('change log names the column that moved', !!statusChange, true);
check('change log records the old value', statusChange[4], 'לא ענה');
check('change log records the new value', statusChange[5], 'לא עונה 3');
check('change log records the new lead',
  changeRows().some(r => r[1] === '3' && r[2] === 'חדש'), true);
check('unchanged lead produces no change-log line',
  changeRows().some(r => r[1] === '1'), false);

const beforeQuietRun = changeRows().length;
run('syncLeads()');
check('a run with no changes logs nothing', changeRows().length, beforeQuietRun);

// --- a lead disappears from the CRM ---
fetchImpl = crmStub(FIELDS, [crmLead(1), crmLead(2, 'לא עונה 3')]);
stats = run('syncLeads()');
check('missing lead counted once', stats.missing, 1);
check('its row is kept, not deleted', !!rowById('3'), true);
check('and flagged', rowById('3')[COL.type], 'לא נמצא ב-CRM');
check('its CRM values are preserved', rowById('3')[COL.name], 'לקוח 3');
check('disappearance recorded in the change log',
  changeRows().some(r => r[1] === '3' && r[2] === 'לא נמצא ב-CRM'), true);

const flaggedAt = rowById('3')[COL.stamp];
stats = run('syncLeads()');
check('an already-flagged row is not re-counted', stats.missing, 0);
check('and not restamped', rowById('3')[COL.stamp], flaggedAt);

// removeMissing drops it instead
run('CONFIG.mirror.removeMissing = true');
run('syncLeads()');
check('removeMissing deletes the row', !!rowById('3'), false);
run('CONFIG.mirror.removeMissing = false');

// --- explicit column list still honoured, id still forced first ---
run(`CONFIG.mirror.columns = [{key:'name',label:'Name'}]`);
run('syncLeads()');
check('explicit columns keep id first', mirror.data[0][0], 'id');
check('explicit columns otherwise respected', mirror.data[0][1], 'Name');
run('CONFIG.mirror.columns = []');

// --- scale: the grid is expanded past the default 1000 rows ---
const many = Array.from({ length: 1200 }, (_, i) => crmLead(i + 1));
fetchImpl = crmStub(FIELDS, many);
run('CONFIG.surense.maxPages = 40');
run('syncLeads()');
check('grid grown for a large pull', mirror.getMaxRows() >= 1201, true);
check('all 1200 leads written', mirror.data.length, 1201);

// --- the two no-write guards ---
const before = JSON.stringify(mirror.data);
run('CONFIG.surense.maxPages = 1');
check('partial read returns nothing', run('syncLeads()'), null);
check('partial read leaves the mirror untouched', JSON.stringify(mirror.data), before);
run('CONFIG.surense.maxPages = 40');

fetchImpl = crmStub(FIELDS, []);
check('empty CRM returns nothing', run('syncLeads()'), null);
check('empty CRM leaves the mirror untouched', JSON.stringify(mirror.data), before);

// a bulk CRM edit must not write tens of thousands of change-log lines
run('CONFIG.mirror.changeLogMaxPerRun = 3');
fetchImpl = crmStub(FIELDS, [crmLead(1), crmLead(2), crmLead(3), crmLead(4), crmLead(5)]);
run('syncLeads()');                       // establishes rows 1-5
fetchImpl = crmStub(FIELDS,
  [1, 2, 3, 4, 5].map(i => crmLead(i, 'סטטוס חדש')));
const beforeBulk = changeRows().length;
run('syncLeads()');
check('change log capped per run', changeRows().length - beforeBulk, 3);
run('CONFIG.mirror.changeLogMaxPerRun = 500');

// ------------------------------------------------------------- flattenValue_
check('null becomes blank', run('flattenValue_(null)'), '');
check('number stays a number', run('flattenValue_(42)'), 42);
check('object without a name falls back to JSON',
  run('flattenValue_({a:1})'), '{"a":1}');
check('array joined', run('flattenValue_(["a","b"])'), 'a, b');
check('leading = escaped so Sheets keeps it as text',
  run('flattenValue_("=SUM(A1)")'), "'=SUM(A1)");

// --------------------------------------------------------------- gap report
mirror.data = [['מזהה', 'שם'], ['1', 'א'], ['2', 'ב'], ['99', 'כבר לא ב-CRM']];
fetchImpl = crmStub(FIELDS, [crmLead(1), crmLead(2), crmLead(3), crmLead(4)]);
const diff = run('reportMissingLeads()');
check('leads absent from the sheet found', diff.missing.map(l => l.id), ['3', '4']);
check('sheet rows with no CRM match found', diff.stale, ['99']);
check('matched rows counted', diff.matched, 2);
check('report written to its own tab',
  sheets['דוח פערים'].data[0][0], 'סוג');
check('the leads tab was not modified by the report', mirror.data.length, 4);

// a column of names must not be mistaken for the id column
mirror.data = [['שם', 'הערה'], ['אבי', 'x'], ['בני', 'y']];
const noKey = run('reportMissingLeads()');
check('no id column found -> every lead reported missing', noKey.missing.length, 4);
check('nothing reported stale when no id column matched', noKey.stale, []);

// a short sheet still matches: rate, not count, decides
mirror.data = [['מזהה'], ['1'], ['2']];
const small = run('reportMissingLeads()');
check('short sheet still matches on the id column',
  small.missing.map(l => l.id), ['3', '4']);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
