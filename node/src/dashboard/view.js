/**
 * Assembling what the dashboard shows, with no I/O of its own.
 *
 * The "handled" column is the point of the screen, and the one thing it must
 * never do is disagree with the sender. So it is not re-derived here: the
 * pending changes are run through the outbox's own decision, and this
 * translates the answer. If a change would be skipped for want of a template,
 * that is what the row says, because that is what would actually happen.
 */

import { buildOutbox } from '../notify/outbox.js';
import { formatValue, labelFor, deliveryLabel, formatDate } from './labels.js';
import { resolveSourceName } from '../sources.js';

/**
 * Works out, for each lead on the page, whether anything is owed to anyone.
 *
 * @param {object} input
 * @param {Array<object>} input.leads     Rows from listLeadsForDashboard.
 * @param {Array<object>} input.pending   Unsent status changes for those leads.
 * @param {Map<string, object>} input.lastSend  Lead id -> the last send.
 * @param {Map<string, object>} input.templates
 * @param {Map<string, object>} input.recipients
 * @param {Map<string, string>} input.sourceNames
 * @param {object} input.columns
 * @param {object} input.messaging
 * @returns {Array<object>}
 */
export function describeLeads({
  leads, pending, lastSend, templates, recipients, sourceNames, columns, messaging
}) {
  // The flood brake is a property of a send run, not of a lead. Raising it
  // here keeps a bulk edit from painting every row "will not be sent" when
  // the real answer is "these are queued and the brake is holding them".
  const { ready, skipped } = buildOutbox({
    changes: pending,
    templates, recipients, sourceNames, columns,
    messaging: { ...messaging, maxPerRun: Number.MAX_SAFE_INTEGER }
  });

  const sendable = new Set(ready.map(item => item.changeId));
  const reasons = new Map(skipped.map(item => [item.changeId, item.reason]));

  const pendingByLead = new Map();
  for (const change of pending) {
    if (!pendingByLead.has(change.lead_id)) pendingByLead.set(change.lead_id, []);
    pendingByLead.get(change.lead_id).push(change);
  }

  return leads.map(lead => {
    const fields = lead.fields ?? {};

    const display = {};
    for (const [key, value] of Object.entries(fields)) {
      display[key] = formatValue(key, value);
    }

    const { name: sourceName } = resolveSourceName(fields, columns, sourceNames);

    return {
      id: lead.id,
      changedAt: formatDate(lead.changed_at),
      changeType: lead.change_type,
      sourceName,
      display,
      handled: handledState({
        lead,
        pending: pendingByLead.get(lead.id) ?? [],
        lastSend: lastSend.get(lead.id),
        sendable,
        reasons
      })
    };
  });
}

/**
 * One lead's delivery state.
 *
 * Four states, and the difference between two of them is what makes the
 * screen worth reading: "ממתין לשליחה" means the next run sends it, while
 * "לא יישלח" means nothing will ever send it until something is fixed. A
 * single "not yet" for both would hide a permanent gap behind a word that
 * promises it is temporary.
 *
 * @returns {{state: string, label: string, reason: ?string, at: ?string, via: ?string}}
 */
function handledState({ lead, pending, lastSend, sendable, reasons }) {
  if (pending.length) {
    const willSend = pending.some(change => sendable.has(change.id));

    if (willSend) {
      return { state: 'pending', label: deliveryLabel('pending'), reason: null, at: null, via: null };
    }

    // Blocked: report the newest change's reason, which is the one that
    // matters — an older one may have been blocked for a reason since fixed.
    const newest = pending[pending.length - 1];
    const reason = reasons.get(newest.id);

    return {
      state: 'blocked',
      label: deliveryLabel('blocked'),
      reason: reason ? deliveryLabel(reason) : null,
      at: null,
      via: null
    };
  }

  if (lastSend) {
    return {
      state: 'sent',
      label: deliveryLabel('sent'),
      reason: null,
      at: formatDate(lastSend.notified_at),
      via: lastSend.notified_via || null
    };
  }

  // No status change has ever been recorded for this lead. Nothing is owed:
  // the mirror has it, but it has not moved since the baseline was taken.
  return { state: 'none', label: deliveryLabel('none'), reason: null, at: null, via: null };
}

/**
 * The label map the page needs, for exactly the keys in use.
 *
 * Built from the stored leads rather than from a fixed list, so a field added
 * in the CRM appears on the dashboard — untranslated and visible — instead of
 * disappearing until somebody writes a label for it.
 *
 * @param {Array<string>} keys
 * @returns {Record<string, string>}
 */
export function labelMap(keys) {
  return Object.fromEntries(keys.map(key => [key, labelFor(key)]));
}
