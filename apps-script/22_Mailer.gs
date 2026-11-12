/**
 * Odesílání e-mailů s ochranami:
 *  - hlavní vypínač (kontrola před KAŽDOU zprávou), automatické odesílání ON/OFF, testovací režim,
 *  - právní brána znovu ověřena těsně před odesláním (souhlas + suppression),
 *  - idempotence: jedna adresa × jeden právní rozsah = max. MAX_EMAILS_PER_CONTACT zpráv; záznam PENDING
 *    se zapíše PŘED odesláním, takže ani pád uprostřed nevede k duplicitě (PENDING → UNCERTAIN, nikdy znovu),
 *  - denní limit + Gmail kvóta (MailApp.getRemainingDailyQuota) s rezervou, pauza mezi zprávami.
 */

const SEND_BLOCKING_STATUSES = ['PENDING', 'SENT', 'UNCERTAIN'];

function emailLogIndex_(rows) {
  const byKey = {}, byEmail = {};
  rows.forEach(function (r) {
    (byKey[r.idempotency_key] = byKey[r.idempotency_key] || []).push(r);
    const e = normEmail_(r.email);
    if (e) (byEmail[e] = byEmail[e] || []).push(r);
  });
  return { byKey: byKey, byEmail: byEmail };
}

/** Předpoklady pro ostré odesílání. @return {string[]} problémy */
function sendPreconditions_() {
  const p = [];
  if (!setting_('EMAIL_SUBJECT').trim()) p.push('Chybí EMAIL_SUBJECT.');
  if (!setting_('EMAIL_BODY').trim()) p.push('Chybí EMAIL_BODY.');
  if (!setting_('SENDER_IDENTIFICATION').trim()) p.push('Chybí SENDER_IDENTIFICATION (zákonná identifikace odesílatele).');
  if (!setting_('WEBAPP_URL').trim()) p.push('Chybí WEBAPP_URL (odkaz pro odhlášení).');
  const from = setting_('SENDER_EMAIL').trim().toLowerCase();
  if (from) {
    const me = Session.getEffectiveUser().getEmail().toLowerCase();
    const aliases = GmailApp.getAliases().map(function (a) { return String(a).toLowerCase(); });
    if (from !== me && aliases.indexOf(from) < 0) p.push('SENDER_EMAIL ' + from + ' není váš účet ani alias v Gmailu (Nastavení → Účty → Odesílat poštu jako).');
  }
  return p;
}

/**
 * Odeslání připravených zpráv.
 * @param {number} deadline
 * @param {Object} opts {manual:boolean} – ruční spuštění z administrace (ignoruje čas, ne bezpečnostní pravidla)
 * @return {Object} souhrn
 */
