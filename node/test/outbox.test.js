/**
 * The notification decision layer, against a real Postgres.
 *
 * These cover the part that decides what goes to whom. Nothing is sent here
 * and nothing is sent in production either — the service decides, the caller
 * sends — so what passes here is exactly the decision that runs live.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { buildOutbox, render, SKIP } from '../src/notify/outbox.js';
import { normalizeText } from '../src/mirror.js';
import { SEED_TEMPLATES } from '../src/notify/seeds.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const COLUMNS = {
  status: 'סטטוס',
  source: 'מקור מפנה',
  clientName: 'שם הלקוח',
  leadNumber: 'מספר ליד'
};

const MESSAGING = {
  columns: COLUMNS,
  subject: 'עדכון סטטוס ליד — {client}',
  body: 'שלום {source},\n\nלקוח: {client}\nמספר: {leadNumber}\nסטטוס: {message}\n\n{signature}',
  signature: 'בברכה, שי',
  maxPerRun: 25
};

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'test-token', webhookSecret: 'hook' },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0, 1, 2, 3, 4, 5],
    activeHours: [8], shrinkGuard: 0.5 },
  messaging: MESSAGING
};

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
  await db.pool.query('TRUNCATE leads, changes, templates, recipients, cursors');
});

const call = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: {
    Authorization: `Bearer ${config.api.token}`,
    'Content-Type': 'application/json',
    ...options.headers
  }
});

/** A change row shaped the way listChanges returns one. */
const change = (id, status, source = 'מטאור - אריאל יואב דביר', before = 'חדש') => ({
  id,
  lead_id: `ld_${id}`,
  change_type: 'עודכן',
  column_name: COLUMNS.status,
  before_value: before,
  after_value: status,
  occurred_at: new Date(),
  fields: {
    [COLUMNS.status]: status,
    [COLUMNS.source]: source,
    [COLUMNS.clientName]: `לקוח ${id}`,
    [COLUMNS.leadNumber]: String(8800 + id)
  }
});

const templateMap = (list) =>
  new Map(list.map(item => [normalizeText(item.status),
    { channel: 'email', active: true, ...item }]));

const recipientMap = (list) =>
  new Map(list.map(item => [normalizeText(item.source_name),
    { email: '', whatsapp: '', active: true, ...item }]));

// ------------------------------------------------------------------ render
test('a placeholder is filled from the lead fields', () => {
  assert.equal(render('שלום {source}, לקוח {client}',
    { source: 'אריאל', client: 'דנה כהן' }), 'שלום אריאל, לקוח דנה כהן');
});

test('an unknown placeholder is left visible rather than becoming undefined', () => {
  // A visibly unfilled slot is a bug report; the word "undefined" reaching a
  // real client is an incident.
  assert.equal(render('שלום {nope}', { source: 'x' }), 'שלום {nope}');
});

// ------------------------------------------------------------------ outbox
test('a status with a template and a reachable source produces a message', () => {
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'לא ענה')],
    templates: templateMap([{ status: 'לא ענה', message: 'אין מענה 1' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'ariel@example.com' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(skipped.length, 0);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].to, 'ariel@example.com');
  assert.equal(ready[0].subject, 'עדכון סטטוס ליד — לקוח 1');
  assert.match(ready[0].body, /סטטוס: אין מענה 1/);
  assert.match(ready[0].body, /בברכה, שי/);
});

test('a status with no template sends nothing', () => {
  // The closed allowlist: the plan lists 34 statuses with no wording yet, and
  // every one of them must stay silent rather than guess.
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'בחתימה')],
    templates: templateMap([{ status: 'לא ענה', message: 'אין מענה 1' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'ariel@example.com' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.noTemplate);
});

test('a deactivated template sends nothing', () => {
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'לא ענה')],
    templates: templateMap([{ status: 'לא ענה', message: 'x', active: false }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'a@b.c' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.templateOff);
});

test('a category source with no recipient row is skipped quietly', () => {
  // "קמפיין" and "חבר מביא חבר" are buckets, not people. The plan puts about
  // 29% of leads behind them, and they must not read as failures.
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'לא ענה', 'קמפיין')],
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.noRecipient);
  assert.equal(skipped[0].detail, 'קמפיין');
});

test('a recipient with no address is reported, not sent to', () => {
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'לא ענה')],
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: '' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.noAddress);
});

