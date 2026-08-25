/**
 * Step-by-step diagnosis of the Surense connection.
 *
 * Run this from the Apps Script editor when something is not working. It
 * never throws: every step reports its own HTTP status and, on failure, the
 * server's own words plus the causes worth checking. That is what turns
 * "the API doesn't work" into a specific, fixable finding.
 *
 * Credentials are never printed.
 */
function diagnoseApi() {
  var report = [];
  var add = function (line) {
    report.push(line);
  };

  add('=== Surense API diagnosis ===');
  add('token endpoint : ' + CONFIG.surense.tokenUrl);
  add('api base       : ' + CONFIG.surense.apiBase);
  add('');

  // --- 1. are the credentials even present? -------------------------------
  var clientId = secret_('SURENSE_CLIENT_ID', false);
  var clientSecret = secret_('SURENSE_CLIENT_SECRET', false);

  add('1. Script properties');
  add('   SURENSE_CLIENT_ID     : ' +
    (clientId ? 'set (' + clientId.slice(0, 8) + '...)' : 'MISSING'));
  add('   SURENSE_CLIENT_SECRET : ' +
    (clientSecret ? 'set (' + clientSecret.length + ' chars)' : 'MISSING'));

  if (!clientId || !clientSecret) {
    add('');
    add('   Stop here. Add the missing property under');
    add('   Project Settings -> Script Properties, then run this again.');
    return finish_(report);
  }

  // --- 2. token -----------------------------------------------------------
  add('');
  add('2. POST ' + CONFIG.surense.tokenUrl);

  var tokenResponse = tryFetch_(CONFIG.surense.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    },
    muteHttpExceptions: true
  });

  if (tokenResponse.error) {
    add('   NETWORK ERROR: ' + tokenResponse.error);
    add('   The request never reached Surense. Check the endpoint hostname.');
    return finish_(report);
  }

  add('   HTTP ' + tokenResponse.code);

  if (tokenResponse.code !== 200) {
    add('   Response: ' + tokenResponse.body.slice(0, 400));
    add('');
    add('   Worth checking, in order:');
    add('   - The secret was rotated in Surense but not updated here.');
    add('   - The secret was copied with a trailing space or line break.');
    add('   - The client was disabled, or its grant is not client_credentials.');
    add('   - 415 or "unsupported content type" means the request went as');
    add('     JSON; this code sends form encoding, which is what Surense wants.');
    return finish_(report);
  }

  var token;

  try {
    var parsed = JSON.parse(tokenResponse.body);
    token = parsed.access_token;

    add('   token received : ' + (token ? 'yes' : 'NO — no access_token key'));
    add('   expires_in     : ' + (parsed.expires_in || 'not reported'));

    var scopes = tokenScopes_(token);

    if (scopes) {
      add('   scopes granted : ' + scopes);
      add('');
      add('   The mirror needs leads:read. Writing back to the CRM would need');
      add('   leads:update — this code never calls it.');
    }
  } catch (err) {
    add('   Could not parse the token response: ' + err.message);
    return finish_(report);
  }

  if (!token) {
    return finish_(report);
  }

  // --- 3. field schema ----------------------------------------------------
  add('');
  add('3. GET ' + CONFIG.surense.apiBase + '/leads/fields');

  var fieldsResponse = tryFetch_(CONFIG.surense.apiBase + '/leads/fields', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  describeResponse_(add, fieldsResponse);

  if (fieldsResponse.code === 200) {
    try {
      var fields = fetchLeadFields_();
      add('   fields parsed  : ' + fields.length);
      add('   first few      : ' + fields.slice(0, 15).map(function (field) {
        return field.key;
      }).join(', '));

      if (!fields.length) {
        add('   The endpoint answered but no field could be parsed — the');
        add('   response shape differs from what is expected. Paste the raw');
        add('   body below and the parser can be adjusted.');
        add('   Raw: ' + fieldsResponse.body.slice(0, 600));
      }
    } catch (err) {
      add('   Parsing failed: ' + err.message);
    }
  }

  // --- 4. lead search -----------------------------------------------------
  add('');
  add('4. POST ' + CONFIG.surense.apiBase + '/leads/search');

  var searchResponse = tryFetch_(CONFIG.surense.apiBase + '/leads/search', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ startRow: 0, endRow: 1, filters: [] }),
    muteHttpExceptions: true
  });

  describeResponse_(add, searchResponse);

  if (searchResponse.code === 200) {
    try {
      var body = JSON.parse(searchResponse.body);
      var rows = extractRows_(body);

      add('   envelope keys  : ' + Object.keys(body).join(', '));
      add('   rows returned  : ' + rows.length);

      if (rows.length) {
        add('   lead keys      : ' + Object.keys(rows[0]).join(', '));
        add('');
        add('   Compare those keys against CONFIG.leadFields:');

        Object.keys(CONFIG.leadFields).forEach(function (name) {
          var key = CONFIG.leadFields[name];
          var present = rows[0][key] !== undefined;
          add('     ' + name + ' -> "' + key + '" : ' +
            (present ? 'found' : 'NOT FOUND in the response'));
        });

        add('');
        add('   Any "NOT FOUND" above is a CONFIG.leadFields fix, not a bug.');
      } else {
        add('   The search returned no rows. If the CRM has leads, the filter');
        add('   or the envelope key differs — paste the raw body:');
        add('   Raw: ' + searchResponse.body.slice(0, 600));
      }
    } catch (err) {
      add('   Could not parse the search response: ' + err.message);
    }
  }

  return finish_(report);
}

