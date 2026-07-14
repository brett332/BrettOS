/**
 * BrettOS Worker — Phase 1 + Phase 2
 * Worker name: brett-os.brett-2f8.workers.dev
 *
 * ENV VARS (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   WORKER_SECRET         = brett-os-secret-2026-brett
 *   SHEET_ID              = 1X2oYjDfnGzJWDI84e1t4p7cbt9iWxq5qbPmNFI9auuA
 *   SERVICE_ACCOUNT_EMAIL = brett-os-sheets@brettos-502323.iam.gserviceaccount.com
 *   SERVICE_ACCOUNT_KEY   = <full JSON from brettos-502323 service account>
 *   ANTHROPIC_API_KEY     = <your Anthropic key>
 *
 *
 * ENDPOINTS (Phase 1):
 *   POST /capture       — save a single WBM or Task
 *   GET  /tasks         — list tasks (with optional filters)
 *   GET  /wbm           — list WBM entries
 *   GET  /patterns      — list active patterns
 *   POST /devlog        — add a dev log entry
 *   GET  /devlog        — list dev log entries
 *
 * ENDPOINTS (Phase 2 — NEW):
 *   POST /batch         — single AI call to tag/classify N pasted items
 *   POST /batchSave     — bulk-write accepted items to WBM/Tasks + log to AI_Log
 *   POST /wbm/update    — edit an existing WBM entry's text/venture/location/status
 *   POST /wbm/convert   — convert a WBM entry into a Task (sets priority/context/etc)
 *
 * ENDPOINTS (Phase 3 — NEW):
 *   GET  /ventures      — list ventures (now data-driven, not hardcoded)
 *   POST /ventures      — add a new venture
 *   GET  /projects      — list all projects
 *   POST /projects      — create a project (multi-venture)
 *   POST /tasks/update  — edit any task field, incl. multi-venture / multi-project
 *
 * ENDPOINTS (Phase 4 — NEW):
 *   POST /patterns          — manual pattern entry (auto-confirmed)
 *   POST /patterns/update   — confirm / reject / apply-to-project (fields patch)
 *   POST /devlog/update     — edit a Dev Log entry
 *   POST /devlog/convert    — convert a Dev Log entry into a Task or Project
 *   POST /batch    (updated)— patterns_detected now includes item_indices for evidence linking
 *   POST /batchSave(updated)— accepts `patterns` array, resolves evidence to real IDs, writes
 *                             suggested patterns to the Patterns tab; WBM rows now also write
 *                             their own Project_ID (column M — tag, not "spawned from")
 *
 * SCHEMA NOTE: WBM tab needs a 13th column "Project_ID" (col M).
 *              Dev_Log tab needs a 6th column "Spawned_ID" (col F).
 *              Projects tab needs a 12th column "Due_Date" (col L) and 13th "Depends_On" (col M).
 *              Tasks tab needs a 20th column "Depends_On" (col T).
 *
 * ENDPOINTS (Phase 5 — NEW):
 *   POST /projects/update — full project edit incl. venture, due_date, depends_on
 *   (Task/WBM/DevLog create+convert paths now also accept due_date and depends_on)
 *
 * ENDPOINTS (Phase 6 — NEW — cross-hub entity linking):
 *   GET  /entities/search?q=  — alias/name search across properties, contacts, BarrelCo listings
 *   POST /entities/sync       — pulls Maintenance Hub + BarrelCo entity feeds, rebuilds index,
 *                                logs every attempt (success or failure) to Integration_Log
 *   GET  /integration-log     — last 50 sync attempts, for a health view in the UI
 *   GET  /contacts            — list contacts
 *   POST /contacts            — add a contact
 *   POST /contacts/update     — edit a contact
 *   scheduled() handler       — Cron Trigger runs /entities/sync automatically (set schedule
 *                                in Cloudflare dashboard → this Worker → Settings → Triggers)
 *
 * NEW ENV VARS NEEDED:
 *   MAINTENANCE_HUB_URL    = https://maintenance-hub.brett-2f8.workers.dev
 *   MAINTENANCE_HUB_SECRET = mh-secret-2026-brett
 *   BARRELCO_URL           = https://barrel-co.brett-2f8.workers.dev
 *
 * SCHEMA NOTE: three new tabs needed —
 *   Entities         : Entity_ID | Entity_Type | Display_Name | Aliases | Source_Hub | Source_ID | Venture | Deep_Link_Hash | Last_Synced
 *   Contacts         : Contact_ID | Name | Aliases | Phone | Email | Relationship_Type | Ventures_Connected | Interests_Skills | Notes | Last_Contact_Date
 *   Integration_Log  : Log_ID | Timestamp | Source_Hub | Status | Detail
 *
 * INTEGRATION CONTRACT: this Worker consumes GET /public/entities-feed from Maintenance Hub
 * and BarrelCo. That endpoint is a deliberate, versioned interface (see each hub's own Worker
 * comments) — internal route changes on those hubs are safe; a breaking change to the FEED
 * SHAPE requires a version bump, which /entities/sync validates and logs on every run.
 *
 * DATA MODEL NOTE: Venture and Project_ID fields on Tasks/WBM/Projects are now
 * comma-separated lists (e.g. "ridge_co, barrel_co") to support many-to-many
 * relationships. Use csvIncludes() for filtering, not exact match.
 */

const SHEET_TABS = {
  tasks:        'Tasks',
  projects:     'Projects',
  wbm:          'WBM',
  patterns:     'Patterns',
  ai_log:       'AI_Log',
  batch_queue:  'Batch_Queue',
  hub_summaries:'Hub_Summaries',
  dev_log:      'Dev_Log',
  ventures:     'Ventures',
  entities:     'Entities',
  contacts:     'Contacts',
  integration_log: 'Integration_Log',
};

// ── CORS HEADERS ─────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

function authed(request, env) {
  return request.headers.get('X-Secret') === env.WORKER_SECRET;
}

