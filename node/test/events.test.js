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
import { DELIVERY_LABELS as DELIVERY_LABELS_FOR_TEST } from '../src/dashboard/labels.js';
import { SEED_TEMPLATES as SEED_TEMPLATES_FOR_TEST,
  MUTED_STATUSES as MUTED_FOR_TEST } from '../src/notify/seeds.js';
import { normalizeText } from '../src/mirror.js';

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
  // Realistic shapes: a one-character secret makes "the response does not
  // contain the secret" true by accident for every response.
  surense: { clientId: 'cid_0123456789abcdef',
    clientSecret: 'csk_zzqqxx_never_in_a_response',
    tokenUrl: 'https://crm.test/oauth/token',
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
    body: 'שלום {source},\nלקוח {client} עבר ל{status}. מטפל: {assignee}\n' +
      '{message}\n{signature}',
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
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, muted_statuses, sources, ' +
    'source_names, cursors, webhook_events, sync_runs, settings');

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

// ------------------------------------------------------------ the settings

test('the settings page shows the CRM config without leaking the secret', async () => {
  const body = await (await call('/api/crm')).json();

  assert.equal(body.settings.tokenUrl, 'https://crm.test/oauth/token');
  assert.deepEqual(body.settings.apiBases, ['https://crm.test/api/v1']);
  assert.equal(body.settings.sourceCatalogPath, '/customers/sources');
  assert.equal(body.settings.mirrorLeads, false);

  // The id is masked and the secret is absent entirely — a settings page that
  // hands back the credential is not a settings page.
  assert.equal(body.settings.clientSecretSet, true);
  assert.ok(!JSON.stringify(body).includes(config.surense.clientSecret));
  assert.ok(!JSON.stringify(body).includes(config.surense.clientId));
});

test('the settings check authenticates and proves the catalog works', async () => {
  const { client } = fakeCrm();

  const probe = createApi({ db, config, fetchImpl: client.fetch });
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));

  const url = `http://127.0.0.1:${probe.address().port}/api/crm`;

  const body = await (await fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer test-token' }
  })).json();

  assert.equal(body.auth.ok, true);
  assert.equal(body.auth.scope, 'leads:read');
  assert.equal(body.apiBase, 'https://crm.test/api/v1');
  assert.equal(body.sourceCatalog.ok, true);
  assert.equal(body.sourceCatalog.sources, 1);
  assert.equal(body.sourceCatalog.example, SOURCE_TITLE);

  probe.close();
});

test('a wrong setting is reported as such, not as a mystery', async () => {
  const broken = createApi({
    db,
    config: { ...config, sourceCatalogPath: '/nope' },
    fetchImpl: fakeCrm().client.fetch
  });

  await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve));

  const body = await (await fetch(
    `http://127.0.0.1:${broken.address().port}/api/crm`,
    { method: 'POST', headers: { Authorization: 'Bearer test-token' } })).json();

  assert.equal(body.auth.ok, true);
  assert.equal(body.sourceCatalog.ok, false);
  assert.equal(body.sourceCatalog.path, '/nope');
  assert.match(body.sourceCatalog.error, /404/);

  broken.close();
});

// ------------------------------------------------- wording that needs a value

test('a message quoting an amount is held when the amount is missing', async () => {
  // "הוגשו החזרים בסך {total}" with no total is worse sent than unsent: the
  // partner gets the placeholder. No CRM field carries this today, so this is
  // the live case, not a hypothetical one.
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', leadNumber: '3500',
    statusBefore: 'בבדיקה', statusAfter: 'הוגש',
    sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({
    status: 'הוגש', message: 'הלקוח נמצא זכאי ! הוגשו החזרים בסך {total}'
  });

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', whatsapp: '', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 0);
  assert.equal(Object.keys(outbox.skipped)[0], 'message-has-an-unfilled-value');
});

test('the same message goes out once the amount is known', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', leadNumber: '3500',
    statusBefore: 'בבדיקה', statusAfter: 'הוגש',
    sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.enrichStatusEvent(id, {
    amount: '12,430 ₪', sourceState: 'resolved', sourceName: SOURCE_TITLE
  });

  await db.saveTemplate({
    status: 'הוגש', message: 'הלקוח נמצא זכאי ! הוגשו החזרים בסך {total}'
  });

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', whatsapp: '', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.match(outbox.messages[0].body, /הוגשו החזרים בסך 12,430 ₪/);
});

test('the log can be walked oldest-first as well as newest-first', async () => {
  for (let i = 0; i < 3; i++) {
    await db.recordStatusEvent({
      leadId: `lead-${i}`, customerName: `לקוח ${i}`,
      statusBefore: 'חדש', statusAfter: 'לא ענה',
      occurredAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString()
    });
  }

  const newest = await (await call('/api/dashboard/events?sort=desc')).json();
  const oldest = await (await call('/api/dashboard/events?sort=asc')).json();

  assert.deepEqual(newest.events.map(e => e.display.customer_name),
    ['לקוח 2', 'לקוח 1', 'לקוח 0']);
  assert.deepEqual(oldest.events.map(e => e.display.customer_name),
    ['לקוח 0', 'לקוח 1', 'לקוח 2']);
});

test('what went out by WhatsApp can be told from what went by email', async () => {
  const a = await db.recordStatusEvent({
    leadId: 'w1', customerName: 'בוואטסאפ', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });
  const b = await db.recordStatusEvent({
    leadId: 'e1', customerName: 'במייל', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-02T10:00:00Z'
  });

  await db.markEventsNotified([a.id], 'whatsapp', '+972500000000');
  await db.markEventsNotified([b.id], 'email', 'a@example.com');

  const whatsapp = await (await call('/api/dashboard/events?channel=whatsapp')).json();
  const email = await (await call('/api/dashboard/events?channel=email')).json();

  assert.equal(whatsapp.total, 1);
  assert.equal(whatsapp.events[0].display.customer_name, 'בוואטסאפ');
  assert.equal(whatsapp.events[0].display.channel, 'וואטסאפ');

  assert.equal(email.total, 1);
  assert.equal(email.events[0].display.channel, 'מייל');

  const counts = (await (await call('/api/dashboard/events')).json()).counts;
  assert.equal(counts.whatsapp, 1);
  assert.equal(counts.email, 1);
});

