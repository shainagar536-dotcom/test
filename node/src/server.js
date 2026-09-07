#!/usr/bin/env node
/**
 * Entrypoint: migrate, start the API, and schedule syncs.
 *
 * On Render's free tier the service sleeps after 15 minutes of inactivity, so
 * the internal timer below cannot be relied on as the schedule. It is a
 * best-effort extra for whenever the process happens to be awake; the actual
 * trigger is an external scheduler calling POST /api/sync, which both wakes
 * the service and runs the work.
 */

import { loadConfig, isWithinSchedule } from './config.js';
import { Database } from './db/index.js';
import { createApi } from './api/server.js';
import { runSync } from './sync/run.js';
import { SEED_TEMPLATES, MUTED_STATUSES } from './notify/seeds.js';
import { SEED_RECIPIENTS } from './notify/recipients-seed.js';

const config = loadConfig();
const db = new Database(config.database);

await db.migrate();

// Only ever writes into an empty table, so wording edited through the API is
// never overwritten by a later deploy.
const seeded = await db.seedTemplates(SEED_TEMPLATES);
if (seeded) console.log(`Seeded ${seeded} status templates.`);

const seededRecipients = await db.seedRecipients(SEED_RECIPIENTS);
if (seededRecipients) console.log(`Seeded ${seededRecipients} recipients.`);

const seededMuted = await db.seedMutedStatuses(MUTED_STATUSES);
if (seededMuted) console.log(`Seeded ${seededMuted} muted statuses.`);

// The seed above only ever writes into an EMPTY table, so wording added to
// the code after the first boot could never arrive on its own — the table is
// not empty, the seed is skipped, and those statuses stay silent with nobody
// able to tell that from a decision. This adds only what is missing and
// leaves every existing row, edited or not, exactly as it is.
const { added } = await db.addMissingTemplates(SEED_TEMPLATES);
if (added.length) {
  console.log(`Added wording for ${added.length} status(es): ${added.join(', ')}`);
}

console.log('Database ready.');

const server = createApi({ db, config });

server.listen(config.api.port, () => {
  console.log(`API listening on :${config.api.port}`);
  console.log(`  window: days [${config.sync.activeDays}] ` +
    `hours [${config.sync.activeHours}] ${config.sync.timeZone}`);
});

// Best-effort internal schedule. Checks often enough to catch the top of an
// active hour, and does nothing outside the window.
let lastRunHour = null;

const timer = setInterval(async () => {
  const now = new Date();
  if (!isWithinSchedule(now, config.sync)) return;

  const hourKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.sync.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).format(now);

  if (hourKey === lastRunHour) return;   // already handled this hour
  lastRunHour = hourKey;

  try {
    const summary = await runSync({ db, config, trigger: 'timer' });
    console.log('Scheduled sync:', JSON.stringify(summary));
  } catch (error) {
    console.error('Scheduled sync failed:', error.message);
  }
}, 60_000);

/** Render sends SIGTERM on deploy and on scale-down; finish cleanly. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down.`);
    clearInterval(timer);
    server.close();
    await db.close();
    process.exit(0);
  });
}
