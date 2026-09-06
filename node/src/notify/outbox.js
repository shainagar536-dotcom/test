/**
 * The outbox: turning "this status changed" into "send this text to this
 * person", or into a stated reason why nothing should be sent.
 *
 * Nothing here sends anything. It decides, and the caller sends — which is
 * what lets the whole decision be tested without a mail server, and what lets
 * a dry run be the identical code path.
 */

import { normalizeText } from '../mirror.js';
import { resolveSourceName } from '../sources.js';

/** Why a change produced no message. */
export const SKIP = {
  noTemplate: 'no-template',
  templateOff: 'template-inactive',
  noSource: 'lead-has-no-source',

  // The lead names a source, but no name is known for that id. Distinct from
  // noSource on purpose: one means the CRM told us nothing, the other means
  // it told us something we cannot yet read. They need opposite fixes, and
  // collapsing them hides which one is actually happening.
  unknownSource: 'source-id-not-mapped',

  // The name this was called while the two implementations of the mapping
  // lived on separate branches. Same string; kept so existing callers and
  // stored reports do not silently stop matching.
  unmappedSource: 'source-id-not-mapped',
  noRecipient: 'source-not-in-recipients',
  recipientOff: 'recipient-inactive',
  noAddress: 'recipient-has-no-address',

  // The event is recorded but its source has not been looked up yet. Not a
  // reason to send nothing forever — a reason to wait for the enrichment pass.
  sourcePending: 'source-not-looked-up-yet',

  // The wording quotes a value the event does not carry — today that means
  // {total}, the "סך הכל" amount the CRM does not expose. Sending
  // "הוגשו החזרים בסך {total}" to a partner is worse than sending nothing,
  // and worse than either is not knowing it happened.
  unfilled: 'message-has-an-unfilled-value'
};

/** A placeholder still sitting in the text after filling. */
const UNFILLED = /\{[^{}]{1,60}\}/;

/**
 * Fills placeholders, treating a known-but-empty value as empty.
 *
 * render() leaves an empty value visible, which is right for a draft: an
 * unfilled slot is a bug report. It is wrong here, because a lead with no
 * handler would leave "{assignee}" in a message to a partner — or, with the
 * hold below, stop the message going out at all over a field nobody needs.
 *
 * So a key we know about renders as itself even when empty, and only a key
 * we have never heard of survives — which is a typo in a template, and worth
 * holding for.
 *
 * @param {string} text
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
function fill(text, values) {
  return String(text).replace(/\{([^{}]{1,60})\}/g, (whole, key) => {
    const trimmed = key.trim();

    if (!Object.hasOwn(values, trimmed)) return whole;

    const value = values[trimmed];
    return value === null || value === undefined ? '' : String(value);
  });
}

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
 * @param {object} input.columns             {status, source, sourceId, clientName, leadNumber}
 * @param {Map<string, string>} [input.sourceNames]  Source id -> name.
 * @param {object} input.messaging           {subject, body, signature, maxPerRun}
 * @returns {{ready: Array<object>, skipped: Array<object>, floodBrake: ?object}}
 */
