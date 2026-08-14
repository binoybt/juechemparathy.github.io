



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
//      (members.csv + Firestore additionalMembers collection)
//   4. if they can't be matched, forces a blocking onboarding modal that
//      collects First name / Last name / Family ID and either verifies them
//      instantly or opens a pendingRegistrations doc for an admin to review
//   5. exposes a role-aware SmashAuth API on window.SmashAuth that all
//      other pages use to gate admin UI (see JSDoc below for the shape)
//   6. shows a small admin banner if there are pending reviews
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

  // ── Members directory (members.csv + additionalMembers) ───────────────
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
      out.push({
        familyId:   (cols[idx.familyId]   || '').trim(),
        firstName:  (cols[idx.firstName]  || '').trim(),
        lastName:   (cols[idx.lastName]   || '').trim(),
        familyName: (cols[idx.familyName] || '').trim(),
        memberId:   (cols[idx.memberId]   || '').trim(),
        _source:    'csv'
      });
    }
    return out;
  }

  async function loadMembersCsv() {
    if (membersCache) return membersCache;
    try {
      const cached = sessionStorage.getItem('smash.membersCsv');
      if (cached) { membersCache = parseMembersCsv(cached); return membersCache; }
    } catch (_) {}
    const res = await fetch('members.csv', { cache: 'no-cache' });
    if (!res.ok) throw new Error('members.csv HTTP ' + res.status);
    const text = await res.text();
    try { sessionStorage.setItem('smash.membersCsv', text); } catch (_) {}
    membersCache = parseMembersCsv(text);
    return membersCache;
  }

  async function loadAdditionalMembers() {
    if (additionalMembersCache) return additionalMembersCache;
    try {
      const snap = await db.collection('additionalMembers').get();
      const out = [];
      snap.forEach(function (d) {
        const v = d.data() || {};
        out.push({
          docId:      d.id,
          familyId:   String(v.familyId   || '').trim(),
          firstName:  String(v.firstName  || '').trim(),
          lastName:   String(v.lastName   || '').trim(),
          familyName: String(v.familyName || '').trim(),
          memberId:   String(v.memberId   || '').trim(),
          _source:    'firestore'
        });
      });
      additionalMembersCache = out;
    } catch (err) {
      console.warn('[onboarding] additionalMembers read failed (continuing with members.csv only):', err);
      additionalMembersCache = [];
    }
    return additionalMembersCache;
  }

  async function findMemberMatch(firstName, lastName, familyId) {
    const list = (await loadMembersCsv()).concat(await loadAdditionalMembers());
    const fn = normKey(firstName), ln = normKey(lastName), fid = normKey(familyId);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (normKey(m.firstName) === fn &&
          normKey(m.lastName)  === ln &&
          normKey(m.familyId)  === fid) {
        return m;
      }
    }
    return null;
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
    if (isVerifiedDoc(doc)) { hideOnboardingModal(); return; }

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
              await db.collection('users').doc(user.uid).set({
                verified:       true,
                verifiedAt:     FV.serverTimestamp(),
                firstName:      match.firstName,
                lastName:       match.lastName,
                firstNameLower: match.firstName.toLowerCase(),
                lastNameLower:  match.lastName.toLowerCase(),
                familyId:       match.familyId,
                familyName:     match.familyName,
                memberId:       match.memberId,
                pendingRegistrationId: FV.delete()
              }, { merge: true });
              hideOnboardingModal();
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
        '<div class="smash-ob-field"><label>Family ID (per parishioner directory)</label>' +
          '<input id="smashObFid" type="text" value="' +
          esc((submitted && submitted.familyId) || '') +
          '" inputmode="numeric" placeholder="e.g. 42" /></div>' +
        '<div id="smashObMsg"></div>' +
        '<div class="smash-ob-actions">' +
          '<button type="button" class="smash-ob-btn" id="smashObSignOut">Sign out</button>' +
          '<button type="button" class="smash-ob-btn primary" id="smashObSubmit">Continue</button>' +
        '</div>' +
        '<p class="smash-ob-note">Not sure of your Family ID? Ask another family ' +
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
          '<div>Family ID: ' + esc(p.familyId || '—') + '</div>' +
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
      msg.innerHTML = '<div class="smash-ob-error">First name, last name, and Family ID are all required.</div>';
      return;
    }

    const submitBtn = box.querySelector('#smashObSubmit');
    submitBtn.disabled = true; submitBtn.textContent = 'Checking…';

    try {
      additionalMembersCache = null;
      const match = await findMemberMatch(fn, ln, fid);
      if (match) {
        await db.collection('users').doc(user.uid).set({
          verified:       true,
          verifiedAt:     FV.serverTimestamp(),
          firstName:      match.firstName,
          lastName:       match.lastName,
          firstNameLower: match.firstName.toLowerCase(),
          lastNameLower:  match.lastName.toLowerCase(),
          familyId:       match.familyId,
          familyName:     match.familyName,
          memberId:       match.memberId,
          pendingRegistrationId: FV.delete()
        }, { merge: true });
        hideOnboardingModal();
        return;
      }

      const payload = {
        uid:               user.uid,
        email:             (user.email || '').toLowerCase(),
        googleDisplayName: user.displayName || '',
        firstName:         fn,
        lastName:          ln,
        familyId:          fid,
        submittedAt:       FV.serverTimestamp(),
        status:            'pending'
      };
      const ref = await db.collection('pendingRegistrations').add(payload);
      await db.collection('users').doc(user.uid).set({
        pendingRegistrationId: ref.id,
        pendingSubmittedAt:    FV.serverTimestamp(),
        pendingFirstName:      fn,
        pendingLastName:       ln,
        pendingFamilyId:       fid
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
    findMemberMatch:       findMemberMatch,
    loadMembersCsv:        loadMembersCsv,
    loadAdditionalMembers: loadAdditionalMembers,
    invalidateCaches:      function () { membersCache = null; additionalMembersCache = null; }
  };
})();
