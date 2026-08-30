/**
 * One sync pass: read the CRM, work out what moved, persist it.
 *
 * The CRM is only ever read. Everything written goes to Postgres.
 */

import { SurenseClient } from '../surense.js';
import { planSync, readExisting, orderColumns, headerFor } from '../mirror.js';

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
    const columns = orderColumns(await client.fetchFields(), config.sync.idKey);

    if (!columns.length) {
      throw new Error('The CRM returned no field definitions.');
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

    const existing = await db.loadExisting(columns);

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
