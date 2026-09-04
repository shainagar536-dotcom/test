/**
 * The outbox: turning "this status changed" into "send this text to this
 * person", or into a stated reason why nothing should be sent.
 *
 * Nothing here sends anything. It decides, and the caller sends — which is
 * what lets the whole decision be tested without a mail server, and what lets
 * a dry run be the identical code path.
 */

import { normalizeText } from '../mirror.js';

/** Why a change produced no message. */
export const SKIP = {
  noTemplate: 'no-template',
  templateOff: 'template-inactive',
  noSource: 'lead-has-no-source',
  noRecipient: 'source-not-in-recipients',
  recipientOff: 'recipient-inactive',
  noAddress: 'recipient-has-no-address'
};

/**
 * Fills {placeholders} from the lead's fields plus a few extras.
 *
 * An unknown placeholder is left as it is rather than replaced with "undefined":
 * a visibly unfilled slot in a test message is a bug report, while the word
 * undefined in a message to a real client is an incident.
 *
 * @param {string} text
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export function render(text, values) {
  return String(text).replace(/\{([^{}]{1,60})\}/g, (whole, key) => {
    const trimmed = key.trim();
    const value = values[trimmed];

    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}

/**
 * Decides what should go out for a set of pending changes.
 *
 * @param {object} input
 * @param {Array<object>} input.changes      Rows from listChanges, with .fields.
 * @param {Map<string, object>} input.templates   Keyed by normalized status.
 * @param {Map<string, object>} input.recipients  Keyed by normalized source.
 * @param {object} input.columns             {status, source, clientName, leadNumber}
 * @param {object} input.messaging           {subject, body, signature, maxPerRun}
 * @returns {{ready: Array<object>, skipped: Array<object>, floodBrake: ?object}}
 */
export function buildOutbox({ changes, templates, recipients, columns, messaging }) {
  const ready = [];
  const skipped = [];

  for (const change of changes) {
    const fields = change.fields ?? {};

    // Only a move of the status column is a notifiable event. A phone number
    // being corrected is a change, but not one anybody was promised.
    if (change.column_name !== columns.status) continue;

    const status = change.after_value ?? '';
    const template = templates.get(normalizeText(status));

    const skip = (reason, detail) => skipped.push({
      changeId: change.id,
      leadId: change.lead_id,
      status,
      reason,
      detail: detail ?? null
    });

    // The closed allowlist. A status nobody has written wording for sends
    // nothing at all, which is what keeps the not-yet-defined statuses quiet
    // rather than guessing at a message.
    if (!template) { skip(SKIP.noTemplate); continue; }
    if (!template.active) { skip(SKIP.templateOff); continue; }

    const sourceName = fields[columns.source] ?? '';
    if (!sourceName) { skip(SKIP.noSource); continue; }

    const recipient = recipients.get(normalizeText(sourceName));

    // Many "sources" are categories, not people — a campaign or a
    // friend-referral bucket. Those have no row here and are meant to be
    // skipped quietly rather than reported as failures.
    if (!recipient) { skip(SKIP.noRecipient, sourceName); continue; }
    if (!recipient.active) { skip(SKIP.recipientOff, sourceName); continue; }

    const address = template.channel === 'whatsapp' ? recipient.whatsapp : recipient.email;
    if (!address) { skip(SKIP.noAddress, sourceName); continue; }

    const values = {
      ...fields,
      status,
      statusBefore: change.before_value ?? '',
      message: template.message,
      source: recipient.source_name,
      client: fields[columns.clientName] ?? '',
      leadNumber: fields[columns.leadNumber] ?? change.lead_id,
      signature: messaging.signature
    };

    ready.push({
      changeId: change.id,
      leadId: change.lead_id,
      channel: template.channel,
      to: address,
      recipient: recipient.source_name,
      status,
      statusBefore: change.before_value ?? '',
      subject: render(messaging.subject, values),
      body: render(messaging.body, values),
      occurredAt: change.occurred_at
    });
  }

  // The flood brake. A bulk status edit in the CRM — marking two hundred
  // leads "no answer" in one pass — would otherwise fire two hundred real
  // messages to real people within a minute, and none of them can be recalled.
  if (ready.length > messaging.maxPerRun) {
    return {
      ready: [],
      skipped,
      floodBrake: {
        blocked: ready.length,
        limit: messaging.maxPerRun,
        statuses: [...new Set(ready.map(item => item.status))],
        message:
          `${ready.length} messages were queued in one run, above the limit ` +
          `of ${messaging.maxPerRun}. Nothing is being released. Review the ` +
          'CRM for a bulk edit, then raise MAX_SENDS_PER_RUN for one run or ' +
          'mark the changes as notified to discard them.'
      }
    };
  }

  return { ready, skipped, floodBrake: null };
}

/**
 * Groups skip reasons into counts, so a run reports "31 sources not in the
 * recipients table" rather than 31 near-identical lines.
 *
 * @param {Array<object>} skipped
 * @returns {Record<string, {count: number, examples: Array<string>}>}
 */
export function summarizeSkips(skipped) {
  const summary = {};

  for (const item of skipped) {
    const entry = summary[item.reason] ??= { count: 0, examples: [] };
    entry.count++;

    if (item.detail && entry.examples.length < 10 &&
        !entry.examples.includes(item.detail)) {
      entry.examples.push(item.detail);
    }
  }

  return summary;
}
