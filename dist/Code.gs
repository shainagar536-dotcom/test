/**
 * אוטומציית התראות על שינוי סטטוס ליד — Surense CRM
 *
 * כל הקוד בקובץ אחד, להעתקה יחידה לעורך Apps Script.
 * נוצר אוטומטית מתוך apps-script/*.gs — אל תערוך כאן.
 * לעריכה: שנה את המקור ב-repo והרץ scripts/bundle.py.
 *
 * התקנה:
 *   1. הדבק את כל הקובץ הזה לתוך Code.gs
 *   2. Project Settings -> Show appsscript.json, והדבק את התוכן מה-repo
 *   3. Project Settings -> Script Properties:
 *        SURENSE_CLIENT_ID      = cid_NpUMsHGD80q0izlhEQnfoA
 *        SURENSE_CLIENT_SECRET  = הסוד אחרי סיבוב
 *   4. מלא את CONFIG.operatorEmail למטה
 *   5. הרץ checkSetup() ואז dryRun()
 */

// ======================================================================
// Config.gs
// ======================================================================

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


// ======================================================================
// Statuses.gs
// ======================================================================

/**
 * The status -> message table from section 5 of the plan.
 *
 * This is the whole policy surface: adding a status means adding one line
 * here, and nothing else in the project changes.
 */

/**
 * Statuses that trigger a message to the referring source, mapped to the
 * exact wording sent for each one.
 */
var SEND_ON_STATUS = {
  'לא ענה':            'ניסינו ליצור קשר עם הלקוח אין מענה 1',
  'לא עונה 2':         'ניסינו ליצור קשר עם הלקוח אין מענה 2',
  'לא עונה 3':         'ניסינו ליצור קשר עם הלקוח אין מענה 3',
  'לא עונה זמן רב':    'ניסינו ליצור קשר מספר רב של פעמים אין מענה',
  'מתלבט לגבי העמלה':  'מתלבט לגבי העמלה',
  'לחזור במועד אחר':   'נקבע לחזור במועד אחר',
  'ממתין לת.ז':        'ממתין לת.ז',
  'רלוונטי ל2026':     'הלקוח לא רלוונטי לבדיקה כרגע אך רלוונטי לשנת 2026'
};

/**
 * Returns the message for a status, or null when nothing should be sent.
 *
 * The allowlist is closed by design: a status missing from SEND_ON_STATUS
 * sends nothing. That is the plan's binding default and it is what keeps the
 * 34 not-yet-defined statuses silent while the table is being filled in.
 *
 * @param {string} statusName
 * @return {?string}
 */
function messageForStatus_(statusName) {
  var key = normalizeText_(statusName);

  for (var status in SEND_ON_STATUS) {
    if (normalizeText_(status) === key) {
      return SEND_ON_STATUS[status];
    }
  }

  return null;
}

/**
 * Normalizes a string for comparison.
 *
 * Section 6 calls name matching the number-one failure point: a doubled space
 * or a typographic quote is enough to lose a row. Both sides of every
 * comparison — status names and source names — go through this.
 *
 * @param {*} value
 * @return {string}
 */
function normalizeText_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/[‘’׳ʼ]/g, "'")   // ’ ‘ ׳ ʼ  -> '
    .replace(/[“”״]/g, '"')          // “ ” ״    -> "
    .replace(/[​-‏‪-‮﻿]/g, '')  // zero-width / bidi marks
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}


// ======================================================================
// Log.gs
// ======================================================================

/**
 * Run logging into a dedicated tab, so what happened is visible in the
 * spreadsheet rather than only in the Apps Script execution log.
 */

/**
 * Appends one line to the log tab.
 *
 * @param {string} level  INFO | WARN | ERROR
 * @param {string} message
 * @param {Object=} details  Optional structured payload, stored as JSON.
 */
function logLine_(level, message, details) {
  try {
    var sheet = getSheet_(CONFIG.workbookId, CONFIG.tabs.log,
      ['תאריך', 'רמה', 'הודעה', 'פירוט']);

    sheet.appendRow([
      Utilities.formatDate(new Date(), CONFIG.timezone, 'yyyy-MM-dd HH:mm:ss'),
      level,
      message,
      details ? JSON.stringify(details) : ''
    ]);

    var excess = (sheet.getLastRow() - 1) - CONFIG.logRetention;

    if (excess > 0) {
      sheet.deleteRows(2, excess);
    }
  } catch (err) {
    // Logging must never be the reason a run dies.
    console.error('logLine_ failed: ' + err);
  }
}

function logInfo_(message, details) {
  console.log(message);
  logLine_('INFO', message, details);
}

function logWarn_(message, details) {
  console.warn(message);
  logLine_('WARN', message, details);
}

function logError_(message, details) {
  console.error(message);
  logLine_('ERROR', message, details);
}


// ======================================================================
// Sheets.gs
// ======================================================================

/**
 * Spreadsheet access: the source mapping, the dedupe state table and the
 * run watermark.
 */

/**
 * Loads the source -> contact mapping, keyed by normalized source name.
 *
 * @return {Object<string, {source: string, email: string, whatsapp: string,
 *                          active: boolean}>}
 */
function loadSourceMapping_() {
  var sheet = getSheet_(
    CONFIG.sourcesWorkbookId || CONFIG.workbookId,
    CONFIG.tabs.mapping,
    [CONFIG.mappingColumns.source, CONFIG.mappingColumns.email,
     CONFIG.mappingColumns.whatsapp, CONFIG.mappingColumns.active]);

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {};
  }

  var values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  var headers = values[0].map(normalizeText_);

  var col = function (name) {
    return headers.indexOf(normalizeText_(name));
  };

  var iSource = col(CONFIG.mappingColumns.source);
  var iEmail = col(CONFIG.mappingColumns.email);
  var iWhatsapp = col(CONFIG.mappingColumns.whatsapp);
  var iActive = col(CONFIG.mappingColumns.active);

  if (iSource === -1) {
    throw new Error('The mapping tab has no "' +
      CONFIG.mappingColumns.source + '" column.');
  }

  var mapping = {};

  for (var r = 1; r < values.length; r++) {
    var source = String(values[r][iSource] || '').trim();

    if (!source) {
      continue;
    }

    // "פעיל" empty counts as active; only an explicit "לא" mutes a source.
    var activeCell = iActive === -1 ? '' : normalizeText_(values[r][iActive]);

    mapping[normalizeText_(source)] = {
      source: source,
      email: iEmail === -1 ? '' : String(values[r][iEmail] || '').trim(),
      whatsapp: iWhatsapp === -1 ? '' : String(values[r][iWhatsapp] || '').trim(),
      active: activeCell !== 'לא' && activeCell !== 'no' && activeCell !== 'false'
    };
  }

  return mapping;
}

/**
 * Loads the dedupe table: lead id -> the status last reported for that lead.
 *
 * @return {Object<string, string>}
 */
function loadReportedStatuses_() {
  var sheet = stateSheet_();
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {};
  }

  var reported = {};

  sheet.getRange(2, 1, lastRow - 1, 3).getValues().forEach(function (row) {
    if (row[0] !== '') {
      reported[String(row[0])] = String(row[1]);
    }
  });

  return reported;
}

/**
 * Records that a status was reported for a lead, so a repeat run does not
 * send the same notification twice.
 *
 * @param {string} leadId
 * @param {string} statusName
 */
