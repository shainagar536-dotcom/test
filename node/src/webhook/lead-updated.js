import { enrichEvent, refreshSourceCatalog } from '../events/enrich.js';

/**
 * Turning a Surense webhook delivery into a recorded change.
 *
 * A LeadUpdated event already carries the diff — each changed field arrives as
 * `{before, after}` — so unlike the polling path there is nothing to compare.
 * The event states what moved.
 *
 * What the event does not carry is the referring source, which is what decides
 * who gets told. That is read back from the CRM once per event — the lead for
 * its `sourceId`, then the cached catalog for the name — so no copy of the
 * lead table has to be kept just to answer it.
 */

/**
 * Wrapper keys a diff has been seen under. The diff may also sit at the top
 * level with no wrapper at all.
 */
const DIFF_WRAPPERS = ['changes', 'changedFields', 'updatedFields', 'diff',
  'updates', 'fields', 'data', 'payload'];

/** Event names that mean a lead was updated. */
const UPDATE_EVENTS = ['leadupdated', 'lead.updated', 'lead_updated'];

/**
 * True when a value is the `{before, after}` shape Surense uses for a change.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isDiff(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    ('after' in value || 'before' in value);
}

/**
 * Finds the object holding the `{before, after}` entries.
 *
 * The delivery may nest the diff under a wrapper or leave it at the top level,
 * so rather than hardcoding one key this looks for the shape itself. That is
 * what keeps a payload change from silently dropping every event.
 *
 * @param {object} payload
 * @returns {{diff: Object, wrapper: ?string}}
 */
export function findDiff(payload) {
  if (!payload || typeof payload !== 'object') return { diff: {}, wrapper: null };

  const topLevel = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => isDiff(value)));

  if (Object.keys(topLevel).length) return { diff: topLevel, wrapper: null };

  for (const key of DIFF_WRAPPERS) {
    const candidate = payload[key];
    if (!candidate || typeof candidate !== 'object') continue;

    const nested = Object.fromEntries(
      Object.entries(candidate).filter(([, value]) => isDiff(value)));

    if (Object.keys(nested).length) return { diff: nested, wrapper: key };
  }

  return { diff: {}, wrapper: null };
}

/**
 * Reads a value from the payload, trying each name in turn.
 *
 * @param {object} payload
 * @param {Array<string>} names
 * @returns {*}
 */
