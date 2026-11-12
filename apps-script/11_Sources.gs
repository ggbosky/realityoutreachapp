/**
 * Moduly zdrojů (katalogů). Každý modul zpracovává stránky postupně podle kurzoru,
 * aby šlo běh kdykoli přerušit a navázat. Nalezené záznamy jdou do interního listu _POOL.
 *
 * Rozhraní modulu:
 *   step(source, cursor, ctx) -> { items: [...], cursor: {...}|null (null = hotovo), note }
 */

/** Stavy podmínek, se kterými smí systém zdroj automaticky zpracovat. */
const TOS_OK = ['NO_RESTRICTION_FOUND', 'APPROVED', 'WRITTEN_PERMISSION'];

const SOURCE_MODULES = {
  ark: {
    label: 'ARK ČR (seznam členů a makléřů)',
    step: function (src, cursor, ctx) {
      cursor = cursor || { stage: 'offices', page: 1, maxPage: null };
      const base = src.base_url.replace(/\/$/, '');
      const maxPages = toInt_(src.max_pages, 40);
      const url = base + (cursor.stage === 'offices' ? '/clenove' : '/makleri') + (cursor.page > 1 ? '?page=' + cursor.page : '');
      const res = ctx.fetch(url);
      if (!res.ok) throw sourceError_(res, url);
      const parsed = cursor.stage === 'offices' ? parseArkOffices_(res.text) : parseArkBrokers_(res.text, url);
      const maxPage = Math.min(Math.max(parsed.maxPage, cursor.maxPage || 1), maxPages);
      let next;
      if (parsed.items.length === 0 || cursor.page >= maxPage) {
        next = cursor.stage === 'offices' ? { stage: 'brokers', page: 1, maxPage: null } : null;
      } else {
        next = { stage: cursor.stage, page: cursor.page + 1, maxPage: maxPage };
      }
      return { items: parsed.items, cursor: next, note: cursor.stage + ' str. ' + cursor.page + '/' + maxPage };
    },
  },

  srovnani: {
    label: 'Srovnání makléřů (jméno, kancelář; bez e-mailů)',
    step: function (src, cursor, ctx) {
      cursor = cursor || { page: 1, maxPage: null };
      const base = src.base_url.replace(/\/$/, '');
      const url = base + '/realitni-makleri/' + (cursor.page > 1 ? '?paginator-page=' + cursor.page : '');
      const res = ctx.fetch(url);
      if (!res.ok) throw sourceError_(res, url);
      const parsed = parseSrovnaniList_(res.text, url);
      const maxPage = Math.min(Math.max(parsed.maxPage, cursor.maxPage || 1), toInt_(src.max_pages, 15));
      const next = (parsed.items.length === 0 || cursor.page >= maxPage) ? null : { page: cursor.page + 1, maxPage: maxPage };
      return { items: parsed.items, cursor: next, note: 'str. ' + cursor.page + '/' + maxPage };
    },
    /** Doplnění lokality z profilu – jen pro vybrané kontakty. */
    enrich: function (src, contact, profileUrl, ctx) {
      const res = ctx.fetch(profileUrl);
      if (!res.ok) return {};
      const p = parseSrovnaniProfile_(res.text);
      return p.city ? { city: p.city, city_source: 'SROVNANI_PROFIL' } : {};
    },
  },

  jenreality: {
    label: 'JenReality – adresář (vyžaduje písemný souhlas provozovatele)',
    step: function (src, cursor, ctx) {
      cursor = cursor || { stage: 'list', offset: 0 };
      const cfg = safeJsonParse_(src.config_json, {}) || {};
      const detailLimit = cfg.detailLimitPerRun || 150;
      if (cursor.stage === 'list') {
        const res = ctx.fetch(src.base_url.replace(/\/$/, '') + '/adresar-realitnich-kancelari/');
        if (!res.ok) throw sourceError_(res, src.base_url);
        const list = parseJenRealityDirectory_(res.text).items.filter(function (it) { return !ctx.isKnownKey('src:' + it.source_key); });
        ctx.scratch.jenList = list.slice(0, detailLimit).map(function (x) { return x.profile_url + '|' + x.office_name; });
        return { items: [], cursor: { stage: 'detail', offset: 0 }, note: 'adresář: ' + list.length + ' neznámých kanceláří' };
      }
      const list = ctx.scratch.jenList || [];
      if (cursor.offset >= list.length) return { items: [], cursor: null, note: 'hotovo' };
      const parts = list[cursor.offset].split('|');
      const res = ctx.fetch(parts[0]);
      const items = [];
      if (res.ok) {
        const g = parseGenericContactPage_(res.text, parts[0]);
        items.push({
          source_key: 'jenreality:office:' + (parts[0].match(/-(\d+)\/?$/) || [, parts[0]])[1],
          contact_type: looksLikePersonName_(parts[1]) ? 'BROKER' : 'OFFICE',
          full_name: looksLikePersonName_(parts[1]) ? parts[1] : '',
          office_name: parts.slice(1).join('|'),
          email: g.emails[0] || '', phone: g.phones[0] || '', website: g.websites[0] || '',
          city: '', region: '', profile_url: parts[0],
        });
      }
      return { items: items, cursor: { stage: 'detail', offset: cursor.offset + 1 }, note: 'detail ' + (cursor.offset + 1) + '/' + list.length };
    },
  },

  robots_monitor: {
    label: 'Pouze kontrola robots.txt (zdroj automatizaci zakazuje)',
    step: function (src, cursor, ctx) {
      return { items: [], cursor: null, note: 'robots.txt zakazuje přístup – nezpracováno' };
    },
  },

  generic: {
    label: 'Obecný katalog (konfigurace regulárními výrazy v config_json)',
    step: function (src, cursor, ctx) {
      const cfg = safeJsonParse_(src.config_json, null);
      if (!cfg || !cfg.listUrl) throw new Error('Obecný zdroj vyžaduje config_json s listUrl a itemPattern.');
      cursor = cursor || { page: cfg.startPage || 1 };
      const url = cfg.listUrl.replace('{page}', String(cursor.page));
      const res = ctx.fetch(url);
      if (!res.ok) throw sourceError_(res, url);
      const parsed = parseGeneric_(res.text, cfg, url);
      const last = (cfg.startPage || 1) + Math.min(cfg.maxPages || 1, toInt_(src.max_pages, 50)) - 1;
      const next = (parsed.items.length === 0 || cursor.page >= last || cfg.listUrl.indexOf('{page}') < 0) ? null : { page: cursor.page + 1 };
      return { items: parsed.items, cursor: next, note: 'str. ' + cursor.page };
    },
  },
};

