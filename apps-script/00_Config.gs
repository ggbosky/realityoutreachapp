/**
 * Project Two – Automatická akvizice realitních makléřů
 * Konfigurace, schémata listů a výchozí nastavení.
 *
 * Všechny soubory .gs sdílí globální scope (Google Apps Script, runtime V8).
 */

const P2 = {
  VERSION: '1.0.0',
  TIMEZONE: 'Europe/Prague',
  USER_AGENT: 'ProjectTwoBot/1.0 (+broker directory research; respects robots.txt)',
  ROBOTS_AGENT_TOKEN: 'ProjectTwoBot',
  // Max. doba jedné exekuce (Apps Script limit je 6 min) – necháváme rezervu.
  EXEC_BUDGET_MS: 4.5 * 60 * 1000,
  TICK_MINUTES: 10,
  STATE_KEY: 'P2_RUN_STATE',
  SEND_STATE_KEY: 'P2_SEND_STATE',
  SECRET_KEY: 'P2_HMAC_SECRET',
  COUNTER_KEY: 'P2_CONTACT_SEQ',
  POOL_SHEET: '_POOL',
};

/** Schémata listů – pořadí sloupců je závazné. */
const SCHEMA = {
  CONTACTS: [
    'contact_id', 'status', 'contact_type', 'full_name', 'first_name', 'last_name',
    'office_name', 'office_size', 'city', 'region', 'email', 'email_shared', 'phone',
    'website', 'website_source', 'own_domain', 'sources', 'source_profile_urls',
    'first_seen_at', 'last_seen_at', 'discovered_run', 'pre_priority', 'priority_reasons',
    'audit_status', 'audited_at', 'web_score', 'web_score_breakdown', 'findings_json',
    'findings_text', 'redesign_opportunity', 'recommended_service', 'potential_score',
    'high_potential', 'legal_status', 'legal_checked_at', 'legal_ref', 'draft_subject',
    'draft_body', 'draft_status', 'draft_missing', 'campaign_id', 'emails_sent',
    'last_email_at', 'communication_history', 'merge_keys', 'notes',
  ],
  EMAIL_LOG: [
    'log_id', 'idempotency_key', 'contact_id', 'email', 'campaign_id', 'mode', 'status',
    'subject', 'body_hash', 'legal_ref', 'gmail_thread_id', 'error', 'created_at', 'updated_at',
  ],
  SETTINGS: ['key', 'value', 'description'],
  CAMPAIGNS: [
    'campaign_id', 'run_date', 'name', 'legal_scope', 'template_hash', 'subject_snapshot',
    'status', 'test_mode', 'target', 'candidates', 'new_contacts', 'audited', 'high_potential',
    'drafts', 'authorized', 'needs_legal_review', 'sent', 'shortfall_reason',
    'sources_summary', 'started_at', 'finished_at',
  ],
  SUPPRESSION: ['email', 'contact_id', 'reason', 'source', 'added_at', 'note'],
  LEGAL_CONSENTS: [
    'consent_id', 'contact_id', 'email', 'legal_basis', 'scope', 'consent_text', 'source',
    'evidence_ref', 'obtained_at', 'valid_until', 'withdrawn_at', 'verified', 'recorded_by',
    'recorded_at', 'notes',
  ],
  SOURCES: [
    'source_id', 'name', 'base_url', 'module', 'enabled', 'status', 'robots_status',
    'tos_status', 'tos_evidence', 'crawl_delay_ms', 'max_pages', 'config_json',
    'last_checked_at', 'last_run_at', 'last_found', 'total_found', 'notes',
  ],
  ERROR_LOG: ['ts', 'run_id', 'job', 'source', 'severity', 'message', 'details'],
  _POOL: ['pool_key', 'source_id', 'payload_json', 'added_at'],
};

/** Stavy kontaktu (CONTACTS.status) */
const CONTACT_STATUS = {
  NEW: 'NEW',                 // uložen, čeká na hodnocení webu
  AUDITED: 'AUDITED',         // web vyhodnocen (nebo web neexistuje)
  SCORED: 'SCORED',           // spočítán obchodní potenciál
  PROCESSED: 'PROCESSED',     // připraven koncept / právní status
  CONTACTED: 'CONTACTED',     // odeslán e-mail
  REPLIED: 'REPLIED',
  SUPPRESSED: 'SUPPRESSED',
};

