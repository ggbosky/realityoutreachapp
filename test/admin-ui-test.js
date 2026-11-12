#!/usr/bin/env node
/**
 * Test administrace v prohlížeči (Playwright/Chromium). Admin.html běží proti skutečné serverové logice
 * (apps-script/*.gs v mock prostředí) – google.script.run je přesměrováno na lokální HTTP API.
 * Spuštění: node test/admin-ui-test.js [adresář-pro-screenshoty]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium, devices } = require('playwright');
const { createGasEnv } = require('./gas-mock');
const { makeRouter } = require('./fixtures');

const shotDir = process.argv[2] || path.join(require('os').tmpdir(), 'p2-ui');
fs.mkdirSync(shotDir, { recursive: true });

// Připravená data: sken nad simulovanými katalogy, šablona, souhlas.
const env = createGasEnv({ startIso: '2026-11-12T07:01:00Z', fetchRouter: makeRouter({}) });
env.call('setup');
env.eval(`(function(){ var t = table_('SOURCES'); var r = t.readAll().filter(function(x){return x.source_id==='srovnani';})[0]; t.update(r,{enabled:'TRUE',tos_status:'APPROVED',tos_evidence:'test'}); })()`);
for (let i = 0; i < 30; i++) { env.call('tick'); const s = env.eval('getRunState_()'); if (s && s.phase === 'DONE') break; env.clock.advance(600000); }
env.eval(`apiSaveEmailSettings(${JSON.stringify({ EMAIL_SUBJECT: 'Web pro {{realitni_kancelar}}', EMAIL_BODY: 'Dobrý den,\n\nprošli jsme web {{url_webu}} a {{konkretni_postreh}}.\nPomáháme makléřům v {{mesto}}.', EMAIL_SIGNATURE: 'S pozdravem\n{{odesilatel}}', SENDER_NAME: 'Project Two', SENDER_IDENTIFICATION: 'Project Two s.r.o., IČO 12345678', WEBAPP_URL: 'https://script.google.com/macros/s/TEST/exec' })})`);
env.eval(`apiAddConsent({email:'jan@svoboda-reality.cz', legal_basis:'CONSENT', scope:'project_two_web_services', source:'formulář', evidence_ref:'FORM-1', obtained_at:'2026-10-01', verified:true})`);

const shim = `<script>
window.__calls = [];
window.google = { script: { run: (function make(ok, fail) {
  return new Proxy({}, { get: function (_, fn) {
    if (fn === 'withSuccessHandler') return function (h) { return make(h, fail); };
    if (fn === 'withFailureHandler') return function (h) { return make(ok, h); };
    return function () { var args = Array.prototype.slice.call(arguments); window.__calls.push(fn);
      fetch('/api/' + fn, { method: 'POST', body: JSON.stringify(args) }).then(function (r) { return r.json(); })
        .then(function (j) { if (j.__error) { fail && fail(new Error(j.__error)); } else { ok && ok(j.result); } }); };
  } });
})() } };
</script>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const html = env.call('doGet', { parameter: {} }).getContent().replace('</head>', shim + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/unsub')) {
    const q = Object.fromEntries(new URL('http://x' + req.url).searchParams);
    const html = env.call('doGet', { parameter: q }).getContent().replace('</head>', shim + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const fn = req.url.substring(5);
      let out;
      try { out = { result: JSON.parse(JSON.stringify(env.call(fn, ...JSON.parse(body || '[]')) || null)) }; }
      catch (e) { out = { __error: String(e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push([name, true]); console.log('  ✓ ' + name); } catch (e) { results.push([name, false]); console.log('  ✗ ' + name + '\n    ' + e.message); } };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'test' : undefined));
  await page.goto(base + '/');

  await check('Dashboard: 8 KPI karet s čísly', async () => {
    await page.waitForSelector('#kpis .kpi');
    const labels = await page.$$eval('#kpis .kpi .label', (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(labels, ['Celkem nalezených makléřů', 'Dnešní nové kontakty', 'Vysoký potenciál', 'S doloženým oprávněním', 'Připravené e-maily', 'Odeslané e-maily', 'Odmítnuté kontakty', 'Chybové stavy']);
    const total = await page.$eval('#kpis .kpi .value', (e) => +e.textContent);
    assert(total > 5, 'celkem ' + total);
    await page.waitForSelector('#runBox dl');
    await page.screenshot({ path: path.join(shotDir, '1-dashboard.png'), fullPage: true });
  });
  await check('Kontakty: tabulka, filtr, detail kontaktu', async () => {
    await page.click('nav button[data-s=contacts]');
    await page.waitForSelector('#cBody tr.click');
    const n = await page.$$eval('#cBody tr.click', (r) => r.length);
    await page.fill('#cText', 'Svoboda'); await page.waitForTimeout(700);
    const m = await page.$$eval('#cBody tr.click', (r) => r.length);
    assert(n > 5 && m === 1, n + '/' + m);
    await page.click('#cBody tr.click');
    await page.waitForSelector('#dBody dl.kv');
    const txt = await page.textContent('#dBody');
    assert(/Zjištěné nedostatky/.test(txt) && /viewport/i.test(txt) && /AUTHORIZED/.test(txt), 'detail');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shotDir, '2-contact-detail.png') });
    await page.click('#dClose');
  });
  await check('Katalogy: 5 zdrojů se stavy, test ARK zdroje', async () => {
    await page.click('nav button[data-s=sources]');
    await page.waitForSelector('#srcList .card');
    const cards = await page.$$eval('#srcList .card', (c) => c.map((x) => x.textContent));
    assert.strictEqual(cards.length, 5);
    assert(cards.some((c) => /České reality/.test(c) && /BLOCKED_ROBOTS/.test(c)));
    await page.click('[data-test=ark]');
    await page.waitForSelector('[data-out=ark] .notice');
    assert(/Nalezeno \d+ záznamů/.test(await page.textContent('[data-out=ark]')));
    await page.screenshot({ path: path.join(shotDir, '3-sources.png'), fullPage: true });
  });
  await check('Hodnocení webů: skóre a nedostatky', async () => {
    await page.click('nav button[data-s=audits]');
    await page.waitForSelector('#aBody tr.click');
    assert(/Chybí meta viewport/.test(await page.textContent('#aBody')));
    await page.screenshot({ path: path.join(shotDir, '4-audits.png') });
  });
  await check('Šablony: načtení, vložení proměnné, náhled personalizace', async () => {
    await page.click('nav button[data-s=templates]');
    await page.waitForFunction(() => document.querySelector('#eSubject').value.length > 0);
    await page.click('#eBody'); await page.click('.chip[data-v=mesto]');
    assert(/\{\{mesto\}\}/.test(await page.inputValue('#eBody')));
    const svId = await page.evaluate(() => fetch('/api/apiContacts', { method: 'POST', body: JSON.stringify([{ text: 'Svoboda' }]) }).then((r) => r.json()).then((j) => j.result.data.rows[0].contact_id));
    await page.fill('#pId', svId); await page.click('#pRun');
    await page.waitForSelector('#pBox .preview');
    const pv = await page.textContent('#pBox');
    assert(/www\.svoboda-reality\.cz/.test(pv) && /Havířov/.test(pv) && /odhl/i.test(pv), pv.substring(0, 300));
    await page.screenshot({ path: path.join(shotDir, '5-templates.png'), fullPage: true });
  });
  await check('Právní oprávnění: přidání souhlasu přes formulář a suppression', async () => {
    await page.click('nav button[data-s=legal]');
    await page.waitForSelector('#consBody tr');
    await page.fill('#lEmail', 'petra@mala-reality.cz'); await page.fill('#lSource', 'smlouva'); await page.fill('#lEvidence', 'SML-7');
    await page.check('#lVerified'); await page.click('#lSave');
    await page.waitForFunction(() => /petra@mala-reality\.cz/.test(document.querySelector('#consBody').textContent));
    await page.fill('#supEmail', '@spam-domena.cz'); await page.click('#supAdd');
    await page.waitForFunction(() => /@spam-domena\.cz/.test(document.querySelector('#supBody').textContent));
    await page.screenshot({ path: path.join(shotDir, '6-legal.png'), fullPage: true });
  });
  await check('Historie odesílání se zobrazí', async () => {
    await page.click('nav button[data-s=history]');
    await page.waitForSelector('#hBody tr');
  });
  await check('Automatizace: přepínače, spuštění testů systému', async () => {
    await page.click('nav button[data-s=automation]');
    await page.waitForSelector('[data-sw=TEST_MODE]', { state: 'attached' });
    assert.strictEqual(await page.isChecked('[data-sw=TEST_MODE]'), true);
    await page.click('#aTests');
    await page.waitForSelector('#aOut .notice b');
    assert(/OK/.test(await page.textContent('#aOut')));
    await page.screenshot({ path: path.join(shotDir, '7-automation.png'), fullPage: true });
  });
  await check('Tlačítko „Zastavit vše“ zastaví systém', async () => {
    await page.click('#btnStop');
    await page.click('#mOk');
    await page.waitForFunction(() => /zastaven/.test(document.querySelector('#pillSystem').textContent));
    assert.strictEqual(env.eval(`setting_('SYSTEM_ENABLED')`), 'FALSE');
    assert.strictEqual(env.triggers.length, 0);
  });
  await check('Mobil (iPhone 13): responzivní, bez horizontálního scrollu', async () => {
    const m = await browser.newContext({ ...devices['iPhone 13'] });
    const p = await m.newPage();
    p.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
    await p.goto(base + '/');
    await p.waitForSelector('#kpis .kpi');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, 'horizontální přetečení ' + overflow + 'px');
    await p.screenshot({ path: path.join(shotDir, '8-mobile.png'), fullPage: false });
    await m.close();
  });
  await check('Veřejná stránka odhlášení funguje v prohlížeči', async () => {
    const c = env.rows('CONTACTS').find((x) => x.email === 'petra@mala-reality.cz');
    const tok = env.eval(`unsubscribeToken_('${c.contact_id}', 'petra@mala-reality.cz')`);
    const p = await ctx.newPage();
    await p.goto(base + '/unsub?action=unsubscribe&c=' + c.contact_id + '&t=' + tok);
    await p.click('#go');
    await p.waitForFunction(() => /Hotovo/.test(document.body.textContent));
    assert(env.rows('SUPPRESSION').some((s) => s.email === 'petra@mala-reality.cz'));
    await p.screenshot({ path: path.join(shotDir, '9-unsubscribe.png') });
  });
  await check('Žádné JS chyby v konzoli', async () => { assert.deepStrictEqual(errors, []); });

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} UI testů prošlo · screenshoty: ${shotDir}`);
  process.exit(failed ? 1 : 0);
})();
