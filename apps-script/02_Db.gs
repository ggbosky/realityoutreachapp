/**
 * Databázová vrstva nad Google Sheets.
 * Každý list má hlavičku v řádku 1, data od řádku 2. Řádek objektu je v poli `_row`.
 */

let SS_CACHE_ = null;
function getSs_() {
  if (SS_CACHE_) return SS_CACHE_;
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (id) ss = SpreadsheetApp.openById(id);
  }
  if (!ss) throw new Error('Skript není svázán s tabulkou a není nastaveno SPREADSHEET_ID.');
  SS_CACHE_ = ss;
  return ss;
}

/** Vytvoří chybějící listy a sloupce. Nikdy nemaže existující data. */
function ensureSchema_() {
  const ss = getSs_();
  Object.keys(SCHEMA).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const want = SCHEMA[name];
    const lastCol = sh.getLastColumn();
    const have = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    if (have.length === 0 || have.every(function (h) { return h === ''; })) {
      sh.getRange(1, 1, 1, want.length).setValues([want]);
    } else {
      const missing = want.filter(function (h) { return have.indexOf(h) === -1; });
      if (missing.length) sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    }
    try {
      // Vše jako prostý text – Sheets jinak převádí "08:00" na čas a "+420…" na číslo.
      sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), want.length)).setNumberFormat('@');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
    } catch (e) { /* formátování není kritické */ }
    if (name.charAt(0) === '_') { try { sh.hideSheet(); } catch (e) { } }
  });
}

/** Tabulka nad jedním listem. */
function Table_(name) {
  this.name = name;
  this.sheet = getSs_().getSheetByName(name);
  if (!this.sheet) throw new Error('List ' + name + ' neexistuje – spusťte nastavení (setup).');
  const lastCol = this.sheet.getLastColumn();
  this.headers = this.sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  this.idx = {};
  for (let i = 0; i < this.headers.length; i++) this.idx[this.headers[i]] = i;
}

Table_.prototype.readAll = function () {
  const last = this.sheet.getLastRow();
  if (last < 2) return [];
  const values = this.sheet.getRange(2, 1, last - 1, this.headers.length).getValues();
  const out = [];
  for (let r = 0; r < values.length; r++) {
    const o = { _row: r + 2 };
    let empty = true;
    for (let c = 0; c < this.headers.length; c++) {
      const v = values[r][c];
      o[this.headers[c]] = (v instanceof Date) ? Utilities.formatDate(v, P2.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss") : v;
      if (v !== '' && v !== null) empty = false;
    }
    if (!empty) out.push(o);
  }
  return out;
};

Table_.prototype.toRow_ = function (obj, base) {
  const row = base ? base.slice() : new Array(this.headers.length).fill('');
  for (let c = 0; c < this.headers.length; c++) {
    const h = this.headers[c];
    if (Object.prototype.hasOwnProperty.call(obj, h)) {
      let v = obj[h];
      if (v === null || v === undefined) v = '';
      if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
      if (typeof v === 'object') v = JSON.stringify(v);
      if (typeof v === 'string' && v.length > 49000) v = v.substring(0, 49000) + '…';
      // Ochrana proti interpretaci jako vzorec (formula injection) u dat z webu.
      if (typeof v === 'string' && /^[=+\-@]/.test(v)) v = "'" + v;
      row[c] = v;
    }
  }
  return row;
};

Table_.prototype.append = function (objs) {
  if (!objs.length) return;
  const self = this;
  const rows = objs.map(function (o) { return self.toRow_(o); });
  const start = this.sheet.getLastRow() + 1;
  const range = this.sheet.getRange(start, 1, rows.length, this.headers.length);
  range.setNumberFormat('@');
  range.setValues(rows);
  for (let i = 0; i < objs.length; i++) objs[i]._row = start + i;
};

/** Aktualizuje řádek objektu (obj._row) – zapíše jen předané klíče. */
Table_.prototype.update = function (obj, patch) {
  if (!obj._row) throw new Error('update bez _row');
  const range = this.sheet.getRange(obj._row, 1, 1, this.headers.length);
  const current = range.getValues()[0];
  const row = this.toRow_(patch, current);
  range.setValues([row]);
  for (const k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) obj[k] = patch[k];
};

/** Hromadný zápis celých objektů (po řádcích). */
Table_.prototype.updateMany = function (objs) {
  const self = this;
  objs.forEach(function (o) {
    const patch = {};
    self.headers.forEach(function (h) { if (Object.prototype.hasOwnProperty.call(o, h)) patch[h] = o[h]; });
    self.sheet.getRange(o._row, 1, 1, self.headers.length).setValues([self.toRow_(patch)]);
  });
};

Table_.prototype.deleteRow = function (obj) {
  this.sheet.deleteRow(obj._row);
};

Table_.prototype.clearData = function () {
  const last = this.sheet.getLastRow();
  if (last >= 2) this.sheet.getRange(2, 1, last - 1, this.headers.length).clearContent();
};

function table_(name) { return new Table_(name); }

/**
 * Spuštění funkce pod zámkem skriptu; vrací null, pokud zámek nelze získat.
 * Re-entrantní v rámci jedné exekuce (vnořené volání zámek znovu nezískává).
 */
let LOCK_DEPTH_ = 0;
function withScriptLock_(fn, waitMs) {
  if (LOCK_DEPTH_ > 0) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 5000)) return null;
  LOCK_DEPTH_++;
  try { return fn(); } finally { LOCK_DEPTH_--; lock.releaseLock(); }
}

/** Unikátní ID kontaktu: P2-000001 … (sekvence v Script Properties pod zámkem). */
function nextContactIds_(count) {
  const props = PropertiesService.getScriptProperties();
  const out = withScriptLock_(function () {
    let seq = toInt_(props.getProperty(P2.COUNTER_KEY), 0);
    const ids = [];
    for (let i = 0; i < count; i++) {
      seq++;
      ids.push('P2-' + String(seq).padStart(6, '0'));
    }
    props.setProperty(P2.COUNTER_KEY, String(seq));
    return ids;
  }, 20000);
  if (!out) throw new Error('Nelze získat zámek pro generování ID.');
  return out;
}

/** Záznam chyby do ERROR_LOG (nikdy nevyhazuje). */
function logError_(job, source, severity, message, details) {
  try {
    const state = getRunState_();
    table_('ERROR_LOG').append([{
      ts: nowIso_(), run_id: state ? state.runId : '', job: job, source: source || '',
      severity: severity || 'ERROR', message: truncate_(message, 500), details: truncate_(details || '', 4000),
    }]);
  } catch (e) {
    console.error('logError_ selhal: ' + e + ' / původní: ' + message);
  }
}
