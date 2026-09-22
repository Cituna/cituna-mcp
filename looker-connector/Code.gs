/**
 * Cituna - Looker Studio community connector
 * =================================================
 * A thin, credential-free bridge from Looker Studio (Data Studio) to the
 * Cituna backend. It authenticates with the SAME personal API key the
 * MCP server uses (a cituna_sk_... key the user pastes once), calls the read-only
 * reporting endpoint GET /api/integrations/looker/data, and maps the flat rows
 * it returns onto Looker dimensions and metrics.
 *
 * NOTHING SENSITIVE LIVES IN THIS SCRIPT. No secret is hardcoded. The user's key
 * is supplied through Looker's KEY auth flow and stored per-user in
 * PropertiesService (UserProperties), never in source. The backend holds the
 * database and any Google OAuth tokens; this connector only ever sends the key
 * as a Bearer token over HTTPS and shapes the JSON it gets back.
 *
 * Contract (Looker community connector API):
 *   getAuthType, setCredentials, isAuthValid, resetAuth  -> KEY auth lifecycle
 *   getConfig, getSchema, getData                        -> the data source
 *   isAdminUser                                          -> debug gate
 */

var cc = DataStudioApp.createCommunityConnector();

// Default backend. Only overridden by the optional "Backend URL" config field
// (for a self-hosted Cituna). Never contains a secret.
var DEFAULT_API_URL = 'https://cituna.com';

// Where the user's pasted key is stored, per-user, by Looker's KEY auth flow.
var KEY_PROPERTY = 'dscc.key';

// The AI engines the report pivots into per-engine columns. Kept in sync with
// the backend's LOOKER_ENGINES and the field ids below. NOTE: this connector is
// a separate Apps Script deployment — adding an engine here only reaches Looker
// after the connector is re-deployed (until then the backend's extra columns are
// simply ignored by Looker, which maps rows by declared field id).
var ENGINES = [
  ['chatgpt', 'ChatGPT'],
  ['perplexity', 'Perplexity'],
  ['gemini', 'Gemini'],
  ['claude', 'Claude'],
  ['grok', 'Grok'],
  ['aioverviews', 'AI Overviews'],
  ['aimode', 'AI Mode']
];

// ---------------------------------------------------------------------------
// Auth (KEY) - the user pastes a Cituna API key (cituna_sk_...)
// ---------------------------------------------------------------------------

function getAuthType() {
  return cc.newAuthTypeResponse()
    .setAuthType(cc.AuthType.KEY)
    .setHelpUrl('https://github.com/rarora2026-gif/visibility-os-app/tree/main/looker-connector#get-your-api-key')
    .build();
}

function resetAuth() {
  PropertiesService.getUserProperties().deleteProperty(KEY_PROPERTY);
}

function isAuthValid() {
  var key = PropertiesService.getUserProperties().getProperty(KEY_PROPERTY);
  return validateKey(key, DEFAULT_API_URL);
}

function setCredentials(request) {
  var key = request.key;
  if (!validateKey(key, DEFAULT_API_URL)) {
    return { errorCode: 'INVALID_CREDENTIALS' };
  }
  PropertiesService.getUserProperties().setProperty(KEY_PROPERTY, key);
  return { errorCode: 'NONE' };
}

/**
 * Best-effort key check. Rejects an obviously-wrong key (wrong prefix) and a key
 * the backend authenticates as nobody (GET /api/auth/me returns { user: null }).
 * On any network error or non-200 (backend down, or a self-hosted backend that
 * this default URL cannot reach) it returns true rather than block setup - a
 * genuinely bad key still surfaces a clear error on the first data pull.
 */
