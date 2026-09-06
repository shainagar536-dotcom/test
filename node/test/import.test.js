/**
 * Importing the recipients file.
 *
 * The file is a spreadsheet maintained by hand over time, so these cover what
 * such a file actually looks like: a BOM from Excel, quoted fields, blank
 * rows, duplicates, and source names that no longer match the CRM.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { parseCsv, detectColumns, buildRecipients, reconcile } from '../src/notify/import.js';
import { normalizeText } from '../src/mirror.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5 },
  messaging: {
    columns: { status: 'סטטוס', source: 'מקור מפנה', clientName: 'שם הלקוח',
      leadNumber: 'מספר ליד' },
    subject: 's', body: 'b', signature: 'sig', maxPerRun: 25, redirectAllTo: ''
  }
};

let db, server, baseUrl;

before(async () => {
  db = new Database(config.database);
  await db.migrate();
  server = createApi({ db, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { server?.close(); await db?.close(); });

beforeEach(async () => {
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, source_names, sources, cursors');

  // History is append-only; clearing it in a test has to say so.
  await db.pool.query("BEGIN; SET LOCAL app.allow_history_delete = 'on'; " +
    'DELETE FROM status_events; COMMIT;');
});

const importCsv = (csv, query = '') => fetch(`${baseUrl}/api/recipients/import${query}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.api.token}`, 'Content-Type': 'text/csv' },
  body: csv
});

const seedLead = (id, source) => db.pool.query(
  `INSERT INTO leads (id, fields, hash, changed_at, change_type)
   VALUES ($1, $2, 'h', now(), 'בסיס')`,
  [id, JSON.stringify({ 'מקור מפנה': source })]);

// ------------------------------------------------------------------ parsing
test('a quoted field containing a comma survives', () => {
  const rows = parseCsv('מקור,מייל\n"מטאור, סניף צפון",a@b.c');

  assert.equal(rows[1][0], 'מטאור, סניף צפון');
  assert.equal(rows[1][1], 'a@b.c');
});

test('an escaped quote inside a field survives', () => {
  const rows = parseCsv('מקור,מייל\n"דוד ""דודי"" כהן",a@b.c');
  assert.equal(rows[1][0], 'דוד "דודי" כהן');
});

test('a gershayim inside a word is literal, not an opening quote', () => {
  // Hebrew puts one inside ordinary words — דוא"ל, ת"ז, יו"ר. Treating it as
  // an opening quote swallows the rest of the file into a single field.
  const rows = parseCsv('שם מקור,דוא"ל\nמטאור,a@b.c');

  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], 'דוא"ל');
  assert.equal(rows[1][1], 'a@b.c');
});

test("Excel's byte order mark does not corrupt the first header", () => {
  const columns = detectColumns(parseCsv('﻿מקור,מייל\nא,a@b.c')[0]);
  assert.equal(columns.sourceName, 0);
});

test('tabs are accepted, since pasting from Excel produces them', () => {
  const rows = parseCsv('מקור\tמייל\nמטאור\ta@b.c');
  assert.equal(rows[1][1], 'a@b.c');
});

test('blank lines are dropped', () => {
  assert.equal(parseCsv('מקור,מייל\n\nא,a@b.c\n\n').length, 2);
});

// ------------------------------------------------------- column detection
test('Hebrew and English headers are both recognised', () => {
  for (const header of ['מקור,מייל', 'source,email', 'שם מקור,דוא"ל']) {
    const columns = detectColumns(parseCsv(`${header}\nא,a@b.c`)[0]);
    assert.equal(columns.sourceName, 0, header);
    assert.equal(columns.email, 1, header);
  }
});

test('column order does not matter', () => {
  const columns = detectColumns(parseCsv('פעיל,מייל,מקור\nכן,a@b.c,מטאור')[0]);

  assert.equal(columns.active, 0);
  assert.equal(columns.email, 1);
  assert.equal(columns.sourceName, 2);
});

test('an unrecognisable header row is refused, and says what it saw', () => {
  assert.throws(() => detectColumns(['עמודה א', 'עמודה ב']),
    /No source or email column was recognised[\s\S]*עמודה א/);
});

// -------------------------------------------------------------- row rules
test('a row with no address is rejected, not imported blank', () => {
  const { recipients, rejected } = buildRecipients(
    parseCsv('מקור,מייל\nמטאור,a@b.c\nקמפיין,'));

  assert.equal(recipients.length, 1);
  assert.equal(rejected[0].reason, 'no-address');
  assert.equal(rejected[0].source, 'קמפיין');
});

test('a malformed address is caught at import, not at send time', () => {
  const { rejected } = buildRecipients(
    parseCsv('מקור,מייל\nמטאור,ariel at example.com'));

  assert.equal(rejected[0].reason, 'malformed-email');
  assert.equal(rejected[0].detail, 'ariel at example.com');
});

test('a duplicate source keeps the first and reports the second', () => {
  // Common in a file edited by hand: the same source typed twice with
  // different spacing, which normalizes to one key.
  const { recipients, rejected } = buildRecipients(
    parseCsv('מקור,מייל\nמטאור,first@x.com\n  מטאור ,second@x.com'));

  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].email, 'first@x.com');
  assert.equal(rejected[0].reason, 'duplicate-source');
  assert.match(rejected[0].detail, /line 2/);
});

test('blank "פעיל" means active; only an explicit no mutes', () => {
  const { recipients } = buildRecipients(
    parseCsv('מקור,מייל,פעיל\nא,a@b.c,\nב,b@b.c,כן\nג,c@b.c,לא'));

  assert.deepEqual(recipients.map(r => r.active), [true, true, false]);
});

test('the key is the normalized source name', () => {
  const { recipients } = buildRecipients(
    parseCsv('מקור,מייל\n"  מטאור   -  אריאל  ",a@b.c'));

  assert.equal(recipients[0].sourceKey, normalizeText('מטאור - אריאל'));
  assert.equal(recipients[0].sourceName, 'מטאור   -  אריאל',
    'the original spelling is kept for display');
});

// ------------------------------------------------------------ reconciling
test('reconcile reports coverage in leads, not just in rows', () => {
  const { recipients } = buildRecipients(
    parseCsv('מקור,מייל\nמטאור,a@b.c\nמקור ישן,b@b.c'));

  const report = reconcile(recipients, [
    { source_name: 'מטאור', leads: 40 },
    { source_name: 'קמפיין', leads: 485 }
  ]);

  assert.equal(report.matchedSources, 1);
  assert.equal(report.matchedLeads, 40);
  assert.deepEqual(report.unmatchedFileRows, ['מקור ישן']);
  assert.deepEqual(report.sourcesWithoutAddress, [{ source: 'קמפיין', leads: 485 }]);
});

// -------------------------------------------------------------- the route
test('an import is a preview until it is asked to apply', async () => {
  await seedLead('a', 'מטאור');

  const preview = await (await importCsv('מקור,מייל\nמטאור,ariel@example.com')).json();

  assert.equal(preview.applied, false);
  assert.equal(preview.parsed, 1);
  assert.equal(preview.matchedSources, 1);
  assert.match(preview.note, /Nothing was written/);

  const { recipients } = await (await fetch(`${baseUrl}/api/recipients`,
    { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

  assert.equal(recipients.length, 0, 'a preview must not write');
});

test('apply=true writes the rows', async () => {
  await seedLead('a', 'מטאור');

  const result = await (await importCsv(
    'מקור,מייל\nמטאור,ariel@example.com', '?apply=true')).json();

  assert.equal(result.applied, true);
  assert.equal(result.saved, 1);

  const { recipients } = await (await fetch(`${baseUrl}/api/recipients`,
    { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].email, 'ariel@example.com');
});

test('re-importing updates rather than duplicating', async () => {
  await importCsv('מקור,מייל\nמטאור,old@example.com', '?apply=true');
  await importCsv('מקור,מייל\nמטאור,new@example.com', '?apply=true');

  const { recipients } = await (await fetch(`${baseUrl}/api/recipients`,
    { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].email, 'new@example.com');
});

test('the preview names sources that have leads but no address', async () => {
  await seedLead('a', 'קמפיין');
  await seedLead('b', 'קמפיין');
  await seedLead('c', 'מטאור');

  const preview = await (await importCsv('מקור,מייל\nמטאור,ariel@example.com')).json();

  assert.equal(preview.sourcesWithoutAddress[0].source, 'קמפיין');
  assert.equal(preview.sourcesWithoutAddress[0].leads, 2);
});

test('the preview reports which column was read as what', async () => {
  const preview = await (await importCsv('פעיל,מייל,מקור\nכן,a@b.c,מטאור')).json();

  assert.equal(preview.columnsDetected.sourceName, 2);
  assert.equal(preview.columnsDetected.email, 1);
  assert.equal(preview.columnsDetected.whatsapp, null);
});

test('an empty body is refused', async () => {
  const response = await importCsv('   ');
  assert.equal(response.status, 400);
});

test('an unrecognisable file is refused with an explanation', async () => {
  const response = await importCsv('עמודה א,עמודה ב\n1,2');

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /No source or email column/);
});

test('the import route needs a token', async () => {
  const response = await fetch(`${baseUrl}/api/recipients/import`,
    { method: 'POST', body: 'מקור,מייל\nא,a@b.c' });

  assert.equal(response.status, 401);
});
