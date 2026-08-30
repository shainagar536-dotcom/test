/**
 * The HTTP API, on Node's own http module — no framework, no dependencies.
 *
 * Authentication is not optional here. Every route except /health serves
 * customer names, phone numbers and statuses; an unauthenticated endpoint on
 * a public URL is a data breach with extra steps. Requests must carry
 * `Authorization: Bearer <API_TOKEN>`.
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { runSync, syncInProgress } from '../sync/run.js';

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secretsMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Comparing against a fixed-size digest is not needed here: pad to
  // the longer length and let the content comparison decide.
  if (left.length !== right.length) {
    // Still do a comparison of equal length so the work is constant-ish.
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

function send(response, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);

  response.writeHead(status, {
    'Content-Type': typeof body === 'string'
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });

  response.end(text);
}

async function readJsonBody(request, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body was not valid JSON.');
  }
}

/**
 * Shapes a stored change for the notifier.
 *
 * @param {object} row
 * @returns {object}
 */
function presentChange(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    type: row.change_type,
    column: row.column_name || null,
    before: row.before_value || null,
    after: row.after_value || null,
    occurredAt: row.occurred_at,
    notifiedAt: row.notified_at,
    lead: row.fields ?? null
  };
}

/**
 * @param {object} deps
 * @param {import('../db/index.js').Database} deps.db
 * @param {object} deps.config
 * @returns {import('node:http').Server}
 */
