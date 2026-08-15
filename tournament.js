/* Church Tournament — single-page app powering /tournament.html
 *
 * URL routing (all views live on tournament.html):
 *   /tournament.html                          → list of all tournaments
 *   /tournament.html?create=1                 → create a new tournament (admin)
 *   /tournament.html?t=<id>                   → tournament view (sport tabs)
 *   /tournament.html?t=<id>&sport=<sportId>   → tournament view scoped to a sport
 *   /tournament.html?t=<id>&manage=1          → edit tournament config (admin)
 *
 * Firestore layout:
 *   tournaments/{docId}
 *     name          string   — admin-entered
 *     format        'teams' | 'individual'
 *     teams[]       { id, name, wards }             — only for teams format
 *     sports[]      see SPORT_TEMPLATES below       — configurable per tournament
 *       schedule    { draft, published }            — per-sport fixture list
 *                     draft.entries[]     working copy (admin only)
 *                     published.entries[] public copy (visible after Publish)
 *       rules       { text, updatedAt, updatedBy }  — sport-specific, admin-edit
 *     rules         { text, updatedAt, updatedBy }  — tournament-wide, admin-edit
 *     archived      bool
 *     createdAt / updatedAt / createdBy
 *
 * Site-wide visibility (firebase-config.js TournamentAccess):
 *   siteConfig/tournament { openToEveryone: bool }
 *     missing/false → admin testing only; true → all signed-in members
 *
 *   tournament_matches/{docId}
 *     tournamentId  string
 *     sport         string  (matches sports[].id)
 *     stage         'league' | 'semifinal' | 'final' | 'third_place'
 *     teamA / teamB     — for teams format
 *     playerA / playerB — for individual format
 *     scheduledAt   ISO string
 *     venue         string
 *     status        'scheduled' | 'in_progress' | 'completed'
 *     winner        'A' | 'B' | 'tie' | null
 *     scoringConfig snapshot of the stage's scoring rules at match-creation time
 *
 *     Racket sports:  games[]  { category, playersA, playersB, sets[{a,b}], status, winner }
 *     Volleyball:     sets[]   { a, b }
 *     Basketball:     quarters[] { a, b }
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG / CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Admin access is granted via users/{uid}.role === 'admin' (managed on
  // admin-users.html). state.isAdmin is kept in sync by a SmashAuth.onChange
  // subscription set up in init(); this file no longer contains any admin
  // email list.

  // Default team roster copied into every new "teams"-format tournament.
  const DEFAULT_TEAMS = [
    { id: 'G1', name: 'G1', wards: 'St.Euphrasia / St.Paul' },
    { id: 'G2', name: 'G2', wards: 'St.Francis' },
    { id: 'G3', name: 'G3', wards: 'St.Mary / St.Chavara / St.Antony' },
    { id: 'G4', name: 'G4', wards: 'St.Joseph / St.Thomas' }
  ];
  const TEAM_COLORS = ['#f97316', '#06b6d4', '#22c55e', '#8b5cf6', '#ec4899', '#f59e0b'];

  // Ready-made templates admins can add when creating/editing a tournament.
  const SPORT_TEMPLATES = {
    badminton:   { id: 'badminton',   label: 'Badminton',    emoji: '🏸', kind: 'racket',     color: '#06b6d4', heroA: '#06b6d4', heroB: '#0e7490' },
    pickleball:  { id: 'pickleball',  label: 'Pickleball',   emoji: '🥒', kind: 'racket',     color: '#22c55e', heroA: '#22c55e', heroB: '#15803d' },
    tabletennis: { id: 'tabletennis', label: 'Table Tennis', emoji: '🏓', kind: 'racket',     color: '#8b5cf6', heroA: '#8b5cf6', heroB: '#5b21b6' },
    volleyball:  { id: 'volleyball',  label: 'Volleyball',   emoji: '🏐', kind: 'volleyball', color: '#d946ef', heroA: '#d946ef', heroB: '#86198f' },
    basketball:  { id: 'basketball',  label: 'Basketball',   emoji: '🏀', kind: 'basketball', color: '#f97316', heroA: '#f97316', heroB: '#c2410c' }
  };

  const CUSTOM_KINDS = [
    { kind: 'racket',     label: 'Racket / Paddle (multi-category sets)' },
    { kind: 'volleyball', label: 'Set-based (best-of-3, deuce cap)' },
    { kind: 'basketball', label: 'Time-based (quarters, cumulative score)' }
  ];

  const STAGES = ['league', 'semifinal', 'final', 'third_place'];
  const STAGE_LABEL = { league: 'League', semifinal: 'Semifinal', final: 'Final', third_place: '3rd Place' };
  const STATUS_LABEL = { scheduled: 'Scheduled', in_progress: 'Live', completed: 'Completed' };

  const DEFAULT_CATEGORIES = ['OD1', 'OD2', 'XD1', 'XD2', 'WD'];
  const CATEGORY_LABEL = {
    OD1: 'Open Doubles 1', OD2: 'Open Doubles 2',
    XD1: 'Mixed Doubles 1', XD2: 'Mixed Doubles 2',
    WD:  'Women\'s Doubles',
    OD:  'Open Doubles',   XD:  'Mixed Doubles',
    MS:  'Men\'s Singles', WS:  'Women\'s Singles'
  };

  // Default per-stage scoring — used when adding a sport to a new tournament.
  function defaultScoring(kind) {
    if (kind === 'basketball') {
      const q = { quarters: 4, quarterMinutes: 7 };
      return { league: { ...q }, semifinal: { ...q }, final: { ...q }, third_place: { ...q } };
    }
    if (kind === 'volleyball') {
      const league = { bestOf: 3, target: 21, cap: 25, decidingTarget: 15, decidingCap: 20 };
      return { league, semifinal: { ...league }, final: { ...league }, third_place: { ...league } };
    }
    // racket
    return {
      league:      { bestOf: 1, target: 21, cap: 25 },
      semifinal:   { bestOf: 3, target: 21, cap: 25 },
      final:       { bestOf: 3, target: 21, cap: 25 },
      third_place: { bestOf: 3, target: 21, cap: 25 }
    };
  }

  function sportTemplateForConfig(templateId, opts) {
    const tpl = SPORT_TEMPLATES[templateId];
    if (!tpl) return null;
    return {
      id: tpl.id,
      label: tpl.label,
      kind: tpl.kind,
      emoji: tpl.emoji,
      color: tpl.color,
      date: '',
      hasThirdPlace: true,
      categories: tpl.kind === 'racket' ? [...DEFAULT_CATEGORIES] : [],
      // Each sport now owns its own team roster. If defaults are provided
      // (e.g. seeding Koinonia), we pre-populate G1–G4.
      teams: (opts && opts.teams) ? JSON.parse(JSON.stringify(opts.teams)) : [],
      scoring: defaultScoring(tpl.kind)
    };
  }

  // Which stages are enabled for a given sport within a tournament.
  // League / Semifinal / Final are always available; 3rd Place is opt-in.
  function enabledStagesFor(sportConfig) {
    const stages = ['league', 'semifinal', 'final'];
    if (sportConfig && sportConfig.hasThirdPlace !== false) stages.push('third_place');
    return stages;
  }

  // Resolves the team roster for a given sport within a tournament.
  //
  // Teams now live per-sport (sport.teams). For backward compatibility we
  // fall back to any tournament-level `teams` array from the previous data
  // model, so existing Koinonia docs keep rendering correctly until the
  // admin saves the tournament again (which drops the legacy field).
  function teamsFor(tournament, sportOrId) {
    if (!tournament) return [];
    const sport = typeof sportOrId === 'string'
      ? getSportConfig(tournament, sportOrId)
      : sportOrId;
    if (sport && Array.isArray(sport.teams) && sport.teams.length) return sport.teams;
    if (Array.isArray(tournament.teams) && tournament.teams.length) return tournament.teams;
    return [];
  }

  function newId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyScheduleEntry(overrides) {
    return Object.assign({
      id: newId('slot'),
      stage: 'league',
      a: '',
      b: '',
      scheduledAt: '',
      venue: '',
      matchId: ''
    }, overrides || {});
  }

  function sanitizeScheduleEntries(entries) {
    return (entries || []).map(function (e) {
      return {
        id: e.id || newId('slot'),
        stage: e.stage || 'league',
        a: String(e.a || ''),
        b: String(e.b || ''),
        scheduledAt: e.scheduledAt || '',
        venue: String(e.venue || ''),
        matchId: e.matchId || ''
      };
    });
  }

  function getSchedule(sport) {
    const sch = (sport && sport.schedule) || {};
    return {
      draft: sch.draft || null,
      published: sch.published || null
    };
  }

  function scheduleIsPublished(sport) {
    const pub = getSchedule(sport).published;
    return !!(pub && Array.isArray(pub.entries) && pub.entries.length);
  }

  // Koinonia seed used when the tournament list is empty and admin clicks "Seed".
  function koinoniaSeed() {
    const teams = JSON.parse(JSON.stringify(DEFAULT_TEAMS));
    return {
      name: 'Koinonia 2026',
      format: 'teams',
      sports: [
        sportTemplateForConfig('badminton',   { teams: teams }),
        sportTemplateForConfig('pickleball',  { teams: teams }),
        sportTemplateForConfig('tabletennis', { teams: teams }),
        sportTemplateForConfig('volleyball',  { teams: teams }),
        sportTemplateForConfig('basketball',  { teams: teams })
      ],
      archived: false
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIREBASE HANDLES
  // ═══════════════════════════════════════════════════════════════════════════

  const db = firebase.firestore();
  const auth = firebase.auth();
  const FieldValue = firebase.firestore.FieldValue;

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    });
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function toast(msg, type) {
    type = type || 'success';
    let t = document.getElementById('tToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'tToast';
      t.className = 't-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 't-toast ' + type + ' show';
    clearTimeout(t._to);
    t._to = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  function fmtDateTime(iso) {
    if (!iso) return 'TBD';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fmtDate(iso) {
    if (!iso) return 'TBD';
    const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function toDatetimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromDatetimeLocal(str) {
    return str ? new Date(str).toISOString() : '';
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTING
  // ═══════════════════════════════════════════════════════════════════════════

  function parseUrl() {
    const params = new URLSearchParams(location.search);
    const t = params.get('t');
    const sport = params.get('sport');
    const view = params.get('create') === '1' ? 'create'
                : params.get('manage') === '1' && t ? 'manage'
                : t ? 'tournament'
                : 'list';
    return { view, tournamentId: t || null, sportId: sport || null };
  }

  function navigate(params, opts) {
    const search = new URLSearchParams();
    if (params.tournamentId) search.set('t', params.tournamentId);
    if (params.sportId) search.set('sport', params.sportId);
    if (params.view === 'manage') search.set('manage', '1');
    if (params.view === 'create') search.set('create', '1');
    const qs = search.toString();
    const url = 'tournament.html' + (qs ? '?' + qs : '');
    if (opts && opts.replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    render();
  }

  window.addEventListener('popstate', function () { render(); });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  function signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    auth.signInWithPopup(provider)
      .catch(function (err) {
        const code = (err && err.code) || '';
        if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user'
            || code === 'auth/cancelled-popup-request'
            || code === 'auth/operation-not-supported-in-this-environment') {
          toast('Popup blocked — redirecting to Google…', 'info');
          auth.signInWithRedirect(provider).catch(function (e2) {
            toast('Sign-in failed: ' + (e2.message || e2.code), 'error');
          });
          return;
        }
        if (code === 'auth/unauthorized-domain') {
          toast('This domain isn\'t in Firebase Authorized Domains.', 'error');
          return;
        }
        toast('Sign-in failed: ' + (err.message || code), 'error');
      });
  }

  function signOut() {
    auth.signOut();
  }

  window.__tournament = { signIn: signIn, signOut: signOut, navigate: navigate };

  auth.getRedirectResult().catch(function (err) {
    if (err && err.code === 'auth/unauthorized-domain') {
      toast('This domain isn\'t in Firebase Authorized Domains.', 'error');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════════

  const state = {
    user: null,
    isAdmin: false,
    authLoading: true,
    tournaments: [],       // all tournaments (subscribed once)
    matches: [],           // matches for the current tournament only
    currentId: null,       // tournamentId currently subscribed for matches
    users: [],             // signed-in user profiles (from `users` collection)
    rsvpResponses: [],     // raw docs from rsvpResponses (existing app data)
    members: [],           // parishioner directory (Firestore `members` collection)
    membersLoaded: false,  // becomes true once CSV has been fetched and parsed
    unsubTournaments: null,
    unsubMatches: null,
    unsubUsers: null,
    unsubRsvp: null,
    ready: { tournaments: false, matches: false, users: false, rsvp: false },
    // Last error surfaced by each data source, for diagnostics in the UI.
    errors: { users: null, rsvp: null, upsert: null }
  };

  // Flipped to true once auth.onAuthStateChanged has fired at least once,
  // so we can distinguish "still restoring session" from "definitely signed out".
  let sessionInitialized = false;

  // Tracks which live-data modal is currently on-screen so that async data
  // arrivals (users snapshot, directory load) can re-render it in place.
  // Values: null | 'userPicker' | 'memberPicker' | 'roster'.
  let openLiveModal = null;
  let openLiveModalContext = null; // arbitrary payload used by the re-renderer

  // ═══════════════════════════════════════════════════════════════════════════
  // PERMISSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Anyone who has signed in and thus has a profile in `users` counts as a
  // known-user. Admin can always do everything. A signed-in user who is also
  // the captain of a specific team can edit that team's roster.
  function currentUid() { return state.user ? state.user.uid : null; }

  function canEditTournamentConfig() { return state.isAdmin; }

  function canManageCaptains() { return state.isAdmin; }

  function canEditSchedule() { return state.isAdmin; }

  function tournamentOpenToEveryone() {
    return !!(window.TournamentAccess && TournamentAccess.isOpenToEveryone());
  }

  function canUseTournamentPage() {
    if (!state.user) return false;
    return !!(state.isAdmin || tournamentOpenToEveryone());
  }

  function tournamentAccessPending() {
    if (state.isAdmin || tournamentOpenToEveryone()) return false;
    if (state.authLoading) return true;
    if (window.TournamentAccess && !TournamentAccess.isLoaded()) return true;
    return false;
  }

  // Returns true if the current user is the captain of the given team.
  // Matches on Firebase uid when available; otherwise falls back to email so
  // captains assigned by name-only (from an rsvpResponse that predates their
  // Google sign-in) can still edit the roster once they authenticate.
  function isCaptainOf(team) {
    if (!team || !state.user) return false;
    if (team.captainUid && team.captainUid === state.user.uid) return true;
    if (team.captainEmail && state.user.email
        && team.captainEmail.toLowerCase() === (state.user.email || '').toLowerCase()) return true;
    return false;
  }

  function isRosterLocked(team) { return !!(team && team.locked); }

  // Identity helpers used both for "is this signed-in user on the roster?"
  // and for the one-team-per-sport uniqueness check when adding members.
  function namesEqual(a, b) {
    const af = String((a && a.firstName) || '').trim().toLowerCase();
    const al = String((a && a.lastName) || '').trim().toLowerCase();
    const bf = String((b && b.firstName) || '').trim().toLowerCase();
    const bl = String((b && b.lastName) || '').trim().toLowerCase();
    return !!(af && al && af === bf && al === bl);
  }

  function membersMatch(a, b) {
    if (!a || !b) return false;
    if (a.uid && b.uid && a.uid === b.uid) return true;
    if (a.email && b.email
        && String(a.email).toLowerCase() === String(b.email).toLowerCase()) return true;
    const aMid = String(a.memberId || '').trim();
    const bMid = String(b.memberId || '').trim();
    if (aMid && bMid && aMid === bMid) return true;
    if (!namesEqual(a, b)) return false;
    const aFid = String(a.familyId || '').trim();
    const bFid = String(b.familyId || '').trim();
    if (aFid && bFid) return aFid === bFid;
    // Names match and at least one side has no Family ID — treat as the
    // same person so we don't allow duplicates across teams.
    return true;
  }

  // Best-effort identity for the signed-in user, combining the users
  // profile, any RSVP record, Google display name, and the parishioner directory.
  function resolveCurrentMemberIdentity() {
    if (!state.user) return null;
    const uid = state.user.uid;
    const email = (state.user.email || '').toLowerCase();
    const profile = (state.users || []).find(function (u) { return u.uid === uid; }) || {};
    const rsvp = (state.rsvpResponses || []).find(function (r) {
      return (r.uid && r.uid === uid) || (r.email && r.email.toLowerCase() === email);
    }) || {};
    const split = splitName(state.user.displayName);
    const firstName = profile.firstName || rsvp.firstName || split.firstName || '';
    const lastName = profile.lastName || rsvp.lastName || split.lastName || '';
    const familyId = String(profile.familyId || rsvp.familyId || '').trim();
    let memberId = String(profile.memberId || '').trim();
    if (!memberId && state.membersLoaded && firstName && lastName) {
      const matches = state.members.filter(function (m) {
        if (!namesEqual(m, { firstName: firstName, lastName: lastName })) return false;
        if (!familyId) return true;
        return String(m.familyId || '').trim() === familyId;
      });
      if (matches.length === 1) memberId = String(matches[0].memberId || '').trim();
    }
    return { uid: uid, email: email, firstName: firstName, lastName: lastName, familyId: familyId, memberId: memberId };
  }

  function isRosterMemberOf(team) {
    if (!team || !state.user) return false;
    const me = resolveCurrentMemberIdentity();
    if (!me) return false;
    return (team.roster || []).some(function (r) { return membersMatch(me, r); });
  }

  // Within a sport, a person may belong to only one team. Returns the other
  // team that already lists `member`, or null if they are free to add.
  function findOtherTeamForMember(teams, teamId, member) {
    teams = Array.isArray(teams) ? teams : [];
    for (let i = 0; i < teams.length; i++) {
      const tm = teams[i];
      if (tm.id === teamId) continue;
      const hit = (tm.roster || []).some(function (r) { return membersMatch(member, r); });
      if (hit) return tm;
    }
    return null;
  }

  // Only admins can toggle the lock. Once locked, no captain can edit.
  function canLockRoster()      { return state.isAdmin; }

  // Edit permissions: admin any time; captain only when unlocked.
  function canEditRoster(team) {
    if (state.isAdmin) return true;
    if (isRosterLocked(team)) return false;
    return isCaptainOf(team);
  }

  // View permissions:
  //   admin                → always
  //   captain of team      → always (even before lock)
  //   member on the roster → always (their own team)
  //   any signed-in        → only when roster is locked AND the tournament has
  //                          opted in via revealLockedRosters
  function canViewRoster(tournament, team) {
    if (!state.user) return false;
    if (state.isAdmin) return true;
    if (isCaptainOf(team)) return true;
    if (isRosterMemberOf(team)) return true;
    if (isRosterLocked(team) && tournament && tournament.revealLockedRosters) return true;
    return false;
  }

  // Human-friendly explainer for why the current user can't view the roster.
  // Used in the "Roster hidden" placeholder on the team card.
  function whyCantView(tournament, team) {
    if (!state.user) return 'Sign in to view rosters.';
    const cap = team && (team.captainName || team.captainEmail);
    if (isRosterLocked(team) && !tournament.revealLockedRosters) {
      return 'Locked. Only team members, ' + (cap ? 'Captain ' + cap : 'the team captain') + ', or an admin can view.';
    }
    if (!isRosterLocked(team)) {
      return 'Not yet published. Only team members, ' + (cap ? 'Captain ' + cap : 'the team captain') + ', or an admin can view until the roster is locked.';
    }
    return 'Only team members, the team captain, or an admin can view.';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USER PROFILE (users/{uid}) — upserted on every login
  // ═══════════════════════════════════════════════════════════════════════════

  // Split a Google displayName into first + last. Some accounts have only a
  // single name; the admin can edit their profile later if needed.
  function splitName(displayName) {
    const parts = String(displayName || '').trim().split(/\s+/);
    if (!parts.length) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  // Persist the signed-in user's identity (email, name, photo) into the
  // `users/{uid}` doc. This is the ONLY place we write to that collection;
  // nothing here ever deletes. Uses `set({ merge: true })` so we can write
  // safely without a pre-read and so `firstLoginAt` (set only on the first
  // ever write) is never overwritten on subsequent logins.
  //
  // If profiles appear to "disappear on logout", the cause is almost always
  // Firestore security rules that only allow a user to read their own
  // `/users/{uid}` doc — so the moment they sign out, the collection reads
  // as empty. See the rules snippet in the README/setup docs; the required
  // rule is:
  //     match /users/{uid} {
  //       allow read:   if request.auth != null;
  //       allow create, update: if request.auth.uid == uid;
  //     }
  async function upsertUserProfile(user) {
    if (!user || !user.uid) return;
    const { firstName, lastName } = splitName(user.displayName);
    const ref = db.collection('users').doc(user.uid);
    const payload = {
      uid: user.uid,
      email: (user.email || '').toLowerCase(),
      displayName: user.displayName || '',
      firstName: firstName,
      lastName: lastName,
      firstNameLower: firstName.toLowerCase(),
      lastNameLower: lastName.toLowerCase(),
      photoURL: user.photoURL || '',
      lastLoginAt: FieldValue.serverTimestamp()
    };
    try {
      // Only stamp firstLoginAt if the doc doesn't exist yet. We swallow a
      // read failure (e.g. offline) and just set the field unconditionally;
      // subsequent merges will overwrite it — that's fine, the field is
      // informational only.
      let firstEver = true;
      try {
        const existing = await ref.get();
        firstEver = !existing.exists;
      } catch (_) { /* proceed as if first-ever */ }
      if (firstEver) payload.firstLoginAt = FieldValue.serverTimestamp();
      await ref.set(payload, { merge: true });
      state.errors.upsert = null;
      console.log('[tournament] user profile saved for', payload.email);
    } catch (err) {
      state.errors.upsert = err;
      console.error('[tournament] upsertUserProfile FAILED — check Firestore rules for /users/{uid}', err);
      toast('Could not save your profile — Firestore rules may need updating (' + (err.code || err.message || 'unknown') + ')', 'error');
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMBERS.CSV — parishioner directory (client-side cache)
  // ═══════════════════════════════════════════════════════════════════════════

  // Very small CSV parser: no quoted fields in our file, so a simple split
  // per line + comma is sufficient. If the CSV ever gains quoted commas
  // this will need upgrading.
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
      const fn = (cols[idx.firstName] || '').trim();
      const ln = (cols[idx.lastName]  || '').trim();
      out.push({
        familyId:   (cols[idx.familyId]   || '').trim(),
        firstName:  fn,
        lastName:   ln,
        familyName: (cols[idx.familyName] || '').trim(),
        memberId:   (cols[idx.memberId]   || '').trim(),
        // pre-computed lowercased haystack for fast filtering
        search: (fn + ' ' + ln + ' ' + (cols[idx.familyName] || '').trim()).toLowerCase()
      });
    }
    return out;
  }

  async function loadMembersCsv() {
    if (state.membersLoaded) return;
    try {
      let list = [];
      if (window.__smashOnboarding && typeof window.__smashOnboarding.loadMembersDirectory === 'function') {
        list = await window.__smashOnboarding.loadMembersDirectory();
      } else {
        const snap = await db.collection('members').get();
        snap.forEach(function (d) {
          const v = d.data() || {};
          list.push({
            familyId: String(v.FID || v.familyId || '').trim(),
            firstName: String(v.firstName || '').trim(),
            lastName: String(v.lastName || '').trim(),
            familyName: String(v.familyName || '').trim(),
            memberId: String(v.memberId || d.id || '').trim()
          });
        });
      }
      state.members = list.map(function (m) {
        const fn = String(m.firstName || '').trim();
        const ln = String(m.lastName || '').trim();
        const fam = String(m.familyName || '').trim();
        return {
          familyId: String(m.familyId || m.FID || '').trim(),
          FID: String(m.FID || m.familyId || '').trim(),
          firstName: fn,
          lastName: ln,
          familyName: fam,
          memberId: String(m.memberId || '').trim(),
          search: (fn + ' ' + ln + ' ' + fam).toLowerCase()
        };
      });
      state.membersLoaded = true;
      render();
      if (openLiveModal === 'memberPicker') rerenderMemberPicker();
      if (openLiveModal === 'roster') rerenderRoster();
    } catch (err) {
      console.error('[tournament] Failed to load parishioner directory:', err);
      toast('Could not load parishioner directory. Roster search will not work until an admin imports it.', 'error');
    }
  }

  function searchMembers(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return state.members.slice(0, 50);
    // If the query looks numeric, also match against Family ID / Member ID.
    const numeric = /^\d+$/.test(q);
    const out = [];
    for (const m of state.members) {
      if (out.length >= 100) break;
      if (m.search.indexOf(q) !== -1) { out.push(m); continue; }
      if (numeric && (m.familyId === q || m.memberId === q)) out.push(m);
    }
    return out;
  }

  // Union of everyone the app knows about — anyone who's ever RSVP'd (whether
  // or not they were signed in at the time) plus anyone whose profile lives
  // in the `users` collection. Deduped on Firebase uid when available,
  // otherwise on a normalized firstName+lastName+familyId key. The person
  // is "authenticatable" (i.e. can be assigned as captain and actually edit
  // the roster themselves) only if their record carries a uid or email
  // captured from a Google sign-in.
  function normKey(firstName, lastName, familyId) {
    return (String(firstName || '') + '|' + String(lastName || '') + '|' + String(familyId || ''))
      .toLowerCase().trim();
  }

  function getKnownPeople() {
    const byKey = new Map();

    function upsert(rec) {
      const uidKey = rec.uid ? ('U:' + rec.uid) : null;
      const nameKey = 'N:' + normKey(rec.firstName, rec.lastName, rec.familyId);
      // Prefer uid identity when we have one — merge onto that record.
      const primaryKey = uidKey || nameKey;
      const existing = byKey.get(primaryKey) || byKey.get(nameKey);
      if (existing) {
        // Merge — richer source wins per field.
        existing.uid       = existing.uid       || rec.uid       || '';
        existing.email     = existing.email     || rec.email     || '';
        existing.firstName = existing.firstName || rec.firstName || '';
        existing.lastName  = existing.lastName  || rec.lastName  || '';
        existing.familyId  = existing.familyId  || rec.familyId  || '';
        existing.memberId  = existing.memberId  || rec.memberId  || '';
        existing.photoURL  = existing.photoURL  || rec.photoURL  || '';
        existing.sources   = Array.from(new Set([...(existing.sources || []), rec.source]));
        // Re-key under the uid-preferred key so future lookups converge.
        if (uidKey && byKey.get(nameKey) === existing) byKey.delete(nameKey);
        byKey.set(primaryKey, existing);
      } else {
        byKey.set(primaryKey, Object.assign({}, rec, { sources: [rec.source] }));
      }
    }

    // Source 1: rsvpResponses (existing app data — most people are here).
    (state.rsvpResponses || []).forEach(function (r) {
      upsert({
        uid:       r.uid || '',
        email:     (r.email || '').toLowerCase(),
        firstName: r.firstName || '',
        lastName:  r.lastName || '',
        familyId:  r.familyId != null ? String(r.familyId) : '',
        photoURL:  '',
        source:    'rsvp'
      });
    });

    // Source 2: users collection (portal sign-ins).
    (state.users || []).forEach(function (u) {
      upsert({
        uid:       u.uid || '',
        email:     (u.email || '').toLowerCase(),
        firstName: u.firstName || '',
        lastName:  u.lastName || '',
        familyId:  u.familyId != null ? String(u.familyId) : '',
        memberId:  u.memberId != null ? String(u.memberId) : '',
        photoURL:  u.photoURL || '',
        source:    'portal'
      });
    });

    const out = [];
    byKey.forEach(function (v) {
      // Skip records with no usable name at all.
      if (!v.firstName && !v.lastName) return;
      v.firstNameLower = (v.firstName || '').toLowerCase();
      v.lastNameLower  = (v.lastName  || '').toLowerCase();
      v.hasLogin       = !!(v.uid || v.email);
      out.push(v);
    });
    out.sort(function (a, b) {
      // People with a Google login first, then alphabetical.
      if (a.hasLogin !== b.hasLogin) return a.hasLogin ? -1 : 1;
      return (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName);
    });
    return out;
  }

  function searchPeople(query) {
    const people = getKnownPeople();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return people.slice(0, 50);
    const numeric = /^\d+$/.test(q);
    return people.filter(function (p) {
      if (p.firstNameLower.indexOf(q) !== -1) return true;
      if (p.lastNameLower.indexOf(q) !== -1) return true;
      if ((p.email || '').indexOf(q) !== -1) return true;
      if (numeric && p.familyId === q) return true;
      return false;
    }).slice(0, 100);
  }

  function currentTournament() {
    const parsed = parseUrl();
    if (!parsed.tournamentId) return null;
    return state.tournaments.find(function (t) { return t.id === parsed.tournamentId; }) || null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCORING LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  function racketSetWinner(set, cfg) {
    const target = (cfg && cfg.target) || 21;
    const cap = (cfg && cfg.cap) || (target + 4);
    const a = set.a || 0, b = set.b || 0;
    if (a >= target && a - b >= 2) return 'A';
    if (b >= target && b - a >= 2) return 'B';
    if (a >= cap) return 'A';
    if (b >= cap) return 'B';
    return null;
  }

  function racketGameWinner(game, cfg) {
    const bestOf = (cfg && cfg.bestOf) || 1;
    const need = Math.ceil(bestOf / 2);
    let a = 0, b = 0;
    (game.sets || []).forEach(function (s) {
      const w = racketSetWinner(s, cfg);
      if (w === 'A') a++; else if (w === 'B') b++;
    });
    if (a >= need) return 'A';
    if (b >= need) return 'B';
    return null;
  }

  function racketMatchWinner(match, tournament) {
    const sportCfg = getSportConfig(tournament, match.sport);
    const cats = (sportCfg && sportCfg.categories && sportCfg.categories.length) ? sportCfg.categories : DEFAULT_CATEGORIES;
    const need = Math.ceil(cats.length / 2);
    let a = 0, b = 0;
    (match.games || []).forEach(function (g) {
      if (g.winner === 'A') a++; else if (g.winner === 'B') b++;
    });
    if (a >= need) return 'A';
    if (b >= need) return 'B';
    return null;
  }

  function volleyballSetWinner(set, cfg, isDeciding) {
    const target = isDeciding ? (cfg.decidingTarget || 15) : (cfg.target || 21);
    const cap = isDeciding ? (cfg.decidingCap || 20) : (cfg.cap || 25);
    const a = set.a || 0, b = set.b || 0;
    if (a >= target && a - b >= 2) return 'A';
    if (b >= target && b - a >= 2) return 'B';
    if (a >= cap) return 'A';
    if (b >= cap) return 'B';
    return null;
  }

  function volleyballMatchWinner(match, cfg) {
    const bestOf = (cfg && cfg.bestOf) || 3;
    const need = Math.ceil(bestOf / 2);
    let a = 0, b = 0;
    const sets = match.sets || [];
    sets.forEach(function (s, i) {
      const isDeciding = i === bestOf - 1;
      const w = volleyballSetWinner(s, cfg, isDeciding);
      if (w === 'A') a++; else if (w === 'B') b++;
    });
    if (a >= need) return 'A';
    if (b >= need) return 'B';
    return null;
  }

  function basketballTotals(match) {
    let a = 0, b = 0;
    (match.quarters || []).forEach(function (q) { a += (q.a || 0); b += (q.b || 0); });
    return { a: a, b: b };
  }

  function basketballWinner(match, cfg) {
    const totalQuarters = (cfg && cfg.quarters) || 4;
    const t = basketballTotals(match);
    if ((match.quarters || []).length >= totalQuarters && t.a !== t.b) return t.a > t.b ? 'A' : 'B';
    return null;
  }

  function getSportConfig(tournament, sportId) {
    if (!tournament) return null;
    return (tournament.sports || []).find(function (s) { return s.id === sportId; }) || null;
  }

  function getStageScoring(tournament, sportId, stage) {
    const sc = getSportConfig(tournament, sportId);
    if (!sc) return null;
    return (sc.scoring && sc.scoring[stage]) || (sc.scoring && sc.scoring.league) || defaultScoring(sc.kind)[stage];
  }

  function matchWinner(match, tournament) {
    const sc = getSportConfig(tournament, match.sport);
    if (!sc) return null;
    const cfg = getStageScoring(tournament, match.sport, match.stage);
    if (sc.kind === 'racket') return racketMatchWinner(match, tournament);
    if (sc.kind === 'volleyball') return volleyballMatchWinner(match, cfg);
    if (sc.kind === 'basketball') return basketballWinner(match, cfg);
    return null;
  }

  function matchScoreDisplay(match, tournament) {
    const sc = getSportConfig(tournament, match.sport);
    if (!sc) return { a: '—', b: '—' };
    if (sc.kind === 'racket') {
      let a = 0, b = 0;
      (match.games || []).forEach(function (g) { if (g.winner === 'A') a++; else if (g.winner === 'B') b++; });
      return { a: String(a), b: String(b), label: 'Games' };
    }
    if (sc.kind === 'volleyball') {
      const cfg = getStageScoring(tournament, match.sport, match.stage);
      const bestOf = (cfg && cfg.bestOf) || 3;
      let a = 0, b = 0;
      (match.sets || []).forEach(function (s, i) {
        const w = volleyballSetWinner(s, cfg, i === bestOf - 1);
        if (w === 'A') a++; else if (w === 'B') b++;
      });
      return { a: String(a), b: String(b), label: 'Sets' };
    }
    if (sc.kind === 'basketball') {
      const t = basketballTotals(match);
      return { a: String(t.a), b: String(t.b), label: 'Points' };
    }
    return { a: '—', b: '—' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STANDINGS
  // ═══════════════════════════════════════════════════════════════════════════

  function participantsOf(match, tournament) {
    if (!tournament) return { a: '', b: '' };
    if (tournament.format === 'teams') return { a: match.teamA, b: match.teamB };
    return { a: match.playerA || '', b: match.playerB || '' };
  }

  function displayName(tournament, sportId, id) {
    if (!tournament || tournament.format !== 'teams') return id || '—';
    const teams = teamsFor(tournament, sportId);
    const t = teams.find(function (x) { return x.id === id; });
    return t ? t.name : (id || '—');
  }

  function teamMeta(tournament, sportId, id) {
    if (!tournament) return { name: id || '—', wards: '', color: 'var(--t-muted)' };
    if (tournament.format !== 'teams') {
      return { name: id || '—', wards: '', color: TEAM_COLORS[Math.abs(hashCode(id || '')) % TEAM_COLORS.length] };
    }
    const teams = teamsFor(tournament, sportId);
    const idx = teams.findIndex(function (x) { return x.id === id; });
    const t = teams[idx];
    if (!t) return { name: id || '—', wards: '', color: 'var(--t-muted)' };
    return { name: t.name, wards: t.wards || '', color: TEAM_COLORS[idx % TEAM_COLORS.length] };
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return h;
  }

  function computeStandings(tournament, matches, sportId) {
    if (!tournament) return [];
    const scoped = matches.filter(function (m) {
      return (!sportId || m.sport === sportId) && m.stage === 'league' && m.status === 'completed';
    });

    // Collect participant IDs
    const seen = {};
    if (tournament.format === 'teams') {
      teamsFor(tournament, sportId).forEach(function (t) { seen[t.id] = true; });
    } else {
      scoped.forEach(function (m) { if (m.playerA) seen[m.playerA] = true; if (m.playerB) seen[m.playerB] = true; });
    }
    const table = {};
    Object.keys(seen).forEach(function (id) {
      table[id] = { id: id, played: 0, won: 0, lost: 0, points: 0, h2h: {} };
    });

    scoped.forEach(function (m) {
      const p = participantsOf(m, tournament);
      const A = p.a, B = p.b;
      if (!A || !B) return;
      if (!table[A]) table[A] = { id: A, played: 0, won: 0, lost: 0, points: 0, h2h: {} };
      if (!table[B]) table[B] = { id: B, played: 0, won: 0, lost: 0, points: 0, h2h: {} };
      table[A].played++; table[B].played++;
      if (m.winner === 'A') {
        table[A].won++; table[A].points++;
        table[B].lost++;
        table[A].h2h[B] = 'W'; table[B].h2h[A] = 'L';
      } else if (m.winner === 'B') {
        table[B].won++; table[B].points++;
        table[A].lost++;
        table[B].h2h[A] = 'W'; table[A].h2h[B] = 'L';
      }
    });

    const rows = Object.values(table);
    rows.sort(function (x, y) {
      if (y.points !== x.points) return y.points - x.points;
      if (x.h2h[y.id] === 'W' && y.h2h[x.id] !== 'W') return -1;
      if (y.h2h[x.id] === 'W' && x.h2h[y.id] !== 'W') return 1;
      return String(x.id).localeCompare(String(y.id));
    });
    return rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTopbar() {
    const bar = document.getElementById('tTopbar');
    if (!bar) return;
    const tournament = currentTournament();
    const homeCrumb = `<a href="tournament.html" class="t-nav-btn" onclick="event.preventDefault();window.__tournament.navigate({view:'list'});">🏆 <span class="hide-sm">All Tournaments</span></a>`;
    const currentCrumb = tournament ? `<span class="t-nav-btn" style="cursor:default;">${escapeHtml(tournament.name)}</span>` : '';
    bar.innerHTML = `
      <div class="t-brand">
        <a href="tournament.html" style="display:flex;align-items:center;gap:10px;text-decoration:none;" onclick="event.preventDefault();window.__tournament.navigate({view:'list'});">
          <img src="icons/smash-logo.png" alt="SMASH" />
        </a>
      </div>
      <h1 class="t-title">${escapeHtml(tournament ? tournament.name : 'Church Tournament')}</h1>
      <div class="t-nav">
        ${homeCrumb}
        ${currentCrumb}
        <a href="index.html" class="t-nav-btn" title="Back to SMASH">← <span class="hide-sm">SMASH</span></a>
        ${state.isAdmin ? '<a href="admin-users.html" class="t-nav-btn" title="Members &amp; Admins">👥 <span class="hide-sm">Members</span></a>' : ''}
        <div id="tUserBox"></div>
      </div>
    `;
    renderUserBox();
  }

  function renderUserBox() {
    const box = document.getElementById('tUserBox');
    if (!box) return;
    if (!state.user) {
      box.innerHTML = `<button class="t-nav-btn" onclick="window.__tournament.signIn()">Sign in</button>`;
    } else {
      const label = state.isAdmin ? 'Admin' : (state.user.displayName || state.user.email || 'You');
      box.innerHTML = `
        <span class="t-user-chip"><span class="dot"></span>${escapeHtml(label)}</span>
        <button class="t-nav-btn" onclick="window.__tournament.signOut()">Sign out</button>
      `;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST VIEW — /tournament.html
  // ═══════════════════════════════════════════════════════════════════════════

  function renderList() {
    document.title = 'Church Tournament — All Tournaments';
    const container = document.getElementById('tContent');
    const tournaments = state.tournaments.slice().sort(function (a, b) {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return (b.createdAt && b.createdAt.seconds || 0) - (a.createdAt && a.createdAt.seconds || 0);
    });
    const canCreate = state.isAdmin;
    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>🏆 Church Tournaments</h1>
          <p>Every tournament run at the parish — Koinonia, SMASH, and anything you set up. Live scores, standings, and playoff progress in one place.</p>
        </div>
        <div class="t-emoji">🏆</div>
      </section>

      ${renderAccessBanner()}

      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">All tournaments <small>${tournaments.length} total</small></h2>
          ${canCreate ? '<button class="t-btn primary" onclick="window.__tournament.navigate({view:\'create\'})">➕ New tournament</button>' : ''}
        </div>
        <div id="tTournamentGrid"></div>
      </section>

      ${!state.user ? `
      <section class="t-section">
        <div class="t-card" style="border-color:var(--t-primary);background:linear-gradient(120deg,#eff6ff,#f5f3ff);">
          <div class="t-card-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;color:var(--t-fg);">Are you a match admin?</div>
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Sign in with Google to create tournaments and enter live scores.</div>
            </div>
            <button class="t-btn primary" onclick="window.__tournament.signIn()">🔐 Sign in with Google</button>
          </div>
        </div>
      </section>
      ` : ''}

      ${state.user && !state.isAdmin ? `
      <section class="t-section">
        <div class="t-card" style="border-color:var(--t-danger);background:#fef2f2;">
          <div class="t-card-body">
            <div style="font-weight:700;color:var(--t-fg);">Signed in as ${escapeHtml(state.user.email || '')}</div>
            <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">This account isn't on the admin list. You can still view all live scores.</div>
          </div>
        </div>
      </section>
      ` : ''}
    `;

    const grid = document.getElementById('tTournamentGrid');
    if (!tournaments.length) {
      grid.innerHTML = `
        <div class="t-empty" style="padding: 50px 20px;">
          <div style="font-size: 2.4rem; margin-bottom: 8px;">🏆</div>
          <div style="color:var(--t-fg);font-size:1.05rem;font-weight:600;margin-bottom:4px;">No tournaments yet</div>
          <div>${canCreate ? 'Create your first tournament to get started.' : 'Come back once a tournament has been created.'}</div>
          ${canCreate ? `
            <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
              <button class="t-btn primary" onclick="window.__tournament.navigate({view:'create'})">➕ Create tournament</button>
              <button class="t-btn" onclick="window.__tournament.seedKoinonia()">🌱 Seed Koinonia 2026</button>
            </div>
          ` : ''}
        </div>
      `;
      return;
    }
    grid.className = 't-tournament-grid';
    grid.innerHTML = '';
    tournaments.forEach(function (t) {
      const sports = (t.sports || []).slice(0, 6).map(function (s) {
        return `<span class="t-sport-chip">${s.emoji || '🏅'} ${escapeHtml(s.label || s.id)}</span>`;
      }).join('');
      const extra = (t.sports || []).length > 6 ? `<span class="t-sport-chip">+${t.sports.length - 6}</span>` : '';
      const formatLabel = t.format === 'individual' ? 'Individual / Doubles' : 'Team-based';

      // Show the max team count across sports (each sport has its own roster now).
      let maxTeams = 0;
      (t.sports || []).forEach(function (s) {
        const n = (s.teams || []).length;
        if (n > maxTeams) maxTeams = n;
      });
      if (!maxTeams && Array.isArray(t.teams)) maxTeams = t.teams.length; // legacy fallback

      const card = el('div', { class: 't-tournament-card ' + (t.archived ? 'archived' : '') });
      card.innerHTML = `
        <div class="t-format">${escapeHtml(formatLabel)}${t.archived ? ' · Archived' : ''}</div>
        <div class="t-name">${escapeHtml(t.name)}</div>
        <div class="t-sports">${sports || '<span class="t-sport-chip">No sports yet</span>'}${extra}</div>
        <div class="t-stats">
          <span><b>${(t.sports || []).length}</b> sports</span>
          ${t.format === 'teams' ? `<span>up to <b>${maxTeams}</b> teams</span>` : ''}
        </div>
        ${state.isAdmin ? `
          <div class="t-card-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px dashed var(--t-border);">
            <button class="t-btn sm" data-act="open">🔎 Open</button>
            <button class="t-btn sm" data-act="manage">⚙️ Manage</button>
            <button class="t-btn sm" data-act="archive">${t.archived ? '📤 Unarchive' : '📥 Archive'}</button>
            <div style="flex:1;"></div>
            <button class="t-btn danger sm" data-act="delete">🗑 Delete</button>
          </div>
        ` : ''}
      `;

      // Card body (everything above the actions row) navigates to the tournament view
      card.addEventListener('click', function (e) {
        if (e.target.closest('[data-act]')) return; // ignore clicks on action buttons
        navigate({ view: 'tournament', tournamentId: t.id });
      });

      card.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.stopPropagation();
          const act = btn.getAttribute('data-act');
          if (act === 'open') return navigate({ view: 'tournament', tournamentId: t.id });
          if (act === 'manage') return navigate({ view: 'manage', tournamentId: t.id });
          if (act === 'archive') {
            try {
              await db.collection('tournaments').doc(t.id).update({
                archived: !t.archived,
                updatedAt: FieldValue.serverTimestamp()
              });
              toast(t.archived ? 'Unarchived' : 'Archived');
            } catch (err) { console.error(err); toast('Failed: ' + (err.message || err.code), 'error'); }
            return;
          }
          if (act === 'delete') { return deleteTournament(t); }
        });
      });

      grid.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE / MANAGE VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  const editState = { draft: null };

  // In-memory schedule editor so Firestore re-renders don't wipe unsaved rows.
  // Keyed by tournamentId|sportId.
  const scheduleEditByKey = {};

  function renderCreateOrManage(mode) {
    if (!state.isAdmin) {
      renderAdminGate();
      return;
    }
    document.title = mode === 'manage' ? 'Manage tournament' : 'New tournament';
    const container = document.getElementById('tContent');
    let draft;
    if (mode === 'manage') {
      const t = currentTournament();
      if (!t) { toast('Tournament not found', 'error'); navigate({ view: 'list' }, { replace: true }); return; }
      // Deep clone so edits don't mutate live state.
      draft = JSON.parse(JSON.stringify(t));
      draft.sports = draft.sports || [];
      // Migration: teams used to live at the tournament root. If the doc still
      // has it, copy those teams into every sport that doesn't already have
      // its own roster, then drop the legacy tournament-level field.
      const legacyTeams = Array.isArray(draft.teams) ? draft.teams : [];
      draft.sports.forEach(function (s) {
        if (!Array.isArray(s.teams) || !s.teams.length) {
          s.teams = JSON.parse(JSON.stringify(legacyTeams));
        }
      });
      delete draft.teams;
    } else {
      draft = { name: '', format: 'teams', sports: [], archived: false };
    }
    editState.draft = draft;

    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>${mode === 'manage' ? '⚙️ Manage tournament' : '➕ Create tournament'}</h1>
          <p>${mode === 'manage' ? 'Change name, format, sports, dates, and scoring rules for this tournament.' : 'Set up a new tournament. All fields except the name are editable later.'}</p>
        </div>
        <div class="t-emoji">${mode === 'manage' ? '⚙️' : '➕'}</div>
      </section>

      <section class="t-section">
        <div class="t-card">
          <div class="t-card-body">
            <div class="t-form-grid" style="grid-template-columns:2fr 1fr;">
              <div class="t-form-field">
                <label>Tournament name *</label>
                <input type="text" class="t-input" id="tfName" placeholder="e.g. Koinonia 2026" value="${escapeHtml(draft.name)}" />
              </div>
              <div class="t-form-field">
                <label>Format</label>
                <select class="t-select" id="tfFormat">
                  <option value="teams" ${draft.format === 'teams' ? 'selected' : ''}>Team-based (groups play each other)</option>
                  <option value="individual" ${draft.format === 'individual' ? 'selected' : ''}>Individual / Doubles (no teams)</option>
                </select>
              </div>
            </div>
            <div id="tfArchivedWrap" style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;">
                <input type="checkbox" id="tfArchived" ${draft.archived ? 'checked' : ''}/> Archive this tournament (hides from active list)
              </label>
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;" title="When enabled, any signed-in user can view rosters that have been locked. Unlocked rosters remain visible only to team members, the team captain, and admins.">
                <input type="checkbox" id="tfRevealLocked" ${draft.revealLockedRosters ? 'checked' : ''}/> Reveal locked rosters to everyone signed in
              </label>
            </div>
          </div>
        </div>
      </section>

      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">Sports <small>teams, date & scoring per sport</small></h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <select class="t-select" id="tfAddSport" style="width:auto;">
              <option value="">Add sport…</option>
              ${Object.values(SPORT_TEMPLATES).map(function (s) { return `<option value="${s.id}">${s.emoji} ${s.label}</option>`; }).join('')}
              <option value="__custom__">➕ Custom sport…</option>
            </select>
          </div>
        </div>
        <div id="tfSports"></div>
      </section>

      <section class="t-section" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button class="t-btn" onclick="window.__tournament.navigate({view:'list'})">Cancel</button>
        ${mode === 'manage' ? `<button class="t-btn danger" id="tfDelete">🗑 Delete tournament</button>` : ''}
        <button class="t-btn primary" id="tfSave">${mode === 'manage' ? '💾 Save changes' : '➕ Create tournament'}</button>
      </section>
    `;

    document.getElementById('tfFormat').addEventListener('change', function (e) {
      draft.format = e.target.value;
      paintSports(draft);
    });

    document.getElementById('tfAddSport').addEventListener('change', function (e) {
      const v = e.target.value;
      if (!v) return;
      if (v === '__custom__') addCustomSport(draft);
      else addSport(draft, v);
      e.target.value = '';
      paintSports(draft);
    });
    paintSports(draft);

    document.getElementById('tfSave').addEventListener('click', function () { saveDraft(mode); });
    if (mode === 'manage') {
      document.getElementById('tfDelete').addEventListener('click', function () { deleteTournament(currentTournament()); });
    }
  }

  function paintTeamsInto(container, sport, draft) {
    container.innerHTML = '';
    sport.teams = sport.teams || [];
    if (!sport.teams.length) {
      const empty = el('div', { class: 't-empty', style: { padding: '12px', textAlign: 'left' } },
        'No teams yet. Click "Add team" or "Copy from another sport" to get started.');
      container.appendChild(empty);
      return;
    }
    sport.teams.forEach(function (t, i) {
      const row = el('div', { class: 't-team-row' });
      const rosterCount = Array.isArray(t.roster) ? t.roster.length : 0;
      const capAssigned = t.captainUid || t.captainName || t.captainEmail;
      const captainLabel = capAssigned
        ? '👤 ' + escapeHtml(t.captainName || t.captainEmail || '(assigned)')
          + (t.captainUid ? '' : ' <span class="t-badge nologin" style="font-size:.62rem;">no login</span>')
        : '<span style="color:var(--t-muted);">No captain</span>';
      row.innerHTML = `
        <input type="text" placeholder="Id" value="${escapeHtml(t.id)}" data-team-key="id" />
        <input type="text" placeholder="Wards / description" value="${escapeHtml(t.wards || '')}" data-team-key="wards" />
        <div class="t-team-captain-cell">
          <span class="cap-lbl">${captainLabel}</span>
          <div class="cap-actions">
            <button class="t-btn sm" type="button" data-team-captain="1">${capAssigned ? 'Change' : 'Assign captain'}</button>
            ${rosterCount ? '<button class="t-btn sm" type="button" data-team-roster="1">Roster (' + rosterCount + ')</button>' : ''}
          </div>
        </div>
        <button class="t-btn danger sm" data-team-remove="1">Remove</button>
      `;
      const inputs = row.querySelectorAll('input');
      inputs[0].addEventListener('input', function () { t.id = this.value.trim() || t.id; t.name = t.id; });
      inputs[1].addEventListener('input', function () { t.wards = this.value; });
      row.querySelector('[data-team-remove]').addEventListener('click', function () {
        sport.teams.splice(i, 1);
        paintTeamsInto(container, sport, draft);
      });
      row.querySelector('[data-team-captain]').addEventListener('click', function () {
        // Captain assignment writes directly to Firestore (not the draft) so
        // it's immediate — but we need a saved tournament for that. If we're
        // in the Create flow the tournament doesn't exist yet.
        if (!draft.id) {
          toast('Save the tournament first, then assign captains from the Manage view or the tournament page.', 'error');
          return;
        }
        openCaptainPicker(draft.id, sport.id, t.id);
      });
      const rosterBtn = row.querySelector('[data-team-roster]');
      if (rosterBtn) {
        rosterBtn.addEventListener('click', function () {
          if (!draft.id) { toast('Save the tournament first.', 'error'); return; }
          openRoster(draft.id, sport.id, t.id);
        });
      }
      container.appendChild(row);
    });
  }

  function addSport(draft, templateId) {
    if ((draft.sports || []).find(function (s) { return s.id === templateId; })) {
      toast(templateId + ' is already in this tournament', 'error');
      return;
    }
    draft.sports = draft.sports || [];
    // Seed the new sport's teams from any existing sport that already has a
    // roster (Koinonia will typically want the same G1–G4 across sports).
    const donor = (draft.sports || []).find(function (s) { return Array.isArray(s.teams) && s.teams.length; });
    const seed = donor ? { teams: donor.teams } : { teams: DEFAULT_TEAMS };
    draft.sports.push(sportTemplateForConfig(templateId, seed));
  }

  function addCustomSport(draft) {
    const name = prompt('Custom sport name (e.g. Chess)');
    if (!name) return;
    const kindLabels = CUSTOM_KINDS.map(function (k, i) { return (i + 1) + ') ' + k.label; }).join('\n');
    const pick = prompt('Which scoring template?\n' + kindLabels, '1');
    const idx = Math.max(0, Math.min(CUSTOM_KINDS.length - 1, (parseInt(pick, 10) || 1) - 1));
    const kind = CUSTOM_KINDS[idx].kind;
    const id = slugify(name);
    if ((draft.sports || []).find(function (s) { return s.id === id; })) {
      toast('A sport with this id already exists', 'error');
      return;
    }
    const donor = (draft.sports || []).find(function (s) { return Array.isArray(s.teams) && s.teams.length; });
    draft.sports.push({
      id: id, label: name, kind: kind, emoji: '🏅', color: '#64748b',
      date: '',
      hasThirdPlace: true,
      categories: kind === 'racket' ? [...DEFAULT_CATEGORIES] : [],
      teams: donor ? JSON.parse(JSON.stringify(donor.teams)) : JSON.parse(JSON.stringify(DEFAULT_TEAMS)),
      scoring: defaultScoring(kind)
    });
  }

  function paintSports(draft) {
    const wrap = document.getElementById('tfSports');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!draft.sports || !draft.sports.length) {
      wrap.innerHTML = '<div class="t-empty">No sports yet. Use the dropdown above to add one.</div>';
      return;
    }
    draft.sports.forEach(function (s, i) {
      if (s.hasThirdPlace === undefined) s.hasThirdPlace = true;
      s.teams = s.teams || [];
      const card = el('div', { class: 't-config-sport' });
      const teamsSectionHtml = draft.format === 'teams' ? `
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t-muted);">Teams for this sport</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="t-btn sm" data-act="add-team">➕ Add team</button>
              ${draft.sports.length > 1 ? '<button class="t-btn sm" data-act="copy-from">📋 Copy from…</button>' : ''}
              ${draft.sports.length > 1 && s.teams.length ? '<button class="t-btn sm" data-act="apply-all">📤 Apply to all sports</button>' : ''}
            </div>
          </div>
          <div class="t-teams-editor" data-teams></div>
        </div>
      ` : '';
      card.innerHTML = `
        <div class="t-config-sport-head">
          <div class="label">${s.emoji || '🏅'} ${escapeHtml(s.label)}</div>
          <span class="kind-chip">${escapeHtml(s.kind)}</span>
          <button class="t-btn danger sm" data-act="remove">Remove</button>
        </div>
        <div class="t-config-sport-body">
          <div class="t-form-grid" style="grid-template-columns:1fr 2fr;">
            <div class="t-form-field">
              <label>Match date</label>
              <input type="date" class="t-input" data-field="date" value="${escapeHtml(s.date || '')}" />
            </div>
            ${s.kind === 'racket' ? `
              <div class="t-form-field">
                <label>Categories per match (comma-separated)</label>
                <input type="text" class="t-input" data-field="categories" placeholder="OD1, OD2, XD1, XD2, WD" value="${escapeHtml((s.categories || []).join(', '))}" />
              </div>
            ` : ''}
          </div>
          ${teamsSectionHtml}
          <div>
            <label style="display:inline-flex;align-items:center;gap:8px;color:var(--t-fg);font-weight:600;font-size:.9rem;">
              <input type="checkbox" data-field="hasThirdPlace" ${s.hasThirdPlace !== false ? 'checked' : ''} />
              Include 3rd-place playoff match
            </label>
            <div style="color:var(--t-muted);font-size:.78rem;margin-top:2px;margin-left:24px;">
              Turn off if this sport ends after the final (loser of semifinal does not play again).
            </div>
          </div>
          <div>
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t-muted);margin-bottom:6px;">Scoring per stage</div>
            <div class="t-stages-grid" data-stages></div>
          </div>
        </div>
      `;
      card.querySelector('[data-act="remove"]').addEventListener('click', function () {
        if (!confirm('Remove ' + s.label + ' from this tournament?')) return;
        draft.sports.splice(i, 1);
        paintSports(draft);
      });
      card.querySelector('[data-field="date"]').addEventListener('change', function () { s.date = this.value; });
      const catInput = card.querySelector('[data-field="categories"]');
      if (catInput) catInput.addEventListener('input', function () {
        s.categories = this.value.split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
      });
      card.querySelector('[data-field="hasThirdPlace"]').addEventListener('change', function () {
        s.hasThirdPlace = this.checked;
        paintSports(draft);
      });

      // Per-sport teams editor (only in team format)
      if (draft.format === 'teams') {
        const teamsBox = card.querySelector('[data-teams]');
        paintTeamsInto(teamsBox, s, draft);
        card.querySelector('[data-act="add-team"]').addEventListener('click', function () {
          const nextId = 'G' + ((s.teams || []).length + 1);
          s.teams.push({ id: nextId, name: nextId, wards: '' });
          paintTeamsInto(teamsBox, s, draft);
        });
        const copyBtn = card.querySelector('[data-act="copy-from"]');
        if (copyBtn) copyBtn.addEventListener('click', function () {
          const others = draft.sports.filter(function (o) { return o.id !== s.id && (o.teams || []).length; });
          if (!others.length) return toast('No other sport has teams yet', 'error');
          const labels = others.map(function (o, oi) { return (oi + 1) + ') ' + o.label + ' (' + o.teams.length + ' teams)'; }).join('\n');
          const pick = prompt('Copy teams from which sport?\n' + labels, '1');
          if (!pick) return;
          const idx = Math.max(0, Math.min(others.length - 1, (parseInt(pick, 10) || 1) - 1));
          s.teams = JSON.parse(JSON.stringify(others[idx].teams));
          paintSports(draft);
        });
        const applyBtn = card.querySelector('[data-act="apply-all"]');
        if (applyBtn) applyBtn.addEventListener('click', function () {
          if (!confirm('Overwrite team rosters for ALL other sports in this tournament with the teams from ' + s.label + '?')) return;
          draft.sports.forEach(function (o) {
            if (o.id !== s.id) o.teams = JSON.parse(JSON.stringify(s.teams));
          });
          paintSports(draft);
          toast('Teams applied to all sports');
        });
      }

      const stagesWrap = card.querySelector('[data-stages]');
      enabledStagesFor(s).forEach(function (st) {
        if (!s.scoring[st]) s.scoring[st] = defaultScoring(s.kind)[st];
        stagesWrap.appendChild(buildStageConfig(s, st));
      });
      wrap.appendChild(card);
    });
  }

  function buildStageConfig(sport, stage) {
    const cfg = sport.scoring[stage];
    const box = el('div', { class: 't-stage-config' });
    box.innerHTML = `<h4>${STAGE_LABEL[stage]}</h4>`;
    const rows = el('div');
    function addRow(label, key, value) {
      const row = el('div', { class: 'row' });
      row.innerHTML = `<label>${label}</label><input type="number" min="0" data-cfg="${key}" value="${value}" />`;
      row.querySelector('input').addEventListener('input', function () {
        cfg[key] = Math.max(0, parseInt(this.value, 10) || 0);
      });
      rows.appendChild(row);
    }
    if (sport.kind === 'racket') {
      addRow('Best of (sets)', 'bestOf', cfg.bestOf || 1);
      addRow('Target points', 'target', cfg.target || 21);
      addRow('Cap points', 'cap', cfg.cap || 25);
    } else if (sport.kind === 'volleyball') {
      addRow('Best of (sets)', 'bestOf', cfg.bestOf || 3);
      addRow('Target points', 'target', cfg.target || 21);
      addRow('Cap points', 'cap', cfg.cap || 25);
      addRow('Deciding set target', 'decidingTarget', cfg.decidingTarget || 15);
      addRow('Deciding set cap', 'decidingCap', cfg.decidingCap || 20);
    } else if (sport.kind === 'basketball') {
      addRow('Quarters', 'quarters', cfg.quarters || 4);
      addRow('Minutes per quarter', 'quarterMinutes', cfg.quarterMinutes || 7);
    }
    box.appendChild(rows);
    return box;
  }

  async function saveDraft(mode) {
    const draft = editState.draft;
    if (!draft) return;
    draft.name = document.getElementById('tfName').value.trim();
    draft.archived = document.getElementById('tfArchived').checked;
    draft.revealLockedRosters = document.getElementById('tfRevealLocked').checked;
    if (!draft.name) return toast('Tournament name is required', 'error');
    if (!draft.sports || !draft.sports.length) return toast('Add at least 1 sport', 'error');

    if (draft.format === 'teams') {
      // Every sport should have at least 2 teams before you can meaningfully
      // run a round-robin. Warn but don't block: admins might want to save
      // the shell first and come back to fill teams later.
      const missing = draft.sports.filter(function (s) { return !s.teams || s.teams.length < 2; });
      if (missing.length) {
        const names = missing.map(function (s) { return s.label; }).join(', ');
        if (!confirm(names + ' — this sport has fewer than 2 teams and won\'t allow match creation. Save anyway?')) return;
      }
    }

    // Merge in live captain + roster fields so we don't clobber assignments
    // that were made (via the direct-write captain/roster modals) after this
    // Manage session was opened. The draft is a deep clone; live data may
    // have moved on since.
    const live = (mode === 'manage')
      ? state.tournaments.find(function (x) { return x.id === draft.id; })
      : null;
    const mergedSports = (draft.sports || []).map(function (s) {
      const liveSport = live ? (live.sports || []).find(function (x) { return x.id === s.id; }) : null;
      const teams = (s.teams || []).map(function (tm) {
        const liveTeam = liveSport ? (liveSport.teams || []).find(function (x) { return x.id === tm.id; }) : null;
        if (!liveTeam) return tm;
        return Object.assign({}, tm, {
          captainUid:      liveTeam.captainUid      || tm.captainUid      || null,
          captainName:     liveTeam.captainName     || tm.captainName     || null,
          captainEmail:    liveTeam.captainEmail    || tm.captainEmail    || null,
          captainFamilyId: liveTeam.captainFamilyId || tm.captainFamilyId || null,
          locked:   typeof liveTeam.locked   === 'boolean' ? liveTeam.locked   : !!tm.locked,
          lockedAt: liveTeam.lockedAt || tm.lockedAt || null,
          lockedBy: liveTeam.lockedBy || tm.lockedBy || null,
          roster: Array.isArray(liveTeam.roster) ? liveTeam.roster : (tm.roster || [])
        });
      });
      return Object.assign({}, s, {
        teams: teams,
        schedule: (liveSport && liveSport.schedule) ? liveSport.schedule : (s.schedule || null)
      });
    });

    const payload = {
      name: draft.name,
      format: draft.format,
      // teams field is now per-sport; we explicitly clear the legacy
      // tournament-level field on every save.
      teams: FieldValue.delete(),
      sports: mergedSports,
      archived: !!draft.archived,
      revealLockedRosters: !!draft.revealLockedRosters,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: (state.user && state.user.email) || ''
    };
    try {
      if (mode === 'manage') {
        const t = currentTournament();
        await db.collection('tournaments').doc(t.id).update(payload);
        toast('Saved');
        navigate({ view: 'tournament', tournamentId: t.id });
      } else {
        // Can't use FieldValue.delete() on a new doc — drop the sentinel.
        delete payload.teams;
        payload.createdAt = FieldValue.serverTimestamp();
        payload.createdBy = (state.user && state.user.email) || '';
        const ref = await db.collection('tournaments').add(payload);
        // Optimistically add to local state so navigate() doesn't beat the
        // onSnapshot delivery and render "Tournament not found".
        if (!state.tournaments.some(function (x) { return x.id === ref.id; })) {
          state.tournaments.push(Object.assign({ id: ref.id }, payload));
        }
        toast('Tournament created');
        navigate({ view: 'tournament', tournamentId: ref.id });
      }
    } catch (err) {
      console.error(err);
      toast('Save failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  async function deleteTournament(t) {
    if (!t) return;
    if (!confirm('Delete "' + t.name + '" and ALL its matches? This cannot be undone.')) return;
    try {
      const snap = await db.collection('tournament_matches').where('tournamentId', '==', t.id).get();
      const batch = db.batch();
      snap.forEach(function (doc) { batch.delete(doc.ref); });
      batch.delete(db.collection('tournaments').doc(t.id));
      await batch.commit();
      toast('Tournament deleted');
      navigate({ view: 'list' }, { replace: true });
    } catch (err) {
      console.error(err);
      toast('Delete failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function renderAdminGate() {
    const container = document.getElementById('tContent');
    container.innerHTML = `
      <section class="t-section">
        <div class="t-auth-gate">
          <h3>Admin sign-in required</h3>
          <p>Sign in with an admin Google account to create or manage tournaments.</p>
          <button class="t-btn primary lg" onclick="window.__tournament.signIn()">🔐 Sign in with Google</button>
          ${state.user ? '<p class="denied">' + escapeHtml(state.user.email || '') + ' isn\'t on the admin list.</p>' : ''}
        </div>
      </section>
    `;
  }

  async function seedKoinonia() {
    if (!state.isAdmin) return toast('Admin only', 'error');
    try {
      const payload = koinoniaSeed();
      payload.createdAt = FieldValue.serverTimestamp();
      payload.updatedAt = FieldValue.serverTimestamp();
      payload.createdBy = (state.user && state.user.email) || '';
      const ref = await db.collection('tournaments').add(payload);
      // Optimistically stash the new doc in local state so navigate() below
      // doesn't race the onSnapshot delivery (which normally arrives within
      // a few ms of the write, but can lag long enough for renderTournament
      // to fire "Tournament not found" first and redirect back to the list).
      if (!state.tournaments.some(function (x) { return x.id === ref.id; })) {
        state.tournaments.push(Object.assign({ id: ref.id }, payload));
      }
      toast('Koinonia 2026 created');
      navigate({ view: 'tournament', tournamentId: ref.id });
    } catch (err) {
      console.error(err);
      toast('Seed failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function renderAccessBanner() {
    if (!state.isAdmin) return '';
    if (tournamentOpenToEveryone()) {
      return `
      <section class="t-section">
        <div class="t-card t-access-banner t-access-banner-open">
          <div class="t-card-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;color:var(--t-fg);">Tournament is open to everyone</div>
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Signed-in members can open this page. Switch back to admin-only if you still need to test privately.</div>
            </div>
            <button class="t-btn" type="button" onclick="window.__tournament.setTournamentOpen(false)">Admin testing only</button>
          </div>
        </div>
      </section>`;
    }
    return `
      <section class="t-section">
        <div class="t-card t-access-banner">
          <div class="t-card-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;color:var(--t-fg);">Admin testing only</div>
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Members cannot see Tournament in the nav and cannot open this page. Open it to everyone when you are ready.</div>
            </div>
            <button class="t-btn primary" type="button" onclick="window.__tournament.setTournamentOpen(true)">Open to everyone</button>
          </div>
        </div>
      </section>`;
  }

  function setTournamentOpen(open) {
    if (!state.isAdmin) return toast('Admin only', 'error');
    if (!window.TournamentAccess) return toast('Visibility setting is unavailable', 'error');
    const next = !!open;
    const ok = next
      ? confirm('Make Tournament visible to all signed-in members? They will see the nav link and can open this page.')
      : confirm('Hide Tournament from members? Only admins will see the page until you open it again.');
    if (!ok) return;
    TournamentAccess.setOpenToEveryone(next).then(function () {
      toast(next ? 'Tournament is now open to everyone' : 'Tournament is admin-only again');
      render();
    }).catch(function (err) {
      console.error(err);
      toast('Could not update visibility: ' + (err.message || err.code || 'unknown'), 'error');
    });
  }

  function rulesText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    return String(obj.text || '');
  }

  function formatRulesHtml(text) {
    const raw = String(text || '').trim();
    if (!raw) return '<p class="t-empty">No rules posted yet.</p>';
    return '<div class="t-rules-text">' + escapeHtml(raw).replace(/\n/g, '<br>') + '</div>';
  }

  function renderRulesCard(opts) {
    const text = opts.text || '';
    if (!state.isAdmin && !String(text).trim()) return '';
    const title = escapeHtml(opts.title || 'Rules');
    const subtitle = escapeHtml(opts.subtitle || '');
    if (state.isAdmin) {
      return `
      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">${title}${subtitle ? ' <small>' + subtitle + '</small>' : ''}</h2>
          <button class="t-btn sm primary" type="button" onclick="window.__tournament.${opts.saveCall}">Save rules</button>
        </div>
        <div class="t-card"><div class="t-card-body">
          <textarea class="t-input t-rules-textarea" id="${escapeHtml(opts.textareaId)}" rows="6" placeholder="${escapeHtml(opts.placeholder || '')}">${escapeHtml(text)}</textarea>
          <div class="t-schedule-note" style="margin-top:8px;">Only admins can edit. Everyone else can read these rules.</div>
        </div></div>
      </section>`;
    }
    return `
      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">${title}${subtitle ? ' <small>' + subtitle + '</small>' : ''}</h2>
        </div>
        <div class="t-card"><div class="t-card-body">${formatRulesHtml(text)}</div></div>
      </section>`;
  }

  async function saveTournamentRules(tournamentId) {
    if (!state.isAdmin) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const box = document.getElementById('tTournamentRules');
    if (!box) return;
    const rules = {
      text: box.value || '',
      updatedAt: new Date().toISOString(),
      updatedBy: (state.user && (state.user.email || state.user.displayName)) || ''
    };
    try {
      await db.collection('tournaments').doc(t.id).update({
        rules: rules,
        updatedAt: FieldValue.serverTimestamp()
      });
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { rules: rules });
      toast('Tournament rules saved', 'success');
    } catch (err) {
      console.error(err);
      toast('Could not save rules: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  async function saveSportRules(tournamentId, sportId) {
    if (!state.isAdmin) return toast('Admin only', 'error');
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const box = document.getElementById('tSportRules');
    if (!box) return;
    const rules = {
      text: box.value || '',
      updatedAt: new Date().toISOString(),
      updatedBy: (state.user && (state.user.email || state.user.displayName)) || ''
    };
    try {
      await writeSportPatch(t, sportId, { rules: rules });
      toast((sport.label || 'Sport') + ' rules saved', 'success');
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  window.__tournament.seedKoinonia = seedKoinonia;
  window.__tournament.setTournamentOpen = setTournamentOpen;
  window.__tournament.openCaptainPicker = openCaptainPicker;
  window.__tournament.openRoster = openRoster;
  window.__tournament.openMemberPicker = openMemberPicker;
  window.__tournament.setRosterLock = setRosterLock;
  window.__tournament.addScheduleRow = addScheduleRow;
  window.__tournament.removeScheduleRow = removeScheduleRow;
  window.__tournament.generateLeagueSchedule = generateLeagueSchedule;
  window.__tournament.saveScheduleDraft = saveScheduleDraft;
  window.__tournament.publishSchedule = publishSchedule;
  window.__tournament.clearSchedule = clearSchedule;
  window.__tournament.saveTournamentRules = saveTournamentRules;
  window.__tournament.saveSportRules = saveSportRules;

  // ═══════════════════════════════════════════════════════════════════════════
  // TOURNAMENT VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTournament() {
    harvestScheduleEditor();
    const parsed = parseUrl();
    const t = currentTournament();
    if (!t) {
      if (state.ready.tournaments) {
        toast('Tournament not found', 'error');
        navigate({ view: 'list' }, { replace: true });
      } else {
        document.getElementById('tContent').innerHTML = '<div class="t-empty">Loading tournament…</div>';
      }
      return;
    }
    document.title = t.name + ' — Church Tournament';

    // Pick active sport
    let sportId = parsed.sportId;
    if (!sportId || !getSportConfig(t, sportId)) sportId = (t.sports && t.sports[0] && t.sports[0].id) || null;
    const sport = getSportConfig(t, sportId);

    const container = document.getElementById('tContent');
    const tabsHtml = (t.sports || []).map(function (s) {
      const count = visibleMatchesFor(t, s.id).length;
      return `<button class="t-tab ${s.id === sportId ? 'active' : ''}" style="--sport-color:${s.color || 'var(--t-primary)'}" onclick="window.__tournament.navigate({view:'tournament',tournamentId:'${t.id}',sportId:'${s.id}'})">${s.emoji || '🏅'} ${escapeHtml(s.label)}${count ? '<span class="count">' + count + '</span>' : ''}</button>`;
    }).join('');

    container.innerHTML = `
      <section class="t-hero" style="--hero-a:${sport ? sport.color : '#3b82f6'};--hero-b:#1e293b;">
        <div>
          <h1>${escapeHtml(t.name)} <small style="opacity:.9;font-family:'Outfit',sans-serif;font-weight:500;font-size:.6em;letter-spacing:normal;text-transform:none;">${t.format === 'individual' ? 'Individual / Doubles' : 'Team-based'}</small></h1>
          <p>${sport ? (sport.emoji || '🏅') + ' ' + escapeHtml(sport.label) + (sport.date ? ' · ' + fmtDate(sport.date) : '') : 'Configure sports for this tournament'}</p>
        </div>
        <div class="t-emoji">${sport ? (sport.emoji || '🏆') : '🏆'}</div>
      </section>

      ${renderAccessBanner()}

      ${renderRulesCard({
        title: 'Tournament rules',
        subtitle: 'applies to every sport',
        text: rulesText(t.rules),
        textareaId: 'tTournamentRules',
        placeholder: 'Eligibility, conduct, scoring notes, prize rules…',
        saveCall: "saveTournamentRules('" + t.id + "')"
      })}

      ${state.isAdmin ? `
      <section class="t-section" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="t-btn" onclick="window.__tournament.navigate({view:'manage',tournamentId:'${t.id}'})">⚙️ Manage tournament</button>
      </section>
      ` : `
      ${!state.user ? `
      <section class="t-section">
        <div class="t-card" style="border-color:var(--t-primary);background:linear-gradient(120deg,#eff6ff,#f5f3ff);">
          <div class="t-card-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;color:var(--t-fg);">Are you a match admin?</div>
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Sign in with Google to create matches and enter live scores.</div>
            </div>
            <button class="t-btn primary" onclick="window.__tournament.signIn()">🔐 Sign in with Google</button>
          </div>
        </div>
      </section>
      ` : ''}
      `}

      ${(t.sports || []).length ? `<div class="t-tabs">${tabsHtml}</div>` : `
        <section class="t-section">
          <div class="t-empty">
            No sports have been added to this tournament yet.
            ${state.isAdmin ? '<div style="margin-top:12px;"><button class="t-btn primary" onclick="window.__tournament.navigate({view:\'manage\',tournamentId:\'' + t.id + '\'})">⚙️ Manage tournament</button></div>' : ''}
          </div>
        </section>
      `}

      ${sport ? `
        ${t.format === 'teams' ? `
        <section class="t-section" id="tRostersSection">
          <div class="t-section-header">
            <h2 class="t-section-title">Team rosters <small>captains &amp; members</small></h2>
          </div>
          <div class="t-rosters-grid" id="tRostersGrid"></div>
        </section>
        ` : ''}

        ${renderRulesCard({
          title: (sport.label || 'Sport') + ' rules',
          subtitle: 'this sport only',
          text: rulesText(sport.rules),
          textareaId: 'tSportRules',
          placeholder: 'Format, scoring, substitutions, court rules for this sport…',
          saveCall: "saveSportRules('" + t.id + "','" + sport.id + "')"
        })}

        <section class="t-section" id="tScheduleSection">
          <div class="t-section-header">
            <h2 class="t-section-title">Schedule <small>fixtures for this sport</small></h2>
            <div id="tScheduleActions" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
          </div>
          <div class="t-card"><div class="t-card-body" id="tScheduleBody"><p class="t-empty">Loading…</p></div></div>
        </section>

        <section class="t-section">
          <div class="t-section-header"><h2 class="t-section-title">Standings <small>league round-robin</small></h2></div>
          <div class="t-card"><div class="t-card-body" id="tStandings"><p class="t-empty">Loading…</p></div></div>
        </section>

        <section class="t-section" id="tLiveSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">🔴 Live now</h2></div>
          <div class="t-match-list" id="tLiveList"></div>
        </section>

        <section class="t-section" id="tUpcomingSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Upcoming</h2></div>
          <div class="t-match-list" id="tUpcomingList"></div>
        </section>

        <section class="t-section" id="tCompletedSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Completed</h2></div>
          <div class="t-match-list" id="tCompletedList"></div>
        </section>

        <section class="t-section" id="tPlayoffsSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Playoffs</h2></div>
          <div class="t-bracket" id="tPlayoffs"></div>
        </section>

        ${state.isAdmin ? `
          <section class="t-section">
            <div class="t-section-header"><h2 class="t-section-title">Admin controls <small>score entry</small></h2></div>
            <div class="t-card">
              <div class="t-card-body" style="color:var(--t-muted);font-size:.88rem;">
                Build the fixture list in <b>Schedule</b> above, then <b>Save draft</b> and <b>Publish</b> so everyone can see it. After it is published, start matches and enter scores from the cards in Upcoming / Live.
              </div>
            </div>
          </section>
        ` : ''}
      ` : ''}
    `;

    if (sport) {
      if (t.format === 'teams') renderRostersFor(t, sport);
      renderScheduleFor(t, sport);
      renderStandingsFor(t, sport.id);
      renderMatchListsFor(t, sport.id);
      renderPlayoffsFor(t, sport.id);
    }
  }

  function renderRostersFor(tournament, sport) {
    const wrap = document.getElementById('tRostersGrid');
    if (!wrap) return;
    const teams = teamsFor(tournament, sport);
    if (!teams.length) {
      wrap.innerHTML = '<div class="t-empty">No teams configured for this sport yet.</div>';
      return;
    }
    wrap.innerHTML = teams.map(function (team) {
      const meta = teamMeta(tournament, sport.id, team.id);
      const captainAssigned = team.captainUid || team.captainName || team.captainEmail;
      const captainName = captainAssigned
        ? escapeHtml(team.captainName || team.captainEmail || '(captain)')
          + (team.captainUid
              ? ''
              : ' <span class="t-badge nologin" style="margin-left:4px;font-size:.65rem;">no login yet</span>')
        : '<span style="color:var(--t-muted);">Not assigned</span>';
      const rosterCount = Array.isArray(team.roster) ? team.roster.length : 0;
      const isMine = isCaptainOf(team) || isRosterMemberOf(team);
      const canManage = state.isAdmin;
      const locked = isRosterLocked(team);
      const canView = canViewRoster(tournament, team);
      const canEdit = canEditRoster(team);
      const lockChip = locked
        ? '<span class="t-badge locked" title="Locked ' + escapeHtml(team.lockedAt || '') + '">🔒 Locked</span>'
        : '<span class="t-badge unlocked">🔓 Open</span>';
      return `
        <div class="t-roster-card ${locked ? 'is-locked' : ''}" style="--team-color:${meta.color || '#3b82f6'}">
          <div class="t-roster-card-head">
            <div class="t-roster-team">
              <span class="t-roster-dot" style="background:${meta.color || '#3b82f6'};"></span>
              <div>
                <div class="t-roster-name">${escapeHtml(team.name || team.id)}${isMine ? ' <span class="t-badge you">Your team</span>' : ''} ${lockChip}</div>
                <div class="t-roster-sub">${escapeHtml(team.wards || '')}</div>
              </div>
            </div>
            ${canManage ? `<button class="t-btn sm" onclick="window.__tournament.openCaptainPicker('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">${captainAssigned ? 'Change captain' : 'Assign captain'}</button>` : ''}
          </div>
          <div class="t-roster-card-body">
            <div class="t-roster-line"><span class="lbl">Captain</span><span class="val">${captainName}</span></div>
            <div class="t-roster-line"><span class="lbl">Members</span><span class="val"><b>${canView ? rosterCount : '—'}</b></span></div>
            ${!canView ? '<div class="t-roster-hidden">' + escapeHtml(whyCantView(tournament, team)) + '</div>' : ''}
          </div>
          <div class="t-roster-card-foot">
            ${canView ? `<button class="t-btn sm" onclick="window.__tournament.openRoster('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">View roster</button>` : ''}
            ${canEdit ? `<button class="t-btn sm primary" onclick="window.__tournament.openMemberPicker('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">➕ Add member</button>` : ''}
            ${canManage ? `<button class="t-btn sm ${locked ? 'warn' : ''}" onclick="window.__tournament.setRosterLock('${tournament.id}','${sport.id}','${escapeHtml(team.id)}',${!locked})">${locked ? '🔓 Unlock' : '🔒 Lock roster'}</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderStandingsFor(tournament, sportId) {
    const wrap = document.getElementById('tStandings');
    if (!wrap) return;
    const rows = computeStandings(tournament, state.matches, sportId);
    if (!rows.length) {
      wrap.innerHTML = '<p class="t-empty">No league matches completed yet.</p>';
      return;
    }
    wrap.innerHTML = `
      <table class="t-standings-table">
        <thead>
          <tr><th>#</th><th>${tournament.format === 'teams' ? 'Team' : 'Player / Pair'}</th><th class="num">P</th><th class="num">W</th><th class="num">L</th><th class="num">Pts</th></tr>
        </thead>
        <tbody>
          ${rows.map(function (r, i) {
            const meta = teamMeta(tournament, sportId, r.id);
            return `
              <tr class="rank-${i + 1}">
                <td><span class="rank-badge">${i + 1}</span></td>
                <td>
                  <div class="t-team-cell">
                    <span class="t-team-swatch" style="--team-color:${meta.color}"></span>
                    <div>
                      <span class="t-team-name">${escapeHtml(meta.name)}</span>
                      ${meta.wards ? '<span class="t-team-wards">' + escapeHtml(meta.wards) + '</span>' : ''}
                    </div>
                  </div>
                </td>
                <td class="num">${r.played}</td>
                <td class="num">${r.won}</td>
                <td class="num">${r.lost}</td>
                <td class="num">${r.points}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function visibleMatchesFor(tournament, sportId) {
    const sport = getSportConfig(tournament, sportId);
    const published = scheduleIsPublished(sport);
    return state.matches.filter(function (m) {
      if (m.sport !== sportId) return false;
      if (state.isAdmin) return true;
      if (m.fromSchedule || m.scheduleEntryId) return published;
      return true;
    });
  }

  function renderMatchListsFor(tournament, sportId) {
    const scoped = visibleMatchesFor(tournament, sportId);
    const live = scoped.filter(function (m) { return m.status === 'in_progress'; }).sort(sortMatches);
    const upcoming = scoped.filter(function (m) { return m.status === 'scheduled'; }).sort(sortMatches);
    const completed = scoped.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse();
    fillMatchList('tLiveList', 'tLiveSection', live, tournament);
    fillMatchList('tUpcomingList', 'tUpcomingSection', upcoming, tournament);
    fillMatchList('tCompletedList', 'tCompletedSection', completed, tournament, { compact: true });
  }

  function renderPlayoffsFor(tournament, sportId) {
    const scoped = visibleMatchesFor(tournament, sportId).filter(function (m) { return m.stage !== 'league'; });
    const sec = document.getElementById('tPlayoffsSection');
    const wrap = document.getElementById('tPlayoffs');
    if (!sec || !wrap) return;
    if (!scoped.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    wrap.innerHTML = '';
    const section = function (title, items) {
      const card = el('div', { class: 't-card' });
      card.innerHTML = `<div class="t-card-header"><h3>${escapeHtml(title)}</h3></div><div class="t-card-body"></div>`;
      const body = card.querySelector('.t-card-body');
      if (!items.length) body.innerHTML = '<p class="t-empty" style="padding:12px;">Not scheduled yet.</p>';
      items.forEach(function (m) { body.appendChild(matchWithActions(m, tournament, { canEdit: state.isAdmin })); });
      return card;
    };
    const sportCfg = getSportConfig(tournament, sportId);
    const stages = enabledStagesFor(sportCfg);
    if (stages.indexOf('semifinal') !== -1) {
      wrap.appendChild(section('Semifinals', scoped.filter(function (m) { return m.stage === 'semifinal'; })));
    }
    if (stages.indexOf('final') !== -1) {
      wrap.appendChild(section('Final', scoped.filter(function (m) { return m.stage === 'final'; })));
    }
    if (stages.indexOf('third_place') !== -1) {
      const third = scoped.filter(function (m) { return m.stage === 'third_place'; });
      if (third.length) wrap.appendChild(section('3rd Place', third));
    } else {
      // Sport has third_place disabled — still show any orphaned 3rd-place matches so admin can delete them.
      const orphan = scoped.filter(function (m) { return m.stage === 'third_place'; });
      if (orphan.length) {
        wrap.appendChild(section('3rd Place (disabled — clean up)', orphan));
      }
    }
  }

  function sortMatches(a, b) {
    const sa = a.scheduledAt || '';
    const sb = b.scheduledAt || '';
    if (sa && sb) return sa.localeCompare(sb);
    if (sa) return -1;
    if (sb) return 1;
    return (a.createdAt && a.createdAt.seconds || 0) - (b.createdAt && b.createdAt.seconds || 0);
  }

  function fillMatchList(listId, sectionId, matches, tournament, opts) {
    const sec = document.getElementById(sectionId);
    const list = document.getElementById(listId);
    if (!sec || !list) return;
    if (!matches.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    list.innerHTML = '';
    matches.forEach(function (m) { list.appendChild(matchWithActions(m, tournament, Object.assign({ canEdit: state.isAdmin }, opts || {}))); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MATCH CARD RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function renderMatchHeadline(match, tournament) {
    const sport = getSportConfig(tournament, match.sport);
    const p = participantsOf(match, tournament);
    const aMeta = teamMeta(tournament, match.sport, p.a);
    const bMeta = teamMeta(tournament, match.sport, p.b);
    const s = matchScoreDisplay(match, tournament);
    const aWin = match.winner === 'A';
    const bWin = match.winner === 'B';
    return `
      <div class="t-match-head">
        <div class="t-match-meta">
          <span class="t-badge stage-${match.stage}">${escapeHtml(STAGE_LABEL[match.stage] || match.stage)}</span>
          <span class="t-badge status-${match.status || 'scheduled'}">${escapeHtml(STATUS_LABEL[match.status] || 'Scheduled')}</span>
          ${match.venue ? '<span class="t-badge">📍 ' + escapeHtml(match.venue) + '</span>' : ''}
          ${match.scheduledAt ? '<span class="t-badge">🕒 ' + escapeHtml(fmtDateTime(match.scheduledAt)) + '</span>' : ''}
        </div>
      </div>
      <div class="t-match-body">
        <div class="t-match-team ${aWin ? 'winner' : ''}">
          <span class="avatar" style="--team-color:${aMeta.color}">${escapeHtml((aMeta.name || 'A').slice(0, 2).toUpperCase())}</span>
          <div class="info">
            <div class="name">${escapeHtml(aMeta.name)}</div>
            ${aMeta.wards ? '<div class="wards">' + escapeHtml(aMeta.wards) + '</div>' : ''}
          </div>
        </div>
        <div class="t-match-score"><span>${s.a}</span><span class="dash">–</span><span>${s.b}</span></div>
        <div class="t-match-team right ${bWin ? 'winner' : ''}">
          <div class="info">
            <div class="name">${escapeHtml(bMeta.name)}</div>
            ${bMeta.wards ? '<div class="wards">' + escapeHtml(bMeta.wards) + '</div>' : ''}
          </div>
          <span class="avatar" style="--team-color:${bMeta.color}">${escapeHtml((bMeta.name || 'B').slice(0, 2).toUpperCase())}</span>
        </div>
      </div>
    `;
  }

  function renderRacketDetail(match, tournament) {
    const rows = (match.games || []).map(function (g) {
      const setsStr = (g.sets || []).map(function (s) {
        const cfg = getStageScoring(tournament, match.sport, match.stage);
        const w = racketSetWinner(s, cfg);
        return '<span class="' + (w ? 'won' : '') + '">' + (s.a || 0) + '-' + (s.b || 0) + '</span>';
      }).join('');
      const wonClass = g.winner === 'A' ? 'won-a' : (g.winner === 'B' ? 'won-b' : '');
      return `
        <tr class="${wonClass}">
          <td class="cat">${escapeHtml(g.category)}</td>
          <td class="players">${escapeHtml(g.playersA || '—')}</td>
          <td class="players">${escapeHtml(g.playersB || '—')}</td>
          <td class="num"><div class="t-set-scores">${setsStr || '<span>0-0</span>'}</div></td>
          <td class="num">${g.winner ? (g.winner === 'A' ? 'A' : 'B') : '—'}</td>
        </tr>
      `;
    }).join('');
    if (!rows) return '';
    return `
      <div class="t-match-details">
        <table class="t-games-table">
          <thead><tr><th>Cat</th><th>A players</th><th>B players</th><th style="text-align:center;">Sets</th><th style="text-align:center;">Won</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderVolleyballDetail(match, tournament) {
    const sets = match.sets || [];
    if (!sets.length) return '';
    const p = participantsOf(match, tournament);
    const cfg = getStageScoring(tournament, match.sport, match.stage);
    let a = 0, b = 0;
    const rows = sets.map(function (s, i) {
      const isDeciding = i === ((cfg && cfg.bestOf) || 3) - 1;
      const w = volleyballSetWinner(s, cfg, isDeciding);
      if (w === 'A') a++; else if (w === 'B') b++;
      return `
        <div class="p-label">Set ${i + 1}</div>
        <div class="p-score ${w === 'A' ? 'won' : ''}">${s.a || 0}</div>
        <div class="p-score ${w === 'B' ? 'won' : ''}">${s.b || 0}</div>
      `;
    }).join('');
    return `
      <div class="t-match-details">
        <div class="t-periods">
          <div></div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, match.sport, p.a))}</div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, match.sport, p.b))}</div>
          ${rows}
          <div class="p-label p-total">Sets</div>
          <div class="p-score p-total">${a}</div>
          <div class="p-score p-total">${b}</div>
        </div>
      </div>
    `;
  }

  function renderBasketballDetail(match, tournament) {
    const qs = match.quarters || [];
    if (!qs.length) return '';
    const p = participantsOf(match, tournament);
    let ta = 0, tb = 0;
    const rows = qs.map(function (q, i) {
      ta += q.a || 0; tb += q.b || 0;
      return `<div class="p-label">Q${i + 1}</div><div class="p-score">${q.a || 0}</div><div class="p-score">${q.b || 0}</div>`;
    }).join('');
    return `
      <div class="t-match-details">
        <div class="t-periods">
          <div></div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, match.sport, p.a))}</div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, match.sport, p.b))}</div>
          ${rows}
          <div class="p-label p-total">Total</div>
          <div class="p-score p-total">${ta}</div>
          <div class="p-score p-total">${tb}</div>
        </div>
      </div>
    `;
  }

  function renderMatchDetail(match, tournament) {
    const sc = getSportConfig(tournament, match.sport);
    if (!sc) return '';
    if (sc.kind === 'racket') return renderRacketDetail(match, tournament);
    if (sc.kind === 'volleyball') return renderVolleyballDetail(match, tournament);
    if (sc.kind === 'basketball') return renderBasketballDetail(match, tournament);
    return '';
  }

  function matchWithActions(match, tournament, opts) {
    opts = opts || {};
    const classes = ['t-match'];
    if (match.status === 'in_progress') classes.push('live');
    if (match.status === 'completed') classes.push('completed');
    const node = el('div', { class: classes.join(' ') });
    node.innerHTML = renderMatchHeadline(match, tournament) + (opts.compact ? '' : renderMatchDetail(match, tournament));
    if (opts.canEdit) {
      const actions = el('div', { class: 't-match-details', style: { borderTop: '1px solid var(--t-border)', paddingTop: '12px' } });
      const btns = [];
      if (match.status === 'scheduled') {
        btns.push('<button class="t-btn success sm" data-act="start">▶ Start match</button>');
        btns.push('<button class="t-btn sm" data-act="schedule">📅 Reschedule</button>');
      } else if (match.status === 'in_progress') {
        btns.push('<button class="t-btn primary sm" data-act="score">🎯 Enter scores</button>');
        btns.push('<button class="t-btn sm" data-act="complete">✔ Mark complete</button>');
        btns.push('<button class="t-btn sm" data-act="reopen">↺ Back to scheduled</button>');
      } else {
        btns.push('<button class="t-btn primary sm" data-act="score">✏ Edit scores</button>');
        btns.push('<button class="t-btn sm" data-act="reopen">↺ Reopen</button>');
      }
      // Delete is always available to admins, regardless of match status.
      btns.push('<button class="t-btn danger sm" data-act="delete">🗑 Delete</button>');
      actions.innerHTML = btns.join(' ');
      actions.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          handleMatchAction(match, tournament, btn.getAttribute('data-act'));
        });
      });
      node.appendChild(actions);
    }
    return node;
  }

  async function handleMatchAction(match, tournament, act) {
    try {
      const ref = db.collection('tournament_matches').doc(match.id);
      const sport = getSportConfig(tournament, match.sport);
      if (act === 'delete') {
        const p = participantsOf(match, tournament);
        const label = displayName(tournament, match.sport, p.a) + ' vs ' + displayName(tournament, match.sport, p.b);
        const warn = match.status === 'completed'
          ? '\n\nThis match is COMPLETED. Deleting it will remove it from standings and cannot be undone.'
          : match.status === 'in_progress'
            ? '\n\nThis match is LIVE. Deleting it will remove all entered scores and cannot be undone.'
            : '\n\nThis cannot be undone.';
        if (!confirm('Delete ' + STAGE_LABEL[match.stage] + ' — ' + label + '?' + warn)) return;
        await ref.delete();
        toast('Match deleted');
      } else if (act === 'start') {
        const update = { status: 'in_progress', updatedAt: FieldValue.serverTimestamp() };
        if (sport.kind === 'racket' && (!match.games || !match.games.length)) {
          const cats = (sport.categories && sport.categories.length) ? sport.categories : DEFAULT_CATEGORIES;
          update.games = cats.map(function (c) { return { category: c, playersA: '', playersB: '', sets: [{ a: 0, b: 0 }], status: 'pending', winner: null }; });
        }
        if (sport.kind === 'volleyball' && (!match.sets || !match.sets.length)) update.sets = [{ a: 0, b: 0 }];
        if (sport.kind === 'basketball' && (!match.quarters || !match.quarters.length)) update.quarters = [{ a: 0, b: 0 }];
        await ref.update(update);
        toast('Match started');
      } else if (act === 'complete') {
        const winner = matchWinner(match, tournament);
        if (!winner && !confirm('No clear winner detected. Mark complete anyway?')) return;
        await ref.update({ status: 'completed', winner: winner || null, updatedAt: FieldValue.serverTimestamp() });
        toast('Match completed');
      } else if (act === 'reopen') {
        await ref.update({ status: 'scheduled', winner: null, updatedAt: FieldValue.serverTimestamp() });
        toast('Match reopened');
      } else if (act === 'schedule') {
        const cur = toDatetimeLocal(match.scheduledAt);
        const val = prompt('New date/time (YYYY-MM-DDTHH:mm) — leave blank to clear', cur);
        if (val === null) return;
        await ref.update({ scheduledAt: fromDatetimeLocal(val), updatedAt: FieldValue.serverTimestamp() });
        toast('Schedule updated');
      } else if (act === 'score') {
        openScorer(match, tournament);
      }
    } catch (err) {
      console.error(err);
      toast('Action failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPORT SCHEDULE (draft → publish)
  // ═══════════════════════════════════════════════════════════════════════════

  function scheduleKey(tournamentId, sportId) {
    return String(tournamentId || '') + '|' + String(sportId || '');
  }

  function harvestScheduleEditor() {
    const table = document.getElementById('tScheduleEditor');
    if (!table) return;
    const tId = table.getAttribute('data-tournament');
    const sId = table.getAttribute('data-sport');
    if (!tId || !sId) return;
    const key = scheduleKey(tId, sId);
    const prev = scheduleEditByKey[key] || { entries: [], dirty: false };
    scheduleEditByKey[key] = {
      entries: readScheduleEntriesFromDom(),
      dirty: !!prev.dirty
    };
  }

  function readWorkingEntries(tournament, sport) {
    const table = document.getElementById('tScheduleEditor');
    if (table
        && table.getAttribute('data-tournament') === tournament.id
        && table.getAttribute('data-sport') === sport.id) {
      const entries = readScheduleEntriesFromDom();
      const key = scheduleKey(tournament.id, sport.id);
      const prev = scheduleEditByKey[key] || { dirty: false };
      scheduleEditByKey[key] = { entries: entries, dirty: !!prev.dirty };
      return entries;
    }
    return workingScheduleEntries(tournament, sport);
  }

  function readScheduleEntriesFromDom() {
    const rows = document.querySelectorAll('#tScheduleEditor tbody tr[data-entry-id]');
    const out = [];
    rows.forEach(function (row) {
      const stageEl = row.querySelector('[data-f="stage"]');
      const aEl = row.querySelector('[data-f="a"]');
      const bEl = row.querySelector('[data-f="b"]');
      const whenEl = row.querySelector('[data-f="when"]');
      const venueEl = row.querySelector('[data-f="venue"]');
      const whenVal = whenEl ? whenEl.value : '';
      out.push({
        id: row.getAttribute('data-entry-id'),
        stage: stageEl ? stageEl.value : 'league',
        a: aEl ? aEl.value.trim() : '',
        b: bEl ? bEl.value.trim() : '',
        scheduledAt: whenVal ? fromDatetimeLocal(whenVal) : '',
        venue: venueEl ? venueEl.value.trim() : '',
        matchId: row.getAttribute('data-match-id') || ''
      });
    });
    return out;
  }

  function markScheduleDirty(tournamentId, sportId) {
    const key = scheduleKey(tournamentId, sportId);
    const cur = scheduleEditByKey[key] || { entries: [], dirty: false };
    cur.dirty = true;
    scheduleEditByKey[key] = cur;
  }

  function entriesFromMatches(tournament, sportId) {
    return state.matches
      .filter(function (m) { return m.sport === sportId; })
      .sort(sortMatches)
      .map(function (m) {
        const p = participantsOf(m, tournament);
        return emptyScheduleEntry({
          id: m.scheduleEntryId || m.id,
          stage: m.stage || 'league',
          a: p.a || '',
          b: p.b || '',
          scheduledAt: m.scheduledAt || '',
          venue: m.venue || '',
          matchId: m.id
        });
      });
  }

  function workingScheduleEntries(tournament, sport) {
    const key = scheduleKey(tournament.id, sport.id);
    const local = scheduleEditByKey[key];
    if (local && local.dirty && Array.isArray(local.entries)) return local.entries;
    const sch = getSchedule(sport);
    if (sch.draft && Array.isArray(sch.draft.entries) && sch.draft.entries.length) {
      return sanitizeScheduleEntries(sch.draft.entries);
    }
    if (sch.published && Array.isArray(sch.published.entries) && sch.published.entries.length) {
      return sanitizeScheduleEntries(sch.published.entries);
    }
    const fromMatches = entriesFromMatches(tournament, sport.id);
    if (fromMatches.length) return fromMatches;
    return [];
  }

  function scheduleHasUnpublishedChanges(tournament, sport) {
    const key = scheduleKey(tournament.id, sport.id);
    const local = scheduleEditByKey[key];
    if (local && local.dirty) return true;
    const sch = getSchedule(sport);
    if (!sch.published) return !!(sch.draft && (sch.draft.entries || []).length);
    const draftEntries = JSON.stringify(sanitizeScheduleEntries((sch.draft && sch.draft.entries) || []));
    const pubEntries = JSON.stringify(sanitizeScheduleEntries(sch.published.entries || []));
    return draftEntries !== pubEntries;
  }

  function participantSelectHtml(tournament, sport, field, selected) {
    if (tournament.format === 'teams') {
      const teams = teamsFor(tournament, sport);
      const opts = ['<option value="">Select team…</option>'].concat(teams.map(function (tm) {
        return '<option value="' + escapeHtml(tm.id) + '"' + (tm.id === selected ? ' selected' : '') + '>'
          + escapeHtml(tm.name || tm.id)
          + (tm.wards ? ' — ' + escapeHtml(tm.wards) : '')
          + '</option>';
      }));
      return '<select class="t-select" data-f="' + field + '">' + opts.join('') + '</select>';
    }
    return '<input type="text" class="t-input" data-f="' + field + '" value="' + escapeHtml(selected || '') + '" placeholder="Player / pair" />';
  }

  function renderScheduleFor(tournament, sport) {
    const body = document.getElementById('tScheduleBody');
    const actions = document.getElementById('tScheduleActions');
    if (!body) return;

    const sch = getSchedule(sport);
    const published = scheduleIsPublished(sport);
    const canEdit = canEditSchedule();
    const entries = canEdit
      ? workingScheduleEntries(tournament, sport)
      : sanitizeScheduleEntries((sch.published && sch.published.entries) || []);

    if (actions) {
      if (canEdit) {
        const dirty = scheduleHasUnpublishedChanges(tournament, sport);
        actions.innerHTML = `
          ${published
            ? '<span class="t-badge locked">Published</span>'
            : '<span class="t-badge unlocked">Draft</span>'}
          ${dirty && published ? '<span class="t-badge nologin">Unpublished changes</span>' : ''}
          <button class="t-btn sm" type="button" onclick="window.__tournament.addScheduleRow('${tournament.id}','${sport.id}')">➕ Add match</button>
          ${tournament.format === 'teams' && teamsFor(tournament, sport).length >= 2
            ? '<button class="t-btn sm" type="button" onclick="window.__tournament.generateLeagueSchedule(\'' + tournament.id + '\',\'' + sport.id + '\')">↺ Generate league</button>'
            : ''}
          <button class="t-btn sm" type="button" onclick="window.__tournament.saveScheduleDraft('${tournament.id}','${sport.id}')">💾 Save draft</button>
          <button class="t-btn sm primary" type="button" onclick="window.__tournament.publishSchedule('${tournament.id}','${sport.id}')">📢 Publish</button>
          <button class="t-btn sm danger" type="button" onclick="window.__tournament.clearSchedule('${tournament.id}','${sport.id}')">Clear schedule</button>
        `;
      } else if (published) {
        actions.innerHTML = '<span class="t-badge locked">Published</span>';
      } else {
        actions.innerHTML = '';
      }
    }

    if (!canEdit && !published) {
      body.innerHTML = '<div class="t-schedule-empty">The schedule for this sport hasn\'t been published yet. Check back after an admin publishes it.</div>';
      return;
    }

    if (!canEdit) {
      body.innerHTML = renderScheduleReadOnly(tournament, sport, entries, sch.published);
      return;
    }

    body.innerHTML = renderScheduleEditor(tournament, sport, entries, sch);
    bindScheduleEditor(tournament, sport);
  }

  function renderScheduleReadOnly(tournament, sport, entries, publishedMeta) {
    if (!entries.length) {
      return '<div class="t-schedule-empty">No fixtures in the published schedule.</div>';
    }
    const sorted = entries.slice().sort(function (a, b) {
      return (a.scheduledAt || '').localeCompare(b.scheduledAt || '');
    });
    const whenNote = publishedMeta && publishedMeta.publishedAt
      ? '<div class="t-schedule-note">Published ' + escapeHtml(fmtDateTime(publishedMeta.publishedAt))
        + (publishedMeta.publishedBy ? ' by ' + escapeHtml(publishedMeta.publishedBy) : '') + '</div>'
      : '';
    const rows = sorted.map(function (e) {
      const aName = displayName(tournament, sport.id, e.a);
      const bName = displayName(tournament, sport.id, e.b);
      return `
        <tr>
          <td><span class="t-badge stage-${escapeHtml(e.stage)}">${escapeHtml(STAGE_LABEL[e.stage] || e.stage)}</span></td>
          <td class="t-schedule-vs"><b>${escapeHtml(aName)}</b> <span>vs</span> <b>${escapeHtml(bName)}</b></td>
          <td>${e.scheduledAt ? escapeHtml(fmtDateTime(e.scheduledAt)) : '—'}</td>
          <td>${e.venue ? escapeHtml(e.venue) : '—'}</td>
        </tr>
      `;
    }).join('');
    return `
      ${whenNote}
      <div class="t-schedule-wrap">
        <table class="t-schedule-table">
          <thead><tr><th>Stage</th><th>Match</th><th>When</th><th>Venue</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderScheduleEditor(tournament, sport, entries, sch) {
    const stages = enabledStagesFor(sport);
    const savedNote = sch.draft && sch.draft.savedAt
      ? 'Last draft saved ' + fmtDateTime(sch.draft.savedAt)
        + (sch.draft.savedBy ? ' by ' + sch.draft.savedBy : '')
      : 'Not saved yet — use Save draft to keep your work.';
    if (!entries.length) {
      return `
        <div class="t-schedule-empty">
          No fixtures yet. Add a match or generate a league round-robin, then <b>Save draft</b>.
          Publish when the schedule is ready for everyone to see.
        </div>
        <div class="t-schedule-note">${escapeHtml(savedNote)}</div>
        <table class="t-schedule-table" id="tScheduleEditor" data-tournament="${escapeHtml(tournament.id)}" data-sport="${escapeHtml(sport.id)}" style="display:none;">
          <tbody></tbody>
        </table>
      `;
    }
    const rows = entries.map(function (e) {
      const stageOpts = stages.map(function (st) {
        return '<option value="' + st + '"' + (e.stage === st ? ' selected' : '') + '>' + STAGE_LABEL[st] + '</option>';
      }).join('');
      return `
        <tr data-entry-id="${escapeHtml(e.id)}" data-match-id="${escapeHtml(e.matchId || '')}">
          <td><select class="t-select" data-f="stage">${stageOpts}</select></td>
          <td>${participantSelectHtml(tournament, sport, 'a', e.a)}</td>
          <td class="t-schedule-vs-cell">vs</td>
          <td>${participantSelectHtml(tournament, sport, 'b', e.b)}</td>
          <td><input type="datetime-local" class="t-input" data-f="when" value="${escapeHtml(toDatetimeLocal(e.scheduledAt))}" /></td>
          <td><input type="text" class="t-input" data-f="venue" value="${escapeHtml(e.venue || '')}" placeholder="Venue" /></td>
          <td><button type="button" class="t-btn danger sm" data-remove-row="${escapeHtml(e.id)}">Remove</button></td>
        </tr>
      `;
    }).join('');
    return `
      <div class="t-schedule-note">${escapeHtml(savedNote)} Only admins can edit. Everyone else sees this after you publish.</div>
      <div class="t-schedule-wrap">
        <table class="t-schedule-table" id="tScheduleEditor" data-tournament="${escapeHtml(tournament.id)}" data-sport="${escapeHtml(sport.id)}">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Side A</th>
              <th></th>
              <th>Side B</th>
              <th>When</th>
              <th>Venue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function bindScheduleEditor(tournament, sport) {
    const table = document.getElementById('tScheduleEditor');
    if (!table) return;
    table.addEventListener('input', function () {
      markScheduleDirty(tournament.id, sport.id);
    });
    table.addEventListener('change', function () {
      markScheduleDirty(tournament.id, sport.id);
    });
    table.querySelectorAll('[data-remove-row]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeScheduleRow(tournament.id, sport.id, btn.getAttribute('data-remove-row'));
      });
    });
  }

  function currentScheduleContext(tournamentId, sportId) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    return { t: t, sport: sport };
  }

  function persistLocalEntries(tournamentId, sportId, entries, dirty) {
    scheduleEditByKey[scheduleKey(tournamentId, sportId)] = {
      entries: sanitizeScheduleEntries(entries),
      dirty: dirty !== false
    };
  }

  function addScheduleRow(tournamentId, sportId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const entries = readWorkingEntries(t, sport).slice();
    const teams = teamsFor(t, sport);
    const a = teams[0] ? teams[0].id : '';
    const b = teams[1] ? teams[1].id : '';
    entries.push(emptyScheduleEntry({
      a: t.format === 'teams' ? a : '',
      b: t.format === 'teams' ? b : '',
      scheduledAt: sport.date ? new Date(sport.date + 'T18:00:00').toISOString() : ''
    }));
    persistLocalEntries(tournamentId, sportId, entries, true);
    renderScheduleFor(t, sport);
  }

  function removeScheduleRow(tournamentId, sportId, entryId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const entries = readWorkingEntries(t, sport).filter(function (e) { return e.id !== entryId; });
    persistLocalEntries(tournamentId, sportId, entries, true);
    renderScheduleFor(t, sport);
  }

  function generateLeagueSchedule(tournamentId, sportId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const teams = teamsFor(t, sport);
    if (teams.length < 2) return toast('Add at least 2 teams before generating a league schedule', 'error');
    harvestScheduleEditor();
    const existing = readWorkingEntries(t, sport);
    const playoffs = existing.filter(function (e) { return e.stage && e.stage !== 'league'; });
    if (existing.length && !confirm('Replace league fixtures with a generated round-robin? Playoff rows will be kept.')) return;
    const league = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        league.push(emptyScheduleEntry({
          stage: 'league',
          a: teams[i].id,
          b: teams[j].id,
          scheduledAt: sport.date ? new Date(sport.date + 'T18:00:00').toISOString() : ''
        }));
      }
    }
    persistLocalEntries(tournamentId, sportId, league.concat(playoffs), true);
    renderScheduleFor(t, sport);
    toast('League round-robin generated — save draft or publish when ready');
  }

  async function writeSportPatch(tournament, sportId, patch) {
    const sports = (tournament.sports || []).map(function (s) {
      if (s.id !== sportId) return s;
      return Object.assign({}, s, patch);
    });
    try {
      await db.collection('tournaments').doc(tournament.id).update({
        sports: sports,
        updatedAt: FieldValue.serverTimestamp()
      });
      const idx = state.tournaments.findIndex(function (x) { return x.id === tournament.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { sports: sports });
    } catch (err) {
      console.error('[tournament] writeSportPatch FAILED', err);
      toast('Save failed: ' + (err.message || err.code || 'unknown'), 'error');
      throw err;
    }
  }

  async function saveScheduleDraft(tournamentId, sportId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const entries = sanitizeScheduleEntries(readWorkingEntries(t, sport));
    const nowIso = new Date().toISOString();
    const who = (state.user && (state.user.email || state.user.displayName)) || '';
    const prev = getSchedule(sport);
    const schedule = {
      draft: { entries: entries, savedAt: nowIso, savedBy: who },
      published: prev.published || null
    };
    try {
      await writeSportPatch(t, sportId, { schedule: schedule });
      persistLocalEntries(tournamentId, sportId, entries, false);
      toast('Draft saved — not visible to others until you publish', 'success');
      render();
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  async function publishSchedule(tournamentId, sportId) {
    if (!canEditSchedule()) return toast('Only admins can publish the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const entries = sanitizeScheduleEntries(readWorkingEntries(t, sport));
    if (!entries.length) return toast('Add at least one match before publishing', 'error');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.a || !e.b) return toast('Every match needs two sides before publishing', 'error');
      if (e.a === e.b) return toast('A match cannot have the same team on both sides', 'error');
    }
    if (!confirm('Publish this schedule? Everyone signed in will be able to view it.')) return;

    const nowIso = new Date().toISOString();
    const who = (state.user && (state.user.email || state.user.displayName)) || '';
    const schedule = {
      draft: { entries: entries, savedAt: nowIso, savedBy: who },
      published: { entries: entries, publishedAt: nowIso, publishedBy: who }
    };

    try {
      await syncPublishedMatches(t, sport, entries);
      await writeSportPatch(t, sportId, { schedule: schedule });
      persistLocalEntries(tournamentId, sportId, entries, false);
      toast('Schedule published', 'success');
      render();
    } catch (_) { /* already toasted */ }
  }

  async function deleteScheduleMatches(tournament, sport) {
    const existing = state.matches.filter(function (m) { return m.sport === sport.id; });
    const col = db.collection('tournament_matches');
    for (let i = 0; i < existing.length; i++) {
      const m = existing[i];
      if (!m.fromSchedule && !m.scheduleEntryId) continue;
      if (m.status && m.status !== 'scheduled') continue;
      await col.doc(m.id).delete();
    }
  }

  async function clearSchedule(tournamentId, sportId) {
    if (!canEditSchedule()) return toast('Only admins can clear the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const published = scheduleIsPublished(sport);
    const sch = getSchedule(sport);
    const local = scheduleEditByKey[scheduleKey(tournamentId, sportId)];
    const hasDraft = !!(sch.draft && Array.isArray(sch.draft.entries) && sch.draft.entries.length);
    const hasLocal = !!(local && Array.isArray(local.entries) && local.entries.length);
    if (!published && !hasDraft && !hasLocal) return toast('Schedule is already empty');

    if (published) {
      if (!confirm('This schedule is published and everyone can see it. Clear it anyway?')) return;
      if (!confirm('This cannot be undone. Remove all published fixtures and scheduled match cards for this sport? Live or completed matches will be kept.')) return;
    } else if (!confirm('Clear this sport\'s schedule draft? This cannot be undone.')) {
      return;
    }

    try {
      await deleteScheduleMatches(t, sport);
      await writeSportPatch(t, sportId, { schedule: { draft: null, published: null } });
      persistLocalEntries(tournamentId, sportId, [], false);
      delete scheduleEditByKey[scheduleKey(tournamentId, sportId)];
      toast('Schedule cleared', 'success');
      if (published) {
        confirm('The published schedule was cleared. Members will no longer see those fixtures. Click OK to continue.');
      }
      render();
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  function buildMatchData(tournament, sport, entry) {
    const stageCfg = getStageScoring(tournament, sport.id, entry.stage);
    const data = {
      tournamentId: tournament.id,
      sport: sport.id,
      stage: entry.stage || 'league',
      scheduledAt: entry.scheduledAt || '',
      venue: entry.venue || '',
      status: 'scheduled',
      winner: null,
      scoringConfig: stageCfg,
      published: true,
      fromSchedule: true,
      scheduleEntryId: entry.id,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: (state.user && state.user.email) || ''
    };
    if (tournament.format === 'teams') {
      data.teamA = entry.a;
      data.teamB = entry.b;
    } else {
      data.playerA = entry.a;
      data.playerB = entry.b;
    }
    if (sport.kind === 'racket') data.games = [];
    else if (sport.kind === 'volleyball') data.sets = [];
    else if (sport.kind === 'basketball') data.quarters = [];
    return data;
  }

  async function syncPublishedMatches(tournament, sport, entries) {
    const existing = state.matches.filter(function (m) { return m.sport === sport.id; });
    const byEntryId = {};
    const byMatchId = {};
    existing.forEach(function (m) {
      if (m.scheduleEntryId) byEntryId[m.scheduleEntryId] = m;
      byMatchId[m.id] = m;
    });
    const keptMatchIds = {};
    const col = db.collection('tournament_matches');

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const found = (e.matchId && byMatchId[e.matchId]) || byEntryId[e.id] || null;
      if (found) {
        keptMatchIds[found.id] = true;
        e.matchId = found.id;
        const patch = {
          stage: e.stage || 'league',
          scheduledAt: e.scheduledAt || '',
          venue: e.venue || '',
          published: true,
          fromSchedule: true,
          scheduleEntryId: e.id,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: (state.user && state.user.email) || ''
        };
        if (tournament.format === 'teams') {
          patch.teamA = e.a;
          patch.teamB = e.b;
        } else {
          patch.playerA = e.a;
          patch.playerB = e.b;
        }
        // Don't clobber scores on matches that have already started.
        if (found.status === 'scheduled') {
          await col.doc(found.id).update(patch);
        } else {
          await col.doc(found.id).update({
            scheduledAt: patch.scheduledAt,
            venue: patch.venue,
            scheduleEntryId: e.id,
            published: true,
            fromSchedule: true,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      } else {
        const data = buildMatchData(tournament, sport, e);
        data.createdAt = FieldValue.serverTimestamp();
        const ref = await col.add(data);
        e.matchId = ref.id;
        keptMatchIds[ref.id] = true;
      }
    }

    // Drop scheduled matches that were created from this schedule but removed
    // from the fixture list. Leave live / completed matches alone.
    for (let i = 0; i < existing.length; i++) {
      const m = existing[i];
      if (!m.fromSchedule && !m.scheduleEntryId) continue;
      if (keptMatchIds[m.id]) continue;
      if (m.status && m.status !== 'scheduled') continue;
      await col.doc(m.id).delete();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC MODAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC MODAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  // Creates (or reuses) a persistent modal shell with the given DOM id, and
  // returns { modal, body }. The shell owns its own close button.
  function getOrCreateModal(id, title, opts) {
    let modal = document.getElementById(id);
    if (!modal) {
      modal = el('div', { class: 't-modal', id: id });
      modal.innerHTML = `
        <div class="t-modal-content ${(opts && opts.wide) ? 'wide' : ''}">
          <div class="t-modal-head">
            <h3 data-title></h3>
            <button class="t-modal-close" type="button" data-close>×</button>
          </div>
          <div class="t-modal-body" data-body></div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('[data-close]').addEventListener('click', function () {
        closeLiveModal(id);
      });
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeLiveModal(id);
      });
    }
    modal.querySelector('[data-title]').textContent = title;
    // Re-append to end of <body> so this modal always stacks on top of any
    // other .t-modal that's currently open (they share z-index: 1000, so
    // DOM order breaks the tie). This is what makes "Add from directory"
    // open on top of the roster modal, and the captain picker on top of the
    // roster modal, etc.
    document.body.appendChild(modal);
    return { modal: modal, body: modal.querySelector('[data-body]') };
  }

  function closeLiveModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
    openLiveModal = null;
    openLiveModalContext = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAPTAIN PICKER (admin only) — search the users collection
  // ═══════════════════════════════════════════════════════════════════════════

  function openCaptainPicker(tournamentId, sportId, teamId) {
    if (!canManageCaptains()) return;
    openLiveModal = 'userPicker';
    openLiveModalContext = { tournamentId, sportId, teamId, query: '' };
    rerenderUserPicker();
  }

  function rerenderUserPicker() {
    if (openLiveModal !== 'userPicker') return;
    const ctx = openLiveModalContext || {};
    const t = state.tournaments.find(function (x) { return x.id === ctx.tournamentId; });
    const sport = t ? getSportConfig(t, ctx.sportId) : null;
    const teams = sport ? (sport.teams || []) : [];
    const team = teams.find(function (x) { return x.id === ctx.teamId; });
    const teamLabel = team ? (team.name || team.id) : ctx.teamId;
    const sportLabel = sport ? ((sport.emoji || '') + ' ' + sport.label) : ctx.sportId;

    const { modal, body } = getOrCreateModal('tCaptainPicker', 'Assign captain — ' + sportLabel + ' · ' + teamLabel, { wide: false });
    const currentCaptainRow = team && (team.captainUid || team.captainName || team.captainEmail)
      ? `<div class="t-captain-current">
           <div>
             <div class="lbl">Current captain</div>
             <div class="val">👤 ${escapeHtml(team.captainName || team.captainEmail || team.captainUid)}</div>
             <div class="sub">
               ${team.captainEmail ? escapeHtml(team.captainEmail) : ''}
               ${team.captainEmail && team.captainFamilyId ? ' · ' : ''}
               ${team.captainFamilyId ? 'FID ' + escapeHtml(team.captainFamilyId) : ''}
             </div>
             ${team.captainUid
                ? '<div class="sub" style="color:var(--t-success);">✓ signed in — can manage roster</div>'
                : '<div class="sub" style="color:var(--t-warning);">⚠ hasn\'t signed in yet — can\'t edit roster until they sign in with Google</div>'}
           </div>
           <button class="t-btn danger sm" data-remove-captain>Remove captain</button>
         </div>`
      : `<div class="t-captain-current empty">No captain assigned yet.</div>`;

    const totalKnown = getKnownPeople().length;
    const usersCount = state.users.length;
    const rsvpCount = state.rsvpResponses.length;

    // Diagnostic pills — only shown when something's actually wrong (an error
    // occurred, or a source returned zero records). When everything is
    // healthy the picker stays clean. This keeps the debug affordance for
    // future rules issues without cluttering the normal UI.
    function pill(label, count, ready, err) {
      let cls, txt;
      if (err) { cls = 'err'; txt = 'blocked (' + (err.code || 'error') + ')'; }
      else if (!ready) { cls = 'loading'; txt = 'loading…'; }
      else if (count === 0) { cls = 'warn'; txt = 'empty'; }
      else return ''; // healthy — no pill
      return `<span class="t-diag-pill ${cls}"><b>${label}:</b> ${txt}</span>`;
    }
    const pills = [
      pill('users collection', usersCount, state.ready.users, state.errors.users),
      pill('rsvpResponses',   rsvpCount,   state.ready.rsvp,  state.errors.rsvp),
      state.errors.upsert
        ? '<span class="t-diag-pill err"><b>your profile write:</b> failed (' + escapeHtml(state.errors.upsert.code || 'error') + ')</span>'
        : ''
    ].filter(Boolean);
    const statusRow = pills.length
      ? '<div class="t-diag-row">' + pills.join('') + '</div>'
      : '';

    const rulesBlocks = [];
    if (state.errors.users || (state.ready.users && usersCount === 0)) {
      rulesBlocks.push({
        title: '/users/{uid}',
        why: state.errors.users
          ? 'Read was blocked by Firestore rules.'
          : 'Reads OK but the collection is empty — every sign-in should write a doc here.',
        snippet: `match /users/{uid} {
  allow read:          if request.auth != null;
  allow create, update: if request.auth.uid == uid;
  allow delete: if false;
}`
      });
    }
    if (state.errors.rsvp) {
      rulesBlocks.push({
        title: '/rsvpResponses/{doc}',
        why: 'Read was blocked by Firestore rules — the app can\'t use RSVPs as a captain source until admins can read them.',
        snippet: `match /rsvpResponses/{doc} {
  allow read: if request.auth != null;
  // keep your existing write rules
}`
      });
    }
    const rulesHint = rulesBlocks.length
      ? `<div class="t-diag-hint">
           <div style="font-weight:700;margin-bottom:6px;">⚠ Firestore rules need updating</div>
           ${rulesBlocks.map(function (b) {
             return `<div style="margin-top:8px;">
               <div style="font-size:.82rem;">${escapeHtml(b.why)}</div>
               <pre>${escapeHtml(b.snippet)}</pre>
             </div>`;
           }).join('')}
         </div>`
      : '';

    body.innerHTML = `
      ${currentCaptainRow}
      ${statusRow}
      ${rulesHint}
      <div style="margin-top:14px;">
        <label class="t-form-label" for="tCaptainSearch">Search people (first name, last name, email, or Family ID)</label>
        <input id="tCaptainSearch" type="text" class="t-input" placeholder="Type a name or Family ID…" value="${escapeHtml(ctx.query || '')}" autocomplete="off" />
        <div style="font-size:.78rem;color:var(--t-muted);margin-top:6px;">
          <b>${totalKnown}</b> known people total.
          A ✓ badge means the person has a Google sign-in and can manage the roster themselves.
        </div>
      </div>
      <div class="t-user-results" id="tCaptainResults"></div>
    `;

    const input = body.querySelector('#tCaptainSearch');
    const results = body.querySelector('#tCaptainResults');
    const removeBtn = body.querySelector('[data-remove-captain]');
    if (removeBtn) {
      removeBtn.addEventListener('click', async function () {
        await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, null);
        closeLiveModal('tCaptainPicker');
      });
    }

    // Keep the last rendered list around so index-based click handlers
    // pick the right record even after re-rendering.
    let lastList = [];

    function paintResults() {
      if (!state.ready.rsvp && !state.ready.users) {
        results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">Loading people…</div>';
        return;
      }
      lastList = searchPeople(input.value);
      if (!lastList.length) {
        const totalKnown = getKnownPeople().length;
        if (totalKnown === 0) {
          results.innerHTML = '<div style="padding:14px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">No people loaded from any source. See the diagnostic panel above — it usually means Firestore rules need updating.</div>';
        } else {
          results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">No matches for "' + escapeHtml(input.value) + '". Try a different name or a Family ID.</div>';
        }
        return;
      }
      results.innerHTML = lastList.map(function (u, idx) {
        const isCurrent = team && (
          (team.captainUid && u.uid && u.uid === team.captainUid) ||
          (team.captainEmail && u.email && u.email === team.captainEmail.toLowerCase())
        );
        const fullName = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
        const meta = [
          u.familyId ? 'FID ' + escapeHtml(u.familyId) : null,
          u.email ? escapeHtml(u.email) : null
        ].filter(Boolean).join(' · ');
        const loginBadge = u.hasLogin
          ? '<span class="t-badge login" title="This person has a Google sign-in">✓ has login</span>'
          : '<span class="t-badge nologin" title="Assignable, but this person must sign in with Google once before they can edit the roster">no login yet</span>';
        return `
          <div class="t-user-row">
            <div class="who">
              ${u.photoURL ? '<img src="' + escapeHtml(u.photoURL) + '" alt="">' : '<span class="avatar-placeholder">👤</span>'}
              <div>
                <div class="name">${escapeHtml(fullName || u.email || '(unnamed)')} ${loginBadge}</div>
                <div class="email">${meta || '<i style="color:var(--t-muted-2);">no contact info</i>'}</div>
              </div>
            </div>
            ${isCurrent
              ? '<span class="t-badge">Current captain</span>'
              : '<button class="t-btn sm primary" data-pick="' + idx + '">Assign</button>'}
          </div>
        `;
      }).join('');
      results.querySelectorAll('[data-pick]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const idx = parseInt(btn.getAttribute('data-pick'), 10);
          const person = lastList[idx];
          if (!person) return;
          if (!person.hasLogin) {
            const fullName = ((person.firstName || '') + ' ' + (person.lastName || '')).trim();
            if (!confirm(fullName + ' hasn\'t signed in with Google yet, so they can\'t edit their team\'s roster until they do. Assign anyway?')) return;
          }
          await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, person);
          closeLiveModal('tCaptainPicker');
        });
      });
    }

    input.addEventListener('input', function () {
      ctx.query = input.value;
      paintResults();
    });
    paintResults();
    modal.classList.add('open');
    setTimeout(function () { input.focus(); }, 30);
  }

  async function setRosterLock(tournamentId, sportId, teamId, locked) {
    if (!canLockRoster()) { toast('Only admins can lock or unlock rosters', 'error'); return; }
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const patch = locked
      ? {
          locked: true,
          lockedAt: new Date().toISOString(),
          lockedBy: (state.user && state.user.email) || ''
        }
      : {
          locked: false,
          lockedAt: null,
          lockedBy: null
        };
    try {
      await writeTeamPatch(t, sportId, teamId, patch);
      toast(locked ? 'Roster locked' : 'Roster unlocked', 'success');
    } catch (_) { /* writeTeamPatch already toasted the error */ }
  }

  async function setTeamCaptain(tournamentId, sportId, teamId, person) {
    if (!canManageCaptains()) { toast('Only admins can change captains', 'error'); return; }
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) { toast('Tournament not found in local state', 'error'); return; }

    // Find the sport + team up-front so we can fail loudly if the ids are
    // wrong (this was the class of silent bugs that made "captain assigned"
    // toasts fire without the doc actually changing).
    const targetSport = (t.sports || []).find(function (s) { return s.id === sportId; });
    if (!targetSport) { toast('Sport "' + sportId + '" not found', 'error'); return; }
    const targetTeam = (targetSport.teams || []).find(function (tm) { return tm.id === teamId; });
    if (!targetTeam) { toast('Team "' + teamId + '" not found in ' + sportId, 'error'); return; }

    const captainPatch = person
      ? {
          captainUid:      person.uid || null,
          captainName:     (
                             ((person.firstName || '') + ' ' + (person.lastName || '')).trim()
                             || person.displayName || person.email || null
                           ),
          captainEmail:    (person.email || '').toLowerCase() || null,
          captainFamilyId: person.familyId ? String(person.familyId) : null
        }
      : {
          captainUid: null, captainName: null, captainEmail: null, captainFamilyId: null
        };

    const sports = (t.sports || []).map(function (s) {
      if (s.id !== sportId) return s;
      const teams = (s.teams || []).map(function (tm) {
        if (tm.id !== teamId) return tm;
        return Object.assign({}, tm, captainPatch);
      });
      return Object.assign({}, s, { teams: teams });
    });

    const ref = db.collection('tournaments').doc(tournamentId);
    console.log('[tournament] setTeamCaptain →', {
      tournamentId: tournamentId, sportId: sportId, teamId: teamId, patch: captainPatch
    });

    try {
      await ref.update({ sports: sports, updatedAt: FieldValue.serverTimestamp() });

      // Verify the write actually landed on the server. Firestore's compat
      // SDK normally resolves update() only after server confirmation, but
      // caches, offline persistence, or a rules rollback can hide failures
      // — reading with {source:'server'} sidesteps all of those.
      let serverTeam = null;
      try {
        const fresh = await ref.get({ source: 'server' });
        const fData = fresh.exists ? (fresh.data() || {}) : {};
        const fSport = (fData.sports || []).find(function (s) { return s.id === sportId; });
        serverTeam = fSport ? (fSport.teams || []).find(function (tm) { return tm.id === teamId; }) : null;
      } catch (verifyErr) {
        console.warn('[tournament] verify read failed (write may still be OK):', verifyErr);
      }
      const wroteWhat = person
        ? (captainPatch.captainName || captainPatch.captainEmail || '(assigned)')
        : 'removed';
      if (serverTeam) {
        const okUid   = (captainPatch.captainUid   || null) === (serverTeam.captainUid   || null);
        const okName  = (captainPatch.captainName  || null) === (serverTeam.captainName  || null);
        const okEmail = (captainPatch.captainEmail || null) === (serverTeam.captainEmail || null);
        if (!(okUid && okName && okEmail)) {
          console.error('[tournament] captain write DID NOT stick on server:', {
            intended: captainPatch, actualServer: {
              captainUid:      serverTeam.captainUid      || null,
              captainName:     serverTeam.captainName     || null,
              captainEmail:    serverTeam.captainEmail    || null,
              captainFamilyId: serverTeam.captainFamilyId || null
            }
          });
          toast('Server did not accept the captain change. Check Firestore rules for tournaments.', 'error');
          // Do not patch local state so the UI reflects reality.
          return;
        }
      }

      const idx = state.tournaments.findIndex(function (x) { return x.id === tournamentId; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { sports: sports });
      console.log('[tournament] captain updated for', sportId, teamId, '→', wroteWhat);
      toast(person ? ('Captain assigned: ' + wroteWhat) : 'Captain removed', 'success');
      render();
    } catch (err) {
      console.error('[tournament] setTeamCaptain FAILED', err);
      toast('Failed to update captain: ' + (err.message || err.code), 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ROSTER VIEWER / EDITOR
  // ═══════════════════════════════════════════════════════════════════════════

  function openRoster(tournamentId, sportId, teamId) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const team = sport ? (sport.teams || []).find(function (x) { return x.id === teamId; }) : null;
    if (t && team && !canViewRoster(t, team)) {
      toast(whyCantView(t, team), 'error');
      return;
    }
    openLiveModal = 'roster';
    openLiveModalContext = { tournamentId, sportId, teamId };
    rerenderRoster();
  }

  function rerenderRoster() {
    if (openLiveModal !== 'roster') return;
    const ctx = openLiveModalContext || {};
    const t = state.tournaments.find(function (x) { return x.id === ctx.tournamentId; });
    const sport = t ? getSportConfig(t, ctx.sportId) : null;
    const teams = sport ? (sport.teams || []) : [];
    const team = teams.find(function (x) { return x.id === ctx.teamId; });
    if (!t || !sport || !team) { closeLiveModal('tRoster'); return; }

    // If the user lost view permission after opening (e.g. an admin unlocked
    // and reveal is off), close the modal defensively.
    if (!canViewRoster(t, team)) {
      closeLiveModal('tRoster');
      toast(whyCantView(t, team), 'error');
      return;
    }

    const canEdit    = canEditRoster(team);
    const canLock    = canLockRoster();
    const locked     = isRosterLocked(team);
    const roster = Array.isArray(team.roster) ? team.roster.slice() : [];
    roster.sort(function (a, b) {
      return ((a.firstName || '') + (a.lastName || '')).localeCompare((b.firstName || '') + (b.lastName || ''));
    });

    const title = (sport.emoji || '🏅') + ' ' + (sport.label || sport.id) + ' — ' + (team.name || team.id) + ' roster';
    const { modal, body } = getOrCreateModal('tRoster', title, { wide: true });

    const captainAssigned = team.captainUid || team.captainName || team.captainEmail;
    const captainLine = captainAssigned
      ? '👤 Captain: <b>' + escapeHtml(team.captainName || team.captainEmail || '') + '</b>'
        + (team.captainFamilyId ? ' <small style="color:var(--t-muted);">· FID ' + escapeHtml(team.captainFamilyId) + '</small>' : '')
        + (team.captainUid ? '' : ' <span class="t-badge nologin">no login yet</span>')
      : '<span style="color:var(--t-muted);">No captain assigned yet.</span>';

    // Lock state banner + admin lock/unlock control.
    const lockBanner = locked
      ? `<div class="t-lock-banner locked">
           <div>
             <b>🔒 Roster locked.</b>
             ${team.lockedBy ? '<span style="color:var(--t-muted);font-size:.82rem;"> — by ' + escapeHtml(team.lockedBy) + '</span>' : ''}
             <div style="font-size:.78rem;color:var(--t-muted);margin-top:2px;">No further edits allowed. ${t.revealLockedRosters ? 'Visible to everyone signed in.' : 'Still visible only to team members, the captain, and admins.'}</div>
           </div>
           ${canLock ? '<button class="t-btn sm" data-toggle-lock>🔓 Unlock</button>' : ''}
         </div>`
      : (canLock
          ? `<div class="t-lock-banner unlocked">
               <div>
                 <b>🔓 Open.</b>
                 <div style="font-size:.78rem;color:var(--t-muted);margin-top:2px;">Captain and admins can add or remove members. Lock when the roster is final.</div>
               </div>
               <button class="t-btn sm primary" data-toggle-lock>🔒 Lock roster</button>
             </div>`
          : '');

    body.innerHTML = `
      <div class="t-roster-head">
        <div>${captainLine}</div>
        <div class="t-roster-count">${roster.length} member${roster.length === 1 ? '' : 's'}</div>
      </div>
      ${lockBanner}
      ${canEdit ? `
        <div class="t-roster-actions">
          <button class="t-btn primary" data-add-member>➕ Add member from directory</button>
          ${!state.membersLoaded ? '<span style="color:var(--t-muted);font-size:.85rem;">Loading parishioner directory…</span>' : ''}
        </div>
      ` : (locked
        ? '<div style="color:var(--t-muted);font-size:.85rem;margin:8px 0 12px;">This roster is locked. Only an admin can unlock it.</div>'
        : '<div style="color:var(--t-muted);font-size:.85rem;margin:8px 0 12px;">You can view this roster but only the team captain (or an admin) can edit it.</div>'
      )}
      <div class="t-roster-list">
        ${roster.length === 0
          ? '<div class="t-empty-note">No members added yet.</div>'
          : roster.map(function (r, i) {
              const nm = ((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.name || '(unnamed)';
              return `
                <div class="t-roster-row">
                  <div class="who">
                    <div class="name">${escapeHtml(nm)}</div>
                    <div class="meta">Family: ${escapeHtml(r.familyName || '—')} · FID ${escapeHtml(r.familyId || '—')}${r.memberId ? ' · MID ' + escapeHtml(r.memberId) : ''}</div>
                    ${r.addedByName ? '<div class="sub">Added by ' + escapeHtml(r.addedByName) + '</div>' : ''}
                  </div>
                  ${canEdit ? '<button class="t-btn danger sm" data-remove="' + i + '">Remove</button>' : ''}
                </div>
              `;
            }).join('')}
      </div>
    `;

    const addBtn = body.querySelector('[data-add-member]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openMemberPicker(ctx.tournamentId, ctx.sportId, ctx.teamId);
      });
    }
    body.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const i = parseInt(btn.getAttribute('data-remove'), 10);
        if (!confirm('Remove this member from the roster?')) return;
        await removeRosterMember(ctx.tournamentId, ctx.sportId, ctx.teamId, i);
      });
    });
    const lockBtn = body.querySelector('[data-toggle-lock]');
    if (lockBtn) {
      lockBtn.addEventListener('click', async function () {
        const nextLocked = !locked;
        if (nextLocked && !confirm('Lock this roster? Captain and members will no longer be able to add or remove people. Only an admin can unlock.')) return;
        await setRosterLock(ctx.tournamentId, ctx.sportId, ctx.teamId, nextLocked);
      });
    }

    modal.classList.add('open');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMBER PICKER (captain/admin) — search parishioner directory
  // ═══════════════════════════════════════════════════════════════════════════

  // Explains — for a specific team — why the current user is not allowed to
  // edit the roster right now. Used by every edit entry point so admins and
  // captains see the actual reason instead of a generic "denied" toast.
  function whyCantEdit(team) {
    if (state.isAdmin) return null; // admin always can
    if (isRosterLocked(team)) {
      return 'This roster is locked. Only an admin can unlock it.';
    }
    if (!isCaptainOf(team)) {
      const cap = team && (team.captainName || team.captainEmail);
      return cap
        ? 'Only Captain ' + cap + ' or an admin can edit this team\'s roster.'
        : 'Only the team captain or an admin can edit this roster.';
    }
    return null;
  }

  function openMemberPicker(tournamentId, sportId, teamId) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const team = sport ? (sport.teams || []).find(function (x) { return x.id === teamId; }) : null;
    if (!team || !canEditRoster(team)) {
      toast(whyCantEdit(team) || 'You can\'t edit this roster.', 'error');
      return;
    }
    openLiveModal = 'memberPicker';
    openLiveModalContext = { tournamentId, sportId, teamId, query: '' };
    rerenderMemberPicker();
  }

  function rerenderMemberPicker() {
    if (openLiveModal !== 'memberPicker') return;
    const ctx = openLiveModalContext || {};
    const t = state.tournaments.find(function (x) { return x.id === ctx.tournamentId; });
    const sport = t ? getSportConfig(t, ctx.sportId) : null;
    const team = sport ? (sport.teams || []).find(function (x) { return x.id === ctx.teamId; }) : null;
    if (!team) { closeLiveModal('tMemberPicker'); return; }

    const { modal, body } = getOrCreateModal(
      'tMemberPicker',
      'Add member — ' + (sport.label || sport.id) + ' · ' + (team.name || team.id),
      { wide: true }
    );

    const existingKeys = new Set((team.roster || []).map(function (r) {
      return r.memberId ? ('M:' + r.memberId) : ('N:' + (r.firstName + '|' + r.lastName + '|' + r.familyId).toLowerCase());
    }));

    body.innerHTML = `
      <div>
        <label class="t-form-label" for="tMemberSearch">Search parishioner directory (name or Family ID)</label>
        <input id="tMemberSearch" type="text" class="t-input" placeholder="e.g. Joseph, or 16" value="${escapeHtml(ctx.query || '')}" autocomplete="off" />
        <div style="font-size:.78rem;color:var(--t-muted);margin-top:6px;">
          ${state.membersLoaded ? state.members.length + ' members in the directory' : 'Loading directory…'}
          · A person can only be on one team in this sport.
        </div>
      </div>
      <div class="t-member-results" id="tMemberResults"></div>
    `;

    const input = body.querySelector('#tMemberSearch');
    const results = body.querySelector('#tMemberResults');

    function paintResults() {
      if (!state.membersLoaded) {
        results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">Loading parishioner directory…</div>';
        return;
      }
      const list = searchMembers(input.value);
      if (!list.length) {
        results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">No matches. Try a different name or a Family ID.</div>';
        return;
      }
      results.innerHTML = list.map(function (m, idx) {
        const key = m.memberId ? ('M:' + m.memberId) : ('N:' + (m.firstName + '|' + m.lastName + '|' + m.familyId).toLowerCase());
        const already = existingKeys.has(key) || (team.roster || []).some(function (r) { return membersMatch(m, r); });
        const otherTeam = already ? null : findOtherTeamForMember(teamsFor(t, sport), team.id, m);
        let actionHtml;
        if (already) {
          actionHtml = '<span class="t-badge">Already on roster</span>';
        } else if (otherTeam) {
          actionHtml = '<span class="t-badge" title="A person can only be on one team per sport">Already on ' + escapeHtml(otherTeam.name || otherTeam.id) + '</span>';
        } else {
          actionHtml = '<button class="t-btn sm primary" data-add="' + idx + '">Add</button>';
        }
        return `
          <div class="t-member-row">
            <div>
              <div class="name">${escapeHtml((m.firstName + ' ' + m.lastName).trim())}</div>
              <div class="meta">Family: ${escapeHtml(m.familyName || '—')} · FID ${escapeHtml(m.familyId || '—')}${m.memberId ? ' · MID ' + escapeHtml(m.memberId) : ''}</div>
            </div>
            ${actionHtml}
          </div>
        `;
      }).join('');
      results.querySelectorAll('[data-add]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const idx = parseInt(btn.getAttribute('data-add'), 10);
          const m = list[idx];
          if (!m) return;
          await addRosterMember(ctx.tournamentId, ctx.sportId, ctx.teamId, m);
          // Refresh the picker so this member now shows "Already on roster"
          rerenderMemberPicker();
        });
      });
    }

    input.addEventListener('input', function () {
      ctx.query = input.value;
      paintResults();
    });
    paintResults();
    modal.classList.add('open');
    setTimeout(function () { input.focus(); }, 30);
  }

  async function addRosterMember(tournamentId, sportId, teamId, member) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const sport = getSportConfig(t, sportId);
    if (!sport) return;
    const team = (sport.teams || []).find(function (x) { return x.id === teamId; });
    if (!team) return;
    if (!canEditRoster(team)) {
      toast(whyCantEdit(team) || 'You can\'t edit this roster.', 'error');
      return;
    }
    const roster = Array.isArray(team.roster) ? team.roster.slice() : [];
    if (roster.some(function (r) { return membersMatch(member, r); })) {
      toast((member.firstName + ' ' + member.lastName).trim() + ' is already on this roster.', 'error');
      return;
    }
    const otherTeam = findOtherTeamForMember(teamsFor(t, sport), teamId, member);
    if (otherTeam) {
      toast((member.firstName + ' ' + member.lastName).trim()
        + ' is already on ' + (otherTeam.name || otherTeam.id)
        + ' for this sport. A person can only be on one team per sport.', 'error');
      return;
    }
    const known = getKnownPeople().find(function (p) { return membersMatch(p, member); });
    const newEntry = {
      memberId: member.memberId || '',
      familyId: member.familyId || '',
      firstName: member.firstName || '',
      lastName: member.lastName || '',
      familyName: member.familyName || '',
      uid: (known && known.uid) || '',
      email: (known && known.email) || '',
      addedByUid: currentUid() || '',
      addedByName: (state.user && (state.user.displayName || state.user.email)) || '',
      // Use an ISO string rather than serverTimestamp — Firestore does not
      // allow FieldValue sentinels inside nested arrays.
      addedAt: new Date().toISOString()
    };
    roster.push(newEntry);
    await writeTeamPatch(t, sportId, teamId, { roster: roster });
    toast('Added ' + (member.firstName + ' ' + member.lastName).trim(), 'success');
  }

  async function removeRosterMember(tournamentId, sportId, teamId, index) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const sport = getSportConfig(t, sportId);
    if (!sport) return;
    const team = (sport.teams || []).find(function (x) { return x.id === teamId; });
    if (!team) return;
    if (!canEditRoster(team)) {
      toast(whyCantEdit(team) || 'You can\'t edit this roster.', 'error');
      return;
    }
    const roster = (team.roster || []).slice();
    roster.splice(index, 1);
    await writeTeamPatch(t, sportId, teamId, { roster: roster });
    toast('Member removed', 'success');
  }

  // Because Firestore requires overwriting the whole `sports` array to modify
  // a nested field, this helper rebuilds the array with a shallow patch to
  // the target team.
  async function writeTeamPatch(tournament, sportId, teamId, patch) {
    const sports = (tournament.sports || []).map(function (s) {
      if (s.id !== sportId) return s;
      const teams = (s.teams || []).map(function (tm) {
        if (tm.id !== teamId) return tm;
        return Object.assign({}, tm, patch);
      });
      return Object.assign({}, s, { teams: teams });
    });
    try {
      await db.collection('tournaments').doc(tournament.id).update({
        sports: sports,
        updatedAt: FieldValue.serverTimestamp()
      });
      // Mirror the write into local state so the UI updates without waiting
      // for the snapshot round-trip.
      const idx = state.tournaments.findIndex(function (x) { return x.id === tournament.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { sports: sports });
      render();
    } catch (err) {
      console.error('[tournament] writeTeamPatch FAILED', err);
      toast('Save failed: ' + (err.message || err.code || 'unknown'), 'error');
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCORER MODAL
  // ═══════════════════════════════════════════════════════════════════════════

  function getScorerModal() {
    let modal = document.getElementById('tScorerModal');
    if (modal) return modal;
    modal = el('div', { class: 't-modal', id: 'tScorerModal' });
    modal.innerHTML = `
      <div class="t-modal-content wide">
        <div class="t-modal-head">
          <h3 id="tScorerTitle">Score entry</h3>
          <button class="t-modal-close" onclick="document.getElementById('tScorerModal').classList.remove('open');">×</button>
        </div>
        <div class="t-modal-body" id="tScorerBody"></div>
        <div class="t-modal-foot">
          <button class="t-btn" onclick="document.getElementById('tScorerModal').classList.remove('open');">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function openScorer(match, tournament) {
    const sport = getSportConfig(tournament, match.sport);
    const modal = getScorerModal();
    const p = participantsOf(match, tournament);
    modal.querySelector('#tScorerTitle').textContent =
      (sport.emoji || '🏅') + ' ' + displayName(tournament, match.sport, p.a) + ' vs ' + displayName(tournament, match.sport, p.b) + ' — ' + STAGE_LABEL[match.stage];
    const body = modal.querySelector('#tScorerBody');
    body.innerHTML = '';
    if (sport.kind === 'racket') body.appendChild(buildRacketScorer(match, tournament, sport));
    else if (sport.kind === 'volleyball') body.appendChild(buildVolleyballScorer(match, tournament, sport));
    else if (sport.kind === 'basketball') body.appendChild(buildBasketballScorer(match, tournament, sport));
    modal.classList.add('open');
  }

  function buildRacketScorer(match, tournament, sport) {
    const cfg = getStageScoring(tournament, match.sport, match.stage) || {};
    const aName = displayName(tournament, match.sport, participantsOf(match, tournament).a);
    const bName = displayName(tournament, match.sport, participantsOf(match, tournament).b);
    const aColor = teamMeta(tournament, match.sport, participantsOf(match, tournament).a).color;
    const bColor = teamMeta(tournament, match.sport, participantsOf(match, tournament).b).color;
    const cats = (sport.categories && sport.categories.length) ? sport.categories : DEFAULT_CATEGORIES;
    const games = (match.games && match.games.length) ? match.games.map(function (g) { return Object.assign({}, g, { sets: (g.sets || []).map(function (s) { return Object.assign({}, s); }) }); })
                : cats.map(function (c) { return { category: c, playersA: '', playersB: '', sets: [{ a: 0, b: 0 }], status: 'pending', winner: null }; });

    const wrap = el('div');
    const banner = el('div', { style: { marginBottom: '10px', color: 'var(--t-muted)', fontSize: '.88rem' } },
      `Best of ${cfg.bestOf || 1} sets, target ${cfg.target || 21} (cap ${cfg.cap || 25}). Use +/- or type values directly. Save is per game.`);
    wrap.appendChild(banner);

    games.forEach(function (game) {
      const gameWrap = el('div', { class: 't-card', style: { marginBottom: '12px' } });
      gameWrap.innerHTML = `
        <div class="t-card-header">
          <h3>${escapeHtml(game.category)} <small style="font-weight:500;color:var(--t-muted);">${escapeHtml(CATEGORY_LABEL[game.category] || '')}</small></h3>
          <span class="t-badge status-${game.status || 'pending'}">${STATUS_LABEL[game.status] || 'Pending'}</span>
        </div>
        <div class="t-card-body">
          <div class="t-form-grid" style="margin-bottom:12px;">
            <div class="t-form-field">
              <label>${escapeHtml(aName)} players</label>
              <input type="text" class="t-input" data-players="A" value="${escapeHtml(game.playersA || '')}" />
            </div>
            <div class="t-form-field">
              <label>${escapeHtml(bName)} players</label>
              <input type="text" class="t-input" data-players="B" value="${escapeHtml(game.playersB || '')}" />
            </div>
          </div>
          <div data-sets></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
            <button class="t-btn sm" data-act="add-set">+ Add set</button>
            <button class="t-btn sm danger" data-act="remove-set">− Remove last set</button>
            <div style="flex:1;"></div>
            <button class="t-btn primary sm" data-act="save-game">💾 Save game</button>
          </div>
        </div>
      `;

      function repaint() {
        const container = gameWrap.querySelector('[data-sets]');
        container.innerHTML = '';
        game.sets.forEach(function (set, si) {
          const w = racketSetWinner(set, cfg);
          const row = el('div', { class: 't-scorer', style: { marginBottom: '8px' } });
          row.innerHTML = `
            <div class="side">
              <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
              <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${set.a || 0}" data-side="A" data-set="${si}" />
              <div class="btns">
                <button class="t-btn sm" data-inc="A" data-set="${si}" data-delta="-1">−</button>
                <button class="t-btn sm primary" data-inc="A" data-set="${si}" data-delta="1">+1</button>
              </div>
            </div>
            <div class="sep">Set ${si + 1}${w ? ' · ' + w : ''}</div>
            <div class="side">
              <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
              <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${set.b || 0}" data-side="B" data-set="${si}" />
              <div class="btns">
                <button class="t-btn sm" data-inc="B" data-set="${si}" data-delta="-1">−</button>
                <button class="t-btn sm primary" data-inc="B" data-set="${si}" data-delta="1">+1</button>
              </div>
            </div>
          `;
          row.querySelectorAll('[data-inc]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              const side = btn.getAttribute('data-inc');
              const idx = +btn.getAttribute('data-set');
              const delta = +btn.getAttribute('data-delta');
              const key = side === 'A' ? 'a' : 'b';
              game.sets[idx][key] = Math.max(0, (game.sets[idx][key] || 0) + delta);
              repaint();
            });
          });
          row.querySelectorAll('input[data-side]').forEach(function (inp) {
            inp.addEventListener('change', function () {
              const side = inp.getAttribute('data-side');
              const idx = +inp.getAttribute('data-set');
              const key = side === 'A' ? 'a' : 'b';
              game.sets[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
            });
          });
          container.appendChild(row);
        });
      }
      repaint();

      gameWrap.querySelector('[data-act="add-set"]').addEventListener('click', function () {
        if (game.sets.length >= (cfg.bestOf || 1)) return toast('Best of ' + (cfg.bestOf || 1) + ' — cannot add more sets', 'error');
        game.sets.push({ a: 0, b: 0 });
        repaint();
      });
      gameWrap.querySelector('[data-act="remove-set"]').addEventListener('click', function () {
        if (game.sets.length <= 1) return;
        game.sets.pop();
        repaint();
      });
      gameWrap.querySelector('[data-act="save-game"]').addEventListener('click', async function () {
        game.playersA = gameWrap.querySelector('[data-players="A"]').value.trim();
        game.playersB = gameWrap.querySelector('[data-players="B"]').value.trim();
        game.winner = racketGameWinner(game, cfg);
        game.status = game.winner ? 'completed' : (game.sets.some(function (s) { return s.a || s.b; }) ? 'in_progress' : 'pending');
        try {
          const fresh = games.map(function (g) { return { category: g.category, playersA: g.playersA || '', playersB: g.playersB || '', sets: g.sets, status: g.status, winner: g.winner || null }; });
          const overall = racketMatchWinner({ games: fresh, sport: match.sport }, tournament);
          const patch = { games: fresh, updatedAt: FieldValue.serverTimestamp() };
          if (overall) { patch.winner = overall; patch.status = 'completed'; }
          await db.collection('tournament_matches').doc(match.id).update(patch);
          toast('Saved ' + game.category + (overall ? ' — match won by ' + (overall === 'A' ? aName : bName) : ''));
        } catch (err) { console.error(err); toast('Save failed', 'error'); }
      });

      wrap.appendChild(gameWrap);
    });
    return wrap;
  }

  function buildVolleyballScorer(match, tournament, sport) {
    const cfg = getStageScoring(tournament, match.sport, match.stage) || {};
    const p = participantsOf(match, tournament);
    const aName = displayName(tournament, match.sport, p.a);
    const bName = displayName(tournament, match.sport, p.b);
    const aColor = teamMeta(tournament, match.sport, p.a).color;
    const bColor = teamMeta(tournament, match.sport, p.b).color;
    const bestOf = cfg.bestOf || 3;
    const sets = (match.sets && match.sets.length) ? match.sets.map(function (s) { return Object.assign({}, s); }) : [{ a: 0, b: 0 }];

    const wrap = el('div');
    wrap.appendChild(el('div', { style: { marginBottom: '10px', color: 'var(--t-muted)', fontSize: '.88rem' } },
      `Best of ${bestOf} sets. Normal set to ${cfg.target || 21} (cap ${cfg.cap || 25}), deciding set to ${cfg.decidingTarget || 15} (cap ${cfg.decidingCap || 20}).`));
    const setsBox = el('div'); wrap.appendChild(setsBox);
    const controls = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } });
    controls.innerHTML = `
      <button class="t-btn sm" data-act="add-set">+ Add set</button>
      <button class="t-btn sm danger" data-act="remove-set">− Remove last set</button>
      <div style="flex:1;"></div>
      <button class="t-btn primary sm" data-act="save">💾 Save</button>
    `;
    wrap.appendChild(controls);

    function paint() {
      setsBox.innerHTML = '';
      sets.forEach(function (s, i) {
        const isDeciding = i === bestOf - 1;
        const w = volleyballSetWinner(s, cfg, isDeciding);
        const row = el('div', { class: 't-scorer', style: { marginBottom: '8px' } });
        row.innerHTML = `
          <div class="side">
            <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
            <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${s.a || 0}" data-side="A" data-set="${i}" />
            <div class="btns">
              <button class="t-btn sm" data-inc="A" data-set="${i}" data-delta="-1">−</button>
              <button class="t-btn sm primary" data-inc="A" data-set="${i}" data-delta="1">+1</button>
            </div>
          </div>
          <div class="sep">Set ${i + 1}${w ? ' · ' + w : ''}${isDeciding ? ' (deciding)' : ''}</div>
          <div class="side">
            <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
            <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${s.b || 0}" data-side="B" data-set="${i}" />
            <div class="btns">
              <button class="t-btn sm" data-inc="B" data-set="${i}" data-delta="-1">−</button>
              <button class="t-btn sm primary" data-inc="B" data-set="${i}" data-delta="1">+1</button>
            </div>
          </div>
        `;
        row.querySelectorAll('[data-inc]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const side = btn.getAttribute('data-inc');
            const idx = +btn.getAttribute('data-set');
            const delta = +btn.getAttribute('data-delta');
            const key = side === 'A' ? 'a' : 'b';
            sets[idx][key] = Math.max(0, (sets[idx][key] || 0) + delta);
            paint();
          });
        });
        row.querySelectorAll('input[data-side]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            const side = inp.getAttribute('data-side');
            const idx = +inp.getAttribute('data-set');
            const key = side === 'A' ? 'a' : 'b';
            sets[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
          });
        });
        setsBox.appendChild(row);
      });
    }
    paint();

    controls.querySelector('[data-act="add-set"]').addEventListener('click', function () {
      if (sets.length >= bestOf) return toast('Best of ' + bestOf + ' — max ' + bestOf + ' sets', 'error');
      sets.push({ a: 0, b: 0 }); paint();
    });
    controls.querySelector('[data-act="remove-set"]').addEventListener('click', function () {
      if (sets.length <= 1) return;
      sets.pop(); paint();
    });
    controls.querySelector('[data-act="save"]').addEventListener('click', async function () {
      try {
        const winner = volleyballMatchWinner({ sets: sets }, cfg);
        const patch = { sets: sets, updatedAt: FieldValue.serverTimestamp() };
        if (winner) { patch.winner = winner; patch.status = 'completed'; }
        await db.collection('tournament_matches').doc(match.id).update(patch);
        toast(winner ? 'Saved — match won by ' + (winner === 'A' ? aName : bName) : 'Saved');
      } catch (err) { console.error(err); toast('Save failed', 'error'); }
    });
    return wrap;
  }

  function buildBasketballScorer(match, tournament, sport) {
    const cfg = getStageScoring(tournament, match.sport, match.stage) || {};
    const p = participantsOf(match, tournament);
    const aName = displayName(tournament, match.sport, p.a);
    const bName = displayName(tournament, match.sport, p.b);
    const aColor = teamMeta(tournament, match.sport, p.a).color;
    const bColor = teamMeta(tournament, match.sport, p.b).color;
    const totalQuarters = cfg.quarters || 4;
    const quarters = (match.quarters && match.quarters.length) ? match.quarters.map(function (q) { return Object.assign({}, q); }) : [{ a: 0, b: 0 }];

    const wrap = el('div');
    wrap.appendChild(el('div', { style: { marginBottom: '10px', color: 'var(--t-muted)', fontSize: '.88rem' } },
      totalQuarters + ' quarters × ' + (cfg.quarterMinutes || 7) + ' min. Use +1 / +2 / +3 buttons or type values directly.'));
    const totalsBox = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '18px', margin: '12px 0 18px', fontFamily: 'Barlow Condensed, sans-serif' } });
    wrap.appendChild(totalsBox);
    const quartersBox = el('div'); wrap.appendChild(quartersBox);
    const controls = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } });
    controls.innerHTML = `
      <button class="t-btn sm" data-act="add-q">+ Add quarter</button>
      <button class="t-btn sm danger" data-act="remove-q">− Remove last quarter</button>
      <div style="flex:1;"></div>
      <button class="t-btn primary sm" data-act="save">💾 Save</button>
    `;
    wrap.appendChild(controls);

    function paint() {
      const totals = quarters.reduce(function (acc, q) { return { a: acc.a + (q.a || 0), b: acc.b + (q.b || 0) }; }, { a: 0, b: 0 });
      totalsBox.innerHTML = `
        <div style="text-align:center;">
          <div style="color:var(--t-muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(aName)}</div>
          <div style="font-size:2.2rem;font-weight:800;color:${aColor};">${totals.a}</div>
        </div>
        <div style="color:var(--t-muted);font-size:1.4rem;">–</div>
        <div style="text-align:center;">
          <div style="color:var(--t-muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(bName)}</div>
          <div style="font-size:2.2rem;font-weight:800;color:${bColor};">${totals.b}</div>
        </div>
      `;
      quartersBox.innerHTML = '';
      quarters.forEach(function (q, i) {
        const row = el('div', { class: 't-card', style: { marginBottom: '8px' } });
        row.innerHTML = `
          <div class="t-card-header"><h3>Q${i + 1}</h3></div>
          <div class="t-card-body">
            <div class="t-scorer">
              <div class="side">
                <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
                <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${q.a || 0}" data-side="A" data-q="${i}" />
                <div class="btns">
                  <button class="t-btn sm" data-inc="A" data-q="${i}" data-delta="-1">−</button>
                  <button class="t-btn sm primary" data-inc="A" data-q="${i}" data-delta="1">+1</button>
                  <button class="t-btn sm primary" data-inc="A" data-q="${i}" data-delta="2">+2</button>
                  <button class="t-btn sm primary" data-inc="A" data-q="${i}" data-delta="3">+3</button>
                </div>
              </div>
              <div class="sep">Q${i + 1}</div>
              <div class="side">
                <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
                <input type="number" min="0" class="t-input" style="width:80px;text-align:center;font-size:1.3rem;font-weight:700;" value="${q.b || 0}" data-side="B" data-q="${i}" />
                <div class="btns">
                  <button class="t-btn sm" data-inc="B" data-q="${i}" data-delta="-1">−</button>
                  <button class="t-btn sm primary" data-inc="B" data-q="${i}" data-delta="1">+1</button>
                  <button class="t-btn sm primary" data-inc="B" data-q="${i}" data-delta="2">+2</button>
                  <button class="t-btn sm primary" data-inc="B" data-q="${i}" data-delta="3">+3</button>
                </div>
              </div>
            </div>
          </div>
        `;
        row.querySelectorAll('[data-inc]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const side = btn.getAttribute('data-inc');
            const idx = +btn.getAttribute('data-q');
            const delta = +btn.getAttribute('data-delta');
            const key = side === 'A' ? 'a' : 'b';
            quarters[idx][key] = Math.max(0, (quarters[idx][key] || 0) + delta);
            paint();
          });
        });
        row.querySelectorAll('input[data-side]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            const side = inp.getAttribute('data-side');
            const idx = +inp.getAttribute('data-q');
            const key = side === 'A' ? 'a' : 'b';
            quarters[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
          });
        });
        quartersBox.appendChild(row);
      });
    }
    paint();

    controls.querySelector('[data-act="add-q"]').addEventListener('click', function () {
      if (quarters.length >= totalQuarters) return toast('Only ' + totalQuarters + ' quarters allowed', 'error');
      quarters.push({ a: 0, b: 0 }); paint();
    });
    controls.querySelector('[data-act="remove-q"]').addEventListener('click', function () {
      if (quarters.length <= 1) return;
      quarters.pop(); paint();
    });
    controls.querySelector('[data-act="save"]').addEventListener('click', async function () {
      try {
        const winner = basketballWinner({ quarters: quarters }, cfg);
        const patch = { quarters: quarters, updatedAt: FieldValue.serverTimestamp() };
        if (winner) { patch.winner = winner; patch.status = 'completed'; }
        await db.collection('tournament_matches').doc(match.id).update(patch);
        toast(winner ? 'Saved — match won by ' + (winner === 'A' ? aName : bName) : 'Saved');
      } catch (err) { console.error(err); toast('Save failed', 'error'); }
    });
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIRESTORE SUBSCRIPTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  function subscribeTournaments() {
    if (state.unsubTournaments) state.unsubTournaments();
    state.unsubTournaments = db.collection('tournaments').onSnapshot(function (snap) {
      state.tournaments = [];
      snap.forEach(function (doc) { state.tournaments.push(Object.assign({ id: doc.id }, doc.data())); });
      state.ready.tournaments = true;
      render();
      // Refresh any live modals whose contents depend on the tournament doc.
      if (openLiveModal === 'roster') rerenderRoster();
      if (openLiveModal === 'memberPicker') rerenderMemberPicker();
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    }, function (err) {
      console.error('tournaments error:', err);
      state.ready.tournaments = true;
      toast('Unable to load tournaments — check Firestore rules', 'error');
      render();
    });
  }

  function subscribeRsvpResponses() {
    if (state.unsubRsvp) return;
    state.unsubRsvp = db.collection('rsvpResponses').onSnapshot(function (snap) {
      state.rsvpResponses = [];
      snap.forEach(function (doc) {
        const d = doc.data() || {};
        state.rsvpResponses.push({
          uid: d.uid || '',
          email: d.email || '',
          firstName: d.firstName || '',
          lastName: d.lastName || '',
          familyId: d.familyId != null ? String(d.familyId) : ''
        });
      });
      state.ready.rsvp = true;
      state.errors.rsvp = null;
      console.log('[tournament] rsvpResponses:', state.rsvpResponses.length, 'docs');
      render();
      if (openLiveModal === 'roster') rerenderRoster();
      if (openLiveModal === 'memberPicker') rerenderMemberPicker();
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    }, function (err) {
      state.errors.rsvp = err;
      state.ready.rsvp = true;
      console.error('[tournament] rsvpResponses read FAILED — check Firestore rules for /rsvpResponses:', err);
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    });
  }

  function unsubscribeUserData() {
    if (state.unsubUsers) { state.unsubUsers(); state.unsubUsers = null; }
    if (state.unsubRsvp)  { state.unsubRsvp();  state.unsubRsvp  = null; }
    state.users = [];
    state.rsvpResponses = [];
    state.ready.users = false;
    state.ready.rsvp  = false;
  }

  function subscribeUsers() {
    if (state.unsubUsers) return;
    state.unsubUsers = db.collection('users').onSnapshot(function (snap) {
      state.users = [];
      snap.forEach(function (doc) {
        const d = doc.data() || {};
        state.users.push({
          uid: doc.id,
          email: d.email || '',
          displayName: d.displayName || '',
          firstName: d.firstName || '',
          lastName: d.lastName || '',
          firstNameLower: (d.firstNameLower || d.firstName || '').toLowerCase(),
          lastNameLower: (d.lastNameLower || d.lastName || '').toLowerCase(),
          familyId: d.familyId != null ? String(d.familyId) : '',
          memberId: d.memberId != null ? String(d.memberId) : '',
          photoURL: d.photoURL || ''
        });
      });
      state.users.sort(function (a, b) {
        return (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName);
      });
      state.ready.users = true;
      state.errors.users = null;
      console.log('[tournament] users collection:', state.users.length, 'profiles');
      render();
      if (openLiveModal === 'roster') rerenderRoster();
      if (openLiveModal === 'memberPicker') rerenderMemberPicker();
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    }, function (err) {
      state.errors.users = err;
      state.ready.users = true;
      console.error('[tournament] users read FAILED — Firestore rules likely block reading /users:', err);
      if (openLiveModal === 'userPicker') rerenderUserPicker();
    });
  }

  function subscribeMatchesFor(tournamentId) {
    if (state.currentId === tournamentId && state.unsubMatches) return;
    if (state.unsubMatches) state.unsubMatches();
    state.currentId = tournamentId;
    state.matches = [];
    state.ready.matches = false;
    if (!tournamentId) { render(); return; }
    state.unsubMatches = db.collection('tournament_matches')
      .where('tournamentId', '==', tournamentId)
      .onSnapshot(function (snap) {
        state.matches = [];
        snap.forEach(function (doc) { state.matches.push(Object.assign({ id: doc.id }, doc.data())); });
        state.ready.matches = true;
        render();
      }, function (err) {
        console.error('matches error:', err);
        state.ready.matches = true;
        toast('Unable to load matches for this tournament', 'error');
        render();
      });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  function render() {
    const parsed = parseUrl();
    renderTopbar();

    // Sign-in first, then admin-only until an admin opens Tournament to everyone.
    if (!state.user) {
      renderAccessGate();
      return;
    }
    if (tournamentAccessPending()) {
      renderCheckingAccess();
      return;
    }
    if (!canUseTournamentPage()) {
      if (state.unsubMatches) { state.unsubMatches(); state.unsubMatches = null; state.currentId = null; }
      renderTestingGate();
      return;
    }

    ensureTournamentData();

    // Non-admin, non-captain users hitting an admin-only URL get bounced to
    // the tournament view (or the list if no tournament is selected).
    if (parsed.view === 'create' && !state.isAdmin) {
      navigate({ view: 'list' }, { replace: true });
      return;
    }
    if (parsed.view === 'manage' && !state.isAdmin) {
      navigate({ view: 'tournament', tournamentId: parsed.tournamentId }, { replace: true });
      return;
    }

    // Manage the tournament-scoped match subscription
    if (parsed.view === 'tournament' || parsed.view === 'manage') {
      if (parsed.tournamentId !== state.currentId) {
        subscribeMatchesFor(parsed.tournamentId);
        return;
      }
    } else {
      if (state.currentId) { subscribeMatchesFor(null); }
    }

    if (parsed.view === 'list') return renderList();
    if (parsed.view === 'create') return renderCreateOrManage('create');
    if (parsed.view === 'manage') return renderCreateOrManage('manage');
    if (parsed.view === 'tournament') return renderTournament();
  }

  function renderCheckingAccess() {
    document.title = 'Church Tournament';
    document.getElementById('tContent').innerHTML = `
      <section class="t-section">
        <div class="t-empty">Checking access…</div>
      </section>
    `;
  }

  function renderTestingGate() {
    document.title = 'Church Tournament — Coming soon';
    const container = document.getElementById('tContent');
    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>🏆 Church Tournament</h1>
          <p>Admins are still setting this up. It will show up in the menu for everyone when it is ready.</p>
        </div>
        <div class="t-emoji">🔒</div>
      </section>
      <section class="t-section">
        <div class="t-auth-gate">
          <h3>Not open yet</h3>
          <p>This page is in admin testing. Signed-in members will get access once an admin taps <strong>Open to everyone</strong>.</p>
          ${state.user ? '<p class="denied">Signed in as ' + escapeHtml(state.user.email || '') + '</p>' : ''}
        </div>
      </section>
    `;
  }

  function renderAccessGate() {
    document.title = 'Church Tournament — Sign in';
    const container = document.getElementById('tContent');
    const authInitialized = state.user !== null || sessionInitialized;
    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>🏆 Church Tournament</h1>
          <p>Sign in with your Google account to see live scores, standings, and your team roster. Team captains can add members; each person can only be on one team per sport.</p>
        </div>
        <div class="t-emoji">🔒</div>
      </section>
      <section class="t-section">
        <div class="t-auth-gate">
          <h3>Sign in required</h3>
          <p>Signing in registers you as a portal user so admins can assign you as a team captain.</p>
          <button class="t-btn primary lg" onclick="window.__tournament.signIn()">🔐 Sign in with Google</button>
          ${!authInitialized ? '<p style="color:var(--t-muted);margin-top:12px;font-size:.85rem;">Checking your existing sign-in…</p>' : ''}
        </div>
      </section>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════════════

  function ensureTournamentData() {
    if (!canUseTournamentPage()) return;
    if (!state.unsubTournaments) subscribeTournaments();
    if (state.user) {
      subscribeUsers();
      subscribeRsvpResponses();
    }
    if (!state._membersLoadStarted) {
      state._membersLoadStarted = true;
      loadMembersCsv();
    }
  }

  function init() {
    render();
    auth.onAuthStateChanged(function (user) {
      state.user = user;
      sessionInitialized = true;
      if (user) {
        // Persist this sign-in into users/{uid} (fire-and-forget). This is
        // how the users collection grows to contain everyone who has ever
        // signed into any part of the site.
        upsertUserProfile(user);
        // People-list subscriptions start from ensureTournamentData() once
        // this user is allowed to use the page (admin, or open to everyone).
        if (!window.SmashAuth) {
          const FALLBACK_ADMIN_EMAILS = [
            'jue.george@gmail.com',
            'binoybt@gmail.com',
            'geojins@gmail.com',
            'b.ajaymathews@gmail.com'
          ];
          state.isAdmin = FALLBACK_ADMIN_EMAILS.indexOf(String(user.email || '').toLowerCase()) !== -1;
          state.authLoading = false;
        }
      } else {
        // Sign-out — drop the people-list subscriptions. The Firestore docs
        // remain untouched; only the local cached view is cleared.
        unsubscribeUserData();
        if (!window.SmashAuth) {
          state.isAdmin = false;
          state.authLoading = false;
        }
      }
      render();
    });

    // Admin flag comes from users/{uid}.role via SmashAuth (managed on
    // admin-users.html). Re-render whenever the role resolves or changes.
    if (window.SmashAuth) {
      SmashAuth.onChange(function (s) {
        const nextAdmin = !!(s.user && s.isAdmin);
        const nextLoading = !!s.loading;
        const changed = state.isAdmin !== nextAdmin || state.authLoading !== nextLoading;
        state.isAdmin = nextAdmin;
        state.authLoading = nextLoading;
        if (changed) render();
      });
    }
    if (window.TournamentAccess) {
      TournamentAccess.onChange(function () { render(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
