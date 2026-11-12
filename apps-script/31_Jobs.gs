/**
 * Denní pipeline – stavový automat s checkpointy. Každá exekuce pracuje max. P2.EXEC_BUDGET_MS
 * a stav ukládá do Script Properties, takže běh pokračuje po přerušení / chybě / limitu času.
 *
 * Fáze: DISCOVER -> SELECT -> ENRICH -> AUDIT -> DRAFT -> DONE
 */

function getRunState_() {
  const s = PropertiesService.getScriptProperties().getProperty(P2.STATE_KEY);
  return s ? safeJsonParse_(s, null) : null;
}

function saveRunState_(state) {
  state.updatedAt = nowIso_();
  PropertiesService.getScriptProperties().setProperty(P2.STATE_KEY, JSON.stringify(state));
}

function newRunState_() {
  const today = todayPrague_();
  const sources = table_('SOURCES').readAll();
  return {
    runId: today,
    campaignId: 'CMP-' + today.replace(/-/g, ''),
    phase: 'DISCOVER',
    target: Math.max(0, settingInt_('DAILY_CONTACT_TARGET', 100)),
    sourceOrder: sources.map(function (s) { return s.source_id; }),
    sourceIdx: 0,
    cursor: null,
    sourceResults: {},
    sourceErrors: {},
    counters: { candidates: 0, new: 0, audited: 0, high: 0, drafts: 0, authorized: 0, review: 0, existingSeen: 0 },
    attempts: 0,
    startedAt: nowIso_(),
    shortfall: '',
    testMode: settingBool_('TEST_MODE'),
  };
}

/** Spustí nový denní běh (pokud dnes ještě neběžel). */
function startDailyRun_(force) {
  const prev = getRunState_();
  const today = todayPrague_();
  if (!force && prev && prev.runId === today) return prev;
  if (prev && prev.phase !== 'DONE' && prev.phase !== 'FAILED' && prev.runId !== today) {
    // Nedokončený běh z minula dokončíme jako první (nic se neztratí).
    return prev;
  }
  ensureSchema_();
  const state = newRunState_();
  table_(P2.POOL_SHEET).clearData();
  upsertCampaign_(state, { status: 'RUNNING', started_at: state.startedAt });
  saveRunState_(state);
  return state;
}

/** Hlavní krok pipeline – volá se z tick() i ručně. Vrací stav. */
function runPipelineStep_(deadline) {
  let state = getRunState_();
  if (!state || state.phase === 'DONE' || state.phase === 'FAILED') return state;
  while (Date.now() < deadline) {
    if (!isSystemEnabled_()) { logError_('pipeline', '', 'INFO', 'Zastaveno hlavním vypínačem.', ''); break; }
    const before = state.phase;
    try {
      if (state.phase === 'DISCOVER') phaseDiscover_(state, deadline);
      else if (state.phase === 'SELECT') phaseSelect_(state);
      else if (state.phase === 'ENRICH') phaseEnrich_(state, deadline);
      else if (state.phase === 'AUDIT') phaseAudit_(state, deadline);
      else if (state.phase === 'DRAFT') phaseDraft_(state, deadline);
      else if (state.phase === 'FINALIZE') phaseFinalize_(state);
      state.attempts = 0;
    } catch (e) {
      state.attempts = (state.attempts || 0) + 1;
      logError_('pipeline:' + state.phase, '', state.attempts >= 5 ? 'CRITICAL' : 'ERROR', String(e && e.message || e), e && e.stack);
      if (state.attempts >= 5) {
        state.phase = 'FAILED';
        upsertCampaign_(state, { status: 'FAILED', finished_at: nowIso_(), shortfall_reason: 'Opakovaná chyba ve fázi ' + before + ': ' + (e && e.message) });
      }
      saveRunState_(state);
      break; // další pokus v příští exekuci (bezpečné opakování)
    }
    const yielded = !!state.yieldExec;
    delete state.yieldExec;
    saveRunState_(state);
    if (state.phase === 'DONE' || state.phase === 'FAILED' || yielded) break;
    if (state.phase === before && Date.now() >= deadline) break;
  }
  return state;
}

