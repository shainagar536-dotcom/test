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
import { buildEventOutbox, summarizeSkips } from '../notify/outbox.js';
import { enrichPending, refreshSourceCatalog } from '../events/enrich.js';
import { parseCsv, buildRecipients, reconcile } from '../notify/import.js';
import { SEED_TEMPLATES, MUTED_STATUSES } from '../notify/seeds.js';
import { verifySvixSignature, readSignatureHeaders } from './svix.js';
import { recordDelivery } from '../webhook/lead-updated.js';
import { normalizeText } from '../mirror.js';
import { SurenseClient, tokenScopes } from '../surense.js';
import { extractPairs, optionsFromSchema, scoreCatalog } from '../sources.js';
import { EVENT_LABELS, describeEvent } from '../dashboard/labels.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * The CRM settings in effect, with the credential masked.
 *
 * Enough to tell one client from another and one host from another, and not
 * enough to authenticate with. The secret is never included at all.
 *
 * @param {object} config
 * @returns {object}
 */
function crmSettings(config) {
  const id = String(config.surense.clientId ?? '');

  return {
    clientId: id ? `${id.slice(0, 8)}…${id.slice(-4)} (${id.length} chars)` : null,
    clientSecretSet: Boolean(config.surense.clientSecret),
    tokenUrl: config.surense.tokenUrl,
    apiBases: config.surense.apiBases,
    sourceCatalogPath: config.sourceCatalogPath,
    mirrorLeads: config.sync.mirrorLeads,
    columns: config.messaging.columns
  };
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
 * @param {typeof fetch} [deps.fetchImpl]  Injectable, for tests.
 * @returns {import('node:http').Server}
 */
const DASHBOARD_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dashboard.html'),
  'utf8');