function recordReportedStatus_(leadId, statusName) {
  var sheet = stateSheet_();
  var lastRow = sheet.getLastRow();
  var stamp = Utilities.formatDate(
    new Date(), CONFIG.timezone, 'yyyy-MM-dd HH:mm:ss');

  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === String(leadId)) {
        sheet.getRange(i + 2, 2, 1, 2).setValues([[statusName, stamp]]);
        return;
      }
    }
  }

  sheet.appendRow([leadId, statusName, stamp]);
}

function stateSheet_() {
  return getSheet_(CONFIG.workbookId, CONFIG.tabs.state,
    ['מספר ליד', 'סטטוס אחרון שדווח', 'תאריך דיווח']);
}

/**
 * The timestamp the next search filters on.
 *
 * On the very first run there is no watermark, so the window is limited to
 * firstRunLookbackHours — otherwise the first poll would pull the entire
 * history and try to notify on all of it.
 *
 * @return {Date}
 */
function getWatermark_() {
  var stored = PropertiesService.getScriptProperties()
    .getProperty('LAST_RUN_AT');

  if (stored) {
    return new Date(stored);
  }

  return new Date(Date.now() - CONFIG.firstRunLookbackHours * 3600 * 1000);
}

/**
 * Advances the watermark. Called only after a run completes, so a failed run
 * re-reads the same window next time instead of losing those leads.
 *
 * @param {Date} date
 */
function setWatermark_(date) {
  PropertiesService.getScriptProperties()
    .setProperty('LAST_RUN_AT', date.toISOString());
}

/**
 * Returns a tab by name, creating it with the given headers when missing.
 *
 * @param {string} workbookId
 * @param {string} name
 * @param {Array<string>} headers
 * @return {Sheet}
 */
function getSheet_(workbookId, name, headers) {
  var ss = SpreadsheetApp.openById(workbookId);
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  return sheet;
}


// ======================================================================
// Surense.gs
// ======================================================================

/**
 * Surense CRM client: OAuth token, the paginated lead search, and the
 * field-schema lookup.
 *
 * Surense has no webhooks, so everything here is pull-based.
 */

/**
 * Fetches an access token, reusing the cached one until it is nearly expired.
 *
 * @return {string}
 */
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('surense_token');

  if (cached) {
    return cached;
  }

  // The token endpoint rejects JSON — it requires form encoding.
  var response = UrlFetchApp.fetch(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: secret_('SURENSE_CLIENT_ID'),
      client_secret: secret_('SURENSE_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Surense token request failed (HTTP ' +
      response.getResponseCode() + '): ' + response.getContentText());
  }

  var body = JSON.parse(response.getContentText());

  if (!body.access_token) {
    throw new Error('Surense token response contained no access_token.');
  }

  // Expire the cache a minute early so a run never uses a token mid-expiry.
  var ttl = Math.max(60, Math.min(3300, (body.expires_in || 3600) - 60));
  cache.put('surense_token', body.access_token, ttl);

  return body.access_token;
}

/**
 * Makes an authenticated API call and returns the parsed body.
 *
 * @param {string} method  'get' or 'post'
 * @param {string} path    Path below the API base, e.g. '/leads/search'
 * @param {Object=} body   JSON payload, for POST
 * @return {Object}
 */
function surenseRequest_(method, path, body) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getAccessToken_() },
    muteHttpExceptions: true
  };

  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  var response = UrlFetchApp.fetch(CONFIG.surense.apiBase + path, options);
  var code = response.getResponseCode();

  if (code !== 200) {
    throw new Error(method.toUpperCase() + ' ' + path + ' failed (HTTP ' +
      code + '): ' + response.getContentText().slice(0, 500));
  }

  return JSON.parse(response.getContentText());
}

/**
 * Pulls the rows array out of a search response.
 *
 * The exact envelope key has not been confirmed against a live response, so
 * the common shapes are all accepted. previewApi() reports which one is real.
 *
 * @param {Object} parsed
 * @return {Array<Object>}
 */
function extractRows_(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  return parsed.rows || parsed.data || parsed.results || parsed.items ||
    parsed.leads || [];
}

/**
 * Runs a paginated lead search, following pages to the end.
 *
 * @param {Array<Object>} filters   Search filters, possibly empty.
 * @param {Object=} options         {deadline: Date, onPage: function}
 * @return {{leads: Array<Object>, complete: boolean}}
 */
function searchLeads_(filters, options) {
  options = options || {};

  var leads = [];
  var startRow = 0;

  for (var page = 0; page < CONFIG.surense.maxPages; page++) {
    if (options.deadline && new Date() > options.deadline) {
      logWarn_('Stopped paginating at the time budget.', {
        pagesRead: page, leadsSoFar: leads.length
      });
      return { leads: leads, complete: false };
    }

    var parsed = surenseRequest_('post', '/leads/search', {
      startRow: startRow,
      endRow: startRow + CONFIG.surense.pageSize,
      sorts: [{ field: 'statusDate', dir: 'asc' }],
      filters: filters || []
    });

    var batch = extractRows_(parsed);
    leads = leads.concat(batch);

    if (options.onPage) {
      options.onPage(leads.length);
    }

    // Trust hasNextPage when the API sends it; otherwise a short page is the
    // end. Either way maxPages stops an unbounded loop.
    var hasNext = parsed.hasNextPage !== undefined
      ? parsed.hasNextPage
      : batch.length === CONFIG.surense.pageSize;

    if (!hasNext || !batch.length) {
      return { leads: leads, complete: true };
    }

    startRow += CONFIG.surense.pageSize;
  }

  logWarn_('Pagination hit the ' + CONFIG.surense.maxPages + '-page cap.',
    { collected: leads.length });

  return { leads: leads, complete: false };
}

/**
 * Every lead whose status changed after `since`. Used by the notifier.
 *
 * @param {Date} since
 * @return {Array<Object>}
 */
function fetchLeadsChangedSince_(since) {
  return searchLeads_([{
    field: 'statusDate',
    operator: 'greaterThan',
    value: Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'")
  }]).leads;
}

/**
 * Every lead in the CRM. Used by the mirror.
 *
 * @param {Object=} options  {deadline: Date, onPage: function}
 * @return {{leads: Array<Object>, complete: boolean}}
 */
function fetchAllLeads_(options) {
  return searchLeads_([], options);
}

/**
 * The CRM's field definitions, including custom fields.
 *
 * Reading the schema from the CRM rather than hardcoding column names means
 * a field added in Surense shows up in the mirror without a code change.
 *
 * @return {Array<{key: string, label: string}>}
 */
function fetchLeadFields_() {
  var parsed = surenseRequest_('get', '/leads/fields');
  var raw = extractRows_(parsed).length ? extractRows_(parsed) : (parsed.fields || []);

  return raw.map(function (field) {
    if (typeof field === 'string') {
      return { key: field, label: field };
    }

    var key = field.key || field.name || field.field || field.id;

    return {
      key: String(key),
      label: String(field.label || field.title || field.displayName || key)
    };
  }).filter(function (field) {
    return field.key && field.key !== 'undefined';
  });
}

/**
 * Pulls the fields the notifier needs out of a raw lead, using the names in
 * CONFIG.leadFields so a naming mismatch is a config fix, not a code change.
 *
 * @param {Object} raw
 * @return {Object}
 */