// ── ROUTER ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!authed(request, env)) return err('Unauthorized', 401);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (method === 'POST' && path === '/capture')   return handleCapture(request, env);
      if (method === 'GET'  && path === '/tasks')     return handleGetTasks(url, env);
      if (method === 'GET'  && path === '/wbm')       return handleGetWBM(url, env);
      if (method === 'GET'  && path === '/patterns')  return handleGetPatterns(env);
      if (method === 'POST' && path === '/patterns')  return handlePostPattern(request, env);
      if (method === 'POST' && path === '/patterns/update') return handlePatternUpdate(request, env);
      if (method === 'POST' && path === '/devlog')    return handlePostDevLog(request, env);
      if (method === 'GET'  && path === '/devlog')    return handleGetDevLog(env);
      if (method === 'POST' && path === '/devlog/update')  return handleDevLogUpdate(request, env);
      if (method === 'POST' && path === '/devlog/convert') return handleDevLogConvert(request, env);
      if (method === 'POST' && path === '/batch')     return handleBatch(request, env);
      if (method === 'POST' && path === '/batchSave') return handleBatchSave(request, env);
      if (method === 'POST' && path === '/wbm/update')  return handleWBMUpdate(request, env);
      if (method === 'POST' && path === '/wbm/convert') return handleWBMConvert(request, env);
      if (method === 'GET'  && path === '/ventures')    return handleGetVentures(env);
      if (method === 'POST' && path === '/ventures')    return handlePostVenture(request, env);
      if (method === 'GET'  && path === '/projects')    return handleGetProjects(env);
      if (method === 'POST' && path === '/projects')    return handlePostProject(request, env);
      if (method === 'POST' && path === '/projects/update') return handleProjectUpdate(request, env);
      if (method === 'POST' && path === '/tasks/update') return handleTaskUpdate(request, env);
      if (method === 'GET'  && path === '/entities/search') return handleEntitiesSearch(url, env);
      if (method === 'POST' && path === '/entities/sync')   return handleEntitiesSync(env);
      if (method === 'GET'  && path === '/integration-log') return handleGetIntegrationLog(env);
      if (method === 'GET'  && path === '/contacts')        return handleGetContacts(env);
      if (method === 'POST' && path === '/contacts')        return handlePostContact(request, env);
      if (method === 'POST' && path === '/contacts/update') return handleContactUpdate(request, env);
      return err('Not found', 404);
    } catch (e) {
      return err('Server error: ' + e.message, 500);
    }
  },

  // Cloudflare Cron Trigger — configure the schedule in the dashboard
  // (Workers & Pages → brett-os → Settings → Triggers → Cron Triggers).
  // Runs the entity sync automatically; every attempt (success or failure) is
  // logged to Integration_Log regardless of whether anything changed.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      handleEntitiesSync(env).catch(e => console.error('Scheduled entity sync failed:', e))
    );
  }
};

// ── CAPTURE ───────────────────────────────────────────────────────────────────
// POST /capture
// Body: { type: 'wbm'|'task', text, venture, location, context, device, energy, priority, source }

async function handleCapture(request, env) {
  const body = await request.json();
  const { type = 'wbm', text, venture = '', location = '', context = '',
          device = 'any', energy = 'medium', priority = 'medium',
          source = 'web_ui', project_ids = '', due_date = '', depends_on = '' } = body;

  if (!text || !text.trim()) return err('text is required');

  // venture/project_ids/depends_on can arrive as arrays (from chip pickers) or legacy comma strings
  const ventureStr = Array.isArray(venture) ? venture.join(', ') : venture;
  const projectStr = Array.isArray(project_ids) ? project_ids.join(', ') : project_ids;
  const dependsStr = Array.isArray(depends_on) ? depends_on.join(', ') : depends_on;

  const today = new Date().toISOString().split('T')[0];
  const token = await getAccessToken(env);

  if (type === 'wbm') {
    const id = await nextId(env, token, SHEET_TABS.wbm, 'WBM');
    const row = [
      id, text.trim(), today, source, ventureStr,
      location, '', '', '', 'raw', '', '', projectStr
    ];
    await appendRow(env, token, SHEET_TABS.wbm, row);
    return json({ ok: true, id, type: 'wbm' });
  }

  if (type === 'task') {
    const id = await nextId(env, token, SHEET_TABS.tasks, 'BTOS');
    const year = new Date().getFullYear();
    const taskId = `BTOS-${year}-${id.split('-')[1]}`;
    const row = [
      taskId, text.trim(), '', 'backlog', projectStr,
      ventureStr, context, device, location, energy,
      priority, '', source, '', due_date,
      today, '', '', '', dependsStr
    ];
    await appendRow(env, token, SHEET_TABS.tasks, row);
    return json({ ok: true, id: taskId, type: 'task' });
  }

  return err('type must be wbm or task');
}

// ── GET TASKS ─────────────────────────────────────────────────────────────────

async function handleGetTasks(url, env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.tasks);

  const venture  = url.searchParams.get('venture');
  const status   = url.searchParams.get('status');
  const device   = url.searchParams.get('device');
  const priority = url.searchParams.get('priority');
  const project  = url.searchParams.get('project');

  const headers = rows[0] || [];
  const data = rows.slice(1).map(r => rowToObj(headers, r)).filter(t => {
    if (venture  && !csvIncludes(t.Venture, venture))     return false;
    if (project  && !csvIncludes(t.Project_ID, project))  return false;
    if (status   && t.Status   !== status)   return false;
    if (device   && t.Device   !== device)   return false;
    if (priority && t.Priority !== priority) return false;
    return t.Task_ID; // skip blank rows
  });

  return json({ tasks: data, count: data.length });
}

// Checks whether a comma-separated field contains a given value (trimmed, exact match per item)
function csvIncludes(field, value) {
  if (!field) return false;
  return field.split(',').map(s => s.trim()).includes(value);
}

// ── GET WBM ───────────────────────────────────────────────────────────────────