/** Právní status kontaktu */
const LEGAL_STATUS = {
  AUTHORIZED: 'AUTHORIZED',
  NEEDS_LEGAL_REVIEW: 'NEEDS_LEGAL_REVIEW',
  SUPPRESSED: 'SUPPRESSED',
  NO_EMAIL: 'NO_EMAIL',
};

/** Právní důvody, které systém akceptuje pro automatické odeslání. */
const ACCEPTED_LEGAL_BASES = {
  // Předchozí souhlas adresáta (§ 7 odst. 2 zák. č. 480/2004 Sb.)
  CONSENT: 'Výslovný předchozí souhlas adresáta (§ 7 odst. 2 zák. 480/2004 Sb.)',
  // Stávající zákazník – vlastní obdobné produkty (§ 7 odst. 3 zák. 480/2004 Sb.)
  EXISTING_CUSTOMER: 'Stávající zákazník, obdobné vlastní produkty (§ 7 odst. 3 zák. 480/2004 Sb.)',
};

/** Výchozí nastavení (list SETTINGS). Hodnoty jsou řetězce; boolean = TRUE/FALSE. */
const DEFAULT_SETTINGS = [
  // --- Hlavní vypínač ---
  ['SYSTEM_ENABLED', 'TRUE', 'Hlavní vypínač celého systému. FALSE = vše zastaveno.'],
  // --- Plánovač ---
  ['DAILY_SCAN_ENABLED', 'TRUE', 'Denní skenování katalogů ON/OFF.'],
  ['DAILY_CONTACT_TARGET', '100', 'Počet nových makléřů zpracovaných denně.'],
  ['SCAN_TIME', '08:00', 'Čas spuštění denního skenování (Europe/Prague), HH:MM.'],
  ['SEND_TIME', '10:00', 'Čas spuštění odesílání (Europe/Prague), HH:MM.'],
  ['AUTO_SEND_ENABLED', 'FALSE', 'Automatické odesílání ON/OFF.'],
  ['TEST_MODE', 'TRUE', 'Testovací režim: TRUE = žádný e-mail není odeslán kontaktům.'],
  ['INBOX_MONITOR_ENABLED', 'TRUE', 'Kontrola odpovědí (odhlášení, bounce) v Gmailu.'],
  // --- E-mail settings ---
  ['EMAIL_SUBJECT', '', 'Předmět e-mailu (podporuje proměnné {{...}}).'],
  ['EMAIL_BODY', '', 'Text e-mailu – dodáte vlastní šablonu (podporuje proměnné {{...}}).'],
  ['EMAIL_SIGNATURE', '', 'Podpis připojený pod text e-mailu.'],
  ['SENDER_NAME', '', 'Jméno odesílatele zobrazené příjemci.'],
  ['SENDER_EMAIL', '', 'Odesílací e-mail. Musí být váš Gmail nebo alias nastavený v Gmailu („Odesílat poštu jako“).'],
  ['REPLY_TO', '', 'Volitelná adresa pro odpovědi.'],
  ['SENDER_IDENTIFICATION', '', 'Povinná identifikace odesílatele (firma/jméno, IČO, sídlo, kontakt) – vkládá se do patičky.'],
  ['EMAIL_FOOTER', 'Toto je obchodní sdělení. Odesílatel: {{identifikace_odesilatele}}\nPokud si nepřejete dostávat další zprávy, odhlaste se zde: {{odhlaseni_url}} nebo odpovězte slovem ODHLÁSIT.', 'Povinná patička – musí obsahovat {{odhlaseni_url}} a označení „obchodní sdělení“.'],
  ['DAILY_SEND_LIMIT', '20', 'Max. počet odeslaných e-mailů za den (Gmail zdarma = max. 100 příjemců/den).'],
  ['SEND_DELAY_SECONDS', '20', 'Pauza mezi jednotlivými e-maily (s).'],
  ['MAX_EMAILS_PER_CONTACT', '1', 'Kolik obchodních sdělení smí jeden kontakt (adresa) dostat v rámci jednoho právního rozsahu.'],
  ['EMAIL_LEGAL_SCOPE', 'project_two_web_services', 'Rozsah obchodního sdělení – souhlas musí mít stejný rozsah (nebo ALL).'],
  ['WEBAPP_URL', '', 'URL nasazené webové aplikace (pro odkaz na odhlášení). Bez ní se nic neodešle.'],
  ['TEST_RECIPIENT', '', 'Váš e-mail pro ruční náhled zprávy (nikdy se nepoužije automaticky).'],
  ['GMAIL_QUOTA_RESERVE', '5', 'Rezerva Gmail kvóty, kterou systém nikdy nevyčerpá.'],
  // --- Výběr a hodnocení ---
  ['HIGH_POTENTIAL_THRESHOLD', '70', 'Skóre potenciálu, od kterého je kontakt „vysoký potenciál“.'],
  ['DRAFT_MIN_POTENTIAL', '50', 'Min. skóre potenciálu pro přípravu konceptu e-mailu.'],
  ['PAGESPEED_API_KEY', '', 'Volitelný klíč Google PageSpeed Insights API (zdarma) pro přesnější měření rychlosti a mobilní verze.'],
  ['SLOW_RESPONSE_MS', '3000', 'Odezva nad touto hodnotou = pomalý web.'],
  ['SERVICE_MAP_JSON', JSON.stringify({
    NO_WEBSITE: 'Nový web makléře (osobní prezentace + nabídka nemovitostí)',
    UNREACHABLE: 'Nový web / obnova nefunkčního webu',
    NO_OWN_DOMAIN: 'Vlastní doména a profesionální web',
    NO_VIEWPORT: 'Responzivní redesign pro mobily',
    OUTDATED: 'Kompletní redesign webu',
    SLOW: 'Optimalizace rychlosti a technický upgrade webu',
    NO_HTTPS: 'Zabezpečení webu (HTTPS) a technický upgrade',
    WEAK_PRESENTATION: 'Prezentace nemovitostí a služeb (obsah, struktura, fotky)',
    DEFAULT: 'Konzultace a audit webové prezentace',
  }), 'Mapování zjištěných nedostatků na službu Project Two (JSON).'],
];

