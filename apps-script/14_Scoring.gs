/**
 * Skóre kvality webu (0–100, 100 = výborný web) a skóre obchodního potenciálu (0–100, 100 = Project Two
 * může nejvíce pomoci). Kategorie dle zadání: design, mobil, rychlost, funkčnost, přehlednost,
 * prezentace služeb, vlastní doména, profesionalita.
 */

const SCORE_WEIGHTS = {
  design: 15, mobile: 20, speed: 15, functionality: 15, clarity: 10, presentation: 10, domain: 5, professionalism: 10,
};
const SEVERITY_PENALTY = { 0: 0, 1: 12, 2: 35, 3: 85 };
/** Horní hranice celkového skóre při zjištění (jistota HIGH). */
const SCORE_CAPS = { FLASH: 25, FRAMESET: 25, NO_VIEWPORT: 40, FIXED_VIEWPORT: 50, NO_OWN_DOMAIN: 50, OLD_CMS: 55, OLD_COPYRIGHT: 60, NO_HTTPS: 65, PSI_MOBILE_SLOW: 60 };
const CATEGORY_LABELS = {
  design: 'Design', mobile: 'Mobilní zobrazení', speed: 'Rychlost', functionality: 'Funkčnost',
  clarity: 'Přehlednost', presentation: 'Prezentace služeb', domain: 'Vlastní doména', professionalism: 'Profesionalita',
};

/** @return {{score:number|null, breakdown:Object}} – null pokud web nelze hodnotit */
function webQualityScore_(findings, facts, hasWebsite) {
  const breakdown = {};
  Object.keys(SCORE_WEIGHTS).forEach(function (k) { breakdown[k] = 100; });
  if (!hasWebsite) {
    Object.keys(breakdown).forEach(function (k) { breakdown[k] = 0; });
    return { score: 0, breakdown: breakdown };
  }
  if (findings.some(function (f) { return f.code === 'ROBOTS_BLOCKED'; })) return { score: null, breakdown: {} };
  if (findings.some(function (f) { return f.code === 'UNREACHABLE'; })) {
    Object.keys(breakdown).forEach(function (k) { breakdown[k] = 0; });
    breakdown.domain = 100;
    return { score: 5, breakdown: breakdown };
  }
  findings.forEach(function (f) {
    if (breakdown[f.category] === undefined) return;
    const pen = SEVERITY_PENALTY[f.severity] * (f.confidence === 'HIGH' ? 1 : 0.6);
    breakdown[f.category] = Math.max(0, breakdown[f.category] - pen);
  });
  // Profesionalita zohlední i doménu a HTTPS.
  if (!facts.https) breakdown.professionalism = Math.max(0, breakdown.professionalism - 20);
  if (breakdown.domain < 100) breakdown.professionalism = Math.max(0, breakdown.professionalism - 20);
  let total = 0, w = 0;
  Object.keys(SCORE_WEIGHTS).forEach(function (k) { total += breakdown[k] * SCORE_WEIGHTS[k]; w += SCORE_WEIGHTS[k]; });
  Object.keys(breakdown).forEach(function (k) { breakdown[k] = Math.round(breakdown[k]); });
  // Kritické nedostatky omezují celkové skóre (průměr by je jinak „rozředil“).
  let score = Math.round(total / w);
  findings.forEach(function (f) {
    if (f.confidence !== 'HIGH') return;
    const cap = SCORE_CAPS[f.code];
    if (cap !== undefined) score = Math.min(score, cap);
  });
  const serious = findings.filter(function (f) { return f.severity >= 2 && f.confidence === 'HIGH'; }).length;
  if (serious >= 3) score = Math.max(0, score - 5 * (serious - 2));
  return { score: score, breakdown: breakdown };
}

/** Skóre obchodního potenciálu. */
function potentialScore_(webScore, pre, c, findings) {
  const need = webScore === null ? 40 : (100 - webScore);
  let p = Math.round(0.65 * need + 0.35 * pre);
  const email = normEmail_(c.email);
  if (isFranchise_(c.office_name) || isFranchise_(emailDomain_(email))) p = Math.min(p, 35);
  if (!email) p = Math.min(p, 45);
  if (findings.some(function (f) { return f.code === 'NO_WEBSITE'; }) && email) p = Math.max(p, 70);
  if (findings.some(function (f) { return f.code === 'UNREACHABLE'; }) && email) p = Math.max(p, 80);
  return Math.max(0, Math.min(100, p));
}

function redesignOpportunity_(webScore, findings) {
  const top = findings.filter(function (f) { return f.severity >= 2; }).sort(function (a, b) { return b.severity - a.severity; })
    .slice(0, 3).map(function (f) { return f.text.replace(/\.$/, ''); });
  if (webScore === null) return 'Nehodnoceno (web zakazuje analýzu).';
  if (findings.some(function (f) { return f.code === 'NO_WEBSITE'; })) return 'Vysoká – makléř nemá vlastní web.';
  if (webScore < 45) return 'Vysoká – ' + top.join('; ');
  if (webScore < 70) return 'Střední – ' + (top.join('; ') || 'drobné nedostatky');
  return 'Nízká – web je v dobrém stavu' + (top.length ? ' (' + top.join('; ') + ')' : '');
}

function recommendService_(findings, webScore) {
  const map = safeJsonParse_(setting_('SERVICE_MAP_JSON'), {}) || {};
  const has = function (c) { return findings.some(function (f) { return f.code === c; }); };
  let key = 'DEFAULT';
  if (has('NO_WEBSITE')) key = 'NO_WEBSITE';
  else if (has('UNREACHABLE')) key = 'UNREACHABLE';
  else if (has('NO_OWN_DOMAIN')) key = 'NO_OWN_DOMAIN';
  else if (has('FLASH') || has('FRAMESET') || has('TABLE_LAYOUT') || has('FONT_TAGS') || has('OLD_COPYRIGHT') || (webScore !== null && webScore < 45)) key = 'OUTDATED';
  else if (has('NO_VIEWPORT') || has('FIXED_VIEWPORT')) key = 'NO_VIEWPORT';
  else if (has('SLOW') || has('PSI_MOBILE_SLOW')) key = 'SLOW';
  else if (has('NO_HTTPS') || has('OLD_CMS')) key = 'NO_HTTPS';
  else if (has('WEAK_PRESENTATION') || has('FEW_IMAGES')) key = 'WEAK_PRESENTATION';
  return map[key] || map.DEFAULT || key;
}

/** Nejsilnější prokazatelné zjištění pro {{konkretni_postreh}} (jen confidence HIGH a s připraveným textem). */
function pickPostreh_(findings) {
  const order = ['UNREACHABLE', 'NO_WEBSITE', 'FLASH', 'FRAMESET', 'NO_VIEWPORT', 'FIXED_VIEWPORT', 'NO_OWN_DOMAIN',
    'OLD_COPYRIGHT', 'PSI_MOBILE_SLOW', 'OLD_CMS', 'NO_HTTPS', 'FREEMAIL'];
  for (let i = 0; i < order.length; i++) {
    const f = findings.filter(function (x) { return x.code === order[i] && x.confidence === 'HIGH' && x.postreh; })[0];
    if (f) return f.postreh;
  }
  return '';
}

function findingsText_(findings) {
  return findings.filter(function (f) { return f.severity > 0 || f.code === 'ROBOTS_BLOCKED' || f.code === 'LIMITED_ANALYSIS'; })
    .sort(function (a, b) { return b.severity - a.severity; })
    .map(function (f) { return '• ' + f.text + (f.confidence !== 'HIGH' ? ' [orientační]' : ''); }).join('\n');
}