function normalizeLead_(raw) {
  var f = CONFIG.leadFields;

  var pick = function (name, fallbacks) {
    var candidates = [name].concat(fallbacks);

    for (var i = 0; i < candidates.length; i++) {
      var value = raw[candidates[i]];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }

    return '';
  };

  return {
    id: String(pick(f.id, ['leadId', 'uuid'])),
    displayId: String(pick(f.displayId, ['number', 'displayId', f.id])),
    clientName: String(pick(f.clientName, ['clientName', 'fullName', 'firstName'])),
    statusName: String(pick(f.statusName, ['status', 'statusTitle'])),
    statusDate: String(pick(f.statusDate, ['statusChangedAt', 'updatedAt'])),
    sourceName: String(pick(f.sourceName, ['source', 'sourceTitle', 'sourceId']))
  };
}


// ======================================================================
// Notify.gs
// ======================================================================

/**
 * Message composition and delivery.
 *
 * Section 3 of the plan specifies Outlook as the sending mailbox. Apps Script
 * cannot send through Outlook directly — sendEmail_ is the single seam where
 * that transport gets swapped in once the mailbox is decided (see
 * sendViaGraph_ below). Everything above it is transport-agnostic.
 */

/** Signature appended to every message. Pending approval (section 12). */
var EMAIL_SIGNATURE = 'בברכה,';

/**
 * Builds the notification for one lead.
 *
 * @param {Object} lead      Normalized lead.
 * @param {Object} source    Mapping row for the referring source.
 * @param {string} message   Wording for the lead's status.
 * @return {{subject: string, body: string}}
 */
function composeNotification_(lead, source, message) {
  var subject = 'עדכון סטטוס ליד — ' + lead.clientName;

  var body = [
    'שלום ' + source.source + ',',
    '',
    'עדכון בליד שהפנית:',
    '',
    'לקוח: ' + lead.clientName,
    'מספר מזהה: ' + lead.displayId,
    'סטטוס: ' + message,
    '',
    EMAIL_SIGNATURE
  ].join('\n');

  return { subject: subject, body: body };
}

/**
 * Sends one notification, or records what would have been sent when the
 * automation is in dry-run mode.
 *
 * @param {string} to
 * @param {{subject: string, body: string}} mail
 * @return {boolean} true when a message actually went out
 */
function sendEmail_(to, mail) {
  if (CONFIG.dryRun) {
    return false;
  }

  MailApp.sendEmail({
    to: to,
    subject: mail.subject,
    body: mail.body
  });

  return true;
}

/**
 * Outlook transport, for when the sending mailbox is connected.
 *
 * Requires a Microsoft Graph token in the MS_GRAPH_TOKEN script property and
 * the sending address in SENDER_MAILBOX. Left unwired deliberately: the
 * mailbox is still an open question in section 12, and picking one here would
 * be guessing. To switch over, call this from sendEmail_ instead of MailApp.
 *
 * @param {string} to
 * @param {{subject: string, body: string}} mail
 */
function sendViaGraph_(to, mail) {
  var mailbox = secret_('SENDER_MAILBOX');

  var response = UrlFetchApp.fetch(
    'https://graph.microsoft.com/v1.0/users/' +
    encodeURIComponent(mailbox) + '/sendMail', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret_('MS_GRAPH_TOKEN') },
      payload: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.body },
          toRecipients: [{ emailAddress: { address: to } }]
        },
        saveToSentItems: true
      }),
      muteHttpExceptions: true
    });

  if (response.getResponseCode() >= 300) {
    throw new Error('Graph sendMail failed (HTTP ' +
      response.getResponseCode() + '): ' + response.getContentText());
  }
}

/**
 * Alerts the operator. Used by the flood brake and by run failures — never
 * sent to a referring source.
 *
 * @param {string} subject
 * @param {string} body
 */
function alertOperator_(subject, body) {
  if (!CONFIG.operatorEmail) {
    logWarn_('No operatorEmail configured — alert not delivered.',
      { subject: subject });
    return;
  }

  MailApp.sendEmail({
    to: CONFIG.operatorEmail,
    subject: subject,
    body: body
  });
}


// ======================================================================
// Main.gs
// ======================================================================

/**
 * Entry points and the hourly run algorithm (section 7 of the plan).
 */

/** Called by the hourly trigger. */
function hourlyUpdate() {
  var now = new Date();

  if (!isWithinSchedule_(now)) {
    console.log('Outside the configured window (' +
      Utilities.formatDate(now, CONFIG.timezone, 'EEE HH:mm') + ') — skipping.');
    return;
  }

  runAutomation_({ trigger: 'hourly' });
}

/** Manual run from the editor. Ignores the schedule window. */
function runNow() {
  runAutomation_({ trigger: 'manual' });
}

/**
 * Stage 1 of the rollout: a full scan that reports what would be sent,
 * without sending anything and without advancing any state.
 *
 * Safe to run repeatedly — it restores dryRun afterwards even on failure.
 */
function dryRun() {
  var previous = CONFIG.dryRun;
  CONFIG.dryRun = true;

  try {
    runAutomation_({ trigger: 'dry-run' });
  } finally {
    CONFIG.dryRun = previous;
  }
}

/**
 * One polling pass.
 *
 * A lock guards the whole pass so two runs can never send the same
 * notification concurrently.
 *
 * @param {{trigger: string}} options
 */
