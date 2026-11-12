/**
 * Nastavení – list SETTINGS (key/value/description). Cache v rámci jedné exekuce.
 */

let SETTINGS_CACHE_ = null;

function loadSettings_(force) {
  if (SETTINGS_CACHE_ && !force) return SETTINGS_CACHE_;
  const rows = table_('SETTINGS').readAll();
  const map = {};
  DEFAULT_SETTINGS.forEach(function (d) { map[d[0]] = d[1]; });
  rows.forEach(function (r) { if (r.key) map[String(r.key).trim()] = String(r.value); });
  SETTINGS_CACHE_ = map;
  return map;
}

function setting_(key) {
  const s = loadSettings_();
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : '';
}

function settingBool_(key) { return toBool_(setting_(key)); }
function settingInt_(key, def) { return toInt_(setting_(key), def); }

/** Zapíše jedno či více nastavení (objekt key->value). */
function saveSettings_(patch) {
  const t = table_('SETTINGS');
  const rows = t.readAll();
  const byKey = {};
  rows.forEach(function (r) { byKey[r.key] = r; });
  const toAppend = [];
  Object.keys(patch).forEach(function (k) {
    const known = DEFAULT_SETTINGS.some(function (d) { return d[0] === k; });
    if (!known) throw new Error('Neznámé nastavení: ' + k);
    const v = patch[k] === true ? 'TRUE' : patch[k] === false ? 'FALSE' : String(patch[k] === null || patch[k] === undefined ? '' : patch[k]);
    validateSetting_(k, v);
    if (byKey[k]) t.update(byKey[k], { value: v });
    else {
      const d = DEFAULT_SETTINGS.filter(function (x) { return x[0] === k; })[0];
      toAppend.push({ key: k, value: v, description: d[2] });
    }
  });
  t.append(toAppend);
  SETTINGS_CACHE_ = null;
}

function validateSetting_(k, v) {
  if ((k === 'SCAN_TIME' || k === 'SEND_TIME') && parseHHMM_(v, -1) < 0) throw new Error(k + ' musí být ve formátu HH:MM');
  if (['DAILY_CONTACT_TARGET', 'DAILY_SEND_LIMIT', 'SEND_DELAY_SECONDS', 'MAX_EMAILS_PER_CONTACT',
    'HIGH_POTENTIAL_THRESHOLD', 'DRAFT_MIN_POTENTIAL', 'GMAIL_QUOTA_RESERVE', 'SLOW_RESPONSE_MS'].indexOf(k) >= 0) {
    if (!/^\d+$/.test(v)) throw new Error(k + ' musí být celé nezáporné číslo');
  }
  if (k === 'DAILY_CONTACT_TARGET' && toInt_(v, 0) > 500) throw new Error('DAILY_CONTACT_TARGET max. 500 (limity Apps Script).');
  if (k === 'SENDER_EMAIL' && v && !isValidEmail_(v)) throw new Error('SENDER_EMAIL není platný e-mail');
  if (k === 'REPLY_TO' && v && !isValidEmail_(v)) throw new Error('REPLY_TO není platný e-mail');
  if (k === 'TEST_RECIPIENT' && v && !isValidEmail_(v)) throw new Error('TEST_RECIPIENT není platný e-mail');
  if (k === 'EMAIL_FOOTER' && v.indexOf('{{odhlaseni_url}}') < 0) throw new Error('Patička musí obsahovat {{odhlaseni_url}} (zákonná možnost odmítnutí).');
  if (k === 'EMAIL_FOOTER' && v.indexOf('{{identifikace_odesilatele}}') < 0) throw new Error('Patička musí obsahovat {{identifikace_odesilatele}} (zákon zakazuje skrývat totožnost odesílatele).');
  if (k === 'SERVICE_MAP_JSON' && safeJsonParse_(v, null) === null) throw new Error('SERVICE_MAP_JSON není platný JSON');
  if (k === 'WEBAPP_URL' && v && !/^https:\/\/script\.google\.com\//.test(v)) throw new Error('WEBAPP_URL musí být adresa nasazené web app (https://script.google.com/...).');
}

/** Doplní chybějící výchozí nastavení do listu (nepřepisuje existující). */
function seedSettings_() {
  const t = table_('SETTINGS');
  const have = {};
  t.readAll().forEach(function (r) { have[r.key] = true; });
  const add = DEFAULT_SETTINGS.filter(function (d) { return !have[d[0]]; })
    .map(function (d) { return { key: d[0], value: d[1], description: d[2] }; });
  t.append(add);
  SETTINGS_CACHE_ = null;
}
