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
import { SEED_TEMPLATES as SEED_TEMPLATES_FOR_TEST } from '../src/notify/seeds.js';
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

  // 'חדש' is muted. Wording for it would send, so the contradiction is named.
  await db.saveTemplate({ status: 'חדש', message: 'לא אמור לצאת' });

  const body = await (await call('/api/dashboard/policy')).json();

  assert.ok(body.muted.includes('חדש'));
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
