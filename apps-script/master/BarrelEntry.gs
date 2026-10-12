// BarrelCo entry-sheet processor.
//
// Brett (Entry tab) and his mother (Waynesboro Sales sheet) type manual stock
// changes; this applies each new row to StockShift's Inventory + History tabs
// and writes the outcome into the row's Status / Result / Processed At cells.
//
//   Status blank       -> new, will be processed
//   Status PROCESSING  -> claimed (never re-applied; flagged CHECK if stuck >10 min)
//   Status OK          -> applied
//   Status ERROR: ...  -> rejected BEFORE anything was written (safe to fix and re-enter)
//   Status CHECK: ...  -> something may be half-applied - look at Inventory/History
//
// Columns are found by HEADER NAME so both sheets share this code:
//   Action | Location | Product | Qty | To Location | Price | Note | Status | Result | Processed At
// Status, Result, Processed At must be adjacent, in that order.
// Counts never go below zero. Every problem lands in the row Status and the Debug tab.

var BARREL = {
  SHEET_ID: '1VVsavQV5tdk14BrtqDU1EvCg9R6-SlrJetRqNpC6z6s',
  VENTURE: 'barrelco',
  STUCK_MS: 10 * 60 * 1000,
  MAX_PER_RUN: 25
};
var ALL_ACTIONS = ['Received', 'Sold', 'Set count', 'Transfer', 'Remove (lost/damaged)'];
var ACTION_ALIASES = {
  'received': 'Received', 'receive': 'Received', 'add': 'Received', 'in': 'Received',
  'sold': 'Sold', 'sale': 'Sold', 'sell': 'Sold',
  'set count': 'Set count', 'set': 'Set count', 'count': 'Set count', 'recount': 'Set count',
  'transfer': 'Transfer', 'move': 'Transfer',
  'remove (lost/damaged)': 'Remove (lost/damaged)', 'remove': 'Remove (lost/damaged)',
  'lost': 'Remove (lost/damaged)', 'damaged': 'Remove (lost/damaged)'
};

function norm_(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }
function cell_(r, i) { return (i >= 0 && r && r[i] !== undefined && r[i] !== null) ? String(r[i]).trim() : ''; }

function readTab_(ss, tab) {
  var sh = ss.getSheetByName(tab);
  if (!sh) return null;
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (!lr || !lc) return [];
  return sh.getRange(1, 1, lr, lc).getDisplayValues();
}

function putCells_(sh, row, col, values) {
  var rng = sh.getRange(row, col, 1, values.length);
  rng.setNumberFormats([values.map(function (v) {
    return typeof v === 'number' ? (v % 1 === 0 ? '0' : '0.00') : '@';
  })]);
  rng.setValues([values]);
}

function appendRow_(ss, tab, values) {
  var sh = ss.getSheetByName(tab);
  if (!sh) throw new Error('tab "' + tab + '" not found');
  putCells_(sh, sh.getLastRow() + 1, 1, values);
}

function logOnce_(ss, app, msg) {
  msg = String(msg).slice(0, 900);
  try { Logger.log('[' + app + '] ' + msg); } catch (_) {}
  try {
    var rows = readTab_(ss, 'Debug') || [];
    var cutoff = Date.now() - 3600 * 1000;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === app && rows[i][1] === msg && Date.parse(rows[i][2]) > cutoff) return;
    }
    appendRow_(ss, 'Debug', [app, msg, new Date().toISOString()]);
  } catch (e) { Logger.log('could not write Debug row: ' + (e && e.message)); }
}

function readConfig_(ss) {
  var rows = readTab_(ss, 'Config');
  var cfg = {};
  if (!rows) return cfg;
  for (var i = 1; i < rows.length; i++) { if (cell_(rows[i], 0)) cfg[cell_(rows[i], 0)] = cell_(rows[i], 1); }
  return cfg;
}

