/**
 * Serverové API administrace (volané z Admin.html přes google.script.run).
 * Každá funkce ověřuje, že ji volá vlastník skriptu (nebo e-mail v ADMIN_EMAILS).
 */

function assertAdmin_() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const extra = String(PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
  if (!active || (active !== owner && extra.indexOf(active) < 0)) throw new Error('Přístup odepřen – administrace je dostupná jen vlastníkovi.');
  return active;
}

function api_(fn) {
  assertAdmin_();
  try { return { ok: true, data: fn() }; }
  catch (e) { logError_('admin', '', 'ERROR', String(e.message || e), e.stack); return { ok: false, error: String(e.message || e) }; }
}

const CONTACT_LIST_FIELDS = ['contact_id', 'status', 'contact_type', 'full_name', 'office_name', 'city', 'email', 'phone', 'website',
  'sources', 'first_seen_at', 'pre_priority', 'web_score', 'potential_score', 'high_potential', 'legal_status', 'draft_status',
  'recommended_service', 'emails_sent', 'last_email_at', 'audit_status', 'email_shared'];

function pick_(o, fields) { const r = {}; fields.forEach(function (f) { r[f] = o[f] === undefined ? '' : o[f]; }); return r; }

/* ------------------------------ Dashboard ------------------------------ */
function apiDashboard() {
  return api_(function () {
    const contacts = table_('CONTACTS').readAll();
    const log = table_('EMAIL_LOG').readAll();
    const today = todayPrague_();
    const errors = table_('ERROR_LOG').readAll();
    const state = getRunState_();
    const props = PropertiesService.getScriptProperties();
    const s = loadSettings_(true);
    let quota = null;
    try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
    return {
      totals: {
        total: contacts.length,
        today: contacts.filter(function (c) { return String(c.first_seen_at).substring(0, 10) === today; }).length,
        high: contacts.filter(function (c) { return toBool_(c.high_potential); }).length,
        authorized: contacts.filter(function (c) { return c.legal_status === LEGAL_STATUS.AUTHORIZED; }).length,
        needsReview: contacts.filter(function (c) { return c.legal_status === LEGAL_STATUS.NEEDS_LEGAL_REVIEW; }).length,
        drafts: contacts.filter(function (c) { return ['READY', 'DRAFT_INTERNAL', 'MISSING_DATA'].indexOf(c.draft_status) >= 0; }).length,
        ready: contacts.filter(function (c) { return c.draft_status === 'READY'; }).length,
        sent: log.filter(function (r) { return r.status === 'SENT'; }).length,
        sentToday: log.filter(function (r) { return r.status === 'SENT' && String(r.created_at).substring(0, 10) === today; }).length,
        testLogged: log.filter(function (r) { return r.status === 'TEST_NOT_SENT'; }).length,
        suppressed: table_('SUPPRESSION').readAll().length,
        errors24h: errors.filter(function (r) { return (r.severity === 'ERROR' || r.severity === 'CRITICAL') && Date.now() - parsePragueIso_(r.ts) < 86400000; }).length,
        uncertain: log.filter(function (r) { return r.status === 'UNCERTAIN'; }).length,
      },
      flags: {
        system: toBool_(s.SYSTEM_ENABLED), scan: toBool_(s.DAILY_SCAN_ENABLED), autoSend: toBool_(s.AUTO_SEND_ENABLED),
        testMode: toBool_(s.TEST_MODE), scanTime: s.SCAN_TIME, sendTime: s.SEND_TIME, target: s.DAILY_CONTACT_TARGET,
        sendLimit: s.DAILY_SEND_LIMIT, triggers: triggersInstalled_(), quota: quota,
      },
      run: state, lastTick: props.getProperty('P2_LAST_TICK'), lastSend: safeJsonParse_(props.getProperty('P2_LAST_SEND_SUMMARY'), null),
      recentErrors: errors.slice(-8).reverse(),
      campaigns: table_('CAMPAIGNS').readAll().slice(-10).reverse(),
      sources: table_('SOURCES').readAll().map(function (r) { return pick_(r, ['source_id', 'name', 'status', 'enabled', 'last_found', 'last_run_at']); }),
    };
  });
}