function runSendJob_(deadline, opts) {
  opts = opts || {};
  SETTINGS_CACHE_ = null;
  const summary = { mode: '', sent: 0, test: 0, blocked: 0, skipped: 0, failed: 0, stoppedBy: '' };
  if (!isSystemEnabled_()) { summary.stoppedBy = 'SYSTEM_ENABLED=FALSE'; return summary; }
  if (!opts.manual && !settingBool_('AUTO_SEND_ENABLED')) { summary.stoppedBy = 'AUTO_SEND_ENABLED=FALSE'; return summary; }
  const testMode = settingBool_('TEST_MODE');
  summary.mode = testMode ? 'TEST' : 'LIVE';
  const scope = setting_('EMAIL_LEGAL_SCOPE') || 'project_two_web_services';
  const maxPerContact = Math.max(1, settingInt_('MAX_EMAILS_PER_CONTACT', 1));
  const delayMs = Math.max(0, settingInt_('SEND_DELAY_SECONDS', 20)) * 1000;
  const today = todayPrague_();

  if (!testMode) {
    const pre = sendPreconditions_();
    if (pre.length) {
      logError_('send', '', 'ERROR', 'Odesílání zablokováno – chybí povinné nastavení.', pre.join(' '));
      summary.stoppedBy = 'PRECONDITIONS: ' + pre.join(' ');
      return summary;
    }
  }

  const logT = table_('EMAIL_LOG');
  let logRows = logT.readAll();
  // Osiřelé PENDING (pád mezi zápisem a potvrzením) => UNCERTAIN, nikdy se neodesílá znovu.
  const staleBefore = Date.now() - 30 * 60 * 1000;
  logRows.forEach(function (r) {
    if (r.status === 'PENDING' && parsePragueIso_(r.created_at) < staleBefore) {
      logT.update(r, { status: 'UNCERTAIN', error: 'Exekuce přerušena během odesílání – zkontrolujte složku Odeslané. Automaticky se neopakuje.', updated_at: nowIso_() });
      logError_('send', r.contact_id, 'WARN', 'PENDING záznam označen jako UNCERTAIN', r.log_id);
    }
  });
  let idx = emailLogIndex_(logRows);
  const sentToday = logRows.filter(function (r) { return r.mode === 'LIVE' && (r.status === 'SENT' || r.status === 'PENDING' || r.status === 'UNCERTAIN') && String(r.created_at).substring(0, 10) === today; }).length;
  let remaining = settingInt_('DAILY_SEND_LIMIT', 20) - sentToday;

  const ct = table_('CONTACTS');
  const legal = legalCtx_();
  const queue = ct.readAll().filter(function (c) { return c.draft_status === 'READY' && c.legal_status === LEGAL_STATUS.AUTHORIZED; })
    .sort(function (a, b) { return toInt_(b.potential_score, 0) - toInt_(a.potential_score, 0); });

  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    if (Date.now() >= deadline) { summary.stoppedBy = 'TIME_BUDGET'; break; }
    if (!isSystemEnabled_()) { summary.stoppedBy = 'SYSTEM_ENABLED=FALSE'; break; }
    if (!testMode && !opts.manual && !settingBool_('AUTO_SEND_ENABLED')) { summary.stoppedBy = 'AUTO_SEND_ENABLED=FALSE'; break; }
    if (!testMode && remaining <= 0) { summary.stoppedBy = 'DAILY_SEND_LIMIT'; break; }
    if (!testMode) {
      const quota = MailApp.getRemainingDailyQuota() - settingInt_('GMAIL_QUOTA_RESERVE', 5);
      if (quota <= 0) {
        summary.stoppedBy = 'GMAIL_QUOTA';
        logError_('send', '', 'WARN', 'Gmail denní kvóta vyčerpána (zbývá ' + MailApp.getRemainingDailyQuota() + '). Odesílání pozastaveno do zítřka.', '');
        break;
      }
    }
    const email = normEmail_(c.email);

    // 1) Právní brána – znovu a čerstvě
    const lg = evaluateLegal_(c, legal);
    if (lg.status !== LEGAL_STATUS.AUTHORIZED) {
      ct.update(c, { legal_status: lg.status, legal_checked_at: nowIso_(), draft_status: lg.status === LEGAL_STATUS.SUPPRESSED ? 'BLOCKED' : 'DRAFT_INTERNAL',
        status: lg.status === LEGAL_STATUS.SUPPRESSED ? CONTACT_STATUS.SUPPRESSED : c.status,
        communication_history: appendHistory_(c.communication_history, 'Odeslání zablokováno: ' + lg.reason) });
      logT.append([{ log_id: 'L-' + Utilities.getUuid().substring(0, 8), idempotency_key: 'BLOCK|' + email + '|' + today, contact_id: c.contact_id, email: email,
        campaign_id: c.campaign_id, mode: testMode ? 'TEST' : 'LIVE', status: lg.status === LEGAL_STATUS.SUPPRESSED ? 'BLOCKED_SUPPRESSION' : 'BLOCKED_LEGAL',
        subject: c.draft_subject, error: lg.reason, created_at: nowIso_(), updated_at: nowIso_() }]);
      summary.blocked++;
      continue;
    }

    // 2) Duplicity – adresa × rozsah
    const prior = (idx.byEmail[email] || []).filter(function (r) { return r.mode === 'LIVE' && SEND_BLOCKING_STATUSES.indexOf(r.status) >= 0 && String(r.idempotency_key).indexOf('|' + scope) > 0; });
    if (!testMode && prior.length >= maxPerContact) {
      ct.update(c, { draft_status: 'SENT', communication_history: appendHistory_(c.communication_history, 'Přeskočeno – adresa už obchodní sdělení dostala (' + prior[0].log_id + ').') });
      summary.skipped++;
      continue;
    }

    // 3) Sestavení zprávy z aktuální šablony
    const mail = buildEmail_(c);
    const issues = mail.problems.concat(mail.missing, mail.unknown);
    if (issues.length) {
      ct.update(c, { draft_status: 'MISSING_DATA', draft_missing: issues.join('; ') });
      summary.skipped++;
      continue;
    }
    const seq = prior.length + 1;
    const key = (testMode ? 'TEST|' + email + '|' + scope + '|' + today : 'LIVE|' + email + '|' + scope + '|' + seq);

    if (testMode) {
      if (idx.byKey[key]) { summary.skipped++; continue; }
      const row = { log_id: 'L-' + Utilities.getUuid().substring(0, 8), idempotency_key: key, contact_id: c.contact_id, email: email,
        campaign_id: c.campaign_id, mode: 'TEST', status: 'TEST_NOT_SENT', subject: mail.subject, body_hash: sha256Hex_(mail.body).substring(0, 16),
        legal_ref: lg.ref, error: 'Testovací režim – zpráva nebyla odeslána.', created_at: nowIso_(), updated_at: nowIso_() };
      logT.append([row]);
      idx = emailLogIndex_(logRows.concat([row])); logRows.push(row);
      ct.update(c, { communication_history: appendHistory_(c.communication_history, 'TEST: zpráva připravena, neodesláno (' + row.log_id + ')') });
      summary.test++;
      continue;
    }

    // 4) Ostré odeslání pod zámkem, PENDING před odesláním
    const res = withScriptLock_(function () {
      const fresh = logT.readAll().filter(function (r) { return r.idempotency_key === key && SEND_BLOCKING_STATUSES.indexOf(r.status) >= 0; });
      if (fresh.length) return { dup: true };
      const row = { log_id: 'L-' + Utilities.getUuid().substring(0, 8), idempotency_key: key, contact_id: c.contact_id, email: email,
        campaign_id: c.campaign_id, mode: 'LIVE', status: 'PENDING', subject: mail.subject, body_hash: sha256Hex_(mail.body).substring(0, 16),
        legal_ref: lg.ref, created_at: nowIso_(), updated_at: nowIso_() };
      logT.append([row]);
      if (typeof SpreadsheetApp.flush === 'function') SpreadsheetApp.flush();
      try {
        const threadId = gmailSend_(email, mail);
        logT.update(row, { status: 'SENT', gmail_thread_id: threadId, updated_at: nowIso_() });
        return { row: row, ok: true };
      } catch (e) {
        logT.update(row, { status: 'FAILED', error: truncate_(String(e.message || e), 500), updated_at: nowIso_() });
        return { row: row, ok: false, error: e };
      }
    }, 30000);
    if (!res) { summary.stoppedBy = 'LOCK_BUSY'; break; }
    if (res.dup) { summary.skipped++; continue; }
    logRows.push(res.row); idx = emailLogIndex_(logRows);
    if (res.ok) {
      ct.update(c, { draft_status: 'SENT', status: CONTACT_STATUS.CONTACTED, emails_sent: String(toInt_(c.emails_sent, 0) + 1), last_email_at: nowIso_(),
        communication_history: appendHistory_(c.communication_history, 'ODESLÁNO: "' + mail.subject + '" (' + res.row.log_id + ', ' + lg.ref + ')') });
      summary.sent++;
      remaining--;
      incrementCampaignSent_(c.campaign_id);
      sleep_(delayMs);
    } else {
      summary.failed++;
      const msg = String(res.error && res.error.message || res.error);
      logError_('send', c.contact_id, 'ERROR', 'Odeslání selhalo: ' + msg, email);
      const fails = (idx.byEmail[email] || []).filter(function (r) { return r.status === 'FAILED'; }).length;
      if (fails >= 3) ct.update(c, { draft_status: 'FAILED', communication_history: appendHistory_(c.communication_history, 'Odeslání 3× selhalo – zastaveno.') });
      if (/too many times|limit|quota/i.test(msg)) { summary.stoppedBy = 'GMAIL_QUOTA'; break; }
    }
  }
  PropertiesService.getScriptProperties().setProperty('P2_LAST_SEND_DATE', today);
  PropertiesService.getScriptProperties().setProperty('P2_LAST_SEND_SUMMARY', JSON.stringify(summary));
  return summary;
}