async function handleGetWBM(url, env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.wbm);

  const statusFilter = url.searchParams.get('status');
  const headers = rows[0] || [];
  const data = rows.slice(1).map(r => rowToObj(headers, r)).filter(w => {
    if (statusFilter && w.Status !== statusFilter) return false;
    return w.WBM_ID;
  });

  return json({ wbm: data, count: data.length });
}

// ── GET PATTERNS ──────────────────────────────────────────────────────────────

async function handleGetPatterns(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.patterns);

  const headers = rows[0] || [];
  const data = rows.slice(1)
    .map(r => rowToObj(headers, r))
    .filter(p => p.Pattern_ID && p.Active !== 'FALSE');

  return json({ patterns: data, count: data.length });
}

// POST /patterns — manual entry { text, category }
async function handlePostPattern(request, env) {
  const body = await request.json();
  const { text = '', category = 'workflow' } = body;
  if (!text.trim()) return err('text is required');

  const token = await getAccessToken(env);
  const id = await nextId(env, token, SHEET_TABS.patterns, 'PAT');
  const today = new Date().toISOString().split('T')[0];

  // Columns: Pattern_ID | Pattern_Text | Category | Source_Type | Evidence_IDs |
  //          Confidence | First_Seen | Last_Seen | Applied_To | Active
  const row = [id, text.trim(), category, 'manual', '', 'confirmed', today, today, '', 'TRUE'];
  await appendRow(env, token, SHEET_TABS.patterns, row);
  return json({ ok: true, id });
}

// POST /patterns/update — { Pattern_ID, fields } — used for Confirm / Reject / Apply-to-Project
async function handlePatternUpdate(request, env) {
  const body = await request.json();
  const { Pattern_ID, fields = {} } = body;
  if (!Pattern_ID) return err('Pattern_ID is required');
  if (Array.isArray(fields.Applied_To)) fields.Applied_To = fields.Applied_To.join(', ');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.patterns);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === Pattern_ID);
  if (idx === -1) return err('Pattern_ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields, Last_Seen: new Date().toISOString().split('T')[0] };
  const newRow = headers.map(h => merged[h] ?? '');

  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.patterns, rowNumber, newRow, headers.length);

  return json({ ok: true, Pattern_ID });
}

// ── DEV LOG ───────────────────────────────────────────────────────────────────

async function handlePostDevLog(request, env) {
  const { text } = await request.json();
  if (!text) return err('text is required');

  const token = await getAccessToken(env);
  const id = await nextId(env, token, SHEET_TABS.dev_log, 'DL');
  const today = new Date().toISOString().split('T')[0];
  await appendRow(env, token, SHEET_TABS.dev_log, [id, text.trim(), 'wishlist', today, 'TRUE']);
  return json({ ok: true, id });
}

async function handleGetDevLog(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.dev_log);
  const headers = rows[0] || [];
  const data = rows.slice(1)
    .map(r => rowToObj(headers, r))
    .filter(d => d.ID && d.Active === 'TRUE');
  return json({ devlog: data, count: data.length });
}

// POST /devlog/update — { ID, fields: { Text, Status } }
async function handleDevLogUpdate(request, env) {
  const body = await request.json();
  const { ID, fields = {} } = body;
  if (!ID) return err('ID is required');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.dev_log);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === ID);
  if (idx === -1) return err('ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields };
  const newRow = headers.map(h => merged[h] ?? '');

  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.dev_log, rowNumber, newRow, headers.length);

  return json({ ok: true, ID });
}

// POST /devlog/convert — { ID, target: 'task'|'project', title, venture, priority, context, device, next_action, project_ids, description, phase }
// Creates a Task or Project from a Dev Log entry, links back via Spawned_ID, marks Status='planned'
async function handleDevLogConvert(request, env) {
  const body = await request.json();
  const {
    ID, target = 'task', title = '', venture = '', priority = 'medium',
    context = '', device = 'any', next_action = '', project_ids = '',
    description = '', phase = '', due_date = '', depends_on = ''
  } = body;
  if (!ID) return err('ID is required');

  const ventureStr = Array.isArray(venture) ? venture.join(', ') : venture;
  const projectStr = Array.isArray(project_ids) ? project_ids.join(', ') : project_ids;
  const dependsStr = Array.isArray(depends_on) ? depends_on.join(', ') : depends_on;

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.dev_log);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === ID);
  if (idx === -1) return err('ID not found', 404);

  const devRecord = rowToObj(headers, dataRows[idx]);
  const today = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();
  let spawnedId;

  if (target === 'project') {
    spawnedId = await nextId(env, token, SHEET_TABS.projects, 'BTOS-PRJ');
    const row = [spawnedId, title || devRecord.Text || '', description, 'active', ventureStr, phase, '', '', today, '', '', due_date, dependsStr];
    await appendRow(env, token, SHEET_TABS.projects, row);
  } else {
    const taskIdRaw = await nextId(env, token, SHEET_TABS.tasks, 'BTOS');
    spawnedId = `BTOS-${year}-${taskIdRaw.split('-')[1]}`;
    const row = [
      spawnedId, title || devRecord.Text || '', '', 'backlog', projectStr,
      ventureStr, context, device, '', 'medium', priority, '', 'devlog_convert',
      '', due_date, today, '', '', next_action, dependsStr,
    ];
    await appendRow(env, token, SHEET_TABS.tasks, row);
  }

  // Mark the Dev Log entry as planned + link the spawned record
  const updated = { ...devRecord, Status: 'planned', Spawned_ID: spawnedId };
  const newRow = headers.map(h => updated[h] ?? '');
  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.dev_log, rowNumber, newRow, headers.length);

  return json({ ok: true, spawnedId, target });
}

// ── BATCH (Phase 2) ────────────────────────────────────────────────────────────
// POST /batch
// Body: { items: string[], defaultVenture, defaultType }
// Single Anthropic call: tag + classify N items, return structured JSON + insights

