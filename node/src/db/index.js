/**
 * Database access. Every SQL statement in the project lives here.
 *
 * Keeping the queries in one module means the rest of the code deals in leads
 * and changes rather than in rows, and a schema change has one place to land.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

import { normalizeText } from '../mirror.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Postgres returns BIGSERIAL as a string to avoid precision loss. These ids
// are well inside the safe range and JSON consumers expect numbers.
pg.types.setTypeParser(20, value => Number(value));

export class Database {
  /** @param {{url: string, ssl: object|false, maxConnections: number}} options */
  constructor({ url, ssl, maxConnections }) {
    this.pool = new pg.Pool({
      connectionString: url,
      ssl,
      max: maxConnections,
      // Render's free web service sleeps; a stale socket should fail fast
      // rather than hang the first request after a wake-up.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }

  /** Creates the tables if they do not exist. Safe to run on every boot. */
  async migrate() {
    const sql = await readFile(join(HERE, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Every stored lead, as the shape planSync expects for comparison.
   *
   * @param {Array<{key: string, label: string}>} columns
   * @returns {Promise<{baseline: boolean, byId: Map, order: Array<string>}>}
   */
  async loadExisting(columns) {
    const { rows } = await this.pool.query(
      'SELECT id, fields, hash, changed_at, change_type FROM leads ORDER BY id');

    if (!rows.length) return { baseline: true, byId: new Map(), order: [] };

    // The stored rows may predate a change in how columns are named. Comparing
    // new labels against old ones finds nothing in common, every row looks
    // changed, and one sync would record thousands of changes and try to
    // notify on all of them. Treat that as a fresh baseline instead.
    const storedKeys = new Set(Object.keys(rows[0].fields ?? {}));
    const overlap = columns.filter(column => storedKeys.has(column.label)).length;

    if (storedKeys.size && overlap < Math.max(1, Math.ceil(columns.length * 0.25))) {
      return {
        baseline: true, byId: new Map(), order: [],
        relabelled: { storedColumns: storedKeys.size, newColumns: columns.length, overlap }
      };
    }

    const byId = new Map();
    const order = [];

    for (const row of rows) {
      byId.set(row.id, {
        timestamp: row.changed_at,
        changeType: row.change_type,
        hash: row.hash,
        cells: columns.map(column => row.fields[column.label] ?? '')
      });

      order.push(row.id);
    }

    return { baseline: false, byId, order };
  }

  /** @returns {Promise<number>} how many leads are stored */
  async countLeads() {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM leads');
    return rows[0].n;
  }

  /**
   * Writes one sync's results.
   *
   * The whole run is a single transaction: a half-applied sync would leave
   * the change feed disagreeing with the lead table, and a reader would then
   * either miss notifications or send them twice.
   *
   * @param {object} input
   * @param {Array<object>} input.rows       Rows from planSync.
   * @param {Array<object>} input.changes    Changes from planSync.
   * @param {Array<{key: string, label: string}>} input.columns
   * @param {Set<string>} input.presentIds   Ids the CRM returned this run.
   * @param {boolean} input.removeMissing
   */
  async applySync({ rows, changes, columns, presentIds, removeMissing = false }) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const row of rows) {
        const fields = {};
        for (const column of columns) fields[column.label] = row[column.label] ?? '';

        await client.query(
          `INSERT INTO leads (id, fields, hash, changed_at, change_type, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (id) DO UPDATE SET
             fields       = EXCLUDED.fields,
             hash         = EXCLUDED.hash,
             changed_at   = EXCLUDED.changed_at,
             change_type  = EXCLUDED.change_type,
             last_seen_at = now()`,
          [row._id, JSON.stringify(fields), row._hash,
            toTimestamp(row['עודכן']), row['סוג שינוי']]);
      }

      if (removeMissing && presentIds.size) {
        await client.query(
          'DELETE FROM leads WHERE NOT (id = ANY($1::text[]))',
          [[...presentIds]]);
      }

      for (const change of changes) {
        await client.query(
          `INSERT INTO changes
             (lead_id, change_type, column_name, before_value, after_value, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [change.id, change.type, change.column ?? '',
            String(change.before ?? ''), String(change.after ?? ''),
            toTimestamp(change.at)]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @param {object} run
   * @returns {Promise<number>} the run's id
   */
  async startRun({ trigger, startedAt }) {
    const { rows } = await this.pool.query(
      'INSERT INTO sync_runs (started_at, trigger) VALUES ($1, $2) RETURNING id',
      [startedAt, trigger]);

    return rows[0].id;
  }

  async finishRun(id, { ok, stats = {}, leadsInCrm = 0, error = null }) {
    await this.pool.query(
      `UPDATE sync_runs SET finished_at = now(), ok = $2, leads_in_crm = $3,
         added = $4, updated = $5, unchanged = $6, missing = $7, error = $8
       WHERE id = $1`,
      [id, ok, leadsInCrm, stats.added ?? 0, stats.updated ?? 0,
        stats.unchanged ?? 0, stats.missing ?? 0, error]);
  }

  /** @returns {Promise<Array<object>>} */
  async recentRuns(limit = 20) {
    const { rows } = await this.pool.query(
      'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT $1', [limit]);

    return rows;
  }

  /**
   * The change feed.
   *
   * @param {object} query
   * @param {string} [query.since]      ISO timestamp, exclusive.
   * @param {number} [query.sinceId]    Change id, exclusive. Preferred over
   *   `since`: ids are strictly increasing, while two changes recorded in the
   *   same second are indistinguishable by timestamp and one would be missed.
   * @param {boolean} [query.pendingOnly]  Only changes with no message sent.
   * @param {Array<string>} [query.types]
   * @param {number} [query.limit]
   * @returns {Promise<Array<object>>}
   */
  async listChanges({
    since, sinceId, pendingOnly = false, types = [], limit = 200
  } = {}) {
    const where = [];
    const params = [];

    if (sinceId !== undefined && sinceId !== null) {
      params.push(sinceId);
      where.push(`c.id > $${params.length}`);
    }

    if (since) {
      params.push(since);
      where.push(`occurred_at > $${params.length}`);
    }

    if (pendingOnly) where.push('notified_at IS NULL');

    if (types.length) {
      params.push(types);
      where.push(`change_type = ANY($${params.length}::text[])`);
    }

    params.push(Math.min(Math.max(limit, 1), 1000));

    const { rows } = await this.pool.query(
      `SELECT c.*, l.fields
         FROM changes c
         LEFT JOIN leads l ON l.id = c.lead_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.occurred_at ASC, c.id ASC
        LIMIT $${params.length}`,
      params);

    return rows;
  }

  /**
   * Marks changes as notified, so a reader cannot send the same message twice.
   *
   * Only rows that are still unsent are updated, and the ids actually claimed
   * are returned — two readers running at once each get a disjoint set rather
   * than both believing they own the same change.
   *
   * @param {Array<number>} ids
   * @param {string} via
   * @returns {Promise<Array<number>>} the ids this call claimed
   */
  async markNotified(ids, via = 'api') {
    if (!ids.length) return [];

    const { rows } = await this.pool.query(
      `UPDATE changes SET notified_at = now(), notified_via = $2
        WHERE id = ANY($1::bigint[]) AND notified_at IS NULL
        RETURNING id`,
      [ids, via]);

    return rows.map(row => row.id);
  }

  /**
   * Reads a consumer's saved position.
   *
   * @param {string} name
   * @returns {Promise<{name: string, lastId: number, updatedAt: ?Date, note: string}>}
   */
  async getCursor(name) {
    const { rows } = await this.pool.query(
      'SELECT name, last_id, updated_at, note FROM cursors WHERE name = $1', [name]);

    if (!rows.length) return { name, lastId: 0, updatedAt: null, note: '' };

    return {
      name: rows[0].name,
      lastId: rows[0].last_id,
      updatedAt: rows[0].updated_at,
      note: rows[0].note
    };
  }

  /**
   * Saves a consumer's position.
   *
   * The stored value only ever moves forward: a retry or a slow duplicate
   * request arriving out of order must not rewind the cursor and cause the
   * same changes to be replayed.
   *
   * @param {string} name
   * @param {number} lastId
   * @param {string} [note]
   * @returns {Promise<{name: string, lastId: number, moved: boolean}>}
   */
  async saveCursor(name, lastId, note = '') {
    const { rows } = await this.pool.query(
      `INSERT INTO cursors (name, last_id, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE
         SET last_id    = GREATEST(cursors.last_id, EXCLUDED.last_id),
             note       = EXCLUDED.note,
             updated_at = now()
       RETURNING last_id`,
      [name, lastId, note]);

    const stored = rows[0].last_id;

    // moved is false when the request tried to rewind and GREATEST kept the
    // higher stored value, which tells a caller its position was stale.
    return { name, lastId: stored, moved: stored === lastId };
  }

  /** @returns {Promise<Array<object>>} */
  async listCursors() {
    const { rows } = await this.pool.query(
      'SELECT name, last_id, updated_at, note FROM cursors ORDER BY name');

    return rows.map(row => ({
      name: row.name, lastId: row.last_id, updatedAt: row.updated_at, note: row.note
    }));
  }

  /** @returns {Promise<number>} the highest change id, for a fresh cursor */
  async latestChangeId() {
    const { rows } = await this.pool.query(
      'SELECT COALESCE(max(id), 0)::bigint AS id FROM changes');

    return Number(rows[0].id);
  }

  /**
   * @param {object} query
   * @returns {Promise<Array<object>>}
   */
  async listLeads({ changedSince, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (changedSince) {
      params.push(changedSince);
      where.push(`changed_at > $${params.length}`);
    }

    params.push(Math.min(Math.max(limit, 1), 1000));
    params.push(Math.max(offset, 0));

    const { rows } = await this.pool.query(
      `SELECT id, fields, changed_at, change_type, first_seen_at, last_seen_at
         FROM leads
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY changed_at DESC, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);

    return rows;
  }

  /** @param {string} id */
  async getLead(id) {
    const { rows } = await this.pool.query(
      'SELECT id, fields, changed_at, change_type FROM leads WHERE id = $1', [id]);

    return rows[0] ?? null;
  }

  // ------------------------------------------------------------ templates
  /** @returns {Promise<Array<object>>} */
  async listTemplates() {
    const { rows } = await this.pool.query(
      'SELECT status, message, channel, active, updated_at FROM templates ORDER BY status');

    return rows;
  }

  /**
   * Adds or replaces one status template.
   *
   * @param {{status: string, message: string, channel?: string, active?: boolean}} template
   */
  async saveTemplate({ status, message, channel = 'email', active = true }) {
    const { rows } = await this.pool.query(
      `INSERT INTO templates (status, message, channel, active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (status) DO UPDATE
         SET message = EXCLUDED.message, channel = EXCLUDED.channel,
             active = EXCLUDED.active, updated_at = now()
       RETURNING status, message, channel, active`,
      [status, message, channel, active]);

    return rows[0];
  }

  /** @param {string} status */
  async deleteTemplate(status) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM templates WHERE status = $1', [status]);

    return rowCount > 0;
  }

  /**
   * Writes the starting set of templates, but only into an empty table.
   *
   * Seeding is deliberately not an upsert: once someone has edited the
   * wording, a later deploy must not quietly put the original text back.
   *
   * @param {Array<object>} templates
   * @returns {Promise<number>} how many were written
   */
  async seedTemplates(templates) {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM templates');
    if (rows[0].n > 0) return 0;

    for (const template of templates) await this.saveTemplate(template);

    return templates.length;
  }

  // ----------------------------------------------------------- recipients
  /** @returns {Promise<Array<object>>} */
  async listRecipients() {
    const { rows } = await this.pool.query(
      `SELECT source_key, source_name, email, whatsapp, channel, leads,
              active, updated_at
         FROM recipients ORDER BY leads DESC, source_name`);

    return rows;
  }

  /**
   * @param {{sourceKey: string, sourceName: string, email?: string,
   *          whatsapp?: string, active?: boolean}} recipient
   */
  async saveRecipient({
    sourceKey, sourceName, email = '', whatsapp = '', active = true,
    channel = '', leads = 0
  }) {
    // The channel follows the address when it is not given, so a row edited
    // in the dashboard with only an email does not have to say twice that it
    // is an email row.
    const resolved = channel || (email ? 'email' : whatsapp ? 'whatsapp' : '');

    const { rows } = await this.pool.query(
      `INSERT INTO recipients
              (source_key, source_name, email, whatsapp, channel, leads, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_key) DO UPDATE
         SET source_name = EXCLUDED.source_name, email = EXCLUDED.email,
             whatsapp = EXCLUDED.whatsapp, channel = EXCLUDED.channel,
             leads = EXCLUDED.leads, active = EXCLUDED.active,
             updated_at = now()
       RETURNING source_key, source_name, email, whatsapp, channel, leads, active`,
      [sourceKey, sourceName, email, whatsapp, resolved, leads, active]);

    return rows[0];
  }

  /**
   * Writes the shipped recipient list into an empty table.
   *
   * Only into an empty one: after the first boot the dashboard owns this, and
   * a deploy must not undo an address somebody corrected.
   *
   * @param {Array<object>} rows
   * @returns {Promise<number>} how many were written
   */
  async seedRecipients(rows) {
    const { rows: [{ count }] } =
      await this.pool.query('SELECT count(*)::int AS count FROM recipients');

    if (count > 0) return 0;

    let written = 0;

    for (const row of rows) {
      await this.saveRecipient({
        sourceKey: normalizeText(row.sourceName),
        sourceName: row.sourceName,
        email: row.email ?? '',
        whatsapp: row.whatsapp ?? '',
        channel: row.channel ?? '',
        leads: row.leads ?? 0,
        active: true
      });

      written++;
    }

    return written;
  }

  /** @param {string} sourceKey */
  async deleteRecipient(sourceKey) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM recipients WHERE source_key = $1', [sourceKey]);

    return rowCount > 0;
  }

  // --------------------------------------------------------- source names
  /**
  // --------------------------------------------------------- source names
  /**
   * Every distinct source the stored leads carry, with how many leads each
   * covers, the name it resolves to, and whether it has a recipient row.
   *
   * This is what turns filling in the recipients table from guesswork into a
   * worklist: the busiest unmatched sources are the ones worth an address.
   *
   * A lead's source arrives as an id, so each value is put through the
   * mapping first. Matching to a recipient is then done on the NORMALIZED
   * name here rather than in SQL, because that is exactly how the send path
   * matches — a join on the raw string reports a source as covered that a
   * doubled space stops the sender from ever finding.
   *
   * @param {{source: string, sourceId: string}|string} columns
   * @returns {Promise<Array<object>>}
   */
  async listSourcesInUse(columns) {
    const { source, sourceId } = sourceColumns(columns);

    // Either column may carry the id; whichever holds a value is the source.
    const { rows } = await this.pool.query(
      `SELECT coalesce(NULLIF(l.fields ->> $1, ''), l.fields ->> $2) AS value,
              count(*)::int AS leads
         FROM leads l
        WHERE coalesce(NULLIF(l.fields ->> $1, ''), l.fields ->> $2, '') <> ''
        GROUP BY 1
        ORDER BY 2 DESC`,
      [source, sourceId]);

    const names = await this.sourceNameMap();
    const recipientKeys = new Set(
      (await this.listRecipients()).map(recipient => recipient.source_key));

    return rows.map(row => {
      const mapped = names.get(row.value);
      const name = mapped ?? row.value;

      return {
        source_id: row.value,
        source_name: name,
        resolved: mapped !== undefined,
        leads: row.leads,
        has_recipient: recipientKeys.has(normalizeText(name))
      };
    });
  }

  /**
   * How many leads each source id carries, named or not.
   *
   * This is the denominator a candidate catalog is scored against — see
   * scoreCatalog in sources.js.
   *
   * @param {{source: string, sourceId: string}|string} columns
   * @returns {Promise<Map<string, number>>}
   */
  async sourceUsage(columns) {
    return new Map((await this.listSourcesInUse(columns))
      .map(source => [source.source_id, source.leads]));
  }

  /**
   * The whole id -> name map, as the outbox needs it.
   *
   * @returns {Promise<Map<string, string>>}
   */
  async sourceNameMap() {
    const { rows } = await this.pool.query('SELECT source_id, name FROM sources');

    return new Map(rows.map(row => [row.source_id, row.name]));
  }

  /** @returns {Promise<Array<object>>} */
  async listSourceMap() {
    const { rows } = await this.pool.query(
      `SELECT source_id, name, origin, updated_at
         FROM sources ORDER BY name`);

    return rows;
  }

  /**
   * Source ids the leads carry that no name is known for.
   *
   * These are the leads that can never produce a message: the id is present,
   * so the lead is not sourceless, but nothing can be looked up by it. Kept
   * separate from listSourcesInUse so that "we do not know who this is" never
   * reads as "this source has no leads".
   *
   * @param {{source: string, sourceId: string}|string} columns
   * @returns {Promise<Array<{source_id: string, leads: number}>>}
   */
  async listUnresolvedSources(columns) {
    return (await this.listSourcesInUse(columns))
      .filter(source => !source.resolved)
      .map(source => ({ source_id: source.source_id, leads: source.leads }));
  }

  /**
   * Writes id -> name pairs.
   *
   * A manual entry outranks the CRM: when a sync rediscovers a name for an id
   * somebody has already corrected by hand, the hand-written one stands. The
   * operator fixing a name in the recipients worklist and having the next
   * hourly sync quietly undo it is the failure this prevents.
   *
   * @param {Array<{id: string, name: string}>} pairs
   * @param {'crm'|'manual'} origin
   * @returns {Promise<{written: number}>}
   */
  async upsertSources(pairs, origin = 'crm') {
    let written = 0;

    for (const pair of pairs) {
      const id = String(pair.id ?? '').trim();
      const name = String(pair.name ?? '').trim();
      if (!id || !name) continue;

      const { rowCount } = await this.pool.query(
        `INSERT INTO sources (source_id, name, origin, updated_at)
              VALUES ($1, $2, $3, now())
         ON CONFLICT (source_id) DO UPDATE
                SET name = EXCLUDED.name,
                    origin = EXCLUDED.origin,
                    updated_at = now()
              WHERE sources.origin <> 'manual' OR EXCLUDED.origin = 'manual'`,
        [id, name, origin]);

      written += rowCount;
    }

    return { written };
  }

  /**
   * A page of leads for the dashboard, with whether each has been notified.
   *
   * "Handled" is asked of the change feed, not of the lead: a lead is not a
   * thing that gets sent, a status change is. A lead counts as open when any
   * of its status changes is still unsent, which is what a reader means by
   * "did this one go out yet".
   *
   * The delivery filter is applied in SQL so paging stays honest — filtering
   * a page after it was fetched gives short pages and a wrong total.
   *
   * @param {object} options
   * @param {{status: string, sourceId: string, source: string}} options.columns
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @param {string} [options.search]    Matched against name, number, phone.
   * @param {string} [options.status]    Exact CRM status name.
   * @param {string} [options.assignee]  Exact handler name.
   * @param {'all'|'sent'|'open'|'none'} [options.delivery]
   * @returns {Promise<{rows: Array<object>, total: number}>}
   */
  async listLeadsForDashboard({
    columns, limit = 50, offset = 0, search = '',
    status = '', assignee = '', delivery = 'all'
  } = {}) {
    const params = [columns.status];
    const where = [];

    // Does this lead have a status change, sent or unsent? Expressed once and
    // reused, so the filter and the returned flags can never disagree.
    const openExists = `EXISTS (SELECT 1 FROM changes c
                                 WHERE c.lead_id = l.id
                                   AND c.column_name = $1
                                   AND c.notified_at IS NULL)`;
    const sentExists = `EXISTS (SELECT 1 FROM changes c
                                 WHERE c.lead_id = l.id
                                   AND c.column_name = $1
                                   AND c.notified_at IS NOT NULL)`;

    if (search) {
      params.push(`%${search}%`);
      const like = `$${params.length}`;

      where.push(`(l.fields ->> 'fullName' ILIKE ${like}
                OR l.fields ->> 'number'   ILIKE ${like}
                OR l.fields ->> 'cellNumber' ILIKE ${like}
                OR l.fields ->> 'idNumber' ILIKE ${like}
                OR l.id ILIKE ${like})`);
    }

    if (status) {
      params.push(status);
      where.push(`l.fields ->> $1 = $${params.length}`);
    }

    if (assignee) {
      params.push(assignee);
      where.push(`l.fields ->> 'assigneeName' = $${params.length}`);
    }

    if (delivery === 'sent') where.push(`${sentExists} AND NOT ${openExists}`);
    if (delivery === 'open') where.push(openExists);
    if (delivery === 'none') where.push(`NOT ${openExists} AND NOT ${sentExists}`);

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Counted through a subquery that carries the same two flags as the page
    // below. Without them the count would reference no parameter at all when
    // nothing is filtered, and Postgres rejects a bind that supplies one.
    const { rows: [{ total }] } = await this.pool.query(
      `SELECT count(*)::int AS total
         FROM (SELECT ${openExists} AS has_open, ${sentExists} AS has_sent
                 FROM leads l ${clause}) counted`,
      params);

    params.push(Math.min(Math.max(limit, 1), 500));
    params.push(Math.max(offset, 0));

    const { rows } = await this.pool.query(
      `SELECT l.id, l.fields, l.changed_at, l.change_type,
              ${openExists} AS has_open,
              ${sentExists} AS has_sent
         FROM leads l
         ${clause}
        ORDER BY l.changed_at DESC, l.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);

    return { rows, total };
  }

  /**
   * The unsent status changes for a given set of leads.
   *
   * Fetched for the page being shown rather than for the whole table: the
   * reason a change is not going out is worked out by the outbox itself, and
   * that needs the change row, not a summary of it.
   *
   * @param {Array<string>} leadIds
   * @param {string} statusColumn
   * @returns {Promise<Array<object>>}
   */
  async pendingChangesForLeads(leadIds, statusColumn) {
    if (!leadIds.length) return [];

    const { rows } = await this.pool.query(
      `SELECT c.id, c.lead_id, c.change_type, c.column_name,
              c.before_value, c.after_value, c.occurred_at,
              c.notified_at, c.notified_via, l.fields
         FROM changes c
         JOIN leads l ON l.id = c.lead_id
        WHERE c.lead_id = ANY($1)
          AND c.column_name = $2
          AND c.notified_at IS NULL
        ORDER BY c.id`,
      [leadIds, statusColumn]);

    return rows;
  }

  /**
   * The most recent send recorded for each of these leads.
   *
   * @param {Array<string>} leadIds
   * @param {string} statusColumn
   * @returns {Promise<Map<string, {notified_at: Date, notified_via: string, after_value: string}>>}
   */
  async lastSendForLeads(leadIds, statusColumn) {
    if (!leadIds.length) return new Map();

    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (lead_id)
              lead_id, notified_at, notified_via, after_value
         FROM changes
        WHERE lead_id = ANY($1)
          AND column_name = $2
          AND notified_at IS NOT NULL
        ORDER BY lead_id, notified_at DESC, id DESC`,
      [leadIds, statusColumn]);

    return new Map(rows.map(row => [row.lead_id, row]));
  }

  /**
   * Distinct values of one stored field, for the dashboard's filters.
   *
   * @param {string} field
   * @param {number} [limit]
   * @returns {Promise<Array<{value: string, leads: number}>>}
   */
  async distinctFieldValues(field, limit = 100) {
    const { rows } = await this.pool.query(
      `SELECT fields ->> $1 AS value, count(*)::int AS leads
         FROM leads
        WHERE coalesce(fields ->> $1, '') <> ''
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT $2`,
      [field, limit]);

    return rows;
  }

  /**
   * Headline counts for the dashboard, in one round trip.
   *
   * @param {string} statusColumn
   * @returns {Promise<object>}
   */
  async deliveryCounts(statusColumn) {
    const { rows: [counts] } = await this.pool.query(
      `SELECT
         (SELECT count(*)::int FROM leads) AS leads,
         (SELECT count(*)::int FROM changes
           WHERE column_name = $1 AND notified_at IS NULL) AS open_changes,
         (SELECT count(*)::int FROM changes
           WHERE column_name = $1 AND notified_at IS NOT NULL) AS sent_changes,
         (SELECT count(DISTINCT lead_id)::int FROM changes
           WHERE column_name = $1 AND notified_at IS NULL) AS open_leads,
         (SELECT count(DISTINCT lead_id)::int FROM changes
           WHERE column_name = $1 AND notified_at IS NOT NULL) AS sent_leads`,
      [statusColumn]);

    return counts;
  }

  /** @param {string} sourceId */
  async deleteSource(sourceId) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM sources WHERE source_id = $1', [sourceId]);

    return rowCount > 0;
  }

  // ---------------------------------------------------------- status events
  /**
   * Records one status change.
   *
   * Written before anything is looked up, so a CRM that is slow or down costs
   * an enrichment, never the event. A redelivery of the same change updates
   * nothing and returns the row already held.
   *
   * @param {object} event
   * @returns {Promise<{id: number, created: boolean}>}
   */
  async recordStatusEvent(event) {
    const { rows } = await this.pool.query(
      `INSERT INTO status_events
              (lead_id, lead_number, customer_name, status_before, status_after,
               assignee_name, source_id, source_name, source_state, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (lead_id, status_before, status_after, occurred_at)
       DO NOTHING
       RETURNING id`,
      [
        event.leadId,
        event.leadNumber ?? '',
        event.customerName ?? '',
        event.statusBefore ?? '',
        event.statusAfter ?? '',
        event.assigneeName ?? '',
        event.sourceId ?? '',
        event.sourceName ?? '',
        event.sourceState ?? 'pending',
        eventTimestamp(event.occurredAt)
      ]);

    if (rows.length) return { id: Number(rows[0].id), created: true };

    // Already recorded. Return the row that exists so the caller can report
    // the duplicate rather than treating it as a failure.
    const { rows: existing } = await this.pool.query(
      `SELECT id FROM status_events
        WHERE lead_id = $1 AND status_before = $2
          AND status_after = $3 AND occurred_at = $4`,
      [event.leadId, event.statusBefore ?? '', event.statusAfter ?? '',
        eventTimestamp(event.occurredAt)]);

    return { id: existing.length ? Number(existing[0].id) : 0, created: false };
  }

  /**
   * Fills in what the lookup found for an event.
   *
   * @param {number} id
   * @param {object} patch
   */
  async enrichStatusEvent(id, patch) {
    await this.pool.query(
      `UPDATE status_events
          SET amount        = coalesce(NULLIF($7, ''), amount),
              assignee_name = coalesce(NULLIF($2, ''), assignee_name),
              source_id     = coalesce(NULLIF($3, ''), source_id),
              source_name   = coalesce(NULLIF($4, ''), source_name),
              source_state  = $5,
              source_error  = $6,
              enrich_attempts = enrich_attempts + 1
        WHERE id = $1`,
      [id, patch.assigneeName ?? '', patch.sourceId ?? '', patch.sourceName ?? '',
        patch.sourceState ?? 'pending', patch.sourceError ?? '', patch.amount ?? '']);
  }

  /**
   * Events whose source has not been resolved yet.
   *
   * `failed` is included: a lookup that failed because the CRM was briefly
   * unreachable should be retried, and capping the attempts is what stops an
   * event that can never resolve from being retried forever.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async pendingEnrichment({ limit = 25, maxAttempts = 5 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM status_events
        WHERE source_state IN ('pending', 'failed')
          AND enrich_attempts < $2
        ORDER BY id
        LIMIT $1`,
      [limit, maxAttempts]);

    return rows;
  }

  /**
   * The change feed the sender reads.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async listStatusEvents({
    limit = 100, offset = 0, pendingOnly = false, sinceId, search = '',
    status = '', assignee = '', delivery = 'all', channel = '', sort = 'desc'
  } = {}) {
    const params = [];
    const where = [];

    if (pendingOnly) where.push('notified_at IS NULL');

    if (sinceId !== undefined) {
      params.push(sinceId);
      where.push(`id > $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(customer_name ILIKE $${params.length}
                OR lead_number   ILIKE $${params.length}
                OR source_name   ILIKE $${params.length}
                OR assignee_name ILIKE $${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`status_after = $${params.length}`);
    }

    if (assignee) {
      params.push(assignee);
      where.push(`assignee_name = $${params.length}`);
    }

    if (delivery === 'sent') where.push('notified_at IS NOT NULL');
    if (delivery === 'open') where.push('notified_at IS NULL');

    // Which channel a message actually went out on, so "what did we send by
    // WhatsApp" is a filter rather than a read-through.
    if (channel) {
      params.push(channel);
      where.push(`notified_via = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(Math.min(Math.max(limit, 1), 500));
    params.push(Math.max(offset, 0));

    const { rows } = await this.pool.query(
      `SELECT * FROM status_events
        ${clause}
        ORDER BY occurred_at ${sort === 'asc' ? 'ASC' : 'DESC'},
                 id ${sort === 'asc' ? 'ASC' : 'DESC'}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);

    return rows;
  }

  /**
   * How many events match, for paging.
   *
   * Counted in SQL rather than by measuring a page: a page is capped, so
   * counting its rows silently reports 500 once there are more than that.
   *
   * @param {object} [options]
   * @returns {Promise<number>}
   */
  async countStatusEvents({
    pendingOnly = false, search = '', status = '', assignee = '',
    delivery = 'all', channel = ''
  } = {}) {
    const params = [];
    const where = [];

    if (pendingOnly) where.push('notified_at IS NULL');

    if (search) {
      params.push(`%${search}%`);
      where.push(`(customer_name ILIKE $${params.length}
                OR lead_number   ILIKE $${params.length}
                OR source_name   ILIKE $${params.length}
                OR assignee_name ILIKE $${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`status_after = $${params.length}`);
    }

    if (assignee) {
      params.push(assignee);
      where.push(`assignee_name = $${params.length}`);
    }

    if (delivery === 'sent') where.push('notified_at IS NOT NULL');
    if (delivery === 'open') where.push('notified_at IS NULL');

    if (channel) {
      params.push(channel);
      where.push(`notified_via = $${params.length}`);
    }

    const { rows: [{ total }] } = await this.pool.query(
      `SELECT count(*)::int AS total FROM status_events
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params);

    return total;
  }

  /** Headline counts for the dashboard. */
  async statusEventCounts() {
    const { rows: [counts] } = await this.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE notified_at IS NULL)::int      AS open,
              count(*) FILTER (WHERE notified_at IS NOT NULL)::int  AS sent,
              count(*) FILTER (WHERE notified_via = 'whatsapp')::int AS whatsapp,
              count(*) FILTER (WHERE notified_via = 'email')::int    AS email,
              count(*) FILTER (WHERE source_state = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE source_state IN ('pending', 'failed'))::int
                AS unresolved,
              count(DISTINCT lead_id)::int                          AS leads
         FROM status_events`);

    return counts;
  }

  /**
   * Marks events as notified, claiming each exactly once.
   *
   * The WHERE on notified_at is what makes two senders running at the same
   * time safe: each claims a disjoint set, so no message goes out twice.
   *
   * @param {Array<number>} ids
   * @param {string} via
   * @param {string} to
   */
  async markEventsNotified(ids, via = '', to = '') {
    if (!ids.length) return { claimed: [], alreadyClaimed: [] };

    const { rows } = await this.pool.query(
      `UPDATE status_events
          SET notified_at = now(), notified_via = $2, notified_to = $3
        WHERE id = ANY($1) AND notified_at IS NULL
        RETURNING id, lead_id, occurred_at`,
      [ids, via, to]);

    const claimed = rows.map(row => Number(row.id));

    // A lead that moved twice before anything went out has older unsent
    // events that are now history, not a queue. Closing them against the one
    // that was sent keeps every move in the record and says which was
    // reported — rather than leaving them to be sent later, out of date.
    let superseded = 0;

    for (const row of rows) {
      const { rowCount } = await this.pool.query(
        `UPDATE status_events
            SET notified_at = now(),
                notified_via = 'superseded',
                superseded_by = $1
          WHERE lead_id = $2
            AND notified_at IS NULL
            AND (occurred_at, id) < ($3, $1)`,
        [Number(row.id), row.lead_id, row.occurred_at]);

      superseded += rowCount;
    }

    return {
      claimed,
      superseded,
      alreadyClaimed: ids.filter(id => !claimed.includes(Number(id)))
    };
  }

  /** Distinct values for the dashboard filters. */
  async eventFilterValues() {
    const { rows: statuses } = await this.pool.query(
      `SELECT status_after AS value, count(*)::int AS leads
         FROM status_events WHERE status_after <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 60`);

    const { rows: assignees } = await this.pool.query(
      `SELECT assignee_name AS value, count(*)::int AS leads
         FROM status_events WHERE assignee_name <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);

    return { statuses, assignees };
  }

  /**
   * Empties the operational mirror, leaving the history untouched.
   *
   * The lead mirror is a cache of the CRM and can be rebuilt at will; the
   * status history cannot, so it is not in this list and the database refuses
   * to delete it anyway.
   *
   * @returns {Promise<Record<string, number>>}
   */
  async resetMirror() {
    const cleared = {};

    for (const table of ['changes', 'leads', 'sync_runs', 'webhook_events', 'cursors']) {
      const { rowCount } = await this.pool.query(`DELETE FROM ${table}`);
      cleared[table] = rowCount;
    }

    return cleared;
  }

  /**
   * Stores a webhook delivery exactly as received.
   *
   * Returns `duplicate: true` when the sender's message id has been seen
   * before. Svix retries a failed delivery with the same id, so without this
   * a retry after a transient failure would record the change a second time
   * and the referring source would be told twice.
   *
   * @param {string} source
   * @param {object} payload
   * @param {?string} [externalId]  The sender's message id (svix-id).
   * @returns {Promise<{id: ?number, duplicate: boolean}>}
   */
  async recordWebhook(source, payload, externalId = null) {
    payload = stripNullBytes(payload);

    const { rows } = await this.pool.query(
      `INSERT INTO webhook_events (source, external_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [source, externalId, JSON.stringify(payload)]);

    if (!rows.length) return { id: null, duplicate: true };

    return { id: rows[0].id, duplicate: false };
  }

  /**
   * Marks a stored delivery as handled, with what came of it.
   *
   * @param {number} id
   * @param {string} result
   */
  async finishWebhook(id, result) {
    if (!id) return;

    await this.pool.query(
      'UPDATE webhook_events SET processed_at = now(), result = $2 WHERE id = $1',
      [id, String(result).slice(0, 500)]);
  }

  /**
   * Records a status change reported by a webhook, and moves the stored lead
   * to match.
   *
   * Both in one transaction: a change row without the matching lead update
   * would make the next poll see the old value and record the same move a
   * second time.
   *
   * @param {object} input
   * @param {string} input.leadId
   * @param {string} input.statusColumn
   * @param {string} input.before
   * @param {string} input.after
   * @param {?string} [input.occurredAt]  The event's own timestamp.
   * @returns {Promise<Array<number>>} the change ids created
   */
  async recordWebhookChange({ leadId, statusColumn, before, after, occurredAt }) {
    const client = await this.pool.connect();
    const when = occurredAt ? new Date(occurredAt) : new Date();
    const at = Number.isNaN(when.getTime()) ? new Date() : when;

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO changes
           (lead_id, change_type, column_name, before_value, after_value, occurred_at)
         VALUES ($1, 'עודכן', $2, $3, $4, $5)
         RETURNING id`,
        [leadId, statusColumn, before, after, at]);

      // The mirror has to move too, or the next poll compares against the old
      // status and records the identical change again.
      await client.query(
        `UPDATE leads
            SET fields      = jsonb_set(fields, ARRAY[$2::text], to_jsonb($3::text), true),
                changed_at  = $4,
                change_type = 'עודכן',
                hash        = 'webhook:' || md5(random()::text)
          WHERE id = $1`,
        [leadId, statusColumn, after, at]);

      await client.query('COMMIT');

      return rows.map(row => row.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Stored deliveries, newest work first.
   *
   * Defaults to everything rather than to unprocessed only: now that each
   * delivery is handled on arrival, "unprocessed" means "stuck", and someone
   * checking whether a webhook arrived at all would otherwise see an empty
   * list and conclude it never came.
   */
  async listWebhookEvents({ pendingOnly = false, limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM webhook_events
        ${pendingOnly ? 'WHERE processed_at IS NULL' : ''}
        ORDER BY received_at ASC LIMIT $1`,
      [Math.min(limit, 500)]);

    return rows;
  }
}

/**
 * Accepts what planSync produced as a timestamp Postgres reads unambiguously.
 *
 * planSync emits ISO 8601 carrying the zone offset, which TIMESTAMPTZ parses
 * exactly. A row carried forward untouched brings back the Date this driver
 * already returned, which needs no conversion. Anything else is a bug worth
 * failing loudly on rather than storing at the wrong hour.
 *
 * @param {string|Date} value
 * @returns {Date|string}
 */
/**
 * Normalizes the column argument the source queries take.
 *
 * Accepts the plain string these methods used to take, so a caller that only
 * knows about a source *name* column keeps working, and defaults the id
 * column to the key this CRM actually uses.
 *
 * @param {string|{source?: string, sourceId?: string}} columns
 * @returns {{source: string, sourceId: string}}
 */
function sourceColumns(columns) {
  if (typeof columns === 'string') {
    return { source: columns, sourceId: 'sourceId' };
  }

  return {
    source: columns?.source ?? '',
    sourceId: columns?.sourceId ?? 'sourceId'
  };
}

/**
 * Coerces whatever a webhook called a timestamp into one we can store.
 *
 * Deliberately forgiving, unlike toTimestamp below. That one guards the sync,
 * where a stamp without an offset is a bug worth stopping for. This one sits
 * on the webhook path, where the sender is outside our control: a delivery
 * with no date, a date in a shape nobody documented, or an outright bad one
 * must still be recorded. Throwing here returns a 500, and Svix answers a 500
 * by delivering the same event again, forever.
 *
 * Falls back to now, which is wrong by seconds; refusing the event is wrong
 * by the whole event.
 *
 * @param {unknown} value
 * @returns {Date}
 */
export function eventTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds and milliseconds are both seen in the wild; anything before
    // 1973 in ms is far more likely to be seconds.
    const date = new Date(value < 1e11 ? value * 1000 : value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value.trim());
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

/**
 * Removes what Postgres cannot store in a JSONB column.
 *
 * A JSON string may contain \u0000; a Postgres jsonb value may not. One null
 * byte anywhere in a delivery would make the insert throw, the endpoint
 * answer 500, and the sender retry the identical body until it gives up.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripNullBytes(value) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(stripNullBytes);

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key.replace(/\u0000/g, ''), stripNullBytes(item)]));
  }

  return value;
}

function toTimestamp(value) {
  if (value instanceof Date) return value;

  const text = String(value);

  if (!/[+-]\d{2}:?\d{2}$|Z$/.test(text)) {
    throw new Error(
      `Timestamp "${text}" carries no UTC offset. Postgres would read it in ` +
      'the server timezone and shift it. planSync should emit zonedIso().');
  }

  return text;
}
