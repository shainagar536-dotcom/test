/**
 * End-to-end tests against a real Postgres and a stubbed CRM.
 *
 * Only the CRM is faked: the database, the sync, the HTTP server and the
 * routing are the real ones, so what passes here is what runs on Render.
 *
 * Point DATABASE_URL at a throwaway database — every test truncates it.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { runSync } from '../src/sync/run.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const config = {
  surense: {
    clientId: 'cid_test',
    clientSecret: 'secret',
    tokenUrl: 'https://crm.test/oauth/token',
    apiBases: ['https://crm.test/api/v1'],
    pageSize: 50,
    maxPages: 40
  },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook-secret' },
  sync: {
    timeZone: 'Asia/Jerusalem',
    idKey: 'id',
    intervalMinutes: 60,
    activeDays: [0, 1, 2, 3, 4, 5],
    activeHours: [8, 20],
    shrinkGuard: 0.5
  }
};

// ------------------------------------------------------------- the fake CRM
const FIELDS = [
  { key: 'leadNumber', label: 'מספר ליד' },
  { key: 'id', label: 'מזהה' },
  { key: 'name', label: 'שם הלקוח' },
  { key: 'statusName', label: 'סטטוס' },
  { key: 'sourceName', label: 'מקור מפנה' }
];

let crmLeads = [];
let sourcesFail = false;

const lead = (n, status = 'לא ענה') => ({
  id: `ld_${n}`,
  leadNumber: String(8800 + n),
  name: `לקוח ${n}`,
  statusName: { id: `st_${n}`, name: status },   // nested, as a CRM sends it
  sourceName: 'מטאור - אריאל יואב דביר'
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

const crmFetch = async (url, options = {}) => {
  if (url.includes('/oauth/token')) {
    return jsonResponse({ access_token: 'tok', expires_in: 3600, scope: 'leads:read' });
  }

  if (url.includes('/leads/fields')) return jsonResponse({ fields: FIELDS });

  if (url.includes('/customers/sources')) {
    if (sourcesFail) return jsonResponse({ error: 'missing scope' }, 400);

    // The name is under `title` — the shape a live response really has.
    return jsonResponse({ results: [
      { id: 'src_1', title: 'מטאור - אריאל יואב דביר', active: true },
      { id: 'src_2', title: 'סו"ב רועי כץ', active: false }
    ] });
  }

  if (url.includes('/leads/search')) {
    const body = JSON.parse(options.body);
    return jsonResponse({
      rows: crmLeads.slice(body.startRow, body.endRow),
      hasNextPage: body.endRow < crmLeads.length
    });
  }

  return jsonResponse({ error: 'not found' }, 404);
};

// ----------------------------------------------------------------- fixtures
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
  await db.pool.query('TRUNCATE leads, changes, sync_runs, webhook_events, source_names, cursors');
  crmLeads = [lead(1), lead(2), lead(3)];
  sourcesFail = false;
});

const sync = () => runSync({ db, config, trigger: 'test', fetchImpl: crmFetch });

const call = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: {
    Authorization: `Bearer ${config.api.token}`,
    'Content-Type': 'application/json',
    ...options.headers
  }
});

// -------------------------------------------------------------------- tests
test('the first sync records a baseline rather than claiming new leads', async () => {
  const summary = await sync();

  assert.equal(summary.baseline, true);
  assert.equal(summary.added, 0);
  assert.equal(summary.leadsInCrm, 3);
  assert.equal(await db.countLeads(), 3);

  // A baseline must not fill the feed with three thousand "new lead" lines.
  const { changes } = await (await call('/api/changes')).json();
  assert.equal(changes.length, 0);
});

test('a changed field is recorded with its old and new value', async () => {
  await sync();

  crmLeads[1] = lead(2, 'לא עונה 3');
  const summary = await sync();

  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 2);

  const { changes } = await (await call('/api/changes')).json();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].leadId, 'ld_2');
  assert.equal(changes[0].column, 'statusName');
  assert.equal(changes[0].before, 'לא ענה');
  assert.equal(changes[0].after, 'לא עונה 3');
});

test('a nested lookup is stored by its name, not as [object Object]', async () => {
  await sync();

  const response = await (await call('/api/leads/ld_1')).json();
  assert.equal(response.fields.statusName, 'לא ענה');
});

test('an untouched lead keeps the timestamp of when it really changed', async () => {
  await sync();
  crmLeads[1] = lead(2, 'לא עונה 3');
  await sync();

  const before = await db.getLead('ld_1');
  await sync();                       // a quiet run
  const after = await db.getLead('ld_1');

  assert.deepEqual(after.changed_at, before.changed_at);
});

test('a new lead is reported as added', async () => {
  await sync();
  crmLeads.push(lead(9, 'חדש'));

  const summary = await sync();
  assert.equal(summary.added, 1);

  const { changes } = await (await call('/api/changes')).json();
  assert.equal(changes.at(-1).type, 'חדש');
});

test('a lead the CRM stops returning is flagged, not deleted', async () => {
  await sync();
  crmLeads.splice(1, 1);

  const summary = await sync();
  assert.equal(summary.missing, 1);
  assert.equal(await db.countLeads(), 3, 'the row must survive');

  const lead2 = await db.getLead('ld_2');
  assert.equal(lead2.change_type, 'לא נמצא ב-CRM');
});

test('flagging a missing lead is not repeated on every later run', async () => {
  await sync();
  crmLeads.splice(1, 1);
  await sync();

  const summary = await sync();
  assert.equal(summary.missing, 0, 'already flagged, so not counted again');
});

test('a truncated read is refused and nothing is written', async () => {
  await sync();
  const before = await db.countLeads();

  const truncating = async (url, options) => {
    if (url.includes('/leads/search')) {
      // Always claims another page, so pagination never reaches the end.
      const body = JSON.parse(options.body);
      return jsonResponse({ rows: crmLeads.slice(body.startRow, body.endRow), hasNextPage: true });
    }
    return crmFetch(url, options);
  };

  await assert.rejects(
    runSync({ db, config: { ...config, surense: { ...config.surense, maxPages: 2 } },
      trigger: 'test', fetchImpl: truncating }),
    /without reaching the end/);

  assert.equal(await db.countLeads(), before);
});

test('an empty CRM response is refused rather than treated as deletions', async () => {
  await sync();
  crmLeads = [];

  await assert.rejects(sync(), /no leads at all/);
  assert.equal(await db.countLeads(), 3);
});

test('a read that loses most leads is refused as suspect', async () => {
  crmLeads = Array.from({ length: 10 }, (_, i) => lead(i + 1));
  await sync();

  crmLeads = [lead(1), lead(2)];      // 80% gone: a filter change, not deletions
  await assert.rejects(sync(), /treated as a fault/);
  assert.equal(await db.countLeads(), 10);
});

test('a failed run is still recorded, with its reason', async () => {
  crmLeads = [];
  await assert.rejects(sync());

  const runs = await db.recentRuns(1);
  assert.equal(runs[0].ok, false);
  assert.match(runs[0].error, /no leads at all/);
});

// -------------------------------------------------------------- source names
test('the sync fills in the source id to name mapping', async () => {
  const summary = await sync();
  assert.equal(summary.sourcesMapped, 2);

  const names = await db.sourceNameMap();
  assert.equal(names.get('src_1'), 'מטאור - אריאל יואב דביר');

  // An inactive source is still mapped. Leads referring to one retired last
  // year are still in the CRM, and a status change on them must not read as
  // an unmapped UUID.
  assert.equal(names.get('src_2'), 'סו"ב רועי כץ');
});

test('a refused source call leaves the lead sync working', async () => {
  // This mapping decides who a message is addressed to, not what the mirror
  // holds. Losing the customers:read scope must not also stop the mirror.
  sourcesFail = true;

  const summary = await sync();

  assert.equal(summary.ok, true);
  assert.equal(summary.leadsInCrm, 3);
  assert.equal(summary.sourcesMapped, 0);
  assert.match(summary.sourcesError, /400/);
});

test('a mapping already stored survives a run that could not refresh it', async () => {
  await sync();
  sourcesFail = true;
  await sync();

  const names = await db.sourceNameMap();
  assert.equal(names.get('src_1'), 'מטאור - אריאל יואב דביר',
    'the previous mapping must stay in place');
});

// ------------------------------------------------------------------- the API
test('every data route refuses an unauthenticated request', async () => {
  for (const path of ['/api/leads', '/api/changes', '/api/runs', '/api/cursors']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must require a token`);
  }
});

test('a wrong token is refused', async () => {
  const response = await fetch(`${baseUrl}/api/leads`,
    { headers: { Authorization: 'Bearer not-the-token' } });

  assert.equal(response.status, 401);
});

test('health is reachable without a token, and leaks nothing', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(Object.keys(body).sort(), ['status', 'syncing', 'time']);
});

test('changes can be claimed once, and a second claim gets nothing', async () => {
  await sync();
  crmLeads[0] = lead(1, 'ממתין לת.ז');
  await sync();

  const { changes } = await (await call('/api/changes?pending=true')).json();
  assert.ok(changes.length > 0);

  const ids = changes.map(change => change.id);

  const first = await (await call('/api/changes/notified',
    { method: 'POST', body: JSON.stringify({ ids, via: 'test' }) })).json();

  assert.equal(first.claimed, ids.length);

  // The same call again — as a retry after a crash — must claim nothing.
  const second = await (await call('/api/changes/notified',
    { method: 'POST', body: JSON.stringify({ ids }) })).json();

  assert.equal(second.claimed, 0);
  assert.deepEqual(second.alreadyClaimed, ids);

  const pending = await (await call('/api/changes?pending=true')).json();
  assert.equal(pending.count, 0);
});

test('the cursor remembers a position and only ever moves forward', async () => {
  const put = (lastId) => call('/api/cursor/notifier',
    { method: 'PUT', body: JSON.stringify({ lastId }) });

  await put(10);
  let cursor = await (await call('/api/cursor/notifier')).json();
  assert.equal(cursor.lastId, 10);

  await put(25);
  cursor = await (await call('/api/cursor/notifier')).json();
  assert.equal(cursor.lastId, 25);

  // A late retry carrying an old position must not rewind and replay.
  await put(12);
  cursor = await (await call('/api/cursor/notifier')).json();
  assert.equal(cursor.lastId, 25, 'the cursor must not go backwards');
});

test('an unknown cursor reads as zero rather than failing', async () => {
  const cursor = await (await call('/api/cursor/never-used')).json();

  assert.equal(cursor.lastId, 0);
  assert.equal(cursor.name, 'never-used');
});

test('sinceId pages through the feed without repeats or gaps', async () => {
  await sync();

  crmLeads[0] = lead(1, 'לא עונה 2');
  crmLeads[1] = lead(2, 'לא עונה 3');
  await sync();

  const first = await (await call('/api/changes?limit=1')).json();
  assert.equal(first.count, 1);

  const second = await (await call(`/api/changes?sinceId=${first.nextCursor}`)).json();

  assert.ok(second.count >= 1);
  assert.ok(second.changes.every(change => change.id > first.nextCursor),
    'a second page must not repeat the first');
});

test('the webhook stores a delivery verbatim', async () => {
  const payload = { event: 'lead.updated', leadId: 'ld_1', nested: { a: 1 } };

  const response = await fetch(`${baseUrl}/webhook/surense`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.api.webhookSecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 200);

  const events = await db.listWebhookEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'surense');
  assert.deepEqual(events[0].payload, payload);
});

test('the webhook refuses a caller without the shared secret', async () => {
  const response = await fetch(`${baseUrl}/webhook/surense`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  assert.equal(response.status, 401);
});

test('an unknown endpoint is a clean 404, not a crash', async () => {
  const response = await call('/api/nope');
  assert.equal(response.status, 404);
});