async function handleBatch(request, env) {
  const body = await request.json();
  const { items = [], defaultVenture = '', defaultType = 'wbm' } = body;
  if (!items.length) return err('No items provided');

  const token = await getAccessToken(env);

  // Load CONFIRMED patterns only to inject into the prompt (suggested/weak ones aren't authoritative yet)
  let patternContext = '(no confirmed patterns loaded)';
  try {
    const pRows = await getSheetRows(env, token, SHEET_TABS.patterns);
    const headers = pRows[0] || [];
    const confirmed = pRows.slice(1)
      .map(r => rowToObj(headers, r))
      .filter(p => p.Pattern_ID && p.Active !== 'FALSE' && p.Confidence === 'confirmed');
    if (confirmed.length) {
      patternContext = 'CONFIRMED PATTERNS (apply these to all items):\n' +
        confirmed.map(p => `- [${p.Pattern_ID}] ${p.Pattern_Text}`).join('\n');
    }
  } catch (e) {
    // Non-fatal — proceed without patterns
  }

  // Cross-hub entity linking: find known properties/contacts/listings whose aliases
  // appear anywhere in this batch's raw text, and hand the AI the resolved names —
  // this is what turns "151" into "151 W Lanvale St" instead of a mystery string.
  let entityContext = '(no matching entities found)';
  try {
    const entRows = await getSheetRows(env, token, SHEET_TABS.entities);
    const entHeaders = entRows[0] || [];
    const allEntities = entRows.slice(1).map(r => rowToObj(entHeaders, r)).filter(e => e.Entity_ID);
    const combinedText = items.join(' ').toLowerCase();
    const matched = allEntities.filter(e => {
      const aliases = (e.Aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
      return aliases.some(a => a && combinedText.includes(a));
    }).slice(0, 15); // capped for token efficiency (PAT-017)
    if (matched.length) {
      entityContext = 'KNOWN ENTITIES (if an item references one of these, resolve the shorthand ' +
        'to its real name and include the Entity_ID in entity_refs):\n' +
        matched.map(e => `- "${e.Display_Name}" [${e.Entity_ID}] aliases: ${e.Aliases} (${e.Entity_Type})`).join('\n');
    }
  } catch (e) {
    // Non-fatal — proceed without entity context
  }

  const ventureHint = defaultVenture ? `Default venture if unclear: ${defaultVenture}.` : '';
  const typeHint = defaultType !== 'auto'
    ? `Default type if unclear: ${defaultType}.`
    : 'Auto-detect type (wbm or task) based on phrasing.';

  const systemPrompt = `You are processing a batch of items for BrettOS — Brett's personal productivity system.
Brett runs: Ridge Co (property maintenance, Baltimore MD), BarrelCo (oak barrel resale), Handyman (Saint Thomas Ventures), WV Cabin STR (Springfield WV).

${patternContext}

${entityContext}

${ventureHint}
${typeHint}

Return ONLY a valid JSON object — no markdown, no preamble — with this exact shape:
{
  "items": [
    {
      "title": "cleaned, action-oriented version of the item — resolve any shorthand from KNOWN ENTITIES into the real name",
      "type": "wbm|task",
      "venture": "ridge_co|barrel_co|handyman|cabin|personal|multiple|",
      "context": "quick_hit|deep_focus|errand|phone_call|waiting_on_someone|planning|",
      "device": "any|phone_ok|desktop_only",
      "location_tags": "baltimore|waynesboro|wv_cabin|anywhere",
      "priority": "critical|high|medium|low",
      "ai_tags": ["tag1","tag2"],
      "next_action": "single next physical step",
      "project_suggestion": "optional project name this might belong to",
      "pattern_flags": ["PAT-001"],
      "entity_refs": ["ENT-0003"]
    }
  ],
  "batch_insights": {
    "patterns_detected": [
      { "text": "description of a new pattern spotted across items", "category": "system_design|workflow|communication|tooling|personal|business", "item_indices": [1,3] }
    ],
    "project_clusters": ["items 1,3,5 all relate to Ridge Co SMS — possible project"],
    "suggested_relationships": ["item 2 and item 7 may be related"]
  }
}
IMPORTANT: item_indices are 1-based, referring to the numbered ITEMS list below. Only include patterns_detected entries when there's a genuine repeated signal across 2+ items — don't force it. entity_refs should only include Entity_IDs from KNOWN ENTITIES that this specific item actually references.`;

  const numberedItems = items.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const userPrompt = `Process these ${items.length} items:\n\n${numberedItems}`;

  const t0 = Date.now();
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const aiData = await aiRes.json();
  if (!aiRes.ok) return err('Anthropic API error: ' + (aiData.error?.message || 'unknown'), 500);

  const rawText = aiData.content?.[0]?.text || '';
  const ms = Date.now() - t0;
  const inTok = aiData.usage?.input_tokens || 0;
  const outTok = aiData.usage?.output_tokens || 0;

  let aiResult;
  try {
    const cleaned = rawText.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    aiResult = JSON.parse(cleaned);
  } catch (e) {
    return err('Failed to parse AI response: ' + e.message, 500);
  }

  // Stamp originals onto each item for diff view
  if (Array.isArray(aiResult.items)) {
    aiResult.items.forEach((item, i) => { item._original = items[i] || ''; item._index = i + 1; });
  }

  // Log to AI_Log (non-blocking — don't fail the request if logging fails)
  logAIAction(env, token, {
    action_type: 'batch_tag',
    input_tokens: inTok,
    output_tokens: outTok,
    items_processed: items.length,
    notes: `Batch of ${items.length} items · ${ms}ms`,
  }).catch(() => {});

  return json({
    ok: true,
    items: aiResult.items || [],
    batch_insights: aiResult.batch_insights || {},
    log: { input_tokens: inTok, output_tokens: outTok, ms },
  });
}

// ── BATCH SAVE (Phase 2) ───────────────────────────────────────────────────────
// POST /batchSave
// Body: { items: [{ type, title, venture, priority, context, ai_tags, next_action, project_suggestion, _original }] }

async function handleBatchSave(request, env) {
  const body = await request.json();
  const { items = [], patterns = [] } = body;
  if (!items.length) return err('No items to save');

  const token = await getAccessToken(env);
  const today = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();

  // Normalize venture / project fields to CSV strings (chip pickers send arrays)
  const toCsv = v => Array.isArray(v) ? v.join(', ') : (v || '');
  items.forEach(i => {
    i.venture = toCsv(i.venture);
    i.project_suggestion = toCsv(i.project_suggestion);
    // Fold entity_refs into ai_tags as bracketed IDs — no new column needed,
    // and it's immediately visible/searchable in the existing AI_Tags field.
    if (i.entity_refs && i.entity_refs.length) {
      const refTags = i.entity_refs.map(id => `[${id}]`).join(' ');
      const existingTags = Array.isArray(i.ai_tags) ? i.ai_tags.join(', ') : (i.ai_tags || '');
      i.ai_tags = existingTags ? `${existingTags}, ${refTags}` : refTags;
    }
  });

  const wbmItems  = items.filter(i => i.type === 'wbm');
  const taskItems = items.filter(i => i.type === 'task');

  let saved = 0;
  const indexToId = {}; // maps original AI item _index -> the real saved Sheet ID (for pattern evidence)

  // ── Save WBMs ──
  for (const item of wbmItems) {
    const id = await nextId(env, token, SHEET_TABS.wbm, 'WBM');
    const row = [
      id,
      item.title || item._original || '',
      today,
      'bulk_paste',
      item.venture || '',
      item.location_tags || '',
      Array.isArray(item.ai_tags) ? item.ai_tags.join(', ') : (item.ai_tags || ''),
      '', // Spawned_Task_ID
      '', // Spawned_Project_ID (only set when this WBM later spawns a NEW project via convert)
      'raw',
      '', // Resolution_Notes
      (item.pattern_flags || []).join(', '),
      item.project_suggestion || '', // Project_ID (tag — column M)
    ];
    await appendRow(env, token, SHEET_TABS.wbm, row);
    if (item._index) indexToId[item._index] = id;
    saved++;
  }

  // ── Save Tasks (same ID scheme as /capture: BTOS-YYYY-NNN) ──
  for (const item of taskItems) {
    const id = await nextId(env, token, SHEET_TABS.tasks, 'BTOS');
    const taskId = `BTOS-${year}-${id.split('-')[1]}`;
    const row = [
      taskId,
      item.title || item._original || '',
      '', // Description
      'backlog',
      item.project_suggestion || '', // Project_ID
      item.venture || '',
      item.context || '',
      item.device || 'any',
      item.location_tags || '',
      'medium', // Energy
      item.priority || 'medium',
      Array.isArray(item.ai_tags) ? item.ai_tags.join(', ') : (item.ai_tags || ''),
      'bulk_paste',
      '', // WBM_ID
      '', // Due_Date
      today,
      '', // Completed_Date
      '', // Notes
      item.next_action || '',
      '', // Depends_On (batch review doesn't set dependencies — done post-save in Task Edit)
    ];
    await appendRow(env, token, SHEET_TABS.tasks, row);
    if (item._index) indexToId[item._index] = taskId;
    saved++;
  }

  // ── Write AI-detected patterns as "suggested", with resolved evidence IDs ──
  let patternsSaved = 0;
  for (const p of patterns) {
    const evidenceIds = (p.item_indices || [])
      .map(idx => indexToId[idx])
      .filter(Boolean);
    if (evidenceIds.length === 0) continue; // all evidence items were skipped — skip the pattern too
    const patId = await nextId(env, token, SHEET_TABS.patterns, 'PAT');
    const row = [
      patId, p.text || '', p.category || 'workflow', 'wbm_cluster',
      evidenceIds.join(', '), 'suggested', today, today, '', 'TRUE',
    ];
    await appendRow(env, token, SHEET_TABS.patterns, row);
    patternsSaved++;
  }

  // Log to AI_Log
  await logAIAction(env, token, {
    action_type: 'batch_tag',
    input_tokens: 0,
    output_tokens: 0,
    items_processed: items.length,
    accepted_count: saved,
    notes: `Batch save: ${wbmItems.length} WBMs, ${taskItems.length} Tasks, ${patternsSaved} patterns suggested`,
  }).catch(() => {});

  return json({ ok: true, saved, patternsSaved });
}

// ── AI_LOG HELPER (Phase 2) ────────────────────────────────────────────────────
// Columns: Log_ID | Timestamp | Action_Type | Input_Token_Count | Output_Token_Count |
//          Items_Processed | Accepted_Count | Rejected_Count | Edited_Count | Notes

async function logAIAction(env, token, { action_type, input_tokens, output_tokens, items_processed, accepted_count, notes }) {
  const id = await nextId(env, token, SHEET_TABS.ai_log, 'LOG');
  const ts = new Date().toISOString();
  const row = [
    id,
    ts,
    action_type || '',
    input_tokens || 0,
    output_tokens || 0,
    items_processed || 0,
    accepted_count || 0,
    0, // Rejected_Count
    0, // Edited_Count
    notes || '',
  ];
  await appendRow(env, token, SHEET_TABS.ai_log, row);
}

// ── VENTURES ──────────────────────────────────────────────────────────────────
// GET  /ventures — list active ventures (Venture_Code, Venture_Name, Color, Active, Created_Date)
// POST /ventures — add a new venture { code, name, color }

async function handleGetVentures(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.ventures);
  const headers = rows[0] || [];
  const data = rows.slice(1)
    .map(r => rowToObj(headers, r))
    .filter(v => v.Venture_Code && v.Active !== 'FALSE');
  return json({ ventures: data, count: data.length });
}

