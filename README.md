# Project Two – automatická akvizice realitních makléřů

Cloudový systém v **Google Apps Script + Google Sheets**, který každý den (výchozí 08:00, Europe/Prague) bez
zapnutého počítače:

1. projde povolené katalogy makléřů (respektuje robots.txt a podmínky užívání),
2. najde až **100 nových** makléřů, sloučí duplicity napříč katalogy a uloží je s unikátním ID,
3. najde a vyhodnotí jejich weby (skóre 0–100 v 8 kategoriích, konkrétní doložené nedostatky),
4. spočítá obchodní potenciál a doporučí službu Project Two,
5. připraví personalizované koncepty podle **vaší** šablony,
6. ověří právní oprávnění a **odešle jen tam, kde je doložené** (jinak `NEEDS_LEGAL_REVIEW`),
7. vše zapíše do databáze; odpovědi „nemám zájem“ a nedoručitelnost automaticky zařadí do SUPPRESSION.

> Repozitář byl na začátku prázdný – Project Two v něm neexistoval, modul je proto postavený jako samostatná aplikace.

## Obsah

| Cesta | Co obsahuje |
|---|---|
| `apps-script/` | Celá aplikace pro Google Apps Script (17 souborů `.gs`, 2× `.html`, `appsscript.json`) |
| `docs/SOURCES_AUDIT.md` | Audit 5 zdrojů: robots.txt, podmínky, struktura, verdikt |
| `docs/LEGAL.md` | Jak systém vynucuje zák. 480/2004 Sb. a GDPR, jak zapisovat souhlasy |
| `test/` | Testy: offline (simulovaný internet), UI (Playwright), živý test proti skutečným webům |

## Architektura

```
time-driven trigger „tick“ (každých 10 min, cloud Google)
  ├─ v SCAN_TIME: denní běh = stavový automat s checkpointy (Script Properties)
  │    DISCOVER → SELECT → ENRICH → AUDIT → DRAFT → FINALIZE → DONE
  │    (každá exekuce max. 4,5 min; po přerušení/chybě pokračuje přesně tam, kde skončila)
  ├─ v SEND_TIME (po dokončení skenu): odesílání s právní bránou, limity a kontrolou kvót
  └─ 1× za hodinu: kontrola odpovědí / odhlášení / bounce v Gmailu
Google Sheets = databáze: CONTACTS, EMAIL_LOG, SETTINGS, CAMPAIGNS, SUPPRESSION, LEGAL_CONSENTS, SOURCES, ERROR_LOG (+ skrytý _POOL)
Administrace = Admin.html (dialog v tabulce nebo web app jen pro vlastníka)
Veřejná stránka odhlášení = Unsubscribe.html (web app, chráněno HMAC tokenem)
```

| Soubor | Účel |
|---|---|
| `00_Config.gs` | Schémata listů, výchozí nastavení a zdroje |
| `01_Util.gs`, `02_Db.gs`, `03_Settings.gs` | Pomocné funkce, databázová vrstva nad Sheets, nastavení |
| `04_Robots.gs`, `05_Http.gs` | Parser robots.txt (RFC 9309), zdvořilé HTTP (crawl-delay, opakování, přesměrování, kódování) |
| `10_Parsers.gs`, `11_Sources.gs` | Parsery a moduly zdrojů (ARK, Srovnání makléřů, JenReality, robots monitor, obecný katalog) |
| `12_Dedupe.gs` | Slučování profilů, deduplikace, předběžná priorita |
| `13_WebAudit.gs`, `14_Scoring.gs` | Hodnocení webů, skóre kvality a potenciálu, doporučená služba, `{{konkretni_postreh}}` |
| `20_Templates.gs`, `21_Legal.gs` | Šablony a proměnné, právní brána, SUPPRESSION |
| `22_Mailer.gs`, `23_Inbox.gs` | Odesílání (idempotence, kvóty, limity), kontrola odpovědí |
| `30_Scheduler.gs`, `31_Jobs.gs` | Plánovač, denní pipeline, kampaně |
| `40_Admin.gs`, `41_WebApp.gs` | API administrace, menu, web app, odhlášení |
| `50_SelfTest.gs` | Testy spustitelné přímo v Apps Script |

