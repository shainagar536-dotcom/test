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
      `SELECT source_key, source_name, email, whatsapp, active, updated_at
         FROM recipients ORDER BY source_name`);

    return rows;
  }

  /**
   * @param {{sourceKey: string, sourceName: string, email?: string,
   *          whatsapp?: string, active?: boolean}} recipient
   */
  async saveRecipient({ sourceKey, sourceName, email = '', whatsapp = '', active = true }) {
    const { rows } = await this.pool.query(
      `INSERT INTO recipients (source_key, source_name, email, whatsapp, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_key) DO UPDATE
         SET source_name = EXCLUDED.source_name, email = EXCLUDED.email,
             whatsapp = EXCLUDED.whatsapp, active = EXCLUDED.active,
             updated_at = now()
       RETURNING source_key, source_name, email, whatsapp, active`,
      [sourceKey, sourceName, email, whatsapp, active]);

    return rows[0];
  }

  /** @param {string} sourceKey */
  async deleteRecipient(sourceKey) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM recipients WHERE source_key = $1', [sourceKey]);

    return rowCount > 0;
  }

  /**
   * Every distinct source NAME the stored leads resolve to, with how many
   * leads each covers and whether it already has a recipient row.
   *
   * This is what turns filling in the recipients table from guesswork into a
   * worklist: the busiest unmatched sources are the ones worth an address.
   *
   * A lead reaches a name one of two ways — a name column, if the CRM serves
   * one, or its `sourceId` through the sources table. This CRM only does the
   * second, so a lead whose id has no row in `sources` contributes to no name
   * at all and is reported by listUnresolvedSources instead of silently
   * vanishing from the worklist.
   *
   * @param {{source: string, sourceId: string}} columns
   * @returns {Promise<Array<object>>}
   */
  async listSourcesInUse(columns) {
    const { source, sourceId } = sourceColumns(columns);

    const { rows } = await this.pool.query(
      `SELECT coalesce(NULLIF(l.fields ->> $1, ''), s.name) AS source_name,
              count(*)::int                                 AS leads,
              bool_or(r.source_key IS NOT NULL)             AS has_recipient
         FROM leads l
         LEFT JOIN sources s
           ON s.source_id = NULLIF(l.fields ->> $2, '')
         LEFT JOIN recipients r
           ON r.source_name = coalesce(NULLIF(l.fields ->> $1, ''), s.name)
        WHERE coalesce(NULLIF(l.fields ->> $1, ''), s.name) IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC`,
      [source, sourceId]);

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
   * @param {{source: string, sourceId: string}} columns
   * @returns {Promise<Array<{source_id: string, leads: number}>>}
   */
  async listUnresolvedSources(columns) {
    const { source, sourceId } = sourceColumns(columns);

    const { rows } = await this.pool.query(
      `SELECT l.fields ->> $2 AS source_id, count(*)::int AS leads
         FROM leads l
         LEFT JOIN sources s
           ON s.source_id = NULLIF(l.fields ->> $2, '')
        WHERE coalesce(l.fields ->> $1, '') = ''
          AND coalesce(l.fields ->> $2, '') <> ''
          AND s.source_id IS NULL
        GROUP BY 1
        ORDER BY 2 DESC`,
      [source, sourceId]);

    return rows;
  }

  /**
   * How many leads each source id carries, named or not.
   *
   * This is the denominator a candidate catalog is scored against — see
   * scoreCatalog in sources.js.
   *
   * @param {{sourceId: string}} columns
   * @returns {Promise<Map<string, number>>}
   */
  async sourceUsage(columns) {
    const { sourceId } = sourceColumns(columns);

    const { rows } = await this.pool.query(
      `SELECT l.fields ->> $1 AS source_id, count(*)::int AS leads
         FROM leads l
        WHERE coalesce(l.fields ->> $1, '') <> ''
        GROUP BY 1
        ORDER BY 2 DESC`,
      [sourceId]);

    return new Map(rows.map(row => [row.source_id, row.leads]));
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

  /** @param {string} sourceId */
  async deleteSource(sourceId) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM sources WHERE source_id = $1', [sourceId]);

    return rowCount > 0;
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