/* ------------------------------- DISCOVER ------------------------------- */

function phaseDiscover_(state, deadline) {
  const srcTable = table_('SOURCES');
  const sources = srcTable.readAll();
  const poolTable = table_(P2.POOL_SHEET);
  const poolKeys = {};
  poolTable.readAll().forEach(function (r) { poolKeys[r.pool_key] = true; });
  const contacts = table_('CONTACTS').readAll();
  const known = buildContactIndex_(contacts).byKey;

  while (state.sourceIdx < state.sourceOrder.length) {
    if (Date.now() >= deadline) return;
    const sid = state.sourceOrder[state.sourceIdx];
    const src = sources.filter(function (s) { return s.source_id === sid; })[0];
    if (!src) { state.sourceIdx++; state.cursor = null; continue; }
    const res = state.sourceResults[sid] || (state.sourceResults[sid] = { status: '', found: 0, note: '' });

    if (state.cursor === null && !res.started) {
      const gate = sourceGate_(src);
      if (gate.transient) {
        const n = (state.sourceErrors[sid] || 0) + 1;
        state.sourceErrors[sid] = n;
        logError_('discover', sid, n >= 3 ? 'ERROR' : 'WARN', gate.reason, 'pokus ' + n);
        if (n < 3) { state.yieldExec = true; saveRunState_(state); return; } // opakujeme v další exekuci
      }
      res.started = true;
      res.status = gate.status;
      res.note = gate.reason;
      srcTable.update(src, { robots_status: gate.robotsStatus, status: gate.ok ? 'OK' : gate.status, last_checked_at: nowIso_() });
      if (!gate.ok) {
        if (gate.status === 'ROBOTS_CHANGED_REVIEW') logError_('discover', sid, 'WARN', gate.reason, '');
        state.sourceIdx++; state.cursor = null; saveRunState_(state);
        continue;
      }
    }

    const module = SOURCE_MODULES[src.module];
    const ctx = makeSourceCtx_(src, known);
    const scratchKey = 'scratch:' + state.runId + ':' + sid;
    ctx.scratch = safeJsonParse_(CacheService.getScriptCache().get(scratchKey), {}) || {};
    let done = false;
    while (!done && Date.now() < deadline) {
      if (!isSystemEnabled_()) return;
      let r;
      try {
        r = module.step(src, state.cursor, ctx);
        state.sourceErrors[sid] = 0;
      } catch (e) {
        const n = (state.sourceErrors[sid] || 0) + 1;
        state.sourceErrors[sid] = n;
        const fatal = e.blockedByRobots || e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 429 || n >= 3;
        logError_('discover', sid, fatal ? 'ERROR' : 'WARN', String(e.message || e), 'pokus ' + n);
        if (fatal) {
          res.status = e.blockedByRobots ? 'BLOCKED_ROBOTS' : 'UNAVAILABLE';
          res.note = 'Zdroj nedostupný: ' + truncate_(String(e.message || e), 200) + ' – pokračuji dalšími zdroji.';
          srcTable.update(src, { status: res.status, last_run_at: nowIso_() });
          done = true;
          break;
        }
        state.yieldExec = true;
        saveRunState_(state);
        return; // zkusíme znovu v další exekuci
      }
      const fresh = (r.items || []).filter(function (it) {
        if (!it.source_key || poolKeys[it.source_key]) return false;
        poolKeys[it.source_key] = true;
        return true;
      });
      if (fresh.length) {
        poolTable.append(fresh.map(function (it) {
          return { pool_key: it.source_key, source_id: sid, payload_json: JSON.stringify(it), added_at: nowIso_() };
        }));
      }
      res.found += fresh.length;
      res.note = r.note || '';
      state.cursor = r.cursor;
      try { CacheService.getScriptCache().put(scratchKey, JSON.stringify(ctx.scratch), 6 * 3600); } catch (e) { }
      saveRunState_(state);
      if (!r.cursor) {
        done = true;
        res.status = 'OK';
        srcTable.update(src, { status: 'OK', last_run_at: nowIso_(), last_found: String(res.found) });
      }
    }
    if (!done) return; // došel čas, pokračujeme příště od kurzoru
    state.sourceIdx++;
    state.cursor = null;
  }
  state.phase = 'SELECT';
}

