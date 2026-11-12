#!/usr/bin/env node
/**
 * Lokální DEMO administrace: Admin.html + skutečná serverová logika (apps-script/*.gs) v simulaci Apps Script.
 * Síťové požadavky (sken katalogů, audit webů) jdou živě na internet; e-maily se NIKDY neodesílají
 * (GmailApp je simulovaný).
 *
 * Spuštění: node test/demo-server.js [port] [cesta-k-live-contacts.csv]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const { createGasEnv } = require('./gas-mock');

const port = parseInt(process.argv[2] || '8080', 10);
const csvPath = process.argv[3];

const env = createGasEnv({ live: true, maxRealSleepMs: 3000, ownerEmail: 'vy@project-two.cz', aliases: [] });
env.call('setup');
env.eval(`saveSettings_(${JSON.stringify({
  EMAIL_SUBJECT: 'Web pro {{realitni_kancelar}}',
  EMAIL_BODY: 'Dobrý den,\n\nprošel jsem online prezentaci kanceláře {{realitni_kancelar}} a všiml jsem si, že {{konkretni_postreh}}.\n\nV Project Two pomáháme realitním makléřům s moderními weby, které na mobilu dobře prodávají. Pokud by vás zajímal krátký nezávazný návrh, stačí odpovědět.',
  EMAIL_SIGNATURE: 'S pozdravem\n{{odesilatel}}\nProject Two',
  SENDER_NAME: 'Project Two (demo)',
  SENDER_IDENTIFICATION: 'DEMO – sem patří jméno/firma, IČO a sídlo',
  WEBAPP_URL: 'https://script.google.com/macros/s/DEMO/exec',
})})`);

// Import kontaktů z posledního živého testu (pokud je k dispozici)
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ';') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
if (csvPath && fs.existsSync(csvPath)) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  const sheet = env.sheet('CONTACTS');
  const target = sheet.data[0];
  let maxSeq = 0;
  rows.slice(1).forEach((r) => {
    if (r.length < header.length) return;
    const o = Object.fromEntries(header.map((h, i) => [h, r[i]]));
    if (o._row !== undefined) delete o._row;
    ['communication_history', 'source_profile_urls', 'merge_keys', 'findings_text', 'draft_body'].forEach((k) => { if (o[k]) o[k] = o[k].split(' | ').join('\n'); });
    sheet.data.push(target.map((h) => (o[h] === undefined ? '' : o[h])));
    maxSeq = Math.max(maxSeq, parseInt(String(o.contact_id).replace(/\D/g, ''), 10) || 0);
  });
  env.props.P2_CONTACT_SEQ = String(maxSeq);
  env.eval('refreshLegalStatuses_(true)');
  console.log('Importováno kontaktů:', sheet.data.length - 1);
}

const shim = `<script>
window.google = { script: { run: (function make(ok, fail) {
  return new Proxy({}, { get: function (_, fn) {
    if (fn === 'withSuccessHandler') return function (h) { return make(h, fail); };
    if (fn === 'withFailureHandler') return function (h) { return make(ok, h); };
    return function () { var args = Array.prototype.slice.call(arguments);
      fetch('/api/' + fn, { method: 'POST', body: JSON.stringify(args) }).then(function (r) { return r.json(); })
        .then(function (j) { if (j.__error) { fail && fail(new Error(j.__error)); } else { ok && ok(j.result); } })
        .catch(function (e) { fail && fail(e); }); };
  } });
})() } };
document.addEventListener('DOMContentLoaded', function () {
  var b = document.createElement('div');
  b.textContent = 'DEMO náhled – běží lokálně se skutečnou logikou aplikace. E-maily se nikdy neodesílají.';
  b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99;background:#0a0a0a;color:#fff;font:12px Inter,system-ui,sans-serif;padding:8px 12px;border-radius:8px;opacity:.9;max-width:calc(100vw - 24px)';
  document.body.appendChild(b);
});
</script>`;

http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') {
      const params = Object.fromEntries(u.searchParams);
      const html = env.call('doGet', { parameter: params }).getContent().replace('</head>', shim + '</head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let out;
        try { out = { result: JSON.parse(JSON.stringify(env.call(u.pathname.substring(5), ...JSON.parse(body || '[]')) || null)) }; }
        catch (e) { out = { __error: String(e.message || e) }; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(port, '0.0.0.0', () => console.log('Project Two DEMO běží na http://localhost:' + port));
