/**
 * Plánovač – Google Apps Script time-driven trigger (běží v cloudu Google, i když je počítač vypnutý).
 *
 * Jeden trigger `tick` každých 10 minut rozhoduje podle nastavení (SCAN_TIME, SEND_TIME, Europe/Prague):
 *  1) pokračuje rozpracovaný běh (checkpoint),
 *  2) v SCAN_TIME spustí denní skenování (max. jednou denně),
 *  3) v SEND_TIME (po dokončení skenu) spustí odesílání,
 *  4) jednou za hodinu zkontroluje odpovědi a odhlášení.
 * Díky tomu změna času v nastavení nevyžaduje přeinstalaci triggerů a výpadek jedné exekuce
 * se automaticky dožene v další.
 */

const TICK_HANDLER = 'tick';

/**
 * Ověří, že volání pochází ze skutečného time-driven triggeru tohoto projektu.
 * (Veřejné funkce jsou v Apps Script volatelné i přes google.script.run z web aplikace.)
 */
function isProjectTriggerEvent_(e) {
  if (!e || !e.triggerUid) return false;
  const uid = String(e.triggerUid);
  return ScriptApp.getProjectTriggers().some(function (t) { return String(t.getUniqueId()) === uid; });
}

/** Vstupní bod triggeru (nebo ručního spuštění vlastníkem z editoru). */
function tick(e) {
  if (!isProjectTriggerEvent_(e)) assertAdmin_();
  const started = Date.now();
  const deadline = started + P2.EXEC_BUDGET_MS;
  const result = withScriptLock_(function () {
    SETTINGS_CACHE_ = null;
    if (!isSystemEnabled_()) return { skipped: 'SYSTEM_ENABLED=FALSE' };
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const today = todayPrague_(now);
    const minutes = minutesOfDayPrague_(now);
    const out = { at: nowIso_() };

    // 1) + 2) Skenování
    let state = getRunState_();
    const unfinished = state && state.phase !== 'DONE' && state.phase !== 'FAILED';
    const scanDue = settingBool_('DAILY_SCAN_ENABLED') && minutes >= parseHHMM_(setting_('SCAN_TIME'), 480) &&
      props.getProperty('P2_LAST_SCAN_START') !== today;
    if (!unfinished && scanDue) {
      state = startDailyRun_(false);
      props.setProperty('P2_LAST_SCAN_START', today);
      out.scanStarted = state.runId;
    }
    state = getRunState_();
    if (state && state.phase !== 'DONE' && state.phase !== 'FAILED') {
      state = runPipelineStep_(deadline);
      out.scanPhase = state && state.phase;
    }

    // 3) Odesílání – až po dokončení dnešního skenu (nebo když dnes sken neběží)
    const scanBusy = state && state.phase !== 'DONE' && state.phase !== 'FAILED';
    const sendDue = settingBool_('AUTO_SEND_ENABLED') && minutes >= parseHHMM_(setting_('SEND_TIME'), 600) &&
      props.getProperty('P2_LAST_SEND_COMPLETE') !== today;
    if (sendDue && !scanBusy && Date.now() < deadline - 30000) {
      const s = runSendJob_(deadline, {});
      out.send = s;
      // Dokončeno = nic dalšího k odeslání dnes (ne kvůli času); jinak pokračujeme v dalším ticku.
      if (s.stoppedBy !== 'TIME_BUDGET' && s.stoppedBy !== 'LOCK_BUSY') props.setProperty('P2_LAST_SEND_COMPLETE', today);
    }

    // 4) Odpovědi / odhlášení – max. jednou za hodinu
    const lastInbox = toInt_(props.getProperty('P2_LAST_INBOX_CHECK'), 0);
    if (Date.now() - lastInbox > 55 * 60 * 1000 && Date.now() < deadline - 30000) {
      try { out.inbox = runInboxMonitor_(deadline); } catch (e) { logError_('inbox', '', 'ERROR', String(e.message || e), e.stack); }
    }
    props.setProperty('P2_LAST_TICK', nowIso_());
    return out;
  }, 1000);
  return result || { skipped: 'LOCK_BUSY (běží jiná exekuce)' };
}

/** Instalace triggerů (idempotentní). */
function installTriggers_() {
  removeTriggers_();
  ScriptApp.newTrigger(TICK_HANDLER).timeBased().everyMinutes(P2.TICK_MINUTES).create();
  return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TICK_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

function triggersInstalled_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === TICK_HANDLER; });
}

/** STOP – jedním tlačítkem zastaví vše: vypínač, automatické odesílání a odstraní triggery. */
function emergencyStop_(who) {
  saveSettings_({ SYSTEM_ENABLED: 'FALSE', AUTO_SEND_ENABLED: 'FALSE' });
  removeTriggers_();
  logError_('admin', '', 'WARN', 'NOUZOVÉ ZASTAVENÍ provedeno: ' + (who || ''), '');
  return { stopped: true, triggers: ScriptApp.getProjectTriggers().length };
}

/** Obnovení provozu (odesílání zůstává vypnuté – je nutné ho zapnout vědomě). */
function resumeSystem_() {
  saveSettings_({ SYSTEM_ENABLED: 'TRUE' });
  installTriggers_();
  return { resumed: true };
}
