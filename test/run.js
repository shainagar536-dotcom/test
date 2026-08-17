/* Apps Script stubs so the real logic can be exercised locally. */
const fs = require('fs');
const vm = require('vm');

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
  constructor(name, data) { this.name = name; this.data = data; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {} hideSheet() {}
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
  'יומן': new FakeSheet('יומן', [['תאריך', 'רמה', 'הודעה', 'פירוט']])
};

const props = { SURENSE_CLIENT_ID: 'cid', SURENSE_CLIENT_SECRET: 'shh' };
const sent = [];
let fetchImpl = () => { throw new Error('no fetch stub'); };

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  Utilities: { formatDate: fmt },
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
  : ['Config', 'Statuses', 'Log', 'Sheets', 'Surense', 'Notify', 'Main', 'Triggers']
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
