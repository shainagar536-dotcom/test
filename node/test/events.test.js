/**
 * The status-change log: the record this service now keeps.
 *
 * Two properties matter more than the rest and are tested hardest — an event
 * is never lost because a lookup failed, and history cannot be deleted even
 * by code that tries.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { recordDelivery } from '../src/webhook/lead-updated.js';
import { enrichEvent, enrichPending, SOURCE_STATE } from '../src/events/enrich.js';
import { buildEventOutbox, SKIP } from '../src/notify/outbox.js';
import { SurenseClient } from '../src/surense.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const LEAD = 'f7651ffc-df01-411e-a6bb-c0ecafabd82c';
const SOURCE = '40db82e8-891c-4eaa-a449-5c1f69e0474e';
const SOURCE_TITLE = 'סו"ב רועי כץ';

const COLUMNS = {
  status: 'statusName', source: '', sourceId: 'sourceId',
  clientName: 'fullName', leadNumber: 'number', assignee: 'assigneeName'
};

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/oauth/token',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5, mirrorLeads: false },
  sourceCatalogPath: '/customers/sources',
  sourceCatalogPaths: [],
  messaging: {
    columns: COLUMNS,
    subject: 'עדכון — {client}',
    body: 'שלום {source},\nלקוח {client} עבר ל{status}. מטפל: {assignee}\n{signature}',
    signature: 'בברכה', maxPerRun: 25, redirectAllTo: ''
  }
};

const DELIVERY = {
  eventType: 'LeadUpdated',
  leadId: LEAD,
  leadNumber: 3500,
  customerName: 'אלון ברמן',
  date: '2026-09-06T13:25:41Z',
  diff: {
    statusName: { before: 'חדש', after: 'לא ענה' },
    closed: { before: false, after: false }
  }
};

/** A CRM that answers the two calls enrichment makes, and counts them. */
function fakeCrm({ sourceId = SOURCE, catalog = [{ id: SOURCE, title: SOURCE_TITLE }],
  failLead = false, failCatalog = false } = {}) {
  const calls = { token: 0, lead: 0, catalog: 0, fields: 0 };

  const client = new SurenseClient({
    ...config.surense,
    fetchImpl: async (url, options = {}) => {
      const path = String(url);
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
      });

      if (path.includes('/oauth/token')) {
        calls.token++;
        return json({ access_token: 'tok', expires_in: 3600, scope: 'leads:read' });
      }

      if (path.includes('/leads/fields')) { calls.fields++; return json([]); }

      if (path.includes('/customers/sources')) {
        calls.catalog++;
        if (failCatalog) return json({ error: 'nope' }, 500);
        return json(catalog);
      }

      if (path.includes('/leads/search') && options.method === 'POST') {
        calls.lead++;
        if (failLead) return json({ error: 'down' }, 503);

        return json({ rows: [{
          id: LEAD, fullName: 'אלון ברמן', number: '3500',
          statusName: 'לא ענה', assigneeName: 'שי נגר',
          ...(sourceId ? { sourceId } : {})
        }] });
      }

      return json({ error: 'unexpected ' + path }, 404);
    }
  });

  return { client, calls };
}

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

/** History refuses deletion, so clearing it in a test says so explicitly. */
const wipe = async () => {
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, sources, ' +
    'source_names, cursors, webhook_events, sync_runs');

  await db.pool.query(
    "BEGIN; SET LOCAL app.allow_history_delete = 'on'; " +
    'DELETE FROM status_events; COMMIT;');
};

beforeEach(wipe);

const call = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    ...(options.headers ?? {})
  }
});

// ------------------------------------------------------- history is history

test('history cannot be deleted, even deliberately in code', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await assert.rejects(
    () => db.pool.query('DELETE FROM status_events'),
    /append-only/);

  await assert.rejects(
    () => db.pool.query('TRUNCATE status_events'),
    /append-only/);

  assert.equal((await db.statusEventCounts()).total, 1);
});

test('resetting the mirror leaves the history standing', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.pool.query(
    `INSERT INTO leads (id, fields, hash, changed_at, change_type)
          VALUES ('x', '{}', 'h', now(), 'baseline')`);

  const response = await call(
    '/api/admin/reset-mirror?confirm=delete-mirror', { method: 'POST' });

  const body = await response.json();

  assert.equal(body.cleared.leads, 1);
  assert.equal(body.historyKept, 1);
  assert.equal(await db.countLeads(), 0);
});