function runBarrelEntry_(ctx) {
  var ss = SpreadsheetApp.openById(BARREL.SHEET_ID);
  var targets = [{ ss: ss, tab: 'Entry', label: 'main', allowed: ALL_ACTIONS, defaults: {} }];
  var cfg = {};
  try {
    cfg = readConfig_(ss);
    if (cfg.WaynesboroEntrySheetId) {
      targets.push({
        ss: SpreadsheetApp.openById(cfg.WaynesboroEntrySheetId), tab: cfg.WaynesboroEntryTab || 'Sales', label: 'waynesboro',
        allowed: ['Sold'], defaults: { action: 'Sold', location: cfg.WaynesboroLocationId || 'loc_waynesboro_va' }
      });
    }
  } catch (e) { logOnce_(ss, 'entry', 'Config / Waynesboro sheet unreadable: ' + e.message); }

  var report = [];
  targets.forEach(function (t) {
    try {
      var r = processEntrySheet_(ss, t);
      report.push(r);
      if (t.label === 'waynesboro' && (r.ok || r.errors || r.checks || (ctx && ctx.minute % 10 === 0))) {
        try { syncWaynesboroStock_(ss, t.ss, cfg); } catch (e) { logOnce_(ss, 'entry', 'Waynesboro stock sync: ' + e.message); }
      }
    } catch (e) {
      report.push({ label: t.label, error: e.message });
      logOnce_(ss, 'entry', 'entry sheet "' + t.label + '" (' + t.tab + ') problem: ' + e.message);
    }
  });
  SpreadsheetApp.flush();
  return report;
}