test('a muted recipient sends nothing', () => {
  const { ready, skipped } = buildOutbox({
    changes: [change(1, 'לא ענה')],
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([{ source_name: 'מטאור - אריאל יואב דביר',
      email: 'a@b.c', active: false }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped[0].reason, SKIP.recipientOff);
});

test('a source is matched despite spacing and quote differences', () => {
  const { ready } = buildOutbox({
    changes: [change(1, 'לא ענה', '  מטאור   -   אריאל   יואב  דביר ')],
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'ariel@example.com' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 1, 'messy whitespace must not lose the match');
});

test('a change to a column other than status is ignored', () => {
  // A corrected phone number is a change, but nobody was promised a message
  // about it.
  const phoneChange = { ...change(1, 'לא ענה'), column_name: 'טלפון' };

  const { ready, skipped } = buildOutbox({
    changes: [phoneChange],
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'a@b.c' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0);
  assert.equal(skipped.length, 0, 'not a skip — simply not an event');
});

test('the flood brake blocks everything and names the cause', () => {
  const changes = Array.from({ length: 30 }, (_, i) => change(i + 1, 'לא ענה'));

  const { ready, floodBrake } = buildOutbox({
    changes,
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'a@b.c' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(ready.length, 0, 'nothing may be released');
  assert.equal(floodBrake.blocked, 30);
  assert.equal(floodBrake.limit, 25);
  assert.deepEqual(floodBrake.statuses, ['לא ענה']);
});

test('the brake lets exactly the limit through', () => {
  const changes = Array.from({ length: 25 }, (_, i) => change(i + 1, 'לא ענה'));

  const { ready, floodBrake } = buildOutbox({
    changes,
    templates: templateMap([{ status: 'לא ענה', message: 'x' }]),
    recipients: recipientMap([
      { source_name: 'מטאור - אריאל יואב דביר', email: 'a@b.c' }]),
    columns: COLUMNS,
    messaging: MESSAGING
  });

  assert.equal(floodBrake, null);
  assert.equal(ready.length, 25);
});

// ----------------------------------------------------------- through the API
test('the seeded templates are the eight the plan gives wording for', async () => {
  const written = await db.seedTemplates(SEED_TEMPLATES);
  assert.equal(written, 8);

  const { templates } = await (await call('/api/templates')).json();
  assert.equal(templates.length, 8);

  const noAnswer = templates.find(t => t.status === 'לא ענה');
  assert.equal(noAnswer.message, 'ניסינו ליצור קשר עם הלקוח אין מענה 1');

  // "חדש" and "רלוונטי ל2025" are on the plan's do-not-send list.
  assert.equal(templates.some(t => t.status === 'חדש'), false);
});

test('seeding never overwrites wording that was edited', async () => {
  await db.seedTemplates(SEED_TEMPLATES);

  await call('/api/templates', {
    method: 'PUT',
    body: JSON.stringify({ status: 'לא ענה', message: 'נוסח מתוקן' })
  });

  const written = await db.seedTemplates(SEED_TEMPLATES);
  assert.equal(written, 0, 'a later deploy must not restore the original text');

  const { templates } = await (await call('/api/templates')).json();
  assert.equal(templates.find(t => t.status === 'לא ענה').message, 'נוסח מתוקן');
});

test('templates can be added, changed and removed through the API', async () => {
  await call('/api/templates', {
    method: 'PUT',
    body: JSON.stringify([
      { status: 'נסגר', message: 'הטיפול הסתיים' },
      { status: 'הוגש', message: 'הבקשה הוגשה' }
    ])
  });

  let { templates } = await (await call('/api/templates')).json();
  assert.equal(templates.length, 2);

  const removed = await call(`/api/templates/${encodeURIComponent('נסגר')}`,
    { method: 'DELETE' });
  assert.equal(removed.status, 200);

  ({ templates } = await (await call('/api/templates')).json());
  assert.equal(templates.length, 1);
});

test('a template without a message is refused', async () => {
  const response = await call('/api/templates',
    { method: 'PUT', body: JSON.stringify({ status: 'נסגר' }) });

  assert.equal(response.status, 400);
});

test('a recipient is keyed by the normalized source name', async () => {
  await call('/api/recipients', {
    method: 'PUT',
    body: JSON.stringify({
      sourceName: '  מטאור   -  אריאל יואב דביר  ',
      email: 'ariel@example.com'
    })
  });

  const { recipients } = await (await call('/api/recipients')).json();
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].source_key, normalizeText('מטאור - אריאל יואב דביר'));
});

test('the outbox renders a full message end to end', async () => {
  await db.seedTemplates(SEED_TEMPLATES);

  await call('/api/recipients', {
    method: 'PUT',
    body: JSON.stringify({ sourceName: 'מטאור - אריאל יואב דביר',
      email: 'ariel@example.com' })
  });

  await db.pool.query(
    `INSERT INTO leads (id, fields, hash, changed_at, change_type)
     VALUES ('ld_1', $1, 'h', now(), 'עודכן')`,
    [JSON.stringify({
      [COLUMNS.status]: 'לא עונה 3',
      [COLUMNS.source]: 'מטאור - אריאל יואב דביר',
      [COLUMNS.clientName]: 'דנה כהן',
      [COLUMNS.leadNumber]: '8801'
    })]);

  await db.pool.query(
    `INSERT INTO changes (lead_id, change_type, column_name,
       before_value, after_value, occurred_at)
     VALUES ('ld_1', 'עודכן', $1, 'לא עונה 2', 'לא עונה 3', now())`,
    [COLUMNS.status]);

  const outbox = await (await call('/api/outbox')).json();

  assert.equal(outbox.readyToSend, 1);
  assert.equal(outbox.floodBrake, null);

  const message = outbox.messages[0];
  assert.equal(message.to, 'ariel@example.com');
  assert.equal(message.subject, 'עדכון סטטוס ליד — דנה כהן');
  assert.match(message.body, /ניסינו ליצור קשר עם הלקוח אין מענה 3/);
  assert.match(message.body, /8801/);
});

test('a message leaves the outbox once it is claimed', async () => {
  await db.seedTemplates(SEED_TEMPLATES);

  await call('/api/recipients', {
    method: 'PUT',
    body: JSON.stringify({ sourceName: 'מקור', email: 'a@b.c' })
  });

  await db.pool.query(
    `INSERT INTO leads (id, fields, hash, changed_at, change_type)
     VALUES ('ld_1', $1, 'h', now(), 'עודכן')`,
    [JSON.stringify({ [COLUMNS.status]: 'לא ענה', [COLUMNS.source]: 'מקור',
      [COLUMNS.clientName]: 'דנה', [COLUMNS.leadNumber]: '1' })]);

  await db.pool.query(
    `INSERT INTO changes (lead_id, change_type, column_name,
       before_value, after_value, occurred_at)
     VALUES ('ld_1', 'עודכן', $1, 'חדש', 'לא ענה', now())`,
    [COLUMNS.status]);

  const first = await (await call('/api/outbox')).json();
  assert.equal(first.readyToSend, 1);

  await call('/api/changes/notified', {
    method: 'POST',
    body: JSON.stringify({ ids: [first.messages[0].changeId], via: 'email' })
  });

  const second = await (await call('/api/outbox')).json();
  assert.equal(second.readyToSend, 0, 'a sent message must not come back');
});

test('the sources worklist shows which need an address, busiest first', async () => {
  for (const [id, source] of [['a', 'קמפיין'], ['b', 'קמפיין'],
    ['c', 'קמפיין'], ['d', 'מטאור']]) {
    await db.pool.query(
      `INSERT INTO leads (id, fields, hash, changed_at, change_type)
       VALUES ($1, $2, 'h', now(), 'בסיס')`,
      [id, JSON.stringify({ [COLUMNS.source]: source })]);
  }

  await call('/api/recipients', {
    method: 'PUT',
    body: JSON.stringify({ sourceName: 'מטאור', email: 'a@b.c' })
  });

  const { sources, total, withRecipient } = await (await call('/api/sources')).json();

  assert.equal(total, 2);
  assert.equal(withRecipient, 1);
  assert.equal(sources[0].source_name, 'קמפיין', 'busiest first');
  assert.equal(sources[0].leads, 3);
  assert.equal(sources[0].has_recipient, false);
});

test('the outbox routes need a token like everything else', async () => {
  for (const path of ['/api/outbox', '/api/templates', '/api/recipients', '/api/sources']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must require a token`);
  }
});
