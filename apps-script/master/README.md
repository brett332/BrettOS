# Brett Master Automation (Google Apps Script)

One Apps Script project for scheduled/automated jobs (no paid Cloudflare cron needed).
Runs as brett@bmoremanagement.com. Script ID: `134ZlNp9qKHK0KFYv4YnKHAtoJtcePLJEc8s0rDRxzmUujGwYwAgW7IL4`.
One-minute trigger (`masterTick`) + on-edit trigger (`onEditTick`).

- `Code.gs` (Main) - module registry (`MODULES`), tick/edit handlers, `installTriggers()`
- `BarrelEntry.gs` - applies the Barrel Tools `Entry` tab (and the Waynesboro `Sales` sheet) to StockShift Inventory/History
- `Waynesboro.gs` - `setupWaynesboro()` created the mother's sales sheet; keeps its stock list fresh

Add a new automation: new file with a function, add it to `MODULES` in Code.gs, re-run `installTriggers()` only if a new sheet needs an on-edit trigger.

The live copy in Apps Script is the source of truth until a CI deploy is wired (same service-account pattern as tasks-sync).
The full source is in the Apps Script project; this README records where it lives.
