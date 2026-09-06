/**
 * The webhook must never take the service down.
 *
 * The sender is outside our control: it can deliver a shape nobody
 * documented, a field of the wrong type, a date that is not a date, or an
 * event we have never heard of. None of that may crash the process, and — as
 * importantly — none of it may answer 500, because Svix answers a 500 by
 * delivering the same body again, and again.
 *
 * The rule these tests hold to: the endpoint answers, the process survives,
 * and anything it could not interpret is stored with the reason.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database, eventTimestamp, stripNullBytes } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { interpretDelivery } from '../src/webhook/lead-updated.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const config = {
  surense: { clientId: 'cid_x', clientSecret: 'csk_y',
    tokenUrl: 'https://crm.test/oauth/token',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 5 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook', svixSecret: '' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5, mirrorLeads: false },
  sourceCatalogPath: '/customers/sources',
  sourceCatalogPaths: [],
  messaging: {
    columns: { status: 'statusName', source: '', sourceId: 'sourceId',
      clientName: 'fullName', leadNumber: 'number', assignee: 'assigneeName', total: '' },
    subject: 'עדכון — {client}', body: 'שלום {source}, {message}',
    signature: 'בברכה', maxPerRun: 25, redirectAllTo: ''
  }
};

/** A real null byte, written as an escape so it survives every editor. */
const NUL = '\u0000';

/** A CRM that is simply not there — the normal case when things go wrong. */
const deadCrm = async () => { throw new Error('ECONNREFUSED'); };

let db;
let server;
let baseUrl;

before(async () => {
  db = new Database(config.database);
  await db.migrate();

  server = createApi({ db, config, fetchImpl: deadCrm });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, sources, ' +
    'source_names, cursors, webhook_events, sync_runs');

  await db.pool.query("BEGIN; SET LOCAL app.allow_history_delete = 'on'; " +
    'DELETE FROM status_events; COMMIT;');
});

