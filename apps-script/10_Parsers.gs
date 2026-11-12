/**
 * Parsery jednotlivých katalogů – čisté funkce (HTML -> data), testovatelné bez Google služeb.
 * Nic nedoplňují odhadem: chybějící údaj = prázdný řetězec.
 */

function maxPageNumber_(html, param) {
  const re = new RegExp('[?&]' + param + '=(\\d+)', 'g');
  let m, max = 1;
  while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

function firstMatch_(s, re) {
  const m = String(s || '').match(re);
  return m ? m[1] : '';
}

/* ------------------------------ ARK ČR ------------------------------ */

/** /makleri?page=N – karty makléřů <li id="broker-ID">. */
function parseArkBrokers_(html, pageUrl) {
  const items = [];
  const re = /<li id="broker-(\d+)"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const name = oneLine_(htmlToText_(firstMatch_(block, /<div class="text-base font-semibold[^"]*">([\s\S]*?)<\/div>/)));
    const officeLink = block.match(/href="(https?:\/\/www\.arkcr\.cz\/realitni-kancelar\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    let officeName = '', officeUrl = '', officeId = '';
    if (officeLink) {
      officeUrl = officeLink[1]; officeId = officeLink[2]; officeName = oneLine_(htmlToText_(officeLink[3]));
    } else {
      const bld = block.match(/fa-building[\s\S]*?<\/span>\s*<span>([\s\S]*?)<\/span>/);
      if (bld) officeName = oneLine_(htmlToText_(bld[1]));
    }
    const email = normEmail_(firstMatch_(block, /href="mailto:([^"]+)"/));
    const phone = oneLine_(firstMatch_(block, /href="tel:([^"]+)"/));
    if (!name) continue;
    items.push({
      source_key: 'ark:broker:' + m[1],
      contact_type: 'BROKER',
      full_name: name,
      office_name: officeName,
      office_key: officeId ? 'ark:office:' + officeId : '',
      office_url: officeUrl,
      email: email,
      phone: phone,
      website: '',
      city: '', region: '',
      profile_url: (pageUrl || 'https://www.arkcr.cz/makleri').replace(/#.*$/, '') + '#broker-' + m[1],
    });
  }
  return { items: items, maxPage: maxPageNumber_(html, 'page') };
}

/** /clenove?page=N – karty kanceláří <li id="office-ID">. */
function parseArkOffices_(html) {
  const items = [];
  const re = /<li id="office-(\d+)"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const name = oneLine_(htmlToText_(firstMatch_(block, /<div class="text-base font-semibold[^"]*">([\s\S]*?)<\/div>/)));
    const addrHtml = firstMatch_(block, /<div class="mt-1 text-sm text-gray-600">([\s\S]*?)<\/div>/);
    const addrParts = addrHtml.split(/<br\s*\/?>/i).map(function (p) { return oneLine_(htmlToText_(p)); });
    const addressLine = addrParts[0] || '';
    const region = addrParts[1] || '';
    const city = oneLine_(firstMatch_(addressLine, /\d{3}\s?\d{2}\s+(.+)$/));
    const webHref = firstMatch_(block, /fa-globe[\s\S]*?href="([^"]+)"/);
    const profileUrl = firstMatch_(block, /href="(https?:\/\/www\.arkcr\.cz\/realitni-kancelar\/[^"]+)"/);
    items.push({
      source_key: 'ark:office:' + m[1],
      office_id: m[1],
      contact_type: 'OFFICE',
      office_name: name,
      full_name: '',
      address: addressLine,
      city: city,
      region: region,
      email: normEmail_(firstMatch_(block, /href="mailto:([^"]+)"/)),
      phone: oneLine_(firstMatch_(block, /href="tel:([^"]+)"/)),
      website: normUrl_(webHref),
      profile_url: profileUrl || '',
    });
  }
  return { items: items, maxPage: maxPageNumber_(html, 'page') };
}

/* ------------------------- Srovnání makléřů ------------------------- */

/** /realitni-makleri/?paginator-page=N – tabulka: foto | jméno (odkaz) | kancelář | praxe. */
function parseSrovnaniList_(html, pageUrl) {
  const items = [];
  const re = /<tr>\s*<td><a class="round-image[\s\S]*?<\/tr>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tds = m[0].match(/<td>([\s\S]*?)<\/td>/g) || [];
    if (tds.length < 3) continue;
    const link = tds[1].match(/href="(\/realitni-makler-[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const profileUrl = absoluteUrl_(pageUrl || 'https://www.srovnani-makleru.cz/', link[1]);
    items.push({
      source_key: 'srovnani:' + link[1].replace(/\//g, ''),
      contact_type: 'BROKER',
      full_name: oneLine_(htmlToText_(link[2])),
      office_name: oneLine_(htmlToText_(tds[2].replace(/^<td>|<\/td>$/g, ''))),
      email: '', phone: '', website: '', city: '', region: '',
      profile_url: profileUrl,
    });
  }
  return { items: items, maxPage: maxPageNumber_(html, 'paginator-page') };
}

/** Profil makléře – lokalita (první uvedená). Nevrací kontakty, protože je web nezveřejňuje. */
function parseSrovnaniProfile_(html) {
  const loc = html.match(/<span class="nmv-label">Lokalita<\/span><span class="nmv-value">([\s\S]*?)<\/span><\/li>/);
  const locs = loc ? htmlToText_(loc[1]).split(',').map(oneLine_).filter(Boolean) : [];
  const city = locs.filter(function (l) { return !/kraj/i.test(l); })[0] || '';
  return { city: city, locations: locs };
}

/* ---------------------------- JenReality ---------------------------- */
/* Pozor: podmínky JenReality zakazují systematické stahování bez písemného souhlasu.
   Parser je připraven pro případ udělení souhlasu – bez něj ho systém nespustí. */

function parseJenRealityDirectory_(html) {
  const seen = {};
  const items = [];
  const re = /href="(\/adresar-realitnich-kancelari\/([a-z0-9\-]+-(\d+)))\/?"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen[m[3]]) continue;
    const name = oneLine_(htmlToText_(m[4]));
    if (!name) continue;
    seen[m[3]] = true;
    items.push({ source_key: 'jenreality:office:' + m[3], office_name: name, profile_url: 'https://www.jenreality.cz' + m[1] + '/' });
  }
  return { items: items, maxPage: 1 };
}

/** Obecná extrakce kontaktů z detailu kanceláře/makléře. */
function parseGenericContactPage_(html, pageUrl) {
  const ownHost = urlHost_(pageUrl);
  const emails = uniq_((html.match(/mailto:([^"'?>\s]+)/gi) || []).map(function (x) { return normEmail_(x); }));
  const phones = uniq_((html.match(/href="tel:([^"]+)"/gi) || []).map(function (x) { return oneLine_(x.replace(/^href="tel:|"$/g, '')); }));
  const webs = uniq_((html.match(/href="(https?:\/\/[^"]+)"[^>]*target="_blank"/gi) || [])
    .map(function (x) { return normUrl_(x.replace(/^href="|"[\s\S]*$/g, '')); })
    .filter(function (u) {
      const h = urlHost_(u);
      return h && h !== ownHost && !/facebook|instagram|linkedin|youtube|twitter|x\.com|google|seznam\.cz$|mapy\.cz|apple\.com/i.test(h);
    }));
  const h1 = oneLine_(htmlToText_(firstMatch_(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)));
  return { name: h1, emails: emails, phones: phones, websites: webs };
}

/* ------------------------ Obecný (admin) katalog ------------------------ */
/**
 * Konfigurace (SOURCES.config_json):
 * {
 *   "listUrl": "https://example.cz/makleri?page={page}",
 *   "startPage": 1, "maxPages": 10,
 *   "itemPattern": "<div class=\"broker\">[\\s\\S]*?</div>\\s*</div>",
 *   "fields": { "full_name": "<h3>(.*?)</h3>", "email": "mailto:([^\"]+)", "phone": "tel:([^\"]+)",
 *               "website": "class=\"web\" href=\"([^\"]+)\"", "office_name": "...", "city": "...",
 *               "profile_url": "href=\"(/makler/[^\"]+)\"" },
 *   "keyField": "profile_url"
 * }
 */
function parseGeneric_(html, config, pageUrl) {
  if (!config || !config.itemPattern) throw new Error('Chybí itemPattern v config_json');
  const itemRe = new RegExp(config.itemPattern, 'g');
  const fields = config.fields || {};
  const items = [];
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    if (m[0].length === 0) { itemRe.lastIndex++; continue; }
    const block = m[0];
    const rec = { contact_type: 'BROKER', full_name: '', office_name: '', email: '', phone: '', website: '', city: '', region: '', profile_url: '' };
    Object.keys(fields).forEach(function (f) {
      const fm = block.match(new RegExp(fields[f], 'i'));
      if (fm) rec[f] = oneLine_(htmlToText_(fm[1] !== undefined ? fm[1] : fm[0]));
    });
    rec.email = normEmail_(rec.email);
    rec.website = normUrl_(rec.website);
    if (rec.profile_url) rec.profile_url = absoluteUrl_(pageUrl, rec.profile_url);
    if (!rec.full_name && rec.office_name) rec.contact_type = 'OFFICE';
    const keyVal = rec[config.keyField || 'profile_url'] || rec.email || (rec.full_name + '|' + rec.office_name);
    if (!rec.full_name && !rec.office_name) continue;
    rec.source_key = 'generic:' + normText_(keyVal).substring(0, 120);
    items.push(rec);
  }
  return { items: items, maxPage: config.maxPages || 1 };
}