/* -------------------------------- SELECT -------------------------------- */

function phaseSelect_(state) {
  const pool = table_(P2.POOL_SHEET).readAll().map(function (r) { return safeJsonParse_(r.payload_json, null); }).filter(Boolean);
  const candidates = buildCandidates_(pool);
  const ct = table_('CONTACTS');
  const contacts = ct.readAll();
  const idx = buildContactIndex_(contacts);
  const now = nowIso_();
  const fresh = [];
  const seenExisting = [];

  // e-maily v poolu (pro detekci sdílených adres)
  const emailCounts = Object.assign({}, idx.emailCount);
  candidates.forEach(function (c) { const e = normEmail_(c.email); if (e) emailCounts[e] = (emailCounts[e] || 0) + 1; });

  const suppression = loadSuppression_();
  let suppressedSkipped = 0;
  candidates.forEach(function (c) {
    // Adresy ze SUPPRESSION (odmítnutí, žádost o výmaz) se znovu neukládají.
    if (normEmail_(c.email) && isSuppressed_(c.email, suppression)) { suppressedSkipped++; return; }
    let existing = null;
    c.merge_keys.forEach(function (k) { if (!existing && idx.byKey[k]) existing = idx.byKey[k]; });
    if (existing) { seenExisting.push({ existing: existing, cand: c }); return; }
    const pp = prePriority_(c, emailCounts);
    c.pre_priority = pp.score;
    c.priority_reasons = pp.reasons.join(', ');
    fresh.push(c);
  });

  // Aktualizace existujících kontaktů: last_seen + nové zdroje (bez duplicitních záznamů).
  let updated = 0;
  seenExisting.forEach(function (x) {
    const e = x.existing;
    const newSources = uniq_(String(e.sources || '').split(',').concat(x.cand.sources || []).map(function (s) { return String(s).trim(); }));
    const newUrls = uniq_(String(e.source_profile_urls || '').split('\n').concat(x.cand.profile_urls || []));
    const newKeys = uniq_(String(e.merge_keys || '').split('\n').concat(x.cand.merge_keys || []));
    const changed = newSources.join(',') !== String(e.sources) || newUrls.join('\n') !== String(e.source_profile_urls) || newKeys.join('\n') !== String(e.merge_keys);
    if (changed && updated < 300) {
      const patch = { last_seen_at: now, sources: newSources.join(','), source_profile_urls: newUrls.join('\n'), merge_keys: newKeys.join('\n') };
      ['email', 'phone', 'website', 'city', 'region', 'office_name'].forEach(function (f) { if (!e[f] && x.cand[f]) patch[f] = x.cand[f]; });
      ct.update(e, patch);
      updated++;
    }
  });

  fresh.sort(function (a, b) { return b.pre_priority - a.pre_priority; });
  const chosen = fresh.slice(0, state.target);
  const ids = chosen.length ? nextContactIds_(chosen.length) : [];
  const rows = chosen.map(function (c, i) {
    const n = splitPersonName_(c.full_name);
    const email = normEmail_(c.email);
    return {
      contact_id: ids[i], status: CONTACT_STATUS.NEW, contact_type: c.contact_type || 'BROKER',
      full_name: n.clean || c.full_name || '', first_name: n.first, last_name: n.last,
      office_name: c.office_name || '', office_size: c.office_size || '', city: c.city || '', region: c.region || '',
      city_source: c.city ? (c.city_source || 'CATALOG') : '',
      email: email, email_shared: email && emailCounts[email] > 1 ? 'TRUE' : 'FALSE', phone: c.phone || '',
      website: c.website || '', website_source: c.website ? (c.website_source || 'CATALOG') : '', own_domain: '',
      sources: (c.sources || []).join(','), source_profile_urls: (c.profile_urls || []).join('\n'),
      first_seen_at: now, last_seen_at: now, discovered_run: state.runId,
      pre_priority: c.pre_priority, priority_reasons: c.priority_reasons,
      audit_status: 'PENDING', legal_status: email ? LEGAL_STATUS.NEEDS_LEGAL_REVIEW : LEGAL_STATUS.NO_EMAIL,
      draft_status: 'NONE', campaign_id: state.campaignId, emails_sent: '0',
      communication_history: now + ' Nalezen v katalogu: ' + (c.sources || []).join(', '),
      merge_keys: (c.merge_keys || []).join('\n'),
    };
  });
  ct.append(rows);

  state.counters.candidates = candidates.length;
  state.counters.new = rows.length;
  state.counters.existingSeen = seenExisting.length;
  state.counters.suppressedSkipped = suppressedSkipped;
  if (rows.length < state.target) {
    const blocked = Object.keys(state.sourceResults).filter(function (k) { return state.sourceResults[k].status !== 'OK'; })
      .map(function (k) { return k + ' (' + state.sourceResults[k].status + ')'; });
    state.shortfall = 'Nalezeno jen ' + rows.length + ' nových z cílových ' + state.target + '. ' +
      'Povolené zdroje obsahovaly ' + candidates.length + ' záznamů, z toho ' + seenExisting.length + ' už v databázi. ' +
      (blocked.length ? 'Nedostupné/zakázané zdroje: ' + blocked.join(', ') + '.' : '');
    logError_('select', '', 'WARN', state.shortfall, '');
  }
  table_(P2.POOL_SHEET).clearData();
  state.phase = 'ENRICH';
  upsertCampaign_(state, { candidates: candidates.length, new_contacts: rows.length, shortfall_reason: state.shortfall });
}

