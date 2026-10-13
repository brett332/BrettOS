# Brett Master Automation (Google Apps Script)

One Apps Script project for scheduled/automated jobs (no paid Cloudflare cron needed).
Runs as brett@bmoremanagement.com. Script ID: `134ZlNp9qKHK0KFYv4YnKHAtoJtcePLJEc8s0rDRxzmUujGwYwAgW7IL4`.
One-minute trigger (`masterTick`) + on-edit trigger (`onEditTick`).

## Files
- `Code.gs` (Main) - module registry (`MODULES`), tick/edit handlers, `installTriggers()`
- `BarrelEntry.gs` - applies the Barrel Tools `Entry` tab, the `Waynesboro_Sales` tab (web page) and, if configured, the old Waynesboro Google Sheet to StockShift Inventory/History
- `Waynesboro.gs` - `setupWaynesboro()` created the old Google Sheet version for Brett's mother (retired; kept for reference)
- `WaynesboroApp.gs` - web page backend: `doGet`, `wbGetState`, `wbRecordSale`, `wbUndoSale`, `setupWaynesboroWeb()`
- `Index.html` - the mobile page (big product tiles, quantity stepper, price box, Record button, recent sales with two-tap Undo)

## Waynesboro sales web page
- Executes as Brett, access: Anyone with the link. A 4-digit PIN (Barrel Tools `Config` tab, key `WaynesboroPin`) is checked on EVERY call, so the link alone does nothing.
- Each sale appends a row to the `Waynesboro_Sales` tab of the Barrel Tools sheet and is applied to Inventory/History immediately (same verified processor as the Entry tab; never goes below zero).
- Undo appends a `Received` row and marks the original row `Undone = yes`.
- Shows only products with stock at the Waynesboro location. Price shown = `Waynesboro Price` column in the `Catalog` tab if set, otherwise `Cabin Shop Price`. Change prices by editing that column; no code change or redeploy needed.
- `Waynesboro_Sales` columns: Action | Product | Qty | Price | Note | Status | Result | Processed At | Time | Undone
- Config keys: `WaynesboroPin`, `WaynesboroLocationId` (loc_waynesboro_va), `WaynesboroEntrySheetId` (blank = old sheet retired), `WaynesboroOldSheetId`.

## Deploying code changes (important)
Apps Script web app deployments are version-pinned. Saving code does NOT change the live page.
Deploy > Manage deployments > pencil on the web app deployment > Version: New version > Deploy. The URL stays the same.
Keep only ONE web app deployment active; archive extras (Manage deployments > select > archive icon).

Add a new automation: new file with a function, add it to `MODULES` in Code.gs, re-run `installTriggers()` only if a new sheet needs an on-edit trigger.

The live copy in Apps Script is the source of truth until a CI deploy is wired (same service-account pattern as tasks-sync). These files are kept in sync with it by hand.
