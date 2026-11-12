/**
 * Mock prostředí Google Apps Script pro Node.js.
 * Načte všechny soubory apps-script/*.gs do jednoho vm kontextu (stejně jako GAS – sdílený globální scope)
 * a poskytne simulace služeb: SpreadsheetApp, PropertiesService, CacheService, LockService, UrlFetchApp,
 * Utilities, Session, ScriptApp, MailApp, GmailApp, HtmlService.
 *
 * UrlFetchApp umí dva režimy:
 *   - live: skutečné HTTP požadavky přes curl (synchronně, stejně jako v GAS),
 *   - router: funkce (url, opts) => {code, headers, body} pro deterministické testy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const SRC_DIR = path.join(__dirname, '..', 'apps-script');

/* ----------------------------- Řízený čas ----------------------------- */
function makeClock(startIso) {
  const clock = { now: startIso ? Date.parse(startIso) : Date.now(), realtime: !startIso };
  const RealDate = Date;
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(clock.realtime ? RealDate.now() : clock.now).toString();
    if (args.length === 0) return new RealDate(clock.realtime ? RealDate.now() : clock.now);
    return new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => (clock.realtime ? RealDate.now() : clock.now);
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(FakeDate, Symbol.hasInstance, { value: (x) => x instanceof RealDate });
  clock.Date = FakeDate;
  clock.advance = (ms) => { if (!clock.realtime) clock.now += ms; };
  clock.set = (iso) => { clock.realtime = false; clock.now = Date.parse(iso); };
  return clock;
}

/* ---------------------------- formatDate ---------------------------- */
function formatDate(date, tz, pattern) {
  const d = new Date(date.getTime());
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  if (parts.hour === '24') parts.hour = '00';
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "'") { const j = pattern.indexOf("'", i + 1); out += pattern.substring(i + 1, j); i = j + 1; continue; }
    const tok = pattern.substr(i).match(/^(yyyy|MM|dd|HH|mm|ss|M|d|H)/);
    if (tok) {
      const t = tok[1];
      out += ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second,
        M: String(+parts.month), d: String(+parts.day), H: String(+parts.hour) })[t];
      i += t.length; continue;
    }
    out += pattern[i]; i++;
  }
  return out;
}

/* ------------------------------ Sheets ------------------------------ */
function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class MockRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    this.sheet.ss.stats.reads++;
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const rr = this.sheet.data[this.r - 1 + i];
        row.push(rr && rr[this.c - 1 + j] !== undefined ? rr[this.c - 1 + j] : '');
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    this.sheet.ss.stats.writes++;
    if (vals.length !== this.nr) throw new Error(`setValues: počet řádků ${vals.length} != ${this.nr}`);
    for (let i = 0; i < this.nr; i++) {
      if (vals[i].length !== this.nc) throw new Error(`setValues: počet sloupců ${vals[i].length} != ${this.nc}`);
      const ri = this.r - 1 + i;
      while (this.sheet.data.length <= ri) this.sheet.data.push([]);
      for (let j = 0; j < this.nc; j++) {
        let v = vals[i][j];
        if (typeof v === 'string' && v.charAt(0) === "'") v = v.substring(1); // Sheets: apostrof = text
        if (typeof v === 'number' || typeof v === 'boolean') v = String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'FALSE' ? String(v).toUpperCase() : String(v);
        if (typeof v === 'string' && v.length > 50000) throw new Error('Buňka překročila 50000 znaků');
        this.sheet.data[ri][this.c - 1 + j] = v;
      }
    }
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  clearContent() {
    for (let i = 0; i < this.nr; i++) {
      const rr = this.sheet.data[this.r - 1 + i];
      if (rr) for (let j = 0; j < this.nc; j++) rr[this.c - 1 + j] = '';
    }
    // ořez prázdných řádků na konci
    while (this.sheet.data.length && this.sheet.data[this.sheet.data.length - 1].every((v) => v === '' || v === undefined)) this.sheet.data.pop();
    return this;
  }
}

class MockSheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this.data = []; this.hidden = false; }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i] && this.data[i].some((v) => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, r) => { let l = 0; (r || []).forEach((v, j) => { if (v !== '' && v !== undefined) l = j + 1; }); return Math.max(m, l); }, 0); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') return new MockRange(this, 1, 1, this.getMaxRows(), this.getMaxColumns());
    return new MockRange(this, r, c, nr || 1, nc || 1);
  }
  setFrozenRows() { }
  hideSheet() { this.hidden = true; }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  // pomocné pro testy
  rowsAsObjects() {
    const h = this.data[0] || [];
    return this.data.slice(1).filter((r) => r && r.some((v) => v !== '')).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
  }
}

