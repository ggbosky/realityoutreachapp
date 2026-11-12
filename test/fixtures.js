/**
 * Simulovaný internet pro deterministické testy. Struktura HTML kopíruje skutečné stránky
 * ARK ČR a Srovnání makléřů (ověřeno 2026-11-12), data jsou smyšlená.
 */
'use strict';

function arkBroker(id, name, office, phone, email) {
  const off = office.link
    ? `<a href="https://www.arkcr.cz/realitni-kancelar/${office.link}" class="text-[#0065B9] hover:underline">${office.name}</a>`
    : office.name;
  return `<li id="broker-${id}" class="p-5 bg-white shadow-sm">
    <div class="h-full flex flex-col">
      <div class="text-base font-semibold text-gray-900">
        ${name}
      </div>
      <div class="grow mt-3 flex flex-col gap-y-1 text-xs text-gray-500">
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-flex w-4 shrink-0 justify-center text-gray-400"><i class="fa-solid fa-building"></i></span>
          <span>
            ${off}
          </span>
        </span>
        ${phone ? `<span class="inline-flex items-center gap-1.5"><a href="tel:${phone}" class="text-[#0065B9] hover:underline">${phone}</a></span>` : ''}
        ${email ? `<span class="inline-flex items-center gap-1.5"><i class="fa-solid fa-envelope"></i><a href="mailto:${email}" class="text-[#0065B9] hover:underline">${email}</a></span>` : ''}
      </div>
    </div>
  </li>`;
}