function processEntrySheet_(main, t) {
  var res = { label: t.label, ok: 0, errors: 0, checks: 0 };
  var sh = t.ss.getSheetByName(t.tab);
  if (!sh) throw new Error('tab "' + t.tab + '" not found');
  var values = readTab_(t.ss, t.tab);
  if (!values.length) return res;

  var header = values[0].map(norm_);
  var col = function (n) { return header.indexOf(norm_(n)); };
  var C = { action: col('Action'), loc: col('Location'), prod: col('Product'), qty: col('Qty'), to: col('To Location'),
    price: col('Price'), note: col('Note'), status: col('Status'), result: col('Result'), at: col('Processed At') };
  var need = [['prod', 'Product'], ['qty', 'Qty'], ['status', 'Status'], ['result', 'Result'], ['at', 'Processed At']];
  if (!t.defaults.action) need.push(['action', 'Action']);
  if (!t.defaults.location) need.push(['loc', 'Location']);
  var missing = need.filter(function (n) { return C[n[0]] < 0; }).map(function (n) { return n[1]; });
  if (missing.length) throw new Error('missing column(s): ' + missing.join(', '));
  if (C.result !== C.status + 1 || C.at !== C.status + 2) throw new Error('Status, Result, Processed At must be adjacent columns in that order');

  var writeStatus = function (i, status, result, at) { putCells_(sh, i + 1, C.status + 1, [status, result, at]); };

  var work = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i] || [];
    var status = cell_(r, C.status);
    if (status) {
      if (status === 'PROCESSING') {
        var since = Date.parse(cell_(r, C.at));
        if (!isFinite(since) || Date.now() - since > BARREL.STUCK_MS) {
          writeStatus(i, 'CHECK: stuck while updating — compare Inventory and History before re-entering', '', new Date().toISOString());
          logOnce_(main, 'entry', t.label + ' row ' + (i + 1) + ' stuck in PROCESSING');
          res.checks++;
        }
      }
      continue;
    }
    if ([C.action, C.loc, C.prod, C.qty].some(function (ci) { return cell_(r, ci) !== ''; })) work.push(i);
  }
  if (!work.length) return res;

  var catalog = readTab_(main, 'Catalog') || [];
  var locations = readTab_(main, 'Locations') || [];
  var cH = (catalog[0] || []).map(norm_), lH = (locations[0] || []).map(norm_);
  var ci = function (n) { return cH.indexOf(norm_(n)); }, li = function (n) { return lH.indexOf(norm_(n)); };
  if ([ci('ProductId'), ci('Code'), ci('Name')].some(function (x) { return x < 0; })) throw new Error('Catalog tab needs ProductId, Code, Name columns');
  if ([li('LocationId'), li('Name')].some(function (x) { return x < 0; })) throw new Error('Locations tab needs LocationId, Name columns');
  var findProd = function (txt) {
    var k = norm_(txt); if (!k) return null;
    for (var j = 1; j < catalog.length; j++) {
      var row = catalog[j];
      if ([cell_(row, ci('ProductId')), cell_(row, ci('Code')), cell_(row, ci('Name'))].some(function (v) { return norm_(v) === k; })) {
        return { id: cell_(row, ci('ProductId')), code: cell_(row, ci('Code')), name: cell_(row, ci('Name')), retail: cell_(row, ci('Cabin Shop Price')) };
      }
    }
    return null;
  };
  var findLoc = function (txt) {
    var k = norm_(txt); if (!k) return null;
    for (var j = 1; j < locations.length; j++) {
      var row = locations[j];
      if (norm_(cell_(row, li('LocationId'))) === k || norm_(cell_(row, li('Name'))) === k) {
        return { id: cell_(row, li('LocationId')), name: cell_(row, li('Name')) };
      }
    }
    return null;
  };

  work.slice(0, BARREL.MAX_PER_RUN).forEach(function (i) {
    var r = values[i] || [];
    var rowNo = i + 1;
    var fail = function (msg) { writeStatus(i, 'ERROR: ' + msg, '', new Date().toISOString()); res.errors++; };

    var actionTxt = cell_(r, C.action) || t.defaults.action || '';
    var action = ACTION_ALIASES[norm_(actionTxt)];
    if (!action) return fail('unknown action "' + actionTxt + '" (use: ' + t.allowed.join(', ') + ')');
    if (t.allowed.indexOf(action) < 0) return fail('"' + action + '" is not allowed on this sheet (use: ' + t.allowed.join(', ') + ')');

    var locTxt = cell_(r, C.loc) || t.defaults.location || '';
    var loc = findLoc(locTxt);
    if (!loc) return fail('unknown location "' + locTxt + '"');
    var prodTxt = cell_(r, C.prod);
    var prod = findProd(prodTxt);
    if (!prod) return fail('unknown product "' + prodTxt + '"');

    var qtyTxt = cell_(r, C.qty).replace(/,/g, '');
    if (!/^\d+$/.test(qtyTxt)) return fail('quantity must be a whole number (got "' + cell_(r, C.qty) + '")');
    var qty = parseInt(qtyTxt, 10);
    if (qty === 0 && action !== 'Set count') return fail('quantity must be at least 1');
    if (qty > 100000) return fail('quantity looks too large');

    var toLoc = null;
    if (action === 'Transfer') {
      var toTxt = cell_(r, C.to);
      toLoc = findLoc(toTxt);
      if (!toLoc) return fail(toTxt ? 'unknown "To Location" "' + toTxt + '"' : 'Transfer needs a "To Location"');
      if (toLoc.id === loc.id) return fail('Transfer To Location is the same as Location');
    }

    var price = null;
    if (action === 'Sold') {
      var pRaw = cell_(r, C.price);
      var p = parseFloat(String(pRaw || prod.retail).replace(/[$,\s]/g, ''));
      if (pRaw && !(isFinite(p) && p >= 0)) return fail('price "' + pRaw + '" is not a number');
      price = (isFinite(p) && p >= 0) ? Math.round(p * 100) / 100 : 0;
    }

    try { writeStatus(i, 'PROCESSING', '', new Date().toISOString()); }
    catch (e) { logOnce_(main, 'entry', t.label + ' row ' + rowNo + ': could not claim row (nothing applied): ' + e.message); return; }

    var wrote = false;
    try {
      var invSh = main.getSheetByName('Inventory');
      var inv = readTab_(main, 'Inventory') || [];
      var find = function (pid, lid) {
        for (var k = 1; k < inv.length; k++) {
          if (inv[k][0] === pid && inv[k][1] === lid && (inv[k][4] || BARREL.VENTURE) === BARREL.VENTURE) return k;
        }
        return -1;
      };
      var countAt = function (pid, lid) { var k = find(pid, lid); return k === -1 ? 0 : (parseInt(inv[k][2], 10) || 0); };
      var cur = countAt(prod.id, loc.id);

      var next, toCur = 0, toNext = 0;
      if (action === 'Received') next = cur + qty;
      else if (action === 'Set count') next = qty;
      else {
        if (qty > cur) {
          writeStatus(i, 'ERROR: only ' + cur + ' of ' + prod.name + ' at ' + loc.name + ", can't take out " + qty + ' — fix the count with "Set count" first', '', new Date().toISOString());
          res.errors++; return;
        }
        next = cur - qty;
        if (action === 'Transfer') { toCur = countAt(prod.id, toLoc.id); toNext = toCur + qty; }
      }

      var ts = new Date().toISOString();
      var setCount = function (lid, count) {
        var k = find(prod.id, lid);
        if (k === -1) { appendRow_(main, 'Inventory', [prod.id, lid, count, ts, BARREL.VENTURE]); inv.push([prod.id, lid, String(count), ts, BARREL.VENTURE]); }
        else { putCells_(invSh, k + 1, 3, [count, ts, BARREL.VENTURE]); inv[k][2] = String(count); }
        wrote = true;
      };
      var noteBase = [cell_(r, C.note), 'entry:' + t.label + ' row ' + rowNo].filter(Boolean).join(' · ');
      var hist = function (type, l, q, newTotal, extra) {
        extra = extra || {};
        appendRow_(main, 'History', [
          'h' + Date.now() + Math.floor(Math.random() * 1000), ts, type, prod.id, prod.code, l.id, prod.code, l.name,
          q, newTotal, extra.salePrice || 0, extra.revenue || 0, extra.note || noteBase, BARREL.VENTURE]);
      };

      var result;
      if (action === 'Received') { setCount(loc.id, next); hist('add', loc, qty, next); result = loc.name + ': ' + cur + ' → ' + next; }
      else if (action === 'Set count') { setCount(loc.id, next); hist('edit', loc, qty, next); result = loc.name + ': ' + cur + ' → ' + next + ' (set)'; }
      else if (action === 'Sold') {
        setCount(loc.id, next);
        hist('sold', loc, qty, next, { salePrice: price, revenue: Math.round(price * qty * 100) / 100 });
        result = loc.name + ': ' + cur + ' → ' + next + (price ? ' · $' + (price * qty).toFixed(2) : ' · no price recorded');
      } else if (action === 'Remove (lost/damaged)') { setCount(loc.id, next); hist('adjust', loc, qty, next); result = loc.name + ': ' + cur + ' → ' + next + ' (removed)'; }
      else {
        setCount(loc.id, next);
        setCount(toLoc.id, toNext);
        hist('transfer', loc, qty, next, { note: noteBase + ' · transfer to ' + toLoc.name });
        hist('transfer', toLoc, qty, toNext, { note: noteBase + ' · transfer from ' + loc.name });
        result = loc.name + ': ' + cur + ' → ' + next + '; ' + toLoc.name + ': ' + toCur + ' → ' + toNext;
      }

      SpreadsheetApp.flush();
      var after = readTab_(main, 'Inventory') || [];
      var got = function (lid) {
        for (var k = 1; k < after.length; k++) {
          if (after[k][0] === prod.id && after[k][1] === lid && (after[k][4] || BARREL.VENTURE) === BARREL.VENTURE) return parseInt(after[k][2], 10);
        }
        return NaN;
      };
      var bad = [];
      if (got(loc.id) !== next) bad.push(loc.name + ' shows ' + got(loc.id) + ', expected ' + next);
      if (toLoc && got(toLoc.id) !== toNext) bad.push(toLoc.name + ' shows ' + got(toLoc.id) + ', expected ' + toNext);

      var finish = function (st) {
        try { writeStatus(i, st, result, ts); return true; }
        catch (e) { logOnce_(main, 'entry', t.label + ' row ' + rowNo + ': applied but could not write status "' + st + '": ' + e.message); return false; }
      };
      if (bad.length) {
        logOnce_(main, 'entry', t.label + ' row ' + rowNo + ': count did not verify: ' + bad.join('; '));
        finish('CHECK: count did not verify — ' + bad.join('; '));
        res.checks++; return;
      }
      if (finish('OK')) res.ok++; else res.checks++;
    } catch (e) {
      var st = (wrote ? 'CHECK: partly applied — ' : 'ERROR: ') + String(e.message).slice(0, 200);
      logOnce_(main, 'entry', t.label + ' row ' + rowNo + ': ' + st);
      try { writeStatus(i, st, '', new Date().toISOString()); } catch (_) { }
      if (wrote) res.checks++; else res.errors++;
    }
  });
  return res;
}
