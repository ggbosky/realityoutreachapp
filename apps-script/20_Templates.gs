/**
 * Šablony e-mailů – text dodává uživatel v EMAIL SETTINGS. Nic není natvrdo.
 * Pokud šablona použije proměnnou, pro kterou nemáme ověřený údaj, zpráva se NEodešle automaticky
 * (stav MISSING_DATA) – nikdy nedoplňujeme odhad.
 */

const TEMPLATE_VARS = ['jmeno', 'prijmeni', 'realitni_kancelar', 'mesto', 'url_webu', 'konkretni_postreh'];
const SYSTEM_VARS = ['identifikace_odesilatele', 'odhlaseni_url', 'odesilatel'];

function templateVarsFor_(c, extra) {
  const name = splitPersonName_(c.full_name);
  const web = c.website ? (c.website.match(/^https?:\/\/([^\/?#]+)/i) || [, ''])[1] : '';
  const v = {
    jmeno: c.contact_type === 'BROKER' ? (c.first_name || name.first) : '',
    prijmeni: c.contact_type === 'BROKER' ? (c.last_name || name.last) : '',
    realitni_kancelar: c.office_name || '',
    mesto: c.city || '',
    url_webu: web,
    konkretni_postreh: c._postreh !== undefined ? c._postreh : pickPostreh_(safeJsonParse_(c.findings_json, [])),
  };
  return Object.assign(v, extra || {});
}

/**
 * @return {{text:string, missing:string[], unknown:string[]}}
 */
function renderTemplate_(tpl, vars) {
  const missing = [], unknown = [];
  const text = String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (all, key) {
    key = key.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(vars, key)) { unknown.push(key); return all; }
    const val = vars[key];
    if (val === '' || val === null || val === undefined) { missing.push(key); return all; }
    return String(val);
  });
  return { text: text, missing: uniq_(missing), unknown: uniq_(unknown) };
}

function unsubscribeUrl_(c) {
  const base = setting_('WEBAPP_URL');
  if (!base) return '';
  const email = normEmail_(c.email);
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'action=unsubscribe&c=' + encodeURIComponent(c.contact_id) +
    '&t=' + unsubscribeToken_(c.contact_id, email);
}

function unsubscribeToken_(contactId, email) {
  return hmacHex_(contactId + '|' + email, getSecret_()).substring(0, 32);
}

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty(P2.SECRET_KEY);
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty(P2.SECRET_KEY, s); }
  return s;
}

/**
 * Sestaví celý e-mail pro kontakt.
 * @return {{subject, body, html, missing:string[], unknown:string[], problems:string[]}}
 */
function buildEmail_(c) {
  const subjectTpl = setting_('EMAIL_SUBJECT');
  const bodyTpl = setting_('EMAIL_BODY');
  const problems = [];
  if (!subjectTpl.trim()) problems.push('Chybí předmět (EMAIL_SUBJECT).');
  if (!bodyTpl.trim()) problems.push('Chybí text e-mailu (EMAIL_BODY).');
  if (!setting_('SENDER_IDENTIFICATION').trim()) problems.push('Chybí identifikace odesílatele (SENDER_IDENTIFICATION).');
  const unsub = unsubscribeUrl_(c);
  if (!unsub) problems.push('Chybí WEBAPP_URL – nelze vytvořit odkaz pro odhlášení.');
  const footerTpl = setting_('EMAIL_FOOTER');
  if (footerTpl.indexOf('{{odhlaseni_url}}') < 0) problems.push('Patička neobsahuje {{odhlaseni_url}}.');

  const vars = templateVarsFor_(c, {
    identifikace_odesilatele: setting_('SENDER_IDENTIFICATION'),
    odhlaseni_url: unsub,
    odesilatel: setting_('SENDER_NAME'),
  });
  const s = renderTemplate_(subjectTpl, vars);
  const b = renderTemplate_(bodyTpl, vars);
  const sig = renderTemplate_(setting_('EMAIL_SIGNATURE'), vars);
  const f = renderTemplate_(footerTpl, vars);
  if (!/obchodní sdělení/i.test(b.text + '\n' + f.text + '\n' + s.text)) {
    problems.push('Zpráva není zřetelně označena jako obchodní sdělení (§ 7 odst. 4 zák. 480/2004 Sb.) – doplňte to do patičky nebo textu.');
  }
  const missing = uniq_([].concat(s.missing, b.missing, sig.missing, f.missing));
  const unknown = uniq_([].concat(s.unknown, b.unknown, sig.unknown, f.unknown));
  const body = b.text.trim() + (sig.text.trim() ? '\n\n' + sig.text.trim() : '') + '\n\n—\n' + f.text.trim();
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">' +
    escapeHtml_(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';
  return { subject: oneLine_(s.text), body: body, html: html, missing: missing, unknown: unknown, problems: problems };
}
