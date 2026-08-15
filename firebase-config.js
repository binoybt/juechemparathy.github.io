



const firebaseConfig = {
  apiKey: "AIzaSyDQbVnLH0A6uL-N43ptBVNI4hDB3BE2Rls",
  authDomain: "smash-26679.firebaseapp.com",
  projectId: "smash-26679",
  storageBucket: "smash-26679.firebasestorage.app",
  messagingSenderId: "877402703377",
  appId: "1:877402703377:web:65db65464dbd385f6b53b0",
};


firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

/* OPTIONAL: restrict to your domain in Firebase console:
   Authentication → Settings → Authorized domains → add:
   - localhost
   - yourusername.github.io
*/

// ── Admin role bootstrap ────────────────────────────────────────────────
// The rest of the app checks users/{uid}.role === 'admin' — email addresses
// are NEVER hard-coded elsewhere. This tiny list only exists so the first
// four SMASH admins can self-promote on their very first sign-in with this
// version of the code. Once each of them has signed in once (or after any
// admin has promoted them from admin-users.html) this list can be emptied
// without affecting the site.
const SMASH_ADMIN_BOOTSTRAP_EMAILS = [
  'jue.george@gmail.com',
  'binoybt@gmail.com',
  'geojins@gmail.com',
  'b.ajaymathews@gmail.com'
];

const ONBOARDING_ADMIN_PAGE = 'pending-users.html';

