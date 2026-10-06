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
import { isOutage, isForbiddenRecord } from '../surense.js';

/** How the source of an event ended up. */
export const SOURCE_STATE = {
  pending: 'pending',
  resolved: 'resolved',
  absent: 'absent',
  failed: 'failed',

  // The CRM says this key's user may not see this record. Terminal, unlike
  // 'failed': no retry can change a permission, and treating it as retryable
  // had a hundred events asking the same forbidden question every hour while
  // their notifications were never going to go out. Only a permission granted
  // in Surense, followed by an explicit retry, moves these.
  blocked: 'blocked'
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

/** A field id, as the CRM writes them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The keys a custom-field entry might hold its value under. */
const VALUE_KEYS = ['value', 'valueText', 'textValue', 'displayValue'];

/**
 * Reads a configured column off a lead, named or custom.
 *
 * "סך הכל" is not a field on the lead. The row carries a `customFields` list
 * of {fieldId, value} with no names in it, and the name is in the schema —
 * so a setting that only looked at `lead[name]` would find nothing and every
 * message quoting the amount would be held forever, looking exactly like a
 * CRM that does not have the column.
 *
 * The setting may therefore name either: a plain field, a custom field's id,
 * or — the one a person would actually write — a custom field's label.
 *
 * Returns '' on any failure, which holds the message. That direction is
 * deliberate: a missing amount stops a message, a wrong one sends a number
 * to a partner.
 *
 * @param {object} lead
 * @param {import('../surense.js').SurenseClient} client
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function readConfiguredValue(lead, client, name) {
  if (!name) return '';

  // A plain field wins: it is the cheaper answer and needs no schema at all.
  const direct = lead?.[name];
  if (direct !== undefined && direct !== null && typeof direct !== 'object') {
    return String(direct);
  }

  const entries = Array.isArray(lead?.customFields) ? lead.customFields : [];
  if (!entries.length) return '';

  let id = UUID.test(name) ? name : null;

  if (!id) {
    try {
      id = (await client.customFieldIds()).get(name.trim()) ?? null;
    } catch {
      // The schema call failed. Holding the message is the safe answer.
      return '';
    }
  }

  if (!id) return '';

  const entry = entries.find(row => String(row?.fieldId ?? row?.id ?? '') === id);
  if (!entry) return '';

  for (const key of VALUE_KEYS) {
    const value = entry[key];
    if (value !== undefined && value !== null && typeof value !== 'object') {
      const text = String(value).trim();
      if (text) return text;
    }
  }

  return '';
}

/**
 * The referring source read off the customer rather than the lead.
 *
 * A customer record names the source in full — `sourceId` and `sourceName`
 * both — so unlike a lead it needs no catalog lookup to be useful. The
 * assignee and the amount are not there, and that is accepted: a message
 * naming the status and the customer is worth incomparably more than no
 * message, and the wordings that quote an amount hold themselves back.
 *
 * Answers with the patch when it can, and otherwise with why not: a refusal
 * on permission grounds settles the row, where anything else leaves the
 * original lead failure standing as the reason — that is what explains it.
 *
 * @param {object} event     A status_events row.
 * @param {import('../surense.js').SurenseClient} client
 * @returns {Promise<?{patch?: object, forbidden?: boolean, error?: ?Error}>}
 */
export async function sourceFromCustomer(event, client) {
  const customerId = String(event?.customer_id ?? '').trim();
  if (!customerId) return null;

  let customer;

  try {
    customer = await client.fetchCustomerById(customerId);
  } catch (error) {
    // Passed back rather than swallowed: "you may not see this customer" is
    // the one refusal that settles the row instead of postponing it.
    return { forbidden: isForbiddenRecord(error), error };
  }

  const sourceId = String(customer?.sourceId ?? '').trim();
  const sourceName = String(customer?.sourceName ?? '').trim();

  if (!sourceName) return { forbidden: false, error: null };

  return {
    patch: {
      sourceId,
      sourceName,
      sourceState: SOURCE_STATE.resolved,
      sourceError: '',
      // Recorded so a row resolved this way is never mistaken for one the
      // lead answered: it carries no assignee and no amount, by nature.
      viaCustomer: true
    }
  };
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
    // Says whether the CRM refused everyone or only this lead. The caller
    // stops the batch on the first of these: the next twenty-four lookups
    // would ask the same question of the same unavailable service, and
    // against a 429 that is not a retry but the cause.
    if (isOutage(error)) {
      return {
        sourceState: SOURCE_STATE.failed,
        sourceError: `lead lookup failed: ${error.message}`,
        outage: true
      };
    }

    // This one lead is unreadable while the CRM is fine — deleted, merged, or
    // outside what this client may see. Retrying the lead will never answer,
    // so ask the customer instead: that record carries the referring source
    // outright, and this is the difference between a notification arriving
    // and an event sitting stuck forever with money in its wording.
    const viaCustomer = await sourceFromCustomer(event, client);

    if (viaCustomer?.patch) return viaCustomer.patch;

    // The CRM has told us, about one of the two records, that this key's user
    // may not see it. That is not a lookup that failed — it is an answer, and
    // the only thing that changes it is a permission granted in Surense. So
    // the row stops asking: 'blocked' is terminal and the retry pass skips
    // it, where 'failed' had it re-asking the same forbidden question hourly
    // until it quietly ran out of attempts.
    if (isForbiddenRecord(error) || viaCustomer?.forbidden) {
      return {
        sourceState: SOURCE_STATE.blocked,
        sourceError: 'the CRM refuses this record to our key: ' +
          'אינך מורשה לצפות או לבצע פעולות על לקוח זה — ' +
          'the integration user needs permission for this customer in Surense',
        outage: false
      };
    }

    // The lead cannot be read and the customer did not answer either. Still
    // 'failed' rather than 'absent': nothing here established that the lead
    // has no source, only that we could not find out.
    return {
      sourceState: SOURCE_STATE.failed,
      sourceError: `lead lookup failed: ${error.message}`,
      outage: false
    };
  }

  const assigneeName = String(
    lead[columns.assignee] ?? lead.assigneeName ?? lead.ownerName ?? '');

  // Only read when a column is configured for it: with no column set, an
  // empty amount is the honest answer, and the wording that quotes it is
  // held rather than sent half-written.
  const amount = await readConfiguredValue(lead, client, columns.total);

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
 * Fills in the amount on events that resolved before the field was known.
 *
 * enrichPending only looks at events whose source is unresolved, which is
 * right — but it means every event already on the table keeps the empty
 * amount it was recorded with, and the two messages that quote the amount
 * stay held forever with nothing left to retry them.
 *
 * Only the statuses whose wording actually quotes the amount are read back,
 * because each one costs a request to the CRM and the rest do not need it.
 *
 * @param {object} input
 * @param {import('../db/index.js').Database} input.db
 * @param {import('../surense.js').SurenseClient} input.client
 * @param {object} input.config
 * @param {number} [input.limit]
 * @returns {Promise<{processed: number, filled: number, stillEmpty: number}>}
 */
export async function backfillAmounts({ db, client, config, limit = 50 }) {
  const column = config.messaging.columns.total;
  const summary = { processed: 0, filled: 0, stillEmpty: 0, column: column || null };

  // With no column configured there is nothing to read, and every event would
  // be fetched from the CRM to learn that.
  if (!column) return summary;

  const quotesAmount = (await db.listTemplates())
    .filter(template => /\{\s*total\s*\}/.test(template.message ?? ''))
    .map(template => template.status);

  const events = await db.eventsMissingAmount({ statuses: quotesAmount, limit });

  for (const event of events) {
    let lead;

    try {
      lead = await client.fetchLeadById(event.lead_id);
    } catch {
      // The source is already resolved on this row; a failed read here costs
      // the amount, not the event, and the next run tries again.
      summary.processed++;
      summary.stillEmpty++;
      continue;
    }

    const amount = await readConfiguredValue(lead, client, column);

    if (amount) {
      // Only the amount. The source on this row is already resolved, and
      // the enrichment writer would reset its state as a side effect.
      await db.setEventAmount(event.id, amount);
      summary.filled++;
    } else {
      summary.stillEmpty++;
    }

    summary.processed++;
  }

  return summary;
}

/**
 * Asks again about the customers the CRM refuses.
 *
 * A blocked row is terminal on purpose — nothing in this service can grant a
 * permission — but "terminal" must not mean "forgotten". The owner's wish is
 * that a status change reaches its source whoever owns the lead, and the only
 * thing standing in the way is a permission inside Surense. So this watches
 * for it: once a day each refused customer is asked about once, and the day
 * the permission appears, every event behind it releases itself with nobody
 * touching anything.
 *
 * Deliberately cheap. It asks about the CUSTOMER only — one request, the
 * record the refusal actually names — rather than re-running the full
 * enrichment, which would read the lead twice first. Thirty-six questions
 * instead of three hundred, and the full enrichment follows only for the
 * customers that answered.
 *
 * @param {object} input
 * @param {import('../db/index.js').Database} input.db
 * @param {import('../surense.js').SurenseClient} input.client
 * @param {number} [input.hours]   How long to leave a refused customer alone.
 * @param {number} [input.limit]   Customers per sweep.
 * @returns {Promise<{asked: number, opened: number, released: number,
 *                    stillRefused: number, outage: ?string}>}
 */
export async function recheckBlocked({ db, client, hours = 20, limit = 40 }) {
  const summary = {
    asked: 0, opened: 0, released: 0, stillRefused: 0, outage: null
  };

  const customers = await db.blockedCustomers?.({ hours, limit }) ?? [];

  for (const row of customers) {
    summary.asked++;

    try {
      const customer = await client.fetchCustomerById(row.customer_id);

      // Readable again. The permission is there, so hand every event behind
      // this customer back to the ordinary pass — which reads the lead and
      // gets the assignee and the amount too, not just the source.
      summary.opened++;
      summary.released += await db.requeueBlockedCustomer(row.customer_id);

      // Nothing is read off `customer` here on purpose: the lead is the
      // better answer now that it is reachable, and this call was a question
      // about access, not a shortcut around it.
      void customer;
    } catch (error) {
      if (isOutage(error)) {
        // The CRM is refusing everyone. Stop: the remaining customers would
        // each get the same answer, and asking anyway is what turns a rate
        // limit into an outage.
        summary.outage = error.message;
        break;
      }

      summary.stillRefused++;
      await db.touchBlockedCustomer(row.customer_id);
    }
  }

  return summary;
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
  // Before asking the CRM anything: fill in customer ids we already hold.
  // The fallback below needs them, and they were in the stored deliveries all
  // along. Pure SQL, no request, and a no-op once nothing is missing.
  const linked = await db.linkCustomerIds?.() ?? 0;

  // And look once a day at the customers the CRM refuses, so a permission
  // granted in Surense releases their events on its own. The gate is inside:
  // a customer asked about today is skipped, so this costs nothing on the
  // other twenty-three runs.
  const recheck = await recheckBlocked({ db, client });

  const events = await db.pendingEnrichment({ limit });

  const summary = {
    processed: 0, resolved: 0, failed: 0, absent: 0, catalogRefreshed: false,

    // Customer ids recovered from stored deliveries, and events that resolved
    // off the customer because their lead could not be read. Reported
    // separately: those rows carry no assignee and no amount, and a count
    // that climbs says leads are disappearing from under us.
    customerIdsLinked: linked, viaCustomer: 0,

    // Rows settled as 'blocked': the CRM will not show us that record at all.
    // Counted because it is the one failure a retry cannot touch, and the
    // fix is a permission inside Surense rather than anything here.
    blocked: 0,

    // What the daily look at those refused customers found. `opened` above
    // zero is the good news: a permission was granted and their events are
    // back in the queue by themselves.
    recheck,

    // Set when the CRM itself is the problem. Named rather than folded into
    // `failed`, because the two need opposite responses: a failed row is a
    // question about that lead, an outage is a question for whoever runs the
    // CRM — and the service went eight days looking like the first while
    // being the second.
    outage: null
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

    // The CRM is down, refusing, or rate-limiting. Stop here and write
    // nothing: every remaining event would get the identical failure, each
    // one spending an attempt it will never get back and asking a throttled
    // endpoint one more time. The rows are left exactly as they were, so the
    // next run finds them unchanged rather than one attempt poorer.
    if (patch.outage) {
      summary.outage = patch.sourceError;
      break;
    }

    await db.enrichStatusEvent(event.id, patch);

    summary.processed++;
    if (patch.sourceState === SOURCE_STATE.resolved) summary.resolved++;
    if (patch.sourceState === SOURCE_STATE.failed) summary.failed++;
    if (patch.sourceState === SOURCE_STATE.absent) summary.absent++;
    if (patch.sourceState === SOURCE_STATE.blocked) summary.blocked++;
    if (patch.viaCustomer) summary.viaCustomer++;
  }

  return summary;
}
