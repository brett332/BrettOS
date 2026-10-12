// Brett Master Automation (Google Apps Script, runs as brett@bmoremanagement.com)
//
// ONE project for scheduled / automated jobs, so nothing needs paid Cloudflare
// cron. Each job is a "module" listed in MODULES below; a single one-minute
// trigger (masterTick) runs them all, and an on-edit trigger runs them
// instantly when an entry sheet is edited.
//
// To add a new automation: write a file with a function, add it to MODULES.
// Run installTriggers() once after authorizing (and again after adding sheets).
//
// Modules
//   barrelEntry  - applies the "Entry" tab (and the Waynesboro Sales sheet) to the
//                  StockShift Inventory + History tabs. See BarrelEntry.gs.

var MODULES = [
  { name: 'barrelEntry', run: function (ctx) { return runBarrelEntry_(ctx); } }
];

// One-minute heartbeat.
function masterTick() {
  runModules_({ source: 'timer', minute: new Date().getMinutes() });
}

// Installable on-edit trigger target (instant processing when someone types a row).
function onEditTick(e) {
  runModules_({ source: 'edit', minute: new Date().getMinutes() });
}

function runModules_(ctx) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return;            // another run is busy; the next tick will catch up
  try {
    MODULES.forEach(function (m) {
      try { m.run(ctx); }
      catch (err) { logMaster_(m.name + ' failed: ' + (err && err.message || err)); }
    });
  } finally { lock.releaseLock(); }
}

// Last-resort error log (Debug tab of the Barrel Tools sheet), de-duplicated hourly.
function logMaster_(msg) {
  try { Logger.log('[master] ' + msg); } catch (_) {}
  try { logOnce_(SpreadsheetApp.openById(BARREL.SHEET_ID), 'master', msg); } catch (_) {}
}

// Run this ONCE (and again whenever a new sheet is wired in). Safe to re-run.
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'masterTick' || h === 'onEditTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('masterTick').timeBased().everyMinutes(1).create();
  var ids = [BARREL.SHEET_ID];
  var ss = SpreadsheetApp.openById(BARREL.SHEET_ID);
  var cfg = readConfig_(ss);
  if (cfg.WaynesboroEntrySheetId) ids.push(cfg.WaynesboroEntrySheetId);
  ids.forEach(function (id) {
    ScriptApp.newTrigger('onEditTick').forSpreadsheet(SpreadsheetApp.openById(id)).onEdit().create();
  });
  Logger.log('Triggers installed: 1-minute timer + on-edit for ' + ids.length + ' sheet(s).');
}
