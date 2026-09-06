/**
 * Filling in what a status-change event does not carry.
 *
 * A Surense webhook says the status moved and who the customer is. It does
 * not say who referred them, and that is what decides where the message goes.
 * So each event is read back against the CRM once: the lead gives its
 * `sourceId` and the name of whoever handles it, and the source catalog turns
 * that id into a name.
 *
 * The catalog is fetched whole and cached in the `sources` table, so a source
 * costs one request the first time anybody refers through it and none after.
 */

import { resolveSourceName } from '../sources.js';

/** How the source of an event ended up. */
export const SOURCE_STATE = {
  pending: 'pending',
  resolved: 'resolved',
  absent: 'absent',
  failed: 'failed'
};

/**
 * Reloads the id -> name catalog from the CRM into `sources`.
 *
 * Names found here are marked 'crm', which never overwrites one entered by
 * hand — a correction has to survive the next refresh.
 *
 * @param {object} input
 * @returns {Promise<{loaded: number, written: number}>}
 */
export async function refreshSourceCatalog({ db, client, path }) {
  const pairs = await client.fetchSourceCatalog(path);
  const { written } = await db.upsertSources(pairs, 'crm');

  return { loaded: pairs.length, written };
}

/**
 * Enriches one recorded event.
 *
 * Returns the patch rather than writing it, so the decision is testable
 * without a database and the caller keeps control of what is stored.
 *
 * @param {object} input
 * @param {object} input.event      A status_events row.
 * @param {object} input.client     A SurenseClient.
 * @param {Map<string, string>} input.sourceNames
 * @param {object} input.columns
 * @param {() => Promise<Map<string, string>>} [input.onUnknownSource]
 *        Called when an id is not in the cached catalog; should refresh it and
 *        return the new map. Called at most once per event.
 * @returns {Promise<object>} the patch for enrichStatusEvent
 */
export async function enrichEvent({
  event, client, sourceNames, columns, onUnknownSource
}) {
  let lead;

  try {
    lead = await client.fetchLeadById(event.lead_id);
  } catch (error) {
    // The CRM is the only place this answer lives, so a failure here is worth
    // retrying rather than recording as "this lead has no source".
    return {
      sourceState: SOURCE_STATE.failed,
      sourceError: `lead lookup failed: ${error.message}`
    };
  }

  const assigneeName = String(
    lead[columns.assignee] ?? lead.assigneeName ?? lead.ownerName ?? '');

  // Only read when a column is configured for it: with no column set, an
  // empty amount is the honest answer, and the wording that quotes it is
  // held rather than sent half-written.
  const amount = columns.total ? String(lead[columns.total] ?? '') : '';

  const { name: direct, id: sourceId } =
    resolveSourceName(lead, columns, sourceNames);

  // A name straight off the lead needs no catalog at all.
  if (direct) {
    return {
      assigneeName,
      amount,
      sourceId,
      sourceName: direct,
      sourceState: SOURCE_STATE.resolved,
      sourceError: ''
    };
  }

  // The CRM never attributed this lead to anyone. Not an error, and not
  // something a retry will change.
  if (!sourceId) {
    return {
      assigneeName,
      amount,
      sourceState: SOURCE_STATE.absent,
      sourceError: ''
    };
  }

  let names = sourceNames;
  let mapped = names.get(sourceId);

  // Unknown id: a source added in the CRM since the catalog was last read.
  // Refreshing costs one request and fixes it for every later event.
  if (!mapped && onUnknownSource) {
    try {
      names = await onUnknownSource();
      mapped = names.get(sourceId);
    } catch (error) {
      return {
        assigneeName,
        amount,
        sourceId,
        sourceState: SOURCE_STATE.failed,
        sourceError: `source catalog refresh failed: ${error.message}`
      };
    }
  }

  if (!mapped) {
    return {
      assigneeName,
      amount,
      sourceId,
      sourceState: SOURCE_STATE.failed,
      sourceError: 'the source id is not in the CRM catalog'
    };
  }

  return {
    assigneeName,
    amount,
    sourceId,
    sourceName: mapped,
    sourceState: SOURCE_STATE.resolved,
    sourceError: ''
  };
}

/**
 * Enriches everything still waiting.
 *
 * The catalog is refreshed at most once for the whole batch: a hundred events
 * naming the same new source must not become a hundred refreshes.
 *
 * @param {object} input
 * @returns {Promise<{processed: number, resolved: number, failed: number,
 *                    absent: number, catalogRefreshed: boolean}>}
 */
export async function enrichPending({ db, client, config, limit = 25 }) {
  const events = await db.pendingEnrichment({ limit });

  const summary = {
    processed: 0, resolved: 0, failed: 0, absent: 0, catalogRefreshed: false
  };

  if (!events.length) return summary;

  let sourceNames = await db.sourceNameMap();
  let refreshed = false;

  const onUnknownSource = async () => {
    if (refreshed) return sourceNames;
    refreshed = true;
    summary.catalogRefreshed = true;

    await refreshSourceCatalog({ db, client, path: config.sourceCatalogPath });
    sourceNames = await db.sourceNameMap();

    return sourceNames;
  };

  for (const event of events) {
    const patch = await enrichEvent({
      event,
      client,
      sourceNames,
      columns: config.messaging.columns,
      onUnknownSource
    });

    await db.enrichStatusEvent(event.id, patch);

    summary.processed++;
    if (patch.sourceState === SOURCE_STATE.resolved) summary.resolved++;
    if (patch.sourceState === SOURCE_STATE.failed) summary.failed++;
    if (patch.sourceState === SOURCE_STATE.absent) summary.absent++;
  }

  return summary;
}
