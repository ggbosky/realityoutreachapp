/**
 * Deduplikace, slučování profilů z více katalogů a předběžná prioritizace.
 *
 * Pravidlo identity: stejná osoba = stejný klíč zdroje NEBO (stejné normalizované jméno
 * A zároveň stejný e-mail / telefon / kancelář). Samotný e-mail osobu neidentifikuje
 * (kanceláře často sdílí info@…), ale e-mailová adresa nikdy nedostane obchodní sdělení dvakrát.
 */

function normPersonName_(full) {
  return normText_(splitPersonName_(full).clean || full);
}

function mergeKeysFor_(rec) {
  const keys = [];
  (rec.source_keys || [rec.source_key]).forEach(function (k) { if (k) keys.push('src:' + k); });
  const email = normEmail_(rec.email);
  const phone = normPhone_(rec.phone);
  const office = normCompany_(rec.office_name);
  if (rec.contact_type === 'OFFICE' || !rec.full_name) {
    if (office && email) keys.push('off:' + office + '|' + email);
    if (office && rec.website) keys.push('offw:' + office + '|' + urlHost_(rec.website));
    if (office && phone) keys.push('offp:' + office + '|' + phone);
    return uniq_(keys);
  }
  const name = normPersonName_(rec.full_name);
  if (name) {
    if (email) keys.push('ne:' + name + '|' + email);
    if (phone) keys.push('np:' + name + '|' + phone);
    if (office) keys.push('no:' + name + '|' + office);
  }
  return uniq_(keys);
}

/**
 * Složí kandidáty z poolu: připojí data kanceláří k makléřům, sloučí duplicity mezi zdroji.
 * @param {Array} poolItems záznamy z _POOL (již rozparsované payloady)
 * @return {Array} kandidáti (sloučení)
 */
function buildCandidates_(poolItems) {
  const offices = {};          // office_key -> office
  const officesByName = {};    // normCompany -> [office]
  const people = [];
  poolItems.forEach(function (it) {
    if (it.contact_type === 'OFFICE' && /^ark:office:/.test(it.source_key)) {
      offices[it.source_key] = it;
      const n = normCompany_(it.office_name);
      (officesByName[n] = officesByName[n] || []).push(it);
    } else {
      people.push(it);
    }
  });

  // Velikost kanceláře = počet makléřů v katalogu.
  const officeCount = {};
  const officeSeen = {};
  people.forEach(function (p) {
    const k = p.office_key || ('n:' + normCompany_(p.office_name));
    const pk = k + '|' + normPersonName_(p.full_name);
    if (p.contact_type === 'BROKER' && !officeSeen[pk]) { officeSeen[pk] = true; officeCount[k] = (officeCount[k] || 0) + 1; }
  });
  const usedOffices = {};

  // Indexy kanceláří pro doložitelné párování (jen jednoznačné shody).
  const offByEmail = {}, offByDomain = {}, offByPhone = {};
  const addIdx = function (idx, k, o) { if (k) (idx[k] = idx[k] || []).push(o); };
  Object.keys(offices).forEach(function (k) {
    const o = offices[k];
    const e = normEmail_(o.email);
    addIdx(offByEmail, e, o);
    const doms = uniq_([e && !isFreemail_(e) ? emailDomain_(e).replace(/^www\./, '') : '', urlHost_(o.website)]);
    doms.forEach(function (d) { if (d && !isFranchise_(d)) addIdx(offByDomain, d, o); });
    addIdx(offByPhone, normPhone_(o.phone), o);
  });
  const unique = function (arr) { return arr && uniq_(arr.map(function (o) { return o.source_key; })).length === 1 ? arr[0] : null; };

  people.forEach(function (p) {
    let off = p.office_key ? offices[p.office_key] : null;
    if (off) p.office_match = 'LINK';
    if (!off && p.office_name) {
      const byName = officesByName[normCompany_(p.office_name)];
      if (byName && byName.length === 1) { off = byName[0]; p.office_match = 'NAME'; } // jen jednoznačná shoda
    }
    const pe = normEmail_(p.email);
    if (!off && pe) { off = unique(offByEmail[pe]); if (off) p.office_match = 'EMAIL'; }
    if (!off && pe && !isFreemail_(pe)) { off = unique(offByDomain[emailDomain_(pe).replace(/^www\./, '')]); if (off) p.office_match = 'EMAIL_DOMAIN'; }
    if (!off && normPhone_(p.phone)) { off = unique(offByPhone[normPhone_(p.phone)]); if (off) p.office_match = 'PHONE'; }
    if (off) {
      usedOffices[off.source_key] = true;
      p.office_key = off.source_key;
      p.office_name = p.office_name || off.office_name;
      p.city = p.city || off.city;
      p.region = p.region || off.region;
      if (!p.website && off.website) { p.website = off.website; p.website_source = 'CATALOG_OFFICE'; }
      if (!p.email && off.email) { p.email = off.email; p.email_source = 'CATALOG_OFFICE'; }
      p.office_profile_url = off.profile_url;
    }
    const k = p.office_key || ('n:' + normCompany_(p.office_name));
    p.office_size = officeCount[k] || (p.contact_type === 'BROKER' ? 1 : 0);
    if (p.website && !p.website_source) p.website_source = 'CATALOG';
  });

  // Kanceláře bez uvedených makléřů jsou samostatnými kontakty (typ OFFICE).
  Object.keys(offices).forEach(function (k) {
    if (usedOffices[k]) return;
    const o = offices[k];
    const solo = looksLikePersonName_(o.office_name);
    people.push(Object.assign({}, o, {
      contact_type: solo ? 'BROKER' : 'OFFICE',
      full_name: solo ? o.office_name : '',
      office_size: solo ? 1 : 0,
      website_source: o.website ? 'CATALOG' : '',
    }));
  });

  // Sloučení duplicit mezi zdroji (union-find podle klíčů).
  const keyOwner = {};
  const merged = [];
  people.forEach(function (p) {
    p.source_keys = [p.source_key];
    p.profile_urls = uniq_([p.profile_url, p.office_profile_url]);
    p.sources = [p.source_key.split(':')[0]];
    const keys = mergeKeysFor_(p);
    let target = null;
    keys.forEach(function (k) { if (!target && keyOwner[k]) target = keyOwner[k]; });
    if (target) {
      mergeInto_(target, p);
      mergeKeysFor_(target).forEach(function (k) { keyOwner[k] = target; });
    } else {
      merged.push(p);
      keys.forEach(function (k) { keyOwner[k] = p; });
    }
  });
  merged.forEach(function (m) { m.merge_keys = mergeKeysFor_(m); });
  return merged;
}