function validateKey(key, apiUrl) {
  if (!key || String(key).indexOf('cituna_sk_') !== 0) return false;
  try {
    var resp = UrlFetchApp.fetch(normalizeUrl(apiUrl) + '/api/auth/me', {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + key },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return true; // ambiguous, do not block
    var body = JSON.parse(resp.getContentText());
    return !!(body && body.user);
  } catch (e) {
    return true; // cannot reach backend to disprove; let getData report real errors
  }
}

// Debug gate. Keep false in production so end users see clean user errors rather
// than stack traces / debug text.
function isAdminUser() {
  return false;
}

// ---------------------------------------------------------------------------
// Config - an optional single-domain filter and an optional backend override
// ---------------------------------------------------------------------------

function getConfig(request) {
  var config = cc.getConfig();

  config.newInfo()
    .setId('instructions')
    .setText(
      'Reports on your Cituna AI-visibility scans. Paste your API key when ' +
      'prompted (generate one in the app under Integrations, "Claude / MCP access"). ' +
      'Optionally filter to a single brand below, then pick a date range in Looker Studio.'
    );

  config.newTextInput()
    .setId('domain')
    .setName('Domain filter (optional)')
    .setHelpText('Limit the report to one brand, e.g. example.com. Leave blank to include every brand in your workspace.')
    .setPlaceholder('example.com')
    .setAllowOverride(true);

  config.newTextInput()
    .setId('apiUrl')
    .setName('Backend URL (optional)')
    .setHelpText('Only change this if you run a self-hosted Cituna backend. Default: https://cituna.com')
    .setPlaceholder(DEFAULT_API_URL)
    .setAllowOverride(true);

  // Sends request.dateRange (startDate / endDate) to getData so the report can
  // be scoped to any period the viewer picks.
  config.setDateRangeRequired(true);

  return config.build();
}

// ---------------------------------------------------------------------------
// Schema - dimensions + metrics. Field ids match the backend's row keys 1:1, so
// getData can map values by id with no translation table.
// ---------------------------------------------------------------------------

function getFields() {
  var fields = cc.getFields();
  var types = cc.FieldType;
  var agg = cc.AggregationType;

  // Dimensions
  fields.newDimension().setId('date').setName('Scan date').setType(types.YEAR_MONTH_DAY);
  fields.newDimension().setId('scan_id').setName('Scan ID').setType(types.TEXT);
  fields.newDimension().setId('domain').setName('Domain').setType(types.TEXT);
  fields.newDimension().setId('brand').setName('Brand').setType(types.TEXT);
  fields.newDimension().setId('score_color').setName('Score band').setType(types.TEXT);
  fields.newDimension().setId('authority_source').setName('Authority source').setType(types.TEXT);
  fields.newDimension().setId('competitor_domain').setName('Top competitor').setType(types.TEXT);

  // Headline scores (point-in-time snapshots -> average across a range)
  fields.newMetric().setId('visibility_score').setName('Visibility score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('seo_score').setName('SEO score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('geo_score').setName('GEO score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('authority_score').setName('Authority score').setType(types.NUMBER).setAggregation(agg.AVG);

  // Per-engine: rate (a ratio 0..1, shown as a percent), plus the raw cited /
  // prompt counts so a report can re-aggregate the rate correctly across rows
  // (sum the counts, do not average the rates), plus average citation position.
  ENGINES.forEach(function (e) {
    var id = e[0], label = e[1];
    fields.newMetric().setId(id + '_citation_rate').setName(label + ' citation rate').setType(types.PERCENT).setAggregation(agg.AVG);
    fields.newMetric().setId(id + '_cited').setName(label + ' citations').setType(types.NUMBER).setAggregation(agg.SUM);
    fields.newMetric().setId(id + '_total').setName(label + ' prompts').setType(types.NUMBER).setAggregation(agg.SUM);
    fields.newMetric().setId(id + '_avg_position').setName(label + ' avg position').setType(types.NUMBER).setAggregation(agg.AVG);
  });

  // Share of voice + competitor benchmark + open-gap count
  fields.newMetric().setId('brand_citations').setName('Brand citations').setType(types.NUMBER).setAggregation(agg.SUM);
  fields.newMetric().setId('competitor_citations').setName('Competitor citations').setType(types.NUMBER).setAggregation(agg.SUM);
  fields.newMetric().setId('brand_citation_share').setName('Share of voice').setType(types.PERCENT).setAggregation(agg.AVG);
  fields.newMetric().setId('competitor_seo_score').setName('Competitor SEO score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('competitor_geo_score').setName('Competitor GEO score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('competitor_authority_score').setName('Competitor authority score').setType(types.NUMBER).setAggregation(agg.AVG);
  fields.newMetric().setId('gap_count').setName('Open gaps').setType(types.NUMBER).setAggregation(agg.AVG);

  fields.setDefaultDimension('domain');
  fields.setDefaultMetric('visibility_score');
  return fields;
}

function getSchema(request) {
  return cc.newGetSchemaResponse().setFields(getFields()).build();
}

// ---------------------------------------------------------------------------
// Data - fetch the flat rows and shape them for the requested fields
// ---------------------------------------------------------------------------

function getData(request) {
  var key = PropertiesService.getUserProperties().getProperty(KEY_PROPERTY);
  if (!key) {
    cc.newUserError()
      .setText('No Cituna API key found. Reconnect the data source and paste your key.')
      .throwException();
  }

  var config = request.configParams || {};
  var apiUrl = normalizeUrl(config.apiUrl || DEFAULT_API_URL);
  var domain = (config.domain || '').toString().trim();

  var params = [];
  if (request.dateRange && request.dateRange.startDate) {
    params.push('start=' + encodeURIComponent(request.dateRange.startDate));
  }
  if (request.dateRange && request.dateRange.endDate) {
    params.push('end=' + encodeURIComponent(request.dateRange.endDate));
  }
  if (domain) params.push('domain=' + encodeURIComponent(domain));
  params.push('limit=2000');

  var url = apiUrl + '/api/integrations/looker/data?' + params.join('&');
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + key },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();

  if (code === 402 || code === 403) {
    cc.newUserError()
      .setText('This report needs a paid Cituna plan (Starter, Pro or Max). Upgrade at https://cituna.com/pricing.')
      .setDebugText('HTTP ' + code + ': ' + text)
      .throwException();
  }
  if (code === 401) {
    cc.newUserError()
      .setText('Your Cituna API key was rejected. Reconnect the data source with a current key.')
      .setDebugText('HTTP 401: ' + text)
      .throwException();
  }
  if (code !== 200) {
    cc.newUserError()
      .setText('Could not reach Cituna (HTTP ' + code + '). Please try again shortly.')
      .setDebugText(text)
      .throwException();
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    cc.newUserError()
      .setText('Unexpected response from Cituna. Please try again shortly.')
      .setDebugText('Non-JSON body: ' + text)
      .throwException();
  }

  var apiRows = (parsed && parsed.rows) || [];

  var requestedFieldIds = request.fields.map(function (f) { return f.name; });
  var requestedFields = getFields().forIds(requestedFieldIds);
  var fieldArray = requestedFields.asArray();

  var rows = apiRows.map(function (item) {
    var values = fieldArray.map(function (field) {
      return formatValue(field, item[field.getId()]);
    });
    return { values: values };
  });

  return cc.newGetDataResponse()
    .setFields(requestedFields)
    .addAllRows(rows)
    .build();
}

/**
 * Coerce one API value into what Looker expects for the field:
 *  - date:   YYYYMMDD (strip the dashes from the ISO YYYY-MM-DD the API returns)
 *  - number: the number, or null when absent (null is excluded from AVG, so an
 *            unscored scan does not drag an average down to zero)
 *  - text:   the string, or '' when absent
 */
function formatValue(field, value) {
  if (field.getId() === 'date') {
    return value ? String(value).replace(/-/g, '') : '';
  }
  var isNumber = field.getType() === cc.FieldType.NUMBER || field.getType() === cc.FieldType.PERCENT;
  if (value === null || value === undefined) {
    return isNumber ? null : '';
  }
  if (isNumber) {
    return typeof value === 'number' ? value : Number(value);
  }
  return String(value);
}

// Trim a trailing slash so base + '/api/...' never doubles up.
function normalizeUrl(u) {
  return String(u || DEFAULT_API_URL).trim().replace(/\/+$/, '');
}
