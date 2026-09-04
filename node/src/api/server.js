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
import { buildOutbox, summarizeSkips } from '../notify/outbox.js';
import { parseCsv, buildRecipients, reconcile } from '../notify/import.js';
import { verifySvixSignature, readSignatureHeaders } from './svix.js';
import { recordDelivery } from '../webhook/lead-updated.js';
import { normalizeText } from '../mirror.js';

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

async function readTextBody(request, limitBytes = 5_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
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

  // ---------------------------------------------------------------- outbox
  // What should go out right now: each pending status change matched to its
  // template and its recipient, with the message already rendered. The
  // scheduled sender calls this, sends what it gets, and reports back.
  route('GET', /^\/api\/outbox$/, async (_request, _params, url) => {
    const limit = Number(url.searchParams.get('limit') ?? 500);

    const changes = await db.listChanges({ pendingOnly: true, limit });

    const templates = new Map((await db.listTemplates())
      .map(template => [normalizeText(template.status), template]));

    const recipients = new Map((await db.listRecipients())
      .map(recipient => [recipient.source_key, recipient]));

    // An override for the one run after a bulk edit has been reviewed.
    const override = Number(url.searchParams.get('maxPerRun'));

    const messaging = Number.isFinite(override) && override > 0
      ? { ...config.messaging, maxPerRun: override }
      : config.messaging;

    const { ready, skipped, floodBrake } = buildOutbox({
      changes, templates, recipients, columns: config.messaging.columns, messaging
    });

    return {
      pendingChanges: changes.length,
      readyToSend: ready.length,
      // Surfaced on every response so a redirect left on by accident is
      // impossible to miss, and one left off before going live is obvious.
      redirectAllTo: config.messaging.redirectAllTo || null,
      floodBrake,
      skipped: summarizeSkips(skipped),
      messages: ready
    };
  });

  // ------------------------------------------------------------- templates
  route('GET', /^\/api\/templates$/, async () =>
    ({ templates: await db.listTemplates() }));

  route('PUT', /^\/api\/templates$/, async request => {
    const body = await readJsonBody(request);
    const list = Array.isArray(body) ? body : [body];

    const invalid = list.find(item => !item?.status || !item?.message);
    if (invalid) {
      return { status: 400,
        body: { error: 'Each template needs {status, message}.' } };
    }

    const saved = [];
    for (const item of list) saved.push(await db.saveTemplate(item));

    return { saved: saved.length, templates: saved };
  });

  route('DELETE', /^\/api\/templates\/(.+)$/, async (_request, params) => {
    const removed = await db.deleteTemplate(decodeURIComponent(params[0]));
    return removed ? { deleted: true } : { status: 404, body: { error: 'No such template.' } };
  });

  // ------------------------------------------------------------ recipients
  route('GET', /^\/api\/recipients$/, async () =>
    ({ recipients: await db.listRecipients() }));

  route('PUT', /^\/api\/recipients$/, async request => {
    const body = await readJsonBody(request);
    const list = Array.isArray(body) ? body : [body];

    const invalid = list.find(item => !item?.sourceName);
    if (invalid) {
      return { status: 400,
        body: { error: 'Each recipient needs {sourceName, email}.' } };
    }

    const saved = [];

    for (const item of list) {
      // The key is derived here, never taken from the caller: it has to match
      // exactly how a CRM source name is normalized at send time.
      saved.push(await db.saveRecipient({
        ...item, sourceKey: normalizeText(item.sourceName)
      }));
    }

    return { saved: saved.length, recipients: saved };
  });

  // Bulk import of the recipients file, as CSV pasted straight from Excel.
  //
  // Defaults to a preview. Name matching is the expensive failure here — a
  // row matching no source never fires and nothing complains — so the import
  // shows what would happen and what would not match, and only writes when
  // asked to.
  route('POST', /^\/api\/recipients\/import$/, async (request, _params, url) => {
    const text = await readTextBody(request);

    if (!text.trim()) {
      return { status: 400, body: { error: 'Send the CSV as the request body.' } };
    }

    let parsed;

    try {
      parsed = buildRecipients(parseCsv(text));
    } catch (error) {
      return { status: 400, body: { error: error.message } };
    }

    const { recipients, rejected, columns } = parsed;
    const sourcesInUse = await db.listSourcesInUse(config.messaging.columns.source);
    const report = reconcile(recipients, sourcesInUse);

    // apply=true is the deliberate second call, after the preview was read.
    const apply = url.searchParams.get('apply') === 'true';
    let saved = 0;

    if (apply) {
      for (const recipient of recipients) {
        await db.saveRecipient(recipient);
        saved++;
      }
    }

    return {
      applied: apply,
      saved,
      parsed: recipients.length,
      rejected,
      // Which column of the file was read as what, so a wrong guess is
      // visible in the preview rather than silently importing blank emails.
      columnsDetected: Object.fromEntries(
        Object.entries(columns).map(([field, index]) => [field, index === -1 ? null : index])),
      ...report,
      note: apply
        ? undefined
        : 'Nothing was written. Repeat with ?apply=true once this looks right.'
    };
  });

  route('DELETE', /^\/api\/recipients\/(.+)$/, async (_request, params) => {
    const removed = await db.deleteRecipient(normalizeText(decodeURIComponent(params[0])));
    return removed ? { deleted: true } : { status: 404, body: { error: 'No such recipient.' } };
  });

  // Every source the stored leads actually use, busiest first, flagged for
  // whether it has an address yet. This is the worklist for filling the
  // recipients table — the sources covering the most leads are worth doing.
  route('GET', /^\/api\/sources$/, async () => {
    const sources = await db.listSourcesInUse(config.messaging.columns.source);

    return {
      total: sources.length,
      withRecipient: sources.filter(source => source.has_recipient).length,
      sources
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
  // Surense delivers through Svix, which signs the body instead of sending a
  // header token — so this route does its own authentication rather than
  // using the bearer check, which needs the raw body to verify against.
  //
  // Two ways in are accepted: a valid Svix signature, or a bearer token for a
  // sender that can set headers and for testing by hand.
  route('POST', /^\/webhook\/([a-z0-9_-]{1,40})$/i, async (request, params) => {
    // The body must be verified exactly as it arrived: re-serialized JSON
    // would differ in key order and spacing, and never match the signature.
    const rawBody = await readTextBody(request);

    const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const expectedBearer = config.api.webhookSecret || config.api.token;

    let authorizedBy = null;

    if (bearer && secretsMatch(bearer, expectedBearer)) {
      authorizedBy = 'bearer';
    } else {
      const check = verifySvixSignature({
        headers: request.headers, rawBody, secret: config.api.svixSecret
      });

      if (check.ok) authorizedBy = 'svix-signature';
      else {
        return { status: 401, body: {
          error: 'Unverified webhook delivery.',
          svix: check.reason,
          hint: 'Set SVIX_WEBHOOK_SECRET to the endpoint signing secret ' +
            '(whsec_...) from the Svix dashboard, or send a bearer token.'
        } };
      }
    }

    let payload;

    try {
      payload = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch {
      return { status: 400, body: { error: 'Body was not valid JSON.' } };
    }

    // The sender's own message id, so a retry of a delivery that failed once
    // does not record the same status change twice.
    const { id: messageId } = readSignatureHeaders(request.headers);

    const stored = await db.recordWebhook(params[0], payload, messageId || null);

    if (stored.duplicate) {
      return {
        received: true, duplicate: true, authorizedBy,
        note: 'Already handled — this message id was delivered before.'
      };
    }

    let outcome;

    try {
      outcome = await recordDelivery({
        db, payload,
        columns: config.messaging.columns,
        timeZone: config.sync.timeZone
      });
    } catch (error) {
      // The delivery is stored either way, so it can be replayed once the
      // cause is fixed. Answering 200 stops Surense retrying something that
      // will fail identically every time.
      await db.finishWebhook(stored.id, `error: ${error.message}`);

      return { received: true, id: stored.id, recorded: false, error: error.message };
    }

    await db.finishWebhook(stored.id,
      outcome.recorded ? `recorded change ${outcome.changeIds.join(',')}` : outcome.reason);

    return {
      received: true,
      id: stored.id,
      authorizedBy,
      eventType: payload.eventType ?? payload.type ?? null,
      recorded: outcome.recorded,
      reason: outcome.reason,
      changeIds: outcome.changeIds,
      statusChange: outcome.event
        ? `${outcome.event.statusBefore} -> ${outcome.event.statusAfter}`
        : null
    };
  }, { auth: false });

  // Everything by default; ?pending=true narrows to deliveries that were
  // stored but never handled, which is the "something is stuck" view.
  route('GET', /^\/api\/webhooks$/, async (_request, _params, url) =>
    ({ events: await db.listWebhookEvents({
      pendingOnly: url.searchParams.get('pending') === 'true',
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