/** Výchozí zdroje (list SOURCES). Ověřeno 2026-11-12 – viz docs/SOURCES_AUDIT.md */
const DEFAULT_SOURCES = [
  {
    source_id: 'ark', name: 'ARK ČR – Asociace realitních kanceláří', base_url: 'https://www.arkcr.cz',
    module: 'ark', enabled: 'TRUE', status: 'OK', robots_status: 'ALLOWED',
    tos_status: 'NO_RESTRICTION_FOUND',
    tos_evidence: 'robots.txt: "User-agent: * / Disallow:" (vše povoleno). Web nepublikuje podmínky užívání omezující automatizovaný přístup (zkontrolováno /ochrana-soukromi, /kontakty, patička).',
    crawl_delay_ms: '2000', max_pages: '40', config_json: '',
    notes: 'Veřejný seznam členů (/clenove) a makléřů (/makleri). Stránkování ?page=N.',
  },
  {
    source_id: 'srovnani', name: 'Srovnání makléřů', base_url: 'https://www.srovnani-makleru.cz',
    module: 'srovnani', enabled: 'FALSE', status: 'NEEDS_TOS_REVIEW', robots_status: 'ALLOWED',
    tos_status: 'NEEDS_REVIEW',
    tos_evidence: 'robots.txt povoluje profily makléřů. Obchodní podmínky jsou dostupné jen přes URL s "do=ajaxDialog", které robots.txt zakazuje – bot je nečetl. Před zapnutím je přečtěte ručně (patička webu → Obchodní podmínky) a nastavte tos_status=APPROVED. Profily neobsahují e-mail ani web.',
    crawl_delay_ms: '3000', max_pages: '15', config_json: '',
    notes: 'Seznam /realitni-makleri/?paginator-page=N. Data: jméno, kancelář, lokalita. Slouží hlavně ke sloučení profilů.',
  },
  {
    source_id: 'jenreality', name: 'JenReality – adresář RK', base_url: 'https://www.jenreality.cz',
    module: 'jenreality', enabled: 'FALSE', status: 'BLOCKED_TOS', robots_status: 'ALLOWED',
    tos_status: 'PROHIBITED',
    tos_evidence: 'Smluvní obchodní podmínky čl. 4.5: „Bez předchozího písemného souhlasu provozovatele nesmíte zejména vytvářet databázi … systematickým stahováním a ukládáním celého Obsahu nebo jeho libovolné části.“ Zapnout jen s doloženým písemným souhlasem provozovatele (tos_status=WRITTEN_PERMISSION).',
    crawl_delay_ms: '3000', max_pages: '1', config_json: '',
    notes: 'Modul připraven, ale vypnut kvůli podmínkám.',
  },
  {
    source_id: 'ceskereality', name: 'České reality', base_url: 'https://www.ceskereality.cz',
    module: 'robots_monitor', enabled: 'TRUE', status: 'BLOCKED_ROBOTS', robots_status: 'DISALLOWED',
    tos_status: 'NOT_EVALUATED',
    tos_evidence: 'robots.txt: "User-agent: *  Disallow: /" – obecným botům zakázán celý web (povoleno jen vyhledávačům). Modul pouze denně kontroluje robots.txt.',
    crawl_delay_ms: '2000', max_pages: '0', config_json: '',
    notes: 'Nedostupné. Alternativa: požádat provozovatele (CESKY INTERNET s.r.o.) o export / souhlas.',
  },
  {
    source_id: 'superhome', name: 'SuperHome', base_url: 'https://superhome.cz',
    module: 'robots_monitor', enabled: 'TRUE', status: 'BLOCKED_ROBOTS', robots_status: 'DISALLOWED',
    tos_status: 'NOT_EVALUATED',
    tos_evidence: 'robots.txt: "User-agent: *  Disallow: /" – povoleno jen vyjmenovaným vyhledávačům. Modul pouze denně kontroluje robots.txt.',
    crawl_delay_ms: '2000', max_pages: '0', config_json: '',
    notes: 'Nedostupné. www.superhome.cz přesměrovává na superhome.cz.',
  },
];

