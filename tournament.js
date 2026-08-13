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
 *     archived      bool
 *     createdAt / updatedAt / createdBy
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

  const ADMIN_EMAILS = [
    'jue.george@gmail.com',
    'binoybt@gmail.com',
    'geojins@gmail.com',
    'b.ajaymathews@gmail.com'
  ];

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

  function sportTemplateForConfig(templateId) {
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

  // Koinonia seed used when the tournament list is empty and admin clicks "Seed".
  function koinoniaSeed() {
    return {
      name: 'Koinonia 2026',
      format: 'teams',
      teams: JSON.parse(JSON.stringify(DEFAULT_TEAMS)),
      sports: [
        sportTemplateForConfig('badminton'),
        sportTemplateForConfig('pickleball'),
        sportTemplateForConfig('tabletennis'),
        sportTemplateForConfig('volleyball'),
        sportTemplateForConfig('basketball')
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

  function isAdminEmail(email) {
    return !!email && ADMIN_EMAILS.indexOf(email.toLowerCase()) !== -1;
  }

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
    tournaments: [],       // all tournaments (subscribed once)
    matches: [],           // matches for the current tournament only
    currentId: null,       // tournamentId currently subscribed for matches
    unsubTournaments: null,
    unsubMatches: null,
    ready: { tournaments: false, matches: false }
  };

  // Flipped to true once auth.onAuthStateChanged has fired at least once,
  // so we can distinguish "still restoring session" from "definitely signed out".
  let sessionInitialized = false;

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

  function displayName(tournament, id) {
    if (!tournament || tournament.format !== 'teams') return id || '—';
    const t = (tournament.teams || []).find(function (x) { return x.id === id; });
    return t ? t.name : (id || '—');
  }

  function teamMeta(tournament, id) {
    if (!tournament) return { name: id || '—', wards: '', color: 'var(--t-muted)' };
    if (tournament.format !== 'teams') {
      return { name: id || '—', wards: '', color: TEAM_COLORS[Math.abs(hashCode(id || '')) % TEAM_COLORS.length] };
    }
    const idx = (tournament.teams || []).findIndex(function (x) { return x.id === id; });
    const t = (tournament.teams || [])[idx];
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
      (tournament.teams || []).forEach(function (t) { seen[t.id] = true; });
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

      const card = el('div', { class: 't-tournament-card ' + (t.archived ? 'archived' : '') });
      card.innerHTML = `
        <div class="t-format">${escapeHtml(formatLabel)}${t.archived ? ' · Archived' : ''}</div>
        <div class="t-name">${escapeHtml(t.name)}</div>
        <div class="t-sports">${sports || '<span class="t-sport-chip">No sports yet</span>'}${extra}</div>
        <div class="t-stats">
          <span><b>${(t.sports || []).length}</b> sports</span>
          ${t.format === 'teams' ? `<span><b>${(t.teams || []).length}</b> teams</span>` : ''}
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
      draft.teams = draft.teams || [];
    } else {
      draft = { name: '', format: 'teams', teams: JSON.parse(JSON.stringify(DEFAULT_TEAMS)), sports: [], archived: false };
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
            <div id="tfArchivedWrap" style="margin-top:12px;">
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;">
                <input type="checkbox" id="tfArchived" ${draft.archived ? 'checked' : ''}/> Archive this tournament (hides from active list)
              </label>
            </div>
          </div>
        </div>
      </section>

      <section class="t-section" id="tfTeamsSection">
        <div class="t-section-header">
          <h2 class="t-section-title">Teams <small>edit group names & rosters</small></h2>
          <button class="t-btn" id="tfAddTeam">➕ Add team</button>
        </div>
        <div class="t-teams-editor" id="tfTeams"></div>
      </section>

      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">Sports <small>date & scoring per stage</small></h2>
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
      const wrap = document.getElementById('tfTeamsSection');
      wrap.style.display = draft.format === 'teams' ? '' : 'none';
    });
    document.getElementById('tfTeamsSection').style.display = draft.format === 'teams' ? '' : 'none';

    document.getElementById('tfAddTeam').addEventListener('click', function () {
      const nextId = 'G' + ((draft.teams || []).length + 1);
      draft.teams.push({ id: nextId, name: nextId, wards: '' });
      paintTeams(draft);
    });
    paintTeams(draft);

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

  function paintTeams(draft) {
    const wrap = document.getElementById('tfTeams');
    if (!wrap) return;
    wrap.innerHTML = '';
    (draft.teams || []).forEach(function (t, i) {
      const row = el('div', { class: 't-team-row' });
      row.innerHTML = `
        <input type="text" placeholder="Id" value="${escapeHtml(t.id)}" data-team-key="id" />
        <input type="text" placeholder="Wards / description" value="${escapeHtml(t.wards || '')}" data-team-key="wards" />
        <button class="t-btn danger sm" data-team-remove="1">Remove</button>
      `;
      const inputs = row.querySelectorAll('input');
      inputs[0].addEventListener('input', function () { t.id = this.value.trim() || t.id; t.name = t.id; });
      inputs[1].addEventListener('input', function () { t.wards = this.value; });
      row.querySelector('[data-team-remove]').addEventListener('click', function () {
        draft.teams.splice(i, 1);
        paintTeams(draft);
      });
      wrap.appendChild(row);
    });
  }

  function addSport(draft, templateId) {
    if ((draft.sports || []).find(function (s) { return s.id === templateId; })) {
      toast(templateId + ' is already in this tournament', 'error');
      return;
    }
    draft.sports = draft.sports || [];
    draft.sports.push(sportTemplateForConfig(templateId));
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
    draft.sports.push({
      id: id, label: name, kind: kind, emoji: '🏅', color: '#64748b',
      date: '',
      categories: kind === 'racket' ? [...DEFAULT_CATEGORIES] : [],
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
      const card = el('div', { class: 't-config-sport' });
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
    if (!draft.name) return toast('Tournament name is required', 'error');
    if (draft.format === 'teams' && (!draft.teams || draft.teams.length < 2)) return toast('Add at least 2 teams', 'error');
    if (!draft.sports || !draft.sports.length) return toast('Add at least 1 sport', 'error');

    const payload = {
      name: draft.name,
      format: draft.format,
      teams: draft.format === 'teams' ? draft.teams : [],
      sports: draft.sports,
      archived: !!draft.archived,
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
        payload.createdAt = FieldValue.serverTimestamp();
        payload.createdBy = (state.user && state.user.email) || '';
        const ref = await db.collection('tournaments').add(payload);
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
      toast('Koinonia 2026 created');
      navigate({ view: 'tournament', tournamentId: ref.id });
    } catch (err) {
      console.error(err);
      toast('Seed failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }
  window.__tournament.seedKoinonia = seedKoinonia;

  // ═══════════════════════════════════════════════════════════════════════════
  // TOURNAMENT VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTournament() {
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
      const count = state.matches.filter(function (m) { return m.sport === s.id; }).length;
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
              <div class="t-card-header"><h3>Create a new match</h3></div>
              <div class="t-card-body" id="tCreateFormWrap"></div>
            </div>
          </section>
        ` : ''}
      ` : ''}
    `;

    if (sport) {
      renderStandingsFor(t, sport.id);
      renderMatchListsFor(t, sport.id);
      renderPlayoffsFor(t, sport.id);
      if (state.isAdmin) renderCreateMatchForm(t, sport);
    }
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
            const meta = teamMeta(tournament, r.id);
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

  function renderMatchListsFor(tournament, sportId) {
    const scoped = state.matches.filter(function (m) { return m.sport === sportId; });
    const live = scoped.filter(function (m) { return m.status === 'in_progress'; }).sort(sortMatches);
    const upcoming = scoped.filter(function (m) { return m.status === 'scheduled'; }).sort(sortMatches);
    const completed = scoped.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse();
    fillMatchList('tLiveList', 'tLiveSection', live, tournament);
    fillMatchList('tUpcomingList', 'tUpcomingSection', upcoming, tournament);
    fillMatchList('tCompletedList', 'tCompletedSection', completed, tournament, { compact: true });
  }

  function renderPlayoffsFor(tournament, sportId) {
    const scoped = state.matches.filter(function (m) { return m.sport === sportId && m.stage !== 'league'; });
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
    const aMeta = teamMeta(tournament, p.a);
    const bMeta = teamMeta(tournament, p.b);
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
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, p.a))}</div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, p.b))}</div>
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
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, p.a))}</div>
          <div class="p-header" style="text-align:center;">${escapeHtml(displayName(tournament, p.b))}</div>
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
        const label = displayName(tournament, p.a) + ' vs ' + displayName(tournament, p.b);
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
  // MATCH CREATION FORM
  // ═══════════════════════════════════════════════════════════════════════════

  function renderCreateMatchForm(tournament, sport) {
    const wrap = document.getElementById('tCreateFormWrap');
    if (!wrap) return;
    const defaultDate = sport.date ? sport.date + 'T18:00' : '';
    let participantFields = '';
    if (tournament.format === 'teams') {
      const opts = (tournament.teams || []).map(function (t) { return `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.wards ? ' — ' + escapeHtml(t.wards) : ''}</option>`; }).join('');
      participantFields = `
        <div class="t-form-field">
          <label>Team A</label>
          <select class="t-select" id="tmA">${opts}</select>
        </div>
        <div class="t-form-field">
          <label>Team B</label>
          <select class="t-select" id="tmB">${opts}</select>
        </div>
      `;
    } else {
      participantFields = `
        <div class="t-form-field">
          <label>Player / Pair A</label>
          <input type="text" class="t-input" id="tmA" placeholder="e.g. Binoy & Jue" />
        </div>
        <div class="t-form-field">
          <label>Player / Pair B</label>
          <input type="text" class="t-input" id="tmB" placeholder="e.g. Ajay & Geo" />
        </div>
      `;
    }
    const stagesForSport = enabledStagesFor(sport);
    wrap.innerHTML = `
      <form id="tCreateMatchForm" class="t-form-grid">
        <div class="t-form-field">
          <label>Stage</label>
          <select class="t-select" id="tmStage">
            ${stagesForSport.map(function (s) { return `<option value="${s}">${STAGE_LABEL[s]}</option>`; }).join('')}
          </select>
        </div>
        ${participantFields}
        <div class="t-form-field">
          <label>Scheduled ${sport.date ? '<small style="text-transform:none;letter-spacing:0;color:var(--t-muted);font-weight:500;">default: ' + fmtDate(sport.date) + '</small>' : ''}</label>
          <input type="datetime-local" class="t-input" id="tmWhen" value="${defaultDate}" />
        </div>
        <div class="t-form-field">
          <label>Venue</label>
          <input type="text" class="t-input" id="tmVenue" placeholder="Optional" />
        </div>
        <div class="t-form-field" style="justify-content:flex-end;">
          <label>&nbsp;</label>
          <button type="submit" class="t-btn primary">➕ Create match</button>
        </div>
      </form>
    `;
    if (tournament.format === 'teams' && (tournament.teams || []).length >= 2) {
      document.getElementById('tmB').value = tournament.teams[1].id;
    }
    document.getElementById('tCreateMatchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const stage = document.getElementById('tmStage').value;
      const a = document.getElementById('tmA').value.trim();
      const b = document.getElementById('tmB').value.trim();
      const when = document.getElementById('tmWhen').value;
      const venue = document.getElementById('tmVenue').value.trim();
      if (!a || !b) return toast('Both participants required', 'error');
      if (a === b) return toast('Pick two different participants', 'error');
      createMatch(tournament, sport, { stage: stage, a: a, b: b, when: when, venue: venue });
    });
  }

  async function createMatch(tournament, sport, input) {
    const stageCfg = getStageScoring(tournament, sport.id, input.stage);
    const data = {
      tournamentId: tournament.id,
      sport: sport.id,
      stage: input.stage,
      scheduledAt: input.when ? new Date(input.when).toISOString() : '',
      venue: input.venue || '',
      status: 'scheduled',
      winner: null,
      scoringConfig: stageCfg,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: (state.user && state.user.email) || ''
    };
    if (tournament.format === 'teams') {
      data.teamA = input.a;
      data.teamB = input.b;
    } else {
      data.playerA = input.a;
      data.playerB = input.b;
    }
    if (sport.kind === 'racket') data.games = [];
    else if (sport.kind === 'volleyball') data.sets = [];
    else if (sport.kind === 'basketball') data.quarters = [];
    try {
      await db.collection('tournament_matches').add(data);
      toast('Match created');
      const form = document.getElementById('tCreateMatchForm');
      if (form) {
        document.getElementById('tmVenue').value = '';
      }
    } catch (err) {
      console.error(err);
      toast('Create failed: ' + (err.message || err.code || 'unknown'), 'error');
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
      (sport.emoji || '🏅') + ' ' + displayName(tournament, p.a) + ' vs ' + displayName(tournament, p.b) + ' — ' + STAGE_LABEL[match.stage];
    const body = modal.querySelector('#tScorerBody');
    body.innerHTML = '';
    if (sport.kind === 'racket') body.appendChild(buildRacketScorer(match, tournament, sport));
    else if (sport.kind === 'volleyball') body.appendChild(buildVolleyballScorer(match, tournament, sport));
    else if (sport.kind === 'basketball') body.appendChild(buildBasketballScorer(match, tournament, sport));
    modal.classList.add('open');
  }

  function buildRacketScorer(match, tournament, sport) {
    const cfg = getStageScoring(tournament, match.sport, match.stage) || {};
    const aName = displayName(tournament, participantsOf(match, tournament).a);
    const bName = displayName(tournament, participantsOf(match, tournament).b);
    const aColor = teamMeta(tournament, participantsOf(match, tournament).a).color;
    const bColor = teamMeta(tournament, participantsOf(match, tournament).b).color;
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
    const aName = displayName(tournament, p.a);
    const bName = displayName(tournament, p.b);
    const aColor = teamMeta(tournament, p.a).color;
    const bColor = teamMeta(tournament, p.b).color;
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
    const aName = displayName(tournament, p.a);
    const bName = displayName(tournament, p.b);
    const aColor = teamMeta(tournament, p.a).color;
    const bColor = teamMeta(tournament, p.b).color;
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
    }, function (err) {
      console.error('tournaments error:', err);
      state.ready.tournaments = true;
      toast('Unable to load tournaments — check Firestore rules', 'error');
      render();
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

    // Gate the entire tournament section behind admin sign-in for now.
    // Everyone else sees a sign-in prompt (or an access-denied message if
    // they signed in with a non-admin account).
    if (!state.isAdmin) {
      renderAccessGate();
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

  function renderAccessGate() {
    document.title = 'Church Tournament — Admin only';
    const container = document.getElementById('tContent');
    // While auth is still initializing (page just loaded, no user yet, but
    // Firebase may still restore a persisted session) show a short loading
    // state instead of the "access denied" copy.
    const authInitialized = state.user !== null || sessionInitialized;
    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#1e293b;--hero-b:#334155;">
        <div>
          <h1>🔒 Tournament — Admin only</h1>
          <p>The tournament section is currently restricted to match admins while we set it up. Public viewing will be enabled soon.</p>
        </div>
        <div class="t-emoji">🔒</div>
      </section>
      <section class="t-section">
        <div class="t-auth-gate">
          ${!state.user
            ? `
              <h3>Sign in required</h3>
              <p>Sign in with an admin Google account to continue.</p>
              <button class="t-btn primary lg" onclick="window.__tournament.signIn()">🔐 Sign in with Google</button>
              ${!authInitialized ? '<p style="color:var(--t-muted);margin-top:12px;font-size:.85rem;">Checking your existing sign-in…</p>' : ''}
            `
            : `
              <h3>Access denied</h3>
              <p>You're signed in as <b>${escapeHtml(state.user.email || '')}</b>, but that account isn't on the tournament admin list.</p>
              <p style="color:var(--t-muted);font-size:.9rem;margin-top:8px;">Ask an existing admin to add your email, or sign out and sign in with a different account.</p>
              <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
                <button class="t-btn" onclick="window.__tournament.signOut()">Sign out</button>
                <a href="index.html" class="t-btn">← Back to SMASH</a>
              </div>
            `}
        </div>
      </section>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    render();
    subscribeTournaments();
    auth.onAuthStateChanged(function (user) {
      state.user = user;
      state.isAdmin = user ? isAdminEmail(user.email) : false;
      sessionInitialized = true;
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
