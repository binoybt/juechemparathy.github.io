#!/usr/bin/env node
/**
 * mirror-auth.js
 *
 * One-off admin backfill script.
 *
 * Iterates every Firebase Authentication user in this project and writes /
 * merges their profile into the Firestore `users/{uid}` collection. This is
 * what makes the tournament captain-picker able to find people who signed
 * up before the tournament portal existed, or who haven't opened the
 * tournament pages yet.
 *
 * The tournament page (`tournament.js`) also writes to `users/{uid}` on
 * every browser sign-in via `upsertUserProfile`, so this script only needs
 * to be run occasionally — typically once, to backfill everyone who
 * pre-dated the mirror logic.
 *
 * The mirror is idempotent: it uses `set({merge: true})` so re-runs never
 * clobber fields the browser has written.
 *
 * Credentials
 * ───────────
 * Three ways to authenticate, in order of preference:
 *
 * 1. GOOGLE CLOUD SHELL (easiest — no key file at all):
 *      gcloud config set project smash-26679
 *      npm install firebase-admin
 *      node mirror-auth.js
 *    Application Default Credentials (ADC) are inherited from your gcloud
 *    session. Zero secrets on disk.
 *
 * 2. LOCAL WITH A SERVICE-ACCOUNT KEY FILE:
 *      FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/key.json node mirror-auth.js
 *
 * 3. LOCAL WITH THE ENV VAR CONVENTION USED BY backup.js:
 *      FIREBASE_SERVICE_ACCOUNT=<raw JSON> node mirror-auth.js
 *      FIREBASE_SERVICE_ACCOUNT=<base64 JSON> node mirror-auth.js
 *
 * Download a service-account JSON from
 *   Firebase Console → Project Settings → Service Accounts →
 *   Generate new private key.
 *
 * When using ADC (#1) you can force the project via env:
 *   GOOGLE_CLOUD_PROJECT=smash-26679 node mirror-auth.js
 *
 * Flags
 * ─────
 *   --dry-run    List what would be written but don't touch Firestore.
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

const DRY_RUN = process.argv.includes('--dry-run');

// ── Credentials ──────────────────────────────────────────────────────────
// Returns either { credential: <parsed JSON>, source: 'file'|'env' }
// or { credential: null, source: 'adc' } if no explicit key is provided
// (in which case we rely on Application Default Credentials — this is the
// mode Cloud Shell / GCE / Cloud Build all use).
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
  // Fall through to ADC.
  return { credential: null, source: 'adc' };
}

function resolveProjectId(credential) {
  if (credential && credential.project_id) return credential.project_id;
  if (process.env.GOOGLE_CLOUD_PROJECT)    return process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.GCLOUD_PROJECT)          return process.env.GCLOUD_PROJECT;
  return null;
}

// ── Name splitting (mirror of splitName in tournament.js) ────────────────
function splitName(displayName) {
  const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length)      return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function buildProfile(user) {
  const { firstName, lastName } = splitName(user.displayName);
  const tsFromISO = function (iso) {
    return iso
      ? admin.firestore.Timestamp.fromDate(new Date(iso))
      : admin.firestore.FieldValue.serverTimestamp();
  };
  return {
    uid:            user.uid,
    email:          (user.email || '').toLowerCase(),
    displayName:    user.displayName || '',
    firstName:      firstName,
    lastName:       lastName,
    firstNameLower: firstName.toLowerCase(),
    lastNameLower:  lastName.toLowerCase(),
    photoURL:       user.photoURL || '',
    firstLoginAt:   tsFromISO(user.metadata && user.metadata.creationTime),
    lastLoginAt:    tsFromISO(user.metadata && user.metadata.lastSignInTime),
    mirroredFromAuthAt: admin.firestore.FieldValue.serverTimestamp()
  };
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
  const auth = admin.auth();
  const db   = admin.firestore();

  console.log('Project:  ' + projectId);
  console.log('Auth:     ' + (source === 'adc' ? 'Application Default Credentials (Cloud Shell / gcloud)' : 'service account (' + source + ')'));
  console.log('Dry run:  ' + DRY_RUN);
  console.log('Fetching users from Firebase Auth…\n');

  const BATCH_SIZE = 400;
  const PAGE_SIZE  = 1000;

  let pageToken = undefined;
  let totalUsers  = 0;
  let totalWrites = 0;

  do {
    const page = await auth.listUsers(PAGE_SIZE, pageToken);
    totalUsers += page.users.length;

    if (DRY_RUN) {
      page.users.forEach(function (u) {
        const { firstName, lastName } = splitName(u.displayName);
        console.log(
          '  ' + u.uid.padEnd(30) +
          ' ' + (u.email || '').padEnd(35) +
          ' → ' + (firstName + ' ' + lastName).trim()
        );
      });
    } else {
      for (let i = 0; i < page.users.length; i += BATCH_SIZE) {
        const slice = page.users.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        slice.forEach(function (u) {
          const ref = db.collection('users').doc(u.uid);
          batch.set(ref, buildProfile(u), { merge: true });
        });
        await batch.commit();
        totalWrites += slice.length;
        process.stdout.write('\r  Mirrored ' + totalWrites + ' / ' + totalUsers + ' users…');
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(DRY_RUN ? '' : '\n');
  console.log('✓ Done.');
  console.log('  Auth users listed:  ' + totalUsers);
  if (!DRY_RUN) {
    console.log('  Firestore writes:   ' + totalWrites);
    console.log('\nOpen the tournament captain picker — the "users collection" pill');
    console.log('should now show the same count.');
  } else {
    console.log('\n(dry-run — no writes performed. Re-run without --dry-run to apply.)');
  }
})().catch(function (err) {
  console.error('\n✗ Mirror failed:', err.message || err);
  process.exit(1);
});