function pick(payload, names) {
  for (const name of names) {
    const value = payload?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

/**
 * Interprets one delivery.
 *
 * @param {object} payload
 * @returns {{
 *   isLeadUpdate: boolean, leadId: ?string, leadNumber: ?string,
 *   clientName: ?string, statusBefore: ?string, statusAfter: ?string,
 *   otherChanges: Array<{field: string, before: string, after: string}>,
 *   reason: ?string
 * }}
 */
export function interpretDelivery(payload) {
  const empty = {
    isLeadUpdate: false, leadId: null, leadNumber: null, clientName: null,
    statusBefore: null, statusAfter: null, otherChanges: [], reason: null
  };

  const eventType = String(
    pick(payload, ['eventType', 'type', 'event']) ?? '').toLowerCase();

  if (!UPDATE_EVENTS.includes(eventType)) {
    return { ...empty, reason: `not a lead update (eventType: ${eventType || 'absent'})` };
  }

  const leadId = pick(payload, ['leadId', 'id', 'lead_id']);

  // Without an id the delivery cannot be matched to a stored lead, and the
  // source — hence the recipient — is unknowable.
  if (!leadId) return { ...empty, reason: 'no leadId in the payload' };

  const { diff } = findDiff(payload);

  const statusEntry = diff.statusName ?? diff.status ?? diff.statusId;
  const statusBefore = statusEntry?.before ?? null;
  const statusAfter = statusEntry?.after ?? null;

  // Surense puts unchanged fields in the diff too — a real delivery carried
  // `closed: {before: false, after: false}`. A status entry whose two sides
  // match is not a status change, and acting on it would notify the referring
  // source about nothing.
  const statusMoved = statusAfter !== null && String(statusBefore) !== String(statusAfter);

  const firstName = pick(payload, ['firstName']) ?? '';
  const lastName = pick(payload, ['lastName']) ?? '';

  // customerName is what Surense actually sends; the name parts are a
  // fallback for an event shaped differently.
  const clientName = pick(payload, ['customerName', 'fullName', 'name', 'clientName']) ??
    [firstName, lastName].filter(Boolean).join(' ') ?? null;

  // Everything else that actually moved, kept so the history is complete even
  // though only a status change is notifiable. Entries whose two sides match
  // are dropped for the same reason as above.
  const otherChanges = Object.entries(diff)
    .filter(([field]) => !['statusName', 'status', 'statusId'].includes(field))
    .map(([field, value]) => ({
      field,
      before: value.before === undefined || value.before === null ? '' : String(value.before),
      after: value.after === undefined || value.after === null ? '' : String(value.after)
    }))
    .filter(entry => entry.before !== entry.after);

  return {
    isLeadUpdate: true,
    leadId: String(leadId),
    // The event carries when the change happened; using it rather than the
    // time of delivery keeps a retried or delayed event honest.
    occurredAt: pick(payload, ['date', 'occurredAt', 'timestamp']) ?? null,
    leadNumber: pick(payload, ['leadNumber', 'number']) != null
      ? String(pick(payload, ['leadNumber', 'number'])) : null,
    clientName: clientName || null,
    statusBefore: statusBefore === null ? null : String(statusBefore),
    statusAfter: statusMoved ? String(statusAfter) : null,
    otherChanges,
    reason: statusMoved ? null : 'the status did not change in this event'
  };
}

/**
 * Records what a delivery means.
 *
 * The event is written first and looked up afterwards. That order is the
 * whole design: resolving the referring source needs the CRM, and a CRM that
 * is slow, rate-limited or down must cost us an enrichment we can retry —
 * never the event itself, which arrives once and is not replayed on demand.
 *
 * Returns what happened rather than throwing on the ordinary cases: a
 * delivery that changes no status is a normal outcome, and the endpoint still
 * answers 200 so Surense does not retry something that will never succeed.
 *
 * @param {object} input
 * @param {import('../db/index.js').Database} input.db
 * @param {object} input.payload
 * @param {object} [input.client]  A SurenseClient; when absent the event is
 *                                 recorded and left for the enrichment pass.
 * @param {object} input.config
 * @returns {Promise<{recorded: boolean, reason: ?string, eventId: ?number,
 *                    duplicate: boolean, enriched: ?object}>}
 */
export async function recordDelivery({ db, payload, client, config }) {
  const event = interpretDelivery(payload);

  const nothing = (reason) =>
    ({ recorded: false, reason, eventId: null, duplicate: false, enriched: null });

  if (!event.isLeadUpdate) return nothing(event.reason);
  if (event.statusAfter === null) return nothing(event.reason);

  // Written before any lookup. Everything below this line is recoverable;
  // losing the event is not.
  const { id, created } = await db.recordStatusEvent({
    leadId: event.leadId,
    leadNumber: event.leadNumber ?? '',
    customerName: event.clientName ?? '',
    statusBefore: event.statusBefore ?? '',
    statusAfter: event.statusAfter,
    occurredAt: event.occurredAt
  });

  if (!created) {
    return {
      recorded: false,
      reason: 'this status change was already recorded',
      eventId: id,
      duplicate: true,
      enriched: null
    };
  }

  // Enrichment is best-effort and inline only as an optimisation: doing it
  // now means the row is complete by the time anyone looks. If it fails the
  // row stays 'pending' and the enrichment pass picks it up.
  let enriched = null;

  if (client) {
    try {
      const sourceNames = await db.sourceNameMap();

      const patch = await enrichEvent({
        event: { lead_id: event.leadId },
        client,
        sourceNames,
        columns: config.messaging.columns,
        onUnknownSource: async () => {
          await refreshSourceCatalog({ db, client, path: config.sourceCatalogPath });
          return db.sourceNameMap();
        }
      });

      await db.enrichStatusEvent(id, patch);
      enriched = patch;
    } catch (error) {
      // Recorded but not enriched is a valid state, and the retry pass exists
      // precisely for it. Failing the request here would make Surense retry a
      // delivery we have already stored.
      await db.enrichStatusEvent(id, {
        sourceState: 'failed',
        sourceError: error.message
      });

      enriched = { sourceState: 'failed', sourceError: error.message };
    }
  }

  return { recorded: true, reason: null, eventId: id, duplicate: false, enriched, event };
}
