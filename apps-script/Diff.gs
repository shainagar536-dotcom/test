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
