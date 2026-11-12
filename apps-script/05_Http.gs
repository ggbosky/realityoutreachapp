/**
 * Zdvořilá HTTP vrstva:
 *  - kontrola robots.txt (RFC 9309) pro každý požadavek a každé přesměrování,
 *  - prodleva mezi požadavky na stejný host (crawl-delay),
 *  - bezpečné opakování (429/5xx/síťová chyba) s exponenciálním čekáním,
 *  - ruční sledování přesměrování (kvůli kontrole robots a zjištění finální URL),
 *  - detekce kódování (UTF-8 / windows-1250 / iso-8859-2).
 * Nikdy neobchází CAPTCHA, přihlášení ani jiné ochrany: 401/403/429 opakovaně = zdroj nedostupný.
 */

const ROBOTS_MEM_ = {};
const LAST_HIT_ = {};

function getRobotsFor_(origin) {
  const mem = ROBOTS_MEM_[origin];
  if (mem && !(mem.mode === 'UNREACHABLE' && Date.now() - mem.ts > 60000)) return mem;
  const cache = CacheService.getScriptCache();
  const ck = 'robots:' + origin;
  const cached = cache.get(ck);
  if (cached) {
    ROBOTS_MEM_[origin] = JSON.parse(cached);
    return ROBOTS_MEM_[origin];
  }
  let entry;
  try {
    const resp = UrlFetchApp.fetch(origin + '/robots.txt', {
      muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': P2.USER_AGENT },
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) entry = { mode: 'RULES', text: resp.getContentText().substring(0, 500000) };
    else if (code >= 400 && code < 500) entry = { mode: 'ALLOW_ALL', text: '', code: code }; // RFC 9309: "unavailable"
    else entry = { mode: 'DISALLOW_ALL', text: '', code: code };                           // RFC 9309: "unreachable"
  } catch (e) {
    // Server neodpovídá vůbec (DNS, TLS, timeout) – nepřistupujeme, ale odlišujeme od zákazu.
    entry = { mode: 'UNREACHABLE', text: '', error: String(e && e.message || e) };
  }
  entry.ts = Date.now();
  ROBOTS_MEM_[origin] = entry;
  // Nedostupnost je přechodná – necachujeme ji mezi exekucemi.
  if (entry.mode !== 'UNREACHABLE') { try { cache.put(ck, JSON.stringify(entry).substring(0, 99000), 6 * 3600); } catch (e) { } }
  return entry;
}

/** Ověření robots.txt pro konkrétní URL. */
function robotsCheck_(url) {
  const origin = urlOrigin_(url);
  const entry = getRobotsFor_(origin);
  if (entry.mode === 'ALLOW_ALL') return { allowed: true, rule: 'robots.txt neexistuje (' + entry.code + ')', crawlDelay: null };
  if (entry.mode === 'UNREACHABLE') return { allowed: false, unreachable: true, rule: 'server nedostupný (' + entry.error + ')', crawlDelay: null };
  if (entry.mode === 'DISALLOW_ALL') return { allowed: false, rule: 'robots.txt nedostupný (HTTP ' + entry.code + ') – dle RFC 9309 nepřistupujeme', crawlDelay: null };
  // Apps Script přidává k User-Agentu vlastní token „Google-Apps-Script“ – přístup jen pokud ho povolují pravidla pro oba.
  const path = urlPathAndQuery_(url);
  const a = robotsIsAllowed_(entry.text, P2.ROBOTS_AGENT_TOKEN, path);
  const b = robotsIsAllowed_(entry.text, 'Google-Apps-Script', path);
  if (!a.allowed) return a;
  if (!b.allowed) return b;
  return { allowed: true, rule: a.rule, crawlDelay: Math.max(a.crawlDelay || 0, b.crawlDelay || 0) || null };
}

function detectCharset_(resp) {
  const headers = resp.getHeaders() || {};
  let ct = '';
  Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === 'content-type') ct = String(headers[k]); });
  let m = ct.match(/charset=([\w\-]+)/i);
  if (m) return m[1].toLowerCase();
  const head = resp.getContentText('ISO-8859-1').substring(0, 4000);
  m = head.match(/<meta[^>]+charset=["']?([\w\-]+)/i);
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decodeBody_(resp) {
  let cs = detectCharset_(resp);
  if (cs === 'cp1250' || cs === 'win-1250') cs = 'windows-1250';
  if (cs === 'latin2') cs = 'iso-8859-2';
  try { return resp.getContentText(cs); } catch (e) { return resp.getContentText(); }
}

function headerValue_(headers, name) {
  let v = '';
  Object.keys(headers || {}).forEach(function (k) { if (k.toLowerCase() === name.toLowerCase()) v = headers[k]; });
  return Array.isArray(v) ? v[0] : String(v || '');
}

/**
 * @param {string} url
 * @param {Object} opts {crawlDelayMs, retries, respectRobots, maxRedirects}
 * @return {{ok, status, text, finalUrl, elapsedMs, redirects, headers, error, blockedByRobots, robotsRule, bytes}}
 */
function httpGet_(url, opts) {
  opts = opts || {};
  const retries = opts.retries === undefined ? 2 : opts.retries;
  const maxRedirects = opts.maxRedirects === undefined ? 5 : opts.maxRedirects;
  const respectRobots = opts.respectRobots !== false;
  let current = url;
  const redirects = [];
  const started = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (respectRobots) {
      const rc = robotsCheck_(current);
      if (!rc.allowed && rc.unreachable) {
        return { ok: false, status: 0, text: '', finalUrl: current, elapsedMs: Date.now() - started, redirects: redirects,
          headers: {}, error: rc.rule, blockedByRobots: false, unreachable: true, bytes: 0 };
      }
      if (!rc.allowed) {
        return { ok: false, status: 0, text: '', finalUrl: current, elapsedMs: Date.now() - started, redirects: redirects,
          headers: {}, error: 'Zakázáno robots.txt (' + rc.rule + ')', blockedByRobots: true, robotsRule: rc.rule, bytes: 0 };
      }
      politeWait_(current, Math.max(opts.crawlDelayMs || 0, (rc.crawlDelay || 0) * 1000));
    } else {
      politeWait_(current, opts.crawlDelayMs || 0);
    }

    let resp = null, lastErr = null, hopElapsed = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = Date.now();
      try {
        resp = UrlFetchApp.fetch(current, {
          muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true,
          headers: { 'User-Agent': P2.USER_AGENT, 'Accept-Language': 'cs,en;q=0.5', 'Accept': 'text/html,application/xhtml+xml' },
        });
        hopElapsed = Date.now() - t0;
        const code = resp.getResponseCode();
        if ((code === 429 || code >= 500) && attempt < retries) {
          const ra = parseInt(headerValue_(resp.getHeaders(), 'Retry-After'), 10);
          sleep_(Math.min(isNaN(ra) ? 2000 * Math.pow(2, attempt) : ra * 1000, 30000));
          continue;
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        resp = null;
        if (attempt < retries) sleep_(2000 * Math.pow(2, attempt));
      }
    }
    LAST_HIT_[urlHost_(current)] = Date.now();

    if (!resp) {
      return { ok: false, status: 0, text: '', finalUrl: current, elapsedMs: Date.now() - started, redirects: redirects,
        headers: {}, error: String(lastErr && lastErr.message || lastErr), blockedByRobots: false, bytes: 0 };
    }
    const code = resp.getResponseCode();
    const headers = resp.getHeaders();
    if (code >= 300 && code < 400) {
      const loc = headerValue_(headers, 'Location');
      if (!loc) break;
      const next = absoluteUrl_(current, loc);
      redirects.push({ from: current, to: next, status: code });
      current = next;
      continue;
    }
    const text = decodeBody_(resp);
    return {
      ok: code >= 200 && code < 300, status: code, text: text, finalUrl: current,
      elapsedMs: Date.now() - started, firstByteMs: hopElapsed, redirects: redirects, headers: headers,
      error: code >= 400 ? 'HTTP ' + code : '', blockedByRobots: false, bytes: resp.getContent().length,
    };
  }
  return { ok: false, status: 0, text: '', finalUrl: current, elapsedMs: Date.now() - started, redirects: redirects,
    headers: {}, error: 'Příliš mnoho přesměrování', blockedByRobots: false, bytes: 0 };
}

function politeWait_(url, delayMs) {
  const host = urlHost_(url);
  const last = LAST_HIT_[host];
  if (last && delayMs > 0) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) sleep_(wait);
  }
}
