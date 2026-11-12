/**
 * Vestavěné testy – spouští se v Apps Script (menu „Spustit testy systému“ nebo z administrace).
 * Nic neodesílají a nemění data kontaktů. Ověřují logiku i reálné napojení (robots.txt, ARK, Gmail kvóta, triggery).
 */

function runSelfTests_() {
  const results = [];
  const t = function (name, fn) {
    try { const info = fn(); results.push({ name: name, ok: true, info: info === undefined ? '' : String(info) }); }
    catch (e) { results.push({ name: name, ok: false, error: String(e.message || e) }); }
  };
  const eq = function (a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' očekáváno ' + JSON.stringify(b) + ', je ' + JSON.stringify(a)); };
  const ok = function (c, msg) { if (!c) throw new Error(msg || 'podmínka nesplněna'); };

  t('Časová zóna projektu Europe/Prague', function () {
    eq(Session.getScriptTimeZone(), 'Europe/Prague', 'appsscript.json timeZone');
    return todayPrague_() + ' ' + Utilities.formatDate(new Date(), P2.TIMEZONE, 'HH:mm');
  });
  t('robots.txt parser (RFC 9309)', function () {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /trap/\n';
    eq(robotsIsAllowed_(txt, 'ProjectTwoBot', '/makleri').allowed, false);
    eq(robotsIsAllowed_('User-agent: *\nDisallow:\n', 'ProjectTwoBot', '/x').allowed, true);
    eq(robotsIsAllowed_('User-agent: *\nDisallow: *search=\n', 'ProjectTwoBot', '/a?search=1').allowed, false);
    eq(robotsIsAllowed_('User-agent: *\nDisallow: /a\nAllow: /a/b\n', 'ProjectTwoBot', '/a/b/c').allowed, true);
  });
  t('Normalizace a deduplikační klíče', function () {
    eq(normPhone_('+420 733 198 268'), '+420733198268');
    eq(normPhone_('733198268'), '+420733198268');
    eq(splitPersonName_('Ing. Jana Nováková, MBA').first, 'Jana');
    const a = mergeKeysFor_({ source_key: 'ark:broker:1', contact_type: 'BROKER', full_name: 'Ing. Jan Novák', email: 'Jan@Firma.cz', office_name: 'Novák reality s.r.o.' });
    const b = mergeKeysFor_({ source_key: 'srovnani:x', contact_type: 'BROKER', full_name: 'Jan Novák', email: '', office_name: 'Novák Reality' });
    ok(a.some(function (k) { return b.indexOf(k) >= 0; }), 'stejný makléř ze dvou katalogů musí mít společný klíč');
  });
  t('Šablona – proměnné a chybějící údaje', function () {
    const r = renderTemplate_('Dobrý den {{jmeno}} {{prijmeni}}, {{mesto}} {{xyz}}', { jmeno: 'Jan', prijmeni: 'Novák', mesto: '' });
    eq(r.missing, ['mesto']); eq(r.unknown, ['xyz']);
  });
  t('Právní brána – bez souhlasu neodesílat', function () {
    const c = { contact_id: 'P2-T', email: 'a@b.cz' };
    eq(evaluateLegal_(c, { suppression: {}, consents: {}, scope: 's' }).status, 'NEEDS_LEGAL_REVIEW');
    const cons = { 'a@b.cz': [{ consent_id: 'C1', email: 'a@b.cz', legal_basis: 'CONSENT', scope: 's', source: 'formulář', evidence_ref: 'x', obtained_at: '2026-01-01', verified: 'TRUE' }] };
    eq(evaluateLegal_(c, { suppression: {}, consents: cons, scope: 's' }).status, 'AUTHORIZED');
    eq(evaluateLegal_(c, { suppression: { 'a@b.cz': { reason: 'x' } }, consents: cons, scope: 's' }).status, 'SUPPRESSED');
    const bad = { 'a@b.cz': [Object.assign({}, cons['a@b.cz'][0], { verified: 'FALSE' })] };
    eq(evaluateLegal_(c, { suppression: {}, consents: bad, scope: 's' }).status, 'NEEDS_LEGAL_REVIEW');
  });
  t('Hodnocení webu – fakta z HTML', function () {
    const a = analyzeSite_({ url: 'http://x.cz/', finalUrl: 'http://x.cz/', ok: true, status: 200, html: '<html><head><title>X</title></head><body><font>a</font><font>b</font><font>c</font><footer>© 2015</footer></body></html>', elapsedMs: 500, httpsOk: false, nowYear: 2026 });
    const codes = a.findings.map(function (f) { return f.code; });
    ['NO_HTTPS', 'NO_VIEWPORT', 'OLD_COPYRIGHT', 'FONT_TAGS'].forEach(function (c) { ok(codes.indexOf(c) >= 0, 'chybí ' + c); });
    const good = analyzeSite_({ url: 'https://y.cz/', finalUrl: 'https://y.cz/', ok: true, status: 200, httpsOk: true, elapsedMs: 300, nowYear: 2026,
      html: '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Y</title><meta name="description" content="d"><meta property="og:title" content="Y"></head><body><nav class="menu"></nav><h1>Y</h1><p>nabídka nemovitostí prodej byty domy reference</p><img alt="a"><img alt="b"><img alt="c"><a href="tel:1">t</a><footer>© 2026</footer></body></html>' });
    eq(good.findings.filter(function (f) { return f.severity > 0; }).length, 0, 'moderní web nesmí mít nedostatky');
  });
  t('Živý robots.txt – zakázané zdroje', function () {
    const out = [];
    ['https://www.ceskereality.cz/makleri/', 'https://superhome.cz/makleri/'].forEach(function (u) {
      const r = robotsCheck_(u); ok(!r.allowed, u + ' by měl být zakázán'); out.push(urlHost_(u) + ': zakázáno');
    });
    const ark = robotsCheck_('https://www.arkcr.cz/makleri'); ok(ark.allowed, 'ARK by měl být povolen');
    return out.join(', ') + ', arkcr.cz: povoleno';
  });
  t('Živý scraping – ARK 1. stránka', function () {
    const r = httpGet_('https://www.arkcr.cz/makleri', { crawlDelayMs: 0 });
    ok(r.ok, 'HTTP ' + r.status + ' ' + r.error);
    const p = parseArkBrokers_(r.text, 'https://www.arkcr.cz/makleri');
    ok(p.items.length >= 10, 'málo makléřů: ' + p.items.length);
    return p.items.length + ' makléřů, ' + p.maxPage + ' stran';
  });
  t('Gmail kvóta čitelná', function () {
    const q = MailApp.getRemainingDailyQuota();
    ok(q >= 0);
    return 'zbývá ' + q + ' příjemců dnes';
  });
  t('Plánovač (trigger tick) nainstalován', function () {
    ok(triggersInstalled_(), 'trigger chybí – spusťte Inicializaci');
    return ScriptApp.getProjectTriggers().length + ' trigger(ů)';
  });
  t('Listy databáze existují', function () {
    Object.keys(SCHEMA).forEach(function (n) { ok(getSs_().getSheetByName(n), 'chybí list ' + n); });
  });
  t('Bezpečné výchozí nastavení', function () {
    const s = loadSettings_(true);
    return 'TEST_MODE=' + s.TEST_MODE + ', AUTO_SEND_ENABLED=' + s.AUTO_SEND_ENABLED + ', SYSTEM_ENABLED=' + s.SYSTEM_ENABLED;
  });
  const failed = results.filter(function (r) { return !r.ok; }).length;
  return { passed: results.length - failed, failed: failed, results: results, at: nowIso_() };
}
