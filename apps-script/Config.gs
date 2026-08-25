/**
 * Configuration for the lead-status notification automation.
 *
 * Secrets are NOT stored here. They live in Script Properties
 * (Project Settings -> Script Properties) and are read via secret_().
 * Nothing in this repository should ever contain a client secret.
 */
var CONFIG = {
  // ---------------------------------------------------------------- safety
  // Stage 1 of the rollout plan: scan and report, send nothing.
  // Leave this true until a dry run has been reviewed and looks correct.
  dryRun: true,

  // Flood brake. If a single run finds more than this many leads to notify
  // about, nothing is sent and the operator gets one alert instead. Guards
  // against a bulk status edit in the CRM firing hundreds of real emails.
  maxSendsPerRun: 25,

  // Recipient of flood-brake and failure alerts — the operator, not a source.
  operatorEmail: '',

  // ------------------------------------------------------------ workbooks
  // The workbook holding the automation's own tabs (state, log, mapping).
  workbookId: '1Omrb0-sijrV-81IBUgNj36dGv5gxp44cV8AJrjGZiHc',

  // Source -> contact-details mapping. Kept separate from the leads export so
  // a re-export from Surense cannot wipe the contact details. Until the
  // dedicated sheet exists, the mapping tab inside workbookId is used.
  sourcesWorkbookId: null,   // null = use workbookId

  tabs: {
    mapping: 'מיפוי',
    state: 'מצב',
    log: 'יומן'
  },

  // Headers expected in the mapping tab.
  mappingColumns: {
    source: 'מקור',
    email: 'מייל',
    whatsapp: 'וואטספ',
    active: 'פעיל'
  },

  // --------------------------------------------------------------- surense
  surense: {
    tokenUrl: 'https://api.surense.com/oauth/token',

    // The token's "aud" claim names https://www.surense.com/api/v1 while the
    // integration notes say api.surense.com. Confirmed by diagnoseApi against
    // a live call; switch this if that host is the one that answers.
    apiBase: 'https://api.surense.com/api/v1',
    pageSize: 50,          // hard API limit
    maxPages: 40           // stops a runaway pagination loop
  },

  /**
   * Field names as they come back from /leads/search. The exact spelling has
   * not been verified against a live response yet — a dry run logs the first
   * raw lead so these can be corrected without touching any logic.
   */
  leadFields: {
    id: 'id',
    displayId: 'leadNumber',
    clientName: 'name',
    statusId: 'statusId',
    statusName: 'statusName',
    statusDate: 'statusDate',
    sourceName: 'sourceName'
  },

  // ---------------------------------------------------------------- mirror
  mirror: {
    // The tab the CRM copy is written to, addressed by gid so a rename does
    // not break it. Set to null to address it by name instead.
    sheetGid: 737522327,
    tabName: 'לידים',

    // Columns to mirror. Empty means "whatever /leads/fields reports", so a
    // field added in the CRM appears here on its own. Supply a list of keys
    // (or {key, label} pairs) to mirror a chosen subset instead.
    columns: [],

    // Apps Script kills an execution at 6 minutes. Paging stops at this many
    // seconds so the run ends on its own terms and reports why.
    timeBudgetSeconds: 300,

    // What to do with a row whose lead the CRM no longer returns. Marking it
    // is the default: deleting a row cannot be undone, and a lead vanishing
    // is more often a changed filter or permission than a real deletion.
    removeMissing: false,

    // Running history of what changed, one line per field that moved.
    changeLogTab: 'שינויים',
    changeLogRetention: 5000,
    changeLogMaxPerRun: 500
  },

  // -------------------------------------------------------------- schedule
  timezone: 'Asia/Jerusalem',
  activeDays: [0, 1, 2, 3, 4, 5],   // 0 = Sunday ... 6 = Saturday
  // 08:00 through 20:00 local. null would mean every hour of an active day.
  activeHours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],

  // How far back the very first run looks, before a watermark exists.
  firstRunLookbackHours: 1,

  logRetention: 2000
};

/**
 * Reads a secret from Script Properties.
 *
 * @param {string} name
 * @param {boolean=} required
 * @return {string}
 */
function secret_(name, required) {
  var value = PropertiesService.getScriptProperties().getProperty(name);

  if (!value && required !== false) {
    throw new Error(
      'Missing script property "' + name + '". Set it under ' +
      'Project Settings -> Script Properties.');
  }

  return value || '';
}