/** Freemailové domény – web z e-mailové domény se z nich neodvozuje. */
const FREEMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'seznam.cz', 'email.cz', 'post.cz', 'centrum.cz', 'atlas.cz',
  'volny.cz', 'tiscali.cz', 'quick.cz', 'iol.cz', 'outlook.com', 'outlook.cz', 'hotmail.com',
  'hotmail.cz', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'tiscali.cz', 'azet.sk',
  'protonmail.com', 'proton.me', 'o2active.cz', 'chello.cz', 'gmx.com', 'gmx.net', 'mail.com',
];

/** Hostingy/bezplatné subdomény – web na nich = bez vlastní domény. */
const FREE_SUBDOMAIN_HOSTS = [
  'webnode.cz', 'webnode.com', 'estranky.cz', 'wixsite.com', 'wix.com', 'blogspot.com',
  'sweb.cz', 'ic.cz', 'mypage.cz', 'websnadno.cz', 'webgarden.cz', 'rajce.idnes.cz',
  'unas.cz', 'xf.cz', 'wordpress.com', 'weebly.com', 'jimdo.com', 'jimdofree.com',
  'webflow.io', 'netlify.app', 'github.io', 'sites.google.com', 'business.site', 'my.canva.site',
];

/** Franšízové sítě / velké RK – nižší pravděpodobnost samostatného rozhodování o webu. */
const FRANCHISE_PATTERNS = [
  /re\/?max/i, /remax/i, /century\s?21/i, /m&m\s?reality/i, /mmreality/i, /bidli/i,
  /svoboda\s*&\s*williams/i, /realitni spolecnost ceske sporitelny/i, /česká spořitelna/i,
  /ceska sporitelna/i, /bezrealitky/i, /maxima reality/i, /next reality/i, /era reality/i,
  /reality iq/i, /evropa realitni/i, /dumrealit/i, /fincentrum/i, /keller williams/i, /rk\s?century/i,
];