/** Lehký stav pro hlavičku administrace (volá se při každém přepnutí sekce). */
function apiStatus() {
  return api_(function () {
    const s = loadSettings_(true);
    return { flags: { system: toBool_(s.SYSTEM_ENABLED), autoSend: toBool_(s.AUTO_SEND_ENABLED), testMode: toBool_(s.TEST_MODE), triggers: triggersInstalled_() },
      lastTick: PropertiesService.getScriptProperties().getProperty('P2_LAST_TICK') };
  });
}

/* ------------------------------ Kontakty ------------------------------ */
function apiContacts(q) {
  return api_(function () {
    q = q || {};
    let rows = table_('CONTACTS').readAll();
    if (q.text) {
      const t = normText_(q.text);
      rows = rows.filter(function (c) { return normText_([c.contact_id, c.full_name, c.office_name, c.email, c.city, c.website].join(' ')).indexOf(t) >= 0; });
    }
    if (q.status) rows = rows.filter(function (c) { return c.status === q.status; });
    if (q.legal) rows = rows.filter(function (c) { return c.legal_status === q.legal; });
    if (q.draft) rows = rows.filter(function (c) { return c.draft_status === q.draft; });
    if (q.high) rows = rows.filter(function (c) { return toBool_(c.high_potential); });
    if (q.today) { const d = todayPrague_(); rows = rows.filter(function (c) { return String(c.first_seen_at).substring(0, 10) === d; }); }
    const sort = q.sort || 'potential_score';
    const num = ['potential_score', 'web_score', 'pre_priority'].indexOf(sort) >= 0;
    rows.sort(function (a, b) {
      if (num) return toInt_(b[sort], -1) - toInt_(a[sort], -1);
      return String(b[sort]).localeCompare(String(a[sort]));
    });
    const size = Math.min(q.pageSize || 50, 200), page = Math.max(q.page || 1, 1);
    return { total: rows.length, page: page, pageSize: size, rows: rows.slice((page - 1) * size, page * size).map(function (c) { return pick_(c, CONTACT_LIST_FIELDS); }) };
  });
}

function apiContact(id) {
  return api_(function () {
    const c = table_('CONTACTS').readAll().filter(function (x) { return x.contact_id === id; })[0];
    if (!c) throw new Error('Kontakt nenalezen');
    const email = normEmail_(c.email);
    const out = Object.assign({}, c);
    delete out._row;
    out.findings = safeJsonParse_(c.findings_json, []);
    out.breakdown = (safeJsonParse_(c.web_score_breakdown, {}) || {}).breakdown || {};
    out.emailLog = table_('EMAIL_LOG').readAll().filter(function (r) { return r.contact_id === id || (email && normEmail_(r.email) === email); });
    out.consents = table_('LEGAL_CONSENTS').readAll().filter(function (r) { return email && normEmail_(r.email) === email; });
    out.legalNow = email ? evaluateLegal_(c, legalCtx_()) : null;
    return out;
  });
}

function apiUpdateContactNotes(id, notes) {
  return api_(function () {
    const t = table_('CONTACTS');
    const c = t.readAll().filter(function (x) { return x.contact_id === id; })[0];
    if (!c) throw new Error('Kontakt nenalezen');
    t.update(c, { notes: String(notes || '').substring(0, 5000) });
    return true;
  });
}

/** Znovu vyhodnotí web a koncept jednoho kontaktu. */
function apiReaudit(id) {
  return api_(function () {
    const t = table_('CONTACTS');
    const c = t.readAll().filter(function (x) { return x.contact_id === id; })[0];
    if (!c) throw new Error('Kontakt nenalezen');
    const patch = auditContact_(c);
    t.update(c, patch);
    const d = draftForContact_(Object.assign({}, c, patch), legalCtx_());
    t.update(c, d.patch);
    return pick_(c, CONTACT_LIST_FIELDS);
  });
}

/* ------------------------------ Zdroje ------------------------------ */
function apiSources() {
  return api_(function () {
    return { sources: table_('SOURCES').readAll().map(function (r) { const o = Object.assign({}, r); delete o._row; return o; }),
      modules: Object.keys(SOURCE_MODULES).map(function (k) { return { id: k, label: SOURCE_MODULES[k].label }; }),
      tosOk: TOS_OK };
  });
}

const SOURCE_EDITABLE = ['name', 'base_url', 'module', 'enabled', 'tos_status', 'tos_evidence', 'crawl_delay_ms', 'max_pages', 'config_json', 'notes'];