test('the reset refuses without an explicit confirmation', async () => {
  const response = await call('/api/admin/reset-mirror', { method: 'POST' });
  assert.equal(response.status, 400);
});

// ------------------------------------------------------------ recording

test('a status change is recorded with the source resolved in one pass', async () => {
  const { client, calls } = fakeCrm();

  const outcome = await recordDelivery({ db, payload: DELIVERY, client, config });

  assert.equal(outcome.recorded, true);
  assert.equal(outcome.enriched.sourceState, SOURCE_STATE.resolved);

  const [event] = await db.listStatusEvents({});

  assert.equal(event.customer_name, 'אלון ברמן');
  assert.equal(event.status_before, 'חדש');
  assert.equal(event.status_after, 'לא ענה');
  assert.equal(event.assignee_name, 'שי נגר');
  assert.equal(event.source_name, SOURCE_TITLE);
  assert.equal(event.source_state, 'resolved');

  // The timestamp is the event's own, not the moment it was received.
  assert.equal(new Date(event.occurred_at).toISOString(), '2026-09-06T13:25:41.000Z');

  // One lead read and one catalog read. Not 66, and not one per source.
  assert.equal(calls.lead, 1);
  assert.equal(calls.catalog, 1);
});

test('the event survives a CRM that cannot be reached', async () => {
  // This is the whole reason the row is written before the lookup runs.
  const { client } = fakeCrm({ failLead: true });

  const outcome = await recordDelivery({ db, payload: DELIVERY, client, config });

  assert.equal(outcome.recorded, true);

  const [event] = await db.listStatusEvents({});
  assert.equal(event.source_state, 'failed');
  assert.match(event.source_error, /lead lookup failed/);
  assert.equal(event.customer_name, 'אלון ברמן');
});

test('a failed lookup is picked up by the enrichment pass afterwards', async () => {
  const broken = fakeCrm({ failLead: true });
  await recordDelivery({ db, payload: DELIVERY, client: broken.client, config });

  const working = fakeCrm();
  const summary = await enrichPending({ db, client: working.client, config });

  assert.equal(summary.processed, 1);
  assert.equal(summary.resolved, 1);

  const [event] = await db.listStatusEvents({});
  assert.equal(event.source_name, SOURCE_TITLE);
});

test('the same change delivered twice is recorded once', async () => {
  const { client } = fakeCrm();

  await recordDelivery({ db, payload: DELIVERY, client, config });
  const second = await recordDelivery({ db, payload: DELIVERY, client, config });

  assert.equal(second.duplicate, true);
  assert.equal((await db.statusEventCounts()).total, 1);
});

test('an event whose status did not move is not recorded', async () => {
  const { client } = fakeCrm();

  const outcome = await recordDelivery({
    db, client, config,
    payload: { ...DELIVERY, diff: { statusName: { before: 'חדש', after: 'חדש' } } }
  });

  assert.equal(outcome.recorded, false);
  assert.equal((await db.statusEventCounts()).total, 0);
});

test('a lead the CRM says has no source is settled, not retried forever', async () => {
  const { client } = fakeCrm({ sourceId: null });

  await recordDelivery({ db, payload: DELIVERY, client, config });

  const [event] = await db.listStatusEvents({});
  assert.equal(event.source_state, 'absent');

  // 'absent' is an answer, so the retry pass leaves it alone.
  assert.equal((await db.pendingEnrichment({})).length, 0);
});

// ------------------------------------------------------------- the lookup

test('the source name is read from title, not name', async () => {
  // The catalog calls it `title`. Looking for `name` returns nothing at all,
  // and the mapping stays silently empty.
  const { client } = fakeCrm({ catalog: [{ id: SOURCE, title: SOURCE_TITLE }] });

  const pairs = await client.fetchSourceCatalog('/customers/sources');
  assert.deepEqual(pairs, [{ id: SOURCE, name: SOURCE_TITLE }]);
});