---

## Nasazení – krok za krokem (cca 15 minut)

### 1. Vytvořte tabulku a projekt Apps Script

1. Na [sheets.new](https://sheets.new) vytvořte prázdnou tabulku, pojmenujte ji např. **Project Two – Akvizice**.
2. V tabulce: **Rozšíření → Apps Script**.
3. V editoru: **Nastavení projektu (ozubené kolo) → zaškrtněte „Zobrazit soubor manifestu appsscript.json“**.
   Časovou zónu ponechte – nastaví ji manifest (`Europe/Prague`).

### 2. Nahrajte kód

**Varianta A – ručně (bez instalace čehokoli):**

1. V editoru otevřete `appsscript.json` a nahraďte jeho obsah souborem `apps-script/appsscript.json`.
2. Smažte výchozí `Kód.gs` / `Code.gs`.
3. Pro každý soubor `apps-script/*.gs` klikněte na **+ → Skript**, pojmenujte ho stejně (bez `.gs`) a vložte obsah.
   Pořadí nehraje roli.
4. Pro `Admin.html` a `Unsubscribe.html` použijte **+ → HTML** a pojmenujte `Admin` a `Unsubscribe`.
5. Uložte (Ctrl+S).

**Varianta B – clasp (rychlejší při aktualizacích):**

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

Povolte Apps Script API na <https://script.google.com/home/usersettings>. ID skriptu najdete v editoru v
**Nastavení projektu → ID skriptu**; zkopírujte `.clasp.json.example` na `.clasp.json` a ID vložte. Pak:

```bash
clasp push
```

### 3. Jednorázová autorizace

V editoru vyberte funkci **`setup`** a klikněte na **Spustit**. Google zobrazí:

1. „Je vyžadována autorizace“ → **Zkontrolovat oprávnění** → vyberte svůj účet.
2. „Google tuto aplikaci neověřil“ → **Rozšířené → Přejít na Project Two (nebezpečné)**. To je normální u
   vlastního skriptu – aplikaci jste napsali vy a běží jen ve vašem účtu.
3. **Povolit**.

| Oprávnění (scope) | Proč ho systém potřebuje |
|---|---|
| `spreadsheets` – zobrazení a úpravy tabulek | databáze v Google Sheets |
| `script.external_request` – připojení k externím službám | čtení katalogů a hodnocení webů makléřů (UrlFetchApp) |
| `script.scriptapp` – spouštění, když nejste přítomni | plánovač (time-driven trigger běžící 24/7 v cloudu) |
| `script.container.ui` – zobrazování obsahu v Google aplikacích | menu „Project Two“ a dialog administrace |
| `mail.google.com` – číst, vytvářet, odesílat e-maily v Gmailu | odeslání přes Gmail (včetně aliasu), čtení odpovědí s odhlášením a nedoručitelností |
| `script.send_mail` | zjištění zbývající denní kvóty e-mailů |
| `userinfo.email` | ověření, že administraci ovládá jen vlastník |

`setup` vytvoří všechny listy, výchozí nastavení (**TEST_MODE = TRUE, AUTO_SEND_ENABLED = FALSE**), 5 zdrojů,
tajný klíč pro odkazy na odhlášení a nainstaluje plánovač (`tick` každých 10 minut). Spustit ho opakovaně je bezpečné.

### 4. Nasaďte web aplikaci (odkaz pro odhlášení)

1. **Nasadit → Nové nasazení → typ: Webová aplikace**.
2. *Spustit jako*: **Já**; *Kdo má přístup*: **Kdokoli** (musí, aby příjemce mohl kliknout na odhlášení bez Google účtu).
3. **Nasadit** a zkopírujte URL (`https://script.google.com/macros/s/…/exec`).
4. URL vložte v administraci do **E-mailové šablony → URL web aplikace**.

Administrace i všechny serverové funkce ověřují, že je volá vlastník; anonymní návštěvník web aplikace vidí jen
stránku odhlášení s platným podepsaným odkazem. Po každé změně kódu: **Nasadit → Spravovat nasazení → Upravit →
Verze: Nová verze** (URL zůstane stejná).

### 5. Otevřete administraci a spusťte testy

1. Obnovte tabulku (F5) → v menu se objeví **Project Two → Otevřít administraci**.
2. **Nastavení automatizace → Spustit testy systému** – ověří časovou zónu, robots.txt zdrojů, živé čtení ARK,
   Gmail kvótu, plánovač, listy a logiku (nic neodesílá).

### 6. Vyplňte EMAIL SETTINGS

Administrace → **E-mailové šablony**: předmět, text, podpis, jméno odesílatele, odesílací e-mail, identifikace
odesílatele (firma/jméno, IČO, sídlo), denní limit, čas odesílání. Proměnné vložíte kliknutím:

| Proměnná | Hodnota | Zdroj |
|---|---|---|
| `{{jmeno}}`, `{{prijmeni}}` | křestní jméno a příjmení makléře (bez titulů, 1. pád) | katalog |
| `{{realitni_kancelar}}` | název kanceláře | katalog |
| `{{mesto}}` | město | adresa kanceláře v katalogu, lokalita profilu, nebo sídlo firmy v registru ARES (jen při jednoznačné shodě) |
| `{{url_webu}}` | doména webu, např. `www.firma.cz` | katalog nebo ověřená doména firemního e-mailu |
| `{{konkretni_postreh}}` | jedna věta s doloženým nedostatkem (malým písmenem, bez tečky), např. *„web firma.cz nemá nastavené zobrazení pro mobilní telefony (chybí značka viewport), takže se na mobilu zobrazuje zmenšená počítačová verze“* | audit webu – jen zjištění s jistotou HIGH |

Tip: proměnné `{{url_webu}}` a `{{mesto}}` mají jen kontakty s webem / doloženým městem (v živém testu 56 % a
46 %). Pokud chcete oslovit i makléře bez webu, napište text tak, aby je nepotřeboval – `{{konkretni_postreh}}`
mají i oni (např. „v katalogu ARK ČR u vás není uvedený žádný web“).

Pokud šablona použije proměnnou, pro kterou chybí ověřený údaj (např. kancelář bez osoby nemá `{{prijmeni}}`),
koncept dostane stav **MISSING_DATA** a automaticky se **neodešle**. Patička je povinná a systém hlídá, že obsahuje
označení „obchodní sdělení“, identifikaci odesílatele a odkaz na odhlášení. **Náhled personalizace** ukáže přesný
výsledný e-mail pro libovolný kontakt; tlačítko „Poslat náhled mně“ ho pošle jen na váš `TEST_RECIPIENT`.

### 7. První provoz – výhradně v testovacím režimu

Výchozí nastavení: `TEST_MODE = TRUE`, `AUTO_SEND_ENABLED = FALSE`. Doporučený postup:

1. Nechte proběhnout první ranní sken (nebo **Nastavení automatizace → Spustit / pokračovat ve skenu**).
2. Zkontrolujte **Kontakty** a **Hodnocení webů**.
3. Zapněte `AUTO_SEND_ENABLED` při zapnutém `TEST_MODE` → v **Historii odesílání** uvidíte stav `TEST_NOT_SENT`
   u každé zprávy, která by šla ven. Nic se neodešle.
4. Teprve až budete mít v **Právní oprávnění** doložené souhlasy a vše sedí, vypněte `TEST_MODE`
   (vyžaduje potvrzení).

**Zastavení:** červené tlačítko **Zastavit vše** (v každé sekci administrace) nebo menu **Project Two →
NOUZOVÉ ZASTAVENÍ** – vypne hlavní vypínač i automatické odesílání a odstraní plánovač. Odesílání se kontroluje
před každou jednotlivou zprávou, takže STOP platí okamžitě i uprostřed běhu.

---

## Konfigurace prvního katalogu (ARK ČR)

Je předvyplněná v listu `SOURCES` a zapnutá:

| Pole | Hodnota |
|---|---|
| `source_id` | `ark` |
| `module` | `ark` |
| `base_url` | `https://www.arkcr.cz` |
| `enabled` | `TRUE` |
| `tos_status` | `NO_RESTRICTION_FOUND` (důkaz v `tos_evidence`) |
| `crawl_delay_ms` | `2000` (pauza mezi požadavky) |
| `max_pages` | `40` |

Modul čte `/clenove?page=N` (kanceláře: adresa, město, kraj, telefon, e-mail, web) a `/makleri?page=N` (makléři:
jméno, kancelář, telefon, e-mail), makléře propojí s kanceláří a jako URL původního profilu ukládá odkaz na kartu
makléře i stránku kanceláře.

### Přidání dalšího katalogu přes administraci

**Katalogy a zdroje → Přidat / upravit katalog**, modul `generic`, např.:

```json
{
  "listUrl": "https://www.priklad.cz/makleri?strana={page}",
  "startPage": 1,
  "maxPages": 10,
  "itemPattern": "<div class=\"makler\">[\\s\\S]*?</div>\\s*</div>",
  "fields": {
    "full_name": "<h3[^>]*>([\\s\\S]*?)</h3>",
    "office_name": "class=\"kancelar\">([\\s\\S]*?)<",
    "email": "mailto:([^\"?]+)",
    "phone": "tel:([^\"]+)",
    "website": "class=\"web\" href=\"([^\"]+)\"",
    "city": "class=\"mesto\">([\\s\\S]*?)<",
    "profile_url": "href=\"(/makler/[^\"]+)\""
  },
  "keyField": "profile_url"
}
```

Tlačítko **Uložit a otestovat 1. stránku** zobrazí, co parser najde (nic neukládá). Zdroj lze zapnout jen s
`tos_status` = `NO_RESTRICTION_FOUND` / `APPROVED` / `WRITTEN_PERMISSION` a vyplněným důkazem; robots.txt se
kontroluje automaticky.

---

## Testy

```bash
node test/run-tests.js
```

```bash
node test/admin-ui-test.js
```

```bash
node test/live-test.js ./live-output
```

- **`run-tests.js`** – 48 testů celého systému nad věrnou simulací Apps Script služeb (Sheets, Properties, Lock,
  Cache, UrlFetch, Gmail, triggery) a simulovaným internetem s řízeným časem.
- **`admin-ui-test.js`** – 12 testů administrace v Chromiu (Playwright) napojené na skutečnou serverovou logiku,
  desktop i mobil.
- **`live-test.js`** – plný denní běh proti **skutečným** webům (robots.txt, ARK, weby makléřů). Výstup obsahuje
  kontaktní údaje → ukládá se mimo repozitář.
- **V Apps Script**: Administrace → *Spustit testy systému* (nebo menu Project Two → Spustit testy systému).

### Výsledky testů (12. 11. 2026)

**Offline (`run-tests.js`): 48/48 ✓** · **UI v Chromiu (`admin-ui-test.js`): 12/12 ✓** · **Živý test: ✓**

| Požadovaný test | Jak ověřeno | Výsledek |
|---|---|---|
| Scraping všech dostupných zdrojů | živě: robots.txt všech 5 zdrojů + plný sken ARK (40 stránek) přes `tick()` | ARK povolen a zpracován (**918 unikátních kandidátů**); ČeskéReality a SuperHome zablokovány robots.txt, JenReality podmínkami, Srovnání čeká na kontrolu podmínek – nic z nich nebylo staženo |
| Kontrola duplicit | živě: druhý běh nad stejnými daty; offline: duplicitní záznam v katalogu, stejný makléř ve 2 katalozích | 2. běh: 100 známých rozpoznáno, 5 nových, **0 duplicit**; sloučení napříč katalogy ✓ |
| Správné ukládání kontaktů | unikátní ID `P2-000001…`, zdroj, URL profilu, datum, právní status | 100/100 ✓ |
| Hodnocení webů | živě 100 kontaktů (56 s webem/doménou): 46 ohodnoceno, 6 parkovaných/prázdných domén rozpoznáno, 4 weby zakázaly analýzu v robots.txt (respektováno); offline sada starý/moderní/JS/parkovaný web | ✓ – zjištění ověřena ručně na vzorku |
| Personalizace e-mailů | šablona s proměnnými; chybějící údaj → `MISSING_DATA` | ✓ (např. *„…na vaší doméně highstreet.cz je zatím jen parkovací stránka poskytovatele hostingu, ne váš vlastní web“*) |
| Právní blokace | kontakty bez souhlasu, s neúplným/neověřeným/odvolaným/propadlým souhlasem, jiný rozsah | živě 100/100 `NEEDS_LEGAL_REVIEW`, **0 e-mailů odesláno**; offline 9 variant vadného souhlasu zablokováno |
| Suppression list | adresa i doména, odhlášení odkazem (HMAC), odpověď „nemám zájem“, bounce, opětovný sběr | ✓ (suppression má přednost i před platným souhlasem) |
| Gmail kvóty | kvóta pod rezervou → pozastavení; denní limit; chyba odeslání | ✓ |
| Plánovač | trigger `tick` 10 min, Europe/Prague, sken až od 08:00, odesílání po skenu, ověření ID triggeru | ✓ |
| Restart po chybě | síťové výpadky, limit času exekuce 0,7 s (desítky checkpointů), výpadek zdroje (503), opakovaná chyba fáze, osiřelé odeslání (PENDING → UNCERTAIN) | ✓ bez ztrát a bez duplicit |
| STOP | tlačítko v UI, menu, zastavení během běhu | ✓ |

Živý běh trval **8,5 min** (2 exekuce po 4,5 min, ~310 HTTP požadavků se zdvořilou prodlevou) a nevznikla žádná chyba.
Město bylo doloženo u 46 ze 100 kontaktů (14 z katalogu, 32 ze sídla v ARES); u zbylých (převážně fyzické osoby
s freemailem) ho žádný povolený zdroj neuvádí – šablona s `{{mesto}}` je proto nechá v `MISSING_DATA`.

> **Co testy v tomto prostředí ověřit nemohly:** běh přímo ve vašem Google účtu (autorizace, skutečné triggery,
> odeslání přes Gmail). Kód běžel ve věrné simulaci služeb Apps Script; skutečné HTTP požadavky šly na živé weby.
> Po nasazení proto spusťte **Spustit testy systému** v administraci – ověří reálné napojení ve vašem účtu.

---

## Limity a omezení (bezplatný účet Gmail)

| Limit Google (účet @gmail.com) | Hodnota | Dopad |
|---|---|---|
| Příjemci e-mailů za den | **100** (Workspace: 1 500) | `DAILY_SEND_LIMIT` výchozí 20; systém hlídá `MailApp.getRemainingDailyQuota()` s rezervou a při vyčerpání se pozastaví do dalšího dne |
| Celková doba běhu triggerů | 90 min / den | Denní běh trvá dle živého testu cca 9 min; nečinné ticky ~1–2 s |
| Jedna exekuce | 6 min | Pipeline pracuje po 4,5 min a pokračuje z checkpointu |
| UrlFetch volání | 20 000 / den | Denní běh potřebuje řádově stovky |
| Přesnost spuštění | ± 10 min | Trigger běží každých 10 min, sken startuje v prvním ticku po `SCAN_TIME` (08:00–08:10) |

- **Měření rychlosti** probíhá ze serverů Google (jedno měření) – proto je zjištění „pomalý web“ označeno jako
  orientační a do e-mailu se nedostane. Přesné mobilní měření: zadejte zdarma klíč **PageSpeed Insights API**
  (`PAGESPEED_API_KEY`) – pak se použije skóre Google Lighthouse.
- **Design** nelze bez vykreslení stránky hodnotit vizuálně; systém hodnotí doložitelné signály (zastaralé
  technologie, rozvržení tabulkami, rok v copyrightu, chybějící mobilní zobrazení, HTTPS, struktura).
- **Počet 100/den** je omezen dostupnými zdroji: legálně lze dnes automaticky zpracovat jen ARK ČR
  (viz `docs/SOURCES_AUDIT.md`). Po jeho vyčerpání systém zpracuje jen nové makléře a zapíše důvod.
- **`{{jmeno}}`/`{{prijmeni}}` jsou v 1. pádě** – český 5. pád systém negeneruje (riziko chybného oslovení).
  Doporučujeme neutrální „Dobrý den,“ a jméno použít ve větě v 1. pádě (např. „… pro kancelář {{realitni_kancelar}}“).
