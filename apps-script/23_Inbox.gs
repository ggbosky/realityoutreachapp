/**
 * Kontrola odpovědí v Gmailu:
 *  - odpověď obsahující žádost o odhlášení → SUPPRESSION (zdroj REPLY),
 *  - jiná odpověď → kontakt REPLIED (dále se automaticky neoslovuje),
 *  - nedoručitelnost (mailer-daemon) → SUPPRESSION (zdroj BOUNCE).
 */

const UNSUBSCRIBE_RE = /odhl[aá]s|nem[aá]m\s+z[aá]jem|nezaj[ií]m[aá]|nepi[sš]te|nekontaktujte|neobt[eě][zž]ujte|unsubscribe|opt[\s-]?out|\bstop\b|vy[rř]a[dď]te|smaz?at?e?\s+(m[eě]|m[uů]j)|gdpr/i;

function runInboxMonitor_(deadline) {
  const out = { checked: 0, replies: 0, unsubscribed: 0, bounces: 0 };
  if (!isSystemEnabled_() || !settingBool_('INBOX_MONITOR_ENABLED')) return out;
  const logT = table_('EMAIL_LOG');
  const ct = table_('CONTACTS');
  const contacts = ct.readAll();
  const byId = {};
  contacts.forEach(function (c) { byId[c.contact_id] = c; });
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const sender = (setting_('SENDER_EMAIL') || me).toLowerCase();
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const sent = logT.readAll().filter(function (r) { return r.status === 'SENT' && r.gmail_thread_id && parsePragueIso_(r.created_at) > cutoff; });

  sent.forEach(function (r) {
    if (Date.now() >= deadline) return;
    const c = byId[r.contact_id];
    if (!c || c.status === CONTACT_STATUS.SUPPRESSED) return;
    let thread;
    try { thread = GmailApp.getThreadById(r.gmail_thread_id); } catch (e) { return; }
    if (!thread) return;
    out.checked++;
    const msgs = thread.getMessages();
    for (let i = 0; i < msgs.length; i++) {
      const from = String(msgs[i].getFrom()).toLowerCase();
      if (from.indexOf(me) >= 0 || from.indexOf(sender) >= 0) continue;
      if (msgs[i].getDate().getTime() < parsePragueIso_(r.created_at)) continue;
      const body = String(msgs[i].getPlainBody() || '').split(/\n>|\nOn .* wrote:|\nDne .* napsal/)[0];
      if (/mailer-daemon|postmaster/.test(from)) {
        addSuppression_(c.email, c.contact_id, 'Nedoručitelné (bounce)', 'BOUNCE', truncate_(body, 300));
        out.bounces++;
        return;
      }
      if (UNSUBSCRIBE_RE.test(body)) {
        addSuppression_(c.email, c.contact_id, 'Odmítnutí v odpovědi na e-mail', 'REPLY', truncate_(body, 300));
        out.unsubscribed++;
        return;
      }
      if (c.status !== CONTACT_STATUS.REPLIED) {
        ct.update(c, { status: CONTACT_STATUS.REPLIED, communication_history: appendHistory_(c.communication_history, 'ODPOVĚĎ od ' + from + ': ' + truncate_(oneLine_(body), 200)) });
        c.status = CONTACT_STATUS.REPLIED;
        out.replies++;
      }
      return;
    }
  });

  // Bounce zprávy, které nejsou ve vlákně (některé servery posílají nové vlákno)
  try {
    const threads = GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:7d', 0, 30);
    const sentEmails = {};
    sent.forEach(function (r) { sentEmails[normEmail_(r.email)] = r; });
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        const body = String(m.getPlainBody() || '').toLowerCase();
        Object.keys(sentEmails).forEach(function (e) {
          const c = byId[sentEmails[e].contact_id];
          if (e && body.indexOf(e) >= 0 && c && c.status !== CONTACT_STATUS.SUPPRESSED) {
            addSuppression_(e, c.contact_id, 'Nedoručitelné (bounce)', 'BOUNCE', '');
            c.status = CONTACT_STATUS.SUPPRESSED;
            out.bounces++;
          }
        });
      });
    });
  } catch (e) {
    logError_('inbox', '', 'WARN', 'Vyhledání bounce zpráv selhalo: ' + e, '');
  }
  PropertiesService.getScriptProperties().setProperty('P2_LAST_INBOX_CHECK', String(Date.now()));
  return out;
}
