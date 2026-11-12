/**
 * Právní brána pro obchodní sdělení (zák. č. 480/2004 Sb., GDPR).
 *
 * Výchozí stav každého kontaktu je NEEDS_LEGAL_REVIEW. Veřejný e-mail v katalogu NENÍ souhlas.
 * Automatické odeslání je povoleno jen, když v LEGAL_CONSENTS existuje záznam, který:
 *   - odpovídá přesně e-mailové adrese (a případně ID kontaktu),
 *   - má právní důvod CONSENT (§ 7 odst. 2) nebo EXISTING_CUSTOMER (§ 7 odst. 3),
 *   - má rozsah shodný s EMAIL_LEGAL_SCOPE (nebo ALL),
 *   - má doložený zdroj a důkaz (source + evidence_ref) a datum získání,
 *   - je ověřen (verified = TRUE), nebyl odvolán a nevypršel,
 * a zároveň adresa ani doména nejsou v SUPPRESSION.
 */

function loadSuppression_() {
  const set = {};
  table_('SUPPRESSION').readAll().forEach(function (r) {
    const e = String(r.email || '').trim().toLowerCase();
    if (e) set[e] = r;
  });
  return set;
}

function isSuppressed_(email, suppression) {
  const e = normEmail_(email);
  if (!e) return null;
  return suppression[e] || suppression['@' + emailDomain_(e)] || null;
}

function loadConsents_() {
  const byEmail = {};
  table_('LEGAL_CONSENTS').readAll().forEach(function (r) {
    const e = normEmail_(r.email);
    if (e) (byEmail[e] = byEmail[e] || []).push(r);
  });
  return byEmail;
}

/** Validace jednoho záznamu souhlasu. @return {string[]} seznam problémů (prázdný = platný) */
function consentProblems_(r, scope, contactId, today) {
  const p = [];
  if (!ACCEPTED_LEGAL_BASES[String(r.legal_basis).trim()]) p.push('neplatný právní důvod "' + r.legal_basis + '"');
  const sc = String(r.scope || '').trim();
  if (sc !== 'ALL' && sc !== scope) p.push('rozsah "' + sc + '" neodpovídá "' + scope + '"');
  if (!String(r.source || '').trim()) p.push('chybí zdroj souhlasu');
  if (!String(r.evidence_ref || '').trim()) p.push('chybí důkaz (evidence_ref)');
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(r.obtained_at || ''))) p.push('chybí datum získání');
  if (!toBool_(r.verified)) p.push('záznam není ověřen (verified)');
  if (String(r.withdrawn_at || '').trim()) p.push('souhlas odvolán ' + r.withdrawn_at);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(r.valid_until || '')) && String(r.valid_until).substring(0, 10) < today) p.push('platnost vypršela ' + r.valid_until);
  if (r.contact_id && contactId && String(r.contact_id).trim() !== String(contactId)) p.push('souhlas patří jinému kontaktu ' + r.contact_id);
  return p;
}

/**
 * @return {{status:string, ref:string, reason:string}}
 */
function evaluateLegal_(c, ctx) {
  const email = normEmail_(c.email);
  if (!email) return { status: LEGAL_STATUS.NO_EMAIL, ref: '', reason: 'Kontakt nemá veřejný e-mail.' };
  const sup = isSuppressed_(email, ctx.suppression);
  if (sup) return { status: LEGAL_STATUS.SUPPRESSED, ref: '', reason: 'V seznamu SUPPRESSION (' + (sup.reason || sup.source || '') + ').' };
  const list = ctx.consents[email] || [];
  if (!list.length) return { status: LEGAL_STATUS.NEEDS_LEGAL_REVIEW, ref: '', reason: 'Žádný doložený právní důvod. Veřejný e-mail z katalogu není souhlas.' };
  const today = todayPrague_();
  const problems = [];
  for (let i = 0; i < list.length; i++) {
    const p = consentProblems_(list[i], ctx.scope, c.contact_id, today);
    if (!p.length) return { status: LEGAL_STATUS.AUTHORIZED, ref: list[i].consent_id, reason: ACCEPTED_LEGAL_BASES[list[i].legal_basis] };
    problems.push(list[i].consent_id + ': ' + p.join(', '));
  }
  return { status: LEGAL_STATUS.NEEDS_LEGAL_REVIEW, ref: '', reason: 'Záznam existuje, ale není platný: ' + problems.join(' | ') };
}

function legalCtx_() {
  return { suppression: loadSuppression_(), consents: loadConsents_(), scope: setting_('EMAIL_LEGAL_SCOPE') || 'project_two_web_services' };
}

/** Přidání do SUPPRESSION (idempotentní) + odvolání souhlasů pro adresu. */
function addSuppression_(email, contactId, reason, source, note) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || (e.charAt(0) !== '@' && !isValidEmail_(e))) throw new Error('Neplatný e-mail pro suppression: ' + email);
  const t = table_('SUPPRESSION');
  const existing = t.readAll().filter(function (r) { return String(r.email).toLowerCase() === e; })[0];
  if (!existing) t.append([{ email: e, contact_id: contactId || '', reason: reason || '', source: source || 'MANUAL', added_at: nowIso_(), note: note || '' }]);
  // Odvolání souhlasů
  const ct = table_('LEGAL_CONSENTS');
  ct.readAll().forEach(function (r) {
    if (normEmail_(r.email) === e && !String(r.withdrawn_at || '').trim()) ct.update(r, { withdrawn_at: nowIso_(), notes: (r.notes ? r.notes + ' | ' : '') + 'odvoláno: ' + (reason || source) });
  });
  // Stav kontaktů
  const cs = table_('CONTACTS');
  cs.readAll().forEach(function (c) {
    if (normEmail_(c.email) === e || (e.charAt(0) === '@' && emailDomain_(c.email) === e.substring(1))) {
      cs.update(c, {
        legal_status: LEGAL_STATUS.SUPPRESSED, status: CONTACT_STATUS.SUPPRESSED, legal_checked_at: nowIso_(),
        draft_status: c.draft_status === 'SENT' ? 'SENT' : 'BLOCKED',
        communication_history: appendHistory_(c.communication_history, 'SUPPRESSION: ' + (reason || source)),
      });
    }
  });
  return !existing;
}

function appendHistory_(hist, line) {
  const h = String(hist || '');
  return (h ? h + '\n' : '') + nowIso_() + ' ' + line;
}