class MockSpreadsheet {
  constructor() { this.sheets = {}; this.stats = { reads: 0, writes: 0 }; this.id = 'mock-ss-1'; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { if (this.sheets[n]) throw new Error('exists'); this.sheets[n] = new MockSheet(this, n); return this.sheets[n]; }
  getSheets() { return Object.values(this.sheets); }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  toast() { }
}

/* ------------------------------ HTTP ------------------------------ */
class MockResponse {
  constructor(code, headers, bodyBuf) { this.code = code; this.headers = headers; this.body = bodyBuf; }
  getResponseCode() { return this.code; }
  getHeaders() { return this.headers; }
  getAllHeaders() { return this.headers; }
  getContent() { return Array.from(this.body); }
  getContentText(charset) {
    const cs = (charset || 'utf-8').toLowerCase();
    try { return new TextDecoder(cs === 'iso-8859-1' ? 'latin1' : cs).decode(this.body); } catch (e) { return this.body.toString('utf8'); }
  }
}

function curlFetch(url, opts, log) {
  const tmp = path.join(os.tmpdir(), 'p2-' + crypto.randomBytes(6).toString('hex'));
  const ua = (opts.headers && (opts.headers['User-Agent'] || opts.headers['user-agent'])) || 'ProjectTwoBot/1.0';
  const args = ['-sS', '-m', '30', '--compressed', '-A', ua, '-D', '-', '-o', tmp];
  if (opts.followRedirects !== false) args.push('-L');
  Object.entries(opts.headers || {}).forEach(([k, v]) => { if (k.toLowerCase() !== 'user-agent') args.push('-H', `${k}: ${v}`); });
  args.push(url);
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { }
    log.push({ url, error: String(e.stderr || e.message).trim(), ms: Date.now() - t0 });
    throw new Error('Exception: ' + String(e.stderr || e.message).trim());
  }
  const body = fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0);
  try { fs.unlinkSync(tmp); } catch (_) { }
  const blocks = out.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b));
  const last = blocks[blocks.length - 1] || 'HTTP/1.1 0';
  const lines = last.split(/\r?\n/);
  const code = parseInt(lines[0].split(' ')[1], 10);
  const headers = {};
  lines.slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) headers[l.substring(0, i).trim()] = l.substring(i + 1).trim(); });
  log.push({ url, code, ms: Date.now() - t0, bytes: body.length });
  return new MockResponse(code, headers, body);
}