test('an empty optional field does not hold the message back', async () => {
  // A lead with no handler must still notify its source. Holding the whole
  // message over a field nobody reads would be the fix being worse than the
  // problem.
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', whatsapp: '', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.ok(!outbox.messages[0].body.includes('{'));
});

test('a template with a misspelled placeholder is held, not sent', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  // {clinet} is not a placeholder anyone defined. It must not reach a partner.
  await db.saveTemplate({ status: 'לא ענה', message: 'שלום {clinet}, אין מענה' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', whatsapp: '', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 0);
  assert.equal(Object.keys(outbox.skipped)[0], 'message-has-an-unfilled-value');
  assert.deepEqual(outbox.skipped['message-has-an-unfilled-value'].examples, ['{clinet}']);
});

// ------------------------------------------- more than one change per lead

test('only the newest status is sent when a lead moves twice', async () => {
  // A lead going 'לא ענה' then 'לא עונה 2' in one afternoon is ordinary. The
  // source wants to know where the lead IS, not to receive a transcript that
  // ends where one message would have arrived.
  const older = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  const newer = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'לא ענה',
    statusAfter: 'לא עונה 2', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T14:00:00Z'
  });

  for (const status of ['לא ענה', 'לא עונה 2']) {
    await db.saveTemplate({ status, message: `נוסח ${status}` });
  }

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.equal(outbox.messages[0].eventId, newer.id);
  assert.equal(outbox.messages[0].status, 'לא עונה 2');

  // The older one is reported as superseded, naming what went instead.
  assert.deepEqual(outbox.skipped['a-newer-status-was-sent-instead'].examples,
    ['לא עונה 2']);
  assert.ok(!outbox.messages.some(m => m.eventId === older.id));
});

test('the older changes are closed against the one that was sent', async () => {
  const older = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T09:00:00Z'
  });
  const middle = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'לא ענה', statusAfter: 'לא עונה 2',
    occurredAt: '2026-09-06T11:00:00Z'
  });
  const newest = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'לא עונה 2', statusAfter: 'לא עונה 3',
    occurredAt: '2026-09-06T14:00:00Z'
  });

  // A different lead's pending event must not be touched.
  const other = await db.recordStatusEvent({
    leadId: 'other-lead', statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T10:00:00Z'
  });

  const result = await (await call('/api/events/notified', {
    method: 'POST',
    body: JSON.stringify({ ids: [newest.id], via: 'email', to: 'roi@example.com' })
  })).json();

  assert.deepEqual(result.claimed, [newest.id]);
  assert.equal(result.superseded, 2);

  const rows = await db.listStatusEvents({});
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  // The history keeps every move, and says which one was reported.
  assert.equal(byId.get(older.id).superseded_by, newest.id);
  assert.equal(byId.get(older.id).notified_via, 'superseded');
  assert.equal(byId.get(middle.id).superseded_by, newest.id);

  assert.equal(byId.get(newest.id).notified_via, 'email');
  assert.equal(byId.get(newest.id).superseded_by, null);

  // Untouched, because it belongs to another lead.
  assert.equal(byId.get(other.id).notified_at, null);
});

test('a superseded row reads as such, not as sent and not as blocked', async () => {
  const older = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-06T09:00:00Z'
  });
  const newest = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'לא ענה',
    statusAfter: 'לא עונה 2', occurredAt: '2026-09-06T14:00:00Z'
  });

  await db.markEventsNotified([newest.id], 'email', 'roi@example.com');

  const body = await (await call('/api/dashboard/events')).json();
  const byId = new Map(body.events.map(e => [e.id, e]));

  assert.equal(byId.get(older.id).handled.state, 'superseded');
  assert.equal(byId.get(older.id).handled.label, 'נשלח הסטטוס העדכני');
  assert.equal(byId.get(newest.id).handled.state, 'sent');
});

// -------------------------------------------------- the channel per source

