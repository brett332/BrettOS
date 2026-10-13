// ─────────────────────────────────────────────────────────────────────────────
// Waynesboro sales web page (for Brett's mother). Deployed as a Web App
// (execute as Brett, anyone with the link + PIN). Reuses the verified entry
// processor: every sale is a row in the Waynesboro_Sales tab of the Barrel Tools
// sheet, applied to Inventory/History immediately.
//   Waynesboro_Sales columns: Action | Product | Qty | Price | Note | Status | Result | Processed At | Time | Undone
// ─────────────────────────────────────────────────────────────────────────────

var WB = {
  TAB: 'Waynesboro_Sales',
  HEADERS: ['Action', 'Product', 'Qty', 'Price', 'Note', 'Status', 'Result', 'Processed At', 'Time', 'Undone'],
  DEFAULT_LOC: 'loc_waynesboro_va'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Waynesboro Sales')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---- helpers ---------------------------------------------------------------
function wbMain_() { return SpreadsheetApp.openById(BARREL.SHEET_ID); }

function wbCheckPin_(main, pin) {
  var cfg = readConfig_(main);
  if (!cfg.WaynesboroPin || String(pin || '').trim() !== cfg.WaynesboroPin) throw new Error('WRONG_PIN');
  return cfg;
}

function wbTarget_(main, cfg) {
  return { ss: main, tab: WB.TAB, label: 'waynesboro-web', allowed: ['Sold', 'Received'],
    defaults: { location: cfg.WaynesboroLocationId || WB.DEFAULT_LOC } };
}

function wbMoney_(s) { var n = parseFloat(String(s || '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }

// Products with stock at Waynesboro, plus the last sales.
function wbState_(main, cfg) {
  var locId = cfg.WaynesboroLocationId || WB.DEFAULT_LOC;
  var cat = readTab_(main, 'Catalog') || [];
  var inv = readTab_(main, 'Inventory') || [];
  var H = (cat[0] || []).map(norm_);
  var iId = H.indexOf('productid'), iN = H.indexOf('name'), iA = H.indexOf('active'), iP = H.indexOf('cabin shop price'), iW = H.indexOf('waynesboro price');
  var products = [];
  for (var i = 1; i < cat.length; i++) {
    var row = cat[i];
    if (!cell_(row, iN)) continue;
    if (iA >= 0 && norm_(cell_(row, iA)) === 'no') continue;
    var pid = cell_(row, iId), n = 0;
    for (var k = 1; k < inv.length; k++) {
      if (inv[k][0] === pid && inv[k][1] === locId && (inv[k][4] || BARREL.VENTURE) === BARREL.VENTURE) { n = parseInt(inv[k][2], 10) || 0; break; }
    }
    if (n > 0) products.push({ id: pid, name: cell_(row, iN), onHand: n, price: wbMoney_(cell_(row, iW)) || wbMoney_(cell_(row, iP)) });   // Waynesboro price wins, else standard
  }
  var recent = [];
  var log = readTab_(main, WB.TAB) || [];
  if (log.length > 1) {
    var h = log[0].map(norm_), c = function (x) { return h.indexOf(norm_(x)); };
    for (var r = log.length - 1; r >= 1 && recent.length < 12; r--) {
      var L = log[r];
      if (cell_(L, c('Action')) !== 'Sold' || cell_(L, c('Status')) !== 'OK') continue;   // failed attempts never show up as sales
      recent.push({ row: r + 1, product: cell_(L, c('Product')), qty: parseInt(cell_(L, c('Qty')), 10) || 0,
        price: wbMoney_(cell_(L, c('Price'))), at: cell_(L, c('Time')),
        status: cell_(L, c('Status')), undone: cell_(L, c('Undone')) === 'yes' });
    }
  }
  return { products: products, recent: recent };
}

function wbFriendly_(status) {
  var s = String(status || '');
  var m = s.match(/only (\d+) of (.+?) at /);
  if (/^ERROR: only/.test(s) && m) return 'There are only ' + m[1] + ' ' + m[2] + ' on the shelf, so that sale was not saved. Please check the number.';
  if (/^ERROR/.test(s)) return 'That sale was not saved (' + s.replace(/^ERROR:\s*/, '') + '). Nothing changed. Please tell Brett.';
  if (/^CHECK/.test(s)) return 'That sale may not have saved correctly. Please tell Brett before trying again.';
  return 'Something did not finish. Please tell Brett before trying again.';
}

// ---- called from the page --------------------------------------------------
function wbGetState(pin) {
  var main = wbMain_();
  var cfg = wbCheckPin_(main, pin);
  return wbState_(main, cfg);
}

function wbRecordSale(pin, productId, qty, price) {
  var main = wbMain_();
  var cfg = wbCheckPin_(main, pin);
  qty = parseInt(qty, 10);
  price = Number(price);
  if (!(qty >= 1 && qty <= 999)) throw new Error('Please enter how many were sold.');
  if (!(price >= 0 && price < 100000)) throw new Error('Please enter the price.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The system is busy. Nothing was saved. Please try again in a minute.');
  try {
    var state = wbState_(main, cfg);
    var p = state.products.filter(function (x) { return x.id === productId; })[0];
    if (!p) throw new Error('That item is not on the shelf list.');
    appendRow_(main, WB.TAB, ['Sold', p.name, qty, price, 'web page', '', '', '', new Date().toISOString(), '']);
    var rowNo = main.getSheetByName(WB.TAB).getLastRow();
    processEntrySheet_(main, wbTarget_(main, cfg));
    SpreadsheetApp.flush();
    var done = readTab_(main, WB.TAB)[rowNo - 1];
    var status = cell_(done, 5);
    if (status !== 'OK') return { ok: false, message: wbFriendly_(status), state: wbState_(main, cfg) };
    var after = wbState_(main, cfg);
    var left = after.products.filter(function (x) { return x.id === productId; })[0];
    return { ok: true, message: 'Saved: ' + qty + ' × ' + p.name + ' for $' + (qty * price).toFixed(2) + '.',
      left: left ? left.onHand : 0, name: p.name, state: after };
  } finally { lock.releaseLock(); }
}

function wbUndoSale(pin, rowNo) {
  var main = wbMain_();
  var cfg = wbCheckPin_(main, pin);
  rowNo = parseInt(rowNo, 10);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The system is busy. Nothing was changed. Please try again in a minute.');
  try {
    var log = readTab_(main, WB.TAB) || [];
    var h = log[0].map(norm_), c = function (x) { return h.indexOf(norm_(x)); };
    var L = log[rowNo - 1];
    if (!L || cell_(L, c('Action')) !== 'Sold' || cell_(L, c('Status')) !== 'OK') throw new Error('That sale cannot be undone.');
    if (cell_(L, c('Undone')) === 'yes') throw new Error('That sale was already undone.');
    var sh = main.getSheetByName(WB.TAB);
    putCells_(sh, rowNo, c('Undone') + 1, ['working']);          // claim so it can never be undone twice
    appendRow_(main, WB.TAB, ['Received', cell_(L, c('Product')), parseInt(cell_(L, c('Qty')), 10), '', 'undo of row ' + rowNo, '', '', '', new Date().toISOString(), '']);
    var newRow = sh.getLastRow();
    processEntrySheet_(main, wbTarget_(main, cfg));
    SpreadsheetApp.flush();
    var status = cell_(readTab_(main, WB.TAB)[newRow - 1], 5);
    if (status !== 'OK') { putCells_(sh, rowNo, c('Undone') + 1, ['']); return { ok: false, message: wbFriendly_(status), state: wbState_(main, cfg) }; }
    putCells_(sh, rowNo, c('Undone') + 1, ['yes']);
    return { ok: true, message: 'Undone. The item is back on the shelf count.', state: wbState_(main, cfg) };
  } finally { lock.releaseLock(); }
}

// ---- one-time setup (run from the editor) ----------------------------------
function setupWaynesboroWeb() {
  var main = wbMain_();
  var sh = main.getSheetByName(WB.TAB);
  if (!sh) {
    sh = main.insertSheet(WB.TAB);
    sh.getRange(1, 1, 1, WB.HEADERS.length).setValues([WB.HEADERS]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
    sh.getRange('A2:J2000').setNumberFormat('@');
    sh.getRange('C2:D2000').setNumberFormat('General');
  }
  var cs = main.getSheetByName('Config');
  var rows = cs.getDataRange().getValues();
  var idx = {};
  for (var i = 1; i < rows.length; i++) idx[rows[i][0]] = i + 1;
  var oldId = idx.WaynesboroEntrySheetId ? String(rows[idx.WaynesboroEntrySheetId - 1][1] || '') : '';
  if (!idx.WaynesboroPin) cs.appendRow(['WaynesboroPin', String(Math.floor(1000 + Math.random() * 9000)), 'PIN for the Waynesboro sales web page']);
  if (oldId) {
    if (!idx.WaynesboroOldSheetId) cs.appendRow(['WaynesboroOldSheetId', oldId, 'Retired Google Sheet version of the Waynesboro log']);
    cs.getRange(idx.WaynesboroEntrySheetId, 2).setValue('');
    try {
      var f = DriveApp.getFileById(oldId);
      f.removeEditor(WAYNESBORO_EDITOR);
      f.setName('Waynesboro Sales Log (retired - use the web page)');
    } catch (e) { logMaster_('retire old Waynesboro sheet: ' + e.message); }
  }
  installTriggers();
  Logger.log('Waynesboro web tab ready. Now Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).');
}
