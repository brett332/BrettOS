/**
 * BrettOS — Google Tasks <-> Sheets Two-Way Sync, plus assistant-independent email capture,
 * automatic multi-list categorization, and a self-learning one-tap review page.
 *
 * Bound to the BrettOS Tasks Sheet (1X2oYjDfnGzJWDI84e1t4p7cbt9iWxq5qbPmNFI9auuA) — NOT the
 * RidgeCo Hub production sheet. Adds/maintains its own tabs (Tasks_Sync, Category_Rules) —
 * does not touch any existing tab, so it's safe to add alongside whatever else lives here.
 *
 * Confirmed against Google's own docs: Google Tasks has full Apps Script support (Tasks
 * Advanced Service), external event polling, and personal API access — Google Keep has
 * none of the three, so Keep cannot do two-way sync at all.
 *
 * WHY THIS VERSION ADDS EMAIL CAPTURE (Sep 26 2026):
 * Getting Gemini/Assistant linked to Google Tasks on a Workspace account ran into what
 * looked like a paywall but was actually 3 free admin-console toggles (documented in the
 * project notes, not repeated here). Regardless, this version also adds a capture path
 * that depends on NEITHER Gemini NOR Bixby NOR any assistant at all: email a task to
 * yourself, dictating with the phone's own keyboard mic (plain Android/Gboard voice
 * typing — not an assistant, not gated by anything Google could paywall) into a Gmail
 * compose window, and this script turns it into a real Task automatically.
 *
 * WHY THIS VERSION ADDS A FAR-FUTURE-DATE MARKER (Sep 26 2026):
 * Assistant/Gemini voice reminders REQUIRE a date+time to create the task at all —
 * confirmed directly by Brett (saying "remind me never" or declining to give a date/time
 * cancels task creation entirely, it doesn't create an undated task). Workaround: use a
 * fixed, obviously-fake far-future date (e.g. "January 1st, 2099") whenever you don't
 * actually want to be reminded at a real time. Any due date whose YEAR is >=
 * FAR_FUTURE_MARKER_YEAR is treated by this script as "not a real due date": blanked out
 * in the Sheet's Due_Date column, with a best-effort attempt to clear it on the live Task
 * too (cosmetic only — the Tasks API only ever stores a date, never a time, so the real
 * alarm mechanism lives outside what this script can touch; safety here comes purely from
 * the date being 70+ years out, not from actually cancelling a notification).
 *
 * WHY THIS VERSION ADDS MULTI-LIST AUTO-CATEGORIZATION (Sep 26 2026):
 * Brett wants real separate Google Tasks lists (Cabin-ToHome, Cabin-FromHome, Admin,
 * Ideas, etc.), created and populated by the backend as needed. Directly tested by Brett:
 * Google Assistant CANNOT target a specific named Tasks list by voice, even one that
 * already exists — every voice capture lands in your one default list ("Brett Lambert's
 * list"), no exceptions. So the backend sorts AFTER capture instead of at capture time:
 *   1. Everything spoken to Assistant lands in the inbox list (INBOX_LIST_NAME below).
 *   2. Every sync pass, routeInboxTasks_() resolves a category for each inbox task, in
 *      priority order: (a) an explicit "#tag" in Notes (from email capture/brain-dump) —
 *      authoritative, used verbatim as the list name; (b) a learned rule from the
 *      Category_Rules tab (see below); (c) the CATEGORY_RULES keyword table baked into
 *      this file as a bootstrap set. If resolved, getOrCreateListId_() creates that Tasks
 *      list if needed and Tasks.Tasks.move() relocates the task into it (confirmed: the
 *      Tasks API moves a task to a different list directly via destinationTasklist — no
 *      delete/recreate needed).
 *   3. Anything left unresolved stays in the inbox and shows up on the review page below.
 *
 * WHY THIS VERSION ADDS THE REVIEW PAGE + LEARNED RULES (Sep 26 2026):
 * Brett explicitly rejected editing the raw Sheet as the resolution mechanism ("clunky").
 * What he wants instead: something to tap through on his phone, where each decision teaches
 * the system so the same kind of item never needs a decision again. This version adds:
 *   - A `Category_Rules` tab: Keyword, List_Name, Created_Date, Match_Count. Populated
 *     both by hand (rows you add yourself) and automatically every time you categorize
 *     something through the review page.
 *   - resolveCategory_() checks these learned rules (longest keyword first, so more
 *     specific rules win over generic ones) BEFORE falling back to the hardcoded
 *     CATEGORY_RULES bootstrap list.
 *   - A tiny mobile web page (doGet/assignCategory below) listing only the inbox tasks
 *     nothing could resolve. Tap a list (or type a new one), confirm the suggested
 *     keyword (auto-extracted, editable), and it: moves the task, creates the list if
 *     new, and saves the keyword as a permanent rule. One deploy (see setup notes below)
 *     gives you a URL to bookmark/add to your phone's home screen — no Sheets UI involved.
 * Net effect: the set of things you have to manually resolve shrinks every time you use it.
 *
 * WHY THIS FILE NOW LIVES IN GITHUB (Sep 26 2026):
 * Deploying via the Apps Script editor UI required a manual "New version -> Deploy" click
 * every time the code changed. This file is now the source of truth, pushed to the live
 * Apps Script project by .github/workflows/deploy-tasks-sync.yml on every push to main —
 * same auto-deploy shape as the RidgeCo Hub's Cloudflare Workers Builds. Edit this file (or
 * have Claude edit it) and push; the live web app + triggers pick it up automatically via
 * `clasp push` + `clasp deploy -i <deploymentId>` (updates the existing deployment/URL
 * rather than minting a new one). See .clasp.json for the bound scriptId. The first CI run
 * failed because the pasted OAuth credentials secret got corrupted by copy/paste — the
 * secret is now stored base64-encoded (CLASP_CREDENTIALS_B64) to avoid that.
 * (redeploy trigger: CLASP_CREDENTIALS_B64 re-saved without trailing shell-prompt text)
 *
 * ---------------------------------------------------------------------------------
 * ONE-TIME SETUP (already done — kept here for reference)
 * 1. Open the BrettOS Tasks Sheet -> Extensions -> Apps Script.
 * 2. Services (+ icon, left sidebar) -> add "Tasks API" (Google's Tasks Advanced
 *    Service). Approve enabling the Tasks API on the linked Google Cloud project if
 *    prompted.
 * 3. Run `setup` once from the editor toolbar. First run prompts for authorization —
 *    accept it (this also asks for Gmail access, for email capture — accept that too).
 *    Creates the Tasks_Sync + Category_Rules tabs and installs all triggers.
 * 4. Run `initialFullSync` once to pull in everything already in the list.
 * 5. Deploy -> New deployment -> Web app -> Execute as Me, Only myself -> Deploy. That
 *    deployment's ID is what the GitHub Action re-deploys to on every push.
 *
 * ONE-TIME SETUP — email capture (no assistant needed)
 * 1. In Gmail: gear -> See all settings -> Filters and Blocked Addresses -> Create a new
 *    filter. Subject contains: task:
 * 2. Create filter -> check "Apply the label" -> New label -> Tasks-Inbox -> also check
 *    "Skip the Inbox (Archive it)". Save.
 * 3. From your phone: Gmail -> compose -> to yourself -> Subject: task: <thing, e.g.
 *    #Cabin-ToHome propane tank> -> dictate with the keyboard mic -> Send. Body -> Notes.
 * 4. `processEmailToTasks` (installed by `setup`, runs every 5 min) converts each one.
 *
 * IMPORTANT — offline note: a task or email created on your phone while offline won't
 * reach this script until your phone reconnects and Gmail/Tasks sync to Google's servers.
 * ---------------------------------------------------------------------------------
 */