function arkOffice(id, slug, name, addr, psc, city, region, phone, email, web) {
  return `<li id="office-${id}" class="p-5 bg-white shadow-sm">
 <div class="h-full flex flex-col">
 <div class="text-base font-semibold text-gray-900">
 ${name}
 </div>
 <div class="mt-1 text-sm text-gray-600">
 ${addr},
 ${psc} ${city}
 <br />${region}
 </div>
 <div class="grow mt-1 flex flex-row gap-x-4">
 <div class="mt-1 flex flex-col gap-y-1 text-xs text-gray-500 grow">
 ${phone ? `<span><i class="fa-solid fa-phone text-gray-400"></i><a href="tel:${phone}" class="text-[#0065B9] hover:underline">${phone}</a></span>` : ''}
 ${email ? `<span><i class="fa-solid fa-envelope text-gray-400"></i><a href="mailto:${email}" class="text-[#0065B9] hover:underline">${email}</a></span>` : ''}
 ${web ? `<span><i class="fa-solid fa-globe text-gray-400"></i><a href="${web}" class="text-[#0065B9] hover:underline" target="_blank" rel="noopener">${web.replace(/^https?:\/\//, '')}</a></span>` : ''}
 </div>
 <div class="self-end whitespace-nowrap"><a
 href="https://www.arkcr.cz/realitni-kancelar/${id}-${slug}"
 class="inline-flex">Více info</a></div>
 </div>
 </div>
 </li>`;
}

function page(items, pagesLinks) {
  return `<!doctype html><html><body><main><ul class="grid">${items.join('\n')}</ul>
  <nav>${pagesLinks.map((p) => `<a href="https://www.arkcr.cz/PATH?page=${p}#filters">${p}</a>`).join(' ')}</nav></main></body></html>`;
}

const OFFICES_P1 = [
  arkOffice(1, 'jan-svoboda', 'Jan Svoboda', 'Hlavní 1', '736 01', 'Havířov', 'Moravskoslezský', '777111222', 'jan@svoboda-reality.cz', 'https://www.svoboda-reality.cz'),
  arkOffice(2, 'mala-reality', 'Malá Reality s.r.o.', 'Krátká 5', '602 00', 'Brno', 'Jihomoravský', '777222333', 'info@mala-reality.cz', 'https://mala-reality.cz'),
  arkOffice(3, 'big-corp', 'Big Corp Reality a.s.', 'Dlouhá 9', '110 00', 'Praha 1', 'Praha', '', 'info@bigcorp.cz', 'https://bigcorp.cz'),
  arkOffice(5, 'novak-reality', 'Novák reality', 'Polní 3', '370 01', 'České Budějovice', 'Jihočeský', '', 'novak@seznam.cz', ''),
];
const OFFICES_P2 = [
  arkOffice(6, 'office-only', 'Office Only s.r.o.', 'Nová 2', '301 00', 'Plzeň', 'Plzeňský', '', 'info@officeonly.cz', ''),
  arkOffice(7, 'robots-blocked', 'Robots Blocked s.r.o.', 'Tichá 4', '460 01', 'Liberec', 'Liberecký', '', 'a@noaudit.cz', 'https://noaudit.cz'),
  arkOffice(8, 'webnode-only', 'Petr Webnode', 'Malá 1', '500 02', 'Hradec Králové', 'Královéhradecký', '', 'petr@seznam.cz', 'https://petrreality.webnode.cz'),
];
const BROKERS_P1 = [
  arkBroker(101, 'Jan Svoboda', { link: '1-jan-svoboda', name: 'Jan Svoboda' }, '+420 777 111 222', 'jan@svoboda-reality.cz'),
  arkBroker(102, 'Petra Malá', { link: '2-mala-reality', name: 'Malá Reality s.r.o.' }, '', 'petra@mala-reality.cz'),
  arkBroker(103, 'Karel Malý', { link: '2-mala-reality', name: 'Malá Reality s.r.o.' }, '', 'info@mala-reality.cz'),
  arkBroker(104, 'Eva Malá', { link: '2-mala-reality', name: 'Malá Reality s.r.o.' }, '', 'info@mala-reality.cz'),
  arkBroker(105, 'Tomáš Velký', { link: '3-big-corp', name: 'Big Corp Reality a.s.' }, '', 'tomas@bigcorp.cz'),
  arkBroker(106, 'Robert Franšíza', { name: 'RE/MAX Test' }, '', 'robert@remax-czech.cz'),
  arkBroker(107, 'Ing. Pavel Novák', { link: '5-novak-reality', name: 'Novák reality' }, '+420 600 100 200', 'novak@seznam.cz'),
];
const BROKERS_P2 = [
  arkBroker(108, 'Jan Svoboda', { link: '1-jan-svoboda', name: 'Jan Svoboda' }, '+420 777 111 222', 'jan@svoboda-reality.cz'), // duplicita v katalogu
  arkBroker(109, 'Lenka Bezmailová', { name: 'Neznámá RK' }, '', ''),
  arkBroker(110, 'Ondřej Tichý', { link: '7-robots-blocked', name: 'Robots Blocked s.r.o.' }, '', 'a@noaudit.cz'),
  arkBroker(111, 'Petr Webnode', { link: '8-webnode-only', name: 'Petr Webnode' }, '', 'petr@seznam.cz'),
];

const SROVNANI_LIST = `<html><body><table>
<tr>
  <td><a class="round-image " style="" href="/realitni-makler-pavel-novak/" title="x"></a></td>
  <td><a href="/realitni-makler-pavel-novak/" title="Realitní makléř Pavel Novák"> Ing. Pavel Novák</a></td>
  <td>Novák reality s.r.o.</td>
  <td>12 let</td>
</tr>
<tr>
  <td><a class="round-image " style="" href="/realitni-makler-nova-osoba/" title="x"></a></td>
  <td><a href="/realitni-makler-nova-osoba/" title="Realitní makléř Nová Osoba"> Nová Osoba</a></td>
  <td>Osobní Reality</td>
  <td>3 roky</td>
</tr>
</table><div class="pagination"><a class="active" href="/realitni-makleri/#">1 </a></div></body></html>`;
const SROVNANI_PROFILE = `<ul class="nmv-meta"><li><span class="nmv-label">Realitní kancelář</span><span class="nmv-value">Osobní Reality</span></li>
<li><span class="nmv-label">Lokalita</span><span class="nmv-value"><a href="/x/">Olomouc</a>, <a href="/y/">Olomoucký kraj</a></span></li></ul>`;

const OLD_SITE = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>Svoboda reality</title><script src="/js/jquery-1.4.2.min.js"></script></head>
<body><table width="900" bgcolor="#fff"><tr><td width="200" bgcolor="#eee"><font size="2">Menu</font></td>
<td width="700"><font face="Arial">Nabídka nemovitostí – prodej bytů a domů</font><font>Reference</font>
<table cellpadding="3"><tr><td width="100"><img src="a.jpg"></td><td width="100"><img src="b.jpg"></td></tr></table>
<table cellpadding="2"><tr><td width="50">x</td></tr></table></td></tr></table>
<div class="paticka">Copyright © 2016 Jan Svoboda</div></body></html>`;

const MODERN_SITE = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Malá Reality – realitní kancelář Brno</title><meta name="description" content="Prodej a pronájem nemovitostí v Brně.">
<meta property="og:title" content="Malá Reality"></head><body><header><nav class="menu"><a href="/nabidka">Nabídka</a></nav></header>
<main><h1>Prodáme vaši nemovitost</h1><p>Aktuální nabídka nemovitostí: byty, rodinné domy, pozemky. Prodej i pronájem. Reference klientů.</p>
<img src="1.jpg" alt="Byt"><img src="2.jpg" alt="Dům"><img src="3.jpg" alt="Pozemek"><a href="tel:+420777222333">Zavolejte</a></main>
<footer>© 2018–2026 Malá Reality</footer></body></html>`;

const OFFICEONLY_SITE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Office Only</title></head>
<body><h1>Office Only</h1><p>Jsme realitní kancelář. Nabídka nemovitostí brzy.</p><footer>© 2019 Office Only s.r.o.</footer></body></html>`;

const WEBNODE_SITE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Petr reality</title>
<meta name="description" content="Reality Petr"><meta property="og:title" content="x"></head><body><nav class="menu"></nav><h1>Petr reality</h1>
<p>nabídka nemovitostí prodej byty domy pozemky reference</p><img alt="a"><img alt="b"><img alt="c"><a href="tel:1">t</a><footer>© 2026</footer></body></html>`;

/** Router simulovaného internetu. state umožní měnit chování během testu. */
function makeRouter(state = {}) {
  const html = (body, code = 200, ms = 120) => ({ code, body, ms, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const text = (body, code = 200) => ({ code, body, ms: 30, headers: { 'Content-Type': 'text/plain' } });
  return function route(url) {
    state.hits = state.hits || {};
    state.hits[url] = (state.hits[url] || 0) + 1;
    const u = url.replace(/#.*$/, '');
    // robots
    if (u === 'https://www.arkcr.cz/robots.txt') return text('User-agent: *\nDisallow:\n');
    if (u === 'https://www.srovnani-makleru.cz/robots.txt') return text('User-Agent: *\nAllow: /\nDisallow: *do=ajaxDialog\n');
    if (u === 'https://www.ceskereality.cz/robots.txt') return text('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /bot-trap/\n');
    if (u === 'https://superhome.cz/robots.txt') return text('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n');
    if (u === 'https://www.jenreality.cz/robots.txt') return text('User-agent: *\nDisallow: /data/\n');
    if (u === 'https://noaudit.cz/robots.txt') return text('User-agent: *\nDisallow: /\n');
    if (/^https:\/\/(www\.)?svoboda-reality\.cz\//.test(u)) return new Error('Exception: SSL handshake failed');
    if (/^https?:\/\/[^/]+\/robots\.txt$/.test(u)) return text('', 404);
    // ARK
    if (state.arkDown && /arkcr\.cz\/(clenove|makleri)/.test(u)) return html('Service Unavailable', 503);
    if (u === 'https://www.arkcr.cz/clenove') return html(page(OFFICES_P1, [1, 2]).replace(/PATH/g, 'clenove'));
    if (u === 'https://www.arkcr.cz/clenove?page=2') return html(page(OFFICES_P2, [1, 2]).replace(/PATH/g, 'clenove'));
    if (u === 'https://www.arkcr.cz/makleri') return html(page(BROKERS_P1.concat(state.extraBrokers || []), [1, 2]).replace(/PATH/g, 'makleri'));
    if (u === 'https://www.arkcr.cz/makleri?page=2') return html(page(BROKERS_P2, [1, 2]).replace(/PATH/g, 'makleri'));
    // Srovnání
    if (u === 'https://www.srovnani-makleru.cz/realitni-makleri/') return html(SROVNANI_LIST);
    if (u === 'https://www.srovnani-makleru.cz/realitni-makler-nova-osoba/') return html(SROVNANI_PROFILE);
    if (u === 'https://www.srovnani-makleru.cz/realitni-makler-pavel-novak/') return html(SROVNANI_PROFILE);
    // weby makléřů
    if (u === 'http://www.svoboda-reality.cz/' || u === 'http://svoboda-reality.cz/') return html(OLD_SITE, 200, 4200);
    if (u === 'https://mala-reality.cz/') return html(MODERN_SITE, 200, 300);
    if (u === 'https://bigcorp.cz/') return html('Internal error', 500);
    if (u === 'https://officeonly.cz/') return { code: 301, headers: { Location: 'https://www.officeonly.cz/' }, body: '' };
    if (u === 'https://www.officeonly.cz/') return html(OFFICEONLY_SITE);
    if (u === 'https://petrreality.webnode.cz/') return html(WEBNODE_SITE);
    if (u === 'https://seznam.cz/') return html('freemail – should never be fetched', 200);
    return undefined; // neexistující host → DNS error
  };
}

module.exports = { makeRouter, OLD_SITE, MODERN_SITE };
