/**
 * Handling a real Surense LeadUpdated delivery.
 *
 * The payload below is a real one, with names changed. Everything here is
 * checked against that shape rather than an invented one.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { interpretDelivery, findDiff } from '../src/webhook/lead-updated.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const SIGNING_SECRET = `whsec_${randomBytes(24).toString('base64')}`;

const COLUMNS = { status: 'סטטוס', source: 'מקור מפנה',
  clientName: 'שם הלקוח', leadNumber: 'מספר ליד' };

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'api-token', webhookSecret: 'hook', svixSecret: SIGNING_SECRET },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5 },
  messaging: { columns: COLUMNS, subject: 'ליד {client}',
    body: 'שלום {source}, סטטוס: {message}', signature: 'בברכה',
    maxPerRun: 25, redirectAllTo: '' }
};

const LEAD_ID = 'f7651ffc-df01-411e-a6bb-c0ecafabd82c';

/** A real LeadUpdated delivery, names changed. */
const delivery = (overrides = {}) => ({
  agencyId: 'c6d82aeb-76fb-4083-8626-0acfd3e1848d',
  assigneeId: '52b102e4-823c-4d6b-90d2-f08c87d0a515',
  authUserId: '52b102e4-823c-4d6b-90d2-f08c87d0a515',
  customerConfidential: false,
  customerId: 'f36e47e8-c428-4732-bd64-88db2f4dd08c',
  customerManagers: ['52b102e4-823c-4d6b-90d2-f08c87d0a515'],
  customerName: 'רועי סלאח',
  date: '2026-09-04T13:25:41.412738803Z',
  diff: {
    closed: { after: false, before: true },
    statusId: { after: 'd2990176-2338-42c2-a73a-d196bb3c5c2e',
      before: '23545862-7a92-44a4-a2f8-019c0820ed12' },
    statusName: { after: 'לא ענה', before: 'חדש' },
    statusSuccess: { after: false, before: true }
  },
  eventType: 'LeadUpdated',
  firstName: 'רועי',
  lastName: 'סלאח',
  leadId: LEAD_ID,
  leadNumber: 3500,
  leadTypeId: '1927a4aa-44c1-4a15-82ec-ade4c7a6075b',
  leadTypeName: 'החזר מס',
  ownerId: '52b102e4-823c-4d6b-90d2-f08c87d0a515',
  tenantId: 'bf3edf72-3e73-4f1f-9f1d-fd79913ec087',
  ...overrides
});

function sign(body, id = `msg_${randomBytes(8).toString('hex')}`) {
  const ts = Math.floor(Date.now() / 1000);
  const key = Buffer.from(SIGNING_SECRET.replace(/^whsec_/, ''), 'base64');

  return {
    'svix-id': id,
    'svix-timestamp': String(ts),
    'svix-signature': `v1,${createHmac('sha256', key)
      .update(`${id}.${ts}.${body}`).digest('base64')}`
  };
}

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
  await db.pool.query('TRUNCATE leads, changes, webhook_events, templates, recipients, source_names, sources');
});