function runAutomation_(options) {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    logWarn_('A previous run is still in progress — skipping this tick.', options);
    return;
  }

  var startedAt = new Date();
  var stats = { scanned: 0, sent: 0, skipped: 0, pending: 0, errors: 0 };

  try {
    var since = getWatermark_();
    var leads = fetchLeadsChangedSince_(since).map(normalizeLead_);

    stats.scanned = leads.length;

    if (options.trigger === 'dry-run' && leads.length) {
      // Lets CONFIG.leadFields be verified against a real response.
      logInfo_('Sample lead as parsed.', leads[0]);
    }

    if (!leads.length) {
      setWatermark_(startedAt);
      console.log('No status changes since ' + since.toISOString() + '.');
      return;
    }

    var mapping = loadSourceMapping_();
    var reported = loadReportedStatuses_();
    var queue = buildQueue_(leads, mapping, reported, stats);

    // Flood brake: a bulk status edit in the CRM must not become a mail-out.
    if (queue.length > CONFIG.maxSendsPerRun) {
      var alert = 'Flood brake: ' + queue.length + ' notifications queued in ' +
        'one run, above the limit of ' + CONFIG.maxSendsPerRun +
        '. Nothing was sent.';

      logError_(alert, {
        statuses: queue.map(function (item) { return item.lead.statusName; })
          .filter(unique_)
      });

      alertOperator_('אוטומציית לידים — בלם הצפה נעצר', alert +
        '\n\nהריצה נעצרה ולא נשלחה אף הודעה. יש לבדוק את ה-CRM ולאשר ידנית.');

      // The watermark stays put: after a manual review the same window is
      // re-scanned rather than being silently swallowed.
      return;
    }

    queue.forEach(function (item) {
      try {
        var mail = composeNotification_(item.lead, item.source, item.message);

        if (sendEmail_(item.source.email, mail)) {
          recordReportedStatus_(item.lead.id, item.lead.statusName);
          stats.sent++;
        } else {
          logInfo_('DRY RUN — would notify ' + item.source.email, {
            lead: item.lead.displayId,
            client: item.lead.clientName,
            status: item.lead.statusName,
            message: item.message
          });
        }
      } catch (err) {
        stats.errors++;
        logError_('Failed to notify about lead ' + item.lead.displayId +
          ': ' + err.message);
      }
    });

    setWatermark_(startedAt);

    logInfo_((CONFIG.dryRun ? 'DRY RUN' : 'Run') + ' finished in ' +
      Math.round((new Date() - startedAt) / 1000) + 's.', {
      scanned: stats.scanned,
      sent: stats.sent,
      wouldSend: CONFIG.dryRun ? queue.length : undefined,
      skipped: stats.skipped,
      awaitingContact: stats.pending,
      errors: stats.errors
    });
  } catch (err) {
    // The watermark is deliberately left alone so the next tick re-reads
    // this window instead of losing it.
    logError_('Run failed: ' + err.message, {
      trigger: options.trigger,
      stack: err.stack
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decides which leads warrant a notification, applying the filters of
 * section 7 step 3 in order.
 *
 * @param {Array<Object>} leads
 * @param {Object} mapping
 * @param {Object<string, string>} reported
 * @param {Object} stats  Mutated with skip/pending counts.
 * @return {Array<{lead: Object, source: Object, message: string}>}
 */
function buildQueue_(leads, mapping, reported, stats) {
  var queue = [];
  var unmatched = [];

  leads.forEach(function (lead) {
    // (a) Closed allowlist — an undefined status sends nothing.
    var message = messageForStatus_(lead.statusName);

    if (!message) {
      stats.skipped++;
      return;
    }

    // (b) Already reported at this status.
    if (reported[lead.id] === lead.statusName) {
      stats.skipped++;
      return;
    }

    // (c) Resolve the referring source.
    var source = mapping[normalizeText_(lead.sourceName)];

    if (!source) {
      stats.pending++;
      unmatched.push(lead.sourceName);
      return;
    }

    if (!source.active || !source.email) {
      stats.pending++;
      return;
    }

    queue.push({ lead: lead, source: source, message: message });
  });

  if (unmatched.length) {
    // Categories like "קמפיין" have no recipient by design, so this is a
    // notice rather than an error — but it is also where a renamed source
    // shows up, which is why the names are listed.
    logWarn_(unmatched.length + ' lead(s) had no matching row in the mapping.', {
      sources: unmatched.filter(unique_)
    });
  }

  return queue;
}

function unique_(value, index, array) {
  return array.indexOf(value) === index;
}

/**
 * True when `date` falls on an allowed day and hour, in CONFIG.timezone.
 *
 * @param {Date} date
 * @return {boolean}
 */
function isWithinSchedule_(date) {
  if (CONFIG.activeDays.indexOf(localDayIndex_(date)) === -1) {
    return false;
  }

  if (CONFIG.activeHours === null) {
    return true;
  }

  var hour = Number(Utilities.formatDate(date, CONFIG.timezone, 'H'));
  return CONFIG.activeHours.indexOf(hour) !== -1;
}

/**
 * Day of week in CONFIG.timezone, 0 = Sunday ... 6 = Saturday.
 *
 * Date#getDay() reports the day in the script's own timezone, which is not
 * necessarily the one the schedule is written against.
 *
 * @param {Date} date
 * @return {number}
 */
function localDayIndex_(date) {
  // 'u' is the ISO day number: 1 = Monday ... 7 = Sunday.
  var isoDay = Number(Utilities.formatDate(date, CONFIG.timezone, 'u'));
  return isoDay % 7;
}


// ======================================================================
// Mirror.gs
// ======================================================================

/**
 * The mirror: keeps a spreadsheet tab in step with the CRM's leads.
 *
 * Rows are matched by lead id and updated only when their values actually
 * changed. A row whose lead is unchanged keeps the timestamp it already had,
 * which is what makes the "changed at" column meaningful — rewriting every
 * row each hour would stamp them all with the time of the last run and say
 * nothing about when anything actually changed.
 *
 * The CRM is only ever read. Nothing here writes back to Surense.
 *
 * Columns come from the CRM's own field schema, so a field added in Surense
 * appears in the mirror without a code change.
 */

/** Columns the mirror maintains itself, appended after the CRM's own. */
var META = {
  timestamp: 'עודכן בגיליון',
  changeType: 'סוג שינוי',
  hash: '_hash'
};

/** Values written into the change-type column. */
var CHANGE = {
  baseline: 'בסיס',
  added: 'חדש',
  updated: 'עודכן',
  missing: 'לא נמצא ב-CRM'
};

/**
 * Reports what the API actually returns, without writing anything.
 *
 * Run this first. The response shapes could not be checked while the code was
 * written — the environment it was written in has no route to the API — so
 * this is what confirms the field names and the response envelope before the
 * first sync touches the sheet.
 */
function previewApi() {
  var lines = [];

  try {
    getAccessToken_();
    lines.push('OK  Authentication succeeded.');
  } catch (err) {
    console.log('FAIL  Authentication failed: ' + err.message);
    return;
  }

  try {
    var fields = fetchLeadFields_();
    lines.push('OK  /leads/fields returned ' + fields.length + ' field(s).');
    lines.push('  ' + fields.slice(0, 40).map(function (field) {
      return field.key + (field.label !== field.key ? ' (' + field.label + ')' : '');
    }).join(', '));
  } catch (err) {
    lines.push('FAIL  /leads/fields failed: ' + err.message);
  }

  try {
    var parsed = surenseRequest_('post', '/leads/search',
      { startRow: 0, endRow: 1, filters: [] });

    lines.push('OK  /leads/search responded.');
    lines.push('  envelope keys: ' + Object.keys(parsed).join(', '));

    var rows = extractRows_(parsed);
    lines.push('  rows found: ' + rows.length);

    if (rows.length) {
      lines.push('  first lead keys: ' + Object.keys(rows[0]).join(', '));
      lines.push('  first lead: ' + JSON.stringify(rows[0]).slice(0, 1500));
    }
  } catch (err) {
    lines.push('FAIL  /leads/search failed: ' + err.message);
  }

  console.log(lines.join('\n'));
  logInfo_('previewApi', { report: lines.join(' | ').slice(0, 4000) });
}

/** Entry point for the mirror's hourly trigger. */
function hourlyMirror() {
  var now = new Date();

  if (!isWithinSchedule_(now)) {
    console.log('Outside the configured window (' +
      Utilities.formatDate(now, CONFIG.timezone, 'EEE HH:mm') + ') — skipping.');
    return;
  }

  syncLeads();
}

/**
 * Brings the mirror tab in step with the CRM.
 *
 * @return {?{added: number, updated: number, unchanged: number,
 *            missing: number, baseline: boolean}}
 */
function syncLeads() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    logWarn_('A mirror sync is already running — skipping.');
    return null;
  }

  var startedAt = new Date();

  try {
    var columns = resolveColumns_();
    var result = fetchAllLeads_({
      deadline: new Date(
        startedAt.getTime() + CONFIG.mirror.timeBudgetSeconds * 1000)
    });

    if (!result.leads.length) {
      logWarn_('The CRM returned no leads — the mirror was left untouched.');
      return null;
    }

    // A truncated read must not be acted on as if it were the whole CRM:
    // every lead not read would be marked as gone from the CRM.
    if (!result.complete) {
      logError_('Read incomplete (' + result.leads.length + ' leads) — the ' +
        'mirror was left untouched to avoid acting on a partial copy.', {
        hint: 'Raise CONFIG.surense.maxPages or CONFIG.mirror.timeBudgetSeconds.'
      });
      return null;
    }

    var existing = readExisting_();
    var plan = buildRows_(columns, result.leads, existing);

    writeRows_(columns, plan.rows);
    appendChangeLog_(plan.changes);

    var stats = plan.stats;
    stats.baseline = existing.baseline;

    logInfo_((existing.baseline ? 'Baseline written' : 'Mirror synced') +
      ' in ' + Math.round((new Date() - startedAt) / 1000) + 's.', {
      leadsInCrm: result.leads.length,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      missingFromCrm: stats.missing,
      changeLogRows: plan.changes.length
    });

    return stats;
  } catch (err) {
    logError_('Mirror sync failed: ' + err.message, { stack: err.stack });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decides the mirror's columns, with the lead id always first.
 *
 * Fixing the id in column A is what lets a later run find a row again
 * without having to guess which header holds the identifier.
 *
 * @return {Array<{key: string, label: string}>}
 */
function resolveColumns_() {
  var columns;

  if (CONFIG.mirror.columns && CONFIG.mirror.columns.length) {
    columns = CONFIG.mirror.columns.map(function (entry) {
      return typeof entry === 'string' ? { key: entry, label: entry } : entry;
    });
  } else {
    columns = fetchLeadFields_();
  }

  if (!columns.length) {
    throw new Error('The CRM returned no field definitions, and ' +
      'CONFIG.mirror.columns is empty — there are no columns to write.');
  }

  var idKey = CONFIG.leadFields.id;

  var idColumn = columns.filter(function (column) {
    return column.key === idKey;
  })[0] || { key: idKey, label: idKey };

  var rest = columns.filter(function (column) {
    return column.key !== idKey;
  });

  return [idColumn].concat(rest);
}

/**
 * Reads what the mirror wrote last time, keyed by lead id.
 *
 * A tab without the mirror's own meta columns has never been synced — it may
 * hold an old export whose layout is unknown. That is reported as a baseline
 * so the first run stamps everything once rather than announcing thousands of
 * leads as newly added.
 *
 * @return {{baseline: boolean, byId: Object, order: Array<string>}}
 */
function readExisting_() {
  var sheet = mirrorSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var empty = { baseline: true, byId: {}, order: [] };

  if (lastRow < 2 || lastCol < 1) {
    return empty;
  }

  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var headers = values[0];

  var iTime = headers.indexOf(META.timestamp);
  var iType = headers.indexOf(META.changeType);
  var iHash = headers.indexOf(META.hash);

  if (iTime === -1 || iType === -1 || iHash === -1) {
    return empty;
  }

  var byId = {};
  var order = [];

  for (var row = 1; row < values.length; row++) {
    var id = String(values[row][0] || '').trim();

    if (!id) {
      continue;
    }

    byId[id] = {
      timestamp: values[row][iTime],
      type: values[row][iType],
      hash: values[row][iHash],
      raw: values[row]
    };

    order.push(id);
  }

  return { baseline: false, byId: byId, order: order };
}

/**
 * Builds the rows to write, deciding for each lead whether it is new,
 * changed, or untouched since the previous run.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<Object>} leads
 * @param {Object} existing
 * @return {{rows: Array<Array>, stats: Object}}
 */
function buildRows_(columns, leads, existing) {
  var now = Utilities.formatDate(
    new Date(), CONFIG.timezone, 'yyyy-MM-dd HH:mm:ss');

  var stats = { added: 0, updated: 0, unchanged: 0, missing: 0 };
  var rows = [];
  var changes = [];
  var seen = {};

  leads.forEach(function (lead) {
    var values = columns.map(function (column) {
      return flattenValue_(lead[column.key]);
    });

    var id = String(values[0]);
    var hash = hashValues_(values);
    var previous = existing.byId[id];
    var timestamp;
    var changeType;

    if (existing.baseline) {
      timestamp = now;
      changeType = CHANGE.baseline;
    } else if (!previous) {
      timestamp = now;
      changeType = CHANGE.added;
      stats.added++;
      changes.push([now, id, CHANGE.added, '', '', values.join(' | ')]);
    } else if (String(previous.hash) !== hash) {
      timestamp = now;
      changeType = CHANGE.updated;
      stats.updated++;

      // Which fields moved, not just that the row did.
      diffRow_(columns, previous.raw, values).forEach(function (diff) {
        changes.push([now, id, CHANGE.updated, diff.column, diff.before, diff.after]);
      });
    } else {
      // Untouched: keep the stamp from whenever this row last really changed.
      timestamp = previous.timestamp;
      changeType = previous.type;
      stats.unchanged++;
    }

    seen[id] = true;
    rows.push(values.concat([timestamp, changeType, hash]));
  });

  // Leads the CRM no longer returns. Marked rather than deleted — removing a
  // row is not recoverable, and a lead vanishing is more often a filter or a
  // permission change than a real deletion. Set CONFIG.mirror.removeMissing
  // to drop them instead.
  if (!existing.baseline && !CONFIG.mirror.removeMissing) {
    existing.order.forEach(function (id) {
      if (seen[id]) {
        return;
      }

      var previous = existing.byId[id];
      var row = previous.raw.slice();
      var alreadyFlagged = previous.type === CHANGE.missing;

      while (row.length < columns.length + 3) {
        row.push('');
      }

      row[columns.length] = alreadyFlagged ? previous.timestamp : now;
      row[columns.length + 1] = CHANGE.missing;
      row[columns.length + 2] = previous.hash;

      rows.push(row);

      if (!alreadyFlagged) {
        stats.missing++;
        changes.push([now, id, CHANGE.missing, '', '', '']);
      }
    });
  }

  return { rows: rows, stats: stats, changes: changes };
}

/**
 * Lists the columns whose value differs between the stored row and the fresh
 * one, so the change log can say what moved rather than only that something
 * did.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array} before  The row as it was read back from the sheet.
 * @param {Array} after   The freshly flattened CRM values.
 * @return {Array<{column: string, before: string, after: string}>}
 */
function diffRow_(columns, before, after) {
  var diffs = [];

  for (var i = 0; i < columns.length; i++) {
    // A value Sheets would read as a formula was stored with a leading
    // apostrophe, which the sheet does not display. Compare without it, or
    // every such column would look changed on every run.
    var was = stripLeadingQuote_(before[i]);
    var now = stripLeadingQuote_(after[i]);

    if (was !== now) {
      diffs.push({ column: columns[i].label, before: was, after: now });
    }
  }

  return diffs;
}

/**
 * @param {*} value
 * @return {string}
 */
function stripLeadingQuote_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).replace(/^'/, '');
}

/**
 * Appends this run's changes to the change-log tab.
 *
 * The mirror tab shows the current state; this is the running history of how
 * it got there — one line per field that moved.
 *
 * @param {Array<Array>} changes
 */
function appendChangeLog_(changes) {
  if (!changes.length) {
    return;
  }

  var capped = changes;

  if (changes.length > CONFIG.mirror.changeLogMaxPerRun) {
    // A bulk edit in the CRM should not write tens of thousands of lines.
    capped = changes.slice(0, CONFIG.mirror.changeLogMaxPerRun);
    logWarn_('Change log truncated: ' + changes.length + ' changes in one ' +
      'run, logging the first ' + CONFIG.mirror.changeLogMaxPerRun + '.');
  }

  var sheet = getSheet_(CONFIG.workbookId, CONFIG.mirror.changeLogTab,
    ['תאריך', 'מזהה ליד', 'סוג שינוי', 'עמודה', 'לפני', 'אחרי']);

  var start = Math.max(sheet.getLastRow() + 1, 2);

  growGrid_(sheet, start + capped.length - 1, 6);
  sheet.getRange(start, 1, capped.length, 6).setValues(capped);

  var excess = (sheet.getLastRow() - 1) - CONFIG.mirror.changeLogRetention;

  if (excess > 0) {
    sheet.deleteRows(2, excess);
  }
}

/**
 * Writes the header row and every data row in one call.
 *
 * The whole block goes out at once: a per-row write of several thousand rows
 * would not finish inside the execution limit.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<Array>} rows
 */
function writeRows_(columns, rows) {
  var sheet = mirrorSheet_();

  var headers = columns.map(function (column) {
    return column.label;
  }).concat([META.timestamp, META.changeType, META.hash]);

  var matrix = [headers].concat(rows);
  var width = headers.length;

  growGrid_(sheet, matrix.length, width);
  sheet.clearContents();
  sheet.getRange(1, 1, matrix.length, width).setValues(matrix);
  sheet.setFrozenRows(1);

  // The hash is bookkeeping, not data anyone should have to look at.
  sheet.hideColumns(width);
}

/**
 * A short, stable fingerprint of a row's CRM values.
 *
 * @param {Array} values
 * @return {string}
 */
function hashValues_(values) {
  var text = values.map(function (value) {
    return value === null || value === undefined ? '' : String(value);
  }).join('');

  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)
    .map(function (byte) {
      return ((byte & 0xff) + 0x100).toString(16).slice(1);
    })
    .join('');
}

/**
 * Renders an API value as something a spreadsheet cell can hold.
 *
 * Nested objects are the common case — a status or a source often arrives as
 * {id, name} rather than a bare string, and writing "[object Object]" into
 * the mirror would quietly lose the value.
 *
 * @param {*} value
 * @return {string|number|boolean}
 */
function flattenValue_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG.timezone, 'yyyy-MM-dd HH:mm:ss');
  }

  var type = typeof value;

  if (type === 'number' || type === 'boolean') {
    return value;
  }

  if (type === 'string') {
    // Sheets treats a leading = + - @ as a formula; keep CRM text as text.
    return /^[=+\-@]/.test(value) ? "'" + value : value;
  }

  if (Array.isArray(value)) {
    return value.map(flattenValue_).join(', ');
  }

  if (type === 'object') {
    var label = value.name || value.title || value.label || value.value ||
      value.displayName;

    return label !== undefined ? String(label) : JSON.stringify(value);
  }

  return String(value);
}

