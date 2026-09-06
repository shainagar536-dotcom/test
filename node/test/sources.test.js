/**
 * Resolving a lead's referring source from its id.
 *
 * The leads carry `sourceId` as a bare UUID and no name anywhere, while the
 * recipients file is keyed by name. Everything here covers the bridge between
 * the two — because with it missing, every lead skips and the service sends
 * nothing at all, which is exactly the failure that looks like "working".
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { buildOutbox, SKIP } from '../src/notify/outbox.js';
import {
  extractPairs, optionsFromSchema, scoreCatalog, resolveSourceName, isUuid
} from '../src/sources.js';
import { parseCsv, buildRecipients } from '../src/notify/import.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const A = 'ce934d66-7cf3-4b94-84cf-929ba7953d9f';
const B = '90d7281e-5c21-476c-822a-e688db22d549';

const COLUMNS = {
  status: 'statusName',
  source: '',
  sourceId: 'sourceId',
  clientName: 'fullName',
  leadNumber: 'number'
};

const MESSAGING = {
  columns: COLUMNS,
  subject: 'עדכון — {client}',
  body: 'שלום {source},\nלקוח: {client}\nסטטוס: {message}\n{signature}',
  signature: 'בברכה',
  maxPerRun: 25,
  redirectAllTo: ''
};

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0, 1, 2, 3, 4, 5],
    activeHours: [8], shrinkGuard: 0.5 },
  sourceCatalogPaths: ['/leads/sources', '/sources'],
  messaging: MESSAGING
};

// --------------------------------------------------------------- pure logic

test('a pair is found whatever key names the catalog uses', () => {
  assert.deepEqual(extractPairs([{ id: A, name: 'מטאור' }]), [{ id: A, name: 'מטאור' }]);
  assert.deepEqual(extractPairs([{ sourceId: A, sourceName: 'מטאור' }]),
    [{ id: A, name: 'מטאור' }]);
  assert.deepEqual(extractPairs([{ value: A, label: 'מטאור' }]),
    [{ id: A, name: 'מטאור' }]);
});

test('pairs are found inside whatever envelope wraps them', () => {
  const wrapped = { data: { rows: [{ id: A, name: 'מטאור' }] } };
  assert.deepEqual(extractPairs(wrapped), [{ id: A, name: 'מטאור' }]);
});

test('a row whose name merely restates the id is not a pair', () => {
  // Otherwise the map fills with UUID "names" that match no recipient and
  // read, in every report, as a mapping that succeeded.
  assert.deepEqual(extractPairs([{ id: A, name: A }]), []);
});

test('non-UUID ids are rejected, since the leads carry UUIDs', () => {
  assert.deepEqual(extractPairs([{ id: '17', name: 'מטאור' }]), []);
  assert.equal(isUuid(A), true);
  assert.equal(isUuid('nope'), false);
});

test('the field schema is mined for the source picklist', () => {
  const schema = [
    { key: 'statusName', label: 'סטטוס' },
    { key: 'sourceId', label: 'מקור', options: [
      { value: A, label: 'מטאור' }, { value: B, label: 'קמפיין' }] }
  ];

  assert.deepEqual(optionsFromSchema(schema, 'sourceId'),
    [{ id: A, name: 'מטאור' }, { id: B, name: 'קמפיין' }]);
});

test('a schema with no option list yields nothing rather than guessing', () => {
  assert.deepEqual(optionsFromSchema([{ key: 'sourceId', label: 'מקור' }], 'sourceId'), []);
});

test('a catalog is scored by the lead traffic it explains, not its size', () => {
  const usage = new Map([[A, 49], [B, 487]]);

  // Plausible shape, wrong contents: it explains none of the real traffic.
  const wrong = scoreCatalog(
    [{ id: '11111111-1111-1111-1111-111111111111', name: 'x' }], usage);
  assert.equal(wrong.matchedSources, 0);
  assert.equal(wrong.coverage, 0);

  const right = scoreCatalog([{ id: B, name: 'מטאור' }], usage);
  assert.equal(right.matchedSources, 1);
  assert.equal(right.matchedLeads, 487);
  assert.equal(right.coverage, 0.9086);
});

test('a name column wins when the CRM serves one', () => {
  const resolved = resolveSourceName(
    { 'מקור מפנה': 'מטאור', sourceId: A },
    { source: 'מקור מפנה', sourceId: 'sourceId' },
    new Map([[A, 'שם אחר']]));

  assert.equal(resolved.via, 'column');
  assert.equal(resolved.name, 'מטאור');
});

test('an id with no mapping is distinguished from no id at all', () => {
  const columns = { source: '', sourceId: 'sourceId' };

  assert.equal(resolveSourceName({ sourceId: A }, columns, new Map()).via, 'none');
  assert.equal(resolveSourceName({ sourceId: A }, columns, new Map()).id, A);
  assert.equal(resolveSourceName({}, columns, new Map()).id, '');
});

test('the recipients file may carry the id column itself', () => {
  const csv = 'מקור,מזהה מקור,מייל\nמטאור,' + A + ',a@example.com\n';
  const { recipients } = buildRecipients(parseCsv(csv));

  assert.equal(recipients[0].sourceId, A);
  assert.equal(recipients[0].sourceName, 'מטאור');
});

// ------------------------------------------------------------- against a db

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
  headers: {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    ...(options.headers ?? {})
  }
});

const storeLead = (id, sourceId) => db.pool.query(
  `INSERT INTO leads (id, fields, hash, changed_at, change_type)
        VALUES ($1, $2, 'h', now(), 'baseline')`,
  [id, JSON.stringify({ id, sourceId, statusName: 'חדש', fullName: 'דנה', number: '1' })]);

test('a hand-written mapping survives a CRM refresh', async () => {
  await db.upsertSources([{ id: A, name: 'שם מה-CRM' }], 'crm');
  await db.upsertSources([{ id: A, name: 'השם הנכון' }], 'manual');

  // The sync runs hourly. If it overwrote a correction, the operator would
  // fix the same name every hour and never know why it kept coming back.
  await db.upsertSources([{ id: A, name: 'שם מה-CRM' }], 'crm');

  assert.equal((await db.sourceNameMap()).get(A), 'השם הנכון');
});

test('unresolved ids are reported apart from the named sources', async () => {
  await storeLead('l1', A);
  await storeLead('l2', B);
  await db.upsertSources([{ id: A, name: 'מטאור' }], 'crm');

  // Every source in use is listed, named or not, so an unnamed one cannot
  // drop off the worklist. `resolved` is what separates them.
  const inUse = await db.listSourcesInUse(COLUMNS);

  assert.deepEqual(
    inUse.filter(row => row.resolved).map(row => row.source_name), ['מטאור']);
  assert.deepEqual(
    inUse.filter(row => !row.resolved).map(row => row.source_id), [B]);

  const unresolved = await db.listUnresolvedSources(COLUMNS);
  assert.deepEqual(unresolved, [{ source_id: B, leads: 1 }]);
});

test('usage counts every id, named or not', async () => {
  await storeLead('l1', A);
  await storeLead('l2', A);
  await storeLead('l3', B);

  assert.deepEqual([...(await db.sourceUsage(COLUMNS))], [[A, 2], [B, 1]]);
});

test('the map is readable and writable over the API', async () => {
  const put = await call('/api/sources/map', {
    method: 'PUT',
    body: JSON.stringify([{ sourceId: A, name: 'מטאור' }])
  });

  assert.equal(put.status, 200);
  assert.equal((await put.json()).written, 1);

  const listed = await (await call('/api/sources/map')).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.manual, 1);

  const removed = await call(`/api/sources/map/${A}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await (await call('/api/sources/map')).json()).total, 0);
});

test('a mapping without both halves is refused, not half-stored', async () => {
  const response = await call('/api/sources/map', {
    method: 'PUT', body: JSON.stringify([{ sourceId: A }])
  });

  assert.equal(response.status, 400);
  assert.equal((await db.listSourceMap()).length, 0);
});

test('the outbox reaches a recipient through the id map', async () => {
  await db.saveTemplate({ status: 'לא ענה', message: 'הליד לא ענה', channel: 'email' });
  await db.saveRecipient({
    sourceKey: 'מטאור', sourceName: 'מטאור', email: 'a@example.com',
    whatsapp: '', active: true
  });
  await db.upsertSources([{ id: A, name: 'מטאור' }], 'crm');

  const changes = [{
    id: 1, lead_id: 'l1', column_name: 'statusName',
    before_value: 'חדש', after_value: 'לא ענה',
    occurred_at: new Date().toISOString(),
    fields: { sourceId: A, statusName: 'לא ענה', fullName: 'דנה', number: '7' }
  }];

  const { ready, skipped } = buildOutbox({
    changes,
    templates: new Map([['לא ענה', { status: 'לא ענה', message: 'הליד לא ענה',
      channel: 'email', active: true }]]),
    recipients: new Map([['מטאור', { source_key: 'מטאור', source_name: 'מטאור',
      email: 'a@example.com', whatsapp: '', active: true }]]),
    sourceNames: await db.sourceNameMap(),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(skipped.length, 0);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].to, 'a@example.com');
  assert.match(ready[0].body, /שלום מטאור/);
});

test('an unmapped id skips as unmapped, not as sourceless', async () => {
  const changes = [{
    id: 1, lead_id: 'l1', column_name: 'statusName',
    before_value: 'חדש', after_value: 'לא ענה',
    occurred_at: new Date().toISOString(),
    fields: { sourceId: A, statusName: 'לא ענה' }
  }];

  const templates = new Map([['לא ענה',
    { status: 'לא ענה', message: 'x', channel: 'email', active: true }]]);

  const { ready, skipped } = buildOutbox({
    changes, templates, recipients: new Map(),
    sourceNames: new Map(), columns: COLUMNS, messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.unknownSource);
  assert.equal(skipped[0].detail, A);

  // A lead the CRM never attributed to anyone is a different problem.
  const noId = buildOutbox({
    changes: [{ ...changes[0], fields: { statusName: 'לא ענה' } }],
    templates, recipients: new Map(),
    sourceNames: new Map(), columns: COLUMNS, messaging: MESSAGING
  });

  assert.equal(noId.skipped[0].reason, SKIP.noSource);
});

test('importing a recipients file with an id column fills the map', async () => {
  const csv = `מקור,מזהה מקור,מייל\nמטאור,${A},a@example.com\n`;

  const preview = await (await call('/api/recipients/import', {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv
  })).json();

  assert.equal(preview.applied, false);
  assert.equal(preview.sourceIdsInFile, 1);
  assert.equal(preview.sourceIdsMapped, 0);
  assert.equal((await db.listSourceMap()).length, 0);

  const applied = await (await call('/api/recipients/import?apply=true', {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv
  })).json();

  assert.equal(applied.sourceIdsMapped, 1);
  assert.equal((await db.sourceNameMap()).get(A), 'מטאור');
});

test('/api/sources reports the unresolved ids alongside the worklist', async () => {
  await storeLead('l1', A);
  await storeLead('l2', B);
  await db.upsertSources([{ id: A, name: 'מטאור' }], 'crm');

  const body = await (await call('/api/sources')).json();

  // Both sources are listed; one of them is still just an id.
  assert.equal(body.total, 2);
  assert.equal(body.withRecipient, 0);
  assert.equal(body.unresolvedIds, 1);
  assert.equal(body.unresolvedLeads, 1);
  assert.equal(body.unresolved[0].source_id, B);
});

test('a schema entry never becomes a source out of its own id and name', () => {
  // The entry describes the field; it is not an option of it. Without the
  // nested-only scan this returns one confident, wrong pair — and a wrong
  // name here emails the wrong partner about a real customer.
  const schema = [{ key: 'sourceId', id: A, name: 'Referring source', label: 'מקור' }];

  assert.deepEqual(optionsFromSchema(schema, 'sourceId'), []);
});

test('an option list under an unexpected key is still found', () => {
  const schema = [{ key: 'sourceId', enumValues: [{ id: A, name: 'מטאור' }] }];

  assert.deepEqual(optionsFromSchema(schema, 'sourceId'), [{ id: A, name: 'מטאור' }]);
});

test('a source column pointed at the id column still resolves', async () => {
  // An earlier version of this service set SOURCE_COLUMN=sourceId, and that
  // setting outlives a deploy. Taking the value at face value would treat a
  // UUID as the partner's name: it matches no recipient, and the report
  // blames the recipients file instead of the missing mapping.
  const columns = { ...COLUMNS, source: 'sourceId', sourceId: 'sourceId' };

  const resolved = resolveSourceName(
    { sourceId: A }, columns, new Map([[A, 'מטאור']]));

  assert.equal(resolved.via, 'map');
  assert.equal(resolved.name, 'מטאור');

  const unmapped = resolveSourceName({ sourceId: A }, columns, new Map());
  assert.equal(unmapped.name, '');
  assert.equal(unmapped.id, A);
});

test('a real name in the source column is never mistaken for an id', async () => {
  const columns = { source: 'מקור מפנה', sourceId: 'sourceId' };

  const resolved = resolveSourceName(
    { 'מקור מפנה': 'מטאור - אריאל', sourceId: A }, columns, new Map());

  assert.equal(resolved.via, 'column');
  assert.equal(resolved.name, 'מטאור - אריאל');
});