/* -------------------------------- ENRICH -------------------------------- */

function phaseEnrich_(state, deadline) {
  const ct = table_('CONTACTS');
  // 1) ARES – sídlo a IČO firem bez města
  if (settingBool_('ARES_ENRICH_ENABLED')) {
    const aresTodo = ct.readAll().filter(function (c) {
      return c.discovered_run === state.runId && !c.city && c.audit_status === 'PENDING' && hasLegalForm_(c.office_name) && !/\[ares\]/.test(String(c.notes));
    });
    for (let i = 0; i < aresTodo.length; i++) {
      if (Date.now() >= deadline) return;
      const c = aresTodo[i];
      const patch = { notes: (c.notes ? c.notes + ' ' : '') + '[ares]' };
      try {
        const a = aresLookup_(c.office_name);
        if (a && a.city) { patch.city = a.city; patch.city_source = 'ARES_SIDLO'; patch.ico = a.ico; }
      } catch (e) { logError_('enrich', 'ares', 'WARN', String(e.message || e), c.office_name); }
      ct.update(c, patch);
    }
  }
  // 2) Srovnání makléřů – lokalita z profilu
  const srcRows = table_('SOURCES').readAll();
  const srov = srcRows.filter(function (s) { return s.source_id === 'srovnani'; })[0];
  const todo = ct.readAll().filter(function (c) {
    return c.discovered_run === state.runId && !c.city && /srovnani-makleru\.cz/.test(String(c.source_profile_urls)) && c.audit_status === 'PENDING' && !String(c.notes).match(/enriched/);
  });
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() >= deadline) return;
    const c = todo[i];
    const url = String(c.source_profile_urls).split('\n').filter(function (u) { return /srovnani-makleru\.cz/.test(u); })[0];
    let patch = {};
    try { if (srov && sourceGate_(srov).ok) patch = SOURCE_MODULES.srovnani.enrich(srov, c, url, makeSourceCtx_(srov, {})); }
    catch (e) { logError_('enrich', 'srovnani', 'WARN', String(e.message || e), url); }
    patch.notes = (c.notes ? c.notes + ' ' : '') + '[enriched]';
    ct.update(c, patch);
  }
  state.phase = 'AUDIT';
}

