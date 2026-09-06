/**
 * The dashboard: the mirror of the database somebody actually reads.
 *
 * The column that matters is "handled". It must agree with the sender in
 * every case — a row that says a message is queued when nothing will ever
 * send it is worse than no dashboard, because it is believed.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { formatValue, formatDate, labelFor } from '../src/dashboard/labels.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const SOURCE = 'ce934d66-7cf3-4b94-84cf-929ba7953d9f';

const COLUMNS = {
  status: 'statusName',
  source: '',
  sourceId: 'sourceId',
  clientName: 'fullName',
  leadNumber: 'number'
};

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0, 1, 2, 3, 4, 5],
    activeHours: [8], shrinkGuard: 0.5 },
  sourceCatalogPaths: [],
  messaging: {
    columns: COLUMNS,
    subject: 'עדכון — {client}',
    body: 'שלום {source}, {message}',
    signature: 'בברכה',
    maxPerRun: 25,
    redirectAllTo: ''
  }
};

// ------------------------------------------------------------ translation

test('field keys are given Hebrew labels, unknown ones stay visible', () => {
  assert.equal(labelFor('statusName'), 'סטטוס');
  assert.equal(labelFor('assigneeName'), 'מטפל');

  // A field added in the CRM must appear untranslated rather than vanish.
  assert.equal(labelFor('brandNewField'), 'brandNewField');
});

test('stored values are unwrapped for a reader', () => {
  assert.equal(formatValue('statusClosed', true), 'כן');
  assert.equal(formatValue('statusClosed', 'false'), 'לא');

  // The apostrophe exists to stop a spreadsheet reading +972 as a formula.
  assert.equal(formatValue('cellNumber', "'+972539116274"), '+972539116274');

  // {"code":1,"description":"ת.ז"} — the description is the readable half.
  assert.equal(formatValue('idType', '{"code":1,"description":"ת.ז"}'), 'ת.ז');

  assert.equal(formatValue('overduePeriod', 'P-26D'), 'באיחור 26 ימים');
  assert.equal(formatValue('anything', ''), '');
});

test('a timestamp is shown in Israel time, not UTC', () => {
  // 14:05 UTC is 17:05 in Jerusalem; showing the UTC hour reads as the CRM
  // being three hours wrong.
  assert.equal(formatDate('2026-09-04T14:05:24Z'), '04/09/2026 17:05');

  // A plain date has no time to shift, and inventing one could move the day.
  assert.equal(formatDate('1989-08-18'), '18/08/1989');
});

// ---------------------------------------------------------------- the page
//
// What the page shows is covered in events.test.js, against the status log it
// actually renders. What matters here is the boundary: the shell is public,
// and everything behind it is not.

let db;
let server;
let baseUrl;

before(async () => {
  db = new Database(config.database);
  await db.migrate();

  server = createApi({ db, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

test('the page is served without a token and carries no data', async () => {
  const response = await fetch(`${baseUrl}/dashboard`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);

  const html = await response.text();
  assert.match(html, /יומן שינויי סטטוס/);

  // The shell is reachable by anyone with the URL, so nothing may be baked in:
  // no token, and no address that could belong to a real person.
  assert.ok(!html.includes('test-token'));
  assert.ok(!/[\w.]+@[\w.]+\.[a-z]{2,}/i.test(html));
});

test('the page is also at the root, so the bare URL works', async () => {
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

test('every route behind it still requires the token', async () => {
  for (const path of ['/api/dashboard/events', '/api/dashboard/filters',
    '/api/events', '/api/outbox', '/api/leads']) {
    assert.equal((await fetch(`${baseUrl}${path}`)).status, 401, path);
  }
});

test('the reset cannot be fired without a token either', async () => {
  const response = await fetch(`${baseUrl}/api/admin/reset-mirror?confirm=delete-mirror`,
    { method: 'POST' });

  assert.equal(response.status, 401);
});