test('the source decides the channel, not the wording', async () => {
  await db.recordStatusEvent({
    leadId: 'w', customerName: 'א', statusBefore: 'חדש', statusAfter: 'לא ענה',
    sourceName: 'סוכן וואטסאפ', sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  // The template's own channel says email; the source is reached on WhatsApp.
  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1', channel: 'email' });
  await db.saveRecipient({
    sourceKey: 'סוכן וואטסאפ', sourceName: 'סוכן וואטסאפ',
    whatsapp: '+972542471430', channel: 'whatsapp', active: true
  });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.equal(outbox.messages[0].channel, 'whatsapp');
  assert.equal(outbox.messages[0].to, '+972542471430');
});

test('the log shows the channel a message would use before it is sent', async () => {
  await db.recordStatusEvent({
    leadId: 'w', customerName: 'א', statusBefore: 'חדש', statusAfter: 'לא ענה',
    sourceName: 'סוכן וואטסאפ', sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({
    sourceKey: 'סוכן וואטסאפ', sourceName: 'סוכן וואטסאפ',
    whatsapp: '+972542471430', channel: 'whatsapp', active: true
  });

  const body = await (await call('/api/dashboard/events')).json();

  assert.equal(body.events[0].display.channel, 'וואטסאפ');
  assert.equal(body.events[0].handled.state, 'pending');
});

// ---------------------------------------------------- the shipped lists

test('the recipient list is seeded once and then owned by the dashboard', async () => {
  const { SEED_RECIPIENTS } = await import('../src/notify/recipients-seed.js');

  const written = await db.seedRecipients(SEED_RECIPIENTS);
  assert.equal(written, SEED_RECIPIENTS.length);

  // A second boot must not undo an address corrected in the dashboard.
  await db.saveRecipient({
    sourceKey: normalizeText(SEED_RECIPIENTS[0].sourceName),
    sourceName: SEED_RECIPIENTS[0].sourceName,
    email: 'corrected@example.com', channel: 'email', active: true
  });

  assert.equal(await db.seedRecipients(SEED_RECIPIENTS), 0);

  const rows = await db.listRecipients();
  const corrected = rows.find(r =>
    normalizeText(r.source_name) === normalizeText(SEED_RECIPIENTS[0].sourceName));

  assert.equal(corrected.email, 'corrected@example.com');
});

test('a source with no address is kept, silent and visible', async () => {
  const { SEED_RECIPIENTS } = await import('../src/notify/recipients-seed.js');
  await db.seedRecipients(SEED_RECIPIENTS);

  const body = await (await call('/api/dashboard/recipients')).json();

  assert.equal(body.total, SEED_RECIPIENTS.length);
  assert.ok(body.email > 90);
  assert.ok(body.whatsapp > 20);

  // Real sources with real volume that nobody has an address for. Dropping
  // them would make them look like an oversight instead of a known gap.
  assert.ok(body.noAddress > 0);

  const campaign = body.recipients.find(r => r.source_name === 'קמפיין');
  assert.equal(campaign.channel, '');
  assert.equal(campaign.leads, 485);
});

test('the policy tab reports wording that contradicts the muted list', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);
  await db.seedMutedStatuses(MUTED_FOR_TEST);

  // 'חדש' is muted. Wording for it would send, so the contradiction is named.
  await db.saveTemplate({ status: 'חדש', message: 'לא אמור לצאת' });

  const body = await (await call('/api/dashboard/policy')).json();

  assert.ok(body.muted.some(m => m.status === 'חדש'));
  assert.deepEqual(body.conflicts, ['חדש']);
});

test('an edited template is marked as differing from the shipped one', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);
  await db.saveTemplate({ status: 'לא ענה', message: 'נוסח חדש שלי' });

  const body = await (await call('/api/dashboard/policy')).json();
  const row = body.templates.find(t => t.status === 'לא ענה');

  assert.equal(row.edited, true);
  assert.equal(row.shipped, 'ניסינו ליצור קשר עם הלקוח אין מענה 1');
});

// ------------------------------------------------- handled outside the code

test('an event marked handled by hand leaves the queue', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 1);

  const marked = await (await call('/api/events/manual', {
    method: 'POST',
    body: JSON.stringify({ ids: [id], note: 'נשלח ידנית בוואטסאפ' })
  })).json();

  assert.deepEqual(marked.marked, [id]);

  // The automation must not pick it up again.
  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 0);
});

test('a hand-marked event is never recorded as sent', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-06T13:25:41Z'
  });

  await call('/api/events/manual', {
    method: 'POST', body: JSON.stringify({ ids: [id], note: 'דיברתי איתו' })
  });

  const body = await (await call('/api/dashboard/events')).json();
  const row = body.events.find(e => e.id === id);

  // The log must never claim we sent something we did not.
  assert.equal(row.handled.state, 'manual');
  assert.equal(row.handled.label, 'טופל ידנית');
  assert.equal(row.handled.reason, 'דיברתי איתו');

  assert.equal(body.counts.manual, 1);
  assert.equal(body.counts.sent, 0);
});

test('a hand-marked event can be put back in the queue', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  await call('/api/events/manual', { method: 'POST', body: JSON.stringify({ ids: [id] }) });

  const undone = await (await call('/api/events/manual/undo', {
    method: 'POST', body: JSON.stringify({ ids: [id] })
  })).json();

  assert.deepEqual(undone.restored, [id]);
  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 1);
});

test('a message that really went out cannot be un-sent', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.markEventsNotified([id], 'email', 'roi@example.com');

  // Clearing this would not recall the email — it would send a second one.
  const undone = await (await call('/api/events/manual/undo', {
    method: 'POST', body: JSON.stringify({ ids: [id] })
  })).json();

  assert.deepEqual(undone.restored, []);
  assert.deepEqual(undone.refused, [id]);

  const [event] = await db.listStatusEvents({});
  assert.equal(event.notified_via, 'email');
  assert.ok(event.notified_at);
});

test('handled-by-hand is its own filter, apart from sent', async () => {
  const a = await db.recordStatusEvent({
    leadId: 'm1', customerName: 'ידני', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });
  const b = await db.recordStatusEvent({
    leadId: 's1', customerName: 'נשלח', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-02T10:00:00Z'
  });

  await db.markEventsManual([a.id], 'טופל');
  await db.markEventsNotified([b.id], 'email', 'a@b.c');

  const manual = await (await call('/api/dashboard/events?delivery=manual')).json();
  const sent = await (await call('/api/dashboard/events?delivery=sent')).json();

  assert.deepEqual(manual.events.map(e => e.display.customer_name), ['ידני']);
  assert.deepEqual(sent.events.map(e => e.display.customer_name), ['נשלח']);
});

test('the channel column never shows an outcome as a channel', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  await db.markEventsManual([id], 'דיברתי איתו');

  const body = await (await call('/api/dashboard/events')).json();

  // "manual" is what happened, not how it would have gone out.
  assert.equal(body.events[0].display.channel, 'מייל');
  assert.equal(body.events[0].handled.state, 'manual');
});


// -------------------------------------------------- the policy is editable

test('wording added to the code later still reaches an existing database', async () => {
  // The seed only writes into an EMPTY table, which is right: it must never
  // undo an edit. But it also means a status given wording after the first
  // boot could never arrive — the table is not empty, so the seed is skipped
  // forever and that status stays silent with nobody able to tell that from
  // a decision. This is the half that was missing.
  await db.seedTemplates([SEED_TEMPLATES_FOR_TEST[0]]);
  assert.equal((await db.listTemplates()).length, 1);

  // A second seed does nothing, because the table is not empty.
  assert.equal(await db.seedTemplates(SEED_TEMPLATES_FOR_TEST), 0);

  const { added } = await db.addMissingTemplates(SEED_TEMPLATES_FOR_TEST);

  assert.equal(added.length, SEED_TEMPLATES_FOR_TEST.length - 1);
  assert.equal((await db.listTemplates()).length, SEED_TEMPLATES_FOR_TEST.length);
});

