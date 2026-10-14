import fs from 'fs';
import vm from 'vm';
import assert from 'node:assert';
// Runs the Hub Improvements applier block of TasksSync.js against fake Apps Script services (no Google calls).
// Run: node test/tasks-sync-hub-applier.test.mjs
const full = fs.readFileSync(process.argv[2] || new URL('../apps-script/tasks-sync/TasksSync.js', import.meta.url), 'utf8');
const src = full.slice(full.lastIndexOf('// ====', full.indexOf('// HUB IMPROVEMENTS APPLIER')), full.indexOf('/** Edits to the Tasks tab push immediately'));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.formula = null; }
  getRange(a, b, c, d) {
    const self = this;
    if (typeof a === 'string') return { setFormula(f) { self.formula = f; self.rows = [[f]]; }, setValue() {} };
    return {
      setValues(v) { for (let i = 0; i < v.length; i++) { self.rows[a - 1 + i] = self.rows[a - 1 + i] || []; for (let j = 0; j < v[i].length; j++) self.rows[a - 1 + i][b - 1 + j] = v[i][j]; } },
      getValues() { return self.rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + d)); },
    };
  }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  appendRow(r) { this.rows.push(r); }
  setFrozenRows() {}
}
const SS = { sheets: {}, getSheetByName(n) { return this.sheets[n] || null; }, insertSheet(n) { return (this.sheets[n] = new Sheet(n)); } };
const TASKS = {};         // key listId|taskId -> task
let patches = [], emails = [], props = {};
const sandbox = {
  SpreadsheetApp: { getActive: () => SS },
  Tasks: { Tasks: {
    get: (l, t) => { const k = l + '|' + t; if (!TASKS[k]) throw new Error('Not Found'); return JSON.parse(JSON.stringify(TASKS[k])); },
    patch: (res, l, t) => { const k = l + '|' + t; if (!TASKS[k]) throw new Error('Not Found'); if (sandbox.__patchFails) throw new Error('Quota exceeded'); Object.assign(TASKS[k], res); patches.push({ k, res }); },
  } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  GmailApp: { sendEmail: (to, subj, body) => emails.push({ to, subj, body }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'brett@bmoremanagement.com' }) },
  Utilities: { formatDate: (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d) },
  Logger: { log() {} },
  TAB_NAME: 'Tasks_Sync',
  listTaskListsByTitle_: () => ({ 'RidgeCo Hub Improvements': 'LST' }),
  Date, JSON, String, Object, Number, Array, isNaN, Math,
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__x={hubNoteLine_,hubMergeNotes_,hubRowsToApply_,applyHubImprovements_,sheetObjects_};', sandbox);
const X = sandbox.__x;
const LH = ['ID', 'Task_ID', 'List_ID', 'Title', 'Status', 'Status_Changed_At', 'Queue_ID', 'Queue_Status', 'PR', 'Note', 'First_Seen', 'Applied_Status', 'Applied_At', 'Apply_Error'];
const led = (o) => LH.map(h => o[h] === undefined ? '' : o[h]);

// pure
eq(X.hubNoteLine_({ Status: 'pulled', Queue_ID: '7', Status_Changed_At: '2026-10-15T11:15:00Z' }), '[Hub] In progress: in the Optimizer queue as #7 since Oct 15', 'pulled line');
ok(/check before building/.test(X.hubNoteLine_({ Status: 'pulled', Queue_ID: '7', Note: 'Queue says: Looks already built: [FL-1] - check before building.', Status_Changed_At: '2026-10-15T11:15:00Z' })), 'pulled line carries the already-built warning');
eq(X.hubNoteLine_({ Status: 'building', PR: '262', Status_Changed_At: '2026-10-14T20:00:00Z' }), '[Hub] In progress: PR #262 open, awaiting merge (Oct 14)', 'building line');
eq(X.hubNoteLine_({ Status: 'done', PR: '113', Status_Changed_At: '2026-10-14T20:00:00Z' }), '[Hub] Built Oct 14 (PR #113)', 'done line');
ok(/Left open/.test(X.hubNoteLine_({ Status: 'dropped', Status_Changed_At: '2026-10-14T20:00:00Z' })), 'dropped stays open');
eq(X.hubMergeNotes_('Want read status\n\n[Hub] In progress: x', '[Hub] Built Oct 14'), 'Want read status\n\n[Hub] Built Oct 14', 'previous Hub line replaced, user text kept');
eq(X.hubMergeNotes_('', '[Hub] Built'), '[Hub] Built', 'empty notes');
eq(X.hubRowsToApply_([{ Task_ID: 'a', Status: 'done' }, { Task_ID: 'b', Status: 'pulled' }, { Task_ID: 'c', Status: 'weird' }, { Task_ID: 'd', Status: 'done' }, { Task_ID: 'e', Status: 'done' }],
  [{ Task_ID: 'a', Applied_Status: 'done', Error: '' }, { Task_ID: 'b', Applied_Status: 'pulled', Error: '' }, { Task_ID: 'd', Applied_Status: 'pulled', Error: '' }, { Task_ID: 'e', Applied_Status: 'done', Error: 'boom' }]).map(r => r.Task_ID), ['d', 'e'], 'only unapplied / errored rows');

// not authorised: view has no header
{
  SS.sheets = {}; emails = []; props = {};
  const r = X.applyHubImprovements_();
  ok(r.problems.length === 1 && /Allow access/.test(r.problems[0]), 'IMPORTRANGE not allowed is reported');
  ok(emails.length === 1 && /Hub_Ledger_View/.test(emails[0].body), 'and emailed');
  ok(SS.sheets.Hub_Ledger_View.formula.includes('IMPORTRANGE') && SS.sheets.Hub_Applied, 'tabs created with the IMPORTRANGE formula');
  X.applyHubImprovements_();
  eq(emails.length, 1, 'same problem is not re-emailed within 20h');
}

// normal run
{
  SS.sheets = {}; emails = []; props = {}; patches = [];
  X.applyHubImprovements_();                     // creates the tabs
  emails = []; props = {};
  const view = SS.sheets.Hub_Ledger_View;
  view.rows = [LH,
    led({ ID: 1, Task_ID: 'T1', List_ID: 'LST', Title: 'Read status', Status: 'pulled', Status_Changed_At: '2026-10-15T11:15:00Z', Queue_ID: 7 }),
    led({ ID: 2, Task_ID: 'T2', List_ID: 'LST', Title: 'SMS translation', Status: 'done', Status_Changed_At: '2026-10-14T20:00:00Z', PR: 113 }),
    led({ ID: 3, Task_ID: 'T3', List_ID: 'OLD', Title: 'Moved list', Status: 'building', PR: 261 }),
    led({ ID: 4, Task_ID: 'T4', List_ID: 'LST', Title: 'Gone', Status: 'done' }),
    led({ ID: 5, Task_ID: 'T5', List_ID: 'LST', Title: 'Unknown status', Status: 'proposed' })];
  TASKS['LST|T1'] = { id: 'T1', status: 'needsAction', notes: 'original note' };
  TASKS['LST|T2'] = { id: 'T2', status: 'needsAction', notes: '' };
  TASKS['NEW|T3'] = { id: 'T3', status: 'needsAction', notes: 'x' };
  SS.sheets.Tasks_Sync = new Sheet('Tasks_Sync'); SS.sheets.Tasks_Sync.rows = [['Task_ID', 'Title', 'Notes', 'Category', 'Status', 'Due_Date', 'Updated', 'List_ID'], ['T3', 'Moved list', 'x', '', 'needsAction', '', '', 'NEW']];
  const r = X.applyHubImprovements_();
  eq(r.applied, 3, 'three applied'); eq(r.failed, 1, 'one failed (task deleted)');
  ok(TASKS['LST|T1'].status === 'needsAction' && /original note\n\n\[Hub\] In progress: in the Optimizer queue as #7 since Oct 15/.test(TASKS['LST|T1'].notes), 'pulled: note line added, task stays open, original note kept');
  ok(TASKS['LST|T2'].status === 'completed' && /\[Hub\] Built Oct 14 \(PR #113\)/.test(TASKS['LST|T2'].notes), 'done: task completed with a Built line');
  ok(TASKS['NEW|T3'].status === 'needsAction' && /PR #261 open/.test(TASKS['NEW|T3'].notes), 'finds a task that moved lists via the mirror');
  const ap = X.sheetObjects_(SS.sheets.Hub_Applied.rows);
  const by = Object.fromEntries(ap.map(a => [a.Task_ID, a]));
  ok(by.T1.Applied_Status === 'pulled' && by.T2.Applied_Status === 'done' && !by.T1.Error, 'Hub_Applied records what was done');
  ok(/not found/.test(by.T4.Error) && by.T4.Applied_Status === '', 'a failure is recorded as an error and NOT as applied');
  ok(!by.T5, 'untracked statuses are ignored');
  ok(emails.length === 1 && /Gone/.test(emails[0].body), 'the failure is emailed');
  // idempotent
  patches = []; emails = [];
  const r2 = X.applyHubImprovements_();
  eq(r2.applied, 0, 'second run applies nothing new except the retry'); eq(r2.failed, 1, 'the failed one is retried');
  eq(patches.length, 0, 'no repeat patches');
  eq(emails.length, 0, 'identical failure not re-emailed');
  // status moves on: pulled -> done
  view.rows[1] = led({ ID: 1, Task_ID: 'T1', List_ID: 'LST', Title: 'Read status', Status: 'done', Status_Changed_At: '2026-10-16T11:15:00Z', PR: 262 });
  X.applyHubImprovements_();
  ok(TASKS['LST|T1'].status === 'completed' && /Built Oct 16 \(PR #262\)/.test(TASKS['LST|T1'].notes) && !/In progress/.test(TASKS['LST|T1'].notes), 'pulled -> done completes the task and replaces the in-progress line');
  // API failure is recorded and does not look applied
  view.rows.push(led({ ID: 6, Task_ID: 'T6', List_ID: 'LST', Title: 'Quota', Status: 'done' })); TASKS['LST|T6'] = { id: 'T6', status: 'needsAction', notes: '' };
  sandbox.__patchFails = true; emails = [];
  X.applyHubImprovements_();
  ok(TASKS['LST|T6'].status === 'needsAction' && X.sheetObjects_(SS.sheets.Hub_Applied.rows).find(a => a.Task_ID === 'T6').Error.includes('Quota'), 'Tasks API error recorded, task untouched');
  sandbox.__patchFails = false;
  X.applyHubImprovements_();
  ok(TASKS['LST|T6'].status === 'completed' && !X.sheetObjects_(SS.sheets.Hub_Applied.rows).find(a => a.Task_ID === 'T6').Error, 'recovers on the next poll and clears the error');
}
console.log('tasks-sync hub applier: ' + n + '/' + n + ' passing');