/* -------------------------------- AUDIT -------------------------------- */

function sourceLabel_(sources) {
  const map = { ark: 'ARK ČR', srovnani: 'Srovnání makléřů', jenreality: 'JenReality' };
  return String(sources || '').split(',').map(function (s) { return map[s.trim()] || s.trim(); }).filter(Boolean).join(' / ') || 'katalogu';
}

/** Vyhodnotí jeden kontakt (web + skóre). Vrací patch pro CONTACTS. */
function auditContact_(c) {
  const slowMs = settingInt_('SLOW_RESPONSE_MS', 3000);
  const nowYear = parseInt(todayPrague_().substring(0, 4), 10);
  const cands = websiteCandidates_(c);
  let chosen = null, analysis = null, catalogFailure = null;
  for (let i = 0; i < cands.length; i++) {
    const r = fetchSite_(cands[i].url);
    if (r.ok || r.blockedByRobots) { chosen = { cand: cands[i], r: r }; break; }
    if (cands[i].source !== 'EMAIL_DOMAIN' && !catalogFailure) catalogFailure = { cand: cands[i], r: r };
  }
  let website = '', websiteSource = '';
  if (chosen) {
    website = chosen.r.finalUrl || chosen.cand.url; websiteSource = chosen.cand.source;
    const psi = chosen.r.ok ? pageSpeedMobile_(website) : null;
    analysis = analyzeSite_({ url: chosen.cand.url, finalUrl: chosen.r.finalUrl, ok: chosen.r.ok, status: chosen.r.status, html: chosen.r.text,
      elapsedMs: chosen.r.elapsedMs, bytes: chosen.r.bytes, error: chosen.r.error, httpsOk: chosen.r.httpsOk, httpFallback: chosen.r.httpFallback,
      httpsError: chosen.r.httpsError, blockedByRobots: chosen.r.blockedByRobots, psi: psi, nowYear: nowYear, slowMs: slowMs });
  } else if (catalogFailure) {
    website = catalogFailure.cand.url; websiteSource = catalogFailure.cand.source;
    analysis = analyzeSite_({ url: website, finalUrl: website, ok: false, status: catalogFailure.r.status, error: catalogFailure.r.error });
  }
  const base = Object.assign({}, c, { website: website });
  let findings = (analysis ? analysis.findings : []).concat(contactLevelFindings_(base, sourceLabel_(c.sources)));
  const facts = analysis ? analysis.facts : {};
  const ws = webQualityScore_(findings, facts, !!website);
  const pot = potentialScore_(ws.score, toInt_(c.pre_priority, 50), base, findings);
  const host = urlHost_(website);
  const own = website ? !isOnHostList_(host, FREE_SUBDOMAIN_HOSTS) : false;
  const threshold = settingInt_('HIGH_POTENTIAL_THRESHOLD', 70);
  return {
    website: website, website_source: websiteSource, own_domain: website ? (own ? 'TRUE' : 'FALSE') : 'FALSE',
    audit_status: analysis && analysis.facts.analyzable === false && findings.some(function (f) { return f.code === 'ROBOTS_BLOCKED'; }) ? 'ROBOTS_BLOCKED' : 'DONE',
    audited_at: nowIso_(),
    web_score: ws.score === null ? '' : String(ws.score),
    web_score_breakdown: JSON.stringify({ breakdown: ws.breakdown, facts: facts }),
    findings_json: JSON.stringify(findings),
    findings_text: findingsText_(findings),
    redesign_opportunity: redesignOpportunity_(ws.score, findings),
    recommended_service: recommendService_(findings, ws.score),
    potential_score: String(pot),
    high_potential: pot >= threshold ? 'TRUE' : 'FALSE',
    status: CONTACT_STATUS.SCORED,
  };
}