test('adding the missing wording never overwrites an edit', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);
  await db.saveTemplate({ status: 'לא ענה', message: 'הנוסח שלי' });

  await db.addMissingTemplates(SEED_TEMPLATES_FOR_TEST);

  const row = (await db.listTemplates()).find(t => t.status === 'לא ענה');
  assert.equal(row.message, 'הנוסח שלי');
});

test('the policy tab names the wording that never arrived', async () => {
  await db.seedTemplates([SEED_TEMPLATES_FOR_TEST[0]]);

  const body = await (await call('/api/dashboard/policy')).json();

  assert.equal(body.templates.length, 1);
  assert.equal(body.missing.length, SEED_TEMPLATES_FOR_TEST.length - 1);

  const synced = await (await call('/api/templates/sync', { method: 'POST' })).json();
  assert.equal(synced.addedCount, SEED_TEMPLATES_FOR_TEST.length - 1);

  const after = await (await call('/api/dashboard/policy')).json();
  assert.deepEqual(after.missing, []);
});

test('a status can be muted and unmuted from the API', async () => {
  await db.seedMutedStatuses(['חדש']);

  const added = await (await call('/api/muted', {
    method: 'PUT', body: JSON.stringify({ status: 'סטטוס חדש שלי', note: 'לא רלוונטי' })
  })).json();

  assert.equal(added.saved, 1);
  assert.ok(added.muted.some(m => m.status === 'סטטוס חדש שלי'));

  const removed = await call('/api/muted/' + encodeURIComponent('סטטוס חדש שלי'),
    { method: 'DELETE' });

  assert.equal(removed.status, 200);

  const body = await (await call('/api/dashboard/policy')).json();
  assert.ok(!body.muted.some(m => m.status === 'סטטוס חדש שלי'));
});

test('muting a status that has wording is reported, not silently ignored', async () => {
  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });

  const result = await (await call('/api/muted', {
    method: 'PUT', body: JSON.stringify({ status: 'לא ענה' })
  })).json();

  // The wording wins at send time, so muting it does nothing — worth saying.
  assert.deepEqual(result.conflicts, ['לא ענה']);
});

test('a status nobody classified is listed, and sends nothing', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);
  await db.seedMutedStatuses(MUTED_FOR_TEST);

  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'סטטוס שהומצא ב-CRM', sourceName: SOURCE_TITLE,
    sourceState: 'resolved', occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  const body = await (await call('/api/dashboard/policy')).json();

  assert.deepEqual(body.unclassified,
    [{ status: 'סטטוס שהומצא ב-CRM', events: 1 }]);

  // Already silent — the allowlist is closed. Listing it makes that a choice.
  const outbox = await (await call('/api/outbox')).json();
  assert.equal(outbox.readyToSend, 0);
  assert.equal(Object.keys(outbox.skipped)[0], 'no-template');
});

test('a status given wording from the dashboard starts sending', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'סטטוס משלי', sourceName: SOURCE_TITLE,
    sourceState: 'resolved', occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 0);

  await call('/api/templates', {
    method: 'PUT',
    body: JSON.stringify([{ status: 'סטטוס משלי', message: 'נוסח שכתבתי באתר' }])
  });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.match(outbox.messages[0].body, /נוסח שכתבתי באתר/);
});

test('a status can be added before its wording is written', async () => {
  const response = await call('/api/templates', {
    method: 'PUT', body: JSON.stringify([{ status: 'סטטוס חדש שלי' }])
  });

  assert.equal(response.status, 200);

  const row = (await db.listTemplates()).find(t => t.status === 'סטטוס חדש שלי');

  // Stored, but never sendable while it has no text.
  assert.equal(row.message, '');
  assert.equal(row.active, false);
});

test('an empty template never sends, even if switched on', async () => {
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'ריק', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  // Forced on directly in the database, bypassing the guard on the way in.
  await db.saveTemplate({ status: 'ריק', message: '   ', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 0);
  assert.equal(Object.keys(outbox.skipped)[0], 'no-template');
});

// ------------------------------------------------ wording that drifted

test('wording that differs from the code is reported, not overwritten', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);

  // Exactly what production had: an older, shorter text for this status.
  await db.saveTemplate({ status: 'ממתין לת.ז', message: 'ממתין לת.ז' });

  const body = await (await call('/api/dashboard/policy')).json();
  const row = body.templates.find(t => t.status === 'ממתין לת.ז');

  assert.equal(row.edited, true);
  assert.equal(row.message, 'ממתין לת.ז');
  assert.equal(row.shipped, 'ממתין לאמצעי זיהוי מהלקוח');

  // Adding what is missing must not touch it — only a person decides.
  await db.addMissingTemplates(SEED_TEMPLATES_FOR_TEST);
  assert.equal((await db.listTemplates())
    .find(t => t.status === 'ממתין לת.ז').message, 'ממתין לת.ז');
});

test('a drifted template can be put back to the shipped wording', async () => {
  await db.seedTemplates(SEED_TEMPLATES_FOR_TEST);
  await db.saveTemplate({ status: 'ממתין לת.ז', message: 'ממתין לת.ז' });

  const result = await (await call('/api/templates/restore', {
    method: 'POST', body: JSON.stringify({ statuses: ['ממתין לת.ז'] })
  })).json();

  assert.deepEqual(result.restored, ['ממתין לת.ז']);

  const row = (await db.listTemplates()).find(t => t.status === 'ממתין לת.ז');
  assert.equal(row.message, 'ממתין לאמצעי זיהוי מהלקוח');
});

test('a status the code has no wording for cannot be restored', async () => {
  const result = await (await call('/api/templates/restore', {
    method: 'POST', body: JSON.stringify({ statuses: ['סטטוס שהמצאתי באתר'] })
  })).json();

  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.unknown, ['סטטוס שהמצאתי באתר']);
});

// ----------------------------------------------------- the row's own state