/** Delivered with the bearer secret, so signing is not what is under test. */
const send = (body) => fetch(`${baseUrl}/webhook/surense`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hook' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

// -------------------------------------------------------- shapes and junk

test('every malformed delivery is answered, and none is a 500', async () => {
  const nasty = [
    '',
    'not json at all',
    '[]',
    'null',
    '42',
    '"a string"',
    '{}',
    JSON.stringify({ eventType: 'LeadUpdated' }),
    JSON.stringify({ eventType: 'SomethingNew', leadId: 'x' }),
    JSON.stringify({ eventType: 'LeadUpdated', leadId: 'x', diff: null }),
    JSON.stringify({ eventType: 'LeadUpdated', leadId: 'x', diff: 'not an object' }),
    JSON.stringify({ eventType: 'LeadUpdated', leadId: 'x',
      diff: { statusName: 'not a before/after pair' } }),
    JSON.stringify({ eventType: 'LeadUpdated', leadId: { nested: true },
      diff: { statusName: { before: 1, after: 2 } } }),
    JSON.stringify({ eventType: 'LeadUpdated', leadId: 'x',
      diff: { statusName: { before: null, after: ['an', 'array'] } } })
  ];

  for (const body of nasty) {
    const response = await send(body);

    assert.ok(response.status < 500,
      `${body.slice(0, 60)} answered ${response.status}`);

    // The service must still be usable afterwards.
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  }
});

test('a delivery with no date is recorded, not refused', async () => {
  // The sync's timestamp check throws on a stamp with no offset. On this path
  // that would be a 500, and a 500 is how you ask Svix to send it again.
  const response = await send({
    eventType: 'LeadUpdated', leadId: 'lead-1', customerName: 'דנה',
    diff: { statusName: { before: 'חדש', after: 'לא ענה' } }
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).recorded, true);

  const [event] = await db.listStatusEvents({});
  assert.equal(event.status_after, 'לא ענה');
  assert.ok(event.occurred_at instanceof Date);
});

test('a date in any plausible shape is accepted', () => {
  assert.equal(eventTimestamp('2026-09-06T13:25:41Z').toISOString(),
    '2026-09-06T13:25:41.000Z');

  // No offset — the sync refuses this; the webhook must not.
  assert.equal(eventTimestamp('2026-09-06 13:25:41').getFullYear(), 2026);

  // Seconds and milliseconds are both seen in the wild.
  assert.equal(eventTimestamp(1757164000).getFullYear(), 2025);
  assert.equal(eventTimestamp(1757164000000).getFullYear(), 2025);

  // Unusable input falls back to now rather than throwing.
  for (const bad of [null, undefined, '', 'yesterday', {}, NaN, Infinity]) {
    assert.ok(eventTimestamp(bad) instanceof Date);
    assert.ok(!Number.isNaN(eventTimestamp(bad).getTime()));
  }
});

test('a null byte in the payload does not break the insert', async () => {
  // Postgres accepts a null byte inside a JSON string and refuses it in a
  // jsonb value. One anywhere in a delivery would make every retry of that
  // delivery fail identically, forever.
  assert.deepEqual(
    stripNullBytes({ ['a' + NUL + 'b']: 'c' + NUL + 'd', e: ['f' + NUL] }),
    { ab: 'cd', e: ['f'] });

  const response = await send({
    eventType: 'LeadUpdated',
    leadId: 'lead-2',
    customerName: 'דנה כהן' + NUL,
    date: '2026-09-06T13:25:41Z',
    diff: { statusName: { before: 'חדש', after: 'לא ענה' + NUL } }
  });

  assert.equal(response.status, 200);
  assert.equal((await db.listWebhookEvents({ pendingOnly: false })).length, 1);
});

test('a CRM that is down costs the lookup, never the event', async () => {
  const response = await send({
    eventType: 'LeadUpdated', leadId: 'lead-3', customerName: 'רועי',
    date: '2026-09-06T13:25:41Z',
    diff: { statusName: { before: 'חדש', after: 'לא ענה' } }
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.recorded, true);
  assert.equal(body.source.state, 'failed');

  // The row is complete apart from the lookup, and the retry pass owns it.
  const [event] = await db.listStatusEvents({});
  assert.equal(event.customer_name, 'רועי');
  assert.equal((await db.pendingEnrichment({})).length, 1);
});

test('the enrichment pass reports a dead CRM rather than throwing', async () => {
  await send({
    eventType: 'LeadUpdated', leadId: 'lead-4', date: '2026-09-06T13:25:41Z',
    diff: { statusName: { before: 'חדש', after: 'לא ענה' } }
  });

  const response = await fetch(`${baseUrl}/api/events/enrich`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token' }
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).failed, 1);
});

test('a hopeless event is retried a bounded number of times, then left', async () => {
  await send({
    eventType: 'LeadUpdated', leadId: 'lead-5', date: '2026-09-06T13:25:41Z',
    diff: { statusName: { before: 'חדש', after: 'לא ענה' } }
  });

  for (let i = 0; i < 10; i++) {
    await fetch(`${baseUrl}/api/events/enrich`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token' }
    });
  }

  // It stops being picked up, so one broken lead cannot crowd out the queue.
  assert.equal((await db.pendingEnrichment({})).length, 0);

  const [event] = await db.listStatusEvents({});
  assert.ok(event.enrich_attempts <= 6, `attempts: ${event.enrich_attempts}`);
  assert.equal(event.source_state, 'failed');
});

test('an unknown event type is stored with its reason, not dropped', async () => {
  await send({ eventType: 'LeadDeleted', leadId: 'x' });

  const [stored] = await db.listWebhookEvents({ pendingOnly: false });

  assert.equal(stored.payload.eventType, 'LeadDeleted');
  assert.match(stored.result, /not a lead update/);
  assert.equal((await db.statusEventCounts()).total, 0);
});

test('interpreting a delivery never throws, whatever it is given', () => {
  for (const payload of [null, undefined, 42, 'text', [], {},
    { diff: { statusName: { before: {}, after: [] } } },
    { eventType: 'LeadUpdated', leadId: 'x', diff: { a: { after: undefined } } }]) {
    assert.doesNotThrow(() => interpretDelivery(payload));
  }
});