test('one catalog refresh covers a whole batch of new sources', async () => {
  const { client, calls } = fakeCrm();

  for (let i = 0; i < 5; i++) {
    await db.recordStatusEvent({
      leadId: LEAD, statusBefore: 'חדש', statusAfter: `סטטוס ${i}`,
      occurredAt: new Date(Date.now() + i * 1000).toISOString()
    });
  }

  const summary = await enrichPending({ db, client, config });

  assert.equal(summary.processed, 5);
  assert.equal(summary.resolved, 5);

  // Five events naming one unknown source must not be five refreshes.
  assert.equal(calls.catalog, 1);
});

test('an id missing from the catalog is reported, not invented', async () => {
  const { client } = fakeCrm({ catalog: [{ id: 'other-id', title: 'מישהו אחר' }] });

  const patch = await enrichEvent({
    event: { lead_id: LEAD },
    client,
    sourceNames: new Map(),
    columns: COLUMNS,
    onUnknownSource: async () => new Map()
  });

  assert.equal(patch.sourceState, SOURCE_STATE.failed);
  assert.match(patch.sourceError, /not in the CRM catalog/);
  assert.equal(patch.sourceName, undefined);
});

// ------------------------------------------------------------- the sending

test('a resolved event with a template and a recipient is ready to send', async () => {
  const { client } = fakeCrm();
  await recordDelivery({ db, payload: DELIVERY, client, config });

  await db.saveTemplate({ status: 'לא ענה', message: 'הליד לא ענה', channel: 'email' });
  await db.saveRecipient({
    sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', whatsapp: '', active: true
  });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.equal(outbox.messages[0].to, 'roi@example.com');
  assert.match(outbox.messages[0].body, /שלום סו"ב רועי כץ/);
  assert.match(outbox.messages[0].body, /מטפל: שי נגר/);
});

test('an event still waiting on its source says so, not "no recipient"', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'x', channel: 'email' });

  const events = await db.listStatusEvents({});

  const { ready, skipped } = buildEventOutbox({
    events,
    templates: new Map([['לא ענה',
      { status: 'לא ענה', message: 'x', channel: 'email', active: true }]]),
    recipients: new Map(),
    messaging: config.messaging
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.sourcePending);
});

test('an event is claimed as sent exactly once', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  const first = await (await call('/api/events/notified', {
    method: 'POST', body: JSON.stringify({ ids: [id], via: 'email', to: 'a@b.c' })
  })).json();

  assert.deepEqual(first.claimed, [id]);

  const second = await (await call('/api/events/notified', {
    method: 'POST', body: JSON.stringify({ ids: [id], via: 'email' })
  })).json();

  assert.deepEqual(second.claimed, []);
  assert.deepEqual(second.alreadyClaimed, [id]);
});

// ------------------------------------------------------------ the dashboard

test('the dashboard shows the change, the handler and the source', async () => {
  const { client } = fakeCrm();
  await recordDelivery({ db, payload: DELIVERY, client, config });

  const body = await (await call('/api/dashboard/events')).json();

  assert.equal(body.total, 1);

  const [row] = body.events;
  assert.equal(row.display.customer_name, 'אלון ברמן');
  assert.equal(row.display.status_before, 'חדש');
  assert.equal(row.display.status_after, 'לא ענה');
  assert.equal(row.display.assignee_name, 'שי נגר');
  assert.equal(row.display.source_name, SOURCE_TITLE);
  // Nothing will send this yet, and the row says which of the several
  // possible reasons it actually is.
  assert.equal(row.handled.state, 'blocked');
  assert.equal(row.handled.reason, 'אין נוסח לסטטוס הזה');
});

test('an empty database is an empty page, not an error', async () => {
  const body = await (await call('/api/dashboard/events')).json();

  assert.equal(body.total, 0);
  assert.deepEqual(body.events, []);
  assert.equal(body.counts.total, 0);
});

test('the filters offer only what the log actually holds', async () => {
  const { client } = fakeCrm();
  await recordDelivery({ db, payload: DELIVERY, client, config });

  const meta = await (await call('/api/dashboard/filters')).json();

  assert.deepEqual(meta.statuses, [{ value: 'לא ענה', leads: 1 }]);
  assert.deepEqual(meta.assignees, [{ value: 'שי נגר', leads: 1 }]);
  assert.equal(meta.labels.assignee_name, 'מטפל');
});