const TAB_NAME = 'Tasks_Sync';
const RULES_TAB_NAME = 'Category_Rules';

// The list Assistant/Gemini voice capture always lands in — confirmed Assistant cannot
// target any other list by voice, so this is the one fixed "inbox" everything starts in.
const INBOX_LIST_NAME = "Brett Lambert's list";

// Lists that exist in the account but should never be synced or routed into (junk/legacy).
const EXCLUDED_LISTS = ['Old Google Keep reminders'];

const COLS = ['Task_ID', 'Title', 'Notes', 'Category', 'Status', 'Due_Date', 'Updated', 'List_ID'];
const RULES_COLS = ['Keyword', 'List_Name', 'Created_Date', 'Match_Count'];
const CATEGORY_TAG_RE = /#([A-Za-z0-9_-]+)/;

// Bootstrap-only keyword routing — the FALLBACK checked after learned rules (Category_Rules
// tab) find nothing. Matched case-insensitively against "title + ' ' + notes". Edit freely,
// but in practice you'll rarely need to: the review page grows Category_Rules over time and
// those always take priority over this list.
const CATEGORY_RULES = [
  { list: 'Cabin-FromHome', any: ['bring to cabin', 'take to cabin', 'for the cabin', 'cabin needs', 'pack for cabin'] },
  { list: 'Cabin-ToHome', any: ['bring home', 'from cabin', 'back from cabin', 'take home', 'cabin to home'] },
  { list: 'Admin', any: ['admin', 'call ', 'email ', 'pay ', 'invoice', 'schedule', 'renew', 'file ', 'appointment'] },
  { list: 'Ideas', any: ['idea', 'someday', 'explore', 'consider', 'what if'] }
];

