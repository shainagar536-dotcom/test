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

beforeEach(async () => {
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, cursors, sources');
});

const call = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: { Authorization: 'Bearer test-token', ...(options.headers ?? {}) }
});

const addLead = (id, fields) => db.pool.query(
  `INSERT INTO leads (id, fields, hash, changed_at, change_type)
        VALUES ($1, $2, 'h', now(), 'updated')`,
  [id, JSON.stringify({
    id, number: id, fullName: 'דנה כהן', statusName: 'לא ענה',
    assigneeName: 'שי נגר', sourceId: SOURCE, ...fields
  })]);

const addChange = (leadId, after, notified) => db.pool.query(
  `INSERT INTO changes (lead_id, change_type, column_name, before_value,
                        after_value, occurred_at, notified_at, notified_via)
        VALUES ($1, 'updated', 'statusName', 'חדש', $2, now(), $3, $4)`,
  [leadId, after, notified ? new Date() : null, notified ? 'email' : null]);

const ready = async () => {
  await db.saveTemplate({ status: 'לא ענה', message: 'הליד לא ענה', channel: 'email' });
  await db.saveRecipient({ sourceKey: 'מטאור', sourceName: 'מטאור',
    email: 'a@example.com', whatsapp: '', active: true });
  await db.upsertSources([{ id: SOURCE, name: 'מטאור' }], 'crm');
};

test('the page is served without a token and carries no data', async () => {
  const response = await fetch(`${baseUrl}/dashboard`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);

  const html = await response.text();
  assert.match(html, /מראה הלידים/);

  // The shell must not embed anything: it is reachable by anyone with the URL.
  assert.ok(!html.includes('test-token'));
  assert.ok(!html.includes('דנה כהן'));
});

test('the data behind it still requires the token', async () => {
  assert.equal((await fetch(`${baseUrl}/api/dashboard/leads`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/dashboard/filters`)).status, 401);
});

test('a lead with a sendable change reads as waiting, not as stuck', async () => {
  await ready();
  await addLead('l1');
  await addChange('l1', 'לא ענה', false);

  const body = await (await call('/api/dashboard/leads')).json();

  assert.equal(body.total, 1);
  assert.equal(body.leads[0].handled.state, 'pending');
  assert.equal(body.leads[0].handled.label, 'ממתין לשליחה');
  assert.equal(body.leads[0].sourceName, 'מטאור');
});

test('a change nothing will ever send says so, and why', async () => {
  // The template exists but the source maps to no name, so no recipient can
  // ever be found. Calling that "waiting" would hide it forever.
  await db.saveTemplate({ status: 'לא ענה', message: 'x', channel: 'email' });
  await addLead('l1');
  await addChange('l1', 'לא ענה', false);

  const body = await (await call('/api/dashboard/leads')).json();

  assert.equal(body.leads[0].handled.state, 'blocked');
  assert.equal(body.leads[0].handled.label, 'לא יישלח');
  assert.equal(body.leads[0].handled.reason, 'מזהה המקור לא ממופה לשם');
});

test('a notified change reads as sent, with when and how', async () => {
  await ready();
  await addLead('l1');
  await addChange('l1', 'לא ענה', true);

  const body = await (await call('/api/dashboard/leads')).json();

  assert.equal(body.leads[0].handled.state, 'sent');
  assert.equal(body.leads[0].handled.via, 'email');
  assert.ok(body.leads[0].handled.at);
});

test('a lead that never moved is not counted as unhandled', async () => {
  await addLead('l1');

  const body = await (await call('/api/dashboard/leads')).json();

  assert.equal(body.leads[0].handled.state, 'none');
  assert.equal(body.summary.openLeads, 0);
});

test('the handled filter pages on the real total, not on a trimmed page', async () => {
  await ready();

  for (let i = 0; i < 5; i++) {
    await addLead(`open${i}`);
    await addChange(`open${i}`, 'לא ענה', false);
  }

  for (let i = 0; i < 3; i++) {
    await addLead(`sent${i}`);
    await addChange(`sent${i}`, 'לא ענה', true);
  }

  await addLead('quiet');

  const open = await (await call('/api/dashboard/leads?delivery=open&limit=2')).json();
  assert.equal(open.total, 5);
  assert.equal(open.leads.length, 2);

  const sent = await (await call('/api/dashboard/leads?delivery=sent')).json();
  assert.equal(sent.total, 3);

  const none = await (await call('/api/dashboard/leads?delivery=none')).json();
  assert.deepEqual(none.leads.map(lead => lead.id), ['quiet']);
});

test('a lead with one sent and one unsent change is still open', async () => {
  // Otherwise the newest status change would be silently written off as
  // handled because an older one went out.
  await ready();
  await addLead('l1');
  await addChange('l1', 'לא ענה', true);
  await addChange('l1', 'לא ענה', false);

  const body = await (await call('/api/dashboard/leads?delivery=open')).json();

  assert.equal(body.total, 1);
  assert.equal(body.leads[0].handled.state, 'pending');
});

test('search matches a customer by name, number or phone', async () => {
  await addLead('l1', { fullName: 'דנה כהן', cellNumber: "'+972500000001" });
  await addLead('l2', { fullName: 'רועי סלאח', cellNumber: "'+972500000002" });

  const byName = await (await call('/api/dashboard/leads?search=רועי')).json();
  assert.deepEqual(byName.leads.map(lead => lead.id), ['l2']);

  const byPhone = await (await call('/api/dashboard/leads?search=0000001')).json();
  assert.deepEqual(byPhone.leads.map(lead => lead.id), ['l1']);
});

test('values arrive translated for display, and raw ones are not shown', async () => {
  await addLead('l1', { statusClosed: true, idType: '{"code":1,"description":"ת.ז"}' });

  const body = await (await call('/api/dashboard/leads')).json();
  const { display } = body.leads[0];

  assert.equal(display.statusClosed, 'כן');
  assert.equal(display.idType, 'ת.ז');
  assert.equal(display.fullName, 'דנה כהן');
});

test('the filters name every column and translate the keys', async () => {
  await addLead('l1');

  const meta = await (await call('/api/dashboard/filters')).json();

  assert.equal(meta.labels.statusName, 'סטטוס');
  assert.ok(meta.columns.includes('assigneeName'));
  assert.ok(meta.defaultColumns.includes('fullName'));
  assert.deepEqual(meta.assignees, [{ value: 'שי נגר', leads: 1 }]);
});

test('the summary reports what is blocking delivery', async () => {
  await addLead('l1');
  await addChange('l1', 'לא ענה', false);

  const body = await (await call('/api/dashboard/leads')).json();

  assert.equal(body.summary.openLeads, 1);
  assert.equal(body.summary.unresolvedSources, 1);
  assert.equal(body.summary.unresolvedLeads, 1);
  assert.equal(body.summary.recipients, 0);
});
