# Audit zdrojů kontaktů

Ověřeno **12. 11. 2026** z prostředí s identifikovaným User-Agentem `ProjectTwoBot/1.0`. Systém navíc při **každém**
denním běhu kontroluje robots.txt znovu (živě) a změnu zapíše do listu `SOURCES` a do `ERROR_LOG`.

| Zdroj | robots.txt pro obecné boty | Podmínky užívání | Dostupná data | Stav v systému |
|---|---|---|---|---|
| **arkcr.cz** (ARK ČR) | `User-agent: *` / `Disallow:` → **vše povoleno** | Web nepublikuje podmínky omezující automatizovaný přístup (zkontrolováno: patička, `/ochrana-soukromi`, `/kontakty`) | `/makleri` – ~700 makléřů (24 stran × 30): jméno, kancelář, telefon, e-mail. `/clenove` – ~470 kanceláří (16 stran × 30): název, adresa, kraj, telefon, e-mail, **web** | **POUŽÍVÁ SE** (`tos_status = NO_RESTRICTION_FOUND`) |
| **srovnani-makleru.cz** | `Allow: /`, zakázáno jen `*do=ajaxDialog`, `*search=` | Obchodní podmínky se otevírají jen přes URL s `do=ajaxDialog`, které robots.txt zakazuje → bot je **nečetl** | `/realitni-makleri/?paginator-page=N` (~7 stran): jméno, kancelář, praxe; profil: lokalita. **Nezveřejňuje e-mail, telefon ani web** (služba makléře zprostředkovává) | **VYPNUTO – čeká na vaši ruční kontrolu podmínek** (`NEEDS_REVIEW`). Po přečtení podmínek nastavte `APPROVED` + důkaz. Slouží hlavně ke sloučení profilů a doplnění lokality. |
| **jenreality.cz** | Seznam kanceláří povolen | **Zakázáno.** Smluvní obchodní podmínky, čl. 4.5: *„Bez předchozího písemného souhlasu provozovatele nesmíte zejména vytvářet databázi v elektronické nebo strukturované manuální podobě systematickým stahováním a ukládáním celého Obsahu nebo jeho libovolné části.“* | `/adresar-realitnich-kancelari/` – ~1000 kanceláří (odkazy na detail) | **BLOKOVÁNO PODMÍNKAMI.** Modul je hotový; zapnout lze jen s písemným souhlasem provozovatele (`tos_status = WRITTEN_PERMISSION` + odkaz na souhlas). |
| **ceskereality.cz** | `User-agent: *` / `Disallow: /` (povoleno jen vyjmenovaným vyhledávačům; navíc „bot-trap“ URL) | nehodnoceno – přístup zakázán už robots.txt | – | **BLOKOVÁNO robots.txt** – modul jen denně hlídá robots.txt |
| **superhome.cz** | `User-agent: *` / `Disallow: /` (povoleno jen vyjmenovaným vyhledávačům) | nehodnoceno | – | **BLOKOVÁNO robots.txt** – modul jen denně hlídá robots.txt |

## Co to znamená pro cíl „100 nových makléřů denně“

Jediný zdroj, který lze dnes legálně a technicky automaticky zpracovat, je ARK ČR. Živý test ukázal, kolik unikátních
kontaktů po sloučení obsahuje (viz výsledek v README → *Výsledky testů*). Při 100 kontaktech denně se ARK vyčerpá
přibližně za týden. Poté systém každý den zpracuje jen nově přidané makléře a do `CAMPAIGNS.shortfall_reason`
zapíše přesný důvod nižšího počtu. **Nic se nedoplňuje odhadem.**

## Bezplatné alternativy (legální)

1. **Písemný souhlas provozovatelů** JenReality a České reality (CESKY INTERNET s.r.o.) – nejrychlejší cesta k dalším
   tisícům kontaktů. Po získání souhlasu jen zapnete zdroj a doplníte důkaz.
2. **Srovnání makléřů** – přečtěte obchodní podmínky (odkaz v patičce webu). Pokud automatické čtení veřejného seznamu
   nezakazují, nastavte `APPROVED`. Zdroj ale e-maily neposkytuje.
3. **Vlastní katalogy přes administraci** (modul `generic`) – např. regionální asociace nebo seznamy, jejichž
   provozovatel automatizované čtení povoluje. Konfigurace regulárními výrazy, tlačítko „Test 1. stránky“.
4. **Inbound souhlasy** – formulář na vašem webu („pošlete mi audit webu zdarma“). Takové kontakty mají rovnou
   doložený souhlas a systém jim může e-mail odeslat automaticky.

## Co systém nikdy nedělá

- neobchází CAPTCHA, přihlášení, rate-limit ani jiné ochrany (HTTP 401/403/429 = zdroj „nedostupný“ pro daný den),
- nemaskuje se za prohlížeč – vždy se identifikuje jako `ProjectTwoBot/1.0`,
- nečte URL zakázané v robots.txt (kontrola u každého požadavku i přesměrování; RFC 9309),
- nevymýšlí e-maily ani jiné údaje. Web se odvozuje jen z katalogu, nebo z firemní domény e-mailu, a to
  **jen pokud na ní web skutečně odpoví**. Freemaily (seznam.cz, gmail.com…) a domény franšíz se nepoužívají.