async function handlePostVenture(request, env) {
  const body = await request.json();
  let { code = '', name = '', color = '#7b80a0' } = body;
  name = name.trim();
  if (!name) return err('name is required');

  // Auto-slug code from name if not provided
  if (!code.trim()) {
    code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  } else {
    code = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.ventures);
  const headers = rows[0] || [];
  const existing = rows.slice(1).map(r => rowToObj(headers, r));
  if (existing.some(v => v.Venture_Code === code)) {
    return err(`Venture code "${code}" already exists`, 409);
  }

  const today = new Date().toISOString().split('T')[0];
  await appendRow(env, token, SHEET_TABS.ventures, [code, name, color, 'TRUE', today]);
  return json({ ok: true, code, name, color });
}

// ── PROJECTS ──────────────────────────────────────────────────────────────────
// GET  /projects — list all projects
// POST /projects — create a project { title, description, venture, phase }
//   venture may be an array (chip picker) or a comma string.

async function handleGetProjects(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.projects);
  const headers = rows[0] || [];
  const data = rows.slice(1).map(r => rowToObj(headers, r)).filter(p => p.Project_ID);
  return json({ projects: data, count: data.length });
}

async function handlePostProject(request, env) {
  const body = await request.json();
  const { title = '', description = '', venture = '', phase = '', due_date = '', depends_on = '' } = body;
  if (!title.trim()) return err('title is required');

  const ventureStr = Array.isArray(venture) ? venture.join(', ') : venture;
  const dependsStr = Array.isArray(depends_on) ? depends_on.join(', ') : depends_on;
  const token = await getAccessToken(env);
  const id = await nextId(env, token, SHEET_TABS.projects, 'BTOS-PRJ');
  const today = new Date().toISOString().split('T')[0];

  // Columns: Project_ID | Title | Description | Status | Venture | Phase |
  //          AI_Tags | Pattern_Flags | Created_Date | Notes | Hub_Link | Due_Date | Depends_On
  const row = [id, title.trim(), description, 'active', ventureStr, phase, '', '', today, '', '', due_date, dependsStr];
  await appendRow(env, token, SHEET_TABS.projects, row);
  return json({ ok: true, id });
}