function sourceError_(res, url) {
  const e = new Error((res.blockedByRobots ? 'BLOCKED_ROBOTS: ' : 'HTTP: ') + (res.error || ('HTTP ' + res.status)) + ' @ ' + url);
  e.blockedByRobots = !!res.blockedByRobots;
  e.httpStatus = res.status;
  return e;
}

/** Načte zdroje; doplní výchozí, pokud chybí. */
function seedSources_() {
  const t = table_('SOURCES');
  const have = {};
  t.readAll().forEach(function (r) { have[r.source_id] = true; });
  const add = DEFAULT_SOURCES.filter(function (s) { return !have[s.source_id]; }).map(function (s) {
    return Object.assign({ last_checked_at: nowIso_(), last_run_at: '', last_found: '0', total_found: '0' }, s);
  });
  t.append(add);
}

/**
 * Ověří, zda zdroj smí být dnes zpracován. Kontroluje vypínač, podmínky a živý robots.txt.
 * @return {{ok:boolean, status:string, reason:string, robotsStatus:string}}
 */
function sourceGate_(src) {
  const module = SOURCE_MODULES[src.module];
  if (!module) return { ok: false, status: 'ERROR', reason: 'Neznámý modul ' + src.module, robotsStatus: src.robots_status };
  // robots.txt kontrolujeme živě vždy (i u blokovaných zdrojů – kvůli informaci o změně).
  const probeUrl = src.base_url.replace(/\/$/, '') + (src.module === 'ark' ? '/makleri' : src.module === 'srovnani' ? '/realitni-makleri/' : '/');
  let robotsStatus = 'UNKNOWN';
  try {
    const rc = robotsCheck_(probeUrl);
    robotsStatus = rc.allowed ? 'ALLOWED' : (rc.unreachable ? 'UNREACHABLE' : 'DISALLOWED');
  } catch (e) { robotsStatus = 'UNREACHABLE'; }
  const wantsToRun = src.module !== 'robots_monitor' && toBool_(src.enabled) && TOS_OK.indexOf(String(src.tos_status)) >= 0;
  if (robotsStatus === 'UNREACHABLE' && (wantsToRun || src.module === 'robots_monitor')) {
    // Přechodná chyba sítě – nejde o zákaz; pipeline to zkusí znovu.
    return { ok: false, transient: true, status: 'UNAVAILABLE', reason: 'Server zdroje neodpovídá (robots.txt nelze načíst).', robotsStatus: robotsStatus };
  }

  if (src.module === 'robots_monitor') {
    if (robotsStatus === 'ALLOWED') {
      return { ok: false, status: 'ROBOTS_CHANGED_REVIEW', robotsStatus: robotsStatus,
        reason: 'robots.txt nyní přístup povoluje – zkontrolujte podmínky a strukturu webu, než zdroj zapnete s parserem.' };
    }
    return { ok: false, status: 'BLOCKED_ROBOTS', reason: 'robots.txt zakazuje automatizovaný přístup', robotsStatus: robotsStatus };
  }
  if (!toBool_(src.enabled)) return { ok: false, status: src.status || 'DISABLED', reason: 'Zdroj je vypnutý', robotsStatus: robotsStatus };
  if (TOS_OK.indexOf(String(src.tos_status)) < 0) {
    return { ok: false, status: src.tos_status === 'PROHIBITED' ? 'BLOCKED_TOS' : 'NEEDS_TOS_REVIEW', robotsStatus: robotsStatus,
      reason: 'Podmínky zdroje nepovolují / neověřeny (tos_status=' + src.tos_status + ')' };
  }
  if (robotsStatus !== 'ALLOWED') return { ok: false, status: 'BLOCKED_ROBOTS', reason: 'robots.txt zakazuje seznam makléřů', robotsStatus: robotsStatus };
  return { ok: true, status: 'OK', reason: '', robotsStatus: robotsStatus };
}

