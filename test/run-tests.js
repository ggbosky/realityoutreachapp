#!/usr/bin/env node
/**
 * Offline testy celého systému (deterministické, simulovaný internet + řízený čas).
 * Spuštění: node test/run-tests.js
 */
'use strict';
const assert = require('assert');
const { createGasEnv } = require('./gas-mock');
const { makeRouter } = require('./fixtures');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); process.stdout.write('  ✓ ' + name + '\n'); }
  catch (e) { results.push({ name, ok: false, e }); process.stdout.write('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 6).join('\n    ') + '\n'); }
}
const deq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
function section(t) { process.stdout.write('\n' + t + '\n'); }

// 07:55 Praha (CET = UTC+1)
function freshEnv(opts = {}) {
  const routerState = opts.routerState || {};
  const env = createGasEnv({ startIso: opts.startIso || '2026-11-12T06:55:00Z', fetchRouter: makeRouter(routerState), ownerEmail: 'owner@example.com', mailQuota: opts.mailQuota });
  env.routerState = routerState;
  env.call('setup');
  return env;
}
function setSetting(env, k, v) { env.eval(`saveSettings_(${JSON.stringify({ [k]: v })})`); }
function contacts(env) { return env.rows('CONTACTS'); }
function byName(env, n) { return contacts(env).find((c) => c.full_name === n || c.office_name === n); }
function enableSrovnani(env) {
  env.eval(`(function(){ const t = table_('SOURCES'); const r = t.readAll().filter(function(x){return x.source_id==='srovnani';})[0];
    t.update(r, { enabled: 'TRUE', tos_status: 'APPROVED', tos_evidence: 'test' }); })()`);
}
function tickUntilDone(env, maxTicks = 30) {
  let last;
  for (let i = 0; i < maxTicks; i++) {
    last = env.fireTrigger();
    const st = env.eval('getRunState_()');
    if (st && (st.phase === 'DONE' || st.phase === 'FAILED')) return st;
    env.clock.advance(10 * 60 * 1000);
  }
  throw new Error('Pipeline nedoběhla: ' + JSON.stringify(env.eval('getRunState_()')));
}
const TEMPLATE = {
  EMAIL_SUBJECT: 'Web pro {{realitni_kancelar}}',
  EMAIL_BODY: 'Dobrý den, pane/paní {{prijmeni}},\n\nprošli jsme váš web {{url_webu}} a všimli jsme si, že {{konkretni_postreh}}.\nPomáháme makléřům v {{mesto}} s moderními weby.',
  EMAIL_SIGNATURE: 'S pozdravem\n{{odesilatel}}',
  SENDER_NAME: 'Test Odesílatel',
  SENDER_IDENTIFICATION: 'Project Two s.r.o., IČO 12345678, Praha',
  WEBAPP_URL: 'https://script.google.com/macros/s/TEST/exec',
};
function applyTemplate(env) { env.eval(`saveSettings_(${JSON.stringify(TEMPLATE)})`); }
function addConsent(env, email, extra = {}) {
  return env.eval(`(function(){ var r = apiAddConsent(${JSON.stringify(Object.assign({ email, legal_basis: 'CONSENT', scope: 'project_two_web_services', source: 'webový formulář', evidence_ref: 'FORM-123', obtained_at: '2026-10-01', verified: true }, extra))}); if (!r.ok) throw new Error(r.error); return r.data; })()`);
}

/* =============================== UNIT =============================== */
section('Jednotkové testy');
const U = createGasEnv({ startIso: '2026-11-12T07:00:00Z' });

test('robots.txt: ceskereality vzor (dvě skupiny *) = zakázáno', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /bot-trap-8f3c17a2/\n';
  assert.strictEqual(U.call('robotsIsAllowed_', txt, 'ProjectTwoBot', '/realitni-makleri/').allowed, false);
});
test('robots.txt: superhome vzor = zakázáno, ARK = povoleno, srovnání: ajaxDialog zakázán', () => {
  assert.strictEqual(U.call('robotsIsAllowed_', 'User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nUser-agent: Googlebot\nAllow: /\n', 'ProjectTwoBot', '/').allowed, false);
  assert.strictEqual(U.call('robotsIsAllowed_', 'User-agent: *\nDisallow:\n', 'ProjectTwoBot', '/makleri?page=3').allowed, true);
  const s = 'User-Agent: *\nAllow: /\nDisallow: *do=ajaxDialog\nDisallow: *search=\n';
  assert.strictEqual(U.call('robotsIsAllowed_', s, 'ProjectTwoBot', '/realitni-makleri/?contentId=7&do=ajaxDialog').allowed, false);
  assert.strictEqual(U.call('robotsIsAllowed_', s, 'ProjectTwoBot', '/realitni-makleri/?paginator-page=2').allowed, true);
});
test('robots.txt: specifická skupina pro náš bot má přednost, $ a * fungují', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: ProjectTwoBot\nAllow: /makleri\nDisallow: /*.pdf$\n';
  assert.strictEqual(U.call('robotsIsAllowed_', txt, 'ProjectTwoBot', '/makleri').allowed, true);
  assert.strictEqual(U.call('robotsIsAllowed_', txt, 'ProjectTwoBot', '/a/b.pdf').allowed, false);
  assert.strictEqual(U.call('robotsIsAllowed_', txt, 'ProjectTwoBot', '/a/b.pdf?x=1').allowed, true);
});
test('normalizace: telefon, e-mail, URL, jméno s tituly', () => {
  assert.strictEqual(U.call('normPhone_', '420 800 123 555'), '+420800123555');
  assert.strictEqual(U.call('normEmail_', 'MAILTO:Info@Firma.CZ?subject=x'), 'info@firma.cz');
  assert.strictEqual(U.call('normUrl_', 'www.firma.cz'), 'http://www.firma.cz/');
  const n = U.call('splitPersonName_', 'Mgr. Ing. Jana Nováková, Ph.D.');
  deq([n.first, n.last], ['Jana', 'Nováková']);
  assert.strictEqual(U.call('looksLikePersonName_', 'Adam Gombos'), true);
  assert.strictEqual(U.call('looksLikePersonName_', 'Malá Reality s.r.o.'), false);
});
test('šablona: proměnné, chybějící a neznámé proměnné', () => {
  const r = U.call('renderTemplate_', 'Ahoj {{jmeno}} z {{ mesto }}, {{neznama}}', { jmeno: 'Jan', mesto: '' });
  assert.strictEqual(r.text, 'Ahoj Jan z {{ mesto }}, {{neznama}}');
  deq(r.missing, ['mesto']);
  deq(r.unknown, ['neznama']);
});
test('hodnocení webu: starý web → konkrétní fakta, moderní web → bez nedostatků', () => {
  const { OLD_SITE, MODERN_SITE } = require('./fixtures');
  const a = U.call('analyzeSite_', { url: 'http://x.cz/', finalUrl: 'http://x.cz/', ok: true, status: 200, html: OLD_SITE, elapsedMs: 4200, httpsOk: false, nowYear: 2026, slowMs: 3000 });
  const codes = a.findings.map((f) => f.code);
  ['NO_HTTPS', 'NO_VIEWPORT', 'OLD_COPYRIGHT', 'FONT_TAGS', 'TABLE_LAYOUT', 'OLD_DOCTYPE', 'OLD_JQUERY', 'SLOW'].forEach((c) => assert(codes.includes(c), 'chybí ' + c + ' v ' + codes));
  const oc = a.findings.find((f) => f.code === 'OLD_COPYRIGHT');
  assert.strictEqual(oc.confidence, 'HIGH'); assert(/2016/.test(oc.postreh));
  const g = U.call('analyzeSite_', { url: 'https://y.cz/', finalUrl: 'https://y.cz/', ok: true, status: 200, html: MODERN_SITE, elapsedMs: 300, httpsOk: true, nowYear: 2026, slowMs: 3000 });
  deq(g.findings.filter((f) => f.severity > 0).map((f) => f.code), []);
  const s1 = U.call('webQualityScore_', a.findings, a.facts, true).score;
  const s2 = U.call('webQualityScore_', g.findings, g.facts, true).score;
  assert(s1 < 45 && s2 === 100, 'skóre starý=' + s1 + ' moderní=' + s2);
});
test('hodnocení webu: nevymýšlí – JS web bez obsahu nemá tvrzení o obsahu, © mimo patičku je jen orientační', () => {
  const js = '<html><head><title>x</title></head><body><div id="app"></div><script></script><script></script><script></script></body></html>';
  const a = U.call('analyzeSite_', { url: 'https://z.cz/', finalUrl: 'https://z.cz/', ok: true, status: 200, html: js, elapsedMs: 200, httpsOk: true, nowYear: 2026 });
  const codes = a.findings.map((f) => f.code);
  assert(!codes.includes('WEAK_PRESENTATION') && !codes.includes('NO_H1') && codes.includes('LIMITED_ANALYSIS'));
  assert.strictEqual(a.findings.find((f) => f.code === 'NO_VIEWPORT').confidence, 'MEDIUM');
  const top = '<html><body><p>© 2015 foto</p>' + 'x'.repeat(5000) + '</body></html>';
  const b = U.call('analyzeSite_', { url: 'https://z.cz/', finalUrl: 'https://z.cz/', ok: true, status: 200, html: top, elapsedMs: 200, httpsOk: true, nowYear: 2026 });
  assert.strictEqual(b.findings.find((f) => f.code === 'OLD_COPYRIGHT').confidence, 'MEDIUM');
  assert.strictEqual(U.call('pickPostreh_', b.findings.filter((f) => f.code === 'OLD_COPYRIGHT')), '');
});
test('právní brána: každá podmínka souhlasu se vyžaduje', () => {
  const c = { contact_id: 'P2-1', email: 'a@b.cz' };
  const good = { consent_id: 'C', email: 'a@b.cz', legal_basis: 'CONSENT', scope: 'sc', source: 'form', evidence_ref: 'e', obtained_at: '2026-01-01', verified: 'TRUE' };
  const ev = (cons, sup) => U.call('evaluateLegal_', c, { suppression: sup || {}, consents: { 'a@b.cz': cons }, scope: 'sc' }).status;
  assert.strictEqual(ev([good]), 'AUTHORIZED');
  assert.strictEqual(ev([]), 'NEEDS_LEGAL_REVIEW');
  for (const bad of [{ legal_basis: 'PUBLIC_EMAIL' }, { scope: 'jiny' }, { source: '' }, { evidence_ref: '' }, { obtained_at: '' }, { verified: 'FALSE' }, { withdrawn_at: '2026-02-01' }, { valid_until: '2026-01-31' }, { contact_id: 'P2-9' }]) {
    assert.strictEqual(ev([Object.assign({}, good, bad)]), 'NEEDS_LEGAL_REVIEW', JSON.stringify(bad));
  }
  assert.strictEqual(ev([good], { '@b.cz': { reason: 'doména' } }), 'SUPPRESSED');
  assert.strictEqual(U.call('evaluateLegal_', { email: '' }, { suppression: {}, consents: {}, scope: 'sc' }).status, 'NO_EMAIL');
});

/* =========================== INTEGRACE =========================== */
section('Integrace: plánovač + sken + deduplikace + audit');
const E = freshEnv();
enableSrovnani(E);

test('plánovač: jeden trigger tick každých 10 min, časová zóna Europe/Prague', () => {
  assert.strictEqual(E.triggers.length, 1);
  deq([E.triggers[0]._t.fn, E.triggers[0]._t.minutes], ['tick', 10]);
  const manifest = JSON.parse(require('fs').readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));
  assert.strictEqual(manifest.timeZone, 'Europe/Prague');
});
test('plánovač: v 07:55 se sken nespustí', () => {
  E.fireTrigger();
  assert.strictEqual(E.eval('getRunState_()'), null);
});
let state1;
test('plánovač: v 08:00 se spustí sken a doběhne přes checkpointy', () => {
  E.clock.set('2026-11-12T07:00:00Z');
  state1 = tickUntilDone(E);
  assert.strictEqual(state1.phase, 'DONE', JSON.stringify(state1));
  assert.strictEqual(state1.runId, '2026-11-12');
});
test('zdroje: blokované robots.txt nejsou staženy, JenReality blokováno podmínkami, ostatní OK', () => {
  const sr = state1.sourceResults;
  assert.strictEqual(sr.ceskereality.status, 'BLOCKED_ROBOTS');
  assert.strictEqual(sr.superhome.status, 'BLOCKED_ROBOTS');
  assert.strictEqual(sr.jenreality.status, 'BLOCKED_TOS');
  assert.strictEqual(sr.ark.status, 'OK');
  assert.strictEqual(sr.srovnani.status, 'OK');
  const hits = Object.keys(E.routerState.hits);
  assert(!hits.some((u) => /ceskereality\.cz\/(?!robots)/.test(u)), 'ceskereality stažen');
  assert(!hits.some((u) => /superhome\.cz\/(?!robots)/.test(u)), 'superhome stažen');
  assert(!hits.some((u) => /jenreality\.cz\/(?!robots)/.test(u)), 'jenreality stažen');
  assert(!hits.some((u) => /seznam\.cz/.test(u)), 'freemail doména nesmí být brána jako web');
});
test('ukládání: unikátní ID, povinná pole, datum a zdroj', () => {
  const cs = contacts(E);
  const ids = cs.map((c) => c.contact_id);
  assert.strictEqual(new Set(ids).size, ids.length);
  ids.forEach((id) => assert(/^P2-\d{6}$/.test(id)));
  cs.forEach((c) => { assert(c.sources); assert(c.first_seen_at.startsWith('2026-11-12')); assert(c.source_profile_urls); assert(c.legal_status); });
});
test('deduplikace: duplicitní makléř v katalogu = 1 záznam; stejný makléř ze 2 katalogů sloučen', () => {
  const cs = contacts(E);
  assert.strictEqual(cs.filter((c) => c.full_name === 'Jan Svoboda').length, 1);
  const novak = cs.filter((c) => /Novák/.test(c.full_name));
  assert.strictEqual(novak.length, 1, JSON.stringify(novak.map((c) => c.full_name)));
  assert.strictEqual(novak[0].sources.split(',').sort().join(','), 'ark,srovnani');
  assert.strictEqual(novak[0].full_name, 'Pavel Novák');
  assert(novak[0].source_profile_urls.includes('srovnani-makleru.cz') && novak[0].source_profile_urls.includes('arkcr.cz'));
  // kancelář s makléři není další kontakt, kancelář bez makléřů ano
  assert(!cs.some((c) => c.contact_type === 'OFFICE' && c.office_name === 'Malá Reality s.r.o.'));
  assert(cs.some((c) => c.contact_type === 'OFFICE' && c.office_name === 'Office Only s.r.o.'));
  // sdílený e-mail
  assert.strictEqual(byName(E, 'Karel Malý').email_shared, 'TRUE');
  assert.strictEqual(byName(E, 'Jan Svoboda').office_size, '1', 'duplicitní záznam nesmí zvýšit velikost kanceláře');
  assert.strictEqual(byName(E, 'Petra Malá').office_size, '3');
  // nová osoba ze srovnání – lokalita doplněna z profilu
  assert.strictEqual(byName(E, 'Nová Osoba').city, 'Olomouc');
});
test('výběr: samostatní makléři mají vyšší prioritu než franšíza', () => {
  assert(+byName(E, 'Jan Svoboda').pre_priority > +byName(E, 'Robert Franšíza').pre_priority);
  assert(/samostatný/.test(byName(E, 'Jan Svoboda').priority_reasons));
  assert(/franšíza/.test(byName(E, 'Robert Franšíza').priority_reasons));
});
test('audit: starý web (HTTP fallback, pomalý, bez mobilu) vs moderní vs nedostupný vs robots vs bez webu', () => {
  const sv = byName(E, 'Jan Svoboda');
  const f = JSON.parse(sv.findings_json).map((x) => x.code);
  ['NO_HTTPS', 'NO_VIEWPORT', 'OLD_COPYRIGHT', 'SLOW'].forEach((c) => assert(f.includes(c), c + ' / ' + f));
  assert(+sv.web_score < 45 && +sv.potential_score >= 70, sv.web_score + '/' + sv.potential_score);
  assert.strictEqual(sv.high_potential, 'TRUE');
  assert(/redesign/i.test(sv.recommended_service));
  const mala = byName(E, 'Petra Malá');
  assert.strictEqual(mala.web_score, '100'); assert(+mala.potential_score < 50);
  const big = byName(E, 'Tomáš Velký');
  assert(JSON.parse(big.findings_json).some((x) => x.code === 'UNREACHABLE' && /500/.test(x.text)));
  const rb = byName(E, 'Ondřej Tichý');
  assert.strictEqual(rb.audit_status, 'ROBOTS_BLOCKED'); assert.strictEqual(rb.web_score, '');
  const novak = byName(E, 'Pavel Novák');
  const nf = JSON.parse(novak.findings_json).map((x) => x.code);
  assert(nf.includes('NO_WEBSITE') && nf.includes('FREEMAIL'));
  const oo = byName(E, 'Office Only s.r.o.');
  assert.strictEqual(oo.website_source, 'EMAIL_DOMAIN'); assert.strictEqual(oo.website, 'https://www.officeonly.cz/');
  const wn = byName(E, 'Petr Webnode');
  assert(JSON.parse(wn.findings_json).some((x) => x.code === 'NO_OWN_DOMAIN')); assert.strictEqual(wn.own_domain, 'FALSE');
});
test('právní status: bez souhlasu NEEDS_LEGAL_REVIEW, bez e-mailu NO_EMAIL; nic odesláno', () => {
  const cs = contacts(E);
  cs.filter((c) => c.email).forEach((c) => assert.strictEqual(c.legal_status, 'NEEDS_LEGAL_REVIEW', c.full_name));
  assert.strictEqual(byName(E, 'Lenka Bezmailová').legal_status, 'NO_EMAIL');
  assert.strictEqual(E.sentMail.length, 0);
});
test('kampaň zaznamenána, nedostatek kontaktů má zapsaný důvod', () => {
  const camp = E.rows('CAMPAIGNS')[0];
  assert.strictEqual(camp.status, 'DONE');
  assert(+camp.new_contacts > 0 && +camp.new_contacts < 100);
  assert(/Nalezeno jen/.test(camp.shortfall_reason) && /ceskereality/.test(camp.shortfall_reason), camp.shortfall_reason);
});

