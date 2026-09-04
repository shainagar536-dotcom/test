/**
 * Surense CRM client.
 *
 * Read-only by construction: the only requests made are the token grant, the
 * field schema and the lead search. There is no code path here that modifies
 * anything in the CRM.
 *
 * Uses the built-in fetch, so this file has no dependencies.
 */

/** Envelope keys seen in the wild; the first that holds an array wins. */
const ROW_KEYS = ['rows', 'data', 'results', 'items', 'leads', 'fields'];

export class SurenseError extends Error {
  constructor(message, { status = 0, body = '', hint = '' } = {}) {
    super(message);
    this.name = 'SurenseError';
    this.status = status;
    this.body = body;
    this.hint = hint;
  }
}

/** What a status code means for this API, so callers need not guess. */
function hintFor(status) {
  return {
    400: 'the request shape was rejected — check the filter or paging fields',
    401: 'credentials rejected — the client secret was probably rotated',
    403: 'authenticated, but this client lacks the scope for this endpoint',
    404: 'wrong path — check the API base URL',
    415: 'wrong content type — the token endpoint needs form encoding',
    429: 'rate limited — retry in a minute'
  }[status] ?? '';
}

export class SurenseClient {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {string} options.tokenUrl
   * @param {Array<string>} options.apiBases  Tried in order; first to answer wins.
   * @param {number} [options.pageSize]
   * @param {number} [options.maxPages]
   * @param {typeof fetch} [options.fetchImpl]  Injectable, for tests.
   */
  constructor({
    clientId, clientSecret, tokenUrl, apiBases,
    pageSize = 50, maxPages = 400, fetchImpl = globalThis.fetch
  }) {
    Object.assign(this, {
      clientId, clientSecret, tokenUrl, apiBases, pageSize, maxPages
    });

    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.base = null;
  }

