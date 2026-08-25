/**
 * Surense CRM client: OAuth token, the paginated lead search, and the
 * field-schema lookup.
 *
 * Surense has no webhooks, so everything here is pull-based.
 */

/**
 * Fetches an access token, reusing the cached one until it is nearly expired.
 *
 * @return {string}
 */
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('surense_token');

  if (cached) {
    return cached;
  }

  // The token endpoint rejects JSON — it requires form encoding.
  var response = UrlFetchApp.fetch(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: secret_('SURENSE_CLIENT_ID'),
      client_secret: secret_('SURENSE_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Surense token request failed (HTTP ' +
      response.getResponseCode() + '): ' + response.getContentText());
  }

  var body = JSON.parse(response.getContentText());

  if (!body.access_token) {
    throw new Error('Surense token response contained no access_token.');
  }

  // Expire the cache a minute early so a run never uses a token mid-expiry.
  var ttl = Math.max(60, Math.min(3300, (body.expires_in || 3600) - 60));
  cache.put('surense_token', body.access_token, ttl);

  return body.access_token;
}

/**
 * Makes an authenticated API call and returns the parsed body.
 *
 * @param {string} method  'get' or 'post'
 * @param {string} path    Path below the API base, e.g. '/leads/search'
 * @param {Object=} body   JSON payload, for POST
 * @return {Object}
 */
function surenseRequest_(method, path, body) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getAccessToken_() },
    muteHttpExceptions: true
  };

  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  var response = UrlFetchApp.fetch(CONFIG.surense.apiBase + path, options);
  var code = response.getResponseCode();

  if (code !== 200) {
    throw new Error(method.toUpperCase() + ' ' + path + ' failed (HTTP ' +
      code + '): ' + response.getContentText().slice(0, 500));
  }

  return JSON.parse(response.getContentText());
}

/**
 * Pulls the rows array out of a search response.
 *
 * The exact envelope key has not been confirmed against a live response, so
 * the common shapes are all accepted. previewApi() reports which one is real.
 *
 * @param {Object} parsed
 * @return {Array<Object>}
 */
function extractRows_(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  return parsed.rows || parsed.data || parsed.results || parsed.items ||
    parsed.leads || [];
}

/**
 * Runs a paginated lead search, following pages to the end.
 *
 * @param {Array<Object>} filters   Search filters, possibly empty.
 * @param {Object=} options         {deadline: Date, onPage: function}
 * @return {{leads: Array<Object>, complete: boolean}}
 */
function searchLeads_(filters, options) {
  options = options || {};

  var leads = [];
  var startRow = 0;

  for (var page = 0; page < CONFIG.surense.maxPages; page++) {
    if (options.deadline && new Date() > options.deadline) {
      logWarn_('Stopped paginating at the time budget.', {
        pagesRead: page, leadsSoFar: leads.length
      });
      return { leads: leads, complete: false };
    }

    var parsed = surenseRequest_('post', '/leads/search', {
      startRow: startRow,
      endRow: startRow + CONFIG.surense.pageSize,
      sorts: [{ field: 'statusDate', dir: 'asc' }],
      filters: filters || []
    });

    var batch = extractRows_(parsed);
    leads = leads.concat(batch);

    if (options.onPage) {
      options.onPage(leads.length);
    }

    // Trust hasNextPage when the API sends it; otherwise a short page is the
    // end. Either way maxPages stops an unbounded loop.
    var hasNext = parsed.hasNextPage !== undefined
      ? parsed.hasNextPage
      : batch.length === CONFIG.surense.pageSize;

    if (!hasNext || !batch.length) {
      return { leads: leads, complete: true };
    }

    startRow += CONFIG.surense.pageSize;
  }

  logWarn_('Pagination hit the ' + CONFIG.surense.maxPages + '-page cap.',
    { collected: leads.length });

  return { leads: leads, complete: false };
}

/**
 * Every lead whose status changed after `since`. Used by the notifier.
 *
 * @param {Date} since
 * @return {Array<Object>}
 */
function fetchLeadsChangedSince_(since) {
  return searchLeads_([{
    field: 'statusDate',
    operator: 'greaterThan',
    value: Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'")
  }]).leads;
}

/**
 * Every lead in the CRM. Used by the mirror.
 *
 * @param {Object=} options  {deadline: Date, onPage: function}
 * @return {{leads: Array<Object>, complete: boolean}}
 */
function fetchAllLeads_(options) {
  return searchLeads_([], options);
}

/**
 * The CRM's field definitions, including custom fields.
 *
 * Reading the schema from the CRM rather than hardcoding column names means
 * a field added in Surense shows up in the mirror without a code change.
 *
 * @return {Array<{key: string, label: string}>}
 */
function fetchLeadFields_() {
  var parsed = surenseRequest_('get', '/leads/fields');
  var raw = extractRows_(parsed).length ? extractRows_(parsed) : (parsed.fields || []);

  return raw.map(function (field) {
    if (typeof field === 'string') {
      return { key: field, label: field };
    }

    var key = field.key || field.name || field.field || field.id;

    return {
      key: String(key),
      label: String(field.label || field.title || field.displayName || key)
    };
  }).filter(function (field) {
    return field.key && field.key !== 'undefined';
  });
}

/**
 * Pulls the fields the notifier needs out of a raw lead, using the names in
 * CONFIG.leadFields so a naming mismatch is a config fix, not a code change.
 *
 * @param {Object} raw
 * @return {Object}
 */
function normalizeLead_(raw) {
  var f = CONFIG.leadFields;

  var pick = function (name, fallbacks) {
    var candidates = [name].concat(fallbacks);

    for (var i = 0; i < candidates.length; i++) {
      var value = raw[candidates[i]];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }

    return '';
  };

  return {
    id: String(pick(f.id, ['leadId', 'uuid'])),
    displayId: String(pick(f.displayId, ['number', 'displayId', f.id])),
    clientName: String(pick(f.clientName, ['clientName', 'fullName', 'firstName'])),
    statusName: String(pick(f.statusName, ['status', 'statusTitle'])),
    statusDate: String(pick(f.statusDate, ['statusChangedAt', 'updatedAt'])),
    sourceName: String(pick(f.sourceName, ['source', 'sourceTitle', 'sourceId']))
  };
}