/**
 * Fetches without throwing, so one failing step cannot end the diagnosis.
 *
 * @param {string} url
 * @param {Object} options
 * @return {{code: number, body: string, error: ?string}}
 */
function tryFetch_(url, options) {
  try {
    var response = UrlFetchApp.fetch(url, options);

    return {
      code: response.getResponseCode(),
      body: response.getContentText(),
      error: null
    };
  } catch (err) {
    return { code: 0, body: '', error: err.message };
  }
}

/**
 * @param {function(string)} add
 * @param {{code: number, body: string, error: ?string}} response
 */
function describeResponse_(add, response) {
  if (response.error) {
    add('   NETWORK ERROR: ' + response.error);
    return;
  }

  add('   HTTP ' + response.code);

  if (response.code === 401) {
    add('   Unauthorized — the token was rejected. Usually a rotated secret.');
  } else if (response.code === 403) {
    add('   Forbidden — authenticated, but this client lacks the scope for');
    add('   this endpoint. Check the scopes listed in step 2.');
  } else if (response.code === 404) {
    add('   Not found — the path is wrong. Check CONFIG.surense.apiBase.');
  } else if (response.code === 429) {
    add('   Rate limited — too many requests. Retry in a minute.');
  } else if (response.code !== 200) {
    add('   Response: ' + response.body.slice(0, 400));
  }
}

/**
 * Reads the scope claim out of a JWT access token, when it is one.
 *
 * Knowing which scopes were actually granted separates "the call is wrong"
 * from "this client was never allowed to make it".
 *
 * @param {string} token
 * @return {?string}
 */
function tokenScopes_(token) {
  try {
    var parts = String(token).split('.');

    if (parts.length !== 3) {
      return null;   // an opaque token, not a JWT
    }

    var payload = JSON.parse(Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])).getDataAsString());

    var scope = payload.scope || payload.scopes || payload.scp;

    if (!scope) {
      return null;
    }

    return Array.isArray(scope) ? scope.join(', ') : String(scope);
  } catch (err) {
    return null;
  }
}

/**
 * @param {Array<string>} report
 * @return {string}
 */
function finish_(report) {
  var text = report.join('\n');

  console.log(text);
  logInfo_('diagnoseApi', { report: text.slice(0, 8000) });

  return text;
}
