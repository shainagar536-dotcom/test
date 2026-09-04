/**
 * Svix webhook verification.
 *
 * Surense delivers through Svix, which signs the body rather than sending a
 * header token. These check the signature scheme against vectors computed the
 * same way Svix computes them, and that a forged or stale delivery is refused.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { Database } from '../src/db/index.js';
import { createApi } from '../src/api/server.js';
import { verifySvixSignature, readSignatureHeaders } from '../src/api/svix.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/surense';

const SIGNING_SECRET = `whsec_${randomBytes(24).toString('base64')}`;

const config = {
  surense: { clientId: 'x', clientSecret: 'y', tokenUrl: 'https://crm.test/t',
    apiBases: ['https://crm.test/api/v1'], pageSize: 50, maxPages: 40 },
  database: { url: DATABASE_URL, ssl: false, maxConnections: 4 },
  api: { port: 0, token: 'api-token', webhookSecret: 'hook-token',
    svixSecret: SIGNING_SECRET },
  sync: { timeZone: 'Asia/Jerusalem', idKey: 'id', activeDays: [0], activeHours: [8],
    shrinkGuard: 0.5 },
  messaging: {
    columns: { status: 'סטטוס', source: 'מקור מפנה', clientName: 'שם הלקוח',
      leadNumber: 'מספר ליד' },
    subject: 's', body: 'b', signature: 'sig', maxPerRun: 25, redirectAllTo: ''
  }
};

/** Signs a body the way Svix does, so the test proves interoperability. */
function sign(body, { id = 'msg_test123', timestamp, secret = SIGNING_SECRET } = {}) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

  const signature = createHmac('sha256', key)
    .update(`${id}.${ts}.${body}`)
    .digest('base64');

  return {
    'svix-id': id,
    'svix-timestamp': String(ts),
    'svix-signature': `v1,${signature}`
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

beforeEach(() => db.pool.query('TRUNCATE webhook_events'));

const post = (body, headers) => fetch(`${baseUrl}/webhook/surense`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body
});

// ------------------------------------------------------------ the scheme
test('a correctly signed body verifies', () => {
  const body = JSON.stringify({ type: 'lead.updated', id: 'ld_1' });

  assert.equal(verifySvixSignature({
    headers: sign(body), rawBody: body, secret: SIGNING_SECRET
  }).ok, true);
});

test('a changed body does not verify', () => {
  const body = JSON.stringify({ type: 'lead.updated', id: 'ld_1' });
  const headers = sign(body);

  const result = verifySvixSignature({
    headers, rawBody: JSON.stringify({ type: 'lead.updated', id: 'ld_999' }),
    secret: SIGNING_SECRET
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no signature matched/);
});

test('a different secret does not verify', () => {
  const body = '{"a":1}';
  const headers = sign(body, { secret: `whsec_${randomBytes(24).toString('base64')}` });

  assert.equal(verifySvixSignature({
    headers, rawBody: body, secret: SIGNING_SECRET }).ok, false);
});

test('an old delivery is refused, so a captured signature cannot be replayed', () => {
  const body = '{"a":1}';
  const old = Math.floor(Date.now() / 1000) - 3600;

  const result = verifySvixSignature({
    headers: sign(body, { timestamp: old }), rawBody: body, secret: SIGNING_SECRET });

  assert.equal(result.ok, false);
  assert.match(result.reason, /away from now/);
});

test('a delivery from the near future is accepted, for clock skew', () => {
  const body = '{"a":1}';
  const soon = Math.floor(Date.now() / 1000) + 60;

  assert.equal(verifySvixSignature({
    headers: sign(body, { timestamp: soon }), rawBody: body,
    secret: SIGNING_SECRET }).ok, true);
});

test('one of several signatures matching is enough, for secret rotation', () => {
  const body = '{"a":1}';
  const real = sign(body)['svix-signature'];

  const result = verifySvixSignature({
    headers: { ...sign(body), 'svix-signature': `v1,AAAAinvalid= ${real}` },
    rawBody: body, secret: SIGNING_SECRET });

  assert.equal(result.ok, true);
});

test('missing headers are named rather than crashing', () => {
  const result = verifySvixSignature({
    headers: {}, rawBody: '{}', secret: SIGNING_SECRET });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing svix-id/);
});

test('an unconfigured secret is reported, not treated as a pass', () => {
  const body = '{"a":1}';

  assert.equal(verifySvixSignature({
    headers: sign(body), rawBody: body, secret: '' }).ok, false);
});

test('the standard-webhooks header names are accepted too', () => {
  const svix = sign('{"a":1}');

  const read = readSignatureHeaders({
    'webhook-id': svix['svix-id'],
    'webhook-timestamp': svix['svix-timestamp'],
    'webhook-signature': svix['svix-signature']
  });

  assert.equal(read.id, svix['svix-id']);
  assert.equal(read.signature, svix['svix-signature']);
});

// ------------------------------------------------------------- the route
test('a signed delivery is accepted and stored verbatim', async () => {
  const payload = { type: 'lead.status.updated', data: { id: 'ld_1', status: 'לא ענה' } };
  const body = JSON.stringify(payload);

  const response = await post(body, sign(body));
  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.authorizedBy, 'svix-signature');
  assert.equal(result.event, 'lead.status.updated');

  const events = await db.listWebhookEvents({});
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, payload);
});

test('an unsigned delivery is refused and told what is missing', async () => {
  const response = await post('{"type":"lead.updated"}');

  assert.equal(response.status, 401);

  const body = await response.json();
  assert.match(body.svix, /missing svix-id/);
  assert.match(body.hint, /SVIX_WEBHOOK_SECRET/);
});

test('a forged body with a stolen signature is refused', async () => {
  const real = JSON.stringify({ type: 'lead.updated', id: 'ld_1' });
  const headers = sign(real);

  const response = await post(JSON.stringify({ type: 'lead.updated', id: 'ld_666' }), headers);

  assert.equal(response.status, 401);
  assert.equal((await db.listWebhookEvents({})).length, 0, 'nothing may be stored');
});

test('a bearer token still works, for a sender that can set headers', async () => {
  const response = await post('{"type":"manual.test"}',
    { Authorization: `Bearer ${config.api.webhookSecret}` });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).authorizedBy, 'bearer');
});

test('a wrong bearer token falls through to signature checking and fails', async () => {
  const response = await post('{"a":1}', { Authorization: 'Bearer nope' });
  assert.equal(response.status, 401);
});

test('a signed delivery whose body is not JSON is refused cleanly', async () => {
  const body = 'this is not json';
  const response = await post(body, sign(body));

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not valid JSON/);
});

test('unicode in the body verifies — the raw bytes are what is signed', async () => {
  const payload = { client: 'דנה כהן', status: 'לא עונה 3' };
  const body = JSON.stringify(payload);

  const response = await post(body, sign(body));

  assert.equal(response.status, 200);
  assert.deepEqual((await db.listWebhookEvents({}))[0].payload, payload);
});
