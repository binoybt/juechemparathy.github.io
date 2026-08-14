


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

// ── Auto-mirror signed-in users into Firestore `users/{uid}` ─────────────
// Every page in the site includes this file, so this listener fires on any
// page after a Google sign-in and mirrors the person's identity into a
// Firestore doc keyed by their Firebase Auth uid. That doc is what the
// tournament captain picker searches.
//
// Idempotent: uses set({merge:true}) so re-runs never clobber existing
// fields. firstLoginAt is only stamped on the very first write.
(function () {
  function splitName(displayName) {
    const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length)      return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  async function mirrorUserProfile(user) {
    if (!user || !user.uid) return;
    const { firstName, lastName } = splitName(user.displayName);
    const ref = db.collection('users').doc(user.uid);
    const FV  = firebase.firestore.FieldValue;
    const payload = {
      uid:            user.uid,
      email:          (user.email || '').toLowerCase(),
      displayName:    user.displayName || '',
      firstName:      firstName,
      lastName:       lastName,
      firstNameLower: firstName.toLowerCase(),
      lastNameLower:  lastName.toLowerCase(),
      photoURL:       user.photoURL || '',
      lastLoginAt:    FV.serverTimestamp()
    };
    try {
      let firstEver = true;
      try {
        const existing = await ref.get();
        firstEver = !existing.exists;
      } catch (_) { /* proceed as if first-ever */ }
      if (firstEver) payload.firstLoginAt = FV.serverTimestamp();
      await ref.set(payload, { merge: true });
      console.log('[firebase-config] mirrored user profile:', payload.email);
    } catch (err) {
      console.error('[firebase-config] user profile mirror FAILED — check Firestore rules for /users/{uid}:', err);
    }
  }

  auth.onAuthStateChanged(function (user) {
    if (user) mirrorUserProfile(user);
  });
})();