/**
 * Makes sure the grid is at least the requested size.
 *
 * setValues throws rather than expanding the sheet, and a new tab starts at
 * 1000 rows — well under a few thousand leads.
 *
 * @param {Sheet} sheet
 * @param {number} rows
 * @param {number} cols
 */
function growGrid_(sheet, rows, cols) {
  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();

  if (maxRows < rows) {
    sheet.insertRowsAfter(maxRows, rows - maxRows);
  }

  if (maxCols < cols) {
    sheet.insertColumnsAfter(maxCols, cols - maxCols);
  }
}

/**
 * Resolves the mirror tab by gid, creating it if the gid is not found.
 *
 * gid survives a rename, which a tab name does not.
 *
 * @return {Sheet}
 */
function mirrorSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.workbookId);

  if (CONFIG.mirror.sheetGid !== null) {
    var byGid = ss.getSheets().filter(function (sheet) {
      return sheet.getSheetId() === CONFIG.mirror.sheetGid;
    })[0];

    if (byGid) {
      return byGid;
    }

    logWarn_('No tab with gid ' + CONFIG.mirror.sheetGid +
      ' — falling back to the tab named "' + CONFIG.mirror.tabName + '".');
  }

  return ss.getSheetByName(CONFIG.mirror.tabName) ||
    ss.insertSheet(CONFIG.mirror.tabName);
}