test('a row can be set to never send, and back to the queue', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 1);

  await call('/api/events/state', {
    method: 'POST',
    body: JSON.stringify({ ids: [id], state: 'skipped', note: 'לא רלוונטי' })
  });

  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 0);

  let row = (await (await call('/api/dashboard/events')).json()).events[0];
  assert.equal(row.handled.state, 'skipped');
  // Worded apart from 'blocked', which is also "will not be sent" — one is a
  // decision, the other is something in the way.
  assert.equal(row.handled.label, 'הוחלט לא לשלוח');
  assert.notEqual(row.handled.label, DELIVERY_LABELS_FOR_TEST.blocked);
  assert.equal(row.handled.reason, 'לא רלוונטי');

  // Back into the queue, so it goes out on the next run.
  await call('/api/events/state', {
    method: 'POST', body: JSON.stringify({ ids: [id], state: 'queued' })
  });

  assert.equal((await (await call('/api/outbox')).json()).readyToSend, 1);

  row = (await (await call('/api/dashboard/events')).json()).events[0];
  assert.equal(row.handled.state, 'pending');
});

test('a sent row cannot be pushed back into the queue', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  await db.markEventsNotified([id], 'email', 'roi@example.com');

  const result = await (await call('/api/events/state', {
    method: 'POST', body: JSON.stringify({ ids: [id], state: 'queued' })
  })).json();

  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.refused, [id]);
});

test('an unknown state is refused rather than guessed at', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, statusBefore: 'חדש', statusAfter: 'לא ענה',
    occurredAt: '2026-09-06T13:25:41Z'
  });

  const response = await call('/api/events/state', {
    method: 'POST', body: JSON.stringify({ ids: [id], state: 'sent' })
  });

  // 'sent' is not something a person may set: the log records what happened.
  assert.equal(response.status, 400);
});

test('the event id is on the row, so a sent message can be traced back', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-06T13:25:41Z'
  });

  const body = await (await call('/api/dashboard/events')).json();

  assert.equal(body.events[0].display.id, String(id));
  assert.equal(body.events[0].id, id);
});

test('the channel comes from the source even when the template disagrees', async () => {
  await db.recordStatusEvent({
    leadId: 'w', customerName: 'א', statusBefore: 'חדש', statusAfter: 'לא ענה',
    sourceName: 'סוכן וואטסאפ', sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  // The template says email; the source is only reachable on WhatsApp. The
  // template has no say — a per-message channel could only contradict the
  // address the source actually has.
  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1', channel: 'email' });
  await db.saveRecipient({
    sourceKey: 'סוכן וואטסאפ', sourceName: 'סוכן וואטסאפ',
    whatsapp: '+972542471430', channel: 'whatsapp', active: true
  });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.messages[0].channel, 'whatsapp');
  assert.equal(outbox.messages[0].to, '+972542471430');
});

test('a source with no address is skipped, never guessed onto a channel', async () => {
  await db.recordStatusEvent({
    leadId: 'n', customerName: 'א', statusBefore: 'חדש', statusAfter: 'לא ענה',
    sourceName: 'קמפיין', sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1', channel: 'email' });
  await db.saveRecipient({ sourceKey: 'קמפיין', sourceName: 'קמפיין', active: true });

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 0);
  assert.equal(Object.keys(outbox.skipped)[0], 'recipient-has-no-address');
});

// ----------------------------------------- waiting to be sent vs stuck

test('"waiting to be sent" means only what the sender would actually send', async () => {
  // Three unsent events: one sendable, one with no wording, one whose source
  // has no address. All three are "not handled yet", and reporting them as
  // one number is what makes a queue of 139 read as 139 about to go out.
  const ready = await db.recordStatusEvent({
    leadId: 'r1', customerName: 'יישלח', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-03T10:00:00Z'
  });

  const noWording = await db.recordStatusEvent({
    leadId: 'b1', customerName: 'אין נוסח', statusBefore: 'חדש',
    statusAfter: 'סטטוס בלי נוסח', sourceName: SOURCE_TITLE,
    sourceState: 'resolved', occurredAt: '2026-09-02T10:00:00Z'
  });

  const noAddress = await db.recordStatusEvent({
    leadId: 'b2', customerName: 'אין כתובת', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: 'קמפיין', sourceState: 'resolved',
    occurredAt: '2026-09-01T10:00:00Z'
  });

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });
  await db.saveRecipient({ sourceKey: 'קמפיין', sourceName: 'קמפיין', active: true });

  const all = await (await call('/api/dashboard/events')).json();

  assert.equal(all.counts.open, 3);
  assert.equal(all.counts.ready, 1);
  assert.equal(all.counts.blocked, 2);

  const readyOnly = await (await call('/api/dashboard/events?delivery=ready')).json();
  assert.equal(readyOnly.total, 1);
  assert.deepEqual(readyOnly.events.map(e => e.id), [ready.id]);

  const blockedOnly = await (await call('/api/dashboard/events?delivery=blocked')).json();
  assert.equal(blockedOnly.total, 2);
  assert.deepEqual(blockedOnly.events.map(e => e.id).sort(),
    [noWording.id, noAddress.id].sort());
});

test('the ready filter agrees with the outbox exactly', async () => {
  for (const [lead, status, source] of [
    ['a', 'לא ענה', SOURCE_TITLE],
    ['b', 'לא ענה', 'קמפיין'],
    ['c', 'סטטוס בלי נוסח', SOURCE_TITLE]
  ]) {
    await db.recordStatusEvent({
      leadId: lead, customerName: lead, statusBefore: 'חדש', statusAfter: status,
      sourceName: source, sourceState: 'resolved',
      occurredAt: `2026-09-0${lead === 'a' ? 1 : lead === 'b' ? 2 : 3}T10:00:00Z`
    });
  }

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });
  await db.saveRecipient({ sourceKey: 'קמפיין', sourceName: 'קמפיין', active: true });

  const outbox = await (await call('/api/outbox')).json();
  const screen = await (await call('/api/dashboard/events?delivery=ready')).json();

  // The screen and the sender must never disagree about this.
  assert.equal(screen.total, outbox.readyToSend);
  assert.deepEqual(
    screen.events.map(e => e.id).sort(),
    outbox.messages.map(m => m.eventId).sort());
});

