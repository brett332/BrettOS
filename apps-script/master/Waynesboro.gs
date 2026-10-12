// Waynesboro sales sheet (for Brett's mother): creates it, keeps its product list
// and "on hand" counts fresh, and shares it. Processing itself is in BarrelEntry.gs.

var WAYNESBORO_EDITOR = 'laprades@hotmail.com';

// Run ONCE. Creates the sheet (owned by Brett), wires it into Config, shares it with
// his mother and re-installs triggers. Safe to re-run: does nothing if already set up.
function setupWaynesboro() {
  var ss = SpreadsheetApp.openById(BARREL.SHEET_ID);
  var cfg = readConfig_(ss);
  if (cfg.WaynesboroEntrySheetId) { Logger.log('Already set up: ' + cfg.WaynesboroEntrySheetId); return cfg.WaynesboroEntrySheetId; }

  var wb = SpreadsheetApp.create('Waynesboro Sales Log');
  var sales = wb.getSheets()[0];
  sales.setName('Sales');
  var headers = ['Product', 'Qty', 'Price', 'Note', 'Status', 'Result', 'Processed At'];
  sales.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaed');
  sales.setFrozenRows(1);
  sales.getRange('A2:G1000').setNumberFormat('@');
  sales.getRange('B2:C1000').setNumberFormat('General');
  sales.setColumnWidths(1, 1, 260); sales.setColumnWidths(2, 1, 60); sales.setColumnWidths(3, 1, 80);
  sales.setColumnWidths(4, 1, 220); sales.setColumnWidths(5, 1, 110); sales.setColumnWidths(6, 1, 280); sales.setColumnWidths(7, 1, 180);

  var stock = wb.insertSheet('Stock here');
  stock.getRange(1, 1, 1, 2).setValues([['Product', 'On hand at Waynesboro']]).setFontWeight('bold').setBackground('#e8eaed');
  stock.setFrozenRows(1); stock.setColumnWidths(1, 1, 260); stock.setColumnWidths(2, 1, 170);

  sales.getRange('A2:A1000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(stock.getRange('A2:A60'), true).setAllowInvalid(false).setHelpText('Pick the product from the list').build());
  sales.getRange('B2:B1000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(1).setAllowInvalid(false).setHelpText('How many were sold (whole number)').build());
  sales.getRange('C2:C1000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).setHelpText('Price for ONE item. Leave blank to use the standard shop price.').build());

  var st = sales.getRange('E2:E1000');
  sales.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OK').setBackground('#b7e1cd').setRanges([st]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('ERROR').setBackground('#f4c7c3').setRanges([st]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('CHECK').setBackground('#fce8b2').setRanges([st]).build()
  ]);
  sales.getRange('E2:G1000').protect().setDescription('Filled in automatically').setWarningOnly(true);

  sales.getRange('I1').setValue('HOW TO USE').setFontWeight('bold');
  sales.getRange('I2:I7').setValues([
    ['1. Each time something sells, add ONE row below.'],
    ['2. Pick the Product, type the Qty. Price is optional (blank = standard price).'],
    ['3. In about a minute, Status turns OK (green) and the stock count goes down.'],
    ['4. A red ERROR means nothing was changed. Read the message, fix or delete the row.'],
    ['5. Please do not edit the Status / Result / Processed At columns.'],
    ['6. "Stock here" tab shows what should be on the shelf.']
  ]);
  sales.setColumnWidths(9, 1, 480);

  var cs = ss.getSheetByName('Config');
  var rows = cs.getDataRange().getValues();
  var found = false;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === 'WaynesboroEntrySheetId') { cs.getRange(i + 1, 2).setValue(wb.getId()); found = true; }
  }
  if (!found) cs.appendRow(['WaynesboroEntrySheetId', wb.getId(), 'Sales sheet for Waynesboro (set by script)']);

  syncWaynesboroStock_(ss, wb, readConfig_(ss));
  try { DriveApp.getFileById(wb.getId()).addEditor(WAYNESBORO_EDITOR); }
  catch (e) { logMaster_('Could not share Waynesboro sheet with ' + WAYNESBORO_EDITOR + ': ' + e.message); }
  installTriggers();
  Logger.log('Waynesboro sheet: ' + wb.getUrl());
  return wb.getId();
}

// Refresh the product list and on-hand counts in the Waynesboro sheet.
function syncWaynesboroStock_(main, wb, cfg) {
  var locId = (cfg && cfg.WaynesboroLocationId) || 'loc_waynesboro_va';
  var stock = wb.getSheetByName('Stock here');
  if (!stock) return;
  var cat = readTab_(main, 'Catalog') || [];
  var inv = readTab_(main, 'Inventory') || [];
  if (!cat.length) return;
  var H = cat[0].map(norm_);
  var iN = H.indexOf('name'), iId = H.indexOf('productid'), iA = H.indexOf('active');
  var out = [];
  for (var i = 1; i < cat.length; i++) {
    var row = cat[i];
    if (!cell_(row, iN)) continue;
    if (iA >= 0 && norm_(cell_(row, iA)) === 'no') continue;
    var pid = cell_(row, iId), n = 0;
    for (var k = 1; k < inv.length; k++) { if (inv[k][0] === pid && inv[k][1] === locId) { n = parseInt(inv[k][2], 10) || 0; break; } }
    out.push([cell_(row, iN), n]);
  }
  var last = stock.getLastRow();
  if (last > 1) stock.getRange(2, 1, last - 1, 2).clearContent();
  if (out.length) stock.getRange(2, 1, out.length, 2).setValues(out);
}