// ======================================================================
// Diff.gs
// ======================================================================

/**
 * Compares the CRM against what is currently in the spreadsheet.
 *
 * Two uses. Day to day it answers "which leads came in that never made it
 * into the sheet". Before the first mirror sync it is the safety check: it
 * reports exactly what the sync is about to add and remove, while changing
 * nothing.
 */

/**
 * Reports leads present in the CRM but missing from the sheet, and rows in
 * the sheet with no matching lead in the CRM.
 *
 * Read-only — it never edits the leads tab. Findings go to a separate report
 * tab and to the log.
 *
 * @return {{missing: Array<Object>, stale: Array<string>, matched: number}}
 */
function reportMissingLeads() {
  var result = fetchAllLeads_({
    deadline: new Date(Date.now() + CONFIG.mirror.timeBudgetSeconds * 1000)
  });

  if (!result.complete) {
    logWarn_('The CRM read was incomplete — treat this report as partial.', {
      leadsRead: result.leads.length
    });
  }

  var leads = result.leads;

  if (!leads.length) {
    console.log('The CRM returned no leads.');
    return { missing: [], stale: [], matched: 0 };
  }

  var sheetKeys = readSheetKeys_(leads);

  if (!sheetKeys) {
    // Nothing in the sheet lines up with any CRM identifier. Reporting every
    // lead as "missing" would be noise, so say what actually went wrong.
    logWarn_('No column in the sheet matches a CRM identifier — the sheet ' +
      'may be empty, or its id column may hold something else entirely.', {
      hint: 'Set CONFIG.mirror.keyField / keyHeader if the match is not obvious.'
    });
    return { missing: leads, stale: [], matched: 0 };
  }

  var missing = leads.filter(function (lead) {
    return !sheetKeys.values[String(lead[sheetKeys.crmField])];
  });

  var crmKeys = {};
  leads.forEach(function (lead) {
    crmKeys[String(lead[sheetKeys.crmField])] = true;
  });

  var stale = Object.keys(sheetKeys.values).filter(function (key) {
    return !crmKeys[key];
  });

  writeDiffReport_(missing, stale, sheetKeys);

  var summary = 'CRM has ' + leads.length + ' lead(s). ' +
    missing.length + ' missing from the sheet, ' +
    stale.length + ' row(s) in the sheet with no CRM match.';

  console.log(summary + '\nMatched on the sheet column "' +
    sheetKeys.header + '" against the CRM field "' + sheetKeys.crmField + '".');

  logInfo_(summary, {
    matchedOn: sheetKeys.header + ' -> ' + sheetKeys.crmField,
    sampleMissing: missing.slice(0, 10).map(function (lead) {
      return String(lead[sheetKeys.crmField]);
    })
  });

  return {
    missing: missing,
    stale: stale,
    matched: Object.keys(sheetKeys.values).length - stale.length
  };
}

/**
 * Works out which sheet column holds the lead identifier.
 *
 * The sheet is an export whose column names are not known here, so rather
 * than guessing a header, every column is scored by how many of its values
 * actually appear as identifiers in the CRM. The best-scoring column wins.
 * That survives a renamed header and a column added in the middle.
 *
 * @param {Array<Object>} leads
 * @return {?{column: number, header: string, crmField: string,
 *            values: Object<string, boolean>}}
 */
