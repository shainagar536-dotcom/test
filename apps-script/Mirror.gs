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

    var stats = plan.stats;
    stats.baseline = existing.baseline;

    logInfo_((existing.baseline ? 'Baseline written' : 'Mirror synced') +
      ' in ' + Math.round((new Date() - startedAt) / 1000) + 's.', {
      leadsInCrm: result.leads.length,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      missingFromCrm: stats.missing
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
    } else if (String(previous.hash) !== hash) {
      timestamp = now;
      changeType = CHANGE.updated;
      stats.updated++;
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
      }
    });
  }

  return { rows: rows, stats: stats };
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