test('no ready rows returns nothing, not everything', async () => {
  // An empty id set must mean "none match", not "no filter applied".
  await db.recordStatusEvent({
    leadId: 'x', customerName: 'חסום', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });

  const readyOnly = await (await call('/api/dashboard/events?delivery=ready')).json();

  assert.equal(readyOnly.total, 0);
  assert.deepEqual(readyOnly.events, []);
});

test('a blocked row becomes ready once what blocked it is fixed', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: 'f1', customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-01T10:00:00Z'
  });

  // No wording yet.
  let body = await (await call('/api/dashboard/events?delivery=blocked')).json();
  assert.deepEqual(body.events.map(e => e.id), [id]);

  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  body = await (await call('/api/dashboard/events?delivery=ready')).json();
  assert.deepEqual(body.events.map(e => e.id), [id]);

  body = await (await call('/api/dashboard/events?delivery=blocked')).json();
  assert.deepEqual(body.events, []);
});

test('the ready filter pages on its own total', async () => {
  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
  await db.saveRecipient({ sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
    email: 'roi@example.com', channel: 'email', active: true });

  for (let i = 0; i < 5; i++) {
    await db.recordStatusEvent({
      leadId: `p${i}`, customerName: `לקוח ${i}`, statusBefore: 'חדש',
      statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
      occurredAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString()
    });
  }

  // And two that are stuck, which must not inflate the ready total.
  for (let i = 0; i < 2; i++) {
    await db.recordStatusEvent({
      leadId: `q${i}`, customerName: `חסום ${i}`, statusBefore: 'חדש',
      statusAfter: 'סטטוס בלי נוסח', occurredAt: `2026-08-0${i + 1}T10:00:00Z`
    });
  }

  const page = await (await call('/api/dashboard/events?delivery=ready&limit=2')).json();

  assert.equal(page.total, 5);
  assert.equal(page.events.length, 2);
  assert.equal(page.counts.blocked, 2);
});

test('search finds a row by its event number', async () => {
  const a = await db.recordStatusEvent({
    leadId: 'e1', customerName: 'ראשון', leadNumber: '5000',
    statusBefore: 'חדש', statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });
  const b = await db.recordStatusEvent({
    leadId: 'e2', customerName: 'שני', leadNumber: '5001',
    statusBefore: 'חדש', statusAfter: 'לא ענה', occurredAt: '2026-09-02T10:00:00Z'
  });

  const found = await (await call('/api/dashboard/events?search=' + a.id)).json();

  assert.equal(found.total, 1);
  assert.deepEqual(found.events.map(e => e.id), [a.id]);
  assert.ok(b.id !== a.id);
});

test('an event number matches exactly, not as a substring', async () => {
  // Otherwise searching for event 1 would drag in 10, 100 and 1000.
  const rows = [];

  for (let i = 0; i < 3; i++) {
    rows.push(await db.recordStatusEvent({
      leadId: `s${i}`, customerName: `לקוח ${i}`, statusBefore: 'חדש',
      statusAfter: 'לא ענה', occurredAt: `2026-09-0${i + 1}T10:00:00Z`
    }));
  }

  const target = rows[0].id;
  const found = await (await call('/api/dashboard/events?search=' + target)).json();

  assert.deepEqual(found.events.map(e => e.id), [target]);
});

test('searching a number still finds a lead number too', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: 'L', customerName: 'אלון ברמן', leadNumber: '3313',
    statusBefore: 'חדש', statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });

  const found = await (await call('/api/dashboard/events?search=3313')).json();

  // The lead number matches even though it is not this row's event id.
  assert.deepEqual(found.events.map(e => e.id), [id]);
});

test('search by event number works alongside the other filters', async () => {
  const { id } = await db.recordStatusEvent({
    leadId: 'z', customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', occurredAt: '2026-09-01T10:00:00Z'
  });

  await db.markEventsManual([id], 'טופל');

  const wrong = await (await call(
    `/api/dashboard/events?search=${id}&delivery=sent`)).json();
  assert.equal(wrong.total, 0);

  const right = await (await call(
    `/api/dashboard/events?search=${id}&delivery=manual`)).json();
  assert.deepEqual(right.events.map(e => e.id), [id]);
});

test('a pending row superseded by a newer one says so in the future tense', async () => {
  // Nothing has gone out for either yet, so "נשלח" would be a claim about a
  // message that does not exist.
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-01T10:00:00Z'
  });
  const newer = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'לא ענה',
    statusAfter: 'לא עונה 2', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-02T10:00:00Z'
  });

  const older = (await (await call('/api/dashboard/events?sort=asc')).json()).events[0];

  assert.equal(older.handled.state, 'blocked');
  assert.equal(older.handled.reason, 'יישלח במקומו הסטטוס העדכני');

  // And once the newer one really goes out, the older one speaks in the past.
  await db.markEventsNotified([newer.id], 'email', 'roi@example.com');

  const after = (await (await call('/api/dashboard/events?sort=asc')).json()).events[0];
  assert.equal(after.handled.state, 'superseded');
  assert.equal(after.handled.label, 'נשלח הסטטוס העדכני');
});

// ------------------------------------------------ a copy of what went out

/** A resolved event with wording and an address: the ready-to-send shape. */
function sendable(overrides = {}) {
  return buildEventOutbox({
    events: [{
      id: 1, lead_id: LEAD, customer_name: 'אלון ברמן', assignee_name: 'שי נגר',
      status_before: 'חדש', status_after: 'לא ענה', source_name: SOURCE_TITLE,
      source_state: 'resolved', amount: '', occurred_at: '2026-09-06T09:00:00Z'
    }],
    templates: new Map([[normalizeText('לא ענה'),
      { status: 'לא ענה', message: 'אין מענה 1', active: true }]]),
    recipients: new Map([[normalizeText(SOURCE_TITLE),
      { source_name: SOURCE_TITLE, email: 'roi@example.com',
        channel: 'email', active: true }]]),
    messaging: { ...config.messaging, ...overrides }
  });
}