function readSheetKeys_(leads) {
  var sheet = mirrorSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) {
    return null;
  }

  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var headers = values[0];

  // Candidate identifier fields, in order of preference.
  var crmFields = [CONFIG.leadFields.id, CONFIG.leadFields.displayId,
    'id', 'leadId', 'leadNumber', 'number'].filter(unique_);

  var best = null;

  crmFields.forEach(function (field) {
    var crmValues = {};
    var populated = 0;

    leads.forEach(function (lead) {
      var value = lead[field];
      if (value !== undefined && value !== null && value !== '') {
        crmValues[String(value).trim()] = true;
        populated++;
      }
    });

    if (!populated) {
      return;
    }

    for (var col = 0; col < lastCol; col++) {
      var seen = {};
      var hits = 0;
      var filled = 0;

      for (var row = 1; row < values.length; row++) {
        var cell = String(values[row][col] || '').trim();

        if (!cell) {
          continue;
        }

        filled++;
        seen[cell] = true;

        if (crmValues[cell]) {
          hits++;
        }
      }

      // Score by hit *rate*, not hit count. A column of names scores near
      // zero however long the sheet is, while a genuine id column scores high
      // even on a short sheet or one carrying rows the CRM no longer has —
      // which a fixed minimum-hits threshold gets wrong in both directions.
      var rate = filled ? hits / filled : 0;

      if (hits && (!best || rate > best.rate ||
          (rate === best.rate && hits > best.hits))) {
        best = {
          hits: hits,
          rate: rate,
          column: col,
          header: headers[col] || ('column ' + (col + 1)),
          crmField: field,
          values: seen
        };
      }
    }
  });

  // Below this the winning column is coincidence, not an identifier.
  if (!best || best.rate < 0.3) {
    return null;
  }

  return best;
}

/**
 * Writes the findings to their own tab, replacing the previous report.
 *
 * @param {Array<Object>} missing
 * @param {Array<string>} stale
 * @param {Object} keys
 */
function writeDiffReport_(missing, stale, keys) {
  var ss = SpreadsheetApp.openById(CONFIG.workbookId);
  var name = 'דוח פערים';
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  sheet.clear();

  // Show the fields that identify a lead to a human, not the whole record.
  var f = CONFIG.leadFields;
  var columns = [f.displayId, f.clientName, f.statusName, f.statusDate,
    f.sourceName].filter(unique_);

  var rows = [['סוג', 'מזהה'].concat(columns)];

  missing.forEach(function (lead) {
    rows.push(['חסר בגיליון', String(lead[keys.crmField])].concat(
      columns.map(function (column) { return flattenValue_(lead[column]); })));
  });

  stale.forEach(function (key) {
    rows.push(['בגיליון, לא ב-CRM', key].concat(
      columns.map(function () { return ''; })));
  });

  if (rows.length === 1) {
    rows.push(['אין פערים', '', '', '', '', '', '']. slice(0, rows[0].length));
  }

  growGrid_(sheet, rows.length, rows[0].length);
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
}


// ======================================================================
// Diagnose.gs
// ======================================================================

/**
 * Step-by-step diagnosis of the Surense connection.
 *
 * Run this from the Apps Script editor when something is not working. It
 * never throws: every step reports its own HTTP status and, on failure, the
 * server's own words plus the causes worth checking. That is what turns
 * "the API doesn't work" into a specific, fixable finding.
 *
 * Credentials are never printed.
 */
function diagnoseApi() {
  var report = [];
  var add = function (line) {
    report.push(line);
  };

  add('=== Surense API diagnosis ===');
  add('token endpoint : ' + CONFIG.surense.tokenUrl);
  add('api base       : ' + CONFIG.surense.apiBase);
  add('');

  // --- 1. are the credentials even present? -------------------------------
  var clientId = secret_('SURENSE_CLIENT_ID', false);
  var clientSecret = secret_('SURENSE_CLIENT_SECRET', false);

  add('1. Script properties');
  add('   SURENSE_CLIENT_ID     : ' +
    (clientId ? 'set (' + clientId.slice(0, 8) + '...)' : 'MISSING'));
  add('   SURENSE_CLIENT_SECRET : ' +
    (clientSecret ? 'set (' + clientSecret.length + ' chars)' : 'MISSING'));

  if (!clientId || !clientSecret) {
    add('');
    add('   Stop here. Add the missing property under');
    add('   Project Settings -> Script Properties, then run this again.');
    return finish_(report);
  }

  // --- 2. token -----------------------------------------------------------
  add('');
  add('2. POST ' + CONFIG.surense.tokenUrl);

  var tokenResponse = tryFetch_(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    },
    muteHttpExceptions: true
  });

  if (tokenResponse.error) {
    add('   NETWORK ERROR: ' + tokenResponse.error);
    add('   The request never reached Surense. Check the endpoint hostname.');
    return finish_(report);
  }

  add('   HTTP ' + tokenResponse.code);

  if (tokenResponse.code !== 200) {
    add('   Response: ' + tokenResponse.body.slice(0, 400));
    add('');
    add('   Worth checking, in order:');
    add('   - The secret was rotated in Surense but not updated here.');
    add('   - The secret was copied with a trailing space or line break.');
    add('   - The client was disabled, or its grant is not client_credentials.');
    add('   - 415 or "unsupported content type" means the request went as');
    add('     JSON; this code sends form encoding, which is what Surense wants.');
    return finish_(report);
  }

  var token;

  try {
    var parsed = JSON.parse(tokenResponse.body);
    token = parsed.access_token;

    add('   token received : ' + (token ? 'yes' : 'NO — no access_token key'));
    add('   expires_in     : ' + (parsed.expires_in || 'not reported'));

    var scopes = tokenScopes_(token);

    if (scopes) {
      add('   scopes granted : ' + scopes);
      add('');
      add('   The mirror needs leads:read. Writing back to the CRM would need');
      add('   leads:update — this code never calls it.');
    }
  } catch (err) {
    add('   Could not parse the token response: ' + err.message);
    return finish_(report);
  }

  if (!token) {
    return finish_(report);
  }

  // --- 3. field schema ----------------------------------------------------
  add('');
  add('3. GET ' + CONFIG.surense.apiBase + '/leads/fields');

  var fieldsResponse = tryFetch_(CONFIG.surense.apiBase + '/leads/fields', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  describeResponse_(add, fieldsResponse);

  if (fieldsResponse.code === 200) {
    try {
      var fields = fetchLeadFields_();
      add('   fields parsed  : ' + fields.length);
      add('   first few      : ' + fields.slice(0, 15).map(function (field) {
        return field.key;
      }).join(', '));

      if (!fields.length) {
        add('   The endpoint answered but no field could be parsed — the');
        add('   response shape differs from what is expected. Paste the raw');
        add('   body below and the parser can be adjusted.');
        add('   Raw: ' + fieldsResponse.body.slice(0, 600));
      }
    } catch (err) {
      add('   Parsing failed: ' + err.message);
    }
  }

  // --- 4. lead search -----------------------------------------------------
  add('');
  add('4. POST ' + CONFIG.surense.apiBase + '/leads/search');

  var searchResponse = tryFetch_(CONFIG.surense.apiBase + '/leads/search', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ startRow: 0, endRow: 1, filters: [] }),
    muteHttpExceptions: true
  });

  describeResponse_(add, searchResponse);

  if (searchResponse.code === 200) {
    try {
      var body = JSON.parse(searchResponse.body);
      var rows = extractRows_(body);

      add('   envelope keys  : ' + Object.keys(body).join(', '));
      add('   rows returned  : ' + rows.length);

      if (rows.length) {
        add('   lead keys      : ' + Object.keys(rows[0]).join(', '));
        add('');
        add('   Compare those keys against CONFIG.leadFields:');

        Object.keys(CONFIG.leadFields).forEach(function (name) {
          var key = CONFIG.leadFields[name];
          var present = rows[0][key] !== undefined;
          add('     ' + name + ' -> "' + key + '" : ' +
            (present ? 'found' : 'NOT FOUND in the response'));
        });

        add('');
        add('   Any "NOT FOUND" above is a CONFIG.leadFields fix, not a bug.');
      } else {
        add('   The search returned no rows. If the CRM has leads, the filter');
        add('   or the envelope key differs — paste the raw body:');
        add('   Raw: ' + searchResponse.body.slice(0, 600));
      }
    } catch (err) {
      add('   Could not parse the search response: ' + err.message);
    }
  }

  return finish_(report);
}

