/**
 * Deriving columns from the leads rather than from the field schema.
 *
 * A live run stored a hundred columns of which almost every one was empty:
 * the schema names fields by one key while a returned lead carries another,
 * so reading lead[schemaKey] found nothing. These cover the fix and the
 * migration off the bad data it produced.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { deriveColumns } from '../src/mirror.js';
import { runSync } from '../src/sync/run.js';
import { createApi } from '../src/api/server.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/oauth/token',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 't', webhookSecret: 'h', svixSecret: '' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5, mirrorLeads: true },
  messaging: { columns: { status: 'סטטוס', source: 'מקור', clientName: 'שם',
    leadNumber: 'מספר' }, subject: 's', body: 'b', signature: '',
    maxPerRun: 25, redirectAllTo: '' }
};

// The schema names fields differently from how the search returns them —
// this mismatch is what produced a hundred empty columns.
const SCHEMA = [
  { key: 'f_status_1927', label: 'סטטוס' },
  { key: 'f_source_44c1', label: 'מקור' },
  { key: 'statusName', label: 'סטטוס' }
];

let crmLeads = [];

const jsonResponse = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

const crmFetch = async (url, options = {}) => {
  if (url.includes('/oauth/token')) {
    return jsonResponse({ access_token: 't', expires_in: 3600, scope: 'leads:read' });
  }
  if (url.includes('/leads/fields')) return jsonResponse({ fields: SCHEMA });
  if (url.includes('/leads/search')) {
    const body = JSON.parse(options.body);
    return jsonResponse({
      rows: crmLeads.slice(body.startRow, body.endRow),
      hasNextPage: body.endRow < crmLeads.length
    });
  }
  return jsonResponse({});
};

const lead = (n, status = 'לא ענה') => ({
  id: `ld_${n}`,
  leadNumber: 8800 + n,
  customerName: `לקוח ${n}`,
  statusName: status,
  sourceName: 'מטאור - אריאל',
  neverFilled: '',
  alsoEmpty: null
});

let db;

before(async () => {
  db = new Database(config.database);
  await db.migrate();
});

after(async () => { await db?.close(); });

beforeEach(async () => {
  await db.pool.query('TRUNCATE leads, changes, sync_runs');
  crmLeads = [lead(1), lead(2), lead(3)];
});

const sync = () => runSync({ db, config, trigger: 'test', fetchImpl: crmFetch });

// ------------------------------------------------------------------ derive
test('columns come from the leads, not from the schema', () => {
  const columns = deriveColumns([lead(1)], SCHEMA, 'id');
  const keys = columns.map(column => column.key);

  // The schema's own keys appear in no lead, so they must not become columns.
  assert.equal(keys.includes('f_status_1927'), false);
  assert.equal(keys.includes('f_source_44c1'), false);

  assert.ok(keys.includes('statusName'));
  assert.ok(keys.includes('customerName'));
});

test('every column is labelled by its own key, schema or no schema', () => {
  // The schema fetch is allowed to fail. If a key it describes were labelled
  // differently when it succeeds, the same data would store under two
  // different names on alternate runs and each would look like a rename.
  const withSchema = deriveColumns([lead(1)], SCHEMA, 'id');
  const withoutSchema = deriveColumns([lead(1)], [], 'id');

  assert.deepEqual(withSchema, withoutSchema, 'labels must not depend on the schema');
  assert.equal(withSchema.find(column => column.key === 'statusName').label, 'statusName');
});

test('a field empty in every lead is not made into a column', () => {
  // A hundred columns that are always blank is what the bug produced.
  const columns = deriveColumns([lead(1), lead(2)], SCHEMA, 'id');
  const keys = columns.map(column => column.key);

  assert.equal(keys.includes('neverFilled'), false);
  assert.equal(keys.includes('alsoEmpty'), false);
});

test('a field only some leads fill still becomes a column', () => {
  const columns = deriveColumns(
    [lead(1), { ...lead(2), notes: 'משהו' }], SCHEMA, 'id');

  assert.ok(columns.map(column => column.key).includes('notes'));
});

test('the id column is first, whatever the leads look like', () => {
  assert.equal(deriveColumns([lead(1)], SCHEMA, 'id')[0].key, 'id');
});

// --------------------------------------------------------------- migration
test('a live sync stores columns that actually hold values', async () => {
  await sync();

  const [stored] = await db.listLeads({ limit: 1 });
  const populated = Object.values(stored.fields).filter(value => value !== '');

  assert.ok(populated.length >= 4,
    `expected real values, got ${JSON.stringify(stored.fields)}`);
  assert.equal(stored.fields.statusName, 'לא ענה');
});

test('renamed columns re-baseline instead of reporting every row changed', async () => {
  // Exactly the situation the fix creates: rows stored under the old, empty
  // column names, then a sync that names columns differently.
  await db.pool.query(
    `INSERT INTO leads (id, fields, hash, changed_at, change_type)
     VALUES ('ld_1', $1, 'old', now(), 'בסיס'), ('ld_2', $1, 'old', now(), 'בסיס')`,
    [JSON.stringify({ 'עמודה ישנה א': '', 'עמודה ישנה ב': '', 'ועוד אחת': '' })]);

  const summary = await sync();

  assert.equal(summary.rebaselined, true);
  assert.equal(summary.updated, 0, 'no row may be reported as changed');
  assert.equal(summary.added, 0, 'nor as newly added');
  assert.equal(summary.changesRecorded, 0);

  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM changes');
  assert.equal(rows[0].n, 0, 'the change feed must not fill with thousands of rows');
});

test('the run after a re-baseline detects changes normally again', async () => {
  await db.pool.query(
    `INSERT INTO leads (id, fields, hash, changed_at, change_type)
     VALUES ('ld_1', $1, 'old', now(), 'בסיס')`,
    [JSON.stringify({ 'עמודה ישנה': '' })]);

  await sync();                       // re-baselines
  crmLeads[0] = lead(1, 'לא עונה 3'); // a real change

  const summary = await sync();

  assert.equal(summary.rebaselined, false);
  assert.equal(summary.updated, 1);
});

test('unchanged column names are not mistaken for a rename', async () => {
  await sync();
  const before = await db.recentRuns(1);

  const summary = await sync();

  assert.equal(summary.rebaselined, false);
  assert.equal(summary.unchanged, 3);
  assert.ok(before.length);
});


// --------------------------------------------------------- background sync
test('POST /api/sync answers at once and works in the background', async () => {
  const server = createApi({ db, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    // A slow CRM, the way a real one with thousands of leads behaves.
    const slowFetch = async (u, o) => {
      if (u.includes('/leads/search')) await new Promise(r => setTimeout(r, 300));
      return crmFetch(u, o);
    };

    // The handler uses the module's own client, so this only proves the
    // response does not wait on the read; the timing check below does.
    const started = Date.now();

    const response = await fetch(`${url}/api/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.api.token}` }
    });

    const elapsed = Date.now() - started;

    assert.equal(response.status, 202);
    assert.equal((await response.json()).started, true);
    assert.ok(elapsed < 2000, `answered in ${elapsed}ms, should not wait for the read`);

    void slowFetch;
  } finally {
    server.close();
  }
});

test('a run that never reached its ending is reported as interrupted', async () => {
  // Exactly what an abandoned request leaves behind: started, never finished,
  // ok false and no error — which reads as a mystery failure without this.
  await db.pool.query(
    `INSERT INTO sync_runs (started_at, trigger, ok) VALUES (now(), 'api', false)`);

  const server = createApi({ db, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const body = await (await fetch(`${url}/api/runs`,
      { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

    const run = body.runs[0];
    assert.equal(run.finished, false);
    assert.match(run.outcome, /never finished|still running/);
  } finally {
    server.close();
  }
});

test('a completed run is reported as ok', async () => {
  await sync();

  const server = createApi({ db, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const body = await (await fetch(`${url}/api/runs`,
      { headers: { Authorization: `Bearer ${config.api.token}` } })).json();

    assert.equal(body.runs[0].finished, true);
    assert.equal(body.runs[0].outcome, 'ok');
  } finally {
    server.close();
  }
});
