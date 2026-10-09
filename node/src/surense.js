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
  constructor(message, { status = 0, body = '', hint = '', retryAfter = null } = {}) {
    super(message);
    this.name = 'SurenseError';
    this.status = status;
    this.body = body;
    this.hint = hint;
    this.retryAfter = retryAfter;
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

/**
 * Whether a failure is about the CRM rather than about the row we asked for.
 *
 * The distinction decides whether retrying is worth anything. "This lead id
 * is unknown" is about one event and another attempt may answer differently.
 * "The token endpoint is refusing us" is about every event equally, and
 * trying the next twenty-four is not a retry — it is the same request twenty-
 * four more times, against a service that has just said it is receiving too
 * many.
 *
 * @param {?Error} error
 * @returns {boolean}
 */
/** How long a refused key is left alone. Long enough not to earn a 429. */
const CREDENTIAL_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * How long to stand down from a 429 that names no Retry-After.
 *
 * The header is advisory and this endpoint does not always send it. Writing
 * nothing in that case looked harmless and was not: the cool-off is what
 * stops the next caller asking, so without it every run went straight back
 * to the token endpoint and renewed the rolling window it was waiting out.
 * A rate limit with no stated deadline is still a rate limit.
 */
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/** Nothing the CRM asks for is honoured beyond this. */
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

export function isOutage(error) {
  if (!error) return false;

  const status = Number(error.status ?? 0);

  // 429 and 5xx are the service saying so itself. 401/403 mean the
  // credentials are wrong, which no amount of retrying per-event will fix.
  if (status === 429 || status === 408 || status >= 500) return true;
  if (status === 401 || status === 403) return true;

  // fetchLeadById joins its attempts' messages into one error and loses the
  // status, so the text is the only thing left to read.
  return /No API base answered|Token request failed|token response|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out/i
    .test(String(error.message ?? ''));
}

/**
 * Whether the CRM refused this particular record on permission grounds.
 *
 * Distinct from every other refusal because it is final. The CRM answers
 * HTTP 400 with code 40000 and "אינך מורשה לצפות או לבצע פעולות על לקוח זה" —
 * this key's user may not see this customer. No retry changes that; only a
 * permission granted inside Surense does. Reading it as an ordinary failure
 * is what had a hundred events asking the same forbidden question every hour.
 *
 * @param {?Error} error
 * @returns {boolean}
 */
export function isForbiddenRecord(error) {
  if (!error) return false;
  if (Number(error.status ?? 0) !== 400) return false;

  const text = String(error.body ?? '');

  // The CRM's own code, and its wording in case the code ever moves. Matched
  // on the Hebrew because that is what it actually sends.
  return /"code"\s*:\s*40000/.test(text) ||
    /אינך מורשה/.test(text) ||
    /not authori[sz]ed|unauthorized|no permission/i.test(text);
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
    pageSize = 50, maxPages = 400, fetchImpl = globalThis.fetch,

    // The shared record of a "retry later" the CRM has already given us.
    // Shared because a client is built per request: a deadline kept in this
    // object would bind only the caller who was told, and the next request a
    // second later would ask again — which is exactly how a half-hour cool-
    // off was kept alive for eight days.
    cooldown = null
  }) {
    Object.assign(this, {
      clientId, clientSecret, tokenUrl, apiBases, pageSize, maxPages
    });

    this.fetch = fetchImpl;
    this.cooldown = cooldown;
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

    // The CRM has already said when to come back. Asking before then is not
    // a retry — it is the request it asked us not to make, and on a rolling
    // window it pushes the deadline out again. So this fails without a call.
    const until = await this.cooldown?.read?.();

    if (until && new Date(until) > new Date()) {
      const seconds = Math.ceil((new Date(until) - Date.now()) / 1000);

      throw new SurenseError(
        `Token request failed (HTTP 429) — waiting ${seconds}s as the CRM asked`,
        { status: 429, retryAfter: seconds, hint: 'rate limited — the cool-off is being honoured' });
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
      // Retry-After is the service telling us exactly how long it wants to be
      // left alone. Worth carrying: without it, "rate limited" is indistinct
      // from "blocked", and the two call for opposite responses — waiting, or
      // asking somebody.
      const retryAfter = response.headers?.get?.('retry-after') ?? null;

      // What the service says it is, which is not always what the status
      // code says. This endpoint has answered 401 while throttling — and a
      // 401 is read here as a dead key, which is the one diagnosis that
      // sends somebody to replace a credential that was never the problem.
      // So the body decides when the two disagree.
      const throttled =
        /too_many_requests|too many requests|rate.?limit|slow.?down/i.test(body);

      // Written down so every later caller honours it too, not only this one.
      //
      // Any 429, with or without a deadline attached. Honouring only the
      // ones that named a Retry-After left the rest with no cool-off at all,
      // so the next run asked again and the window never closed — which is
      // how a rate limit outlives the thing that caused it.
      if (response.status === 429 || throttled) {
        const asked = Number(retryAfter) > 0
          ? Number(retryAfter) * 1000 : RATE_LIMIT_COOLDOWN_MS;

        const until = new Date(Date.now() + Math.min(asked, MAX_COOLDOWN_MS));
        await this.cooldown?.write?.(until);

        // Reported as what it is, whatever status it arrived under. A wait
        // and a revoked key need opposite responses from a person, and
        // telling them to go and make a new key is not a harmless guess: it
        // is work, on the wrong thing, during an outage.
        throw new SurenseError(
          `Token request failed (HTTP ${response.status}) — the CRM is rate limiting us`,
          { status: 429, body, retryAfter, hint: hintFor(429) });
      }

      // Rejected credentials are the one failure that retrying cannot mend,
      // and retrying them is what earns the rate limit that then hides them.
      // That is the whole shape of this outage: a 401 nobody could see,
      // behind a 429 our own retries kept alive. So a refused key buys the
      // same silence a 429 does — long enough that the hourly run cannot
      // turn a fixable mistake back into an invisible one.
      if (response.status === 401 || response.status === 403) {
        await this.cooldown?.write?.(new Date(Date.now() + CREDENTIAL_COOLDOWN_MS));

        throw new SurenseError(
          `Credentials rejected (HTTP ${response.status}) — ` +
          'check SURENSE_CLIENT_ID and SURENSE_CLIENT_SECRET',
          { status: response.status, body, hint: 'the key itself is the problem; retrying will not help' });
      }

      throw new SurenseError(`Token request failed (HTTP ${response.status})`, {
        status: response.status, body, retryAfter, hint: hintFor(response.status)
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

    // Through: whatever deadline was standing no longer applies.
    await this.cooldown?.write?.(null);

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
   * The custom fields, by the name a person knows them by.
   *
   * A lead's Hebrew columns — "סך הכל" among them — do not appear on the row
   * as named fields at all. The row carries {fieldId, value}, and the name
   * lives only in the field schema. So a setting like TOTAL_COLUMN can only
   * be written in a UUID nobody can read, unless something joins the two.
   *
   * Cached for the life of the client: the schema is the same for every lead
   * in a run, and re-reading it per event would turn one request into
   * hundreds.
   *
   * @returns {Promise<Map<string, string>>}  label -> field id
   */
  async customFieldIds() {
    if (this.customFieldIdCache) return this.customFieldIdCache;

    const byLabel = new Map();

    for (const field of await this.fetchFieldsRaw()) {
      const id = field?.id ?? field?.fieldId;
      const label = String(field?.label ?? field?.title ??
        field?.displayName ?? '').trim();

      // First definition wins. Labels are not guaranteed unique — the schema
      // has more than one field labelled "#" — and a later one overwriting an
      // earlier is how a setting silently starts reading the wrong column.
      if (id && label && !byLabel.has(label)) byLabel.set(label, String(id));
    }

    this.customFieldIdCache = byLabel;
    return byLabel;
  }

  /**
   * The referring-source catalog: every source, by id and name.
   *
   * `/customers/sources` is the path that actually serves this — confirmed
   * against the live CRM, not guessed. The name arrives under `title`, not
   * `name`: looking for `name` returns a row with no name at all and the
   * mapping silently stays empty, which is exactly the trap this comment
   * exists to stop the next reader falling into.
   *
   * One call returns all of them, so a lead's source costs no request of its
   * own — the catalog is fetched once and cached in the `sources` table.
   *
   * @param {string} [path]
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async fetchSourceCatalog(path = '/customers/sources') {
    await this.resolveBase();

    return extractRows(await this.request('GET', path))
      .map(row => {
        const id = row?.id ?? row?.sourceId ?? row?.value;
        const name = row?.title ?? row?.name ?? row?.label ?? row?.sourceName;

        return id && name ? { id: String(id), name: String(name) } : null;
      })
      .filter(Boolean);
  }

  /**
   * One lead, by its id.
   *
   * A webhook carries the status change but not the referring source, so the
   * lead has to be read back for its `sourceId`. Which call does that is not
   * documented, so each candidate is tried once and the one that answers is
   * remembered — every later lookup then costs a single request.
   *
   * @param {string} leadId
   * @returns {Promise<?object>}
   */
  async fetchLeadById(leadId) {
    await this.resolveBase();

    const attempts = this.leadLookup
      ? [this.leadLookup]
      : [
        // A filtered search: the CRM confirmed filters work, and this is one
        // request rather than paging the whole table.
        { kind: 'search', field: 'id' },
        { kind: 'get', path: `/leads/${encodeURIComponent(leadId)}` }
      ];

    const failures = [];

    // Kept so the joined error can still say what the CRM answered. Without
    // this the status was lost: both attempts could come back 503 and the
    // single error thrown below carried none, so a CRM that was refusing
    // everyone read as one lead that could not be read — and every remaining
    // event in the batch went on to ask the same failing service again.
    let worst = 0;
    const bodies = [];

    for (const attempt of attempts) {
      try {
        const lead = attempt.kind === 'get'
          ? await this.request('GET', `/leads/${encodeURIComponent(leadId)}`)
          : extractRows(await this.request('POST', '/leads/search', {
            startRow: 0,
            endRow: 1,
            filters: [{ field: attempt.field, operator: 'equals', value: leadId }]
          }))[0];

        // A call that answers 200 with the wrong lead — or none — is not a
        // working lookup, and remembering it would break every later one.
        const found = lead?.fields ?? lead;
        if (!found || (found.id && String(found.id) !== String(leadId))) {
          failures.push(`${attempt.kind}: no matching lead returned`);
          continue;
        }

        this.leadLookup = attempt;
        return found;
      } catch (error) {
        failures.push(`${attempt.kind}: ${error.message}`);
        if (error.body) bodies.push(String(error.body));

        // A refusal that is about the service outranks one about this lead:
        // 503 beats 400, however the attempts happened to be ordered.
        const status = Number(error.status ?? 0);
        if (status === 429 || status === 408 || status === 401 ||
            status === 403 || status >= 500) worst = status;
        else if (!worst) worst = status;
      }
    }

    throw new SurenseError(
      `Could not read lead ${leadId}.\n  ${failures.join('\n  ')}`,
      {
        status: worst || undefined,
        // What the CRM said, not only that it said no. A 400 meaning "you may
        // not see this record" is final where every other 400 is not, and the
        // joined message alone cannot carry that.
        body: bodies.join('\n').slice(0, 500),
        hint: 'Check that this client may read a single lead.'
      });
  }

  /**
   * One customer, by its id.
   *
   * The second route to the referring source, and the reason the webhook's
   * `customerId` is stored. A lead that the CRM will not return — deleted,
   * merged, or outside what this client may read — answers HTTP 400 on every
   * attempt, and the event behind it can never learn who to tell. The
   * customer record carries both `sourceId` and `sourceName`, so it answers
   * the question outright and needs no catalog.
   *
   * Used only as a fallback: the lead is the better answer when it exists,
   * because it also carries the assignee and the amount.
   *
   * @param {string} customerId
   * @returns {Promise<?object>}
   */
  async fetchCustomerById(customerId) {
    await this.resolveBase();

    const customer = await this.request(
      'GET', `/customers/${encodeURIComponent(customerId)}`);

    // Same shape question as the leads: some calls wrap the record, and a
    // reply about a different customer is not an answer. Both wrappers are
    // unwrapped — `/customers/{id}` has been seen to use `data`.
    const found = customer?.fields ?? customer?.data ?? customer;
    if (!found || (found.id && String(found.id) !== String(customerId))) {
      throw new SurenseError(
        `Customer ${customerId} was not returned by the CRM`,
        { hint: 'Check that this client may read a single customer.' });
    }

    return found;
  }

  /**
   * The customer's other leads — the ones this key is allowed to see.
   *
   * A returning customer has history: an earlier lead, usually owned by
   * whoever first brought them in. When the CRM refuses the lead that just
   * moved, those siblings are still readable, and they carry the same
   * `sourceId` — because the referring source is a fact about the customer,
   * not about which lead happened to be opened this year.
   *
   * A filtered search is exactly the right call for this: it returns only
   * what this key may see, so the refusal that blocks the one lead does not
   * block the question.
   *
   * @param {string} customerId
   * @param {number} [limit]
   * @returns {Promise<Array<object>>}
   */
  async fetchLeadsByCustomer(customerId, limit = 20) {
    await this.resolveBase();

    const rows = extractRows(await this.request('POST', '/leads/search', {
      startRow: 0,
      endRow: limit,
      filters: [{ field: 'customerId', operator: 'equals', value: customerId }]
    }));

    return rows.map(row => row?.fields ?? row).filter(Boolean);
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
/**
 * Who the token says it is.
 *
 * The question a refusal raises first: a key created under one user carries
 * that user's permissions, and the CRM's own screen does not say which user
 * a key belongs to. If the key is not the owner's, "the owner can see
 * everything" is simply about somebody else.
 *
 * Identity claims only, never the token and never the secret. The names vary
 * by issuer, so every plausible spelling is read and whatever is present is
 * reported.
 *
 * @param {string} token
 * @returns {?object}
 */
export function tokenIdentity(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;

    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'));

    const wanted = [
      'sub', 'userId', 'user_id', 'uid', 'nameid', 'name', 'userName',
      'user_name', 'given_name', 'email', 'upn', 'role', 'roles',
      'tenantId', 'tenant_id', 'agencyId', 'agency_id', 'client_id', 'azp'
    ];

    const found = {};
    for (const key of Object.keys(claims)) {
      // Claim names are often namespaced URLs ending in the plain name.
      const plain = key.split('/').pop();
      if (wanted.includes(key) || wanted.includes(plain)) {
        found[plain] = claims[key];
      }
    }

    // Every claim name present, so a user id hiding under an unexpected one
    // is visible rather than silently dropped.
    found.allClaimNames = Object.keys(claims);

    return found;
  } catch {
    return null;
  }
}

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
