#!/usr/bin/env node
/**
 * Deploys apps-script/tasks-sync/{TasksSync.js,appsscript.json} to the live,
 * container-bound Apps Script project using a Google service account —
 * no clasp, no OAuth-as-a-human-user, no reauth policy to trip over.
 *
 * Auth: reads the full service-account JSON key from the
 * APPSSCRIPT_SA_KEY_B64 env var (base64-encoded). This must only ever be
 * set as a GitHub Actions secret and decoded inside the runner — never
 * pasted in chat, never handled client-side in a browser.
 *
 * Safety: script.projects.updateContent() REPLACES the entire project's
 * file set. Code.gs (Brett's original setup script) is NOT tracked in
 * this repo, so we first fetch the project's current files and merge our
 * two tracked files into that set rather than overwriting it wholesale.
 *
 * First live run via service account: 2026-09-28.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCRIPT_ID = '1GnQ5-6PalnMFADIwjQKDzkEF5cbhqR-APvUHgd7g0CKb48CsOQJVV3YD';
const DEPLOYMENT_ID = 'AKfycbwboTdUJ3datXm7R2XTn3gyaYPxhEWbz7iIPyAZJvO-b3RaOo8zueFZqQGxTT6loPGsug';
// This file lives at .github/scripts/deploy-apps-script.js in the repo,
// so the tracked source files are two levels up, under apps-script/tasks-sync.
const SRC_DIR = path.join(__dirname, '..', '..', 'apps-script', 'tasks-sync');

// name -> { localFile, type }
const TRACKED_FILES = {
  TasksSync: { localFile: 'TasksSync.js', type: 'SERVER_JS' },
  appsscript: { localFile: 'appsscript.json', type: 'JSON' },
};

async function main() {
  const keyB64 = process.env.APPSSCRIPT_SA_KEY_B64;
  if (!keyB64) {
    throw new Error('APPSSCRIPT_SA_KEY_B64 env var is empty or not set. This must be a GitHub Actions secret.');
  }
  const key = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf8'));

  // The Apps Script API requires a real Workspace user identity, not a bare
  // service account — so this impersonates Brett via domain-wide delegation
  // (configured in the GCP console + admin.google.com, not here).
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    // script.projects covers file/version edits; deployments.update needs the
    // separate script.deployments scope, or it fails with
    // ACCESS_TOKEN_SCOPE_INSUFFICIENT even though everything else succeeds.
    // Both scopes must also be authorized (comma-separated) for this service
    // account's Client ID in admin.google.com's Domain-wide Delegation settings.
    scopes: [
      'https://www.googleapis.com/auth/script.projects',
      'https://www.googleapis.com/auth/script.deployments',
    ],
    subject: 'brett@bmoremanagement.com',
  });
  await auth.authorize();
  console.log(`Authenticated as ${key.client_email}, impersonating brett@bmoremanagement.com`);

  const script = google.script({ version: 'v1', auth });

  // 1. Fetch existing project content so we don't clobber untracked files (Code.gs).
  const { data: existing } = await script.projects.getContent({ scriptId: SCRIPT_ID });
  const existingFiles = existing.files || [];
  console.log(`Existing project files: ${existingFiles.map(f => f.name).join(', ')}`);

  // 2. Build merged file list: keep everything not tracked here, replace/add tracked files.
  const trackedNames = new Set(Object.keys(TRACKED_FILES));
  const merged = existingFiles.filter(f => !trackedNames.has(f.name));

  for (const [name, { localFile, type }] of Object.entries(TRACKED_FILES)) {
    const source = fs.readFileSync(path.join(SRC_DIR, localFile), 'utf8');
    merged.push({ name, type, source });
    console.log(`Prepared ${localFile} -> project file "${name}" (${type}, ${source.length} bytes)`);
  }

  // 3. Push the merged file set.
  await script.projects.updateContent({
    scriptId: SCRIPT_ID,
    requestBody: { files: merged },
  });
  console.log('updateContent succeeded.');

  // 4. Create a new version.
  const timestamp = new Date().toISOString();
  const { data: version } = await script.projects.versions.create({
    scriptId: SCRIPT_ID,
    requestBody: { description: `auto-deploy ${timestamp}` },
  });
  console.log(`Created version ${version.versionNumber}`);

  // 5. Point the existing deployment at the new version.
  await script.projects.deployments.update({
    scriptId: SCRIPT_ID,
    deploymentId: DEPLOYMENT_ID,
    requestBody: {
      deploymentConfig: {
        scriptId: SCRIPT_ID,
        versionNumber: version.versionNumber,
        manifestFileName: 'appsscript',
        description: `auto-deploy ${timestamp}`,
      },
    },
  });
  console.log(`Deployment ${DEPLOYMENT_ID} now points at version ${version.versionNumber}. Done.`);
}

main().catch(err => {
  console.error('Deploy failed:', err && err.response && err.response.data ? JSON.stringify(err.response.data, null, 2) : err);
  process.exit(1);
});