/** Odeslání přes Gmail (koncept → send), vrací ID vlákna pro sledování odpovědí. */
function gmailSend_(to, mail) {
  const o = { htmlBody: mail.html };
  const name = setting_('SENDER_NAME').trim();
  const from = setting_('SENDER_EMAIL').trim();
  const replyTo = setting_('REPLY_TO').trim();
  if (name) o.name = name;
  if (from && from.toLowerCase() !== Session.getEffectiveUser().getEmail().toLowerCase()) o.from = from;
  if (replyTo) o.replyTo = replyTo;
  const draft = GmailApp.createDraft(to, mail.subject, mail.body, o);
  const msg = draft.send();
  return msg && msg.getThread ? msg.getThread().getId() : '';
}

function incrementCampaignSent_(campaignId) {
  const t = table_('CAMPAIGNS');
  const row = t.readAll().filter(function (r) { return r.campaign_id === campaignId; })[0];
  if (row) t.update(row, { sent: String(toInt_(row.sent, 0) + 1) });
}

/** Ruční náhled – pošle jednu zprávu POUZE na TEST_RECIPIENT (vaši adresu). */
function sendPreviewToMe_(contactId) {
  const to = setting_('TEST_RECIPIENT');
  if (!isValidEmail_(to)) throw new Error('Nastavte TEST_RECIPIENT (váš e-mail).');
  const c = table_('CONTACTS').readAll().filter(function (x) { return x.contact_id === contactId; })[0];
  if (!c) throw new Error('Kontakt nenalezen');
  const mail = buildEmail_(c);
  const quota = MailApp.getRemainingDailyQuota();
  if (quota <= settingInt_('GMAIL_QUOTA_RESERVE', 5)) throw new Error('Gmail kvóta téměř vyčerpána (' + quota + ').');
  GmailApp.sendEmail(to, '[NÁHLED pro ' + c.email + '] ' + mail.subject, mail.body, { htmlBody: mail.html, name: setting_('SENDER_NAME') || undefined });
  return { to: to, subject: mail.subject, missing: mail.missing, problems: mail.problems };
}