const EMAIL_LABEL_INBOX = 'Tasks-Inbox';       // Gmail filter applies this label
const EMAIL_LABEL_DONE = 'Tasks-Processed';    // this script moves processed threads here
const EMAIL_SUBJECT_STRIP_RE = /^\s*task:\s*/i; // strips the "task:" trigger word from the title

// Any due date whose year is >= this is treated as a fake "Assistant made me pick a date"
// placeholder, not a real reminder. Pick a spoken date in this year or later (e.g. "January
// first, twenty ninety-nine") whenever you want voice capture with no real due date.
const FAR_FUTURE_MARKER_YEAR = 2090;

function isFarFutureMarker_(dueIso) {
  if (!dueIso) return false;
  const year = new Date(dueIso).getUTCFullYear();
  return !isNaN(year) && year >= FAR_FUTURE_MARKER_YEAR;
}

function setup() {
  ensureTab_();
  ensureRulesTab_();
  ensureEmailLabels_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t)); // avoid dupes on re-run
  ScriptApp.newTrigger('pollAll').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('processEmailToTasks').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  Logger.log('Setup complete: Tasks_Sync + Category_Rules tabs ready, 5-min routing+sync poll + 5-min email-capture poll + onEdit trigger installed. Deploy as a Web App (see file header) to get the review page.');
}