test('a copy address is added alongside the source, not instead of it', () => {
  const { ready } = sendable({ copyTo: 'shai@example.com' });

  // The distinction that matters: the partner still receives the message.
  assert.equal(ready[0].to, 'roi@example.com');
  assert.equal(ready[0].copyTo, 'shai@example.com');
  assert.equal(ready[0].redirected, false);
});

test('with no copy address set the message carries none', () => {
  assert.equal(sendable({ copyTo: '' }).ready[0].copyTo, null);
});

test('a pilot redirect leaves no copy to make', () => {
  // Everything is already going to one address, so a "copy" would be the
  // only message there is — and it would read as if a source had been told.
  const { ready } = sendable({
    copyTo: 'shai@example.com', redirectAllTo: 'shai@example.com'
  });

  assert.equal(ready[0].to, 'shai@example.com');
  assert.equal(ready[0].intendedFor, 'roi@example.com');
  assert.equal(ready[0].copyTo, null);
});

test('the outbox response always states the copy address', async () => {
  const body = await (await call('/api/outbox')).json();

  // Stated on every response for the same reason as the redirect: whoever
  // sends must never have to guess who else is being shown the message.
  assert.ok('copyTo' in body);
  assert.equal(body.copyTo, null);
});

// ----------------------------------------------- the amount in the wording

test('the amount is read out of the custom fields, not off the row', async () => {
  const { readConfiguredValue } = await import('../src/events/enrich.js');

  // The shape the CRM really returns: no named column, a list of ids.
  const lead = {
    fullName: 'עומרי מיטב',
    customFields: [
      { fieldId: '22ebc08e-f66e-4ca2-b13e-c6e331a2f17d', type: 6, value: 'הוגש ( 10 )' },
      { fieldId: '523c2e8e-fdc5-4200-8b65-b64e89da588b', type: 6, value: '18,250' }
    ]
  };

  const client = {
    customFieldIds: async () => new Map([
      ['2020', '22ebc08e-f66e-4ca2-b13e-c6e331a2f17d'],
      ['סך הכל', '523c2e8e-fdc5-4200-8b65-b64e89da588b']
    ])
  };

  // By the name a person would write in the setting.
  assert.equal(await readConfiguredValue(lead, client, 'סך הכל'), '18,250');

  // And by the id, for anyone who prefers the thing that cannot be renamed.
  assert.equal(
    await readConfiguredValue(lead, client, '523c2e8e-fdc5-4200-8b65-b64e89da588b'),
    '18,250');

  // A plain field still wins and costs no schema call at all.
  assert.equal(
    await readConfiguredValue(lead, { customFieldIds: async () => {
      throw new Error('must not be called');
    } }, 'fullName'),
    'עומרי מיטב');
});

test('a schema that will not load holds the message instead of guessing', async () => {
  const { readConfiguredValue } = await import('../src/events/enrich.js');

  const amount = await readConfiguredValue(
    { customFields: [{ fieldId: 'x', value: '18,250' }] },
    { customFieldIds: async () => { throw new Error('403'); } },
    'סך הכל');

  // Empty holds the message. The other direction would send a number that
  // came from whichever custom field happened to be first.
  assert.equal(amount, '');
});

test('only a real amount is allowed into "בסך"', async () => {
  const { isSendableAmount } = await import('../src/notify/outbox.js');

  for (const good of ['18,250', '7700', '₪5,690', '1,200.50']) {
    assert.equal(isSendableAmount(good), true, good);
  }

  // All three are real values sitting in the CRM's free-text "סך הכל" today.
  for (const bad of ['', '16,400 / 23,200', '- 140', '0', 'בבדיקה']) {
    assert.equal(isSendableAmount(bad), false, bad);
  }
});

test('an amount nobody can send is held and quoted, not sent', () => {
  const held = buildEventOutbox({
    events: [{
      id: 9, lead_id: LEAD, customer_name: 'אלון ברמן', status_before: 'בטיפול',
      status_after: 'הוגש', source_name: SOURCE_TITLE, source_state: 'resolved',
      amount: '16,400 / 23,200', occurred_at: '2026-09-06T09:00:00Z'
    }],
    templates: new Map([[normalizeText('הוגש'),
      { status: 'הוגש', message: 'הוגשו החזרים בסך {total}', active: true }]]),
    recipients: new Map([[normalizeText(SOURCE_TITLE),
      { source_name: SOURCE_TITLE, email: 'roi@example.com',
        channel: 'email', active: true }]]),
    messaging: config.messaging
  });

  assert.equal(held.ready.length, 0);
  assert.equal(held.skipped[0].reason, SKIP.unfilled);

  // The value is quoted so whoever fixes it knows what the CRM actually says.
  assert.equal(held.skipped[0].detail, 'סך הכל: 16,400 / 23,200');
});

