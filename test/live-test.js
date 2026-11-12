#!/usr/bin/env node
/**
 * ŽIVÝ test proti skutečným webům (respektuje robots.txt a crawl-delay).
 * Spuštění: node test/live-test.js <výstupní-adresář>
 * Výstup obsahuje veřejné kontaktní údaje makléřů – neukládejte ho do repozitáře.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createGasEnv } = require('./gas-mock');
const outDir = process.argv[2] || path.join(require('os').tmpdir(), 'p2-live');
fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const env = createGasEnv({ live: true, maxRealSleepMs: 5000 });
env.call('setup');
const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);
const report = { startedAt: new Date().toISOString() };

// 1) robots.txt + brány všech zdrojů
report.gates = env.eval(`table_('SOURCES').readAll().map(function(s){ var g = sourceGate_(s); return { id: s.source_id, status: g.status, robots: g.robotsStatus, ok: g.ok, reason: g.reason }; })`);
log('Brány zdrojů:', JSON.stringify(report.gates));

// 2) Uživatelská šablona pro test personalizace (jen interní koncepty – TEST_MODE, žádné odeslání)
env.eval(`saveSettings_(${JSON.stringify({
  EMAIL_SUBJECT: 'Web pro {{realitni_kancelar}}',
  EMAIL_BODY: 'Dobrý den,\n\nprošel jsem web {{url_webu}} a všiml jsem si, že {{konkretni_postreh}}.\nPomáháme makléřům v {{mesto}} s moderní prezentací.',
  EMAIL_SIGNATURE: 'S pozdravem\n{{odesilatel}}', SENDER_NAME: 'Project Two (test)',
  SENDER_IDENTIFICATION: 'TEST – identifikace odesílatele', WEBAPP_URL: 'https://script.google.com/macros/s/TEST/exec',
})})`);

// 3) Plný denní běh přes tick() – opakovaně, dokud nedoběhne (checkpointy)
let st, ticks = 0;
while (ticks < 40) {
  ticks++;
  const r = env.call('tick');
  st = env.eval('getRunState_()');
  log('tick', ticks, 'fáze', st && st.phase, 'nových', st && st.counters.new, 'auditováno', st && st.counters.audited, 'HTTP', env.fetchLog.length);
  if (st && (st.phase === 'DONE' || st.phase === 'FAILED')) break;
}
report.state = st;
report.ticks = ticks;
report.httpRequests = env.fetchLog.length;
report.httpErrors = env.fetchLog.filter((f) => f.error).length;
report.durationSec = Math.round((Date.now() - t0) / 1000);

const cs = env.rows('CONTACTS');
const ids = cs.map((c) => c.contact_id);
const dupKeys = cs.map((c) => (c.full_name + '|' + c.email).toLowerCase());
report.contacts = cs.length;
report.uniqueIds = new Set(ids).size === ids.length;
report.duplicatePersons = dupKeys.length - new Set(dupKeys).size;
report.withEmail = cs.filter((c) => c.email).length;
report.withWebsite = cs.filter((c) => c.website).length;
report.websiteSources = cs.reduce((m, c) => { m[c.website_source || 'NONE'] = (m[c.website_source || 'NONE'] || 0) + 1; return m; }, {});
report.auditStatus = cs.reduce((m, c) => { m[c.audit_status] = (m[c.audit_status] || 0) + 1; return m; }, {});
report.highPotential = cs.filter((c) => c.high_potential === 'TRUE').length;
report.legal = cs.reduce((m, c) => { m[c.legal_status] = (m[c.legal_status] || 0) + 1; return m; }, {});
report.drafts = cs.reduce((m, c) => { m[c.draft_status] = (m[c.draft_status] || 0) + 1; return m; }, {});
const fcount = {};
cs.forEach((c) => JSON.parse(c.findings_json || '[]').forEach((f) => { if (f.severity > 0 || f.code === 'ROBOTS_BLOCKED') fcount[f.code] = (fcount[f.code] || 0) + 1; }));
report.findings = fcount;
const scores = cs.filter((c) => c.web_score !== '').map((c) => +c.web_score);
report.webScore = { n: scores.length, min: Math.min(...scores), max: Math.max(...scores), avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) };
report.sentMail = env.sentMail.length;
report.errors = env.rows('ERROR_LOG').map((e) => e.severity + ' ' + e.job + ' ' + e.source + ': ' + e.message).slice(0, 40);
report.campaign = env.rows('CAMPAIGNS')[0];

// 4) Druhý běh téhož dne s force → ověření, že nevzniknou duplicity
env.eval(`startDailyRun_(true)`);
let st2, t2 = 0;
env.eval(`saveSettings_({DAILY_CONTACT_TARGET:'5'})`);
env.eval(`(function(){ var s = getRunState_(); s.target = 5; saveRunState_(s); })()`);
while (t2 < 20) { t2++; env.call('tick'); st2 = env.eval('getRunState_()'); if (st2.phase === 'DONE' || st2.phase === 'FAILED') break; }
const cs2 = env.rows('CONTACTS');
const keys2 = cs2.map((c) => (c.full_name + '|' + c.email).toLowerCase());
report.secondRun = { phase: st2.phase, new: st2.counters.new, existingSeen: st2.counters.existingSeen, total: cs2.length, duplicatePersons: keys2.length - new Set(keys2).size };

fs.writeFileSync(path.join(outDir, 'live-report.json'), JSON.stringify(report, null, 2));
const sample = cs2.slice().sort((a, b) => +b.potential_score - +a.potential_score).slice(0, 15).map((c) => ({
  id: c.contact_id, name: c.full_name, office: c.office_name, city: c.city, email: c.email, web: c.website, web_src: c.website_source,
  web_score: c.web_score, potential: c.potential_score, reasons: c.priority_reasons, findings: c.findings_text, service: c.recommended_service,
  legal: c.legal_status, draft: c.draft_status, missing: c.draft_missing, body: c.draft_body,
}));
fs.writeFileSync(path.join(outDir, 'live-top15.json'), JSON.stringify(sample, null, 2));
fs.writeFileSync(path.join(outDir, 'live-contacts.csv'), [Object.keys(cs2[0]).join(';')].concat(cs2.map((c) => Object.values(c).map((v) => '"' + String(v).replace(/"/g, '""').replace(/\n/g, ' | ') + '"').join(';'))).join('\n'));
log('HOTOVO', JSON.stringify({ contacts: report.contacts, secondRun: report.secondRun, durationSec: report.durationSec }));
