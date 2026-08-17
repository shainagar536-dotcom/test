/**
 * Surense CRM client: OAuth token plus the paginated lead search.
 *
 * Surense has no webhooks, so the automation polls: every run asks for the
 * leads whose statusDate moved since the previous run.
 */

/**
 * Fetches an access token, reusing the cached one until it is nearly expired.
 *
 * Tokens are valid for an hour and the automation runs hourly, so the cache
 * mostly matters for retries and manual runs within the same hour.
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
  var payload = {
    grant_type: 'client_credentials',
    client_id: secret_('SURENSE_CLIENT_ID'),
    client_secret: secret_('SURENSE_CLIENT_SECRET')
  };

  var response = UrlFetchApp.fetch(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
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
 * Returns every lead whose status changed after `since`, following pagination
 * to the end.
 *
 * @param {Date} since
 * @return {Array<Object>} raw lead objects as returned by the API
 */
function fetchLeadsChangedSince_(since) {
  var token = getAccessToken_();
  var sinceIso = Utilities.formatDate(
    since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");

  var leads = [];
  var startRow = 0;

  for (var page = 0; page < CONFIG.surense.maxPages; page++) {
    var body = {
      startRow: startRow,
      endRow: startRow + CONFIG.surense.pageSize,
      sorts: [{ field: 'statusDate', dir: 'asc' }],
      filters: [{
        field: 'statusDate',
        operator: 'greaterThan',
        value: sinceIso
      }]
    };

    var response = UrlFetchApp.fetch(
      CONFIG.surense.apiBase + '/leads/search', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });

    if (response.getResponseCode() !== 200) {
      throw new Error('Lead search failed (HTTP ' +
        response.getResponseCode() + '): ' + response.getContentText());
    }

    var parsed = JSON.parse(response.getContentText());
    var batch = parsed.rows || parsed.data || parsed.results || [];

    leads = leads.concat(batch);

    // Trust hasNextPage when the API sends it; otherwise a short page is the
    // end. Either way maxPages stops an unbounded loop.
    var hasNext = parsed.hasNextPage !== undefined
      ? parsed.hasNextPage
      : batch.length === CONFIG.surense.pageSize;

    if (!hasNext || !batch.length) {
      return leads;
    }

    startRow += CONFIG.surense.pageSize;
  }

  logWarn_('Pagination stopped at the ' + CONFIG.surense.maxPages +
    '-page cap; some leads may not have been read.', { collected: leads.length });

  return leads;
}

/**
 * Pulls the fields the automation needs out of a raw lead, using the names in
 * CONFIG.leadFields so a naming mismatch is a config fix, not a code change.
 *
 * @param {Object} raw
 * @return {{id: string, displayId: string, clientName: string,
 *           statusName: string, statusDate: string, sourceName: string}}
 */
function normalizeLead_(raw) {
  var f = CONFIG.leadFields;

  var pick = function (name, fallbacks) {
    if (raw[name] !== undefined && raw[name] !== null && raw[name] !== '') {
      return raw[name];
    }

    for (var i = 0; i < fallbacks.length; i++) {
      var value = raw[fallbacks[i]];
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