test('the backfill fills amounts on events that resolved without one', async () => {
  const { backfillAmounts } = await import('../src/events/enrich.js');

  await db.saveTemplate({
    status: 'הוגש', message: 'הוגשו החזרים בסך {total}', channel: 'email' });
  await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1', channel: 'email' });

  const quoting = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'בטיפול',
    statusAfter: 'הוגש', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  // A status whose wording quotes nothing must not cost a CRM request.
  await db.recordStatusEvent({
    leadId: 'other', customerName: 'דנה', statusBefore: 'חדש',
    statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  const read = [];
  const client = {
    fetchLeadById: async (id) => {
      read.push(id);
      return { customFields: [
        { fieldId: '523c2e8e-fdc5-4200-8b65-b64e89da588b', value: '18,250' }] };
    },
    customFieldIds: async () =>
      new Map([['סך הכל', '523c2e8e-fdc5-4200-8b65-b64e89da588b']])
  };

  const summary = await backfillAmounts({
    db, client,
    config: { messaging: { columns: { ...COLUMNS, total: 'סך הכל' } } }
  });

  assert.deepEqual(read, [LEAD], 'only the status that quotes an amount');
  assert.equal(summary.filled, 1);

  const [row] = await db.listStatusEvents({ ids: [quoting.id] });
  assert.equal(row.amount, '18,250');
});

test('with no amount column configured the backfill reads no leads at all', async () => {
  const { backfillAmounts } = await import('../src/events/enrich.js');

  await db.saveTemplate({
    status: 'הוגש', message: 'הוגשו החזרים בסך {total}', channel: 'email' });
  await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'בטיפול',
    statusAfter: 'הוגש', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  const summary = await backfillAmounts({
    db,
    client: { fetchLeadById: async () => assert.fail('must not read the CRM') },
    config: { messaging: { columns: { ...COLUMNS, total: '' } } }
  });

  assert.equal(summary.processed, 0);
  assert.equal(summary.column, null);
});

// ------------------------------------------- the switch a person can reach

test('the pilot redirect can be turned off from the dashboard', async () => {
  // The service boots with a redirect in the environment, as production does.
  const piloted = createApi({
    db, fetchImpl: fetch,
    config: { ...config,
      messaging: { ...config.messaging, redirectAllTo: 'shai@example.com' } }
  });

  const server = piloted.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options) => fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: 'Bearer test-token',
      'Content-Type': 'application/json', ...(options?.headers ?? {}) }
  });

  try {
    const before = await (await call('/api/settings/delivery')).json();
    assert.equal(before.live, false, 'the environment starts it in pilot mode');
    assert.equal(before.redirectAllTo, 'shai@example.com');
    assert.equal(before.source.redirectAllTo, 'environment');

    const saved = await (await call('/api/settings/delivery', {
      method: 'PUT', body: JSON.stringify({ live: true, copyTo: 'shai@example.com' })
    })).json();

    assert.equal(saved.live, true);
    assert.equal(saved.redirectAllTo, '', 'going live clears the redirect');

    // The point of the whole thing: the sender now addresses the source.
    await db.recordStatusEvent({
      leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חדש',
      statusAfter: 'לא ענה', sourceName: SOURCE_TITLE, sourceState: 'resolved',
      occurredAt: '2026-09-06T09:00:00Z'
    });
    await db.saveTemplate({ status: 'לא ענה', message: 'אין מענה 1' });
    await db.saveRecipient({
      sourceKey: SOURCE_TITLE, sourceName: SOURCE_TITLE,
      email: 'roi@example.com', active: true
    });

    const outbox = await (await call('/api/outbox')).json();

    assert.equal(outbox.redirectAllTo, null, 'the stored value wins over the env');
    assert.equal(outbox.messages[0].to, 'roi@example.com');
    assert.equal(outbox.messages[0].copyTo, 'shai@example.com',
      'and the copy is added alongside, not instead');

    // And the source of each value is reported, so a setting that will not
    // budge is explicable rather than mysterious.
    const after = await (await call('/api/settings/delivery')).json();
    assert.equal(after.source.redirectAllTo, 'dashboard');
  } finally {
    server.close();
  }
});

test('turning the pilot back on needs an address, or it sends to nowhere', async () => {
  const refused = await call('/api/settings/delivery', {
    method: 'PUT', body: JSON.stringify({ live: false })
  });

  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /address/);

  const ok = await (await call('/api/settings/delivery', {
    method: 'PUT',
    body: JSON.stringify({ live: false, redirectAllTo: 'shai@example.com' })
  })).json();

  assert.equal(ok.live, false);
  assert.equal(ok.redirectAllTo, 'shai@example.com');
});

test('a delivery address that is not an address is refused', async () => {
  const bad = await call('/api/settings/delivery', {
    method: 'PUT', body: JSON.stringify({ copyTo: 'not-an-email' })
  });

  assert.equal(bad.status, 400);

  // And nothing was stored, so a typo cannot leave the setting half-changed.
  const now = await (await call('/api/settings/delivery')).json();
  assert.equal(now.copyTo, '');
});

test('an empty settings table leaves the environment in charge', async () => {
  const body = await (await call('/api/settings/delivery')).json();

  assert.equal(body.source.redirectAllTo, 'environment');
  assert.equal(body.source.copyTo, 'environment');
  assert.equal(body.live, true, 'this test config has no redirect set');
});

test('the amount column is set from the dashboard, not the environment', async () => {
  const saved = await (await call('/api/settings/delivery', {
    method: 'PUT', body: JSON.stringify({ totalColumn: 'סך הכל' })
  })).json();

  assert.equal(saved.totalColumn, 'סך הכל');

  const now = await (await call('/api/settings/delivery')).json();
  assert.equal(now.source.totalColumn, 'dashboard');

  // The nested column map survives: a flat merge would have replaced all six
  // column names with this one key and broken every other lookup.
  const probe = await (await call('/api/settings/delivery')).json();
  assert.equal(probe.totalColumn, 'סך הכל');

  // And the backfill now has a column to read, where before it had none.
  const { backfillAmounts } = await import('../src/events/enrich.js');

  await db.saveTemplate({
    status: 'הוגש', message: 'הוגשו החזרים בסך {total}', channel: 'email' });
  const held = await db.recordStatusEvent({
    leadId: LEAD, customerName: 'אלון ברמן', statusBefore: 'חתימה',
    statusAfter: 'הוגש', sourceName: SOURCE_TITLE, sourceState: 'resolved',
    occurredAt: '2026-09-06T09:00:00Z'
  });

  const summary = await backfillAmounts({
    db,
    client: {
      fetchLeadById: async () => ({ customFields: [{ fieldId: 'f1', value: '18,250' }] }),
      customFieldIds: async () => new Map([['סך הכל', 'f1']])
    },
    config: { messaging: { columns: { ...COLUMNS, total: now.totalColumn } } }
  });

  assert.equal(summary.filled, 1);
  assert.equal((await db.listStatusEvents({ ids: [held.id] }))[0].amount, '18,250');
});

test('a column name is not required to be an email address', async () => {
  // The same endpoint carries two addresses and one field name, and the
  // address check must not reject the field name for lacking an "@".
  const ok = await call('/api/settings/delivery', {
    method: 'PUT', body: JSON.stringify({ totalColumn: 'סך הכל' })
  });

  assert.equal(ok.status, 200);
});
