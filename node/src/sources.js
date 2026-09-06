/**
 * Resolving a lead's referring source from an id to a name.
 *
 * The leads carry `sourceId` and nothing else. Every other entity in the CRM
 * arrives as a pair — `statusId`/`statusName`, `interestId`/`interestName`,
 * `ownerId`/`ownerName` — but the source is the one that arrives as a bare
 * UUID. The recipients table is keyed by the source's *name*, because that is
 * what the operator's own file lists, so without a bridge between the two
 * every lead skips with "lead-has-no-source" and nothing is ever sent.
 *
 * The name is not recoverable from the lead: no other mirrored field is
 * functionally determined by `sourceId`. It has to come from a lookup, and
 * this module is the part of that with no I/O — finding id/name pairs in
 * whatever shape a lookup returns, and scoring how much of the real traffic
 * a candidate actually explains.
 */

import { normalizeText } from './mirror.js';

/** Keys that have held the identifier, most specific first. */
const ID_KEYS = ['sourceId', 'sourceid', 'source_id', 'id', 'value', 'key', 'code', 'guid'];

/** Keys that have held the display name, most specific first. */
const NAME_KEYS = [
  'sourceName', 'sourcename', 'source_name',
  'name', 'label', 'title', 'displayName', 'display_name', 'text', 'caption'
];

/** Where a picklist hides its options inside a field-schema entry. */
const OPTION_KEYS = ['options', 'values', 'items', 'picklist', 'lookup', 'choices', 'list'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} value */
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value.trim());
}

/**
 * Picks the first key present and non-empty, honouring the listed order.
 *
 * @param {Record<string, unknown>} row
 * @param {Array<string>} keys
 * @returns {?string}
 */
function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined) continue;

    // Only scalars. A nested object here means the key means something else.
    if (typeof value === 'object') continue;

    const text = String(value).trim();
    if (text) return text;
  }

  return null;
}

/**
 * Pulls {id, name} pairs out of an arbitrary payload.
 *
 * Deliberately shape-agnostic: the point is to accept whatever the lookup
 * turns out to return rather than to require one documented shape, because
 * the shape is exactly what is unknown here. Anything that does not yield
 * both an id and a name it does not already carry is dropped.
 *
 * @param {unknown} payload
 * @param {object} [options]
 * @param {boolean} [options.uuidOnly]  Keep only UUID ids — the leads' shape.
 * @returns {Array<{id: string, name: string}>}
 */
export function extractPairs(payload, { uuidOnly = true } = {}) {
  const found = new Map();

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const id = pick(node, ID_KEYS);
    const name = pick(node, NAME_KEYS);

    // A row is a pair only when the name is not just the id restated.
    if (id && name && id !== name && (!uuidOnly || isUuid(id))) {
      if (!found.has(id)) found.set(id, { id, name });
    }

    // Keep descending regardless: catalogs arrive wrapped, and a picklist
    // sits nested inside its field-schema entry.
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };

  visit(payload, 0);

  return [...found.values()];
}

/**
 * Mines the field schema for the source field's own option list.
 *
 * The cheapest possible answer: the schema is already fetched on every sync,
 * so if the CRM describes `sourceId` as a picklist, the mapping is already
 * arriving and is merely being discarded.
 *
 * @param {Array<object>} schema  Raw entries from GET /leads/fields.
 * @param {string} [idColumn]
 * @returns {Array<{id: string, name: string}>}
 */
export function optionsFromSchema(schema, idColumn = 'sourceId') {
  if (!Array.isArray(schema)) return [];

  const wanted = normalizeText(idColumn);

  for (const field of schema) {
    if (!field || typeof field !== 'object') continue;

    const key = String(field.key ?? field.name ?? field.field ?? field.id ?? '');
    if (normalizeText(key) !== wanted) continue;

    for (const optionKey of OPTION_KEYS) {
      const pairs = extractPairs(field[optionKey]);
      if (pairs.length) return pairs;
    }

    // No recognised option key. The list may still be under a name not on
    // that list, so nested containers are scanned — but only those. Scanning
    // the entry itself would let its own {id, name} become a "source": one
    // bogus pair, scored as a success, naming the wrong partner.
    for (const value of Object.values(field)) {
      if (!value || typeof value !== 'object') continue;

      const pairs = extractPairs(value);
      if (pairs.length) return pairs;
    }

    return [];
  }

  return [];
}

/**
 * Scores a candidate mapping against the ids the leads actually carry.
 *
 * This is what turns "which endpoint is the right one" from a guess into a
 * measurement: a catalog that resolves 3 of 161 sources is the wrong catalog,
 * however plausible its shape, and one that resolves 158 is the right one
 * even if it was found at an unexpected path.
 *
 * @param {Array<{id: string, name: string}>} pairs
 * @param {Map<string, number>} usage  sourceId -> lead count.
 * @returns {{pairs: number, matchedSources: number, matchedLeads: number,
 *           totalSources: number, totalLeads: number, coverage: number,
 *           examples: Array<{id: string, name: string, leads: number}>}}
 */
export function scoreCatalog(pairs, usage) {
  const byId = new Map(pairs.map(pair => [pair.id, pair.name]));

  let matchedSources = 0;
  let matchedLeads = 0;
  let totalLeads = 0;
  const examples = [];

  for (const [id, leads] of usage) {
    totalLeads += leads;

    if (!byId.has(id)) continue;

    matchedSources++;
    matchedLeads += leads;

    if (examples.length < 5) examples.push({ id, name: byId.get(id), leads });
  }

  return {
    pairs: pairs.length,
    matchedSources,
    matchedLeads,
    totalSources: usage.size,
    totalLeads,
    coverage: totalLeads ? Number((matchedLeads / totalLeads).toFixed(4)) : 0,
    examples
  };
}

/**
 * Resolves one lead's source name.
 *
 * The name column is tried first so that a CRM that does serve a source name
 * directly keeps working untouched; the id lookup is the fallback for the
 * shape this CRM actually has.
 *
 * @param {Record<string, unknown>} fields
 * @param {{source: string, sourceId: string}} columns
 * @param {Map<string, string>} sourceNames  id -> name.
 * @returns {{name: string, id: string, via: 'column'|'map'|'none'}}
 */
export function resolveSourceName(fields, columns, sourceNames) {
  const direct = String(fields?.[columns.source] ?? '').trim();

  // A configured source column that turns out to hold a UUID is an id column,
  // whatever it was meant to be. This matters in practice: SOURCE_COLUMN has
  // been pointed at `sourceId` in a deployed environment, and taking that
  // value at face value would treat a UUID as a partner's name — matching no
  // recipient, and reporting the wrong reason for it.
  if (direct && !isUuid(direct)) {
    return { name: direct, id: '', via: 'column' };
  }

  // Whichever column actually carries the id: the one configured for it, or
  // the source column when that is what it holds.
  const id = direct || String(fields?.[columns.sourceId] ?? '').trim();
  if (!id) return { name: '', id: '', via: 'none' };

  const mapped = sourceNames?.get(id);
  if (mapped) return { name: String(mapped), id, via: 'map' };

  return { name: '', id, via: 'none' };
}