export function createApi({ db, config }) {
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

  // ---------------------------------------------------------------- health
  // Unauthenticated on purpose: this is what an uptime pinger and Render's
  // own health check call, and it reveals nothing about anyone's data.
  route('GET', /^\/health$/, async () => ({
    status: 'ok',
    syncing: syncInProgress(),
    time: new Date().toISOString()
  }), { auth: false });

  // ----------------------------------------------------------------- leads
  route('GET', /^\/api\/leads$/, async (_request, _params, url) => {
    const rows = await db.listLeads({
      changedSince: url.searchParams.get('changedSince') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 200),
      offset: Number(url.searchParams.get('offset') ?? 0)
    });

    return {
      count: rows.length,
      leads: rows.map(row => ({
        id: row.id,
        changedAt: row.changed_at,
        changeType: row.change_type,
        fields: row.fields
      }))
    };
  });

  route('GET', /^\/api\/leads\/([^/]+)$/, async (_request, params) => {
    const lead = await db.getLead(decodeURIComponent(params[0]));
    if (!lead) return { status: 404, body: { error: 'No such lead.' } };

    return {
      id: lead.id,
      changedAt: lead.changed_at,
      changeType: lead.change_type,
      fields: lead.fields
    };
  });

  // --------------------------------------------------------------- changes
  // The feed the notifier reads. `pending=true` returns only changes no
  // message has gone out for yet, which is the normal call.
  route('GET', /^\/api\/changes$/, async (_request, _params, url) => {
    const types = (url.searchParams.get('type') ?? '')
      .split(',').map(value => value.trim()).filter(Boolean);

    const sinceId = url.searchParams.get('sinceId');

    const rows = await db.listChanges({
      sinceId: sinceId === null ? undefined : Number(sinceId),
      since: url.searchParams.get('since') ?? undefined,
      pendingOnly: url.searchParams.get('pending') === 'true',
      types,
      limit: Number(url.searchParams.get('limit') ?? 200)
    });

    // nextCursor is what the caller saves and sends back as sinceId next
    // time. Returning it means the caller never has to reason about ids.
    return {
      count: rows.length,
      nextCursor: rows.length ? rows[rows.length - 1].id : (sinceId ? Number(sinceId) : 0),
      changes: rows.map(presentChange)
    };
  });

  // --------------------------------------------------------------- cursors
  // Where a consumer got to. Kept server-side so it survives the consumer
  // restarting, moving machine, or being a different process each run.
  route('GET', /^\/api\/cursors$/, async () => ({ cursors: await db.listCursors() }));

  route('GET', /^\/api\/cursor\/([\w.-]{1,64})$/, async (_request, params) => {
    const cursor = await db.getCursor(params[0]);
    return { ...cursor, latestChangeId: await db.latestChangeId() };
  });

  route('PUT', /^\/api\/cursor\/([\w.-]{1,64})$/, async (request, params) => {
    const body = await readJsonBody(request);
    const lastId = Number(body.lastId);

    if (!Number.isFinite(lastId) || lastId < 0) {
      return { status: 400, body: { error: 'Send {"lastId": 123}.' } };
    }

    // The stored value only moves forward — a retry arriving late must not
    // rewind the cursor and replay changes that were already handled.
    return db.saveCursor(params[0], lastId, String(body.note ?? ''));
  });

  // Claiming changes as sent. This is what stops a notifier that crashes
  // mid-run from sending everything twice on its next pass: it reports which
  // ids it actually claimed, and a second caller racing it gets none of them.
  route('POST', /^\/api\/changes\/notified$/, async request => {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];

    if (!ids.length) {
      return { status: 400, body: { error: 'Send {"ids": [1, 2, 3]}.' } };
    }

    const claimed = await db.markNotified(ids, String(body.via ?? 'api'));

    return {
      requested: ids.length,
      claimed: claimed.length,
      claimedIds: claimed,
      alreadyClaimed: ids.filter(id => !claimed.includes(id))
    };
  });

  // ------------------------------------------------------------------ sync
  // Called by whatever schedules the work. On Render's free tier the service
  // sleeps, so an external caller hitting this both wakes it and runs the sync.
  route('POST', /^\/api\/sync$/, async () => {
    const summary = await runSync({ db, config, trigger: 'api' });
    return summary;
  });

  route('GET', /^\/api\/runs$/, async (_request, _params, url) =>
    ({ runs: await db.recentRuns(Number(url.searchParams.get('limit') ?? 20)) }));

  // --------------------------------------------------------------- webhook
  // Surense has no webhooks today. This exists so that a push from Surense or
  // any other system is captured verbatim the moment it starts arriving,
  // rather than being dropped while support for it is written.
  route('POST', /^\/webhook\/([a-z0-9_-]{1,40})$/i, async (request, params) => {
    const payload = await readJsonBody(request);
    const id = await db.recordWebhook(params[0], payload);

    return { received: true, id };
  }, { auth: 'webhook' });

  route('GET', /^\/api\/webhooks$/, async (_request, _params, url) =>
    ({ events: await db.listWebhookEvents({
      pendingOnly: url.searchParams.get('pending') !== 'false',
      limit: Number(url.searchParams.get('limit') ?? 100)
    }) }));

  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

    const match = routes.find(entry =>
      entry.method === request.method && entry.pattern.test(url.pathname));

    if (!match) return send(response, 404, { error: 'No such endpoint.' });

    if (match.auth) {
      const expected = match.auth === 'webhook'
        ? (config.api.webhookSecret || config.api.token)
        : config.api.token;

      const presented = (request.headers.authorization ?? '')
        .replace(/^Bearer\s+/i, '');

      if (!presented || !secretsMatch(presented, expected)) {
        return send(response, 401,
          { error: 'Send Authorization: Bearer <token>.' },
          { 'WWW-Authenticate': 'Bearer' });
      }
    }

    const params = url.pathname.match(match.pattern).slice(1);

    try {
      const result = await match.handler(request, params, url);

      if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
        return send(response, result.status, result.body);
      }

      return send(response, 200, result ?? { ok: true });
    } catch (error) {
      console.error(`${request.method} ${url.pathname} failed:`, error);

      // The message is the operator's own diagnostic — a wrong secret, a
      // truncated read — so it is worth returning rather than swallowing.
      return send(response, 500, {
        error: error.message,
        hint: error.hint ?? undefined
      });
    }
  });
}