function apiSaveSource(src) {
  return api_(function () {
    const t = table_('SOURCES');
    if (!src || !src.source_id || !/^[a-z0-9_\-]{2,40}$/.test(src.source_id)) throw new Error('source_id: 2–40 znaků a-z0-9_-');
    if (src.base_url && !/^https:\/\/[a-z0-9.\-]+\.[a-z]{2,}\/?$/i.test(src.base_url)) throw new Error('base_url musí být https://domena.tld');
    if (src.module && !SOURCE_MODULES[src.module]) throw new Error('Neznámý modul');
    if (src.config_json && safeJsonParse_(src.config_json, null) === null) throw new Error('config_json není platný JSON');
    if (toBool_(src.enabled) && TOS_OK.indexOf(src.tos_status) < 0 && src.module !== 'robots_monitor') {
      throw new Error('Zdroj lze zapnout jen s ověřenými podmínkami (tos_status: ' + TOS_OK.join(' / ') + ') a doloženým důkazem v tos_evidence.');
    }
    if (TOS_OK.indexOf(src.tos_status) >= 0 && src.tos_status !== 'NO_RESTRICTION_FOUND' && !String(src.tos_evidence || '').trim()) {
      throw new Error('Doplňte tos_evidence (např. odkaz na souhlas provozovatele / datum kontroly podmínek).');
    }
    const existing = t.readAll().filter(function (r) { return r.source_id === src.source_id; })[0];
    const patch = {};
    SOURCE_EDITABLE.forEach(function (k) { if (src[k] !== undefined) patch[k] = src[k]; });
    if (existing) t.update(existing, patch);
    else t.append([Object.assign({ source_id: src.source_id, status: 'NEW', robots_status: 'UNKNOWN', last_found: '0', total_found: '0', module: 'generic',
      tos_status: 'NEEDS_REVIEW', enabled: 'FALSE', crawl_delay_ms: '3000', max_pages: '10', last_checked_at: nowIso_() }, patch)]);
    return true;
  });
}

function apiTestSource(id) {
  return api_(function () {
    const src = table_('SOURCES').readAll().filter(function (r) { return r.source_id === id; })[0];
    if (!src) throw new Error('Zdroj nenalezen');
    return testSourceConfig_(src);
  });
}

/* ------------------------------ Hodnocení webů ------------------------------ */
function apiAudits(q) {
  return api_(function () {
    q = q || {};
    let rows = table_('CONTACTS').readAll().filter(function (c) { return c.audit_status && c.audit_status !== 'PENDING'; });
    if (q.onlyWithWeb) rows = rows.filter(function (c) { return c.website; });
    rows.sort(function (a, b) { return toInt_(b.potential_score, 0) - toInt_(a.potential_score, 0); });
    const size = Math.min(q.pageSize || 50, 200), page = Math.max(q.page || 1, 1);
    return { total: rows.length, rows: rows.slice((page - 1) * size, page * size).map(function (c) {
      return Object.assign(pick_(c, ['contact_id', 'full_name', 'office_name', 'website', 'web_score', 'potential_score', 'high_potential',
        'redesign_opportunity', 'recommended_service', 'findings_text', 'audited_at', 'audit_status']),
      { breakdown: (safeJsonParse_(c.web_score_breakdown, {}) || {}).breakdown || {} });
    }) };
  });
}

/* ------------------------------ E-mail ------------------------------ */
const EMAIL_SETTING_KEYS = ['EMAIL_SUBJECT', 'EMAIL_BODY', 'EMAIL_SIGNATURE', 'SENDER_NAME', 'SENDER_EMAIL', 'REPLY_TO',
  'SENDER_IDENTIFICATION', 'EMAIL_FOOTER', 'DAILY_SEND_LIMIT', 'SEND_TIME', 'SEND_DELAY_SECONDS', 'MAX_EMAILS_PER_CONTACT',
  'EMAIL_LEGAL_SCOPE', 'WEBAPP_URL', 'TEST_RECIPIENT'];

function apiEmailSettings() {
  return api_(function () {
    const s = loadSettings_(true);
    const out = {};
    EMAIL_SETTING_KEYS.forEach(function (k) { out[k] = s[k]; });
    let aliases = [];
    try { aliases = GmailApp.getAliases(); } catch (e) { }
    return { settings: out, vars: TEMPLATE_VARS, systemVars: SYSTEM_VARS, me: Session.getEffectiveUser().getEmail(), aliases: aliases,
      deployedUrl: (function () { try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; } })() };
  });
}