section('E-maily, právní blokace, suppression, kvóty');
test('bez šablony: koncepty MISSING_DATA (žádná pevná šablona v kódu)', () => {
  const sv = byName(E, 'Jan Svoboda');
  assert.strictEqual(sv.draft_status, 'MISSING_DATA');
  assert(/EMAIL_BODY/.test(sv.draft_missing));
});
test('personalizace: šablona vyplněna fakty konkrétního makléře', () => {
  applyTemplate(E);
  E.eval('refreshLegalStatuses_(true)');
  const sv = byName(E, 'Jan Svoboda');
  assert.strictEqual(sv.draft_status, 'DRAFT_INTERNAL', sv.draft_missing);
  assert(sv.draft_body.includes('pane/paní Svoboda'));
  assert(sv.draft_body.includes('www.svoboda-reality.cz'));
  assert(sv.draft_body.includes('Havířov'));
  assert(/nemá nastavené zobrazení pro mobilní telefony|neběží na zabezpečeném/.test(sv.draft_body), sv.draft_body);
  assert(sv.draft_body.includes('Project Two s.r.o., IČO 12345678'));
  assert(/action=unsubscribe&c=P2-\d+&t=[a-f0-9]{32}/.test(sv.draft_body));
  assert.strictEqual(sv.draft_subject, 'Web pro Jan Svoboda');
});
test('personalizace: chybí-li údaj (OFFICE bez příjmení), zpráva je MISSING_DATA', () => {
  const oo = byName(E, 'Office Only s.r.o.');
  assert.strictEqual(oo.draft_status, 'MISSING_DATA', oo.draft_status + ' / pot ' + oo.potential_score); assert(/prijmeni/.test(oo.draft_missing));
});
test('zákonné náležitosti: bez označení „obchodní sdělení“ / identifikace / odhlášení se zpráva nepřipraví', () => {
  const orig = E.eval(`setting_('EMAIL_FOOTER')`);
  assert.throws(() => setSetting(E, 'EMAIL_FOOTER', 'Bez odkazu {{identifikace_odesilatele}}'), /odhlaseni_url/);
  assert.throws(() => setSetting(E, 'EMAIL_FOOTER', 'Odhlášení {{odhlaseni_url}}'), /identifikace_odesilatele/);
  setSetting(E, 'EMAIL_FOOTER', 'Odesílatel: {{identifikace_odesilatele}} Odhlášení: {{odhlaseni_url}}');
  const c = byName(E, 'Jan Svoboda');
  const m = E.eval(`buildEmail_(table_('CONTACTS').readAll().filter(function(x){return x.contact_id==='${c.contact_id}';})[0])`);
  assert(m.problems.some((p) => /obchodní sdělení/.test(p)), JSON.stringify(m.problems));
  setSetting(E, 'EMAIL_FOOTER', orig);
});
test('test mode + auto send: nic se neodešle, vše se zaloguje', () => {
  addConsent(E, 'jan@svoboda-reality.cz');
  addConsent(E, 'novak@seznam.cz');
  E.eval(`apiAddSuppression('novak@seznam.cz', 'nechce')`);
  setSetting(E, 'AUTO_SEND_ENABLED', 'TRUE');
  E.clock.set('2026-11-12T09:05:00Z'); // 10:05 Praha
  E.fireTrigger();
  assert.strictEqual(E.sentMail.length, 0);
  const log = E.rows('EMAIL_LOG');
  assert(log.some((l) => l.status === 'TEST_NOT_SENT' && l.email === 'jan@svoboda-reality.cz'), JSON.stringify(log));
  assert(!log.some((l) => l.email === 'novak@seznam.cz' && l.status !== 'BLOCKED_SUPPRESSION'));
});
test('suppression má přednost i před platným souhlasem; souhlas se odvolá', () => {
  const n = byName(E, 'Pavel Novák');
  assert.strictEqual(n.legal_status, 'SUPPRESSED');
  assert(E.rows('LEGAL_CONSENTS').find((c) => c.email === 'novak@seznam.cz').withdrawn_at);
  assert.throws(() => addConsent(E, 'novak@seznam.cz'), /SUPPRESSION/);
});
test('ostrý režim: odešle se jen kontaktu s doloženým oprávněním, s patičkou a odhlášením', () => {
  E.eval(`(function(){ var r = apiSaveAutomation({TEST_MODE:'FALSE', confirmLive:true}); if(!r.ok) throw new Error(r.error); })()`);
  E.clock.set('2026-11-13T09:05:00Z');
  E.eval(`PropertiesService.getScriptProperties().setProperty('P2_LAST_SCAN_START','2026-11-13')`); // sken dnes neřešíme
  E.eval(`saveSettings_({DAILY_SCAN_ENABLED:'FALSE'})`);
  E.fireTrigger();
  assert.strictEqual(E.sentMail.length, 1, JSON.stringify(E.sentMail.map((m) => m.to)));
  const m = E.sentMail[0];
  assert.strictEqual(m.to, 'jan@svoboda-reality.cz');
  assert(/Odesílatel: Project Two s\.r\.o\./.test(m.body) && /action=unsubscribe/.test(m.body));
  assert.strictEqual(m.options.name, 'Test Odesílatel');
  const sv = byName(E, 'Jan Svoboda');
  assert.strictEqual(sv.status, 'CONTACTED'); assert.strictEqual(sv.draft_status, 'SENT'); assert.strictEqual(sv.emails_sent, '1');
  assert(/ODESLÁNO/.test(sv.communication_history));
  const sentLog = E.rows('EMAIL_LOG').filter((l) => l.status === 'SENT');
  assert.strictEqual(sentLog.length, 1); assert(sentLog[0].legal_ref.startsWith('CONS-'));
});
test('ochrana proti duplicitě: další tick ani ruční spuštění neodešle znovu', () => {
  E.eval(`PropertiesService.getScriptProperties().deleteProperty('P2_LAST_SEND_COMPLETE')`);
  E.fireTrigger();
  E.eval('apiRunSendNow()');
  // i kdyby někdo vrátil koncept do READY, adresa už sdělení dostala
  E.eval(`(function(){ var t=table_('CONTACTS'); var c=t.readAll().filter(function(x){return x.email==='jan@svoboda-reality.cz';})[0]; t.update(c,{draft_status:'READY'}); })()`);
  E.eval('apiRunSendNow()');
  assert.strictEqual(E.sentMail.length, 1);
});
test('osiřelý PENDING (pád během odeslání) → UNCERTAIN, nikdy znovu neodeslán', () => {
  const c = byName(E, 'Petra Malá');
  addConsent(E, 'petra@mala-reality.cz');
  E.eval(`(function(){ var t=table_('CONTACTS'); var c=t.readAll().filter(function(x){return x.email==='petra@mala-reality.cz';})[0]; t.update(c,{draft_status:'READY', legal_status:'AUTHORIZED'});
    table_('EMAIL_LOG').append([{log_id:'L-crash', idempotency_key:'LIVE|petra@mala-reality.cz|project_two_web_services|1', contact_id:'${c.contact_id}', email:'petra@mala-reality.cz', mode:'LIVE', status:'PENDING', created_at:'2026-11-13T09:00:00', updated_at:''}]); })()`);
  E.clock.set('2026-11-13T10:00:00Z');
  E.eval('apiRunSendNow()');
  assert.strictEqual(E.sentMail.filter((m) => m.to === 'petra@mala-reality.cz').length, 0);
  assert.strictEqual(E.rows('EMAIL_LOG').find((l) => l.log_id === 'L-crash').status, 'UNCERTAIN');
});
test('Gmail kvóta: při vyčerpání se odesílání pozastaví', () => {
  addConsent(E, 'tomas@bigcorp.cz');
  E.setQuota(4); // rezerva 5 → nic
  const r = E.eval('apiRunSendNow()').data;
  assert.strictEqual(r.stoppedBy, 'GMAIL_QUOTA');
  assert.strictEqual(E.sentMail.filter((m) => m.to === 'tomas@bigcorp.cz').length, 0);
  assert(E.rows('ERROR_LOG').some((e) => /kvóta/.test(e.message)));
  E.setQuota(100);
});
test('denní limit odesílání je dodržen', () => {
  setSetting(E, 'DAILY_SEND_LIMIT', '1'); // dnes už 1 SENT (13.11. je jiný den než první odeslání? ověřit)
  const sentToday = E.rows('EMAIL_LOG').filter((l) => l.status === 'SENT' && l.created_at.startsWith('2026-11-13')).length;
  const before = E.sentMail.length;
  E.eval('apiRunSendNow()');
  assert.strictEqual(E.sentMail.length - before, Math.max(0, 1 - sentToday));
  setSetting(E, 'DAILY_SEND_LIMIT', '20');
});
test('chyba při odeslání: FAILED se zaloguje, žádný pád, bez duplicity', () => {
  E.failSend = 'Exception: Mail service unavailable';
  const before = E.sentMail.length;
  const r = E.eval('apiRunSendNow()').data;
  assert.strictEqual(r.failed, 1, JSON.stringify(r));
  const failed = E.rows('EMAIL_LOG').filter((l) => l.status === 'FAILED');
  assert(failed.length >= 1);
  E.eval('apiRunSendNow()'); // opakování po technické chybě
  const toms = E.sentMail.filter((m) => m.to === 'tomas@bigcorp.cz').length;
  assert(toms <= 1, 'duplicitní odeslání');
  assert(E.sentMail.length >= before);
});
test('odhlášení odkazem: platný token → SUPPRESSION; neplatný token odmítnut', () => {
  const sv = byName(E, 'Jan Svoboda');
  const url = sv.draft_body.match(/https:\/\/script\.google\.com\S+/)[0];
  const q = Object.fromEntries(new URL(url).searchParams);
  const page = E.call('doGet', { parameter: q });
  assert(/Odhlásit se/.test(page.getContent()));
  const bad = E.call('doGet', { parameter: Object.assign({}, q, { t: 'ab'.repeat(16) }) });
  assert(/neplatný/.test(bad.getContent()));
  assert.strictEqual(E.call('publicUnsubscribe', q.c, 'ab'.repeat(16)).ok, false);
  assert.strictEqual(E.call('publicUnsubscribe', q.c, q.t).ok, true);
  assert(E.rows('SUPPRESSION').some((s) => s.email === 'jan@svoboda-reality.cz' && s.source === 'UNSUBSCRIBE_LINK'));
  assert.strictEqual(byName(E, 'Jan Svoboda').status, 'SUPPRESSED');
});
test('odpověď „nemám zájem“ v Gmailu → SUPPRESSION; běžná odpověď → REPLIED', () => {
  // Tomáš (pokud byl odeslán) odpoví
  const sent = E.sentMail.find((m) => m.to === 'tomas@bigcorp.cz');
  assert(sent, 'předpoklad: Tomášovi byl e-mail odeslán (po obnovení kvóty)');
  if (sent) {
    const th = E.gmailThreads.find((t) => t.id === sent.threadId);
    th.messages.push({ from: 'Tomáš <tomas@bigcorp.cz>', body: 'Dobrý den, nemám zájem, děkuji.', date: E.clock.Date.now() + 1000 });
  }
  E.clock.advance(2 * 3600 * 1000);
  E.eval(`PropertiesService.getScriptProperties().setProperty('P2_LAST_INBOX_CHECK','0')`);
  const out = E.eval('runInboxMonitor_(Date.now()+60000)');
  if (sent) { assert.strictEqual(out.unsubscribed, 1); assert(E.rows('SUPPRESSION').some((s) => s.email === 'tomas@bigcorp.cz' && s.source === 'REPLY')); }
});
test('administrace: anonymní uživatel nemá přístup k API ani stránce', () => {
  E.activeUser = '';
  assert.throws(() => E.eval('apiDashboard()'), /Přístup odepřen/);
  assert(/Přístup odepřen/.test(E.call('doGet', { parameter: {} }).getContent()));
  E.activeUser = 'owner@example.com';
  const d = E.eval('apiDashboard()');
  assert(d.ok && d.data.totals.total > 0);
});
test('bezpečnost: veřejné funkce nejdou zneužít z anonymní web aplikace', () => {
  E.activeUser = '';
  for (const fn of ['setup', 'menuStop', 'menuRunScan', 'menuRunTests', 'openAdmin']) assert.throws(() => E.call(fn), /Přístup odepřen/, fn);
  assert.throws(() => E.call('tick'), /Přístup odepřen/);
  assert.throws(() => E.call('tick', { triggerUid: 'trig-podvrh' }), /Přístup odepřen/);
  E.activeUser = 'owner@example.com';
  E.eval('installTriggers_()');
  const r = E.fireTrigger();
  assert(!r.skipped || /SYSTEM/.test(r.skipped), JSON.stringify(r));
  assert.strictEqual(E.eval(`setting_('SYSTEM_ENABLED')`), 'TRUE');
});
test('administrace: zdroj nelze zapnout bez ověřených podmínek', () => {
  const r = E.eval(`apiSaveSource({source_id:'jenreality', enabled:'TRUE', tos_status:'PROHIBITED'})`);
  assert.strictEqual(r.ok, false); assert(/podmínkami|tos_status/.test(r.error));
});
test('vypnutí testovacího režimu vyžaduje potvrzení', () => {
  setSetting(E, 'TEST_MODE', 'TRUE');
  assert.strictEqual(E.eval(`apiSaveAutomation({TEST_MODE:'FALSE'})`).ok, false);
});

