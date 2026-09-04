/**
 * One sync pass: read the CRM, work out what moved, persist it.
 *
 * The CRM is only ever read. Everything written goes to Postgres.
 */

import { SurenseClient, toLabelledFields } from '../surense.js';
import { planSync, readExisting, deriveColumns, headerFor } from '../mirror.js';
import { optionsFromSchema } from '../sources.js';

/** Runs are serialised in-process; a second caller is told to wait. */
let inFlight = null;

/**
 * @param {object} deps
 * @param {import('../db/index.js').Database} deps.db
 * @param {object} deps.config
 * @param {string} [deps.trigger]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<object>} the run summary
 */
export async function runSync({ db, config, trigger = 'manual', fetchImpl }) {
  if (inFlight) {
    // Two triggers can overlap easily here: the internal timer and an
    // external scheduler both firing on the hour. Joining the run in progress
    // is correct — the second caller wants the same answer, not a second read.
    return inFlight;
  }

  inFlight = execute({ db, config, trigger, fetchImpl })
    .finally(() => { inFlight = null; });

  return inFlight;
}

async function execute({ db, config, trigger, fetchImpl }) {
  const startedAt = new Date();
  const runId = await db.startRun({ trigger, startedAt });

  const client = new SurenseClient({ ...config.surense, fetchImpl });

  try {
    const { scope } = await client.authenticate();

    // The schema supplies labels only. Which columns exist is decided by the
    // leads themselves — see deriveColumns.
    const rawSchema = await client.fetchFieldsRaw().catch(() => []);
    const schema = toLabelledFields(rawSchema);

    // If the CRM describes the source field as a picklist, its option list is
    // the id -> name mapping the leads do not carry. It arrives on a request
    // that is already being made, so keeping it costs nothing — and it means
    // a source added in the CRM gets its name here without anyone noticing.
    const sourceOptions = optionsFromSchema(
      rawSchema, config.messaging?.columns?.sourceId ?? 'sourceId');

    if (sourceOptions.length) {
      // 'crm' never overwrites a name entered by hand — see upsertSources.
      await db.upsertSources(sourceOptions, 'crm').catch(error => {
        console.warn(`Could not store the source catalog: ${error.message}`);
      });
    }

    const { leads, complete } = await client.fetchAllLeads();

    // A truncated read must never be applied: every lead not read would be
    // recorded as having disappeared from the CRM.
    if (!complete) {
      throw new Error(
        `The lead read stopped after ${leads.length} leads without reaching ` +
        'the end. Nothing was written. Raise SURENSE_MAX_PAGES.');
    }

    if (!leads.length) {
      throw new Error(
        'The CRM returned no leads at all. Nothing was written — an empty ' +
        'response is far more likely to be a fault than an empty CRM.');
    }

    const stored = await db.countLeads();

    // A read that lost a large share of the leads is treated as suspect. A
    // filter or permission change in the CRM looks exactly like a mass
    // deletion from here, and acting on it would fire notifications for every
    // lead that "vanished".
    if (stored > 0 && leads.length < stored * config.sync.shrinkGuard) {
      throw new Error(
        `The CRM returned ${leads.length} leads but ${stored} are stored — ` +
        'a drop that large is treated as a fault, not as deletions. Nothing ' +
        'was written. Set SHRINK_GUARD lower if the drop is genuine.');
    }

    const columns = deriveColumns(leads, schema, config.sync.idKey);

    if (!columns.length) {
      throw new Error('The leads returned by the CRM carry no fields at all.');
    }

    const existing = await db.loadExisting(columns);

    if (existing.relabelled) {
      // Worth saying out loud: this run rewrites every row and records no
      // changes, which would otherwise look like the sync losing its history.
      console.warn('Column names changed since the last sync ' +
        `(${existing.relabelled.overlap} of ${existing.relabelled.newColumns} ` +
        'in common). Recording a fresh baseline; no changes will be reported ' +
        'for this run.');
    }

    const { rows, changes, stats } = planSync({
      columns,
      leads,
      existing,
      now: new Date(),
      timeZone: config.sync.timeZone,
      idKey: config.sync.idKey
    });

    await db.applySync({
      rows,
      changes,
      columns,
      presentIds: new Set(rows.map(row => row._id))
    });

    const summary = {
      ok: true,
      trigger,
      scope,
      apiBase: client.base,
      leadsInCrm: leads.length,
      columns: headerFor(columns).length,
      columnNames: columns.slice(0, 12).map(column => column.label),
      rebaselined: Boolean(existing.relabelled),
      changesRecorded: changes.length,
      durationMs: Date.now() - startedAt.getTime(),
      ...stats
    };

    await db.finishRun(runId, { ok: true, stats, leadsInCrm: leads.length });

    return summary;
  } catch (error) {
    await db.finishRun(runId, {
      ok: false,
      error: `${error.message}${error.hint ? ` — ${error.hint}` : ''}`
    });

    throw error;
  }
}

/**
 * Reports whether a sync is currently running, for the health endpoint.
 *
 * @returns {boolean}
 */
export function syncInProgress() {
  return inFlight !== null;
}
