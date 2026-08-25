/**
 * Runs the real Apps Script modules against a simulated CRM, so the output
 * can be seen before the automation is pointed at a live spreadsheet.
 *
 * Nothing here is a mock of the automation itself — Mirror.gs, Config.gs and
 * the rest are loaded and executed as written. Only the Apps Script platform
 * (Sheets, UrlFetchApp, Utilities) and the CRM behind it are stubbed.
 *
 * Usage:  node scripts/simulate.js [outfile.json]
 */

const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const MODULES = ['Config', 'Statuses', 'Log', 'Sheets', 'Surense', 'Notify',
  'Main', 'Mirror', 'Diff', 'Diagnose', 'Triggers'];

// --------------------------------------------------------------- fake clock
const RealDate = Date;
let simNow = null;

class SimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && simNow !== null) {
      super(simNow);
    } else {
      super(...args);
    }
  }

  static now() {
    return simNow !== null ? simNow : RealDate.now();
  }
}

// ----------------------------------------------------------- Sheets stubs
class FakeSheet {
  constructor(name, data, gid) {
    this.name = name;
    this.data = data;
    this.gid = gid ?? Math.floor(Math.random() * 1e6);
    this._maxRows = 1000;
    this._maxCols = 26;
    this.hiddenColumn = null;
  }