section('Odolnost: přerušení, chyby, STOP, opakované dny');
test('druhý den: stejné katalogy → žádné duplicity, zaznamenán důvod', () => {
  const env = freshEnv();
  tickUntilDone((env.clock.set('2026-11-12T07:01:00Z'), env));
  const n1 = contacts(env).length;
  env.clock.set('2026-11-13T07:01:00Z');
  const st = tickUntilDone(env);
  assert.strictEqual(contacts(env).length, n1);
  assert.strictEqual(st.counters.new, 0);
  assert(st.counters.existingSeen > 0);
  assert(/Nalezeno jen 0/.test(st.shortfall));
  // nový makléř v katalogu → právě 1 nový kontakt
  env.routerState.extraBrokers = [require('./fixtures').makeRouter && `<li id="broker-999" class="p"><div class="text-base font-semibold text-gray-900">Nový Makléř</div><a href="mailto:novy@makler.cz">x</a></li>`];
  env.clock.set('2026-11-14T07:01:00Z');
  const st3 = tickUntilDone(env);
  assert.strictEqual(st3.counters.new, 1);
  assert.strictEqual(contacts(env).length, n1 + 1);
});
test('GDPR: smazaný kontakt v SUPPRESSION se při dalším skenu znovu neuloží', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z'); tickUntilDone(env);
  const n = contacts(env).length;
  env.eval(`apiAddSuppression('petra@mala-reality.cz', 'žádost o výmaz')`);
  env.eval(`(function(){ var t=table_('CONTACTS'); var c=t.readAll().filter(function(x){return x.email==='petra@mala-reality.cz';})[0]; t.deleteRow(c); })()`);
  env.clock.set('2026-11-13T07:01:00Z');
  const st = tickUntilDone(env);
  assert.strictEqual(contacts(env).length, n - 1);
  assert(!contacts(env).some((c) => c.email === 'petra@mala-reality.cz'));
  assert.strictEqual(st.counters.suppressedSkipped, 1);
});
test('denní limit 100 (zde 3): vybere se jen cílový počet, zbytek zůstane na další dny', () => {
  const env = freshEnv();
  env.eval(`saveSettings_({DAILY_CONTACT_TARGET:'3'})`);
  env.clock.set('2026-11-12T07:01:00Z');
  tickUntilDone(env);
  assert.strictEqual(contacts(env).length, 3);
  env.clock.set('2026-11-13T07:01:00Z');
  tickUntilDone(env);
  assert.strictEqual(contacts(env).length, 6);
  const ids = contacts(env).map((c) => c.contact_id);
  assert.strictEqual(new Set(ids).size, 6);
});
test('výpadek zdroje (503) → zdroj označen jako nedostupný, běh pokračuje dalšími zdroji', () => {
  const env = freshEnv({ routerState: { arkDown: true } });
  enableSrovnani(env);
  env.clock.set('2026-11-12T07:01:00Z');
  const st = tickUntilDone(env);
  assert.strictEqual(st.sourceResults.ark.status, 'UNAVAILABLE');
  assert.strictEqual(st.sourceResults.srovnani.status, 'OK');
  assert(contacts(env).length >= 2);
  assert(env.rows('ERROR_LOG').some((e) => e.source === 'ark'));
});
test('přerušení uprostřed (síťové chyby + limit času exekuce) → navázání bez ztrát a duplicit', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z');
  env.eval('P2.EXEC_BUDGET_MS = 700'); // velmi krátké exekuce → mnoho checkpointů
  env.failNextFetches = 2;
  let ticks = 0;
  let st;
  for (; ticks < 200; ticks++) {
    env.fireTrigger();
    st = env.eval('getRunState_()');
    if (st && (st.phase === 'DONE' || st.phase === 'FAILED')) break;
    env.clock.advance(10 * 60 * 1000);
    if (ticks === 5) env.failNextFetches = 1;
  }
  assert.strictEqual(st.phase, 'DONE', 'fáze ' + st.phase);
  assert(ticks > 3, 'mělo proběhnout víc exekucí: ' + ticks);
  const ref = freshEnv(); ref.clock.set('2026-11-12T07:01:00Z'); tickUntilDone(ref);
  assert.strictEqual(contacts(env).length, contacts(ref).length);
  const keys = contacts(env).map((c) => c.full_name + '|' + c.office_name);
  assert.strictEqual(new Set(keys).size, keys.length);
});
test('opakovaná chyba fáze → po 5 pokusech FAILED a záznam v kampani (žádná nekonečná smyčka)', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z');
  env.eval('phaseSelect_ = function(){ throw new Error("simulovaná chyba"); }');
  let st;
  for (let i = 0; i < 20; i++) { env.fireTrigger(); st = env.eval('getRunState_()'); if (st.phase === 'FAILED') break; env.clock.advance(600000); }
  assert.strictEqual(st.phase, 'FAILED');
  assert(env.rows('ERROR_LOG').some((e) => e.severity === 'CRITICAL'));
  assert.strictEqual(env.rows('CAMPAIGNS')[0].status, 'FAILED');
});
test('NOUZOVÉ ZASTAVENÍ: jedno tlačítko zastaví vše (vypínač, odesílání, triggery)', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z');
  const r = env.eval('apiEmergencyStop()');
  assert(r.ok);
  assert.strictEqual(env.triggers.length, 0);
  assert.strictEqual(env.call('tick').skipped, 'SYSTEM_ENABLED=FALSE');
  assert.strictEqual(env.eval('getRunState_()'), null);
  assert.strictEqual(env.eval(`setting_('AUTO_SEND_ENABLED')`), 'FALSE');
  env.eval('apiResume()');
  assert.strictEqual(env.triggers.length, 1);
  assert.strictEqual(env.eval(`setting_('AUTO_SEND_ENABLED')`), 'FALSE', 'odesílání se samo nezapne');
});
test('STOP během běhu: pipeline se zastaví před dalším krokem', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z');
  env.eval('P2.EXEC_BUDGET_MS = 500');
  env.fireTrigger();
  env.eval('saveSettings_({SYSTEM_ENABLED:"FALSE"})');
  const before = Object.keys(env.routerState.hits).length;
  env.clock.advance(600000); env.fireTrigger();
  assert.strictEqual(Object.keys(env.routerState.hits).length, before);
});
test('souběh: pokud běží jiná exekuce (zámek), tick nic nedělá', () => {
  const env = freshEnv();
  env.clock.set('2026-11-12T07:01:00Z');
  env.forceLock(true);
  assert(/LOCK_BUSY/.test(env.call('tick').skipped));
  env.forceLock(false);
});
test('vestavěné testy (runSelfTests_) projdou offline částí', () => {
  const env = freshEnv();
  const r = env.eval('runSelfTests_()');
  const offlineNames = ['Časová zóna projektu Europe/Prague', 'robots.txt parser (RFC 9309)', 'Normalizace a deduplikační klíče', 'Šablona – proměnné a chybějící údaje',
    'Právní brána – bez souhlasu neodesílat', 'Hodnocení webu – fakta z HTML', 'Plánovač (trigger tick) nainstalován', 'Listy databáze existují', 'Gmail kvóta čitelná'];
  offlineNames.forEach((n) => { const x = r.results.find((y) => y.name === n); assert(x && x.ok, n + ': ' + (x && x.error)); });
});

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} testů prošlo\n`);
process.exit(failed.length ? 1 : 0);