const send = (payload, id) => {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/webhook/surense`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign(body, id) },
    body
  });
};

const seedLead = (status = 'חדש', source = 'מטאור - אריאל') => db.pool.query(
  `INSERT INTO leads (id, fields, hash, changed_at, change_type)
   VALUES ($1, $2, 'h', now(), 'בסיס')`,
  [LEAD_ID, JSON.stringify({
    [COLUMNS.status]: status, [COLUMNS.source]: source,
    [COLUMNS.clientName]: 'רועי סלאח', [COLUMNS.leadNumber]: '3500'
  })]);

// ----------------------------------------------------------- interpretation
test('the diff is found under its "diff" wrapper', () => {
  assert.equal(findDiff(delivery()).wrapper, 'diff');
});

test('a real delivery yields the status move', () => {
  const event = interpretDelivery(delivery());

  assert.equal(event.isLeadUpdate, true);
  assert.equal(event.leadId, LEAD_ID);
  assert.equal(event.leadNumber, '3500');
  assert.equal(event.clientName, 'רועי סלאח');
  assert.equal(event.statusBefore, 'חדש');
  assert.equal(event.statusAfter, 'לא ענה');
  assert.equal(event.occurredAt, '2026-09-04T13:25:41.412738803Z');
});

test('fields present in the diff but unchanged are not changes', () => {
  // The second real delivery carried closed:{before:false,after:false} and
  // statusSuccess:{before:false,after:false} — Surense lists the fields it
  // looked at, not only the ones that moved.
  const event = interpretDelivery(delivery({
    diff: {
      closed: { before: false, after: false },
      statusId: { before: 'd2990176', after: 'acc8daca' },
      statusName: { before: 'חדש', after: 'לא ענה' },
      statusSuccess: { before: false, after: false }
    }
  }));

  assert.equal(event.statusAfter, 'לא ענה', 'the real move is still seen');
  assert.deepEqual(event.otherChanges, [],
    'both no-op entries have matching sides, so neither is a change');
});

test('a non-status field that really moved is kept', () => {
  const event = interpretDelivery(delivery({
    diff: {
      statusName: { before: 'חדש', after: 'לא ענה' },
      closed: { before: false, after: true }
    }
  }));

  assert.deepEqual(event.otherChanges,
    [{ field: 'closed', before: 'false', after: 'true' }]);
});

test('a status whose two sides match is not a status change', () => {
  // Without this the referring source would be told the status moved to the
  // value it already had.
  const event = interpretDelivery(delivery({
    diff: { statusName: { before: 'לא ענה', after: 'לא ענה' } }
  }));

  assert.equal(event.statusAfter, null);
  assert.match(event.reason, /status did not change/);
});

test('a no-op status delivery records nothing and sends nothing', async () => {
  await seedLead('לא ענה');

  const body = await (await send(delivery({
    diff: { statusName: { before: 'לא ענה', after: 'לא ענה' } }
  }))).json();

  assert.equal(body.recorded, false);

  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM changes');
  assert.equal(rows[0].n, 0);
});

test('an event of another type is ignored, with the reason', () => {
  const event = interpretDelivery(delivery({ eventType: 'LeadCreated' }));

  assert.equal(event.isLeadUpdate, false);
  assert.match(event.reason, /not a lead update/);
});

test('an update that did not touch the status is not notifiable', () => {
  const event = interpretDelivery(delivery({
    diff: { closed: { after: false, before: true } }
  }));

  assert.equal(event.statusAfter, null);
  assert.match(event.reason, /status did not change/);
});

test('a diff at the top level, with no wrapper, still works', () => {
  const event = interpretDelivery({
    eventType: 'LeadUpdated', leadId: LEAD_ID,
    statusName: { before: 'חדש', after: 'לא ענה' }
  });

  assert.equal(event.statusAfter, 'לא ענה');
});

// ------------------------------------------------------------- end to end
test('a delivery records a change against the stored lead', async () => {
  await seedLead();

  const response = await send(delivery());
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.recorded, true);
  assert.equal(body.statusChange, 'חדש -> לא ענה');

  const { rows } = await db.pool.query('SELECT * FROM changes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].column_name, COLUMNS.status);
  assert.equal(rows[0].before_value, 'חדש');
  assert.equal(rows[0].after_value, 'לא ענה');

  // The event's own timestamp, not the moment of delivery.
  assert.equal(rows[0].occurred_at.toISOString().slice(0, 19),
    '2026-09-04T13:25:41');
});

test('the stored lead moves to the new status', async () => {
  await seedLead('חדש');
  await send(delivery());

  const lead = await db.getLead(LEAD_ID);

  // Without this the next poll would compare against the old value and record
  // the identical change a second time.
  assert.equal(lead.fields[COLUMNS.status], 'לא ענה');
  assert.equal(lead.change_type, 'עודכן');
});

test('a retried delivery is not recorded twice', async () => {
  await seedLead();
  const messageId = 'msg_the_same_one';

  const first = await (await send(delivery(), messageId)).json();
  assert.equal(first.recorded, true);

  // Svix retries a failed delivery with the SAME message id.
  const second = await (await send(delivery(), messageId)).json();
  assert.equal(second.duplicate, true);

  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM changes');
  assert.equal(rows[0].n, 1, 'a retry must not notify the source twice');
});

test('a lead the sync has not seen is reported, not failed', async () => {
  const response = await send(delivery());

  // 200 on purpose: retrying will not help until a sync runs, and a 4xx
  // would have Surense retry it repeatedly for nothing.
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.recorded, false);
  assert.match(body.reason, /not in the database yet/);
});

test('the delivery is stored even when nothing is recorded', async () => {
  await send(delivery({ eventType: 'LeadCreated' }));

  const events = await db.listWebhookEvents({ pendingOnly: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.eventType, 'LeadCreated');

  // Marked handled with why, so a stuck delivery is distinguishable from an
  // unhandled one.
  assert.match(events[0].result, /not a lead update/);
});

test('a recorded change reaches the outbox as a real message', async () => {
  await seedLead('חדש', 'מטאור - אריאל');

  await db.saveTemplate({ status: 'לא ענה', message: 'ניסינו ליצור קשר אין מענה 1' });
  await db.saveRecipient({ sourceKey: 'מטאור - אריאל', sourceName: 'מטאור - אריאל',
    email: 'ariel@example.com' });

  await send(delivery());

  const outbox = await (await fetch(`${baseUrl}/api/outbox`,
    { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

  assert.equal(outbox.readyToSend, 1);
  assert.equal(outbox.messages[0].to, 'ariel@example.com');
  assert.equal(outbox.messages[0].status, 'לא ענה');
  assert.match(outbox.messages[0].body, /אין מענה 1/);
});
