/**
 * The mirror's decision logic, with no I/O of its own.
 *
 * Given what the CRM returned and what the destination already holds, this
 * works out which rows are new, which changed, which are untouched and which
 * leads have disappeared — and what to write for each. Keeping it free of
 * network and file access is what makes it directly testable.
 */

import { createHash } from 'node:crypto';

/** Columns the mirror maintains beyond the CRM's own fields. */
export const META = {
  id: '_id',
  timestamp: 'עודכן',
  changeType: 'סוג שינוי',
  hash: '_hash'
};

/** Values written into the change-type column. */
export const CHANGE = {
  baseline: 'בסיס',
  added: 'חדש',
  updated: 'עודכן',
  missing: 'לא נמצא ב-CRM'
};

/** Column order is fixed, so a reader never has to guess where the id is. */
export const META_ORDER = [META.id, META.timestamp, META.changeType, META.hash];

/**
 * Renders one API value as a single cell.
 *
 * Nested objects are the common case: a status or a source usually arrives as
 * `{id, name}` rather than a bare string, and stringifying that naively would
 * put "[object Object]" in the sheet and silently lose the value.
 *
 * @param {unknown} value
 * @returns {string|number|boolean}
 */
export function toCell(value) {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) return formatTimestamp(value, 'UTC');

  const type = typeof value;
  if (type === 'number' || type === 'boolean') return value;

  if (type === 'string') {
    // A spreadsheet reads a leading = + - @ as a formula; keep CRM text as text.
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
  }

  if (Array.isArray(value)) return value.map(toCell).join(', ');

  if (type === 'object') {
    const label = value.name ?? value.title ?? value.label ??
      value.value ?? value.displayName;

    return label === undefined ? JSON.stringify(value) : String(label);
  }

  return String(value);
}

/**
 * Formats a moment in a fixed layout in the given zone.
 *
 * Locale-dependent formatting is a real hazard here: the same instant
 * rendered differently on two machines would change the row hash and mark
 * every dated row as updated on every run.
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string} `yyyy-MM-dd HH:mm:ss`
 */
export function formatTimestamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;

  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

/**
 * Formats a moment as ISO 8601 carrying its UTC offset, in the given zone.
 *
 * The stamp written into a row has to survive a round trip through Postgres
 * and through a spreadsheet, and be comparable across both. A bare
 * "2026-08-25 14:00:00" cannot: a TIMESTAMPTZ column reads it in the server's
 * zone, which on Render is UTC, silently shifting every timestamp by the
 * offset. Carrying the offset removes the ambiguity entirely.
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string} e.g. `2026-08-25T14:00:00+03:00`
 */
