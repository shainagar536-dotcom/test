/**
 * Importing the recipients file.
 *
 * The mapping from a referring source to an address already exists as a
 * spreadsheet. This turns that file into recipient rows, and — more
 * importantly — reports how many of its source names actually match the
 * sources the leads carry, before anything is written.
 *
 * Name matching is the failure that costs the most here: a row whose source
 * name does not match anything simply never fires, and nothing complains.
 * Finding that out at import time rather than months later is the point.
 */

import { normalizeText } from '../mirror.js';

/**
 * Header names accepted for each field, in either language.
 *
 * Compared normalized, so spacing and case do not matter and the file can
 * come straight out of Excel without being tidied first.
 */
const HEADERS = {
  sourceName: ['מקור', 'שם מקור', 'מקור מפנה', 'source', 'source name', 'name'],
  email: ['מייל', 'אימייל', 'דואל', 'דוא"ל', 'כתובת מייל', 'email', 'e-mail', 'mail'],
  whatsapp: ['וואטספ', 'ואטסאפ', 'whatsapp', 'phone', 'טלפון', 'נייד'],
  active: ['פעיל', 'active', 'enabled'],

  // Optional, and the most direct answer to the mapping problem: the leads
  // carry `sourceId` and no name, so a file that lists the id alongside the
  // name carries the bridge itself and needs no lookup in the CRM at all.
  sourceId: [
    'מזהה מקור', 'מזהה', 'קוד מקור', 'sourceid', 'source id', 'id', 'uuid', 'guid'
  ]
};

/**
 * Parses CSV text into rows of strings, per RFC 4180.
 *
 * Written here rather than pulled in: source names contain commas and quotes
 * often enough that naive splitting corrupts them, and this file is the only
 * place the project reads CSV.
 *
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');   // Excel writes a BOM
  const rows = [];

  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];

    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    // A quote opens a quoted field only at the start of one. Hebrew puts a
    // gershayim inside ordinary words — דוא"ל, ת"ז, יו"ר — and treating those
    // as an opening quote swallows the rest of the file into one field.
    if (char === '"' && field === '') quoted = true;
    else if (char === ',' || char === '\t') { row.push(field); field = ''; }
    else if (char === '\r') { /* the \n that follows ends the row */ }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter(entry => entry.some(cell => cell.trim() !== ''));
}

/**
 * Works out which column holds what.
 *
 * @param {Array<string>} headers
 * @returns {{sourceName: number, email: number, whatsapp: number,
 *            active: number, sourceId: number}}
 */
export function detectColumns(headers) {
  const normalized = headers.map(normalizeText);
  const found = {};

  for (const [field, candidates] of Object.entries(HEADERS)) {
    found[field] = normalized.findIndex(header =>
      candidates.some(candidate => normalizeText(candidate) === header));
  }

  // A file whose header row was not recognised at all is far more likely to
  // be missing its header than to be a file of nameless sources.
  if (found.sourceName === -1 && found.email === -1) {
    throw new Error(
      'No source or email column was recognised in the header row.\n' +
      `  Saw: ${headers.join(' | ')}\n` +
      '  Expected a column named one of: מקור / source, and מייל / email.');
  }

  return found;
}

/**
 * Turns parsed rows into recipients, keeping the reason for each rejection.
 *
 * @param {Array<Array<string>>} rows   Including the header row.
 * @returns {{recipients: Array<object>, rejected: Array<object>, columns: object}}
 */
export function buildRecipients(rows) {
  if (rows.length < 2) {
    throw new Error('The file has a header row but no data rows.');
  }

  const columns = detectColumns(rows[0]);
  const recipients = [];
  const rejected = [];
  const seen = new Map();

  const cell = (row, index) => (index === -1 ? '' : String(row[index] ?? '').trim());

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sourceName = cell(row, columns.sourceName);
    const sourceId = cell(row, columns.sourceId);
    const email = cell(row, columns.email);
    const whatsapp = cell(row, columns.whatsapp);
    const activeCell = normalizeText(cell(row, columns.active));

    if (!sourceName) {
      rejected.push({ line: i + 1, reason: 'no-source-name', row: row.join(' | ') });
      continue;
    }

    if (!email && !whatsapp) {
      rejected.push({ line: i + 1, reason: 'no-address', source: sourceName });
      continue;
    }

    // An address that cannot be one is worth catching here rather than
    // discovering when the send fails.
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      rejected.push({ line: i + 1, reason: 'malformed-email', source: sourceName, detail: email });
      continue;
    }

    const key = normalizeText(sourceName);

    // Two rows for the same source, which after normalization is common when
    // a file has been edited by hand over time.
    if (seen.has(key)) {
      rejected.push({
        line: i + 1,
        reason: 'duplicate-source',
        source: sourceName,
        detail: `already on line ${seen.get(key)}`
      });
      continue;
    }

    seen.set(key, i + 1);

    recipients.push({
      sourceKey: key,
      sourceName,
      // Empty unless the file carried an id column. When present this is
      // written to the sources table, which is what lets a lead reach this
      // row at all.
      sourceId,
      email,
      whatsapp,
      // Blank counts as active; only an explicit no mutes a source.
      active: !['לא', 'no', 'false', '0'].includes(activeCell)
    });
  }

  return { recipients, rejected, columns };
}

/**
 * Compares the file against the sources the leads actually carry.
 *
 * This is the part worth reading before committing an import: a row that
 * matches nothing will never fire, and a busy source that the file misses
 * will never be told anything.
 *
 * @param {Array<object>} recipients
 * @param {Array<{source_name: string, leads: number}>} sourcesInUse
 * @returns {object}
 */
export function reconcile(recipients, sourcesInUse) {
  const fileKeys = new Set(recipients.map(recipient => recipient.sourceKey));

  const inUse = sourcesInUse.map(source => ({
    ...source,
    key: normalizeText(source.source_name)
  }));

  const matched = inUse.filter(source => fileKeys.has(source.key));
  const missing = inUse.filter(source => !fileKeys.has(source.key));
  const usedKeys = new Set(inUse.map(source => source.key));

  return {
    matchedSources: matched.length,
    matchedLeads: matched.reduce((sum, source) => sum + source.leads, 0),

    // In the file but matching no lead: a renamed source, or a typo.
    unmatchedFileRows: recipients
      .filter(recipient => !usedKeys.has(recipient.sourceKey))
      .map(recipient => recipient.sourceName),

    // Used by leads but absent from the file, busiest first — the worklist
    // for whoever maintains it.
    sourcesWithoutAddress: missing
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 50)
      .map(source => ({ source: source.source_name, leads: source.leads }))
  };
}
