/**
 * Turning a Surense webhook delivery into a recorded change.
 *
 * A LeadUpdated event already carries the diff — each changed field arrives as
 * `{before, after}` — so unlike the polling path there is nothing to compare.
 * The event states what moved.
 *
 * What the event does not carry is the referring source, which is what decides
 * who gets told. That comes from the lead row the polling sync maintains, so
 * the two paths are complementary rather than redundant: polling keeps the
 * lead data complete, the webhook makes status changes immediate.
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
 * Records what a delivery means, against the stored lead.
 *
 * Returns what happened rather than throwing on the ordinary cases: a delivery
 * that changes nothing notifiable, or names a lead not yet synced, is a normal
 * outcome and the endpoint should still answer 200 so Surense does not retry
 * something that will never succeed.
 *
 * @param {object} input
 * @param {import('../db/index.js').Database} input.db
 * @param {object} input.payload
 * @param {object} input.columns   config.messaging.columns
 * @param {string} input.timeZone
 * @returns {Promise<{recorded: boolean, reason: ?string, changeIds: Array<number>}>}
 */
export async function recordDelivery({ db, payload, columns, timeZone }) {
  const event = interpretDelivery(payload);

  if (!event.isLeadUpdate) {
    return { recorded: false, reason: event.reason, changeIds: [] };
  }

  if (event.statusAfter === null) {
    return { recorded: false, reason: event.reason, changeIds: [] };
  }

  const lead = await db.getLead(event.leadId);

  // A lead the sync has not seen yet. The next POST /api/sync will pick it up,
  // and its status will be recorded then — so this is a wait, not a failure.
  if (!lead) {
    return {
      recorded: false,
      reason: `lead ${event.leadId} is not in the database yet; run a sync`,
      changeIds: []
    };
  }

  const changeIds = await db.recordWebhookChange({
    leadId: event.leadId,
    statusColumn: columns.status,
    before: event.statusBefore ?? '',
    after: event.statusAfter,
    occurredAt: event.occurredAt,
    timeZone
  });

  return { recorded: true, reason: null, changeIds, event };
}