// POST /projects/update — { Project_ID, fields } — full edit incl. venture, due_date, depends_on
async function handleProjectUpdate(request, env) {
  const body = await request.json();
  const { Project_ID, fields = {} } = body;
  if (!Project_ID) return err('Project_ID is required');
  if (Array.isArray(fields.Venture))     fields.Venture     = fields.Venture.join(', ');
  if (Array.isArray(fields.Depends_On))  fields.Depends_On  = fields.Depends_On.join(', ');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.projects);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === Project_ID);
  if (idx === -1) return err('Project_ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields };
  const newRow = headers.map(h => merged[h] ?? '');

  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.projects, rowNumber, newRow, headers.length);

  return json({ ok: true, Project_ID });
}

// ── TASK UPDATE (edit any field in place, incl. multi-venture/multi-project) ──
// POST /tasks/update
// Body: { Task_ID, fields: { Title, Status, Venture, Project_ID, Priority, Context, Device, Next_Action, ... } }
// venture/project_ids in `fields` may be arrays — auto-joined to CSV strings.

async function handleTaskUpdate(request, env) {
  const body = await request.json();
  const { Task_ID, fields = {} } = body;
  if (!Task_ID) return err('Task_ID is required');

  if (Array.isArray(fields.Venture))    fields.Venture    = fields.Venture.join(', ');
  if (Array.isArray(fields.Project_ID)) fields.Project_ID = fields.Project_ID.join(', ');
  if (Array.isArray(fields.Depends_On)) fields.Depends_On = fields.Depends_On.join(', ');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.tasks);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === Task_ID);
  if (idx === -1) return err('Task_ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields };
  const newRow = headers.map(h => merged[h] ?? '');

  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.tasks, rowNumber, newRow, headers.length);

  return json({ ok: true, Task_ID });
}

// ── WBM UPDATE (edit an existing entry in place) ───────────────────────────────
// POST /wbm/update
// Body: { WBM_ID, fields: { Text, Venture, Location, Status, Resolution_Notes } }
// Only fields present in `fields` are overwritten — everything else stays as-is.

async function handleWBMUpdate(request, env) {
  const body = await request.json();
  const { WBM_ID, fields = {} } = body;
  if (!WBM_ID) return err('WBM_ID is required');
  if (Array.isArray(fields.Venture))    fields.Venture    = fields.Venture.join(', ');
  if (Array.isArray(fields.Project_ID)) fields.Project_ID = fields.Project_ID.join(', ');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.wbm);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === WBM_ID);
  if (idx === -1) return err('WBM_ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields };
  const newRow = headers.map(h => merged[h] ?? '');

  const rowNumber = idx + 2; // +1 for header, +1 for 1-indexing
  await updateSheetRow(env, token, SHEET_TABS.wbm, rowNumber, newRow, headers.length);

  return json({ ok: true, WBM_ID });
}

// ── WBM CONVERT (turn a WBM into a Task) ───────────────────────────────────────
// POST /wbm/convert
// Body: { WBM_ID, title, venture, priority, context, device, next_action }
// Creates a new Task row, then marks the source WBM as converted + links Spawned_Task_ID.

