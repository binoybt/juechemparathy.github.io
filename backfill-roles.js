#!/usr/bin/env node
/**
 * backfill-roles.js
 *
 * One-off admin script that stamps `role: 'admin'` on the Firestore
 * users/{uid} doc of every email listed below. Uses the Firebase Admin
 * SDK, so it bypasses security rules — meaning it's the correct fix when
 * the strict `users/{uid}` update rule has locked you out of self-promoting
 * via the browser bootstrap.
 *
 * Usage
 * ─────
 *   node backfill-roles.js               # promote the defaults
 *   node backfill-roles.js --dry-run     # show what would change
 *   node backfill-roles.js foo@x.com bar@y.com   # promote arbitrary emails
 *
 * Credentials
 * ───────────
 * Same three options as mirror-auth.js — in order of preference:
 *
 *   1. GOOGLE CLOUD SHELL (easiest):
 *        gcloud config set project smash-26679
 *        npm install
 *        node backfill-roles.js
 *
 *   2. LOCAL WITH A SERVICE-ACCOUNT KEY FILE:
 *        FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/key.json node backfill-roles.js
 *
 *   3. LOCAL WITH THE ENV VAR CONVENTION:
 *        FIREBASE_SERVICE_ACCOUNT=<raw or base64 JSON> node backfill-roles.js
 */

const fs = require('fs');

let admin;
try {
  admin = require('firebase-admin');
} catch (err) {
  console.error('\n✗ firebase-admin is not installed.\n');
  console.error('  Run this first (from the repo root):');
  console.error('    npm install\n');
  process.exit(1);
}

// Default set of admins to promote when no emails are given on the CLI.
const DEFAULT_ADMINS = [
  'jue.george@gmail.com',
  'binoybt@gmail.com',
  'geojins@gmail.com',
  'b.ajaymathews@gmail.com'
];

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const emails  = args.filter(function (a) { return a && !a.startsWith('--'); });
const TARGETS = (emails.length ? emails : DEFAULT_ADMINS).map(function (e) { return e.toLowerCase(); });

// ── Credentials (same shape as mirror-auth.js) ───────────────────────────
function readCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
    if (!fs.existsSync(p)) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE points at a missing file: ' + p);
    }
    return { credential: JSON.parse(fs.readFileSync(p, 'utf8')), source: 'file' };
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const trimmed = raw.trim();
    const jsonString = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    try {
      return { credential: JSON.parse(jsonString), source: 'env' };
    } catch (err) {
      throw new Error('Failed to parse FIREBASE_SERVICE_ACCOUNT: ' + err.message);
    }
  }
  return { credential: null, source: 'adc' };
}

function resolveProjectId(credential) {
  if (credential && credential.project_id) return credential.project_id;
  if (process.env.GOOGLE_CLOUD_PROJECT)    return process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.GCLOUD_PROJECT)          return process.env.GCLOUD_PROJECT;
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────
(async function main() {
  const { credential, source } = readCredentials();
  const projectId = resolveProjectId(credential);
  if (!projectId) {
    throw new Error(
      'Could not determine the Firebase project ID.\n' +
      '  When using Application Default Credentials, set GOOGLE_CLOUD_PROJECT\n' +
      '  or run "gcloud config set project <your-project-id>" first.'
    );
  }
  if (source === 'adc') {
    admin.initializeApp({ projectId: projectId });
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(credential),
      projectId: projectId
    });
  }
  const authAdmin = admin.auth();
  const db        = admin.firestore();

  console.log('Project:  ' + projectId);
  console.log('Auth:     ' + (source === 'adc' ? 'Application Default Credentials (Cloud Shell / gcloud)' : 'service account (' + source + ')'));
  console.log('Dry run:  ' + DRY_RUN);
  console.log('Targets:  ' + TARGETS.length + ' email' + (TARGETS.length === 1 ? '' : 's'));
  TARGETS.forEach(function (e) { console.log('  · ' + e); });
  console.log('');

  let promoted = 0;
  let missing  = 0;
  let alreadyAdmin = 0;

  for (let i = 0; i < TARGETS.length; i++) {
    const email = TARGETS[i];
    let userRec = null;
    try {
      userRec = await authAdmin.getUserByEmail(email);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log('  ✗ ' + email.padEnd(35) + ' — no Firebase Auth account. They must sign in with Google at least once first.');
        missing++;
        continue;
      }
      console.log('  ✗ ' + email.padEnd(35) + ' — lookup failed: ' + (err.message || err.code));
      missing++;
      continue;
    }

    const uid = userRec.uid;
    const ref = db.collection('users').doc(uid);
    let existingRole = null;
    try {
      const snap = await ref.get();
      existingRole = snap.exists && snap.data() ? (snap.data().role || null) : null;
    } catch (_) {}

    if (existingRole === 'admin') {
      console.log('  = ' + email.padEnd(35) + ' — already admin (uid ' + uid + ')');
      alreadyAdmin++;
      continue;
    }

    if (DRY_RUN) {
      console.log('  → ' + email.padEnd(35) + ' — would set role="admin" (uid ' + uid + (existingRole ? ', was "' + existingRole + '"' : ', no prior role') + ')');
      promoted++;
      continue;
    }

    try {
      await ref.set({
        role:      'admin',
        roleSetAt: admin.firestore.FieldValue.serverTimestamp(),
        roleSetBy: 'backfill-roles.js'
      }, { merge: true });
      console.log('  ✓ ' + email.padEnd(35) + ' — role set to admin (uid ' + uid + ')');
      promoted++;
    } catch (err) {
      console.log('  ✗ ' + email.padEnd(35) + ' — write failed: ' + (err.message || err.code));
      missing++;
    }
  }

  console.log('');
  console.log('✓ Done.');
  console.log('  Promoted:      ' + promoted + (DRY_RUN ? ' (would-be)' : ''));
  console.log('  Already admin: ' + alreadyAdmin);
  console.log('  Skipped/failed:' + missing);
  if (!DRY_RUN && promoted > 0) {
    console.log('\nSign out and sign back in on the site. The SmashAuth listener will');
    console.log('pick up role="admin" from the users/{uid} snapshot within seconds.');
  } else if (DRY_RUN) {
    console.log('\n(dry-run — no writes performed. Re-run without --dry-run to apply.)');
  }
})().catch(function (err) {
  console.error('\n✗ Backfill failed:', err.message || err);
  process.exit(1);
});