function apiSaveEmailSettings(patch) {
  return api_(function () {
    const clean = {};
    EMAIL_SETTING_KEYS.forEach(function (k) { if (patch && patch[k] !== undefined) clean[k] = patch[k]; });
    saveSettings_(clean);
    refreshLegalStatuses_(true); // koncepty se přegenerují z nové šablony
    return true;
  });
}

/** Náhled vyplněné šablony pro kontakt (nic neodesílá). */
function apiPreview(contactId) {
  return api_(function () {
    const contacts = table_('CONTACTS').readAll();
    let c = contactId ? contacts.filter(function (x) { return x.contact_id === contactId; })[0] : null;
    if (!c) c = contacts.filter(function (x) { return x.email && x.audit_status === 'DONE'; }).sort(function (a, b) { return toInt_(b.potential_score, 0) - toInt_(a.potential_score, 0); })[0];
    if (!c) throw new Error('Zatím není žádný vyhodnocený kontakt s e-mailem.');
    const m = buildEmail_(c);
    return { contact: pick_(c, CONTACT_LIST_FIELDS), subject: m.subject, body: m.body, missing: m.missing, unknown: m.unknown, problems: m.problems,
      vars: templateVarsFor_(c), legal: evaluateLegal_(c, legalCtx_()) };
  });
}

function apiSendPreviewToMe(contactId) { return api_(function () { return sendPreviewToMe_(contactId); }); }

function apiEmailLog(q) {
  return api_(function () {
    q = q || {};
    let rows = table_('EMAIL_LOG').readAll().reverse();
    if (q.status) rows = rows.filter(function (r) { return r.status === q.status; });
    const size = Math.min(q.pageSize || 100, 300), page = Math.max(q.page || 1, 1);
    return { total: rows.length, rows: rows.slice((page - 1) * size, page * size).map(function (r) { const o = Object.assign({}, r); delete o._row; return o; }) };
  });
}

/* ------------------------------ Právní oprávnění ------------------------------ */
function apiLegal() {
  return api_(function () {
    const strip = function (r) { const o = Object.assign({}, r); delete o._row; return o; };
    return { consents: table_('LEGAL_CONSENTS').readAll().map(strip).reverse(), suppression: table_('SUPPRESSION').readAll().map(strip).reverse(),
      bases: ACCEPTED_LEGAL_BASES, scope: setting_('EMAIL_LEGAL_SCOPE') };
  });
}