export function buildOutbox({
  changes, templates, recipients, columns, messaging, sourceNames = new Map()
}) {
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

    // The lead carries `sourceId` and no name, so the name is looked up.
    // Which of the two failures this is matters: an id with no mapping is a
    // gap in the source catalog, while no id at all is a lead the CRM never
    // attributed to anyone.
    const { name: sourceName, id: sourceId } =
      resolveSourceName(fields, columns, sourceNames);

    if (!sourceName) {
      skip(sourceId ? SKIP.unknownSource : SKIP.noSource, sourceId || null);
      continue;
    }

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

    // While a redirect address is set, nothing reaches the real source. The
    // intended address travels with the message so a pilot run still shows
    // exactly who would have received it.
    const redirected = Boolean(messaging.redirectAllTo);

    ready.push({
      changeId: change.id,
      leadId: change.lead_id,
      channel: template.channel,
      to: redirected ? messaging.redirectAllTo : address,
      intendedFor: redirected ? address : null,
      redirected,
      recipient: recipient.source_name,
      status,
      statusBefore: change.before_value ?? '',
      subject: redirected
        ? `[פיילוט → ${address}] ${render(messaging.subject, values)}`
        : render(messaging.subject, values),
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


/**
 * Decides what to send for a set of recorded status events.
 *
 * The event already carries the customer, the move and the referring source,
 * because the enrichment pass resolved it when the event arrived. So unlike
 * the lead-mirror path this needs no lead table at all: everything the
 * decision depends on is on the row.
 *
 * @param {object} input
 * @param {Array<object>} input.events        Rows from listStatusEvents.
 * @param {Map<string, object>} input.templates    Keyed by normalized status.
 * @param {Map<string, object>} input.recipients   Keyed by normalized source.
 * @param {object} input.messaging
 * @returns {{ready: Array<object>, skipped: Array<object>, floodBrake: ?object}}
 */
export function buildEventOutbox({ events, templates, recipients, messaging }) {
  const ready = [];
  const skipped = [];

  for (const event of events) {
    const status = event.status_after ?? '';
    const template = templates.get(normalizeText(status));

    const skip = (reason, detail) => skipped.push({
      eventId: Number(event.id),
      leadId: event.lead_id,
      customer: event.customer_name,
      status,
      reason,
      detail: detail ?? null
    });

    // The closed allowlist: a status nobody has written wording for sends
    // nothing, which keeps the statuses still being decided quiet rather than
    // guessing at a message.
    if (!template) { skip(SKIP.noTemplate); continue; }
    if (!template.active) { skip(SKIP.templateOff); continue; }

    if (event.source_state === 'absent') { skip(SKIP.noSource); continue; }

    if (event.source_state !== 'resolved' || !event.source_name) {
      // Distinguishing "not looked up yet" from "looked up, no such source"
      // is what separates a queue that is moving from one that is stuck.
      skip(event.source_state === 'failed' ? SKIP.unknownSource : SKIP.sourcePending,
        event.source_id || null);
      continue;
    }

    const recipient = recipients.get(normalizeText(event.source_name));

    // Many sources are categories rather than people — a campaign, a
    // friend-referral bucket. Those are meant to be skipped quietly.
    if (!recipient) { skip(SKIP.noRecipient, event.source_name); continue; }
    if (!recipient.active) { skip(SKIP.recipientOff, event.source_name); continue; }

    const address = template.channel === 'whatsapp' ? recipient.whatsapp : recipient.email;
    if (!address) { skip(SKIP.noAddress, event.source_name); continue; }

    // The amount is the one value whose absence changes what the sentence
    // means: "הוגשו החזרים בסך" followed by nothing is not a message anyone
    // should receive. Held until the CRM supplies it.
    if (/\{\s*total\s*\}/.test(template.message) && !event.amount) {
      skip(SKIP.unfilled, '{total}');
      continue;
    }

    const values = {
      status,
      statusBefore: event.status_before ?? '',
      message: fill(template.message, { total: event.amount ?? '' }),
      source: recipient.source_name,
      client: event.customer_name ?? '',
      leadNumber: event.lead_number || event.lead_id,
      assignee: event.assignee_name ?? '',
      total: event.amount ?? '',
      signature: messaging.signature
    };

    const redirected = Boolean(messaging.redirectAllTo);

    const subject = fill(messaging.subject, values);
    const body = fill(messaging.body, values);

    // Anything still unfilled is a placeholder nobody defined — a typo in a
    // template edited through the API. Sending it would put "{clinet}" in
    // front of a partner, so it is held and named instead.
    if (UNFILLED.test(subject) || UNFILLED.test(body)) {
      skip(SKIP.unfilled, (subject + ' ' + body).match(UNFILLED)?.[0] ?? null);
      continue;
    }

    ready.push({
      eventId: Number(event.id),
      leadId: event.lead_id,
      channel: template.channel,
      to: redirected ? messaging.redirectAllTo : address,
      intendedFor: redirected ? address : null,
      redirected,
      recipient: recipient.source_name,
      customer: event.customer_name,
      assignee: event.assignee_name,
      status,
      statusBefore: event.status_before ?? '',
      subject: redirected ? `[פיילוט → ${address}] ${subject}` : subject,
      body,
      occurredAt: event.occurred_at
    });
  }

  // The flood brake. A bulk status edit in the CRM would otherwise fire one
  // real message per lead, and none of them can be recalled.
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
          'mark the events as notified to discard them.'
      }
    };
  }

  return { ready, skipped, floodBrake: null };
}
