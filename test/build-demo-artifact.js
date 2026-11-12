#!/usr/bin/env node
/**
 * Sestaví samostatnou demo stránku administrace: Admin.html + apps-script/*.gs + simulace služeb v prohlížeči + data.
 * Použití: node test/build-demo-artifact.js <live-contacts.csv> <výstup.html>
 * Výstup obsahuje kontaktní údaje z katalogu – necommitovat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createGasEnv } = require('./gas-mock');

const [csvPath, outPath] = process.argv.slice(2);
const SRC = path.join(__dirname, '..', 'apps-script');

// 1) Data: stejná příprava jako demo-server (import CSV + ukázková šablona)
const env = createGasEnv({ ownerEmail: 'vy@project-two.cz' });
env.call('setup');
env.eval(`saveSettings_(${JSON.stringify({
  EMAIL_SUBJECT: 'Web pro {{realitni_kancelar}}',
  EMAIL_BODY: 'Dobrý den,\n\nprošel jsem online prezentaci kanceláře {{realitni_kancelar}} a všiml jsem si, že {{konkretni_postreh}}.\n\nV Project Two pomáháme realitním makléřům s moderními weby, které na mobilu dobře prodávají. Pokud by vás zajímal krátký nezávazný návrh, stačí odpovědět.',
  EMAIL_SIGNATURE: 'S pozdravem\n{{odesilatel}}\nProject Two',
  SENDER_NAME: 'Project Two (demo)',
  SENDER_IDENTIFICATION: 'DEMO – sem patří jméno/firma, IČO a sídlo',
  WEBAPP_URL: 'https://script.google.com/macros/s/DEMO/exec',
})})`);
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true; else if (ch === ';') { row.push(f); f = ''; } else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const header = rows[0];
const sheet = env.sheet('CONTACTS');
const target = sheet.data[0];
let maxSeq = 0;
rows.slice(1).forEach((r) => {
  if (r.length < header.length) return;
  const o = Object.fromEntries(header.map((h, i) => [h, r[i]]));
  ['communication_history', 'source_profile_urls', 'merge_keys', 'findings_text', 'draft_body'].forEach((k) => { if (o[k]) o[k] = o[k].split(' | ').join('\n'); });
  sheet.data.push(target.map((h) => (o[h] === undefined ? '' : o[h])));
  maxSeq = Math.max(maxSeq, parseInt(String(o.contact_id).replace(/\D/g, ''), 10) || 0);
});
env.props.P2_CONTACT_SEQ = String(maxSeq);
// Stav posledního běhu a kampaň, aby dashboard ukázal i průběh skenu
const report = JSON.parse(fs.readFileSync(path.join(path.dirname(csvPath), 'live-report.json'), 'utf8'));
env.props.P2_RUN_STATE = JSON.stringify(report.state);
env.props.P2_LAST_TICK = report.state.updatedAt;
env.eval(`table_('CAMPAIGNS').append([${JSON.stringify(Object.assign({}, report.campaign, { _row: undefined }))}])`);
env.eval(`(function(){ var t = table_('SOURCES'); t.readAll().forEach(function(s){ var g = ${JSON.stringify(report.gates)}.filter(function(x){return x.id===s.source_id;})[0];
  t.update(s, { status: g ? g.status : s.status, last_run_at: '${report.state.updatedAt}', last_found: s.source_id === 'ark' ? '${report.state.sourceResults.ark.found}' : '0' }); }); })()`);
env.eval('refreshLegalStatuses_(true)');
const demo = { sheets: {}, props: env.props, triggers: ['tick'] };
Object.keys(env.ss.sheets).forEach((n) => { demo.sheets[n] = env.ss.sheets[n].data; });

// 2) Kód
const gs = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().map((f) => '// ---- ' + f + '\n' + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
const browserMock = fs.readFileSync(path.join(__dirname, 'gas-browser.js'), 'utf8');
const shim = `
window.google = { script: { run: (function make(ok, fail) {
  return new Proxy({}, { get: function (_, fn) {
    if (fn === 'withSuccessHandler') return function (h) { return make(h, fail); };
    if (fn === 'withFailureHandler') return function (h) { return make(ok, h); };
    return function () { var args = Array.prototype.slice.call(arguments);
      setTimeout(function () { var r; try { r = JSON.parse(JSON.stringify(window[fn].apply(null, args) || null)); } catch (e) { fail && fail(e); return; } ok && ok(r); }, 0); };
  } });
})() } };`;
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

let admin = fs.readFileSync(path.join(SRC, 'Admin.html'), 'utf8');
admin = admin.replace(/^<!DOCTYPE html>\s*<html[^>]*>\s*<head>\s*/i, '').replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '');
admin = admin.replace('<base target="_top">\n', '').replace('<meta charset="utf-8">\n', '').replace('<meta name="viewport" content="width=device-width, initial-scale=1">\n', '');
admin = admin.replace('<title>Project Two – administrace</title>', '<title>Project Two Akvizice</title>');
const banner = `<div id="demoBanner" style="position:fixed;left:max(12px,env(safe-area-inset-left,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:70;background:#0a0a0a;color:#fff;font:12px/1.4 Inter,system-ui,sans-serif;padding:8px 12px;border-radius:8px;max-width:calc(100vw - 24px)">DEMO · data z živého testu (ARK ČR) · běží ve vašem prohlížeči · nic se neodesílá ani neukládá</div>`;
const inject = `<script>window.__P2_DEMO__ = ${esc(JSON.stringify(demo))};</script>\n<script>${esc(browserMock)}</script>\n<script>${esc(gs)}</script>\n<script>${esc(shim)}</script>\n`;
// skripty musí běžet před skriptem administrace (ten je na konci těla)
const marker = '<div class="app">';
admin = admin.replace(marker, () => inject + marker).replace(/(<\/script>\s*)$/, (m) => m + banner);
fs.writeFileSync(outPath, admin);
console.log('Zapsáno', outPath, Math.round(admin.length / 1024) + ' kB');
