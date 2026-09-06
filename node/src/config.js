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

/**
 * Collected rather than thrown one at a time.
 *
 * Failing on the first missing variable costs a deploy cycle per variable —
 * fix one, redeploy, discover the next. Reporting all of them at once means
 * one round trip.
 */
const missing = [];

function required(name, hint = '') {
  const value = process.env[name];

  if (!value) {
    missing.push(hint ? `${name} — ${hint}` : name);
    return '';
  }

  return value;
}

/** Throws once, listing everything that was not set. */
function assertComplete() {
  if (!missing.length) return;

  throw new Error(
    `Missing ${missing.length} required environment variable(s):\n` +
    missing.map(name => `  - ${name}`).join('\n') +
    '\n\n  On Render: Service -> Environment -> Add Environment Variable.' +
    '\n  Locally:   add them to .env (see .env.example).' +
    '\n\n  Note: an empty value counts as missing.');
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Reads a setting whose value is meant to span lines.
 *
 * A .env file is one line per value, and Render's single-line fields are the
 * same, so a message body has to be written with a literal backslash-n. This
 * turns that into a real newline. A value that already contains real newlines
 * — Render's multi-line editor, or a here-doc — passes through unharmed.
 *
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function multiline(name, fallback) {
  return optional(name, fallback).replace(/\\n/g, '\n');
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
  missing.length = 0;

  const config = {
    surense: {
      clientId: required('SURENSE_CLIENT_ID', 'the cid_... from Surense'),
      clientSecret: required('SURENSE_CLIENT_SECRET',
        'the csk_... from Surense; an empty value is not enough'),
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
      url: required('DATABASE_URL',
        'create a Postgres in Render and paste its Internal Database URL'),
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
      token: required('API_TOKEN',
        'run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
        'and paste the OUTPUT, not the command'),

      // Shared secret a webhook sender must present as a bearer token.
      // Separate from API_TOKEN so a sender can be revoked without cutting
      // off every reader. Used by senders that can set a header.
      webhookSecret: optional('WEBHOOK_SECRET', ''),

      // Surense delivers through Svix, which signs the body rather than
      // sending a header token. This is the endpoint's signing secret, shown
      // in the Svix dashboard after the endpoint is created: whsec_...
      svixSecret: optional('SVIX_WEBHOOK_SECRET', '')
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
      shrinkGuard: number('SHRINK_GUARD', 0.5),

      // Mirror every lead into Postgres on each sync.
      //
      // Off by default. What the service needs is the status changes and the
      // source behind them — both of which arrive by webhook and are read
      // back per event — not a copy of three thousand lead rows kept fresh by
      // a full read of the CRM every hour. Turn it on to get /api/leads and
      // the lead-level dashboard back.
      mirrorLeads: optional('MIRROR_LEADS', 'false') === 'true'
    },

    // The catalog of referring sources: every source by id and name, in one
    // call. Confirmed against the live CRM — and the name arrives under
    // `title`, not `name`.
    sourceCatalogPath: optional('SOURCE_CATALOG_PATH', '/customers/sources'),

    // Read-only lookups tried when hunting for the source catalog. Order is
    // most to least likely; each is scored against real lead traffic rather
    // than trusted for answering at all.
    sourceCatalogPaths: optional('SOURCE_CATALOG_PATHS', [
      '/customers/sources',
      '/leads/sources',
      '/sources',
      '/leadsources',
      '/lookups/sources',
      '/settings/sources',
      '/leads/sources/list'
    ].join(',')).split(',').map(path => path.trim()).filter(Boolean),

    messaging: {
      // Which mirrored columns carry the meaning the outbox needs. A column
      // is named by the CRM's own field key, which is what /api/columns
      // lists. The defaults are Surense's keys; another CRM needs all of them
      // set.
      columns: {
        status: optional('STATUS_COLUMN', 'statusName'),

        // A source NAME column, if the CRM serves one. Surense does not: of
        // its 78 fields the only one naming the referring source is
        // `sourceId`, a UUID. Pointing this at an id column is therefore
        // safe and is what an earlier version of this service did — a value
        // shaped like a UUID is recognised as an id and resolved through the
        // `sources` table, never taken for a name.
        source: optional('SOURCE_COLUMN', ''),

        // The id column, resolved to a name through the `sources` table.
        // This is what the recipients file is ultimately joined on.
        sourceId: optional('SOURCE_ID_COLUMN', 'sourceId'),

        clientName: optional('CLIENT_NAME_COLUMN', 'fullName'),
        leadNumber: optional('LEAD_NUMBER_COLUMN', 'number'),

        // The "סך הכל" amount, quoted by the wording for הוגש and for
        // טיפול הסתיים - שולם לקוח. No such field is among the 78 the CRM
        // returns today, so this is empty and those two messages are held
        // rather than sent with the placeholder showing. Set it to the field
        // key once the CRM exposes one.
        total: optional('TOTAL_COLUMN', ''),

        // Who in the CRM handles the lead. Arrives with the lead already
        // named, unlike the source, so it needs no lookup of its own.
        assignee: optional('ASSIGNEE_COLUMN', 'assigneeName')
      },

      subject: multiline('MESSAGE_SUBJECT', 'עדכון סטטוס ליד — {client}'),

      body: multiline('MESSAGE_BODY', [
        'שלום {source},',
        '',
        'עדכון בליד שהפנית:',
        '',
        'לקוח: {client}',
        'מספר מזהה: {leadNumber}',
        'סטטוס: {message}',
        '',
        '{signature}'
      ].join('\n')),

      signature: multiline('MESSAGE_SIGNATURE', 'בברכה,'),

      // The flood brake. A bulk status edit in the CRM would otherwise fire
      // one real message per lead, and none of them can be recalled.
      maxPerRun: number('MAX_SENDS_PER_RUN', 25),

      // Pilot safety net. While this holds an address, every message is
      // addressed to it instead of to the referring source — real leads, real
      // statuses, real wording, and nobody outside can receive one by
      // accident. Clearing it is the deliberate act that goes live.
      redirectAllTo: optional('REDIRECT_ALL_TO', '')
    }
  };

  assertComplete();

  return config;
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
