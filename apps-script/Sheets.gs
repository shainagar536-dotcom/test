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