export function createApi({ db, config, fetchImpl }) {
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
    const events = await db.listStatusEvents({ pendingOnly: true, limit: 500 });

    const templates = new Map((await db.listTemplates())
      .map(template => [normalizeText(template.status), template]));

    const recipients = new Map((await db.listRecipients())
      .map(recipient => [recipient.source_key, recipient]));

    // An override for the one run after a bulk edit has been reviewed.
    const override = Number(url.searchParams.get('maxPerRun'));

    const messaging = Number.isFinite(override) && override > 0
      ? { ...config.messaging, maxPerRun: override }
      : config.messaging;

    const { ready, skipped, floodBrake } = buildEventOutbox({
      events, templates, recipients, messaging
    });

    return {
      pendingEvents: events.length,
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
    const sourcesInUse = await db.listSourcesInUse(config.messaging.columns);
    const report = reconcile(recipients, sourcesInUse);

    // apply=true is the deliberate second call, after the preview was read.
    const apply = url.searchParams.get('apply') === 'true';
    let saved = 0;

    // A file that carries the source id maps it as well as addresses it.
    // This is the shortest path out of the id/name gap: the operator already
    // maintains this sheet, and one extra column makes it the bridge.
    const mappings = recipients
      .filter(recipient => recipient.sourceId)
      .map(recipient => ({ id: recipient.sourceId, name: recipient.sourceName }));

    let mapped = 0;

    if (apply) {
      for (const recipient of recipients) {
        await db.saveRecipient(recipient);
        saved++;
      }

      if (mappings.length) {
        ({ written: mapped } = await db.upsertSources(mappings, 'manual'));
      }
    }

    return {
      applied: apply,
      saved,

      // How many rows carried a source id, and how many were stored. A file
      // with no id column reports 0 here, which is the signal that the
      // mapping still has to come from somewhere else.
      sourceIdsInFile: mappings.length,
      sourceIdsMapped: mapped,

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
    const sources = await db.listSourcesInUse(config.messaging.columns);
    const unresolved = await db.listUnresolvedSources(config.messaging.columns);

    return {
      total: sources.length,
      withRecipient: sources.filter(source => source.has_recipient).length,

      // Leads whose source id maps to no name. These cannot reach a
      // recipient however complete the recipients file is, so they are
      // reported next to the worklist rather than left out of it.
      unresolvedIds: unresolved.length,
      unresolvedLeads: unresolved.reduce((sum, row) => sum + row.leads, 0),
      unresolved: unresolved.slice(0, 50),

      sources
    };
  });

  // ---------------------------------------------------------- source map
  // The id -> name bridge. The leads carry `sourceId` as a bare UUID; the
  // recipients file is keyed by name. Without a row here the two never join.
  route('GET', /^\/api\/sources\/map$/, async () => {
    const map = await db.listSourceMap();

    return {
      total: map.length,
      fromCrm: map.filter(row => row.origin === 'crm').length,
      manual: map.filter(row => row.origin === 'manual').length,
      sources: map
    };
  });

  // Hand-written mappings. These outrank anything a sync discovers, so a name
  // corrected here is not undone by the next hourly run.
  route('PUT', /^\/api\/sources\/map$/, async (request) => {
    const body = await readJsonBody(request);
    const rows = Array.isArray(body) ? body : [body];

    const pairs = rows
      .map(row => ({
        id: String(row.sourceId ?? row.id ?? '').trim(),
        name: String(row.name ?? row.sourceName ?? '').trim()
      }))
      .filter(pair => pair.id && pair.name);

    if (!pairs.length) {
      return { status: 400, body: {
        error: 'Send [{"sourceId": "<uuid>", "name": "<source name>"}, ...].' } };
    }

    const { written } = await db.upsertSources(pairs, 'manual');

    return { written, sources: await db.listSourceMap() };
  });

  route('DELETE', /^\/api\/sources\/map\/(.+)$/, async (_request, params) => {
    const removed = await db.deleteSource(decodeURIComponent(params[0]));

    return removed
      ? { deleted: true }
      : { status: 404, body: { error: 'No such source id.' } };
  });

  // Hunts the CRM for a lookup that lists sources by id and name, and scores
  // each candidate against the ids the leads actually carry.
  //
  // Which path serves this — if any does — is not documented, so guessing one
  // and hardcoding it would be a coin flip that fails silently. Every
  // candidate is a GET; nothing here writes to the CRM, and nothing is stored
  // unless ?apply=true and a candidate actually explains the traffic.
  route('POST', /^\/api\/sources\/probe$/, async (request, _params, url) => {
    const usage = await db.sourceUsage(config.messaging.columns);

    if (!usage.size) {
      return { status: 409, body: {
        error: 'No leads stored yet. Run POST /api/sync first.' } };
    }

    const client = new SurenseClient({ ...config.surense, fetchImpl });
    const candidates = [];

    // The cheapest candidate first: the field schema is already read on every
    // sync, so if the source field is a picklist the mapping is arriving
    // already and is merely being discarded.
    try {
      const schema = await client.fetchFieldsRaw();
      const pairs = optionsFromSchema(schema, config.messaging.columns.sourceId);

      candidates.push({
        path: 'GET /leads/fields (field schema options)',
        ok: true,
        ...scoreCatalog(pairs, usage),
        pairsFound: pairs
      });
    } catch (error) {
      candidates.push({
        path: 'GET /leads/fields (field schema options)',
        ok: false, error: error.message, coverage: 0, pairsFound: []
      });
    }

    for (const attempt of await client.probeSourceCatalogs(config.sourceCatalogPaths)) {
      if (!attempt.ok) {
        candidates.push({
          path: `GET ${attempt.path}`,
          ok: false,
          status: attempt.status,
          error: attempt.error,
          coverage: 0,
          pairsFound: []
        });
        continue;
      }

      const pairs = extractPairs(attempt.payload);

      candidates.push({
        path: `GET ${attempt.path}`,
        ok: true,
        status: attempt.status,
        ...scoreCatalog(pairs, usage),
        pairsFound: pairs
      });
    }

    candidates.sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
    const best = candidates[0];

    const apply = url.searchParams.get('apply') === 'true';
    let written = 0;

    // Storing a catalog that explains almost nothing would fill the table
    // with plausible-looking wrong names, which is worse than an empty table:
    // an empty one skips, a wrong one emails the wrong partner.
    const worthStoring = Boolean(best?.ok) && best.matchedSources > 0;

    if (apply && worthStoring) {
      ({ written } = await db.upsertSources(best.pairsFound, 'crm'));
    }

    return {
      applied: apply && worthStoring,
      written,
      leadSourceIds: usage.size,

      // Trimmed: a catalog can be long, and the decision is made on the
      // score, not on reading every pair.
      candidates: candidates.map(({ pairsFound, ...rest }) => ({
        ...rest,
        samplePairs: (pairsFound ?? []).slice(0, 5)
      })),

      note: worthStoring
        ? (apply
          ? undefined
          : 'Repeat with ?apply=true to store the best candidate.')
        : 'No candidate resolved any source id the leads use. The CRM may not ' +
          'expose a source lookup to this client; fill the map by hand with ' +
          'PUT /api/sources/map, or ask Surense which path serves it.'
    };
  });

  // ---------------------------------------------------------------- events
  // The status-change log: the record this service keeps. One row per change,
  // carrying the customer, the move, who handles it and who referred them.
  route('GET', /^\/api\/events$/, async (_request, _params, url) => {
    const sinceId = url.searchParams.get('sinceId');

    const events = await db.listStatusEvents({
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
      pendingOnly: url.searchParams.get('pending') === 'true',
      sinceId: sinceId === null ? undefined : Number(sinceId),
      search: url.searchParams.get('search') ?? '',
      status: url.searchParams.get('status') ?? '',
      assignee: url.searchParams.get('assignee') ?? '',
      delivery: url.searchParams.get('delivery') ?? 'all',
      channel: url.searchParams.get('channel') ?? '',
      sort: url.searchParams.get('sort') === 'asc' ? 'asc' : 'desc'
    });

    return {
      count: events.length,
      nextCursor: events.length ? Math.max(...events.map(e => Number(e.id))) : 0,
      counts: await db.statusEventCounts(),
      events
    };
  });

  // Looks up the source for events that arrived without one. Safe to call
  // repeatedly and safe to schedule: it only touches rows still waiting.
  route('POST', /^\/api\/events\/enrich$/, async (_request, _params, url) => {
    const client = new SurenseClient({ ...config.surense, fetchImpl });

    return enrichPending({
      db, client, config,
      limit: Number(url.searchParams.get('limit') ?? 25)
    });
  });

  // Claims events as sent. Two senders running at once get disjoint sets, so
  // no message goes out twice.
  route('POST', /^\/api\/events\/notified$/, async request => {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];

    if (!ids.length) {
      return { status: 400, body: { error: 'Send {"ids": [1, 2, 3]}.' } };
    }

    const { claimed, superseded, alreadyClaimed } = await db.markEventsNotified(
      ids, String(body.via ?? ''), String(body.to ?? ''));

    return {
      requested: ids.length,
      claimed,

      // Older unsent changes for the same leads, closed against the one that
      // went out. Reported so a caller can see the queue shrink by more than
      // it claimed and know why.
      superseded,

      alreadyClaimed
    };
  });

  // Reloads the whole id -> name catalog in one call. This is the endpoint
  // that fills in every source name at once.
  route('POST', /^\/api\/sources\/refresh$/, async () => {
    const client = new SurenseClient({ ...config.surense, fetchImpl });

    const result = await refreshSourceCatalog({
      db, client, path: config.sourceCatalogPath
    });

    return { ...result, path: config.sourceCatalogPath };
  });

  // ----------------------------------------------------------- source names
  // The earlier spelling of the same mapping, from when this was solved on a
  // separate branch. Kept working, and pointed at the same table, so a script
  // or a bookmark written against it does not quietly stop mapping anything.
  route('GET', /^\/api\/source-names$/, async () => {
    const map = await db.listSourceMap();
    const sources = await db.listSourcesInUse(config.messaging.columns);

    return {
      total: map.length,

      // The worklist: ids the leads actually use that are still unnamed,
      // busiest first.
      unresolvedInUse: sources
        .filter(source => !source.resolved)
        .slice(0, 50)
        .map(source => ({ sourceId: source.source_id, leads: source.leads })),

      sourceNames: map.map(row => ({
        source_id: row.source_id,
        source_name: row.name,
        origin: row.origin,
        updated_at: row.updated_at
      }))
    };
  });

  route('PUT', /^\/api\/source-names$/, async request => {
    const body = await readJsonBody(request);
    const list = Array.isArray(body) ? body : [body];

    const invalid = list.find(item => !item?.sourceId || !item?.sourceName);
    if (invalid) {
      return { status: 400,
        body: { error: 'Each entry needs {sourceId, sourceName}.' } };
    }

    // Written by hand through the API, so it outranks a name a sync finds.
    const { written } = await db.upsertSources(
      list.map(item => ({ id: item.sourceId, name: item.sourceName })), 'manual');

    return { saved: written, sourceNames: await db.listSourceMap() };
  });

  route('DELETE', /^\/api\/source-names\/(.+)$/, async (_request, params) => {
    const removed = await db.deleteSource(decodeURIComponent(params[0]));

    return removed
      ? { deleted: true }
      : { status: 404, body: { error: 'No such source id.' } };
  });

  // The two tables the dashboard edits, with what the shipped list held, so
  // an edit can be told from the default and reverted deliberately.
  route('GET', /^\/api\/dashboard\/policy$/, async () => {
    const templates = await db.listTemplates();
    const shipped = new Map(SEED_TEMPLATES.map(t => [normalizeText(t.status), t.message]));

    return {
      templates: templates.map(row => ({
        ...row,
        shipped: shipped.get(normalizeText(row.status)) ?? null,
        edited: shipped.has(normalizeText(row.status)) &&
          shipped.get(normalizeText(row.status)) !== row.message
      })),

      // Statuses deliberately given no wording. Silence is the default
      // anyway; this is what separates "decided" from "not written yet".
      muted: MUTED_STATUSES,

      // Wording that exists for a status on the muted list contradicts the
      // policy, so it is surfaced rather than left to be noticed.
      conflicts: templates
        .filter(row => MUTED_STATUSES.some(m => normalizeText(m) === normalizeText(row.status)))
        .map(row => row.status)
    };
  });

  route('GET', /^\/api\/dashboard\/recipients$/, async (_request, _params, url) => {
    const rows = await db.listRecipients();
    const search = normalizeText(url.searchParams.get('search') ?? '');

    const matching = search
      ? rows.filter(row => normalizeText(row.source_name).includes(search) ||
        normalizeText(row.email).includes(search) ||
        normalizeText(row.whatsapp).includes(search))
      : rows;

    return {
      total: rows.length,
      email: rows.filter(row => row.channel === 'email').length,
      whatsapp: rows.filter(row => row.channel === 'whatsapp').length,

      // Real sources with real volume that nobody has an address for. These
      // are silent by necessity, not by decision, and worth seeing.
      noAddress: rows.filter(row => !row.channel).length,

      recipients: matching
    };
  });

  // ------------------------------------------------------------------- crm
  // What the service is pointed at, and whether it answers.
  //
  // Changing a host or a token path in the dashboard is only half the job;
  // the other half is knowing it took. This reports the settings in effect
  // and, on POST, actually authenticates and says what came back.
  //
  // The client id is masked and the secret is never returned — only whether
  // one is set. A settings page that leaks the credential is not a settings
  // page.
  route('GET', /^\/api\/crm$/, async () => ({
    settings: crmSettings(config),
    note: 'POST here to authenticate and confirm these actually work.'
  }));

  route('POST', /^\/api\/crm$/, async () => {
    const client = new SurenseClient({ ...config.surense, fetchImpl });
    const settings = crmSettings(config);

    let auth;

    try {
      const { token, scope } = await client.authenticate();

      auth = {
        ok: true,
        // The scope the token really carries, which is not always the scope
        // that was granted in the CRM's own UI — that gap is exactly what a
        // 403 on a new endpoint turns out to be.
        scope: scope || tokenScopes(token) || '(the token states no scope)',
        error: null
      };
    } catch (error) {
      return {
        settings,
        auth: { ok: false, scope: null, error: error.message, hint: error.hint || null },
        apiBase: null,
        sourceCatalog: null
      };
    }

    let apiBase = null;
    let apiError = null;

    try {
      apiBase = await client.resolveBase();
    } catch (error) {
      apiError = error.message;
    }

    // The one call the source mapping depends on. Read-only, and it is the
    // call most likely to fail for want of a scope.
    let sourceCatalog = null;

    if (apiBase) {
      try {
        const pairs = await client.fetchSourceCatalog(config.sourceCatalogPath);

        sourceCatalog = {
          ok: true,
          path: config.sourceCatalogPath,
          sources: pairs.length,
          example: pairs.length ? pairs[0].name : null,
          error: null
        };
      } catch (error) {
        sourceCatalog = {
          ok: false,
          path: config.sourceCatalogPath,
          sources: 0,
          example: null,
          error: error.message
        };
      }
    }

    return { settings, auth, apiBase, apiError, sourceCatalog };
  });

  // ----------------------------------------------------------------- admin
  // Empties the lead mirror. The status history is NOT touched — the database
  // refuses to delete it — so this clears the cache and keeps the record.
  //
  // Guarded by an explicit confirmation rather than a bare POST, because a
  // stray call would otherwise throw away every stored lead.
  route('POST', /^\/api\/admin\/reset-mirror$/, async (_request, _params, url) => {
    if (url.searchParams.get('confirm') !== 'delete-mirror') {
      return { status: 400, body: {
        error: 'Add ?confirm=delete-mirror to confirm.',
        note: 'This clears the lead mirror. status_events is never touched.'
      } };
    }

    const cleared = await db.resetMirror();

    return {
      cleared,
      historyKept: (await db.statusEventCounts()).total,
      note: 'The lead mirror is empty. The status history is untouched.'
    };
  });

  // ------------------------------------------------------------- dashboard
  // The page itself carries no data — it is an empty shell that asks for the
  // token and then calls the authenticated endpoints below. That is why it
  // can be served unauthenticated: there is nothing in it to leak, and a
  // token in a URL would end up in browser history and proxy logs.
  route('GET', /^\/(dashboard|dashboard\/)?$/, async () => ({
    status: 200,
    body: DASHBOARD_HTML,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  }), { auth: false });

  // What the filters offer, and how to say each column in Hebrew.
  route('GET', /^\/api\/dashboard\/filters$/, async () => {
    const { statuses, assignees } = await db.eventFilterValues();

    return { statuses, assignees, labels: EVENT_LABELS };
  });

  // The status-change log, translated, with whether a message has gone out.
  route('GET', /^\/api\/dashboard\/events$/, async (_request, _params, url) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    const query = {
      search: url.searchParams.get('search') ?? '',
      status: url.searchParams.get('status') ?? '',
      assignee: url.searchParams.get('assignee') ?? '',
      delivery: url.searchParams.get('delivery') ?? 'all',
      channel: url.searchParams.get('channel') ?? ''
    };

    // Newest first by default; the reader can flip it to walk forwards
    // through what happened.
    const sort = url.searchParams.get('sort') === 'asc' ? 'asc' : 'desc';

    const [events, counts, templates, recipientRows] = await Promise.all([
      db.listStatusEvents({
        ...query,
        sort,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0
      }),
      db.statusEventCounts(),
      db.listTemplates(),
      db.listRecipients()
    ]);

    // The same decision the sender makes, so the screen cannot claim a
    // message is queued while the sender skips it.
    const { ready, skipped } = buildEventOutbox({
      events,
      templates: new Map(templates.map(row => [normalizeText(row.status), row])),
      recipients: new Map(recipientRows.map(row => [row.source_key, row])),
      messaging: { ...config.messaging, maxPerRun: Number.MAX_SAFE_INTEGER }
    });

    const sendable = new Set(ready.map(item => item.eventId));
    const reasons = new Map(skipped.map(item => [item.eventId, item.reason]));

    // How each one would go out, so the column reads "וואטסאפ" before the
    // message is sent and not only after.
    const planned = new Map(ready.map(item => [item.eventId, item.channel]));

    const byName = new Map(recipientRows.map(row => [row.source_key, row]));
    for (const event of events) {
      if (planned.has(Number(event.id)) || !event.source_name) continue;

      const recipient = byName.get(normalizeText(event.source_name));
      if (recipient?.channel) planned.set(Number(event.id), recipient.channel);
    }

    return {
      total: await db.countStatusEvents(query),
      limit,
      offset,
      sort,
      counts,
      recipients: recipientRows.length,
      redirectAllTo: config.messaging.redirectAllTo || null,
      events: events.map(event => describeEvent(event, sendable, reasons, planned))
    };
  });

  // --------------------------------------------------------------- columns
  // Which of the CRM's fields the messaging layer is pointed at, and whether
  // those names actually exist. With a hundred-odd fields, finding the right
  // four by reading a JSON dump is the kind of task that gets done wrong.
  route('GET', /^\/api\/columns$/, async () => {
    const [sample] = await db.listLeads({ limit: 1 });

    if (!sample) {
      return { status: 409, body: {
        error: 'No leads stored yet. Run POST /api/sync first.' } };
    }

    const names = Object.keys(sample.fields);

    // A field is a candidate when its name contains one of these and it
    // actually holds something in the sample.
    const HINTS = {
      status: ['סטטוס', 'status'],
      source: ['מקור', 'מפנה', 'source', 'referr'],
      clientName: ['שם', 'לקוח', 'name', 'client', 'customer'],
      leadNumber: ['מספר', 'number', 'מזהה', 'id']
    };

    const suggest = (hints) => names
      .filter(name => hints.some(hint => name.toLowerCase().includes(hint)))
      .map(name => ({ name, sample: String(sample.fields[name] ?? '').slice(0, 40) }))
      .filter(entry => entry.sample !== '')
      .slice(0, 12);

    const configured = config.messaging.columns;

    return {
      totalColumns: names.length,

      // The four the messaging layer reads, and whether each one is real.
      configured: Object.fromEntries(
        Object.entries(configured).map(([role, name]) => [role, {
          name,
          exists: names.includes(name),
          sample: names.includes(name)
            ? String(sample.fields[name] ?? '').slice(0, 60)
            : null
        }])),

      // What to use instead, for any that does not exist.
      suggestions: Object.fromEntries(
        Object.entries(HINTS).map(([role, hints]) => [role, suggest(hints)])),

      allColumns: names
    };
  });

  // ----------------------------------------------------------- diagnostics
  // The whole state of the system in one response, for pasting into a
  // conversation with someone helping. Deliberately carries no customer
  // names, phone numbers or email addresses: the point is to show whether
  // the wiring is right, and that never requires anyone's personal details.
  route('GET', /^\/api\/diagnostics$/, async () => {
    const [sample] = await db.listLeads({ limit: 1 });
    const runs = await db.recentRuns(3);
    const templates = await db.listTemplates();
    const recipients = await db.listRecipients();
    const pending = await db.listChanges({ pendingOnly: true, limit: 1000 });
    const sources = sample ? await db.listSourcesInUse(config.messaging.columns) : [];
    const unresolved = sample
      ? await db.listUnresolvedSources(config.messaging.columns) : [];
    const sourceMap = await db.listSourceMap();

    const names = sample ? Object.keys(sample.fields) : [];

    // Values for the two columns whose content has to be recognisable to
    // confirm the mapping — a status and a partner name, neither personal.
    // For the two that identify a customer, only the shape is reported.
    const describe = (role, name) => {
      const exists = names.includes(name);
      const value = exists ? String(sample.fields[name] ?? '') : '';

      const shown = ['status', 'source'].includes(role)
        ? value.slice(0, 60)
        : (value ? `<${value.length} chars>` : '');

      return { name, exists, sample: shown || null };
    };

    const HINTS = {
      status: ['סטטוס', 'status'],
      source: ['מקור', 'מפנה', 'source', 'referr'],
      clientName: ['שם', 'לקוח', 'name', 'client', 'customer'],
      leadNumber: ['מספר', 'number', 'מזהה', 'id']
    };

    return {
      generatedAt: new Date().toISOString(),

      counts: {
        leads: await db.countLeads(),
        distinctSources: sources.length,
        sourcesWithRecipient: sources.filter(source => source.has_recipient).length,

        // The id -> name bridge. While this is empty every lead skips with
        // source-id-not-mapped and nothing can ever be sent, however complete
        // the templates and recipients are — so it belongs in the headline
        // counts rather than buried.
        sourceMappings: sourceMap.length,
        sourceMappingsManual: sourceMap.filter(row => row.origin === 'manual').length,
        unresolvedSourceIds: unresolved.length,
        unresolvedLeads: unresolved.reduce((sum, row) => sum + row.leads, 0),

        // The names the previous version of this report used. Kept so a
        // saved comparison against an earlier diagnostics dump still lines up.
        sourcesStillUnnamedIds: unresolved.length,
        sourceNamesMapped: sourceMap.length,
        templates: templates.length,
        activeTemplates: templates.filter(template => template.active).length,
        recipients: recipients.length,
        recipientsWithEmail: recipients.filter(recipient => recipient.email).length,
        pendingChanges: pending.length,
        columnsInCrm: names.length
      },

      // The four names the messaging layer reads, and whether they are real.
      columns: Object.fromEntries(
        Object.entries(config.messaging.columns)
          .map(([role, name]) => [role, describe(role, name)])),

      // Candidates for any that is not, by name and by having a value.
      suggestions: Object.fromEntries(Object.entries(HINTS).map(([role, hints]) => [
        role,
        names.filter(name => hints.some(hint => name.toLowerCase().includes(hint)))
          .filter(name => String(sample?.fields[name] ?? '') !== '')
          .slice(0, 8)
      ])),

      settings: {
        timeZone: config.sync.timeZone,
        activeDays: config.sync.activeDays,
        activeHours: config.sync.activeHours,
        maxSendsPerRun: config.messaging.maxPerRun,
        redirectAllTo: config.messaging.redirectAllTo || null,
        shrinkGuard: config.sync.shrinkGuard,
        svixSecretSet: Boolean(config.api.svixSecret)
      },

      recentRuns: runs.map(run => ({
        at: run.started_at, trigger: run.trigger, ok: run.ok,
        leads: run.leads_in_crm, added: run.added, updated: run.updated,
        missing: run.missing, error: run.error
      })),

      // Busiest sources still without an address — names of partners, which
      // is what the recipients file has to cover.
      topSourcesWithoutRecipient: sources
        .filter(source => !source.has_recipient)
        .slice(0, 15)
        .map(source => ({
          source: source.resolved ? source.source_name : `<unnamed id> ${source.source_id}`,
          leads: source.leads
        })),

      statusTemplates: templates.map(template => template.status)
    };
  });

  // ------------------------------------------------------------------ sync
  // Called by whatever schedules the work. On Render's free tier the service
  // sleeps, so an external caller hitting this both wakes it and runs the sync.
  //
  // Answers immediately and works in the background. A full read of a few
  // thousand leads takes about a minute, and holding an HTTP request open
  // that long fails everywhere it matters — a shell client gives up, the
  // platform cuts the connection, an external scheduler times out — and the
  // run is then abandoned half-done with nothing recorded about why.
  //
  // ?wait=true keeps the old behaviour for a caller that can afford to hold.
  route('POST', /^\/api\/sync$/, async (_request, _params, url) => {
    if (url.searchParams.get('wait') === 'true') {
      return runSync({ db, config, trigger: 'api-wait' });
    }

    const started = new Date().toISOString();

    // Deliberately not awaited. The rejection is handled here so a failure
    // becomes a logged, recorded run rather than an unhandled rejection.
    runSync({ db, config, trigger: 'api' })
      .then(summary => console.log('Sync finished:', JSON.stringify(summary)))
      .catch(error => console.error('Sync failed:', error.message));

    return {
      status: 202,
      body: {
        started: true,
        at: started,
        note: 'Running in the background — a full read takes about a minute. ' +
          'Poll GET /api/runs for the result, or use ?wait=true to hold.'
      }
    };
  });

  route('GET', /^\/api\/runs$/, async (_request, _params, url) => {
    const runs = await db.recentRuns(Number(url.searchParams.get('limit') ?? 20));

    return {
      running: syncInProgress(),
      runs: runs.map(run => ({
        ...run,
        // A row with ok=false and no error is a run that never reached its
        // own ending — the process restarted, or the request was abandoned
        // mid-flight. That is a different thing from a run that failed, and
        // reads as a mystery without saying so.
        finished: run.finished_at !== null,
        outcome: run.finished_at === null
          ? (syncInProgress() ? 'still running' : 'never finished — interrupted')
          : (run.ok ? 'ok' : 'failed')
      }))
    };
  });

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

    // Valid JSON is not necessarily an object: `null`, a number and a bare
    // string all parse. The payload column is jsonb and NOT NULL, so storing
    // one of those directly throws, the endpoint answers 500, and a 500 is
    // how you ask the sender to deliver the identical body again. Wrapped, it
    // is stored, reported as uninterpretable, and never retried.
    if (!payload || typeof payload !== 'object') {
      payload = { unexpectedBody: payload === undefined ? null : payload };
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
        db,
        payload,
        config,
        client: new SurenseClient({ ...config.surense, fetchImpl })
      });
    } catch (error) {
      // The delivery is stored either way, so it can be replayed once the
      // cause is fixed. Answering 200 stops Surense retrying something that
      // will fail identically every time.
      await db.finishWebhook(stored.id, `error: ${error.message}`);

      return { received: true, id: stored.id, recorded: false, error: error.message };
    }

    await db.finishWebhook(stored.id,
      outcome.recorded ? `recorded event ${outcome.eventId}` : outcome.reason);

    return {
      received: true,
      id: stored.id,
      authorizedBy,
      eventType: payload.eventType ?? payload.type ?? null,
      recorded: outcome.recorded,
      reason: outcome.reason,
      eventId: outcome.eventId,
      duplicate: outcome.duplicate,

      // What the lookup found, so a delivery that recorded but could not be
      // enriched says so here rather than looking like a clean success.
      source: outcome.enriched
        ? {
          state: outcome.enriched.sourceState,
          name: outcome.enriched.sourceName ?? null,
          error: outcome.enriched.sourceError || null
        }
        : null,

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
        return send(response, result.status, result.body, result.headers ?? {});
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