async function handleWBMConvert(request, env) {
  const body = await request.json();
  const {
    WBM_ID, title = '', venture = '', priority = 'medium',
    context = '', device = 'any', next_action = '', project_ids = '',
    due_date = '', depends_on = ''
  } = body;
  if (!WBM_ID) return err('WBM_ID is required');

  const ventureStr = Array.isArray(venture) ? venture.join(', ') : venture;
  const projectStr = Array.isArray(project_ids) ? project_ids.join(', ') : project_ids;
  const dependsStr = Array.isArray(depends_on) ? depends_on.join(', ') : depends_on;

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.wbm);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === WBM_ID);
  if (idx === -1) return err('WBM_ID not found', 404);

  const wbmRecord = rowToObj(headers, dataRows[idx]);
  const today = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();

  // If no project explicitly passed, inherit whatever was already tagged on the WBM
  const finalProjectStr = projectStr || wbmRecord.Project_ID || '';

  // Create the Task
  const taskIdRaw = await nextId(env, token, SHEET_TABS.tasks, 'BTOS');
  const taskId = `BTOS-${year}-${taskIdRaw.split('-')[1]}`;
  const taskRow = [
    taskId,
    title || wbmRecord.Text || '',
    '', // Description
    'backlog',
    finalProjectStr,
    ventureStr || wbmRecord.Venture || '',
    context,
    device,
    wbmRecord.Location || '',
    'medium', // Energy
    priority,
    wbmRecord.AI_Tags || '',
    'wbm_convert',
    WBM_ID,
    due_date,
    today,
    '', // Completed_Date
    '', // Notes
    next_action,
    dependsStr,
  ];
  await appendRow(env, token, SHEET_TABS.tasks, taskRow);

  // Mark the WBM as converted + link the new Task
  const updatedWBM = { ...wbmRecord, Status: 'converted', Spawned_Task_ID: taskId };
  const newWBMRow = headers.map(h => updatedWBM[h] ?? '');
  const rowNumber = idx + 2;
  await updateSheetRow(env, token, SHEET_TABS.wbm, rowNumber, newWBMRow, headers.length);

  return json({ ok: true, taskId, WBM_ID });
}

// ── ENTITY SYNC (Phase 6 — cross-hub linking) ───────────────────────────────────
// POST /entities/sync
// Pulls from Maintenance Hub + BarrelCo's /public/entities-feed contracts, validates
// shape, replaces this Worker's copy of each source's entities, and logs every
// attempt — success or failure — to Integration_Log so breakage is visible, not silent.

async function handleEntitiesSync(env) {
  const token = await getAccessToken(env);
  const results = {};

  // ── Maintenance Hub (properties) ──
  try {
    if (!env.MAINTENANCE_HUB_URL) throw new Error('MAINTENANCE_HUB_URL env var not set');
    const res = await fetch(`${env.MAINTENANCE_HUB_URL}/public/entities-feed`, {
      headers: { 'X-Auth-Token': env.MAINTENANCE_HUB_SECRET || '' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || 'unknown error'}`);
    if (data.version !== 1) throw new Error(`Unexpected feed version: got ${data.version}, expected 1`);
    if (!Array.isArray(data.properties)) throw new Error('Feed missing "properties" array');

    await replaceEntitiesForSource(env, token, 'ridge_co', data.properties.map(p => ({
      Entity_Type: 'property',
      Display_Name: p.address || p.id,
      Aliases: Array.isArray(p.aliases) ? p.aliases.join(', ') : '',
      Source_ID: p.id,
      Venture: 'ridge_co',
      Deep_Link_Hash: `#property/${p.id}`,
    })));
    await logIntegration(env, token, 'maintenance_hub', 'ok', `Synced ${data.properties.length} properties`);
    results.maintenance_hub = { ok: true, count: data.properties.length };
  } catch (e) {
    await logIntegration(env, token, 'maintenance_hub', 'error', e.message);
    results.maintenance_hub = { ok: false, error: e.message };
  }

  // ── BarrelCo (listings) ──
  try {
    if (!env.BARRELCO_URL) throw new Error('BARRELCO_URL env var not set');
    const res = await fetch(`${env.BARRELCO_URL}/public/entities-feed`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || 'unknown error'}`);
    if (data.version !== 1) throw new Error(`Unexpected feed version: got ${data.version}, expected 1`);
    if (!Array.isArray(data.listings)) throw new Error('Feed missing "listings" array');

    await replaceEntitiesForSource(env, token, 'barrel_co', data.listings.map(l => ({
      Entity_Type: 'barrelco_listing',
      Display_Name: l.name || l.id,
      Aliases: Array.isArray(l.aliases) ? l.aliases.join(', ') : '',
      Source_ID: l.id,
      Venture: 'barrel_co',
      Deep_Link_Hash: `#listing/${l.id}`,
    })));
    await logIntegration(env, token, 'barrelco', 'ok', `Synced ${data.listings.length} listings`);
    results.barrelco = { ok: true, count: data.listings.length };
  } catch (e) {
    await logIntegration(env, token, 'barrelco', 'error', e.message);
    results.barrelco = { ok: false, error: e.message };
  }

  // ── Contacts (self — BrettOS is the source of truth here) ──
  try {
    const rows = await getSheetRows(env, token, SHEET_TABS.contacts);
    const headers = rows[0] || [];
    const contacts = rows.slice(1).map(r => rowToObj(headers, r)).filter(c => c.Contact_ID);

    await replaceEntitiesForSource(env, token, 'brettos', contacts.map(c => ({
      Entity_Type: 'contact',
      Display_Name: c.Name,
      Aliases: c.Aliases || '',
      Source_ID: c.Contact_ID,
      Venture: c.Ventures_Connected || '',
      Deep_Link_Hash: '',
    })));
    await logIntegration(env, token, 'contacts', 'ok', `Synced ${contacts.length} contacts`);
    results.contacts = { ok: true, count: contacts.length };
  } catch (e) {
    await logIntegration(env, token, 'contacts', 'error', e.message);
    results.contacts = { ok: false, error: e.message };
  }

  return json({ ok: true, results });
}