export function zonedIso(date, timeZone) {
  const local = formatTimestamp(date, timeZone).replace(' ', 'T');

  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find(part => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';

  // "GMT+03:00" -> "+03:00"; plain "GMT" means UTC.
  const offset = name === 'GMT' ? '+00:00' : name.replace('GMT', '');

  return `${local}${offset}`;
}

/**
 * A short, stable fingerprint of a row's CRM values.
 *
 * The separator is a unit-separator character so that ["a","bc"] and
 * ["ab","c"] cannot collide.
 *
 * @param {Array<unknown>} values
 * @returns {string}
 */
export function hashRow(values) {
  const text = values
    .map(value => (value === null || value === undefined ? '' : String(value)))
    .join('');

  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * Strips the apostrophe added to stop a spreadsheet treating text as a
 * formula, so a round-tripped value compares equal to the fresh one.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripQuote(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/^'/, '');
}

/**
 * Puts the lead id first, adding it when the CRM schema does not list it.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {string} idKey
 * @returns {Array<{key: string, label: string}>}
 */
export function orderColumns(columns, idKey) {
  const idColumn = columns.find(column => column.key === idKey) ??
    { key: idKey, label: idKey };

  const rest = columns.filter(column => column.key !== idKey);

  // Two CRM fields can carry the same display label; headers must stay unique.
  const seen = new Set();

  return [idColumn, ...rest].map(column => {
    let label = column.label || column.key;

    if (seen.has(label)) label = `${label} (${column.key})`;
    seen.add(label);

    return { key: column.key, label };
  });
}

/**
 * Decides what the destination should contain after this run.
 *
 * @param {object} input
 * @param {Array<{key: string, label: string}>} input.columns
 * @param {Array<object>} input.leads          Raw leads from the CRM.
 * @param {{baseline: boolean, byId: Map, order: Array<string>}} input.existing
 * @param {Date} input.now
 * @param {string} input.timeZone
 * @param {string} input.idKey
 * @param {boolean} [input.removeMissing]
 * @returns {{rows: Array<object>, changes: Array<object>, stats: object}}
 */
export function planSync({
  columns, leads, existing, now, timeZone, idKey, removeMissing = false
}) {
  const stamp = zonedIso(now, timeZone);
  const stats = { added: 0, updated: 0, unchanged: 0, missing: 0,
    baseline: existing.baseline };

  const rows = [];
  const changes = [];
  const seen = new Set();

  for (const lead of leads) {
    const cells = columns.map(column => toCell(lead[column.key]));
    const id = String(lead[idKey] ?? lead.id ?? cells[0]);
    const hash = hashRow(cells);
    const previous = existing.byId.get(id);

    let rowStamp;
    let changeType;

    if (existing.baseline) {
      // Nothing to compare against: record the state without claiming that
      // thousands of leads just arrived.
      rowStamp = stamp;
      changeType = CHANGE.baseline;
    } else if (!previous) {
      rowStamp = stamp;
      changeType = CHANGE.added;
      stats.added++;
      changes.push({
        at: stamp, id, type: CHANGE.added,
        column: '', before: '', after: cells.join(' | ')
      });
    } else if (String(previous.hash) !== hash) {
      rowStamp = stamp;
      changeType = CHANGE.updated;
      stats.updated++;

      for (const diff of diffRow(columns, previous.cells, cells)) {
        changes.push({ at: stamp, id, type: CHANGE.updated, ...diff });
      }
    } else {
      // Untouched: keep the stamp from whenever this row last really changed.
      rowStamp = previous.timestamp;
      changeType = previous.changeType;
      stats.unchanged++;
    }

    seen.add(id);
    rows.push(buildRow(columns, cells, id, rowStamp, changeType, hash));
  }

  // Leads the CRM no longer returns. Flagged rather than deleted: removing a
  // row cannot be undone, and a lead vanishing is more often a changed filter
  // or permission than a real deletion.
  if (!existing.baseline && !removeMissing) {
    for (const id of existing.order) {
      if (seen.has(id)) continue;

      const previous = existing.byId.get(id);
      const alreadyFlagged = previous.changeType === CHANGE.missing;

      rows.push(buildRow(
        columns, previous.cells, id,
        alreadyFlagged ? previous.timestamp : stamp,
        CHANGE.missing, previous.hash));

      if (!alreadyFlagged) {
        stats.missing++;
        changes.push({
          at: stamp, id, type: CHANGE.missing,
          column: '', before: '', after: ''
        });
      }
    }
  }

  return { rows, changes, stats };
}

/**
 * Lists the columns whose value differs, so the history can say what moved
 * rather than only that something did.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<unknown>} before
 * @param {Array<unknown>} after
 * @returns {Array<{column: string, before: string, after: string}>}
 */
export function diffRow(columns, before, after) {
  const diffs = [];

  for (let i = 0; i < columns.length; i++) {
    const was = stripQuote(before[i]);
    const is = stripQuote(after[i]);

    if (was !== is) diffs.push({ column: columns[i].label, before: was, after: is });
  }

  return diffs;
}

function buildRow(columns, cells, id, timestamp, changeType, hash) {
  const row = {};

  columns.forEach((column, i) => {
    row[column.label] = cells[i] ?? '';
  });

  row[META.id] = id;
  row[META.timestamp] = timestamp;
  row[META.changeType] = changeType;
  row[META.hash] = hash;

  return row;
}

/**
 * Interprets what a destination handed back as the previous state.
 *
 * A table without the mirror's own meta columns was not written by this tool,
 * so its layout is unknown and it is reported as a baseline rather than
 * guessed at.
 *
 * @param {Array<object>} records
 * @param {Array<{key: string, label: string}>} columns
 * @returns {{baseline: boolean, byId: Map, order: Array<string>}}
 */
export function readExisting(records, columns) {
  const empty = { baseline: true, byId: new Map(), order: [] };

  if (!records?.length) return empty;

  const headers = Object.keys(records[0]);
  if (META_ORDER.some(name => !headers.includes(name))) return empty;

  const byId = new Map();
  const order = [];

  for (const record of records) {
    const id = String(record[META.id] ?? '').trim();
    if (!id) continue;

    byId.set(id, {
      timestamp: record[META.timestamp],
      changeType: record[META.changeType],
      hash: record[META.hash],
      cells: columns.map(column => record[column.label] ?? '')
    });

    order.push(id);
  }

  return { baseline: false, byId, order };
}

/**
 * The header row a destination should write.
 *
 * @param {Array<{key: string, label: string}>} columns
 * @returns {Array<string>}
 */
export function headerFor(columns) {
  return [...columns.map(column => column.label), ...META_ORDER];
}