function apiAddConsent(rec) {
  return api_(function () {
    const who = assertAdmin_();
    const email = normEmail_(rec.email);
    if (!email) throw new Error('Neplatný e-mail');
    if (!ACCEPTED_LEGAL_BASES[rec.legal_basis]) throw new Error('Neplatný právní důvod');
    if (!String(rec.scope || '').trim()) throw new Error('Vyplňte rozsah (scope)');
    if (!String(rec.source || '').trim() || !String(rec.evidence_ref || '').trim()) throw new Error('Zdroj i důkaz (evidence_ref) jsou povinné.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.obtained_at || ''))) throw new Error('Datum získání ve formátu RRRR-MM-DD');
    if (rec.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(rec.valid_until)) throw new Error('Platnost do ve formátu RRRR-MM-DD');
    if (isSuppressed_(email, loadSuppression_())) throw new Error('Adresa je v SUPPRESSION (odmítla komunikaci). Souhlas nelze zapsat, dokud ji odtud vědomě neodeberete.');
    const contact = table_('CONTACTS').readAll().filter(function (c) { return normEmail_(c.email) === email; })[0];
    const id = 'CONS-' + Utilities.getUuid().substring(0, 8).toUpperCase();
    table_('LEGAL_CONSENTS').append([{
      consent_id: id, contact_id: rec.contact_id || (contact ? contact.contact_id : ''), email: email, legal_basis: rec.legal_basis,
      scope: String(rec.scope).trim(), consent_text: rec.consent_text || '', source: rec.source, evidence_ref: rec.evidence_ref,
      obtained_at: rec.obtained_at, valid_until: rec.valid_until || '', withdrawn_at: '', verified: toBool_(rec.verified) ? 'TRUE' : 'FALSE',
      recorded_by: who, recorded_at: nowIso_(), notes: rec.notes || '',
    }]);
    refreshLegalStatuses_();
    return id;
  });
}

function apiWithdrawConsent(id, reason) {
  return api_(function () {
    const t = table_('LEGAL_CONSENTS');
    const r = t.readAll().filter(function (x) { return x.consent_id === id; })[0];
    if (!r) throw new Error('Záznam nenalezen');
    t.update(r, { withdrawn_at: nowIso_(), notes: (r.notes ? r.notes + ' | ' : '') + 'odvoláno: ' + (reason || 'ručně') });
    refreshLegalStatuses_();
    return true;
  });
}

function apiAddSuppression(email, reason) {
  return api_(function () { return addSuppression_(email, '', reason || 'Ručně', 'MANUAL', 'admin ' + assertAdmin_()); });
}

function apiRemoveSuppression(email, justification) {
  return api_(function () {
    if (!String(justification || '').trim()) throw new Error('Uveďte důvod odebrání (např. omylem přidáno).');
    const t = table_('SUPPRESSION');
    const r = t.readAll().filter(function (x) { return String(x.email).toLowerCase() === String(email).toLowerCase(); })[0];
    if (!r) throw new Error('Nenalezeno');
    t.deleteRow(r);
    logError_('admin', '', 'WARN', 'Odebráno ze SUPPRESSION: ' + email, justification + ' / ' + assertAdmin_());
    return true;
  });
}

/* ------------------------------ Automatizace ------------------------------ */
const AUTOMATION_KEYS = ['DAILY_SCAN_ENABLED', 'DAILY_CONTACT_TARGET', 'SCAN_TIME', 'SEND_TIME', 'AUTO_SEND_ENABLED', 'TEST_MODE',
  'INBOX_MONITOR_ENABLED', 'HIGH_POTENTIAL_THRESHOLD', 'DRAFT_MIN_POTENTIAL', 'PAGESPEED_API_KEY', 'SLOW_RESPONSE_MS',
  'GMAIL_QUOTA_RESERVE', 'SERVICE_MAP_JSON', 'DAILY_SEND_LIMIT'];

function apiAutomation() {
  return api_(function () {
    const s = loadSettings_(true);
    const out = {};
    AUTOMATION_KEYS.concat(['SYSTEM_ENABLED']).forEach(function (k) { out[k] = s[k]; });
    const desc = {};
    DEFAULT_SETTINGS.forEach(function (d) { desc[d[0]] = d[2]; });
    return { settings: out, descriptions: desc, triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
      run: getRunState_(), timezone: P2.TIMEZONE };
  });
}

function apiSaveAutomation(patch) {
  return api_(function () {
    const clean = {};
    AUTOMATION_KEYS.forEach(function (k) { if (patch && patch[k] !== undefined) clean[k] = patch[k]; });
    // Ostré odesílání vyžaduje vědomé potvrzení.
    if (clean.TEST_MODE !== undefined && !toBool_(clean.TEST_MODE) && settingBool_('TEST_MODE') && !patch.confirmLive) {
      throw new Error('Vypnutí testovacího režimu musí být potvrzeno (confirmLive).');
    }
    saveSettings_(clean);
    return true;
  });
}

function apiInstallTriggers() { return api_(function () { return installTriggers_(); }); }
function apiEmergencyStop() { return api_(function () { return emergencyStop_(assertAdmin_()); }); }
function apiResume() { return api_(function () { return resumeSystem_(); }); }

/** Ruční spuštění skenu (pokračuje v pozadí přes trigger). */
function apiRunScanNow(force) {
  return api_(function () {
    if (!isSystemEnabled_()) throw new Error('Systém je zastaven hlavním vypínačem.');
    const st = getRunState_();
    if (st && st.phase !== 'DONE' && st.phase !== 'FAILED') return runPipelineStep_(Date.now() + 4 * 60 * 1000);
    startDailyRun_(!!force);
    PropertiesService.getScriptProperties().setProperty('P2_LAST_SCAN_START', todayPrague_());
    return runPipelineStep_(Date.now() + 4 * 60 * 1000);
  });
}

function apiRunSendNow() {
  return api_(function () { return runSendJob_(Date.now() + 4 * 60 * 1000, { manual: true }); });
}

function apiErrors() {
  return api_(function () { return table_('ERROR_LOG').readAll().slice(-200).reverse().map(function (r) { const o = Object.assign({}, r); delete o._row; return o; }); });
}

function apiRunSelfTests() { return api_(function () { return runSelfTests_(); }); }
