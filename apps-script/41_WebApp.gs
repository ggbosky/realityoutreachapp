/**
 * Vstupní body: menu v tabulce, inicializace, web app (administrace + veřejné odhlášení).
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Project Two')
    .addItem('Otevřít administraci', 'openAdmin')
    .addSeparator()
    .addItem('1) Inicializace (listy, nastavení, plánovač)', 'setup')
    .addItem('Spustit sken teď', 'menuRunScan')
    .addItem('Spustit testy systému', 'menuRunTests')
    .addSeparator()
    .addItem('⛔ NOUZOVÉ ZASTAVENÍ', 'menuStop')
    .addToUi();
}

/** Jednorázová inicializace – bezpečné spustit opakovaně (nic nemaže). */
function setup() {
  assertAdmin_();
  ensureSchema_();
  seedSettings_();
  seedSources_();
  getSecret_();
  installTriggers_();
  const ss = getSs_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  return { ok: true, spreadsheet: ss.getUrl ? ss.getUrl() : ss.getId(), triggers: ScriptApp.getProjectTriggers().length,
    testMode: settingBool_('TEST_MODE'), autoSend: settingBool_('AUTO_SEND_ENABLED') };
}

function openAdmin() {
  assertAdmin_();
  const html = HtmlService.createTemplateFromFile('Admin').evaluate().setWidth(1400).setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, 'Project Two – administrace');
}

function menuRunScan() {
  assertAdmin_();
  const r = apiRunScanNow(false);
  SpreadsheetApp.getUi().alert(r.ok ? 'Sken běží – fáze: ' + (r.data && r.data.phase) + '. Pokračuje automaticky každých 10 min.' : 'Chyba: ' + r.error);
}

function menuRunTests() {
  assertAdmin_();
  const r = runSelfTests_();
  SpreadsheetApp.getUi().alert('Testy: ' + r.passed + ' OK, ' + r.failed + ' chyb\n\n' + r.results.map(function (x) { return (x.ok ? '✓ ' : '✗ ') + x.name + (x.ok ? '' : ' – ' + x.error); }).join('\n'));
}

function menuStop() {
  assertAdmin_();
  emergencyStop_(Session.getActiveUser().getEmail());
  SpreadsheetApp.getUi().alert('Vše zastaveno: SYSTEM_ENABLED=FALSE, AUTO_SEND_ENABLED=FALSE, triggery odstraněny.');
}

/** Pomocná funkce pro šablony HTML. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Web app: ?action=unsubscribe → veřejná stránka odhlášení; jinak administrace (jen vlastník). */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'unsubscribe') {
    const t = HtmlService.createTemplateFromFile('Unsubscribe');
    t.c = String(p.c || '').replace(/[^A-Za-z0-9\-]/g, '').substring(0, 20);
    t.t = String(p.t || '').replace(/[^a-f0-9]/g, '').substring(0, 64);
    t.valid = verifyUnsubscribe_(t.c, t.t) ? 'yes' : 'no';
    t.identification = setting_('SENDER_IDENTIFICATION');
    return t.evaluate().setTitle('Odhlášení z komunikace').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  try { assertAdmin_(); } catch (err) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Přístup odepřen.</p>').setTitle('Project Two');
  }
  return HtmlService.createTemplateFromFile('Admin').evaluate().setTitle('Project Two – administrace')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function verifyUnsubscribe_(contactId, token) {
  if (!contactId || !token) return null;
  const c = table_('CONTACTS').readAll().filter(function (x) { return x.contact_id === contactId; })[0];
  if (!c || !normEmail_(c.email)) return null;
  const expected = unsubscribeToken_(c.contact_id, normEmail_(c.email));
  if (expected.length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? c : null;
}

/** Veřejně volatelné z Unsubscribe.html – chráněno HMAC tokenem. */
function publicUnsubscribe(contactId, token) {
  const c = verifyUnsubscribe_(String(contactId || ''), String(token || ''));
  if (!c) return { ok: false, message: 'Odkaz je neplatný. Odpovězte prosím na e-mail slovem ODHLÁSIT a vyřadíme vás ručně.' };
  addSuppression_(c.email, c.contact_id, 'Odhlášení odkazem v e-mailu', 'UNSUBSCRIBE_LINK', '');
  return { ok: true, message: 'Hotovo. Adresa ' + c.email + ' byla vyřazena a další zprávy vám nepošleme.' };
}
