/**
 * Obecné pomocné funkce (bez závislosti na Google službách, kromě Utilities pro hash/datum).
 */

function nowIso_() {
  return Utilities.formatDate(new Date(), P2.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

/** Převod lokálního pražského času "yyyy-MM-ddTHH:mm:ss" na epoch ms. */
function parsePragueIso_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // offset Prahy v daném okamžiku (zimní/letní čas)
  const probe = new Date(asUtc);
  const local = Utilities.formatDate(probe, P2.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  const localAsUtc = Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +local[6]);
  return asUtc - (localAsUtc - asUtc);
}

function todayPrague_(d) {
  return Utilities.formatDate(d || new Date(), P2.TIMEZONE, 'yyyy-MM-dd');
}

/** Minuty od půlnoci v Praze. */
function minutesOfDayPrague_(d) {
  const hm = Utilities.formatDate(d || new Date(), P2.TIMEZONE, 'HH:mm').split(':');
  return parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10);
}

function parseHHMM_(s, fallback) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

function toBool_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === 'ON' || s === '1' || s === 'ANO' || s === 'YES';
}

function toInt_(v, def) {
  const n = parseInt(String(v).trim(), 10);
  return isNaN(n) ? def : n;
}

function sleep_(ms) {
  if (ms > 0) Utilities.sleep(ms);
}

function sha256Hex_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function hmacHex_(s, key) {
  const bytes = Utilities.computeHmacSha256Signature(String(s), String(key), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

/** Odstranění diakritiky – pro porovnávání (ne pro zobrazení). */
function stripDiacritics_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normText_(s) {
  return stripDiacritics_(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalizace názvu firmy pro párování (bez právní formy). */
function normCompany_(s) {
  return normText_(s)
    .replace(/\b(s r o|spol s r o|a s|v o s|k s|z s|o p s|s p|sro|as)\b/g, ' ')
    .replace(/\b(realitni kancelar|reality|realitni|rk)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normEmail_(s) {
  const e = String(s || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  return isValidEmail_(e) ? e : '';
}

function isValidEmail_(e) {
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(String(e || ''));
}

function emailDomain_(e) {
  const m = String(e || '').toLowerCase().match(/@([a-z0-9.\-]+)$/);
  return m ? m[1] : '';
}

/** Normalizace českého telefonu na +420XXXXXXXXX (nebo '' pokud nejde). */
function normPhone_(s) {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.indexOf('+') === 0) d = d.substring(1);
  else if (d.indexOf('00') === 0) d = d.substring(2);
  if (d.length === 9) d = '420' + d;
  if (!/^\d{11,13}$/.test(d)) return '';
  return '+' + d;
}

/** Normalizace URL webu na https://host/... ; vrací '' pro neplatné. */
function normUrl_(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (/^(mailto|tel|javascript):/i.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s.replace(/^\/+/, '');
  const m = s.match(/^(https?):\/\/([^\/?#:]+)(:\d+)?([^#]*)/i);
  if (!m) return '';
  const host = m[2].toLowerCase();
  if (!/^[a-z0-9.\-]+\.[a-z]{2,}$/.test(host)) return '';
  let path = m[4] || '/';
  if (path === '') path = '/';
  return m[1].toLowerCase() + '://' + host + (m[3] || '') + path;
}

function urlHost_(u) {
  const m = String(u || '').match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function urlOrigin_(u) {
  const m = String(u || '').match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function urlPathAndQuery_(u) {
  const m = String(u || '').match(/^https?:\/\/[^\/?#]+([^#]*)/i);
  const p = m ? m[1] : '/';
  return p ? (p.charAt(0) === '/' ? p : '/' + p) : '/';
}

function absoluteUrl_(base, href) {
  if (!href) return '';
  href = String(href).trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (href.indexOf('//') === 0) return 'https:' + href;
  const origin = urlOrigin_(base);
  if (href.charAt(0) === '/') return origin + href;
  const basePath = urlPathAndQuery_(base).split('?')[0];
  return origin + basePath.replace(/[^\/]*$/, '') + href;
}

function isOnHostList_(host, list) {
  host = String(host || '').toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

function isFreemail_(email) {
  return isOnHostList_(emailDomain_(email), FREEMAIL_DOMAINS);
}

function isFranchise_(text) {
  const s = String(text || '');
  const plain = stripDiacritics_(s);
  for (let i = 0; i < FRANCHISE_PATTERNS.length; i++) {
    if (FRANCHISE_PATTERNS[i].test(s) || FRANCHISE_PATTERNS[i].test(plain)) return true;
  }
  return false;
}

/** HTML entity decode (základní + číselné). */
function decodeEntities_(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', copy: '©', bdquo: '„', ldquo: '“', rdquo: '”' };
  return String(s || '')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&([a-z]+);/gi, function (m, n) { return Object.prototype.hasOwnProperty.call(map, n.toLowerCase()) ? map[n.toLowerCase()] : m; });
}

/** Text z HTML fragmentu. */
function htmlToText_(s) {
  return decodeEntities_(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function oneLine_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

const NAME_TITLES_RE = /^(ing|mgr|bc|judr|mudr|phdr|rndr|paeddr|ph\.?d|mba|dis|doc|prof|csc|ll\.?m|msc|bba|arch|akad|ma|ba|th\.?d|dr)\.?$/i;

/** Rozdělení jména na křestní a příjmení (odstraní tituly). Nehádá – pokud nejde, vrací prázdné. */
function splitPersonName_(full) {
  const cleaned = oneLine_(String(full || '').replace(/,/g, ' '));
  const parts = cleaned.split(' ').filter(function (p) {
    return p && !NAME_TITLES_RE.test(p.replace(/\.$/, '')) && !NAME_TITLES_RE.test(p);
  });
  if (parts.length < 2) return { first: '', last: '', clean: parts.join(' ') };
  return { first: parts[0], last: parts[parts.length - 1], clean: parts.join(' ') };
}

/** Vypadá řetězec jako jméno osoby (2–4 slova, velká písmena, bez právní formy)? */
function looksLikePersonName_(s) {
  const t = oneLine_(s);
  if (!t || /s\.\s?r\.\s?o|a\.\s?s\.|spol\.|reality|realit|kancel|invest|group|servis|holding|\d/i.test(t)) return false;
  const p = splitPersonName_(t);
  if (!p.first) return false;
  const words = p.clean.split(' ');
  if (words.length > 4) return false;
  return words.every(function (w) { return /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž'\-]+$/.test(w); });
}

function safeJsonParse_(s, def) {
  try { return s ? JSON.parse(s) : def; } catch (e) { return def; }
}

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function uniq_(arr) {
  const seen = {};
  return arr.filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; });
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