// Replaces all Entities rows for a given Source_Hub with a fresh set, keeping
// everything from other sources untouched. Rewrites the whole tab body (small
// dataset — properties + listings + contacts is nowhere near Sheets' limits).
async function replaceEntitiesForSource(env, token, sourceHub, newEntities) {
  const rows = await getSheetRows(env, token, SHEET_TABS.entities);
  const headers = rows[0] || ['Entity_ID','Entity_Type','Display_Name','Aliases','Source_Hub','Source_ID','Venture','Deep_Link_Hash','Last_Synced'];
  const existingAll = rows.slice(1).map(r => rowToObj(headers, r)).filter(e => e.Entity_ID);
  const kept = existingAll.filter(e => e.Source_Hub !== sourceHub);

  const allIds = existingAll.map(e => parseInt((e.Entity_ID || 'ENT-0').split('-')[1]) || 0);
  let nextNum = allIds.length ? Math.max(...allIds) + 1 : 1;

  const today = new Date().toISOString();
  const fresh = newEntities.map(e => ({
    Entity_ID: `ENT-${String(nextNum++).padStart(4, '0')}`,
    Source_Hub: sourceHub,
    Last_Synced: today,
    ...e,
  }));

  const combined = [...kept, ...fresh];
  const combinedRows = combined.map(e => headers.map(h => e[h] ?? ''));

  await clearSheetRange(env, token, SHEET_TABS.entities);
  if (combinedRows.length) await appendRows(env, token, SHEET_TABS.entities, combinedRows);
}

// GET /entities/search?q=151 — used both by the AI batch prompt and available for
// direct lookups later (autocomplete, etc.)
async function handleEntitiesSearch(url, env) {
  const q = (url.searchParams.get('q') || '').toLowerCase().trim();
  if (!q) return json({ entities: [] });
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.entities);
  const headers = rows[0] || [];
  const all = rows.slice(1).map(r => rowToObj(headers, r)).filter(e => e.Entity_ID);
  const matches = all.filter(e => {
    const aliases = (e.Aliases || '').toLowerCase().split(',').map(a => a.trim()).filter(Boolean);
    const name = (e.Display_Name || '').toLowerCase();
    return aliases.includes(q) || name.includes(q) || aliases.some(a => a.includes(q));
  });
  return json({ entities: matches.slice(0, 10) });
}

// GET /integration-log — last 50 sync attempts, newest first
async function handleGetIntegrationLog(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.integration_log);
  const headers = rows[0] || [];
  const data = rows.slice(1)
    .map(r => rowToObj(headers, r))
    .filter(l => l.Log_ID)
    .reverse()
    .slice(0, 50);
  return json({ log: data });
}

async function logIntegration(env, token, sourceHub, status, detail) {
  const id = await nextId(env, token, SHEET_TABS.integration_log, 'ILOG');
  const row = [id, new Date().toISOString(), sourceHub, status, detail || ''];
  await appendRow(env, token, SHEET_TABS.integration_log, row);
}

// ── CONTACTS ──────────────────────────────────────────────────────────────────

async function handleGetContacts(env) {
  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.contacts);
  const headers = rows[0] || [];
  const data = rows.slice(1).map(r => rowToObj(headers, r)).filter(c => c.Contact_ID);
  return json({ contacts: data, count: data.length });
}

async function handlePostContact(request, env) {
  const body = await request.json();
  const {
    name = '', aliases = '', phone = '', email = '', relationship_type = '',
    ventures_connected = '', interests_skills = '', notes = ''
  } = body;
  if (!name.trim()) return err('name is required');

  const ventureStr = Array.isArray(ventures_connected) ? ventures_connected.join(', ') : ventures_connected;
  const token = await getAccessToken(env);
  const id = await nextId(env, token, SHEET_TABS.contacts, 'CON');
  const today = new Date().toISOString().split('T')[0];

  const row = [id, name.trim(), aliases, phone, email, relationship_type, ventureStr, interests_skills, notes, today];
  await appendRow(env, token, SHEET_TABS.contacts, row);
  return json({ ok: true, id });
}

async function handleContactUpdate(request, env) {
  const body = await request.json();
  const { Contact_ID, fields = {} } = body;
  if (!Contact_ID) return err('Contact_ID is required');
  if (Array.isArray(fields.Ventures_Connected)) fields.Ventures_Connected = fields.Ventures_Connected.join(', ');

  const token = await getAccessToken(env);
  const rows = await getSheetRows(env, token, SHEET_TABS.contacts);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const idx = dataRows.findIndex(r => r[0] === Contact_ID);
  if (idx === -1) return err('Contact_ID not found', 404);

  const existing = rowToObj(headers, dataRows[idx]);
  const merged = { ...existing, ...fields, Last_Contact_Date: new Date().toISOString().split('T')[0] };
  const newRow = headers.map(h => merged[h] ?? '');
  await updateSheetRow(env, token, SHEET_TABS.contacts, idx + 2, newRow, headers.length);

  return json({ ok: true, Contact_ID });
}

// ── SHEETS HELPERS ────────────────────────────────────────────────────────────

async function getSheetRows(env, token, tab) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

async function appendRow(env, token, tab, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status}`);
  return res.json();
}

// Batch append — multiple rows in a single API call (used by entity sync)
async function appendRows(env, token, tab, rows) {
  if (!rows.length) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`Sheets batch append failed: ${res.status}`);
  return res.json();
}

// Clears a data range (headers preserved) — used before rewriting Entities on sync
async function clearSheetRange(env, token, tab) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab + '!A2:Z20000')}:clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets clear failed: ${res.status}`);
  return res.json();
}

async function updateSheetRow(env, token, tab, rowNumber, row, colCount) {
  const lastCol = colLetter(colCount || row.length);
  const range = `${tab}!A${rowNumber}:${lastCol}${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets update failed: ${res.status}`);
  return res.json();
}

function colLetter(n) {
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

async function nextId(env, token, tab, prefix) {
  const rows = await getSheetRows(env, token, tab);
  const count = Math.max(0, rows.length - 1); // subtract header
  const next = String(count + 1).padStart(3, '0');
  return `${prefix}-${next}`;
}

function rowToObj(headers, row) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i] || ''; });
  return obj;
}

// ── GOOGLE AUTH ───────────────────────────────────────────────────────────────

async function getAccessToken(env) {
  const key = JSON.parse(env.SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: env.SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const unsigned = `${header}.${payload}`;
  const signature = await signRS256(unsigned, key.private_key);
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signRS256(data, pemKey) {
  const pem = pemKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
