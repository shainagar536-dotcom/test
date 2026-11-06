/**
 * The owner-normalisation pass: the only code here that writes to the CRM.
 *
 * What is worth proving is mostly what it does NOT do — stay off unless
 * configured, send one field, leave the assignee alone, and refuse to
 * rewrite the whole CRM when the configured id is wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOwners } from '../src/sync/owner.js';

const SHAI = '52b102e4-823c-4d6b-90d2-f08c87d0a515';

const lead = (n, ownerId) => ({
  id: `ld_${n}`, number: String(4000 + n), ownerId,
  assigneeId: 'someone-else', assigneeName: 'שיר נגר', statusName: 'חדש'
});

/** A client that records what it was asked to write. */
function stubClient(leads, { failOn = [] } = {}) {
  const writes = [];

  return {
    writes,
    fetchAllLeads: async () => ({ leads, complete: true }),
    setLeadOwner: async (leadId, ownerId) => {
      if (failOn.includes(leadId)) {
        const error = new Error('not authorized to perform this operation');
        error.status = 400;
        throw error;
      }

      writes.push({ leadId, ownerId });
      return {};
    }
  };
}

/** A database that only has to remember one cursor. */
function stubDb(lastSeconds = 0) {
  let stored = lastSeconds;

  return {
    saved: () => stored,
    getCursor: async () => ({ last_id: stored }),
    saveCursor: async (_name, value) => { stored = Math.max(stored, value); }
  };
}

const owner = (overrides = {}) =>
  ({ targetId: SHAI, everyHours: 24, maxPerRun: 300, ...overrides });

// --------------------------------------------------------------------------
test('it does nothing at all when no owner is configured', async () => {
  // The default. A service that rewrites the CRM because nobody set a
  // variable is the wrong default for the only write in the codebase.
  const client = stubClient([lead(1, 'someone'), lead(2, 'another')]);

  const result = await normalizeOwners({
    client, db: stubDb(), owner: owner({ targetId: '' })
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'not configured');
  assert.equal(client.writes.length, 0);
});

test('a drifted lead is moved and a correct one is left alone', async () => {
  const client = stubClient([lead(1, 'someone'), lead(2, SHAI), lead(3, 'another')]);

  const result = await normalizeOwners({ client, db: stubDb(), owner: owner() });

  assert.equal(result.changed, 2);
  assert.deepEqual(client.writes.map(write => write.leadId), ['ld_1', 'ld_3']);
});

test('the write carries ownerId and nothing else', async () => {
  // The whole promise of this feature: the assignee is not touched.
  const client = stubClient([lead(1, 'someone')]);

  await normalizeOwners({ client, db: stubDb(), owner: owner() });

  assert.deepEqual(client.writes, [{ leadId: 'ld_1', ownerId: SHAI }]);
});

test('a lead the CRM refuses is counted, and the rest still run', async () => {
  // About ten leads are refused outright. One of them must not stop the
  // other nine hundred from being corrected.
  const client = stubClient(
    [lead(1, 'x'), lead(2, 'x'), lead(3, 'x')], { failOn: ['ld_2'] });

  const result = await normalizeOwners({ client, db: stubDb(), owner: owner() });

  assert.equal(result.changed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].lead, '4002');
  assert.match(result.failures[0].error, /not authorized/);
});

test('a wrong owner id does not rewrite the whole CRM', async () => {
  // If the configured id names nobody, every lead looks drifted. The brake
  // is what stands between a typo and four thousand writes.
  const leads = Array.from({ length: 50 }, (_, i) => lead(i, SHAI));
  const client = stubClient(leads);

  const result = await normalizeOwners({
    client, db: stubDb(), owner: owner({ targetId: 'not-a-real-user', maxPerRun: 10 })
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'too many at once');
  assert.equal(result.drifted, 50);
  assert.equal(client.writes.length, 0, 'nothing may be written');
});

test('it runs once a day, not on every sync', async () => {
  const client = stubClient([lead(1, 'someone')]);
  const db = stubDb();

  const first = await normalizeOwners({ client, db, owner: owner() });
  assert.equal(first.ran, true);

  // The sync fires hourly; the pass reads every lead, so it must not.
  const second = await normalizeOwners({ client, db, owner: owner() });
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'not due');
  assert.equal(client.writes.length, 1);
});

test('it runs again once the interval has passed', async () => {
  const client = stubClient([lead(1, 'someone')]);
  const db = stubDb();

  await normalizeOwners({ client, db, owner: owner() });

  const tomorrow = new Date(Date.now() + 25 * 3600 * 1000);
  const again = await normalizeOwners({ client, db, owner: owner(), now: tomorrow });

  assert.equal(again.ran, true);
  assert.equal(client.writes.length, 2);
});

test('a short read is reported rather than acted on', async () => {
  // Unlike the mirror, nothing here is inferred from a lead's absence, so a
  // truncated read means fewer leads were looked at — not that any vanished.
  const client = {
    fetchAllLeads: async () => ({ leads: [lead(1, 'someone')], complete: false }),
    setLeadOwner: async () => ({})
  };

  const result = await normalizeOwners({ client, db: stubDb(), owner: owner() });

  assert.equal(result.complete, false);
  assert.equal(result.changed, 1);
});