function ensureTab_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) sheet = ss.insertSheet(TAB_NAME);
  const header = sheet.getRange(1, 1, 1, COLS.length);
  if (sheet.getLastRow() === 0 || header.getValues()[0].join('') === '') {
    header.setValues([COLS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureRulesTab_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(RULES_TAB_NAME);
  if (!sheet) sheet = ss.insertSheet(RULES_TAB_NAME);
  const header = sheet.getRange(1, 1, 1, RULES_COLS.length);
  if (sheet.getLastRow() === 0 || header.getValues()[0].join('') === '') {
    header.setValues([RULES_COLS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureEmailLabels_() {
  [EMAIL_LABEL_INBOX, EMAIL_LABEL_DONE].forEach(name => {
    if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
  });
}

/** All task lists in the account, keyed by title, refreshed fresh every call (no caching —
 *  avoids staleness bugs right after a list is created). */
function listTaskListsByTitle_() {
  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  const byTitle = {};
  lists.forEach(l => { byTitle[l.title] = l.id; });
  return byTitle;
}

/** Returns the id of a task list with this exact title, creating it via the API if it
 *  doesn't exist yet. This is the mechanism that lets the backend spin up new categories
 *  ("this needs a new list") without any manual step in the Tasks app. */
function getOrCreateListId_(title) {
  const byTitle = listTaskListsByTitle_();
  if (byTitle[title]) return byTitle[title];
  const created = Tasks.Tasklists.insert({ title: title });
  Logger.log(`Created new Tasks list: "${title}" (${created.id})`);
  return created.id;
}

function getInboxListId_() {
  return getOrCreateListId_(INBOX_LIST_NAME);
}

/** Reads Category_Rules into an array of {keyword (lowercase), list, row}, longest keyword
 *  first so more specific learned rules outrank shorter/generic ones. */
function getLearnedRules_() {
  const sheet = ensureRulesTab_();
  const data = sheet.getDataRange().getValues();
  const rules = [];
  for (let r = 1; r < data.length; r++) {
    const [keyword, list] = data[r];
    if (keyword && list) rules.push({ keyword: String(keyword).toLowerCase(), list: String(list), row: r + 1 });
  }
  rules.sort((a, b) => b.keyword.length - a.keyword.length);
  return rules;
}

/** Bumps Match_Count for a learned rule (best-effort, non-fatal if it fails). */
function bumpRuleMatchCount_(row) {
  try {
    const sheet = ensureRulesTab_();
    const cell = sheet.getRange(row, RULES_COLS.indexOf('Match_Count') + 1);
    cell.setValue((Number(cell.getValue()) || 0) + 1);
  } catch (err) {
    Logger.log(`Could not bump match count for rule row ${row}: ${err}`);
  }
}

/** Appends a new learned rule. Skips silently if that exact keyword already exists
 *  (edit the existing row instead if you want to repoint it). */
function addLearnedRule_(keyword, list) {
  const kw = (keyword || '').trim();
  if (!kw) return;
  const existing = getLearnedRules_();
  if (existing.some(r => r.keyword === kw.toLowerCase())) return;
  const sheet = ensureRulesTab_();
  sheet.appendRow([kw, list, new Date().toISOString(), 0]);
}

/** Decide which list an inbox task belongs in, or null if nothing matches (stays put,
 *  shows up on the review page). Priority: explicit #tag > learned rules > bootstrap
 *  keyword table. Returns { category, ruleRow } — ruleRow set only for a learned-rule hit,
 *  so the caller can bump its match count. */
function resolveCategory_(title, notes) {
  const tagMatch = (notes || '').match(CATEGORY_TAG_RE);
  if (tagMatch) return { category: tagMatch[1], ruleRow: null }; // explicit tag is authoritative

  const haystack = `${title || ''} ${notes || ''}`.toLowerCase();

  const learned = getLearnedRules_();
  for (const rule of learned) {
    if (haystack.includes(rule.keyword)) return { category: rule.list, ruleRow: rule.row };
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.any.some(kw => haystack.includes(kw))) return { category: rule.list, ruleRow: null };
  }
  return { category: null, ruleRow: null };
}

/**
 * Scans the inbox list and moves any task with a resolved category into its real list,
 * creating that list first if needed. Runs before syncTasksToSheet() on every poll so the
 * Sheet always reflects each task's post-routing location, not its momentary inbox stop.
 */
function routeInboxTasks_() {
  const inboxId = getInboxListId_();
  let pageToken;
  do {
    const resp = Tasks.Tasks.list(inboxId, {
      showCompleted: false, // no need to re-route something already done
      maxResults: 100,
      pageToken
    });
    (resp.items || []).forEach(task => {
      const { category, ruleRow } = resolveCategory_(task.title, task.notes);
      if (!category) return; // stays in inbox — will show up on the review page

      try {
        const destId = getOrCreateListId_(category);
        if (destId === inboxId) return; // category resolved to the inbox itself — no-op
        Tasks.Tasks.move(inboxId, task.id, { destinationTasklist: destId });
        if (ruleRow) bumpRuleMatchCount_(ruleRow);
        Logger.log(`Routed task "${task.title}" (${task.id}) -> "${category}"`);
      } catch (err) {
        Logger.log(`Failed to route task "${task.title}" (${task.id}) to "${category}": ${err}`);
        // left in the inbox — will be retried next poll
      }
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
}

/** Entry point for the 5-min trigger: route first, then sync everything to the Sheet. */
function pollAll() {
  routeInboxTasks_();
  syncTasksToSheet();
}

/** Tasks -> Sheet, across every non-excluded list. Also callable manually. */
function syncTasksToSheet() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SYNCING', 'true');
  try {
    const sheet = ensureTab_();
    const data = sheet.getDataRange().getValues();
    const idCol = COLS.indexOf('Task_ID');
    const rowById = {};
    for (let r = 1; r < data.length; r++) {
      if (data[r][idCol]) rowById[data[r][idCol]] = r + 1; // 1-indexed sheet row
    }

    const listsByTitle = listTaskListsByTitle_();
    Object.keys(listsByTitle).forEach(listTitle => {
      if (EXCLUDED_LISTS.includes(listTitle)) return;
      const taskListId = listsByTitle[listTitle];

      let pageToken;
      do {
        const resp = Tasks.Tasks.list(taskListId, {
          showCompleted: true,
          showHidden: true,
          maxResults: 100,
          pageToken
        });
        (resp.items || []).forEach(task => {
          // Category column mirrors the list the task is CURRENTLY in — routing has
          // already run by this point in pollAll(), so an inbox leftover correctly shows
          // blank (needs review) rather than a stale guess.
          const category = (listTitle === INBOX_LIST_NAME) ? '' : listTitle;

          let displayDue = task.due || '';
          if (isFarFutureMarker_(task.due)) {
            displayDue = ''; // hide the placeholder date in the Sheet
            try {
              Tasks.Tasks.patch({ due: null }, taskListId, task.id);
            } catch (err) {
              Logger.log(`Could not clear far-future marker due date on task ${task.id}: ${err}`);
            }
          }

          const rowValues = [
            task.id, task.title || '', task.notes || '', category,
            task.status, displayDue, task.updated || '', taskListId
          ];
          if (rowById[task.id]) {
            sheet.getRange(rowById[task.id], 1, 1, COLS.length).setValues([rowValues]);
          } else {
            sheet.appendRow(rowValues);
          }
        });
        pageToken = resp.nextPageToken;
      } while (pageToken);
    });
  } finally {
    props.setProperty('SYNCING', 'false');
  }
}

/**
 * Sheet -> Tasks. Fires on any edit to the Tasks_Sync tab. This is now a secondary path —
 * the review page is the intended way to categorize — but ordinary field edits
 * (title/notes/status/due) made directly in the Sheet still push through, and a Category
 * edit here still triggers a real move too, in case you ever do reach for the Sheet.
 */
function onSheetEdit(e) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SYNCING') === 'true') return; // don't echo our own poll writes back

  const sheet = e.range.getSheet();
  if (sheet.getName() !== TAB_NAME) return;
  const row = e.range.getRow();
  if (row === 1) return; // header row

  const idCol = COLS.indexOf('Task_ID') + 1;
  const taskId = sheet.getRange(row, idCol).getValue();
  if (!taskId) return; // brand-new row with no Task_ID yet — the next poll brings it in

  const values = sheet.getRange(row, 1, 1, COLS.length).getValues()[0];
  const [, title, notes, category, status, due, , listId] = values;

  try {
    const listsByTitle = listTaskListsByTitle_();
    const currentListTitle = Object.keys(listsByTitle).find(t => listsByTitle[t] === listId);
    const desiredCategory = (category || '').trim();
    const desiredListTitle = desiredCategory || INBOX_LIST_NAME;

    if (desiredListTitle !== currentListTitle) {
      const destId = getOrCreateListId_(desiredListTitle);
      Tasks.Tasks.move(listId, taskId, { destinationTasklist: destId });
      Logger.log(`Manual move: task ${taskId} "${currentListTitle}" -> "${desiredListTitle}"`);

      props.setProperty('SYNCING', 'true'); // guard the sheet write below from re-triggering onEdit
      sheet.getRange(row, COLS.indexOf('List_ID') + 1).setValue(destId);
      props.setProperty('SYNCING', 'false');
    }
  } catch (err) {
    Logger.log(`Manual category-move failed for row ${row} (task ${taskId}): ${err}`);
  }

  let newNotes = (notes || '').replace(CATEGORY_TAG_RE, '').trim();

  try {
    Tasks.Tasks.patch(
      {
        title: title,
        notes: newNotes,
        status: status === 'completed' ? 'completed' : 'needsAction',
        due: due || null
      },
      listId,
      taskId
    );
  } catch (err) {
    Logger.log(`Push to Tasks failed for row ${row} (task ${taskId}): ${err}`);
  }
}

/**
 * Email -> Task. Runs every 5 min via trigger; also callable manually to test.
 */
function processEmailToTasks() {
  ensureEmailLabels_();
  const inboxLabel = GmailApp.getUserLabelByName(EMAIL_LABEL_INBOX);
  const doneLabel = GmailApp.getUserLabelByName(EMAIL_LABEL_DONE);
  const taskListId = getInboxListId_();

  const threads = inboxLabel.getThreads(0, 50);
  threads.forEach(thread => {
    try {
      const msg = thread.getMessages()[0];
      const rawSubject = msg.getSubject() || '';
      const title = rawSubject.replace(EMAIL_SUBJECT_STRIP_RE, '').trim() || '(untitled task)';
      const notes = (msg.getPlainBody() || '').trim();

      Tasks.Tasks.insert({ title, notes }, taskListId);

      thread.removeLabel(inboxLabel).addLabel(doneLabel);
    } catch (err) {
      Logger.log(`Failed to convert thread "${thread.getFirstMessageSubject()}" to a task: ${err}`);
    }
  });

  if (threads.length) pollAll();
}

/** One-time backfill of everything already in every synced list. Run once after setup(). */
function initialFullSync() {
  pollAll();
}

/** Manual helper: add a brand-new task straight from Apps Script (used by the brain-dump
 *  path). Pass a category to target a specific list directly (created if needed). */
function createTask(title, notes, category) {
  const taskListId = category ? getOrCreateListId_(category) : getInboxListId_();
  const created = Tasks.Tasks.insert({ title, notes: notes || '' }, taskListId);
  pollAll();
  return created;
}

// ===================================================================================
// REVIEW PAGE — one-tap categorization + the learning loop
// ===================================================================================

/** Very small stopword list so the auto-suggested keyword isn't something useless like
 *  "the" or "to". Not linguistically rigorous — just good enough to pick a decent word. */
const STOPWORDS_ = new Set(['the','a','an','to','for','of','and','or','in','on','at','my','is',
  'it','with','from','need','get','buy','pick','up','please','remind','me','about']);

/** Suggests a single keyword from a task's title for the review page to pre-fill —
 *  picks the longest non-stopword word, which is usually the most distinctive one
 *  (e.g. "propane" out of "grab propane for the cabin"). Brett can edit it before saving. */
function suggestKeyword_(title) {
  const words = (title || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, '').split(/\s+/).filter(Boolean);
  const candidates = words.filter(w => w.length > 2 && !STOPWORDS_.has(w));
  if (!candidates.length) return words[0] || '';
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/** Data the review page needs: uncategorized inbox tasks (with a suggested keyword each)
 *  plus the list of all known Tasks lists (for the dropdown of existing categories). */
function getReviewData_() {
  const inboxId = getInboxListId_();
  const items = [];
  let pageToken;
  do {
    const resp = Tasks.Tasks.list(inboxId, { showCompleted: false, maxResults: 100, pageToken });
    (resp.items || []).forEach(task => {
      const { category } = resolveCategory_(task.title, task.notes);
      if (category) return; // would have been routed already by the next poll — don't show it
      items.push({
        id: task.id,
        title: task.title || '(untitled)',
        notes: task.notes || '',
        suggestedKeyword: suggestKeyword_(task.title)
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  const knownLists = Object.keys(listTaskListsByTitle_()).filter(
    t => t !== INBOX_LIST_NAME && !EXCLUDED_LISTS.includes(t)
  );

  return { items, knownLists };
}

/** Called from the review page when Brett taps a category for a task. Moves the task,
 *  creates the list if it's new, and saves the keyword as a permanent learned rule. */
function assignCategory(taskId, category, keyword) {
  const inboxId = getInboxListId_();
  const cat = (category || '').trim();
  if (!cat) throw new Error('No category given.');

  const destId = getOrCreateListId_(cat);
  Tasks.Tasks.move(inboxId, taskId, { destinationTasklist: destId });

  const kw = (keyword || '').trim();
  if (kw) addLearnedRule_(kw, cat);

  syncTasksToSheet();
  return { ok: true };
}

/** Serves the review page. Deploy via Deploy -> New deployment -> Web app (see file
 *  header). Execute as: Me, so it always has your Tasks access regardless of who opens
 *  the URL — keep "Who has access" set to Only myself. */
function doGet() {
  const data = getReviewData_();
  const template = HtmlService.createTemplate(REVIEW_PAGE_HTML_);
  template.data = JSON.stringify(data);
  return template.evaluate()
    .setTitle('Categorize Tasks')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const REVIEW_PAGE_HTML_ = `
<!DOCTYPE html>
<html>
<head>
<base target="_top">
<style>
  body { font-family: -apple-system, Roboto, Arial, sans-serif; margin: 0; padding: 16px;
         background: #f5f5f5; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
  .card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .title { font-weight: 600; font-size: 16px; margin-bottom: 8px; }
  .notes { color: #666; font-size: 13px; margin-bottom: 10px; white-space: pre-wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .chip { background: #eef0ff; border: 1px solid #ccd; border-radius: 20px; padding: 8px 14px;
          font-size: 14px; cursor: pointer; }
  .chip:active { background: #dde0ff; }
  .newrow { display: flex; gap: 8px; margin-bottom: 8px; }
  input[type=text] { flex: 1; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px;
                      font-size: 14px; }
  .kwrow { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #555;
           margin-bottom: 10px; }
  .kwrow input { flex: 1; padding: 6px 8px; border: 1px solid #ddd; border-radius: 6px;
                 font-size: 13px; }
  button.go { background: #4a5cff; color: #fff; border: none; border-radius: 6px;
              padding: 8px 14px; font-size: 14px; }
  .empty { text-align: center; color: #888; margin-top: 40px; }
  .done { opacity: 0.4; pointer-events: none; }
</style>
</head>
<body>
  <h1>Categorize Tasks</h1>
  <div class="sub" id="count"></div>
  <div id="list"></div>
  <div class="empty" id="empty" style="display:none">All caught up — nothing needs review.</div>

  <script>
    const data = JSON.parse(<?= data ?>);
    const listEl = document.getElementById('list');
    const countEl = document.getElementById('count');
    const emptyEl = document.getElementById('empty');

    function render() {
      listEl.innerHTML = '';
      if (!data.items.length) {
        emptyEl.style.display = 'block';
        countEl.textContent = '';
        return;
      }
      countEl.textContent = data.items.length + ' item(s) need a category';
      data.items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';
        card.id = 'card-' + item.id;

        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = item.title;
        card.appendChild(title);

        if (item.notes) {
          const notes = document.createElement('div');
          notes.className = 'notes';
          notes.textContent = item.notes;
          card.appendChild(notes);
        }

        const kwRow = document.createElement('div');
        kwRow.className = 'kwrow';
        kwRow.innerHTML = 'Remember by: <input type="text" value="' +
          (item.suggestedKeyword || '').replace(/"/g, '&quot;') + '" id="kw-' + item.id + '">';
        card.appendChild(kwRow);

        const chips = document.createElement('div');
        chips.className = 'chips';
        data.knownLists.forEach(listName => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = listName;
          chip.onclick = () => assign(item.id, listName);
          chips.appendChild(chip);
        });
        card.appendChild(chips);

        const newRow = document.createElement('div');
        newRow.className = 'newrow';
        newRow.innerHTML = '<input type="text" placeholder="New list name" id="new-' + item.id + '">';
        const goBtn = document.createElement('button');
        goBtn.className = 'go';
        goBtn.textContent = 'Create + Move';
        goBtn.onclick = () => {
          const val = document.getElementById('new-' + item.id).value.trim();
          if (val) assign(item.id, val);
        };
        newRow.appendChild(goBtn);
        card.appendChild(newRow);

        listEl.appendChild(card);
      });
    }

    function assign(taskId, category) {
      const card = document.getElementById('card-' + taskId);
      card.classList.add('done');
      const kw = document.getElementById('kw-' + taskId).value;
      google.script.run
        .withSuccessHandler(() => {
          data.items = data.items.filter(i => i.id !== taskId);
          if (!data.knownLists.includes(category)) data.knownLists.push(category);
          render();
        })
        .withFailureHandler(err => {
          card.classList.remove('done');
          alert('Failed: ' + err.message);
        })
        .assignCategory(taskId, category, kw);
    }

    render();
  </script>
</body>
</html>
`;