// ── Site-wide sign-in gate + role tracker ───────────────────────────────
// Runs on every page (every HTML includes this file) and:
//   1. mirrors any signed-in user's Google profile into users/{uid}
//   2. bootstraps role: existing admins in SMASH_ADMIN_BOOTSTRAP_EMAILS get
//      role='admin' on next sign-in; everyone else defaults to role='member'
//   3. verifies the user against the SMASH parishioner directory
//      (Firestore `members` collection, plus legacy additionalMembers)
//   4. if they can't be matched, forces a blocking onboarding modal that
//      collects First name / Last name / FID and either verifies them
//      instantly or opens a pendingRegistrations doc for an admin to review
//      On a directory match, users/{uid}.FID is stored. A second Google
//      account claiming the same person is blocked.
//   5. exposes a role-aware SmashAuth API on window.SmashAuth that all
//      other pages use to gate admin UI (see JSDoc below for the shape)
//   6. shows a small admin banner if there are pending reviews
//   7. tracks Tournament page visibility (admin-only vs everyone) via
//      siteConfig/tournament.openToEveryone and hides .js-tournament-nav
//      links until an admin opens it
//
// FIRESTORE RULES (paste into your rules editor):
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//
//       function isSignedIn() { return request.auth != null; }
//
//       function myRole() {
//         return exists(/databases/$(database)/documents/users/$(request.auth.uid))
//           ? get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role
//           : null;
//       }
//
//       function isAdmin() {
//         return isSignedIn() && myRole() == 'admin';
//       }
//
//       match /users/{uid} {
//         allow read:   if isSignedIn();
//         allow create: if isSignedIn() && request.auth.uid == uid;
//         // A user can update their own doc but cannot touch the role field.
//         // Admins can change anything on any doc.
//         allow update: if isSignedIn() && (
//                         (request.auth.uid == uid &&
//                          !request.resource.data.diff(resource.data)
//                             .affectedKeys().hasAny(['role'])) ||
//                         isAdmin()
//                       );
//         allow delete: if isAdmin();
//       }
//
//       match /pendingRegistrations/{docId} {
//         allow create: if isSignedIn()
//                        && request.resource.data.uid == request.auth.uid;
//         allow read, update, delete: if isAdmin();
//       }
//
//       match /additionalMembers/{docId} {
//         allow read:  if isSignedIn();
//         allow write: if isAdmin();
//       }
//
//       // Parishioner directory (replaces public members.csv).
//       match /members/{id} {
//         allow read:  if isSignedIn();
//         allow write: if isAdmin();
//       }
//
//       // One Google account per parishioner (memberId or FID+name).
//       match /identityClaims/{id} {
//         allow get:    if isSignedIn();
//         allow list:   if isAdmin();
//         allow create: if isSignedIn() && request.resource.data.uid == request.auth.uid;
//         allow update, delete: if isAdmin();
//       }
//
//       // Tournament page only. Collection "siteConfig" is just a folder
//       // name; document "tournament" is the one yes/no switch for whether
//       // members can open Tournament. This does not affect any other page.
//       // Missing doc / openToEveryone != true = admin testing only.
//       match /siteConfig/tournament {
//         allow read:  if true;
//         allow write: if isAdmin();
//       }
//     }
//   }
(function () {
  const FV = firebase.firestore.FieldValue;

  // ── Helpers ────────────────────────────────────────────────────────────
  function splitName(displayName) {
    const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length)      return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  function normKey(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  function isBootstrapAdminEmail(email) {
    return !!(email && SMASH_ADMIN_BOOTSTRAP_EMAILS.indexOf(String(email).toLowerCase()) !== -1);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function onOnboardingReviewPage() {
    const path = (window.location && window.location.pathname) || '';
    return path.endsWith('/' + ONBOARDING_ADMIN_PAGE) || path.endsWith(ONBOARDING_ADMIN_PAGE);
  }

  // ── SmashAuth (role-aware auth state exposed to every page) ───────────
  // Shape passed to onChange listeners:
  //   { user: User|null, role: 'admin'|'member'|null, isAdmin: bool, loading: bool }
  // Pages should treat loading=true as "unknown yet, don't render admin UI".
  const state = { user: null, role: null, isAdmin: false, loading: true };
  const listeners = [];
  let userDocUnsub = null;

  function notify() {
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](Object.assign({}, state)); }
      catch (err) { console.error('[SmashAuth] listener threw:', err); }
    }
  }

  function setState(patch) {
    Object.assign(state, patch);
    state.isAdmin = (state.role === 'admin');
    notify();
  }

  function subscribeToUserDoc(uid) {
    if (userDocUnsub) { try { userDocUnsub(); } catch (_) {} userDocUnsub = null; }
    userDocUnsub = db.collection('users').doc(uid).onSnapshot(function (snap) {
      const d = snap.exists ? (snap.data() || {}) : {};
      setState({ role: d.role || 'member', loading: false });
    }, function (err) {
      console.warn('[SmashAuth] users/' + uid + ' snapshot failed:', err);
      setState({ role: null, loading: false });
    });
  }

  window.SmashAuth = {
    /** True if a listener has been registered before we resolved auth. */
    get currentUser()  { return state.user;  },
    get currentRole()  { return state.role;  },
    /** Convenience: SmashAuth.isAdmin() */
    isAdmin: function () { return state.isAdmin; },
    /** Convenience: SmashAuth.isSignedIn() */
    isSignedIn: function () { return !!state.user; },
    /** True until the users/{uid} role snapshot has resolved. */
    isLoading: function () { return state.loading; },
    /** Register a callback; fires immediately with current state, then
     *  on every auth or role change. Returns an unsubscribe fn. */
    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.push(cb);
      try { cb(Object.assign({}, state)); } catch (err) { console.error(err); }
      return function () {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    /** Admin action: mark another user as admin. */
    promoteToAdmin: async function (uid) {
      if (!state.isAdmin) throw new Error('Only admins can promote.');
      await db.collection('users').doc(uid).set({
        role:      'admin',
        roleSetAt: FV.serverTimestamp(),
        roleSetBy: (state.user && state.user.email) || 'unknown'
      }, { merge: true });
    },
    /** Admin action: demote another user back to member. */
    demoteFromAdmin: async function (uid) {
      if (!state.isAdmin) throw new Error('Only admins can demote.');
      if (state.user && state.user.uid === uid) {
        throw new Error("You can't revoke your own admin access.");
      }
      await db.collection('users').doc(uid).set({
        role:      'member',
        roleSetAt: FV.serverTimestamp(),
        roleSetBy: (state.user && state.user.email) || 'unknown'
      }, { merge: true });
    }
  };

  // ── Tournament visibility (admin testing vs everyone) ─────────────────
  // Only the Tournament page is gated. Firestore path:
  //   collection "siteConfig"  (a settings folder; unused for other pages)
  //   document   "tournament"  (one field: openToEveryone true/false)
  // Default is admin-only. A missing doc, a failed read, or
  // openToEveryone !== true all keep Tournament private. Admins flip the
  // flag from the banner on tournament.html.
  const tournamentAccess = {
    openToEveryone: false,
    loaded: false,
    listeners: [],
    unsub: null
  };

  function applyTournamentNavVisibility() {
    const show = !!(window.SmashAuth && SmashAuth.isAdmin()) || tournamentAccess.openToEveryone;
    document.querySelectorAll('.js-tournament-nav').forEach(function (el) {
      el.hidden = !show;
    });
  }

  function notifyTournamentAccess() {
    const payload = {
      openToEveryone: tournamentAccess.openToEveryone,
      loaded: tournamentAccess.loaded
    };
    tournamentAccess.listeners.forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[TournamentAccess] listener threw:', err); }
    });
    applyTournamentNavVisibility();
  }

  function subscribeTournamentAccess() {
    if (tournamentAccess.unsub) {
      try { tournamentAccess.unsub(); } catch (_) {}
      tournamentAccess.unsub = null;
    }
    tournamentAccess.unsub = db.collection('siteConfig').doc('tournament').onSnapshot(function (snap) {
      tournamentAccess.loaded = true;
      const d = snap.exists ? (snap.data() || {}) : {};
      tournamentAccess.openToEveryone = d.openToEveryone === true;
      notifyTournamentAccess();
    }, function (err) {
      console.warn('[TournamentAccess] siteConfig/tournament read failed:', err);
      tournamentAccess.loaded = true;
      tournamentAccess.openToEveryone = false;
      notifyTournamentAccess();
    });
  }

  window.TournamentAccess = {
    isOpenToEveryone: function () { return tournamentAccess.openToEveryone; },
    isLoaded: function () { return tournamentAccess.loaded; },
    canSeeNav: function (isAdmin) { return !!isAdmin || tournamentAccess.openToEveryone; },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      tournamentAccess.listeners.push(fn);
      if (tournamentAccess.loaded) {
        try { fn({ openToEveryone: tournamentAccess.openToEveryone, loaded: true }); } catch (err) { console.error(err); }
      }
      return function () {
        const i = tournamentAccess.listeners.indexOf(fn);
        if (i !== -1) tournamentAccess.listeners.splice(i, 1);
      };
    },
    setOpenToEveryone: function (open) {
      if (!window.SmashAuth || !SmashAuth.isAdmin()) {
        return Promise.reject(new Error('Only admins can change tournament visibility.'));
      }
      return db.collection('siteConfig').doc('tournament').set({
        openToEveryone: !!open,
        updatedAt: FV.serverTimestamp(),
        updatedBy: (auth.currentUser && auth.currentUser.uid) || null
      }, { merge: true });
    }
  };

  subscribeTournamentAccess();
  auth.onAuthStateChanged(function () { subscribeTournamentAccess(); });
  window.SmashAuth.onChange(function () { applyTournamentNavVisibility(); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTournamentNavVisibility);
  } else {
    applyTournamentNavVisibility();
  }

  // ── Members directory (Firestore `members` + legacy additionalMembers) ─
  let membersCache = null;
  let additionalMembersCache = null;

  function parseMembersCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map(function (h) { return h.trim(); });
    const idx = {
      familyId:   header.indexOf('Family ID'),
      firstName:  header.indexOf('Firstname'),
      lastName:   header.indexOf('Lastname'),
      familyName: header.indexOf('Family Name'),
      memberId:   header.indexOf('Member ID')
    };
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const familyId = (cols[idx.familyId] || '').trim();
      out.push({
        familyId:   familyId,
        FID:        familyId,
        firstName:  (cols[idx.firstName]  || '').trim(),
        lastName:   (cols[idx.lastName]   || '').trim(),
        familyName: (cols[idx.familyName] || '').trim(),
        memberId:   (cols[idx.memberId]   || '').trim(),
        _source:    'csv'
      });
    }
    return out;
  }

  function memberDocId(m) {
    const mid = String((m && m.memberId) || '').trim();
    if (mid) return mid;
    return 'n_' + [normKey(m && (m.familyId || m.FID)), normKey(m && m.firstName), normKey(m && m.lastName)].join('_');
  }

  function memberDocPayload(m, extra) {
    const fid = String((m && (m.FID || m.familyId)) || '').trim();
    const firstName = String((m && m.firstName) || '').trim();
    const lastName = String((m && m.lastName) || '').trim();
    const familyName = String((m && m.familyName) || '').trim();
    const memberId = String((m && m.memberId) || '').trim();
    return Object.assign({
      FID: fid,
      familyId: fid,
      firstName: firstName,
      lastName: lastName,
      familyName: familyName,
      memberId: memberId,
      firstNameLower: firstName.toLowerCase(),
      lastNameLower: lastName.toLowerCase(),
      search: (firstName + ' ' + lastName + ' ' + familyName).toLowerCase()
    }, extra || {});
  }

  function normalizeMemberRecord(v, docId, source) {
    const fid = String((v && (v.FID || v.familyId)) || '').trim();
    const firstName = String((v && v.firstName) || '').trim();
    const lastName = String((v && v.lastName) || '').trim();
    const familyName = String((v && v.familyName) || '').trim();
    return {
      docId:      docId || '',
      familyId:   fid,
      FID:        fid,
      firstName:  firstName,
      lastName:   lastName,
      familyName: familyName,
      memberId:   String((v && v.memberId) || docId || '').trim(),
      search:     String((v && v.search) || (firstName + ' ' + lastName + ' ' + familyName)).toLowerCase(),
      _source:    source || 'firestore'
    };
  }

  async function loadAdditionalMembers() {
    if (additionalMembersCache) return additionalMembersCache;
    try {
      const snap = await db.collection('additionalMembers').get();
      const out = [];
      snap.forEach(function (d) {
        out.push(normalizeMemberRecord(d.data() || {}, d.id, 'additionalMembers'));
      });
      additionalMembersCache = out;
    } catch (err) {
      console.warn('[onboarding] additionalMembers read failed:', err);
      additionalMembersCache = [];
    }
    return additionalMembersCache;
  }

  async function loadMembersDirectory() {
    if (membersCache) return membersCache;
    const out = [];
    try {
      const snap = await db.collection('members').get();
      snap.forEach(function (d) {
        out.push(normalizeMemberRecord(d.data() || {}, d.id, 'members'));
      });
    } catch (err) {
      console.warn('[onboarding] members collection read failed:', err);
    }
    const extra = await loadAdditionalMembers();
    extra.forEach(function (m) {
      const dup = out.some(function (x) {
        if (m.memberId && x.memberId && m.memberId === x.memberId) return true;
        return normKey(x.firstName) === normKey(m.firstName) &&
               normKey(x.lastName) === normKey(m.lastName) &&
               normKey(x.familyId) === normKey(m.familyId);
      });
      if (!dup) out.push(m);
    });
    membersCache = out;
    return membersCache;
  }

  // Kept as an alias — pending-users.html and tournament.js call this name.
  async function loadMembersCsv() {
    return loadMembersDirectory();
  }

  async function importMembersFromRows(rows) {
    if (!window.SmashAuth || !SmashAuth.isAdmin()) {
      throw new Error('Only admins can import the parishioner directory.');
    }
    const list = rows || [];
    let written = 0;
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      list.slice(i, i + 400).forEach(function (m) {
        const id = memberDocId(m);
        if (!id || id === 'n__') return;
        batch.set(db.collection('members').doc(id), memberDocPayload(m, {
          importedAt: FV.serverTimestamp(),
          importedBy: (auth.currentUser && auth.currentUser.email) || ''
        }), { merge: true });
        written++;
      });
      await batch.commit();
    }
    membersCache = null;
    return { written: written, total: list.length };
  }

  async function importMembersFromCsvText(text) {
    return importMembersFromRows(parseMembersCsv(text));
  }

  async function findMemberMatch(firstName, lastName, familyId) {
    const list = await loadMembersDirectory();
    const fn = normKey(firstName), ln = normKey(lastName), fid = normKey(familyId);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (normKey(m.firstName) === fn &&
          normKey(m.lastName)  === ln &&
          (normKey(m.familyId) === fid || normKey(m.FID) === fid)) {
        return m;
      }
    }
    return null;
  }

  function identityClaimKey(match) {
    const mid = String((match && match.memberId) || '').trim();
    if (mid) return 'mid:' + mid;
    return 'name:' + [
      normKey(match && (match.FID || match.familyId)),
      normKey(match && match.firstName),
      normKey(match && match.lastName)
    ].join('|');
  }

  function verifiedMemberPayload(match) {
    const fid = String((match && (match.FID || match.familyId)) || '').trim();
    return {
      verified:       true,
      verifiedAt:     FV.serverTimestamp(),
      firstName:      match.firstName,
      lastName:       match.lastName,
      firstNameLower: String(match.firstName || '').toLowerCase(),
      lastNameLower:  String(match.lastName || '').toLowerCase(),
      familyId:       fid,
      FID:            fid,
      familyName:     match.familyName || '',
      memberId:       String(match.memberId || '').trim(),
      pendingRegistrationId: FV.delete()
    };
  }

  async function findExistingUserClaim(match, currentUid) {
    const fid = String((match && (match.FID || match.familyId)) || '').trim();
    const fn = normKey(match && match.firstName);
    const ln = normKey(match && match.lastName);
    const mid = String((match && match.memberId) || '').trim();
    let found = null;
    function consider(d) {
      if (!d || d.id === currentUid || found) return;
      const v = d.data() || {};
      if (mid && String(v.memberId || '').trim() === mid) {
        found = Object.assign({ uid: d.id }, v);
        return;
      }
      const vFid = String(v.FID || v.familyId || '').trim();
      if (fid && vFid === fid && normKey(v.firstName) === fn && normKey(v.lastName) === ln) {
        found = Object.assign({ uid: d.id }, v);
      }
    }
    if (mid) {
      try {
        (await db.collection('users').where('memberId', '==', mid).get()).forEach(consider);
      } catch (err) {
        console.warn('[onboarding] memberId claim lookup failed:', err);
      }
    }
    if (!found && fid) {
      const variants = [fid];
      if (/^\d+$/.test(fid)) variants.push(Number(fid));
      for (let i = 0; i < variants.length && !found; i++) {
        const val = variants[i];
        try {
          (await db.collection('users').where('FID', '==', val).get()).forEach(consider);
        } catch (err) {
          console.warn('[onboarding] FID claim lookup failed:', err);
        }
        if (found) break;
        try {
          (await db.collection('users').where('familyId', '==', val).get()).forEach(consider);
        } catch (err) {
          console.warn('[onboarding] familyId claim lookup failed:', err);
        }
      }
    }
    return found;
  }

  async function claimIdentity(user, match) {
    const key = identityClaimKey(match);
    if (!key || key === 'name:||') return { ok: true };
    const ref = db.collection('identityClaims').doc(key);
    const payload = {
      uid:      user.uid,
      email:    (user.email || '').toLowerCase(),
      FID:      String((match && (match.FID || match.familyId)) || '').trim(),
      firstName: match.firstName || '',
      lastName:  match.lastName || '',
      memberId:  String((match && match.memberId) || '').trim(),
      claimedAt: FV.serverTimestamp()
    };
    try {
      await db.runTransaction(function (tx) {
        return tx.get(ref).then(function (snap) {
          if (snap.exists) {
            const d = snap.data() || {};
            if (d.uid && d.uid !== user.uid) {
              const err = new Error('IDENTITY_CLAIMED');
              err.claimedBy = d;
              throw err;
            }
            return;
          }
          tx.set(ref, payload);
        });
      });
      return { ok: true };
    } catch (err) {
      if (err && (err.message === 'IDENTITY_CLAIMED' || err.claimedBy)) {
        return { ok: false, claimedBy: err.claimedBy || {} };
      }
      throw err;
    }
  }

  function showBlockedOverlay(claimedBy) {
    ensureStyles();
    hideOnboardingModal();
    const prev = document.getElementById('smashClaimBlocked');
    if (prev) prev.remove();
    const overlay = document.createElement('div');
    overlay.className = 'smash-ob-overlay';
    overlay.id = 'smashClaimBlocked';
    const box = document.createElement('div');
    box.className = 'smash-ob-box';
    const other = (claimedBy && claimedBy.email) ? claimedBy.email : 'another Google account';
    box.innerHTML =
      '<h2>This parishioner is already registered</h2>' +
      '<p class="smash-ob-sub">' +
        'FID, first name, and last name already belong to a signed-in SMASH account. ' +
        'A second login with a different email is blocked.' +
      '</p>' +
      '<div class="smash-ob-error">' +
        'Already registered with <strong>' + esc(other) + '</strong>. ' +
        'Sign in with that Google account. If this is a mistake, contact a SMASH admin.' +
      '</div>' +
      '<div class="smash-ob-actions">' +
        '<button type="button" class="smash-ob-btn primary" id="smashClaimOk">OK</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('#smashClaimOk').addEventListener('click', function () {
      overlay.remove();
    });
  }

  async function blockDuplicateLogin(claimedBy) {
    try { await auth.signOut(); } catch (_) {}
    showBlockedOverlay(claimedBy || {});
  }

  async function verifyUserWithMatch(user, match) {
    const existing = await findExistingUserClaim(match, user.uid);
    if (existing) {
      await blockDuplicateLogin(existing);
      return false;
    }
    let claim = { ok: true };
    try {
      claim = await claimIdentity(user, match);
    } catch (err) {
      console.warn('[onboarding] identityClaims write failed (add Firestore rules for /identityClaims):', err);
    }
    if (!claim.ok) {
      await blockDuplicateLogin(claim.claimedBy);
      return false;
    }
    await db.collection('users').doc(user.uid).set(verifiedMemberPayload(match), { merge: true });
    return true;
  }

  async function backfillFidAndClaim(user, doc) {
    if (!user || !doc) return;
    const fid = String(doc.FID || doc.familyId || '').trim();
    if (!fid) return;
    const patch = {};
    if (!doc.FID) patch.FID = fid;
    if (doc.familyId == null || doc.familyId === '') patch.familyId = fid;
    if (Object.keys(patch).length) {
      try { await db.collection('users').doc(user.uid).set(patch, { merge: true }); } catch (_) {}
    }
    try {
      await claimIdentity(user, {
        FID: fid,
        familyId: fid,
        firstName: doc.firstName || '',
        lastName: doc.lastName || '',
        memberId: doc.memberId || ''
      });
    } catch (_) {}
  }

  // ── Profile mirror + role bootstrap ───────────────────────────────────
  async function mirrorUserProfileAndBootstrapRole(user) {
    if (!user || !user.uid) return null;
    const nm = splitName(user.displayName);
    const ref = db.collection('users').doc(user.uid);
    const payload = {
      uid:            user.uid,
      email:          (user.email || '').toLowerCase(),
      displayName:    user.displayName || '',
      firstName:      nm.firstName,
      lastName:       nm.lastName,
      firstNameLower: nm.firstName.toLowerCase(),
      lastNameLower:  nm.lastName.toLowerCase(),
      photoURL:       user.photoURL || '',
      lastLoginAt:    FV.serverTimestamp()
    };
    let existing = null;
    try {
      const s = await ref.get();
      existing = s.exists ? (s.data() || {}) : null;
    } catch (err) {
      console.warn('[SmashAuth] users doc read failed:', err);
    }
    if (!existing) payload.firstLoginAt = FV.serverTimestamp();

    // Do not overwrite directory-verified name / FID from Google displayName.
    if (existing && (existing.verified || existing.FID || existing.familyId || existing.memberId)) {
      delete payload.firstName;
      delete payload.lastName;
      delete payload.firstNameLower;
      delete payload.lastNameLower;
    }

    // Bootstrap role. Never downgrade admins here — only stamp when missing.
    const bootstrapAdmin = isBootstrapAdminEmail(user.email);
    if (bootstrapAdmin && (!existing || existing.role !== 'admin')) {
      payload.role      = 'admin';
      payload.roleSetAt = FV.serverTimestamp();
      payload.roleSetBy = 'bootstrap';
    } else if (!existing || !existing.role) {
      payload.role      = 'member';
      payload.roleSetAt = FV.serverTimestamp();
      payload.roleSetBy = existing ? 'default-migration' : 'default-signup';
    }

    try {
      await ref.set(payload, { merge: true });
    } catch (err) {
      console.error('[firebase-config] user profile mirror FAILED — check Firestore rules for /users/{uid}:', err);
    }
    return payload.role || (existing && existing.role) || 'member';
  }

  // ── Verification check ────────────────────────────────────────────────
  function isVerifiedDoc(d) {
    if (!d) return false;
    if (d.verified === true)   return true;
    if (d.mirroredFromAuthAt)  return true;   // grandfathered by mirror-auth.js
    return false;
  }

  async function readUserDoc(uid) {
    try {
      const d = await db.collection('users').doc(uid).get();
      return d.exists ? (d.data() || {}) : null;
    } catch (err) {
      console.error('[onboarding] users/' + uid + ' read failed:', err);
      return null;
    }
  }

  async function checkOnboarding(user) {
    if (!user) { hideOnboardingModal(); return; }
    // Never gate the admin review page itself.
    if (onOnboardingReviewPage() && (state.isAdmin || isBootstrapAdminEmail(user.email))) {
      hideOnboardingModal();
      return;
    }
    // Admins are trusted and never see the onboarding modal.
    if (state.isAdmin || isBootstrapAdminEmail(user.email)) {
      try {
        await db.collection('users').doc(user.uid).set({
          verified:   true,
          verifiedAt: FV.serverTimestamp(),
          verifiedBy: 'admin-auto'
        }, { merge: true });
      } catch (_) {}
      hideOnboardingModal();
      return;
    }

    const doc = await readUserDoc(user.uid);
    if (isVerifiedDoc(doc)) {
      await backfillFidAndClaim(user, doc);
      hideOnboardingModal();
      return;
    }

    if (doc && doc.pendingRegistrationId) {
      try {
        const p = await db.collection('pendingRegistrations').doc(doc.pendingRegistrationId).get();
        const pd = p.exists ? (p.data() || {}) : null;
        if (pd) {
          if (pd.status === 'accepted') {
            additionalMembersCache = null;
            const match = await findMemberMatch(
              pd.firstName || doc.firstName || '',
              pd.lastName  || doc.lastName  || '',
              pd.familyId  || ''
            );
            if (match) {
              const ok = await verifyUserWithMatch(user, match);
              if (ok) hideOnboardingModal();
              return;
            }
            showOnboardingModal(user, 'form', {
              submitted: pd,
              hint: 'A SMASH admin approved your request. Please re-enter your details to finish signing in.'
            });
            return;
          }
          if (pd.status === 'rejected') {
            showOnboardingModal(user, 'rejected', pd);
            return;
          }
          showOnboardingModal(user, 'pending', pd);
          return;
        }
      } catch (err) {
        console.warn('[onboarding] pendingRegistrations read failed:', err);
      }
    }

    showOnboardingModal(user, 'form', { submitted: null });
  }

  // ── Modal DOM ─────────────────────────────────────────────────────────
  const MODAL_ID = 'smashOnboardingModal';
  const STYLE_ID = 'smashOnboardingStyles';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.smash-ob-overlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.72);' +
        'display:flex;align-items:center;justify-content:center;padding:16px;' +
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;}" +
      '.smash-ob-box{background:#fff;color:#1f2937;max-width:480px;width:100%;border-radius:16px;' +
        'box-shadow:0 24px 48px rgba(0,0,0,.3);padding:28px;max-height:92vh;overflow-y:auto;}' +
      '.smash-ob-box h2{margin:0 0 8px 0;font-size:1.35rem;color:#111827;}' +
      '.smash-ob-sub{color:#6b7280;font-size:.95rem;line-height:1.45;margin-bottom:20px;}' +
      '.smash-ob-field{margin-bottom:14px;}' +
      '.smash-ob-field label{display:block;font-weight:600;font-size:.85rem;color:#374151;margin-bottom:6px;}' +
      '.smash-ob-field input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;' +
        'font-size:.95rem;box-sizing:border-box;}' +
      '.smash-ob-field input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15);}' +
      '.smash-ob-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap;}' +
      '.smash-ob-btn{padding:10px 18px;border-radius:8px;border:1px solid #d1d5db;background:#fff;' +
        'font-weight:600;font-size:.95rem;cursor:pointer;transition:all .15s;}' +
      '.smash-ob-btn:hover{background:#f3f4f6;}' +
      '.smash-ob-btn.primary{background:#3b82f6;border-color:#3b82f6;color:#fff;}' +
      '.smash-ob-btn.primary:hover{background:#2563eb;}' +
      '.smash-ob-btn:disabled{opacity:.6;cursor:not-allowed;}' +
      '.smash-ob-error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;' +
        'padding:10px 12px;border-radius:8px;font-size:.9rem;margin-top:12px;}' +
      '.smash-ob-info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;' +
        'padding:10px 12px;border-radius:8px;font-size:.9rem;margin-top:12px;}' +
      '.smash-ob-note{color:#6b7280;font-size:.82rem;margin-top:12px;line-height:1.5;}' +
      '.smash-ob-user{display:flex;align-items:center;gap:10px;margin-bottom:16px;' +
        'padding:10px 12px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;}' +
      '.smash-ob-user img{width:32px;height:32px;border-radius:999px;object-fit:cover;}' +
      '.smash-ob-user-meta{font-size:.82rem;color:#6b7280;}' +
      '.smash-ob-user-meta strong{display:block;color:#111827;font-size:.95rem;font-weight:700;}' +
      '.smash-ob-admin-banner{position:fixed;top:12px;right:12px;z-index:9998;' +
        'background:#fef3c7;color:#78350f;border:1px solid #fbbf24;padding:10px 14px;border-radius:10px;' +
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
        'font-size:.85rem;font-weight:600;box-shadow:0 6px 16px rgba(0,0,0,.12);' +
        'display:none;align-items:center;gap:10px;}' +
      '.smash-ob-admin-banner a{color:#92400e;text-decoration:underline;}';
    document.head.appendChild(s);
  }

  function hideOnboardingModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
  }

  function userChipHtml(user) {
    return '<div class="smash-ob-user">' +
      (user.photoURL ? '<img src="' + esc(user.photoURL) + '" alt="" />' : '') +
      '<div class="smash-ob-user-meta">' +
        '<strong>' + esc(user.displayName || user.email || '') + '</strong>' +
        esc(user.email || '') +
      '</div>' +
    '</div>';
  }

  function showOnboardingModal(user, mode, data) {
    ensureStyles();
    hideOnboardingModal();

    const overlay = document.createElement('div');
    overlay.className = 'smash-ob-overlay';
    overlay.id = MODAL_ID;
    const box = document.createElement('div');
    box.className = 'smash-ob-box';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const suggested = splitName(user.displayName);

    if (mode === 'form') {
      const submitted = (data && data.submitted) || null;
      const hint = (data && data.hint)
        ? '<div class="smash-ob-info">' + esc(data.hint) + '</div>' : '';
      box.innerHTML =
        '<h2>Welcome — one quick verification</h2>' +
        '<p class="smash-ob-sub">' +
          "You're signed in but we don't yet have you in the SMASH parishioner " +
          'directory. Please confirm your details so we can link this account.' +
        '</p>' +
        userChipHtml(user) +
        hint +
        '<div class="smash-ob-field"><label>First name</label>' +
          '<input id="smashObFirst" type="text" value="' +
          esc((submitted && submitted.firstName) || suggested.firstName) +
          '" autocomplete="given-name" /></div>' +
        '<div class="smash-ob-field"><label>Last name</label>' +
          '<input id="smashObLast" type="text" value="' +
          esc((submitted && submitted.lastName) || suggested.lastName) +
          '" autocomplete="family-name" /></div>' +
        '<div class="smash-ob-field"><label>FID (Family ID from the parishioner directory)</label>' +
          '<input id="smashObFid" type="text" value="' +
          esc((submitted && (submitted.FID || submitted.familyId)) || '') +
          '" inputmode="numeric" placeholder="e.g. 42" /></div>' +
        '<div id="smashObMsg"></div>' +
        '<div class="smash-ob-actions">' +
          '<button type="button" class="smash-ob-btn" id="smashObSignOut">Sign out</button>' +
          '<button type="button" class="smash-ob-btn primary" id="smashObSubmit">Continue</button>' +
        '</div>' +
        '<p class="smash-ob-note">Not sure of your FID? Ask another family ' +
        'member or contact a SMASH admin.</p>';

      box.querySelector('#smashObSubmit').addEventListener('click', function () {
        submitFromForm(user);
      });
      box.querySelector('#smashObSignOut').addEventListener('click', function () {
        auth.signOut();
      });
      ['smashObFirst','smashObLast','smashObFid'].forEach(function (id) {
        box.querySelector('#' + id).addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); submitFromForm(user); }
        });
      });
    }
    else if (mode === 'pending') {
      const p = data || {};
      box.innerHTML =
        '<h2>Waiting for admin review</h2>' +
        '<p class="smash-ob-sub">' +
          "Thanks — we've logged your details and a SMASH admin will review " +
          "them shortly. You'll be able to sign in normally once they add " +
          'you to the parishioner directory.' +
        '</p>' +
        userChipHtml(user) +
        '<div class="smash-ob-info">' +
          '<div><strong>Submitted:</strong></div>' +
          '<div>' + esc(p.firstName || '') + ' ' + esc(p.lastName || '') + '</div>' +
          '<div>FID: ' + esc(p.FID || p.familyId || '—') + '</div>' +
        '</div>' +
        '<div class="smash-ob-actions">' +
          '<button type="button" class="smash-ob-btn" id="smashObSignOut">Sign out</button>' +
          '<button type="button" class="smash-ob-btn primary" id="smashObRetry">Check again</button>' +
        '</div>' +
        "<p class=\"smash-ob-note\">If you haven't heard back within a day, please " +
        'contact a SMASH admin.</p>';
      box.querySelector('#smashObSignOut').addEventListener('click', function () { auth.signOut(); });
      box.querySelector('#smashObRetry').addEventListener('click', function () {
        additionalMembersCache = null;
        checkOnboarding(user);
      });
    }
    else if (mode === 'rejected') {
      const p = data || {};
      box.innerHTML =
        '<h2>Registration not approved</h2>' +
        '<p class="smash-ob-sub">' +
          'A SMASH admin reviewed your request but was unable to match it to a ' +
          'parishioner. Please contact a SMASH admin for help.' +
        '</p>' +
        userChipHtml(user) +
        '<div class="smash-ob-error">' +
          '<strong>Reason:</strong> ' + esc(p.rejectReason || '(no reason provided)') +
        '</div>' +
        '<div class="smash-ob-actions">' +
          '<button type="button" class="smash-ob-btn" id="smashObSignOut">Sign out</button>' +
          '<button type="button" class="smash-ob-btn primary" id="smashObAgain">Try again</button>' +
        '</div>';
      box.querySelector('#smashObSignOut').addEventListener('click', function () { auth.signOut(); });
      box.querySelector('#smashObAgain').addEventListener('click', function () {
        showOnboardingModal(user, 'form', { submitted: p });
      });
    }
  }

  async function submitFromForm(user) {
    const box = document.querySelector('#' + MODAL_ID + ' .smash-ob-box');
    if (!box) return;
    const fn  = (box.querySelector('#smashObFirst').value || '').trim();
    const ln  = (box.querySelector('#smashObLast').value  || '').trim();
    const fid = (box.querySelector('#smashObFid').value   || '').trim();
    const msg = box.querySelector('#smashObMsg');
    msg.innerHTML = '';

    if (!fn || !ln || !fid) {
      msg.innerHTML = '<div class="smash-ob-error">First name, last name, and FID are all required.</div>';
      return;
    }

    const submitBtn = box.querySelector('#smashObSubmit');
    submitBtn.disabled = true; submitBtn.textContent = 'Checking…';

    try {
      additionalMembersCache = null;
      membersCache = null;
      const match = await findMemberMatch(fn, ln, fid);
      if (match) {
        const ok = await verifyUserWithMatch(user, match);
        if (ok) hideOnboardingModal();
        return;
      }

      const payload = {
        uid:               user.uid,
        email:             (user.email || '').toLowerCase(),
        googleDisplayName: user.displayName || '',
        firstName:         fn,
        lastName:          ln,
        familyId:          fid,
        FID:               fid,
        submittedAt:       FV.serverTimestamp(),
        status:            'pending'
      };
      const ref = await db.collection('pendingRegistrations').add(payload);
      await db.collection('users').doc(user.uid).set({
        pendingRegistrationId: ref.id,
        pendingSubmittedAt:    FV.serverTimestamp(),
        pendingFirstName:      fn,
        pendingLastName:       ln,
        pendingFamilyId:       fid,
        pendingFID:            fid
      }, { merge: true });
      showOnboardingModal(user, 'pending', payload);
    } catch (err) {
      console.error('[onboarding] submit failed:', err);
      msg.innerHTML = '<div class="smash-ob-error">Something went wrong: ' +
        esc(err && err.message ? err.message : err) + '</div>';
      submitBtn.disabled = false; submitBtn.textContent = 'Continue';
    }
  }

  // ── Admin banner (pending review count) ───────────────────────────────
  let bannerEl = null;
  let bannerUnsub = null;

  function stopAdminBanner() {
    if (bannerUnsub) { try { bannerUnsub(); } catch (_) {} bannerUnsub = null; }
    if (bannerEl)    { bannerEl.remove(); bannerEl = null; }
  }

  function startAdminBanner() {
    if (bannerUnsub) return;
    if (onOnboardingReviewPage()) return;
    ensureStyles();
    bannerEl = document.createElement('div');
    bannerEl.className = 'smash-ob-admin-banner';
    document.body.appendChild(bannerEl);
    try {
      bannerUnsub = db.collection('pendingRegistrations')
        .where('status', '==', 'pending')
        .onSnapshot(function (snap) {
          const n = snap.size;
          if (n > 0) {
            bannerEl.innerHTML =
              '<span>' + n + ' user' + (n === 1 ? '' : 's') + ' awaiting review</span>' +
              '<a href="' + ONBOARDING_ADMIN_PAGE + '">Review</a>';
            bannerEl.style.display = 'flex';
          } else {
            bannerEl.style.display = 'none';
          }
        }, function (err) {
          console.warn('[onboarding] admin banner subscribe failed:', err);
        });
    } catch (err) {
      console.warn('[onboarding] admin banner setup failed:', err);
    }
  }

  // ── Auth wiring ───────────────────────────────────────────────────────
  auth.onAuthStateChanged(async function (user) {
    if (!user) {
      if (userDocUnsub) { try { userDocUnsub(); } catch (_) {} userDocUnsub = null; }
      setState({ user: null, role: null, loading: false });
      hideOnboardingModal();
      stopAdminBanner();
      return;
    }

    // Publish the user immediately so pages can start rendering; role
    // arrives shortly after via the users doc snapshot.
    setState({ user: user, role: null, loading: true });

    await mirrorUserProfileAndBootstrapRole(user);
    subscribeToUserDoc(user.uid);

    // Admin banner + onboarding both need to react to role, so they'll
    // re-run when the snapshot arrives. But we can start onboarding right
    // now (it's tolerant of role being unresolved).
    await checkOnboarding(user);
  });

  // Once role resolves, start/stop admin-only features.
  window.SmashAuth.onChange(function (s) {
    if (!s.user) { stopAdminBanner(); return; }
    if (s.isAdmin) startAdminBanner();
    else           stopAdminBanner();
  });

  // Expose helpers so pending-users.html can reuse the same directory logic.
  window.__smashOnboarding = {
    findMemberMatch:          findMemberMatch,
    loadMembersCsv:           loadMembersCsv,
    loadMembersDirectory:     loadMembersDirectory,
    loadAdditionalMembers:    loadAdditionalMembers,
    parseMembersCsv:          parseMembersCsv,
    importMembersFromCsvText: importMembersFromCsvText,
    importMembersFromRows:    importMembersFromRows,
    memberDocId:              memberDocId,
    memberDocPayload:         memberDocPayload,
    invalidateCaches:         function () { membersCache = null; additionalMembersCache = null; }
  };
})();