function phaseAudit_(state, deadline) {
  const ct = table_('CONTACTS');
  const todo = ct.readAll().filter(function (c) { return c.discovered_run === state.runId && c.audit_status === 'PENDING'; });
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() >= deadline) return;
    if (!isSystemEnabled_()) return;
    const c = todo[i];
    let patch;
    try {
      patch = auditContact_(c);
    } catch (e) {
      const n = toInt_(String(c.notes).match(/auditfail=(\d)/) ? String(c.notes).match(/auditfail=(\d)/)[1] : 0, 0) + 1;
      logError_('audit', c.contact_id, 'WARN', String(e.message || e), c.website);
      patch = n >= 3 ? { audit_status: 'ERROR', status: CONTACT_STATUS.SCORED, potential_score: String(c.pre_priority || 0), notes: String(c.notes).replace(/auditfail=\d/, '') + ' auditfail=' + n }
        : { notes: String(c.notes || '').replace(/ ?auditfail=\d/, '') + ' auditfail=' + n };
    }
    ct.update(c, patch);
    if (patch.audit_status) state.counters.audited++;
    if (patch.high_potential === 'TRUE') state.counters.high++;
    saveRunState_(state);
  }
  state.phase = 'DRAFT';
}

/* -------------------------------- DRAFT -------------------------------- */

/** Připraví koncept a právní status pro jeden kontakt. */
function draftForContact_(c, legal) {
  const minPot = settingInt_('DRAFT_MIN_POTENTIAL', 50);
  const lg = evaluateLegal_(c, legal);
  const patch = { legal_status: lg.status, legal_checked_at: nowIso_(), legal_ref: lg.ref || '', status: CONTACT_STATUS.PROCESSED };
  if (!normEmail_(c.email) || lg.status === LEGAL_STATUS.SUPPRESSED) {
    patch.draft_status = lg.status === LEGAL_STATUS.SUPPRESSED ? 'BLOCKED' : 'NONE';
    if (lg.status === LEGAL_STATUS.SUPPRESSED) patch.status = CONTACT_STATUS.SUPPRESSED;
    return { patch: patch, legal: lg };
  }
  if (toInt_(c.potential_score, 0) < minPot && lg.status !== LEGAL_STATUS.AUTHORIZED) {
    patch.draft_status = 'NONE';
    return { patch: patch, legal: lg };
  }
  const mail = buildEmail_(c);
  patch.draft_subject = mail.subject;
  patch.draft_body = mail.body;
  const issues = mail.problems.concat(mail.missing.map(function (m) { return 'chybí údaj {{' + m + '}}'; }), mail.unknown.map(function (u) { return 'neznámá proměnná {{' + u + '}}'; }));
  patch.draft_missing = issues.join('; ');
  if (issues.length) patch.draft_status = 'MISSING_DATA';
  else if (lg.status === LEGAL_STATUS.AUTHORIZED) patch.draft_status = 'READY';
  else patch.draft_status = 'DRAFT_INTERNAL'; // jen pro interní kontrolu, nikdy se neodešle
  return { patch: patch, legal: lg };
}

