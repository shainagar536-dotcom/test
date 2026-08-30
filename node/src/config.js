/**
 * Configuration, read from the environment.
 *
 * Nothing secret is ever a default. On Render these come from the service's
 * Environment settings; locally from a .env file, which is gitignored.
 */

import { readFileSync } from 'node:fs';

/** Loads .env into process.env without overwriting anything already set. */
export function loadDotEnv(path = '.env') {
  let text;

  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;   // no .env is normal in production
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip one layer of matching quotes, so secrets containing # or spaces work.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}.\n` +
      '  Locally: add it to .env (see .env.example).\n' +
      '  On Render: Service -> Environment -> Add Environment Variable.');
  }

  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function number(name, fallback) {
  const value = optional(name, null);
  if (value === null) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);

  return parsed;
}

export function loadConfig() {
  loadDotEnv();

  return {
    surense: {
      clientId: required('SURENSE_CLIENT_ID'),
      clientSecret: required('SURENSE_CLIENT_SECRET'),
      tokenUrl: optional('SURENSE_TOKEN_URL', 'https://api.surense.com/oauth/token'),

      // The token's aud claim and the integration notes name different hosts;
      // whichever answers first is used.
      apiBases: optional('SURENSE_API_BASE',
        'https://api.surense.com/api/v1,https://www.surense.com/api/v1')
        .split(',').map(base => base.trim()).filter(Boolean),

      pageSize: number('SURENSE_PAGE_SIZE', 50),
      maxPages: number('SURENSE_MAX_PAGES', 400)
    },

    database: {
      // Render injects this for its managed Postgres.
      url: required('DATABASE_URL'),
      // Render's managed Postgres presents a certificate the default trust
      // store does not carry; its own docs prescribe this for external URLs.
      ssl: optional('DATABASE_SSL', 'true') === 'true'
        ? { rejectUnauthorized: false }
        : false,
      maxConnections: number('DATABASE_POOL', 5)
    },

    api: {
      port: number('PORT', 3000),

      // The API serves customer names and phone numbers. A token is required,
      // not optional — see the note in api/server.js.
      token: required('API_TOKEN'),

      // Shared secret a webhook sender must present. Separate from API_TOKEN
      // so a sender can be revoked without cutting off every reader.
      webhookSecret: optional('WEBHOOK_SECRET', '')
    },

    sync: {
      timeZone: optional('TIMEZONE', 'Asia/Jerusalem'),
      idKey: optional('LEAD_ID_FIELD', 'id'),

      // Automatic syncing while the process happens to be awake. On Render's
      // free tier the service sleeps, so the scheduled trigger is an external
      // caller hitting POST /api/sync.
      intervalMinutes: number('SYNC_INTERVAL_MINUTES', 60),
      activeDays: optional('ACTIVE_DAYS', '0,1,2,3,4,5')
        .split(',').map(Number).filter(Number.isFinite),
      activeHours: optional('ACTIVE_HOURS', '8,9,10,11,12,13,14,15,16,17,18,19,20')
        .split(',').map(Number).filter(Number.isFinite),

      // Refuse to act on a read that returned fewer leads than this fraction
      // of what is already stored — see sync/run.js.
      shrinkGuard: number('SHRINK_GUARD', 0.5)
    }
  };
}

/**
 * True when `date` falls inside the configured working window.
 *
 * Evaluated in the configured zone rather than UTC, so the window means what
 * it says locally wherever the server happens to run.
 *
 * @param {Date} date
 * @param {{timeZone: string, activeDays: Array<number>, activeHours: Array<number>}} sync
 * @returns {boolean}
 */
export function isWithinSchedule(date, sync) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: sync.timeZone, weekday: 'short', hour: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);

  if (!sync.activeDays.includes(day)) return false;
  if (sync.activeHours.length && !sync.activeHours.includes(hour)) return false;

  return true;
}