  /**
   * Returns a valid access token, reusing the cached one until it is nearly
   * expired so a long paginated read never fails mid-way.
   *
   * @returns {Promise<{token: string, scope: string}>}
   */
  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return { token: this.token, scope: this.scope };
    }

    // This endpoint rejects JSON; it requires form encoding.
    const response = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      }).toString()
    });

    const body = await response.text();

    if (!response.ok) {
      throw new SurenseError(`Token request failed (HTTP ${response.status})`, {
        status: response.status, body, hint: hintFor(response.status)
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new SurenseError('The token response was not JSON.', { body });
    }

    if (!parsed.access_token) {
      throw new SurenseError('The token response contained no access_token.', { body });
    }

    this.token = parsed.access_token;
    this.scope = parsed.scope ?? '';
    // Expire a minute early so a request never goes out with a stale token.
    this.tokenExpiresAt = Date.now() + ((parsed.expires_in ?? 3600) - 60) * 1000;

    return { token: this.token, scope: this.scope };
  }

  /**
   * Finds which of the candidate hosts actually serves the API.
   *
   * The token's `aud` claim and the integration notes name different hosts,
   * and only a live call settles it.
   *
   * @returns {Promise<string>}
   */
  async resolveBase() {
    if (this.base) return this.base;

    const failures = [];

    for (const candidate of this.apiBases) {
      try {
        await this.request('GET', '/leads/fields', null, candidate);
        this.base = candidate;
        return candidate;
      } catch (error) {
        failures.push(`${candidate}: ${error.message}`);
      }
    }

    throw new SurenseError(
      `No API base answered.\n  ${failures.join('\n  ')}`,
      { hint: 'Confirm the API host with Surense.' });
  }

  /**
   * One authenticated call.
   *
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {object|null} [body]
   * @param {string} [base]
   * @returns {Promise<object>}
   */
  async request(method, path, body = null, base = null) {
    const { token } = await this.authenticate();
    const url = (base ?? this.base ?? this.apiBases[0]) + path;

    const response = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    const text = await response.text();

    if (!response.ok) {
      throw new SurenseError(`${method} ${path} failed (HTTP ${response.status})`, {
        status: response.status,
        body: text.slice(0, 500),
        hint: hintFor(response.status)
      });
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new SurenseError(`${method} ${path} did not return JSON.`, {
        body: text.slice(0, 300)
      });
    }
  }

  /**
   * The CRM's field definitions, including custom fields.
   *
   * Reading the schema rather than hardcoding column names means a field
   * added in Surense reaches the spreadsheet without a code change.
   *
   * @returns {Promise<Array<{key: string, label: string}>>}
   */
  async fetchFields() {
    return toLabelledFields(await this.fetchFieldsRaw());
  }

  /**
   * The field definitions exactly as the CRM sends them.
   *
   * fetchFields reduces every entry to {key, label} and throws the rest away.
   * That is all the mirror needs, but it also discards any option list a
   * picklist field carries — and the source field's option list is precisely
   * the id -> name mapping that is missing everywhere else. Keeping the raw
   * form costs nothing: it is the same single request either way.
   *
   * @returns {Promise<Array<object>>}
   */
  async fetchFieldsRaw() {
    await this.resolveBase();

    return extractRows(await this.request('GET', '/leads/fields'));
  }

  /**
   * Looks for a lookup that lists the referring sources by id and name.
   *
   * Which path serves it is genuinely unknown — it is not in the integration
   * notes and the leads do not hint at it — so rather than hardcode a guess,
   * every candidate is tried and the caller scores what came back against the
   * ids the leads actually carry. A catalog that explains 3 sources out of
   * 161 is the wrong one whatever its shape; one that explains 158 is right
   * even if it turned up at an unexpected path.
   *
   * Every candidate is a GET. Nothing here writes.
   *
   * @param {Array<string>} paths
   * @returns {Promise<Array<{path: string, ok: boolean, payload: ?object,
   *                          status: number, error: string}>>}
   */
  async probeSourceCatalogs(paths) {
    await this.resolveBase();

    const attempts = [];

    for (const path of paths) {
      try {
        const payload = await this.request('GET', path);
        attempts.push({ path, ok: true, payload, status: 200, error: '' });
      } catch (error) {
        attempts.push({
          path,
          ok: false,
          payload: null,
          status: error.status ?? 0,
          error: error.message
        });
      }
    }

    return attempts;
  }

  /**
   * Every lead, following pagination to the end.
   *
   * Reports whether the read completed: a caller must never treat a truncated
   * read as the whole CRM, or every unread lead looks deleted.
   *
   * @param {object} [options]
   * @param {(count: number) => void} [options.onProgress]
   * @param {Array<object>} [options.filters]
   * @returns {Promise<{leads: Array<object>, complete: boolean}>}
   */
  async fetchAllLeads({ onProgress, filters = [] } = {}) {
    await this.resolveBase();

    const leads = [];
    let startRow = 0;

    for (let page = 0; page < this.maxPages; page++) {
      const parsed = await this.request('POST', '/leads/search', {
        startRow,
        endRow: startRow + this.pageSize,
        sorts: [{ field: 'statusDate', dir: 'asc' }],
        filters
      });

      const batch = extractRows(parsed);
      leads.push(...batch);
      onProgress?.(leads.length);

      // Trust hasNextPage when sent; otherwise a short page is the end.
      const hasNext = parsed.hasNextPage !== undefined
        ? Boolean(parsed.hasNextPage)
        : batch.length === this.pageSize;

      if (!hasNext) return { leads, complete: true };

      // The server says there is more but sent nothing. That contradiction
      // cannot be resolved by asking again, and reporting it as a complete
      // read would let a partial pull be applied as the whole CRM — every
      // lead not returned would look deleted.
      if (batch.length === 0) return { leads, complete: false };

      startRow += this.pageSize;
    }

    return { leads, complete: false };
  }
}

/**
 * Reduces raw schema entries to the {key, label} pairs the mirror wants.
 *
 * Separate from the fetch so that a caller which needs the raw entries — the
 * source field's option list lives there — can have both from one request.
 *
 * @param {Array<object|string>} rows
 * @returns {Array<{key: string, label: string}>}
 */
export function toLabelledFields(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(field => {
      if (typeof field === 'string') return { key: field, label: field };
      if (!field || typeof field !== 'object') return null;

      const key = field.key ?? field.name ?? field.field ?? field.id;
      if (!key) return null;

      return {
        key: String(key),
        label: String(field.label ?? field.title ?? field.displayName ?? key)
      };
    })
    .filter(Boolean);
}

/**
 * Pulls the array out of whatever envelope the API wraps it in.
 *
 * @param {unknown} parsed
 * @returns {Array<object>}
 */
export function extractRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];

  for (const key of ROW_KEYS) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }

  return [];
}

/**
 * Reads the scope claim out of a JWT, when the token is one.
 *
 * Knowing what was actually granted separates "this call is malformed" from
 * "this client was never allowed to make it".
 *
 * @param {string} token
 * @returns {?string}
 */
export function tokenScopes(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;

    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'));

    const scope = claims.scope ?? claims.scopes ?? claims.scp;
    if (!scope) return null;

    return Array.isArray(scope) ? scope.join(', ') : String(scope);
  } catch {
    return null;
  }
}
