/**
 * Automatické hodnocení webů. Zjištění vychází výhradně z naměřených faktů (HTTP odpověď, HTML kód,
 * volitelně Google PageSpeed Insights). Každé zjištění nese důkaz (evidence) a míru jistoty.
 * Do e-mailu ({{konkretni_postreh}}) se smí dostat jen zjištění s confidence = HIGH.
 */

/** Najde/ověří web kontaktu. Nikdy nevymýšlí: buď web z katalogu, nebo doména firemního e-mailu, která skutečně odpovídá. */
function websiteCandidates_(c) {
  const out = [];
  if (c.website) out.push({ url: normUrl_(c.website), source: c.website_source || 'CATALOG' });
  const email = normEmail_(c.email);
  const dom = emailDomain_(email);
  if (dom && !isFreemail_(email) && !isFranchise_(dom)) {
    const h = urlHost_(c.website);
    if (!h || h !== dom.replace(/^www\./, '')) out.push({ url: 'https://' + dom + '/', source: 'EMAIL_DOMAIN' });
  }
  return out;
}

/**
 * Načte web: nejdřív HTTPS, při selhání HTTP. Respektuje robots.txt.
 * @return {Object} fetch výsledek rozšířený o httpsTried/httpsOk/httpFallback
 */
function fetchSite_(url) {
  const host = urlHost_(url);
  const path = urlPathAndQuery_(url);
  const httpsUrl = 'https://' + (url.match(/^https?:\/\/([^\/?#]+)/i) || [, host])[1] + path;
  let r = httpGet_(httpsUrl, { retries: 1, crawlDelayMs: 0 });
  r.httpsTried = true;
  r.httpsOk = r.ok && /^https:/i.test(r.finalUrl);
  if (!r.ok && !r.blockedByRobots && r.status === 0) {
    const httpUrl = httpsUrl.replace(/^https:/i, 'http:');
    const r2 = httpGet_(httpUrl, { retries: 1, crawlDelayMs: 0 });
    r2.httpsTried = true;
    r2.httpsOk = r2.ok && /^https:/i.test(r2.finalUrl);
    r2.httpFallback = true;
    r2.httpsError = r.error;
    if (r2.ok || r2.blockedByRobots) return r2;
  }
  return r;
}

/** Volitelné měření Google PageSpeed Insights (mobil). */
function pageSpeedMobile_(url) {
  const key = setting_('PAGESPEED_API_KEY');
  if (!key) return null;
  try {
    const api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=' +
      encodeURIComponent(url) + '&key=' + encodeURIComponent(key);
    const resp = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { error: 'PSI HTTP ' + resp.getResponseCode() };
    const j = JSON.parse(resp.getContentText());
    const lr = j.lighthouseResult || {};
    const perf = lr.categories && lr.categories.performance ? Math.round(lr.categories.performance.score * 100) : null;
    const audits = lr.audits || {};
    const lcp = audits['largest-contentful-paint'] ? audits['largest-contentful-paint'].numericValue : null;
    return { performance: perf, lcpMs: lcp, viewportOk: audits.viewport ? audits.viewport.score === 1 : null };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Čistá analýza HTML a měření.
 * @param {Object} m {url, finalUrl, ok, status, html, elapsedMs, bytes, error, httpsOk, httpFallback, blockedByRobots, psi, nowYear, slowMs}
 * @return {{findings: Array, facts: Object}}
 */
function analyzeSite_(m) {
  const findings = [];
  const facts = {};
  const host = urlHost_(m.finalUrl || m.url);
  const add = function (code, category, severity, confidence, text, evidence, postreh) {
    findings.push({ code: code, category: category, severity: severity, confidence: confidence, text: text, evidence: evidence || '', postreh: postreh || '' });
  };

  if (m.blockedByRobots) {
    facts.analyzable = false;
    add('ROBOTS_BLOCKED', 'functionality', 0, 'HIGH', 'Web zakazuje automatizovanou analýzu (robots.txt) – nehodnoceno.', m.error, '');
    return { findings: findings, facts: facts };
  }
  if (!m.ok) {
    facts.analyzable = false;
    const err = m.status ? 'HTTP ' + m.status : (m.error || 'nedostupný');
    add('UNREACHABLE', 'functionality', 3, 'HIGH', 'Web se nepodařilo načíst (' + err + ').', err,
      'web ' + host + ' se nám při kontrole nepodařilo načíst (' + (m.status ? 'server vrátil chybu ' + m.status : 'server neodpověděl') + ')');
    return { findings: findings, facts: facts };
  }

  const html = String(m.html || '');
  const lower = html.toLowerCase();
  const head = lower.substring(0, Math.max(lower.indexOf('</head>'), 5000));
  const bodyText = htmlToText_(html.replace(/<head[\s\S]*?<\/head>/i, ''));
  facts.analyzable = true;
  facts.status = m.status;
  facts.elapsedMs = m.elapsedMs;
  facts.htmlBytes = m.bytes || html.length;
  facts.textLength = bodyText.length;
  facts.https = !!m.httpsOk;
  facts.finalUrl = m.finalUrl;
  const scriptCount = (lower.match(/<script/g) || []).length;
  const jsOnly = bodyText.length < 250 && scriptCount >= 3;
  facts.jsRendered = jsOnly;

  // --- Funkčnost / zabezpečení ---
  if (!m.httpsOk) {
    add('NO_HTTPS', 'functionality', 2, 'HIGH', 'Web neběží na HTTPS (finální adresa ' + m.finalUrl + ').', m.httpsError || m.finalUrl,
      'web ' + host + ' neběží na zabezpečeném protokolu HTTPS, takže ho prohlížeče označují jako nezabezpečený');
  }
  if (/<embed[^>]+\.swf|<object[^>]+(\.swf|shockwave)/i.test(html)) {
    add('FLASH', 'functionality', 3, 'HIGH', 'Web obsahuje Flash (.swf), který prohlížeče nepodporují.', '.swf',
      'část webu ' + host + ' používá technologii Flash, kterou dnešní prohlížeče už nezobrazí');
  }
  if (/<frameset/i.test(html)) {
    add('FRAMESET', 'design', 3, 'HIGH', 'Web je postavený na rámech (frameset).', '<frameset>',
      'web ' + host + ' je postavený na zastaralé technologii rámů (frameset)');
  }

  // --- Mobilní zobrazení ---
  const vp = head.match(/<meta[^>]+name=["']?viewport["']?[^>]*>/i) || lower.match(/<meta[^>]+name=["']?viewport["']?[^>]*>/i);
  facts.viewport = vp ? vp[0] : '';
  if (!vp) {
    add('NO_VIEWPORT', 'mobile', 3, jsOnly ? 'MEDIUM' : 'HIGH', 'Chybí meta viewport – web nemá mobilní zobrazení.', 'meta viewport nenalezen',
      'web ' + host + ' nemá nastavené zobrazení pro mobilní telefony (chybí značka viewport), takže se na mobilu zobrazuje zmenšená počítačová verze');
  } else if (/width\s*=\s*\d{3,4}/.test(vp[0])) {
    add('FIXED_VIEWPORT', 'mobile', 2, 'HIGH', 'Viewport má pevnou šířku (' + vp[0] + ').', vp[0],
      'web ' + host + ' má pro mobily nastavenou pevnou šířku stránky, takže se nepřizpůsobí displeji telefonu');
  }
  if (m.psi && m.psi.performance !== null && m.psi.performance !== undefined) {
    facts.psiMobilePerformance = m.psi.performance;
    if (m.psi.performance < 50) {
      add('PSI_MOBILE_SLOW', 'speed', 2, 'HIGH', 'Google PageSpeed (mobil): výkon ' + m.psi.performance + '/100.', 'PSI ' + m.psi.performance,
        'Google PageSpeed hodnotí rychlost webu ' + host + ' na mobilu jen ' + m.psi.performance + ' bodů ze 100');
    }
  }

  // --- Rychlost ---
  const slowMs = m.slowMs || 3000;
  if (m.elapsedMs > slowMs) {
    add('SLOW', 'speed', m.elapsedMs > slowMs * 2 ? 3 : 2, 'MEDIUM',
      'Úvodní stránka se načítala ' + (m.elapsedMs / 1000).toFixed(1) + ' s (jedno měření ze serverů Google).', m.elapsedMs + ' ms', '');
  }
  if (facts.htmlBytes > 1500000) {
    add('HEAVY_HTML', 'speed', 1, 'HIGH', 'HTML úvodní stránky má ' + Math.round(facts.htmlBytes / 1024) + ' kB.', facts.htmlBytes + ' B', '');
  }

  // --- Design / zastaralost (fakta z kódu) ---
  const years = [];
  const yre = /(?:©|&copy;|&#169;|copyright)\s*(?:[^<\d]{0,40})?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;
  let ym;
  let yearPos = 0;
  while ((ym = yre.exec(html)) !== null) {
    const y = parseInt(ym[2] || ym[1], 10);
    if (!years.length || y > Math.max.apply(null, years)) yearPos = ym.index;
    years.push(y);
  }
  const nowYear = m.nowYear || new Date().getFullYear();
  if (years.length) {
    const maxYear = Math.max.apply(null, years);
    facts.copyrightYear = maxYear;
    // "v patičce" tvrdíme jen tehdy, když je údaj v <footer> nebo v poslední třetině stránky.
    const footerIdx = lower.lastIndexOf('<footer');
    const inFooter = (footerIdx >= 0 && yearPos > footerIdx) || yearPos > html.length * 0.66;
    if (maxYear <= nowYear - 3 && maxYear >= 1995) {
      add('OLD_COPYRIGHT', 'design', 2, inFooter ? 'HIGH' : 'MEDIUM', 'Copyright uvádí rok ' + maxYear + ' – web pravděpodobně dlouho neaktualizován.', '© ' + maxYear,
        'v patičce webu ' + host + ' je stále uvedený rok ' + maxYear);
    }
  }
  const fontTags = (lower.match(/<font[\s>]/g) || []).length;
  if (fontTags >= 3) add('FONT_TAGS', 'design', 2, 'HIGH', 'Web používá zastaralé značky <font> (' + fontTags + '×).', fontTags + '× <font>', '');
  const tables = (lower.match(/<table/g) || []).length;
  const layoutAttrs = (lower.match(/<(table|td)[^>]+(bgcolor|cellpadding|background=|width=["']?\d)/g) || []).length;
  if (tables >= 3 && layoutAttrs >= 5 && !/<(header|nav|main|section|footer)[\s>]/.test(lower)) {
    add('TABLE_LAYOUT', 'design', 2, 'MEDIUM', 'Rozvržení stránky je pravděpodobně tvořené tabulkami (' + tables + ' tabulek).', tables + ' <table>', '');
  }
  const doctype = (lower.match(/<!doctype[^>]*>/) || [''])[0];
  facts.doctype = doctype;
  if (/html 4\.0|xhtml 1\.0 transitional|html 3\.2/.test(doctype)) {
    add('OLD_DOCTYPE', 'design', 1, 'HIGH', 'Zastaralý typ dokumentu: ' + doctype, doctype, '');
  }
  const jq = lower.match(/jquery[\-.]?(1\.\d+(?:\.\d+)?)(?:\.min)?\.js/);
  if (jq) add('OLD_JQUERY', 'design', 1, 'HIGH', 'Stará knihovna jQuery ' + jq[1] + '.', 'jquery ' + jq[1], '');
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
  if (gen) {
    facts.generator = gen[1];
    const wp = gen[1].match(/WordPress\s+(\d+)\.(\d+)/i);
    const jm = gen[1].match(/Joomla!?\s+(\d+)\.(\d+)/i);
    if ((wp && parseInt(wp[1], 10) < 5) || (jm && parseInt(jm[1], 10) < 3)) {
      add('OLD_CMS', 'functionality', 2, 'HIGH', 'Zastaralá verze redakčního systému: ' + gen[1] + '.', gen[1],
        'web ' + host + ' běží na staré verzi redakčního systému (' + gen[1] + ')');
    }
  }

  // --- Přehlednost ---
  const title = oneLine_(htmlToText_(firstMatch_(html, /<title[^>]*>([\s\S]*?)<\/title>/i)));
  facts.title = truncate_(title, 150);
  if (!title) add('NO_TITLE', 'clarity', 2, 'HIGH', 'Stránka nemá titulek (<title>).', '', '');
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  if (!desc || !oneLine_(desc[1])) add('NO_META_DESCRIPTION', 'clarity', 1, 'HIGH', 'Chybí meta description (popis ve vyhledávačích).', '', '');
  if (!jsOnly && !/<h1[\s>]/.test(lower)) add('NO_H1', 'clarity', 1, 'HIGH', 'Stránka nemá hlavní nadpis H1.', '', '');
  if (!jsOnly && !/<nav[\s>]|<ul[^>]*(menu|nav)|class=["'][^"']*(menu|nav)/.test(lower)) {
    add('NO_NAV', 'clarity', 1, 'MEDIUM', 'Nenalezena zřetelná navigace (menu).', '', '');
  }

  // --- Prezentace služeb / nemovitostí ---
  if (!jsOnly) {
    const plain = stripDiacritics_(bodyText).toLowerCase();
    const kw = (plain.match(/nabidk|nemovitost|prodej|pronajem|byt[uy ]|rodinn|pozem|reference/g) || []).length;
    facts.realEstateKeywords = kw;
    if (kw < 3) add('WEAK_PRESENTATION', 'presentation', 2, 'MEDIUM', 'Na úvodní stránce téměř chybí obsah o nabídce/službách (' + kw + ' klíčových slov).', String(kw), '');
    const imgs = html.match(/<img[^>]*>/gi) || [];
    facts.images = imgs.length;
    const noAlt = imgs.filter(function (i) { return !/\salt=["'][^"']+["']/i.test(i); }).length;
    if (imgs.length < 3) add('FEW_IMAGES', 'presentation', 1, 'MEDIUM', 'Úvodní stránka obsahuje jen ' + imgs.length + ' obrázků.', String(imgs.length), '');
    if (imgs.length >= 5 && noAlt / imgs.length > 0.5) add('MISSING_ALT', 'presentation', 1, 'HIGH', noAlt + ' z ' + imgs.length + ' obrázků nemá popisek (alt).', noAlt + '/' + imgs.length, '');
  }
  if (!/property=["']og:/i.test(html)) add('NO_OPEN_GRAPH', 'professionalism', 1, 'HIGH', 'Chybí Open Graph – sdílení na sociálních sítích nemá náhled.', '', '');
  if (!/href=["']tel:|href=["']mailto:/i.test(html) && !jsOnly) add('NO_CONTACT_LINKS', 'professionalism', 1, 'MEDIUM', 'Na úvodní stránce není klikací telefon ani e-mail.', '', '');

  // --- Doména ---
  if (isOnHostList_(host, FREE_SUBDOMAIN_HOSTS)) {
    add('NO_OWN_DOMAIN', 'domain', 3, 'HIGH', 'Web běží na bezplatné subdoméně ' + host + '.', host,
      'váš web běží na bezplatné subdoméně ' + host + ', ne na vlastní doméně');
  }
  if (jsOnly) add('LIMITED_ANALYSIS', 'design', 0, 'HIGH', 'Web se vykresluje JavaScriptem – analýza obsahu je omezená.', scriptCount + ' skriptů', '');
  return { findings: findings, facts: facts };
}

/** Zjištění na úrovni kontaktu (bez webu, freemail). */
function contactLevelFindings_(c, sourceLabel) {
  const f = [];
  const email = normEmail_(c.email);
  if (!c.website) {
    f.push({ code: 'NO_WEBSITE', category: 'domain', severity: 3, confidence: 'HIGH',
      text: 'Web nebyl nalezen (katalog ho neuvádí a doména e-mailu web nemá / je freemail).', evidence: sourceLabel,
      postreh: 'v katalogu ' + sourceLabel + ' u vás není uvedený žádný web' });
  }
  if (email && isFreemail_(email)) {
    f.push({ code: 'FREEMAIL', category: 'domain', severity: 2, confidence: 'HIGH',
      text: 'Kontaktní e-mail je na freemailu (' + emailDomain_(email) + ').', evidence: email,
      postreh: 'jako kontaktní e-mail používáte adresu na ' + emailDomain_(email) + ', ne na vlastní doméně' });
  }
  return f;
}
