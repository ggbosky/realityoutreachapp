/**
 * Parser robots.txt dle RFC 9309.
 * - Skupiny se stejným user-agentem se slučují.
 * - Pokud existuje skupina pro náš token (ProjectTwoBot), použije se; jinak skupina "*".
 * - Rozhoduje nejdelší shodné pravidlo; při shodě délky vítězí Allow.
 * - Podpora wildcardů "*" a ukotvení "$".
 */

function parseRobots_(text) {
  const groups = []; // {agents:[], rules:[{allow, path}], crawlDelay}
  let current = null;
  let lastWasAgent = false;
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue; // prázdný Disallow = nic nezakazuje
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const d = parseFloat(value);
      if (!isNaN(d)) current.crawlDelay = d;
    }
  }
  return groups;
}

/** Vybere pravidla platná pro daný agent token (sloučené skupiny). */
function robotsRulesFor_(groups, agentToken) {
  const token = String(agentToken).toLowerCase();
  let specific = groups.filter(function (g) {
    return g.agents.some(function (a) { return a && a !== '*' && a === token; });
  });
  if (!specific.length) specific = groups.filter(function (g) { return g.agents.indexOf('*') >= 0; });
  const rules = [];
  let crawlDelay = null;
  specific.forEach(function (g) {
    g.rules.forEach(function (r) { rules.push(r); });
    if (g.crawlDelay !== null) crawlDelay = Math.max(crawlDelay || 0, g.crawlDelay);
  });
  return { rules: rules, crawlDelay: crawlDelay, matchedGroups: specific.length };
}

function robotsPatternToRegex_(path) {
  let anchored = false;
  let p = path;
  if (p.charAt(p.length - 1) === '$') { anchored = true; p = p.substring(0, p.length - 1); }
  const esc = p.split('*').map(function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('.*');
  return new RegExp('^' + esc + (anchored ? '$' : ''));
}

/** Je cesta (path+query) povolena? */
function robotsIsAllowed_(groupsOrText, agentToken, pathAndQuery) {
  const groups = typeof groupsOrText === 'string' ? parseRobots_(groupsOrText) : groupsOrText;
  const sel = robotsRulesFor_(groups, agentToken);
  let path = pathAndQuery || '/';
  try { path = decodeURI(path); } catch (e) { /* ponechat */ }
  let best = null;
  sel.rules.forEach(function (r) {
    let rp = r.path;
    try { rp = decodeURI(rp); } catch (e) { /* ponechat */ }
    // Pravidla, která nezačínají "/" ani "*", porovnáváme i jako prefix s "/" (častá chyba v robots.txt).
    const candidates = [rp];
    if (rp.charAt(0) !== '/' && rp.charAt(0) !== '*') candidates.push('/' + rp);
    candidates.forEach(function (c) {
      if (robotsPatternToRegex_(c).test(path)) {
        const len = c.length;
        if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len: len, allow: r.allow, rule: r };
      }
    });
  });
  return { allowed: best ? best.allow : true, rule: best ? (best.allow ? 'Allow: ' : 'Disallow: ') + best.rule.path : null, crawlDelay: sel.crawlDelay };
}
