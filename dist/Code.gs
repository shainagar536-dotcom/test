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

  // -------------------------------------------------------------- schedule
  timezone: 'Asia/Jerusalem',
  activeDays: [0, 1, 2, 3, 4, 5],   // 0 = Sunday ... 6 = Saturday
  activeHours: null,                // null = every hour of an active day

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
 * Surense CRM client: OAuth token plus the paginated lead search.
 *
 * Surense has no webhooks, so the automation polls: every run asks for the
 * leads whose statusDate moved since the previous run.
 */

/**
 * Fetches an access token, reusing the cached one until it is nearly expired.
 *
 * Tokens are valid for an hour and the automation runs hourly, so the cache
 * mostly matters for retries and manual runs within the same hour.
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
  var payload = {
    grant_type: 'client_credentials',
    client_id: secret_('SURENSE_CLIENT_ID'),
    client_secret: secret_('SURENSE_CLIENT_SECRET')
  };

  var response = UrlFetchApp.fetch(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
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
 * Returns every lead whose status changed after `since`, following pagination
 * to the end.
 *
 * @param {Date} since
 * @return {Array<Object>} raw lead objects as returned by the API
 */
function fetchLeadsChangedSince_(since) {
  var token = getAccessToken_();
  var sinceIso = Utilities.formatDate(
    since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");

  var leads = [];
  var startRow = 0;

  for (var page = 0; page < CONFIG.surense.maxPages; page++) {
    var body = {
      startRow: startRow,
      endRow: startRow + CONFIG.surense.pageSize,
      sorts: [{ field: 'statusDate', dir: 'asc' }],
      filters: [{
        field: 'statusDate',
        operator: 'greaterThan',
        value: sinceIso
      }]
    };

    var response = UrlFetchApp.fetch(
      CONFIG.surense.apiBase + '/leads/search', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });

    if (response.getResponseCode() !== 200) {
      throw new Error('Lead search failed (HTTP ' +
        response.getResponseCode() + '): ' + response.getContentText());
    }

    var parsed = JSON.parse(response.getContentText());
    var batch = parsed.rows || parsed.data || parsed.results || [];

    leads = leads.concat(batch);

    // Trust hasNextPage when the API sends it; otherwise a short page is the
    // end. Either way maxPages stops an unbounded loop.
    var hasNext = parsed.hasNextPage !== undefined
      ? parsed.hasNextPage
      : batch.length === CONFIG.surense.pageSize;

    if (!hasNext || !batch.length) {
      return leads;
    }

    startRow += CONFIG.surense.pageSize;
  }

  logWarn_('Pagination stopped at the ' + CONFIG.surense.maxPages +
    '-page cap; some leads may not have been read.', { collected: leads.length });

  return leads;
}

/**
 * Pulls the fields the automation needs out of a raw lead, using the names in
 * CONFIG.leadFields so a naming mismatch is a config fix, not a code change.
 *
 * @param {Object} raw
 * @return {{id: string, displayId: string, clientName: string,
 *           statusName: string, statusDate: string, sourceName: string}}
 */
function normalizeLead_(raw) {
  var f = CONFIG.leadFields;

  var pick = function (name, fallbacks) {
    if (raw[name] !== undefined && raw[name] !== null && raw[name] !== '') {
      return raw[name];
    }

    for (var i = 0; i < fallbacks.length; i++) {
      var value = raw[fallbacks[i]];
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
// Triggers.gs
// ======================================================================

/**
 * Trigger management. Run installHourlyTrigger() once, from the Apps Script
 * editor, to put the automation on its schedule.
 */

var TRIGGER_HANDLER = 'hourlyUpdate';

/**
 * Installs the hourly time-driven trigger, replacing any earlier copy.
 *
 * Apps Script has no weekday filter for hourly triggers — the trigger fires
 * every hour, every day, and hourlyUpdate() drops the ticks that fall outside
 * CONFIG.activeDays and CONFIG.activeHours.
 */
function installHourlyTrigger() {
  removeTriggers();

  ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyHours(1)
    .create();

  var days = CONFIG.activeDays.map(function (d) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d];
  }).join(', ');

  var message = 'Hourly trigger installed. Active days: ' + days +
    ' (' + CONFIG.timezone + ').';

  console.log(message);
  logInfo_(message, {
    activeHours: CONFIG.activeHours === null ? 'all' : CONFIG.activeHours
  });
}

/** Removes every trigger this script owns. Use it to pause the automation. */
function removeTriggers() {
  var removed = 0;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  if (removed) {
    console.log('Removed ' + removed + ' existing trigger(s).');
  }
}

/** Lists the installed triggers — a quick check that the schedule is live. */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  if (!triggers.length) {
    console.log('No triggers installed. Run installHourlyTrigger().');
    return;
  }

  triggers.forEach(function (trigger) {
    console.log(trigger.getHandlerFunction() + ' — ' +
      trigger.getEventType() + ' / ' + trigger.getTriggerSource());
  });
}

/**
 * Clears the run watermark so the next run re-scans the last
 * CONFIG.firstRunLookbackHours instead of continuing from where it stopped.
 */
function resetWatermark() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_RUN_AT');
  logWarn_('Watermark cleared — the next run re-scans the lookback window.');
}

/**
 * One-time check that everything the automation depends on is in place.
 * Run this before installing the trigger.
 */
function checkSetup() {
  var problems = [];

  ['SURENSE_CLIENT_ID', 'SURENSE_CLIENT_SECRET'].forEach(function (name) {
    if (!secret_(name, false)) {
      problems.push('Missing script property: ' + name);
    }
  });

  if (!CONFIG.operatorEmail) {
    problems.push('CONFIG.operatorEmail is empty — flood-brake alerts have ' +
      'nowhere to go.');
  }

  try {
    var mapping = loadSourceMapping_();
    var withEmail = Object.keys(mapping).filter(function (key) {
      return mapping[key].email;
    });

    if (!withEmail.length) {
      problems.push('The mapping tab has no rows with an email address — ' +
        'nothing can be sent yet.');
    } else {
      console.log(withEmail.length + ' source(s) have an email address.');
    }
  } catch (err) {
    problems.push('Mapping tab unreadable: ' + err.message);
  }

  try {
    getAccessToken_();
    console.log('Surense authentication succeeded.');
  } catch (err) {
    problems.push('Surense authentication failed: ' + err.message);
  }

  if (problems.length) {
    console.warn('Setup is incomplete:\n - ' + problems.join('\n - '));
  } else {
    console.log('Setup looks complete. Run dryRun() next.');
  }

  return problems;
}