/** Sloučení záznamu b do a – doplní jen chybějící údaje, nic nepřepisuje. */
function mergeInto_(a, b) {
  ['full_name', 'office_name', 'email', 'phone', 'website', 'city', 'region', 'office_key'].forEach(function (f) {
    if (!a[f] && b[f]) { a[f] = b[f]; if (f === 'website') a.website_source = b.website_source || 'CATALOG'; }
  });
  a.office_size = Math.max(toInt_(a.office_size, 0), toInt_(b.office_size, 0)) || a.office_size;
  a.source_keys = uniq_((a.source_keys || []).concat(b.source_keys || [b.source_key]));
  a.profile_urls = uniq_((a.profile_urls || []).concat(b.profile_urls || [b.profile_url]));
  a.sources = uniq_((a.sources || []).concat(b.sources || []));
}

/** Index existujících kontaktů podle merge klíčů a e-mailů. */
function buildContactIndex_(contacts) {
  const byKey = {};
  const emailCount = {};
  contacts.forEach(function (c) {
    String(c.merge_keys || '').split('\n').forEach(function (k) { if (k) byKey[k] = c; });
    const e = normEmail_(c.email);
    if (e) emailCount[e] = (emailCount[e] || 0) + 1;
  });
  return { byKey: byKey, emailCount: emailCount };
}

/**
 * Předběžná priorita (před hodnocením webu) – preferuje samostatné makléře a malé kanceláře.
 * @return {{score:number, reasons:string[]}}
 */
function prePriority_(c, emailCounts) {
  let score = 50;
  const reasons = [];
  const email = normEmail_(c.email);
  const isFr = isFranchise_(c.office_name) || isFranchise_(emailDomain_(email)) || isFranchise_(urlHost_(c.website));
  const size = toInt_(c.office_size, 0);
  const solo = c.contact_type === 'BROKER' && (size <= 1 || normPersonName_(c.full_name) === normText_(c.office_name) ||
    (c.office_name && normCompany_(c.office_name).indexOf(normText_(splitPersonName_(c.full_name).last)) >= 0 && size <= 2));
  if (isFr) { score -= 30; reasons.push('franšíza/síť'); }
  else if (solo) { score += 25; reasons.push('samostatný makléř'); }
  else if (size > 0 && size <= 5) { score += 15; reasons.push('malá kancelář (' + size + ' makl.)'); }
  else if (size > 15) { score -= 10; reasons.push('velká kancelář (' + size + ' makl.)'); }
  if (email) { score += 15; reasons.push('veřejný e-mail'); } else { score -= 25; reasons.push('bez e-mailu'); }
  if (email && emailCounts && emailCounts[email] > 1) { score -= 10; reasons.push('sdílený e-mail kanceláře'); }
  if (c.website) { score += 5; reasons.push('má web'); }
  else if (!isFr) { score += 10; reasons.push('web nenalezen v katalogu'); }
  if (email && isFreemail_(email)) { score += 5; reasons.push('freemail (bez vlastní domény)'); }
  return { score: Math.max(0, Math.min(100, score)), reasons: reasons };
}
