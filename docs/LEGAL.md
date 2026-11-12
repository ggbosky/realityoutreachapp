# Právní rámec odesílání

> Toto je technický popis toho, jak systém pravidla vynucuje. Nejde o právní poradenství. Před ostrým provozem
> doporučuji nechat nastavení (zejména text souhlasu a informace podle GDPR) zkontrolovat právníkem.

## Zákon č. 480/2004 Sb. (o některých službách informační společnosti)

- **§ 7 odst. 2** – obchodní sdělení e-mailem lze šířit jen adresátovi, který k tomu dal **předchozí souhlas**.
  Česká úprava nerozlišuje fyzické a právnické osoby: platí i pro firemní e-maily (info@…).
- **§ 7 odst. 3** – výjimka pro **vlastní zákazníky** (kontakt získaný v souvislosti s prodejem výrobku/služby),
  a to jen pro obdobné vlastní produkty a pokud měl zákazník možnost to odmítnout.
- **§ 7 odst. 4** – každé sdělení musí být **zřetelně označeno jako obchodní sdělení**, nesmí skrývat
  **totožnost odesílatele** a musí obsahovat **platnou adresu pro odmítnutí** dalších sdělení.

**Veřejně uvedený e-mail v katalogu proto NENÍ souhlas.** Kontakty z katalogů mají vždy stav `NEEDS_LEGAL_REVIEW`.

## Jak to systém vynucuje

| Pravidlo | Kde v kódu |
|---|---|
| Bez platného záznamu v `LEGAL_CONSENTS` se nic neodešle (výchozí stav `NEEDS_LEGAL_REVIEW`, koncept jen interně) | `21_Legal.gs → evaluateLegal_` |
| Záznam musí mít: právní důvod `CONSENT` nebo `EXISTING_CUSTOMER`, rozsah = `EMAIL_LEGAL_SCOPE` (nebo `ALL`), zdroj, důkaz, datum získání, `verified = TRUE`, nesmí být odvolán ani propadlý, a musí patřit stejné adrese (příp. ID kontaktu) | `consentProblems_` |
| Právní brána se vyhodnocuje **znovu těsně před každým odesláním** | `22_Mailer.gs` |
| SUPPRESSION má přednost před souhlasem; přidání do SUPPRESSION automaticky odvolá souhlasy dané adresy; lze blokovat i celou doménu (`@domena.cz`) | `addSuppression_` |
| Patička musí obsahovat `{{identifikace_odesilatele}}` a `{{odhlaseni_url}}`; zpráva musí obsahovat text „obchodní sdělení“; bez `SENDER_IDENTIFICATION` a `WEBAPP_URL` se nic neodešle | `03_Settings.gs`, `20_Templates.gs`, `sendPreconditions_` |
| Odhlášení: odkaz s HMAC tokenem (nelze odhlásit cizí adresu) + odpověď se slovy „odhlásit / nemám zájem / unsubscribe…“ + nedoručitelnost → SUPPRESSION | `41_WebApp.gs`, `23_Inbox.gs` |
| Jedna adresa × jeden právní rozsah = max. `MAX_EMAILS_PER_CONTACT` sdělení (výchozí 1), i když adresu sdílí více makléřů | `22_Mailer.gs` |
| Evidence: kdo a kdy souhlas zapsal (`recorded_by`, `recorded_at`), znění, zdroj, důkaz; každé odeslání má v `EMAIL_LOG` odkaz na `consent_id` | `apiAddConsent_`, `EMAIL_LOG.legal_ref` |

## Jak zaznamenat oprávnění

Administrace → **Právní oprávnění** → *Zaznamenat právní důvod*:

- **E-mail** – přesně adresa, které dal makléř souhlas,
- **Právní důvod** – `CONSENT` (souhlas) nebo `EXISTING_CUSTOMER` (váš zákazník),
- **Rozsah** – musí odpovídat `EMAIL_LEGAL_SCOPE` (výchozí `project_two_web_services`),
- **Zdroj** – např. „webový formulář project-two.cz/audit“, „e-mail ze dne…“, „podepsaná objednávka“,
- **Důkaz** – odkaz na uložený dokument / ID záznamu ve formuláři / odkaz na e-mail v Gmailu,
- **Datum získání**, volitelně **platnost do**,
- zaškrtnutí *Ověřil(a) jsem…* – bez něj záznam není platný.

## GDPR – doporučení (mimo automatiku)

- Ukládáte osobní údaje fyzických osob (jméno, pracovní e-mail, telefon) z veřejných zdrojů. Jako právní titul se
  obvykle uvádí **oprávněný zájem** (čl. 6 odst. 1 písm. f) – sepište si krátký test vyvážení (LIA).
- Při prvním kontaktu splňte **informační povinnost dle čl. 14** (odkaz na zásady zpracování v patičce e-mailu).
- Stanovte **dobu uchování** (např. 12 měsíců u nekontaktovaných kontaktů) a kontakty pak smažte z listu `CONTACTS`.
- Na žádost o výmaz: přidejte adresu do SUPPRESSION (zabrání opětovnému sběru a oslovení) a smažte řádek z `CONTACTS`.
