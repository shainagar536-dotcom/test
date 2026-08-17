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