/* ------------------------------ Vytvoření prostředí ------------------------------ */
function createGasEnv(options = {}) {
  const clock = makeClock(options.startIso);
  const ss = new MockSpreadsheet();
  const props = {};
  const cache = {};
  const triggers = [];
  const sentMail = [];
  const drafts = [];
  const fetchLog = [];
  const consoleLog = [];
  const gmailThreads = options.gmailThreads || [];
  let mailQuota = options.mailQuota === undefined ? 100 : options.mailQuota;
  let lockHeld = false;
  const env = { clock, ss, props, cache, triggers, sentMail, drafts, fetchLog, consoleLog, gmailThreads };
  env.setQuota = (q) => { mailQuota = q; };
  env.fetchRouter = options.fetchRouter || null;
  env.failNextFetches = 0;

  const Utilities = {
    formatDate,
    sleep: (ms) => {
      if (clock.realtime) {
        const real = Math.min(ms, options.maxRealSleepMs === undefined ? 0 : options.maxRealSleepMs);
        if (real > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, real);
      } else clock.advance(ms);
    },
    computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    computeHmacSha256Signature: (s, key) => Array.from(crypto.createHmac('sha256', String(key)).update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64url'),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => {
        if (String(v).length > 9 * 1024) throw new Error('Property value too large (9kB limit): ' + k);
        props[k] = String(v); return this;
      },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => ({ ...props }),
    }),
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (cache[k] && cache[k].exp > clock.Date.now() ? cache[k].v : null),
      put: (k, v, sec) => { if (String(v).length > 100 * 1024) throw new Error('cache value too large'); cache[k] = { v: String(v), exp: clock.Date.now() + (sec || 600) * 1000 }; },
      remove: (k) => { delete cache[k]; },
    }),
  };

  const LockService = {
    getScriptLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      waitLock: () => { if (lockHeld) throw new Error('Lock timeout'); lockHeld = true; },
      releaseLock: () => { lockHeld = false; },
      hasLock: () => lockHeld,
    }),
  };
  env.forceLock = (v) => { lockHeld = v; };

  const UrlFetchApp = {
    fetch: (url, opts = {}) => {
      if (env.failNextFetches > 0) { env.failNextFetches--; fetchLog.push({ url, error: 'injected' }); throw new Error('Exception: Injected network failure'); }
      if (env.fetchRouter) {
        const r = env.fetchRouter(url, opts);
        if (r === undefined) {
          if (options.live) return curlFetch(url, opts, fetchLog);
          throw new Error('Exception: DNS error: ' + url);
        }
        if (r instanceof Error) { fetchLog.push({ url, error: r.message }); throw r; }
        fetchLog.push({ url, code: r.code });
        clock.advance(r.ms || 50);
        return new MockResponse(r.code, r.headers || { 'Content-Type': 'text/html; charset=utf-8' }, Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body || '', 'utf8'));
      }
      if (options.live) return curlFetch(url, opts, fetchLog);
      throw new Error('Exception: no network in test');
    },
    fetchAll: (reqs) => reqs.map((r) => UrlFetchApp.fetch(r.url, r)),
  };

  const ownerEmail = options.ownerEmail || 'owner@example.com';
  env.activeUser = ownerEmail;
  const Session = {
    getEffectiveUser: () => ({ getEmail: () => ownerEmail }),
    getActiveUser: () => ({ getEmail: () => env.activeUser }),
    getScriptTimeZone: () => 'Europe/Prague',
  };

  let trigSeq = 0;
  function TriggerBuilder(fn) {
    const t = { fn, type: null, id: 'trig-' + (++trigSeq) };
    const b = {
      timeBased: () => b, everyMinutes: (n) => { t.type = 'every'; t.minutes = n; return b; }, everyHours: (n) => { t.type = 'everyHours'; t.hours = n; return b; },
      atHour: (h) => { t.hour = h; return b; }, nearMinute: (m) => { t.minute = m; return b; }, everyDays: (n) => { t.type = 'daily'; t.days = n; return b; },
      inTimezone: (tz) => { t.tz = tz; return b; }, after: (ms) => { t.type = 'after'; t.ms = ms; return b; },
      create: () => { const tr = { getHandlerFunction: () => fn, getUniqueId: () => t.id, getEventType: () => 'CLOCK', _t: t }; triggers.push(tr); return tr; },
    };
    return b;
  }
  const ScriptApp = {
    newTrigger: (fn) => TriggerBuilder(fn),
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (tr) => { const i = triggers.indexOf(tr); if (i >= 0) triggers.splice(i, 1); },
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/MOCK/exec' }),
    getScriptId: () => 'mock-script',
    AuthMode: { FULL: 'FULL' },
    EventType: { CLOCK: 'CLOCK' },
  };

  const MailApp = { getRemainingDailyQuota: () => mailQuota };

  function threadObj(t) {
    return {
      getId: () => t.id,
      getMessages: () => t.messages.map((m) => ({
        getFrom: () => m.from, getPlainBody: () => m.body, getDate: () => new Date(m.date), getSubject: () => m.subject || '', getId: () => m.id || (t.id + ':' + m.date),
      })),
      getFirstMessageSubject: () => t.subject || '',
    };
  }
  const GmailApp = {
    sendEmail: (to, subject, body, o) => {
      if (mailQuota <= 0) throw new Error('Service invoked too many times for one day: email.');
      mailQuota--; sentMail.push({ to, subject, body, options: o, at: clock.Date.now() });
    },
    getAliases: () => options.aliases || [],
    search: (q) => gmailThreads.filter((t) => !t.query || q.indexOf(t.query) >= 0).map(threadObj),
    getThreadById: (id) => { const t = gmailThreads.find((x) => x.id === id); return t ? threadObj(t) : null; },
    createDraft: (to, subject, body, o) => {
      const dr = { to, subject, body, options: o };
      drafts.push(dr);
      return { getId: () => 'd' + drafts.length, send: () => {
        if (env.failSend) { const e = env.failSend; env.failSend = null; throw new Error(e); }
        if (mailQuota <= 0) throw new Error('Service invoked too many times for one day: email.');
        mailQuota--;
        const threadId = 'thread-' + (sentMail.length + 1);
        sentMail.push({ to, subject, body, options: o, at: clock.Date.now(), threadId });
        gmailThreads.push({ id: threadId, subject, messages: [{ from: (o && o.from) || ownerEmail, body, date: clock.Date.now() }] });
        return { getThread: () => ({ getId: () => threadId }), getId: () => 'm-' + threadId };
      } };
    },
  };

  function htmlOutput(content) {
    const o = { content, title: '', setTitle: (t) => { o.title = t; return o; }, setXFrameOptionsMode: () => o, addMetaTag: () => o,
      setWidth: () => o, setHeight: () => o, getContent: () => o.content, setSandboxMode: () => o, evaluate: () => o };
    return o;
  }
  const HtmlService = {
    createHtmlOutputFromFile: (name) => htmlOutput(fs.readFileSync(path.join(SRC_DIR, name + '.html'), 'utf8')),
    createHtmlOutput: (s) => htmlOutput(s || ''),
    createTemplateFromFile: (name) => {
      const tpl = { _src: fs.readFileSync(path.join(SRC_DIR, name + '.html'), 'utf8') };
      tpl.evaluate = () => htmlOutput(renderTemplate(tpl._src, tpl, ctx));
      return tpl;
    },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME' },
  };

  const uiCalls = [];
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    openById: () => ss,
    getUi: () => ({
      createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => m }; return m; },
      showModalDialog: (o, t) => uiCalls.push({ type: 'modal', title: t }),
      showSidebar: (o) => uiCalls.push({ type: 'sidebar' }),
      alert: (m) => uiCalls.push({ type: 'alert', msg: m }),
      ButtonSet: { OK: 'OK' },
    }),
  };
  env.uiCalls = uiCalls;

  const ctx = {
    console: { log: (...a) => consoleLog.push(a.join(' ')), error: (...a) => consoleLog.push('ERR ' + a.join(' ')), warn: (...a) => consoleLog.push('WARN ' + a.join(' ')), info: (...a) => consoleLog.push(a.join(' ')) },
    Logger: { log: (...a) => consoleLog.push(a.join(' ')) },
    Date: clock.Date, Math, JSON, RegExp, String, Number, Array, Object, Error, TextDecoder, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, Intl, Symbol, Promise, Set, Map,
    Utilities, PropertiesService, CacheService, LockService, UrlFetchApp, Session, ScriptApp, MailApp, GmailApp, HtmlService, SpreadsheetApp,
  };
  vm.createContext(ctx);
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.gs')).sort();
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    // Top-level const/let ve vm skriptech nejsou vlastnostmi kontextu – sdílíme je jako v GAS přes jeden skript.
    env._code = (env._code || '') + '\n// ---- ' + f + '\n' + code;
  }
  vm.runInContext(env._code + '\n;globalThis.__P2_EXPORTS__ = { P2, SCHEMA, DEFAULT_SETTINGS, DEFAULT_SOURCES };', ctx, { filename: 'apps-script.bundle.js' });
  env.ctx = ctx;
  env.call = (fnName, ...args) => {
    const fn = vm.runInContext(fnName, ctx);
    if (typeof fn !== 'function') throw new Error('Funkce neexistuje: ' + fnName);
    return fn(...args);
  };
  env.eval = (code) => vm.runInContext(code, ctx);
  /** Simulace spuštění time-driven triggeru (Apps Script předá event s triggerUid). */
  env.fireTrigger = () => {
    const tr = triggers.find((t) => t.getHandlerFunction() === 'tick');
    if (!tr) return { skipped: 'NO_TRIGGER' };
    const saved = env.activeUser; env.activeUser = '';
    try { return env.call('tick', { triggerUid: tr.getUniqueId(), authMode: 'FULL' }); } finally { env.activeUser = saved; }
  };
  env.sheet = (name) => ss.getSheetByName(name);
  env.rows = (name) => (ss.getSheetByName(name) ? ss.getSheetByName(name).rowsAsObjects() : []);
  return env;
}

/** Vyhodnocení GAS šablon: <? kód ?>, <?= tisk s escapováním ?>, <?!= tisk bez escapování ?>. */
function renderTemplate(src, tpl, ctx) {
  let code = 'var __o = []; with (__vars) {\n';
  const re = /<\?(!?=)?([\s\S]*?)\?>/g;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    code += '__o.push(' + JSON.stringify(src.substring(last, m.index)) + ');\n';
    if (m[1] === '=') code += '__o.push(__esc(' + m[2] + '));\n';
    else if (m[1] === '!=') code += '__o.push(String(' + m[2] + '));\n';
    else code += m[2] + '\n';
    last = re.lastIndex;
  }
  code += '__o.push(' + JSON.stringify(src.substring(last)) + ');\n} __o.join("")';
  const vars = Object.assign(Object.create(null), tpl);
  delete vars.evaluate; delete vars._src;
  const sandbox = Object.assign({}, { __vars: new Proxy(vars, { has: (t, k) => k in t || k in ctx, get: (t, k) => (k in t ? t[k] : ctx[k]) }),
    __esc: (v) => String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') });
  return vm.runInNewContext(code, sandbox);
}

module.exports = { createGasEnv, formatDate, curlFetch };
