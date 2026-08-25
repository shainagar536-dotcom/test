/**
 * The mirror: a full copy of the CRM's leads in a spreadsheet tab.
 *
 * Every run replaces the tab's contents outright rather than patching rows.
 * A full replace is self-healing — a lead deleted in the CRM disappears here,
 * an edited field is simply correct again, and no drift can accumulate. The
 * cost is re-reading everything each hour, which at a few thousand leads is
 * well inside what Apps Script allows.
 *
 * Columns come from the CRM's own field schema, so a field added in Surense
 * appears in the mirror without a code change.
 */

/**
 * Reports what the API actually returns, without writing anything.
 *
 * Run this first. The response shapes could not be checked while the code was
 * written — the environment it was written in has no route to the API — so
 * this is what confirms the field names and the response envelope before the
 * first real sync touches the sheet.
 */
function previewApi() {
  var lines = [];

  try {
    getAccessToken_();
    lines.push('✓ Authentication succeeded.');
  } catch (err) {
    console.log('✗ Authentication failed: ' + err.message);
    return;
  }

  try {
    var fields = fetchLeadFields_();
    lines.push('✓ /leads/fields returned ' + fields.length + ' field(s).');
    lines.push('  ' + fields.slice(0, 40).map(function (f) {
      return f.key + (f.label !== f.key ? ' (' + f.label + ')' : '');
    }).join(', '));
  } catch (err) {
    lines.push('✗ /leads/fields failed: ' + err.message);
  }

  try {
    var parsed = surenseRequest_('post', '/leads/search',
      { startRow: 0, endRow: 1, filters: [] });

    lines.push('✓ /leads/search responded.');
    lines.push('  envelope keys: ' + Object.keys(parsed).join(', '));

    var rows = extractRows_(parsed);
    lines.push('  rows found: ' + rows.length);

    if (rows.length) {
      lines.push('  first lead keys: ' + Object.keys(rows[0]).join(', '));
      lines.push('  first lead: ' + JSON.stringify(rows[0]).slice(0, 1500));
    }
  } catch (err) {
    lines.push('✗ /leads/search failed: ' + err.message);
  }

  console.log(lines.join('\n'));
  logInfo_('previewApi', { report: lines.join(' | ').slice(0, 4000) });
}

/** Entry point for the mirror's hourly trigger. */
function hourlyMirror() {
  var now = new Date();

  if (!isWithinSchedule_(now)) {
    console.log('Outside the configured window — skipping.');
    return;
  }

  syncLeads();
}

/**
 * Replaces the mirror tab with the current contents of the CRM.
 */
function syncLeads() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    logWarn_('A mirror sync is already running — skipping.');
    return;
  }

  var startedAt = new Date();

  try {
    var deadline = new Date(
      startedAt.getTime() + CONFIG.mirror.timeBudgetSeconds * 1000);

    var columns = resolveColumns_();
    var result = fetchAllLeads_({ deadline: deadline });

    if (!result.leads.length) {
      logWarn_('The CRM returned no leads — the mirror was left untouched.');
      return;
    }

    // A truncated read must not be written as if it were the whole CRM:
    // replacing the tab with a partial pull would look like mass deletion.
    if (!result.complete) {
      logError_('Read incomplete (' + result.leads.length + ' leads) — the ' +
        'mirror was left untouched to avoid writing a partial copy.', {
        hint: 'Raise CONFIG.surense.maxPages or CONFIG.mirror.timeBudgetSeconds.'
      });
      return;
    }

    var written = writeMirror_(columns, result.leads);

    logInfo_('Mirror synced in ' +
      Math.round((new Date() - startedAt) / 1000) + 's.', {
      leads: result.leads.length,
      columns: columns.length,
      cells: written
    });
  } catch (err) {
    logError_('Mirror sync failed: ' + err.message, { stack: err.stack });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decides the mirror's columns.
 *
 * The CRM's schema is the default. An explicit CONFIG.mirror.columns list
 * overrides it, for when the mirror should hold a chosen subset rather than
 * every field the CRM happens to expose.
 *
 * @return {Array<{key: string, label: string}>}
 */
function resolveColumns_() {
  if (CONFIG.mirror.columns && CONFIG.mirror.columns.length) {
    return CONFIG.mirror.columns.map(function (entry) {
      return typeof entry === 'string'
        ? { key: entry, label: entry }
        : entry;
    });
  }

  var fields = fetchLeadFields_();

  if (!fields.length) {
    throw new Error('The CRM returned no field definitions, and ' +
      'CONFIG.mirror.columns is empty — there are no columns to write.');
  }

  return fields;
}

/**
 * Writes the header row and every lead into the mirror tab.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<Object>} leads
 * @return {number} cells written
 */
function writeMirror_(columns, leads) {
  var sheet = mirrorSheet_();

  var matrix = [columns.map(function (column) { return column.label; })];

  leads.forEach(function (lead) {
    matrix.push(columns.map(function (column) {
      return flattenValue_(lead[column.key]);
    }));
  });

  var rows = matrix.length;
  var cols = columns.length;

  growGrid_(sheet, rows, cols);
  sheet.clearContents();

  // One setValues for the whole block: a per-row write of a few thousand rows
  // would not finish inside the execution limit.
  sheet.getRange(1, 1, rows, cols).setValues(matrix);
  sheet.setFrozenRows(1);

  return rows * cols;
}

/**
 * Renders an API value as something a spreadsheet cell can hold.
 *
 * Nested objects are the common case — a status or a source often arrives as
 * {id, name} rather than a bare string, and writing "[object Object]" into
 * the mirror would quietly lose the value.
 *
 * @param {*} value
 * @return {string|number|boolean|Date}
 */
function flattenValue_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return value;
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