function phaseDraft_(state, deadline) {
  const ct = table_('CONTACTS');
  const legal = legalCtx_();
  const todo = ct.readAll().filter(function (c) { return c.discovered_run === state.runId && c.status === CONTACT_STATUS.SCORED; });
  for (let i = 0; i < todo.length; i++) {
    if (Date.now() >= deadline) return;
    const r = draftForContact_(todo[i], legal);
    ct.update(todo[i], r.patch);
    if (r.patch.draft_status && r.patch.draft_status !== 'NONE' && r.patch.draft_status !== 'BLOCKED') state.counters.drafts++;
    if (r.legal.status === LEGAL_STATUS.AUTHORIZED) state.counters.authorized++;
    if (r.legal.status === LEGAL_STATUS.NEEDS_LEGAL_REVIEW) state.counters.review++;
  }
  state.phase = 'FINALIZE';
}

function phaseFinalize_(state) {
  refreshLegalStatuses_();
  state.phase = 'DONE';
  state.finishedAt = nowIso_();
  const summary = Object.keys(state.sourceResults).map(function (k) {
    const r = state.sourceResults[k];
    return k + ': ' + r.status + ' (' + r.found + ')' + (r.note && r.status !== 'OK' ? ' – ' + r.note : '');
  }).join('\n');
  upsertCampaign_(state, {
    status: 'DONE', finished_at: state.finishedAt, audited: state.counters.audited, high_potential: state.counters.high,
    drafts: state.counters.drafts, authorized: state.counters.authorized, needs_legal_review: state.counters.review,
    sources_summary: summary, shortfall_reason: state.shortfall,
  });
  PropertiesService.getScriptProperties().setProperty('P2_LAST_SCAN_DATE', state.runId);
}

/**
 * Přepočte právní status u kontaktů s připraveným konceptem (např. po doplnění souhlasu nebo odhlášení).
 * Koncept se při změně na AUTHORIZED znovu vygeneruje z aktuální šablony.
 */
function refreshLegalStatuses_(redraftAll) {
  const ct = table_('CONTACTS');
  const legal = legalCtx_();
  let changed = 0;
  ct.readAll().forEach(function (c) {
    if (!normEmail_(c.email) || c.status === CONTACT_STATUS.SUPPRESSED || c.draft_status === 'SENT') return;
    if (['DRAFT_INTERNAL', 'READY', 'MISSING_DATA', 'NONE'].indexOf(c.draft_status) < 0) return;
    if (!c.audit_status || c.audit_status === 'PENDING') return;
    const lg = evaluateLegal_(c, legal);
    if (redraftAll || lg.status !== c.legal_status || (lg.status === LEGAL_STATUS.AUTHORIZED && c.draft_status !== 'READY')) {
      const r = draftForContact_(c, legal);
      const differs = Object.keys(r.patch).some(function (k) { return k !== 'legal_checked_at' && String(r.patch[k]) !== String(c[k] === undefined ? '' : c[k]); });
      if (differs) { ct.update(c, r.patch); changed++; }
    }
  });
  return changed;
}

/* ------------------------------ Kampaně ------------------------------ */

function upsertCampaign_(state, patch) {
  const t = table_('CAMPAIGNS');
  const row = t.readAll().filter(function (r) { return r.campaign_id === state.campaignId; })[0];
  const base = {
    campaign_id: state.campaignId, run_date: state.runId, name: 'Denní akvizice ' + state.runId,
    legal_scope: setting_('EMAIL_LEGAL_SCOPE'),
    template_hash: sha256Hex_(setting_('EMAIL_SUBJECT') + '\n' + setting_('EMAIL_BODY')).substring(0, 16),
    subject_snapshot: truncate_(setting_('EMAIL_SUBJECT'), 200), test_mode: settingBool_('TEST_MODE') ? 'TRUE' : 'FALSE',
    target: state.target,
  };
  if (row) t.update(row, patch);
  else t.append([Object.assign(base, { status: 'RUNNING', sent: 0 }, patch)]);
}

function isSystemEnabled_() {
  // vždy čerstvě z listu – tlačítko STOP musí platit okamžitě
  SETTINGS_CACHE_ = null;
  return settingBool_('SYSTEM_ENABLED');
}