/**
 * Fetches without throwing, so one failing step cannot end the diagnosis.
 *
 * @param {string} url
 * @param {Object} options
 * @return {{code: number, body: string, error: ?string}}
 */
function tryFetch_(url, options) {
  try {
    var response = UrlFetchApp.fetch(url, options);

    return {
      code: response.getResponseCode(),
      body: response.getContentText(),
      error: null
    };
  } catch (err) {
    return { code: 0, body: '', error: err.message };
  }
}

/**
 * @param {function(string)} add
 * @param {{code: number, body: string, error: ?string}} response
 */
function describeResponse_(add, response) {
  if (response.error) {
    add('   NETWORK ERROR: ' + response.error);
    return;
  }

  add('   HTTP ' + response.code);

  if (response.code === 401) {
    add('   Unauthorized — the token was rejected. Usually a rotated secret.');
  } else if (response.code === 403) {
    add('   Forbidden — authenticated, but this client lacks the scope for');
    add('   this endpoint. Check the scopes listed in step 2.');
  } else if (response.code === 404) {
    add('   Not found — the path is wrong. Check CONFIG.surense.apiBase.');
  } else if (response.code === 429) {
    add('   Rate limited — too many requests. Retry in a minute.');
  } else if (response.code !== 200) {
    add('   Response: ' + response.body.slice(0, 400));
  }
}

/**
 * Reads the scope claim out of a JWT access token, when it is one.
 *
 * Knowing which scopes were actually granted separates "the call is wrong"
 * from "this client was never allowed to make it".
 *
 * @param {string} token
 * @return {?string}
 */
function tokenScopes_(token) {
  try {
    var parts = String(token).split('.');

    if (parts.length !== 3) {
      return null;   // an opaque token, not a JWT
    }

    var payload = JSON.parse(Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])).getDataAsString());

    var scope = payload.scope || payload.scopes || payload.scp;

    if (!scope) {
      return null;
    }

    return Array.isArray(scope) ? scope.join(', ') : String(scope);
  } catch (err) {
    return null;
  }
}

/**
 * @param {Array<string>} report
 * @return {string}
 */
function finish_(report) {
  var text = report.join('\n');

  console.log(text);
  logInfo_('diagnoseApi', { report: text.slice(0, 8000) });

  return text;
}


// ======================================================================
// Triggers.gs
// ======================================================================

/**
 * Trigger management. Run the installers once, from the Apps Script editor,
 * to put the automations on their schedule.
 *
 * There are two independent automations sharing this project:
 *   hourlyMirror  — copies the CRM into the spreadsheet
 *   hourlyUpdate  — emails referring sources when a lead's status changes
 *
 * They can be enabled separately; neither depends on the other.
 */

var HANDLERS = { mirror: 'hourlyMirror', notifier: 'hourlyUpdate' };

/** Installs the hourly CRM-to-sheet mirror. */
function installMirrorTrigger() {
  installHourly_(HANDLERS.mirror);
}

/** Installs the hourly status-change notifier. */
function installNotifierTrigger() {
  installHourly_(HANDLERS.notifier);
}

/**
 * Creates an hourly trigger for one handler, replacing any earlier copy.
 *
 * Apps Script has no weekday filter for hourly triggers — the trigger fires
 * every hour, every day, and the handler drops the ticks that fall outside
 * CONFIG.activeDays and CONFIG.activeHours.
 *
 * @param {string} handler
 */
function installHourly_(handler) {
  removeTrigger_(handler);

  ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();

  var days = CONFIG.activeDays.map(function (day) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day];
  }).join(', ');

  var message = handler + ' installed hourly. Active days: ' + days +
    ' (' + CONFIG.timezone + ').';

  console.log(message);
  logInfo_(message);
}

/** Removes every trigger this project owns. Stops both automations. */
function removeTriggers() {
  var removed = ScriptApp.getProjectTriggers().length;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  console.log('Removed ' + removed + ' trigger(s).');
}

/**
 * @param {string} handler
 */
function removeTrigger_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** Lists the installed triggers — a quick check that a schedule is live. */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  if (!triggers.length) {
    console.log('No triggers installed.');
    return;
  }

  triggers.forEach(function (trigger) {
    console.log(trigger.getHandlerFunction() + ' — ' + trigger.getEventType());
  });
}

/**
 * Clears the notifier's watermark so its next run re-scans the last
 * CONFIG.firstRunLookbackHours instead of continuing from where it stopped.
 */
function resetWatermark() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_RUN_AT');
  logWarn_('Watermark cleared — the next run re-scans the lookback window.');
}

/**
 * One-time check that everything the automations depend on is in place.
 * Run this before installing any trigger.
 *
 * @return {Array<string>} problems found
 */
function checkSetup() {
  var problems = [];

  ['SURENSE_CLIENT_ID', 'SURENSE_CLIENT_SECRET'].forEach(function (name) {
    if (!secret_(name, false)) {
      problems.push('Missing script property: ' + name);
    }
  });

  try {
    getAccessToken_();
    console.log('✓ Surense authentication succeeded.');
  } catch (err) {
    problems.push('Surense authentication failed: ' + err.message);
  }

  try {
    var sheet = mirrorSheet_();
    console.log('✓ Mirror tab resolved: "' + sheet.getName() + '".');
  } catch (err) {
    problems.push('Mirror tab unreachable: ' + err.message);
  }

  // The notifier needs more than the mirror does; report but do not fail on it.
  if (!CONFIG.operatorEmail) {
    problems.push('Notifier: CONFIG.operatorEmail is empty — flood-brake ' +
      'alerts have nowhere to go.');
  }

  try {
    var mapping = loadSourceMapping_();
    var withEmail = Object.keys(mapping).filter(function (key) {
      return mapping[key].email;
    });

    if (!withEmail.length) {
      problems.push('Notifier: the mapping tab has no email addresses yet — ' +
        'nothing can be sent. (The mirror does not need this.)');
    } else {
      console.log('✓ ' + withEmail.length + ' source(s) have an email address.');
    }
  } catch (err) {
    problems.push('Notifier: mapping tab unreadable: ' + err.message);
  }

  if (problems.length) {
    console.warn('Setup is incomplete:\n - ' + problems.join('\n - '));
  } else {
    console.log('Setup looks complete. Run previewApi() next.');
  }

  return problems;
}
