/**
 * Keeping every lead's owner pointed at one person.
 *
 * Leads arrive in the CRM owned by whoever created them, and the referring
 * source can only be read for a lead this key is allowed to see — so an
 * owner it cannot see is a notification that never goes out. Normalising the
 * owner is what keeps that from happening.
 *
 * This is the only part of the service that writes to the CRM, and it writes
 * exactly one field. The assignee — who actually handles the lead — is never
 * sent, so it stays whatever a person set it to.
 *
 * Off unless OWNER_NORMALIZE_ID names a user: silence is the right default
 * for the only code here that can change the CRM.
 */

/** Stored in `cursors` as epoch seconds, so the pass can be daily. */
const CURSOR = 'owner-normalize';

/**
 * @param {object} deps
 * @param {import('../surense.js').SurenseClient} deps.client
 * @param {import('../db/index.js').Database} deps.db
 * @param {object} deps.owner   config.owner
 * @param {Date}   [deps.now]
 * @returns {Promise<object>} what happened, for the run summary
 */
export async function normalizeOwners({ client, db, owner, now = new Date() }) {
  if (!owner.targetId) return { ran: false, reason: 'not configured' };

  const dueAt = await nextDueAt(db, owner.everyHours);

  if (now.getTime() < dueAt) {
    return { ran: false, reason: 'not due', dueAt: new Date(dueAt).toISOString() };
  }

  const { leads, complete } = await client.fetchAllLeads();

  // A truncated read is not a reason to stop — unlike the mirror, nothing
  // here is inferred from a lead's absence, so a short read simply means
  // fewer leads were looked at this time. It is reported, not acted on.
  const drifted = leads.filter(lead => lead.ownerId !== owner.targetId);

  // The brake. If the configured id is ever wrong — a typo, a user removed
  // in the CRM — every lead in the system looks drifted, and without this
  // the next run would rewrite all of them before anyone noticed.
  if (drifted.length > owner.maxPerRun) {
    return {
      ran: false,
      reason: 'too many at once',
      scanned: leads.length,
      drifted: drifted.length,
      limit: owner.maxPerRun,
      message:
        `${drifted.length} leads have an owner other than the configured ` +
        `one, above the limit of ${owner.maxPerRun}. Nothing was changed. ` +
        'Check OWNER_NORMALIZE_ID names the right user before raising it.'
    };
  }

  let changed = 0;
  let failed = 0;
  const failures = [];

  for (const lead of drifted) {
    try {
      await client.setLeadOwner(lead.id, owner.targetId);
      changed++;
    } catch (error) {
      failed++;

      // Ten or so leads are refused outright — this key may not act on that
      // customer. Those need a permission in Surense, not another attempt,
      // so they are named once rather than retried every day.
      if (failures.length < 10) {
        failures.push({
          lead: lead.number ?? lead.id,
          status: error.status ?? 0,
          error: String(error.message).slice(0, 120)
        });
      }
    }
  }

  await markDone(db, now);

  return {
    ran: true,
    scanned: leads.length,
    complete,
    drifted: drifted.length,
    changed,
    failed,
    failures
  };
}

/**
 * When the next pass is allowed, as epoch milliseconds.
 *
 * @param {import('../db/index.js').Database} db
 * @param {number} everyHours
 */
async function nextDueAt(db, everyHours) {
  const cursor = await db.getCursor(CURSOR).catch(() => null);
  const lastSeconds = Number(cursor?.last_id ?? 0);

  if (!lastSeconds) return 0;

  return (lastSeconds + everyHours * 3600) * 1000;
}

/**
 * @param {import('../db/index.js').Database} db
 * @param {Date} now
 */
async function markDone(db, now) {
  // saveCursor only ever moves forward, which is what a timestamp wants.
  await db.saveCursor(CURSOR, Math.floor(now.getTime() / 1000),
    'last owner normalisation').catch(() => {});
}
