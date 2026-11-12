/* Simulace služeb Google Apps Script v prohlížeči (pro demo stránku).
   Data: window.__P2_DEMO__ = { sheets: {name: [[...]]}, props: {...} }. Síť ani e-mail nejsou dostupné. */
(function (g) {
  'use strict';
  var demo = g.__P2_DEMO__ || { sheets: {}, props: {} };

  /* ---------- SHA-256 + HMAC (synchronně, jako Utilities) ---------- */
  function utf8(s) { return Array.from(new TextEncoder().encode(String(s))); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(bytes) {
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l = bytes.length, m = bytes.slice(); m.push(0x80);
    while ((m.length % 64) !== 56) m.push(0);
    var bits = l * 8; for (var i = 7; i >= 0; i--) m.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 255);
    var w = new Array(64);
    for (var o = 0; o < m.length; o += 64) {
      for (var t = 0; t < 16; t++) w[t] = (m[o + t * 4] << 24) | (m[o + t * 4 + 1] << 16) | (m[o + t * 4 + 2] << 8) | m[o + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], gg = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & gg);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + gg) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = []; H.forEach(function (v) { out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); });
    return out;
  }
  function hmac(msg, key) {
    var k = utf8(key); if (k.length > 64) k = sha256(k); while (k.length < 64) k.push(0);
    var ipad = k.map(function (b) { return b ^ 0x36; }), opad = k.map(function (b) { return b ^ 0x5c; });
    return sha256(opad.concat(sha256(ipad.concat(utf8(msg)))));
  }
  var signed = function (arr) { return arr.map(function (b) { return b > 127 ? b - 256 : b; }); };

  /* ---------- Utilities ---------- */
  g.Utilities = {
    formatDate: function (date, tz, pattern) {
      var parts = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        .formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
      if (parts.hour === '24') parts.hour = '00';
      var out = '', i = 0;
      while (i < pattern.length) {
        if (pattern[i] === "'") { var j = pattern.indexOf("'", i + 1); out += pattern.substring(i + 1, j); i = j + 1; continue; }
        var tok = pattern.substr(i).match(/^(yyyy|MM|dd|HH|mm|ss|M|d|H)/);
        if (tok) { out += { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, M: String(+parts.month), d: String(+parts.day), H: String(+parts.hour) }[tok[1]]; i += tok[1].length; continue; }
        out += pattern[i]; i++;
      }
      return out;
    },
    sleep: function () {},
    computeDigest: function (_a, s) { return signed(sha256(utf8(s))); },
    computeHmacSha256Signature: function (s, key) { return signed(hmac(s, key)); },
    getUuid: function () { return (g.crypto && g.crypto.randomUUID) ? g.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  };

  /* ---------- Sheets ---------- */
  function Range(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  Range.prototype.getValues = function () {
    var out = [];
    for (var i = 0; i < this.nr; i++) { var row = [], rr = this.sh.data[this.r - 1 + i];
      for (var j = 0; j < this.nc; j++) row.push(rr && rr[this.c - 1 + j] !== undefined ? rr[this.c - 1 + j] : ''); out.push(row); }
    return out;
  };
  Range.prototype.setValues = function (vals) {
    for (var i = 0; i < this.nr; i++) { var ri = this.r - 1 + i; while (this.sh.data.length <= ri) this.sh.data.push([]);
      for (var j = 0; j < this.nc; j++) { var v = vals[i][j]; if (typeof v === 'string' && v.charAt(0) === "'") v = v.substring(1); if (typeof v !== 'string') v = String(v); this.sh.data[ri][this.c - 1 + j] = v; } }
    return this;
  };
  Range.prototype.setNumberFormat = function () { return this; };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.clearContent = function () {
    for (var i = 0; i < this.nr; i++) { var rr = this.sh.data[this.r - 1 + i]; if (rr) for (var j = 0; j < this.nc; j++) rr[this.c - 1 + j] = ''; }
    while (this.sh.data.length && this.sh.data[this.sh.data.length - 1].every(function (v) { return v === '' || v === undefined; })) this.sh.data.pop();
    return this;
  };
  function Sheet(name, data) { this.name = name; this.data = data || []; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { for (var i = this.data.length - 1; i >= 0; i--) if (this.data[i] && this.data[i].some(function (v) { return v !== '' && v !== undefined; })) return i + 1; return 0; };
  Sheet.prototype.getLastColumn = function () { return this.data.reduce(function (m, r) { var l = 0; (r || []).forEach(function (v, j) { if (v !== '' && v !== undefined) l = j + 1; }); return Math.max(m, l); }, 0); };
  Sheet.prototype.getMaxRows = function () { return Math.max(1000, this.data.length); };
  Sheet.prototype.getMaxColumns = function () { return Math.max(26, this.getLastColumn()); };
  Sheet.prototype.getRange = function (r, c, nr, nc) { if (typeof r === 'string') return new Range(this, 1, 1, this.getMaxRows(), this.getMaxColumns()); return new Range(this, r, c, nr || 1, nc || 1); };
  Sheet.prototype.setFrozenRows = function () {}; Sheet.prototype.hideSheet = function () {};
  Sheet.prototype.deleteRow = function (r) { this.data.splice(r - 1, 1); };
  var sheets = {};
  Object.keys(demo.sheets).forEach(function (n) { sheets[n] = new Sheet(n, demo.sheets[n]); });
  var ss = { getSheetByName: function (n) { return sheets[n] || null; }, insertSheet: function (n) { sheets[n] = new Sheet(n, []); return sheets[n]; },
    getSheets: function () { return Object.keys(sheets).map(function (k) { return sheets[k]; }); }, getId: function () { return 'demo'; }, getUrl: function () { return '#'; } };
  g.SpreadsheetApp = { getActiveSpreadsheet: function () { return ss; }, openById: function () { return ss; }, flush: function () {},
    getUi: function () { throw new Error('V demu není tabulka.'); } };

  /* ---------- Properties / Cache / Lock ---------- */
  var props = Object.assign({}, demo.props || {}), cache = {}, lock = false;
  g.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
    setProperty: function (k, v) { props[k] = String(v); }, deleteProperty: function (k) { delete props[k]; }, getProperties: function () { return Object.assign({}, props); } }; } };
  g.CacheService = { getScriptCache: function () { return { get: function (k) { return cache[k] && cache[k].exp > Date.now() ? cache[k].v : null; },
    put: function (k, v, s) { cache[k] = { v: String(v), exp: Date.now() + (s || 600) * 1000 }; }, remove: function (k) { delete cache[k]; } }; } };
  g.LockService = { getScriptLock: function () { return { tryLock: function () { if (lock) return false; lock = true; return true; },
    waitLock: function () { if (lock) throw new Error('Lock timeout'); lock = true; }, releaseLock: function () { lock = false; }, hasLock: function () { return lock; } }; } };

  /* ---------- Síť: v demu zakázaná ---------- */
  g.UrlFetchApp = { fetch: function (url) { throw new Error('Demo stránka nemá přístup k síti (' + String(url).replace(/^https?:\/\//, '').split('/')[0] + '). Skenování běží jen v nasazené aplikaci.'); },
    fetchAll: function (r) { return r.map(function (x) { return g.UrlFetchApp.fetch(x.url); }); } };

  /* ---------- Identita, triggery, e-mail ---------- */
  var owner = 'vy@project-two.cz';
  g.Session = { getEffectiveUser: function () { return { getEmail: function () { return owner; } }; },
    getActiveUser: function () { return { getEmail: function () { return owner; } }; }, getScriptTimeZone: function () { return 'Europe/Prague'; } };
  var triggers = (demo.triggers || ['tick']).map(function (fn, i) { return { getHandlerFunction: function () { return fn; }, getUniqueId: function () { return 'demo-' + i; } }; });
  function builder(fn) { var b = { timeBased: function () { return b; }, everyMinutes: function () { return b; }, atHour: function () { return b; }, everyDays: function () { return b; }, inTimezone: function () { return b; },
    create: function () { var t = { getHandlerFunction: function () { return fn; }, getUniqueId: function () { return 'demo-' + Date.now(); } }; triggers.push(t); return t; } }; return b; }
  g.ScriptApp = { newTrigger: builder, getProjectTriggers: function () { return triggers.slice(); },
    deleteTrigger: function (t) { var i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    getService: function () { return { getUrl: function () { return ''; } }; } };
  var quota = 100;
  g.MailApp = { getRemainingDailyQuota: function () { return quota; } };
  g.__P2_SENT__ = [];
  g.GmailApp = {
    getAliases: function () { return []; },
    sendEmail: function () { throw new Error('V demu se e-maily neodesílají.'); },
    createDraft: function (to, subject, body) { return { send: function () { g.__P2_SENT__.push({ to: to, subject: subject }); return { getThread: function () { return { getId: function () { return 'demo-thread'; } }; } }; } }; },
    getThreadById: function () { return null; }, search: function () { return []; },
  };
  g.HtmlService = { createHtmlOutput: function (s) { return { getContent: function () { return s; } }; } };
  g.Logger = { log: function () {} };
})(window);