/** Test konfigurace zdroje z administrace (jen 1. stránka, nic neukládá). */
function testSourceConfig_(src) {
  // Test je povolen i u vypnutého zdroje, ale nikdy při zákazu v robots.txt nebo podmínkách.
  const gate = sourceGate_(Object.assign({}, src, { enabled: 'TRUE' }));
  if (!gate.ok) return { ok: false, gate: gate, items: [] };
  const module = SOURCE_MODULES[src.module];
  const ctx = makeSourceCtx_(src, {});
  const r = module.step(src, null, ctx);
  let items = r.items;
  if (!items.length && r.cursor) items = module.step(src, r.cursor, ctx).items;
  return { ok: true, gate: gate, count: items.length, items: items.slice(0, 10) };
}

function makeSourceCtx_(src, knownKeys) {
  return {
    scratch: {},
    fetch: function (url) { return httpGet_(url, { crawlDelayMs: toInt_(src.crawl_delay_ms, 2000) }); },
    isKnownKey: function (k) { return !!knownKeys[k]; },
  };
}

/**
 * Veřejný registr ARES (Ministerstvo financí, otevřená data) – sídlo a IČO firmy.
 * Volá se jen pro názvy s právní formou; výsledek se použije jen při jednoznačné přesné shodě.
 */
function aresLookup_(companyName) {
  const url = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat';
  const rc = robotsCheck_(url);
  if (!rc.allowed) return null;
  politeWait_(url, 300);
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'User-Agent': P2.USER_AGENT, 'Accept': 'application/json' },
    payload: JSON.stringify({ obchodniJmeno: oneLine_(companyName), pocet: 10 }),
  });
  LAST_HIT_[urlHost_(url)] = Date.now();
  if (resp.getResponseCode() !== 200) return null;
  return pickAresMatch_(safeJsonParse_(resp.getContentText(), {}), companyName);
}