  getName() { return this.name; }
  getSheetId() { return this.gid; }
  getMaxRows() { return this._maxRows; }
  getMaxColumns() { return this._maxCols; }
  insertRowsAfter(_a, n) { this._maxRows += n; }
  insertColumnsAfter(_a, n) { this._maxCols += n; }
  clearContents() { this.data = []; }
  clear() { this.data = []; }
  setFrozenRows() {}
  hideSheet() {}
  hideColumns(c) { this.hiddenColumn = c; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
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

const sheets = { 'לידים': new FakeSheet('לידים', [], 737522327) };

// ------------------------------------------------------------- the fake CRM
const FIELDS = [
  { key: 'leadNumber', label: 'מספר ליד' },
  { key: 'id', label: 'מזהה' },
  { key: 'name', label: 'שם הלקוח' },
  { key: 'phone', label: 'טלפון' },
  { key: 'statusName', label: 'סטטוס' },
  { key: 'sourceName', label: 'מקור מפנה' },
  { key: 'agentName', label: 'סוכן מטפל' },
  { key: 'statusDate', label: 'תאריך סטטוס' },
  { key: 'createdAt', label: 'תאריך יצירה' }
];

const NAMES = ['דנה כהן', 'אבי לוי', 'מיכל בר-און', 'יוסי מזרחי', 'רות אברהם',
  'עומר שפירא', 'נועה פרידמן', 'איתי גולן', 'שירה דהן', 'רון ביטון',
  'תמר נחום', 'גיא אלמוג', 'ליאת סבג', 'אורי חזן', 'הדס פלד'];

const SOURCES = ['מטאור - אריאל יואב דביר', 'קמפיין', 'חבר מביא חבר',
  'לקוח עבר', 'מזדמן', 'סוכנות הראל - דוד מלכה'];

const AGENTS = ['שי נגר', 'רונית כהן', 'אלון מור'];

const STATUSES = ['חדש', 'לא ענה', 'לא עונה 2', 'לא עונה 3', 'לא עונה זמן רב',
  'מתלבט לגבי העמלה', 'לחזור במועד אחר', 'ממתין לת.ז', 'רלוונטי ל2026',
  'בחתימה', 'הוגש'];

/** Deterministic pseudo-random, so the demo is reproducible. */
let seed = 20260825;
const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;

function makeLead(i) {
  return {
    id: 'ld_' + String(4000 + i),
    leadNumber: String(8800 + i),
    name: NAMES[i % NAMES.length],
    phone: '05' + String(20000000 + i * 137).slice(0, 8),
    // Nested, the way a CRM usually sends a lookup value.
    statusName: { id: 'st_' + (i % STATUSES.length), name: STATUSES[i % STATUSES.length] },
    sourceName: SOURCES[i % SOURCES.length],
    agentName: AGENTS[i % AGENTS.length],
    statusDate: '2026-08-2' + (i % 5) + 'T09:14:00Z',
    createdAt: '2026-07-' + String(10 + (i % 19)).padStart(2, '0') + 'T11:00:00Z'
  };
}

let crmLeads = Array.from({ length: 18 }, (_, i) => makeLead(i + 1));

const json = o => ({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify(o)
});

function crmFetch(url, options) {
  if (/oauth/.test(url)) {
    return json({ access_token: 'sim.token', expires_in: 3600 });
  }

  if (/\/leads\/fields/.test(url)) {
    return json({ fields: FIELDS });
  }

  if (/\/leads\/search/.test(url)) {
    const body = JSON.parse(options.payload);
    return json({
      rows: crmLeads.slice(body.startRow, body.endRow),
      hasNextPage: body.endRow < crmLeads.length
    });
  }

  throw new Error('unexpected url: ' + url);
}

// ------------------------------------------------------------- the sandbox
function formatDate(date, tz, pattern) {
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

const runLog = [];

const sandbox = {
  Date: SimDate,
  console: {
    log: m => runLog.push(String(m)),
    warn: m => runLog.push('WARN ' + m),
    error: m => runLog.push('ERROR ' + m)
  },
  Utilities: {
    formatDate,
    DigestAlgorithm: { MD5: 'MD5' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_a, text) =>
      Array.from(crypto.createHash('md5').update(text, 'utf8').digest())
        .map(b => (b > 127 ? b - 256 : b)),
    base64DecodeWebSafe: t => Buffer.from(t, 'base64url'),
    newBlob: b => ({ getDataAsString: () => Buffer.from(b).toString('utf8') })
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => ({ SURENSE_CLIENT_ID: 'cid', SURENSE_CLIENT_SECRET: 'x' }[k] ?? null),
      setProperty: () => {},
      deleteProperty: () => {}
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
  MailApp: { sendEmail: () => {} },
  UrlFetchApp: { fetch: crmFetch }
};

vm.createContext(sandbox);

for (const name of MODULES) {
  vm.runInContext(
    fs.readFileSync(`${__dirname}/../apps-script/${name}.gs`, 'utf8'),
    sandbox, { filename: name });
}

// ------------------------------------------------------------- the schedule
const cycles = [];

function tick(label, at, mutate) {
  if (mutate) mutate();
  simNow = new RealDate(at).getTime();

  const stats = vm.runInContext('syncLeads()', sandbox);

  cycles.push({
    label,
    at: formatDate(new RealDate(at), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm:ss'),
    stats
  });

  console.log(`${label.padEnd(34)} ${JSON.stringify(stats)}`);
}

console.log('Running the real Mirror.gs against a simulated CRM\n');

tick('08:00  first run (baseline)', '2026-08-25T05:00:00Z');

tick('09:00  three statuses moved', '2026-08-25T06:00:00Z', () => {
  crmLeads[2].statusName = { id: 'st_x', name: 'לא עונה 2' };
  crmLeads[5].statusName = { id: 'st_y', name: 'ממתין לת.ז' };
  crmLeads[9].agentName = 'אלון מור';
});

tick('10:00  two leads joined', '2026-08-25T07:00:00Z', () => {
  crmLeads.push(makeLead(19), makeLead(20));
});

tick('11:00  nothing happened', '2026-08-25T08:00:00Z');

tick('12:00  a lead left the CRM', '2026-08-25T09:00:00Z', () => {
  crmLeads.splice(4, 1);
});

// ------------------------------------------------------------------ output
const out = {
  cycles,
  leads: sheets['לידים'].data,
  changes: (sheets['שינויים'] || { data: [] }).data,
  log: (sheets['יומן'] || { data: [] }).data,
  hiddenColumn: sheets['לידים'].hiddenColumn
};

const target = process.argv[2] || `${__dirname}/../simulation.json`;
fs.writeFileSync(target, JSON.stringify(out, null, 2));

console.log(`\nleads tab   : ${out.leads.length - 1} rows x ${out.leads[0].length} cols`);
console.log(`changes tab : ${Math.max(0, out.changes.length - 1)} rows`);
console.log(`written to  : ${target}`);
