/* Church Tournament — single-page app powering /tournament.html
 *
 * URL routing (all views live on tournament.html):
 *   /tournament.html                          → list of all tournaments
 *   /tournament.html?create=1                 → create a new tournament (admin)
 *   /tournament.html?t=<id>                   → tournament view (sport tabs)
 *   /tournament.html?t=<id>&sport=<sportId>   → tournament view scoped to a sport
 *   /tournament.html?t=<id>&sport=<id>&cat=<id>&bracket=<id>&team=<id>&st=<stageId>
 *                                         → category, bracket, stage, or team detail
 *   /tournament.html?t=<id>&manage=1          → edit tournament config (admin)
 *   /watch.html?s=<token>                     → spectator board, one-shot read (share this)
 *   /watch.html?s=<token>&live=1              → spectator board with live listeners (venue screens)
 *                                             one unique token per tournament; disabled
 *                                             links do not read public score data
 *   /watch.html?s=<token>&cat=<id>&panel=teams → category Teams tab (name, players, team tags)
 *
 * Firestore layout:
 *   tournaments/{docId}
 *     name          string   — admin-entered
 *     sportMode     'single' | 'multi'
 *                   single → one sport, no tournament-wide rules
 *                   multi  → several sports, tournament rules apply to all
 *                   missing → multi when more than one sport is saved, else single
 *     format        'teams' | 'individual'
 *     started       bool — once true, members see standings, the current match,
 *                   and upcoming matches for category-based sports
 *     teams[]       { id, name, wards }             — legacy tournament-level roster
 *     sports[]      see SPORT_TEMPLATES below       — configurable per tournament
 *       categoryMode  '' | 'open' | 'split'
 *                     ''     parish group teams (captains and roster)
 *                     'open' one Open category, registration is open to everyone
 *                     'split' registration categories, each with its own teams
 *       divisions[]   registration categories (not racket games-per-match)
 *         id, name, open, maxPlayers
 *         skippedStages[]  stage ids this category leaves out. Order still
 *                     comes from the sport's stageList. At least one stage stays.
 *                     disabledStages[] is still read for older category docs
 *                     and treated as the same skip list.
 *         advanced    { [stageId]: teamId[] } teams sent into that stage from
 *                     the previous stage this category still uses, ordered by
 *                     that previous stage's overall ranking across groups.
 *                     The first stage includes every registered team. Later
 *                     stages only list advanced teams, Seed 1 is the best
 *                     previous rank, and brackets are filled from that list.
 *         ranking     { [stageId]: teamId[] } admin override of overall ranking
 *                     across groups for that stage. Empty/missing uses points.
 *         winnerId    admin-set champion for the category (optional)
 *         runnerId    admin-set runner-up for the category (optional)
 *         completedStages[]  stage ids the admin marked complete. Every match
 *                     in that stage must already be completed. The next stage
 *                     cannot start (advance, brackets, schedule, start match)
 *                     until the previous stage is marked complete.
 *         teams[]     { id, name, players[], tags[], here, hereAt, hereBy }
 *                     tags are optional short labels (seed, home side, group)
 *                     here is a registration check-in flag (team has arrived)
 *         brackets[]  { id, name, stageId, teamIds[], teamTags, schedule, complete, walkoverPoints }
 *           stageId   which stage this bracket belongs to (missing = league)
 *           teamTags  { [teamId]: string } admin-only short scheduling tags
 *                     assigned when a team is pulled into the bracket. Not shown
 *                     on spectator, points tables, or member views.
 *           walkoverPoints / walkoverScore
 *                     Walkover Score for that bracket (match score, e.g. 15 → 15–0).
 *                     The team that shows up still receives the sport's Win table points.
 *           a team is in at most one bracket per stage
 *           schedule  { draft, published } — fixtures for this bracket only
 *           complete  admin marked the bracket finished. Generate round-robin
 *                     skips it until the bracket is reopened
 *       tablePoints   { win, draw, walkover, noResult }
 *                     missing on older sports → win 1, draw 0, walkover 1, no result 0
 *                     new sports default to win 2, draw 1, walkover 2, no result 0
 *                     a walkover win uses the Win value; walkover is kept for older docs
 *                     no result never awards those points to either side
 *       stageList[]   { id, name } — league, semifinal, final, optional 3rd place,
 *                     plus any stages the admin inserts (Round of 16, …)
 *                     this is the stage order for every category in the sport
 *                     standings are one table per stage, and one per bracket
 *                     a category can skip a stage; Advance on the overall
 *                     ranking across groups sends a team to the next stage
 *                     it still uses, seeded from that ranking
 *                     when that category's last stage other than 3rd place is
 *                     finished, or an admin sets a winner, Matches shows the
 *                     champion and runner-up. Until then that tile stays hidden.
 *       schedule    { draft, published }            — legacy per-sport fixture list
 *                     draft.entries[]     working copy (admin only)
 *                     published.entries[] public copy (visible after Publish)
 *       rules       { text, updatedAt, updatedBy }  — sport-specific, admin-edit
 *       maxRosterSize number  — per-team member cap including the captain
 *                               (0/omitted = no limit). Parish group teams only.
 *     rules         { text, updatedAt, updatedBy }  — multi-sport tournaments only
 *     archived      bool
 *     published     bool  — members see it only when true; missing = unpublished
 *                           (existing docs without the field stay unpublished)
 *     scorers[]     { uid, name, email } — scorer-role members assigned by admin
 *     scorerUids[]  string — mirrored UIDs used by Firestore authorization
 *     spectatorToken one unique public-board key; reused when the link is re-enabled.
 *                     Share URL is watch.html?s=token (one-shot read). Live display
 *                     URL is watch.html?s=token&live=1 (onSnapshot auto-refresh).
 *     publicBoard   bool — spectator link is on only while this is true
 *     clonedFrom    string — source tournament id when created via Clone
 *     createdAt / updatedAt / createdBy
 *
 *   Clone copies sports, scoring, table points, stage names, rules, max roster,
 *   and team shells (id / name / wards / tags), plus category teams, category
 *   stage overrides, and bracket membership. It does not copy matches, schedule,
 *   rosters, captains, lock state, or Here check-in. Clones are always unpublished.
 *
 * Site-wide visibility (firebase-config.js TournamentAccess):
 *   siteConfig/tournament { openToEveryone: bool }
 *     missing/false → admin / lab-user testing only;
 *     true → all signed-in members
 *
 *   tournament_matches/{docId}
 *     tournamentId  string
 *     sport         string  (matches sports[].id)
 *     categoryId    string  — registration category, when the sport uses divisions
 *     bracketId     string  — bracket the fixture was scheduled in
 *     stage         league | semifinal | final | third_place | a custom stage id
 *     resultType    'played' | 'draw' | 'walkover' | 'no_result'
 *     teamA / teamB     — for teams format
 *     playerA / playerB — for individual format
 *     scheduledAt   ISO string
 *     court         string — optional. Blank when there is one court, or none.
 *     venue         string — kept equal to court so older boards still show it
 *     showUpcoming  bool — admin marks which scheduled matches appear in Upcoming
 *     status        'scheduled' | 'in_progress' | 'completed'
 *     winner        'A' | 'B' | 'tie' | null
 *     scorerUid / scorerName / scorerEmail — admin-assigned match scorer
 *     captainAUid / captainAEmail / captainBUid / captainBEmail
 *                     captain of each side, copied from the team
 *     ackAName / ackAAt / ackBName / ackBAt
 *                     acknowledgement after the match. Name is the selected
 *                     player, not the signed-in scorer. Older docs may still
 *                     have ackAUid / ackBUid; those are no longer written.
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
  const ALL_SCHEDULES = 'all';

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

  function defaultTablePoints() {
    return { win: 2, draw: 1, walkover: 2, noResult: 0 };
  }

  // Sports saved before table points existed awarded 1 point for a win.
  function legacyTablePoints() {
    return { win: 1, draw: 0, walkover: 1, noResult: 0 };
  }

  function clampTablePoint(value, fallback) {
    const n = parseInt(String(value == null ? '' : value).trim(), 10);
    if (!isFinite(n) || n < 0) return fallback;
    return Math.min(n, 99);
  }

  function tablePointsFor(sport) {
    const hasOwn = !!(sport && sport.tablePoints);
    const src = hasOwn ? sport.tablePoints : legacyTablePoints();
    const fallback = hasOwn ? defaultTablePoints() : legacyTablePoints();
    return {
      win: clampTablePoint(src.win, fallback.win),
      draw: clampTablePoint(src.draw, fallback.draw),
      walkover: clampTablePoint(src.walkover, fallback.walkover),
      noResult: clampTablePoint(src.noResult, fallback.noResult)
    };
  }

  function tablePointsForScope(sport, scope) {
    return tablePointsFor(sport);
  }

  function defaultWalkoverScore(sport, stageId) {
    const kind = sport && sport.kind;
    if (kind === 'basketball') return 20;
    const scoring = (sport && sport.scoring && (sport.scoring[stageId] || sport.scoring.league))
      || (kind ? defaultScoring(kind)[stageId || 'league'] : null)
      || defaultScoring('racket').league;
    return clampTablePoint(scoring && scoring.target, 21);
  }

  function looksLikeLegacyWalkoverPoints(value, sport) {
    const n = clampTablePoint(value, -1);
    if (n < 0) return true;
    const table = tablePointsFor(sport).walkover;
    return n <= 3 && (n === table || n === 0 || n === 1 || n === 2);
  }

  function walkoverScoreForBracket(sport, bracket, stageId) {
    const fallback = defaultWalkoverScore(sport, stageId || (bracket && bracket.stageId) || 'league');
    if (!bracket) return fallback;
    if (bracket.walkoverScore != null && bracket.walkoverScore !== '') {
      return clampTablePoint(bracket.walkoverScore, fallback);
    }
    if (bracket.walkoverPoints == null || bracket.walkoverPoints === '') return fallback;
    if (looksLikeLegacyWalkoverPoints(bracket.walkoverPoints, sport)) return fallback;
    return clampTablePoint(bracket.walkoverPoints, fallback);
  }

  function walkoverScoreForMatch(tournament, match) {
    const sport = getSportConfig(tournament, match && match.sport);
    const fallback = defaultWalkoverScore(sport, match && match.stage);
    if (!sport || !match) return fallback;
    const bracket = findBracket(findDivision(sport, match.categoryId), match.bracketId);
    return walkoverScoreForBracket(sport, bracket, match.stage);
  }

  function walkoverScorePair(winnerSide, score) {
    const n = clampTablePoint(score, 0);
    if (winnerSide === 'B') return { a: 0, b: n };
    return { a: n, b: 0 };
  }

  function walkoverScorePatch(match, tournament, winnerSide) {
    const sport = getSportConfig(tournament, match && match.sport);
    const pair = walkoverScorePair(winnerSide, walkoverScoreForMatch(tournament, match));
    const patch = {
      status: 'completed',
      winner: winnerSide,
      resultType: 'walkover',
      updatedAt: FieldValue.serverTimestamp()
    };
    if (!sport) return patch;
    if (sport.kind === 'racket') {
      const games = racketGamesForMatch(match, tournament, sport);
      patch.games = (games.length ? games : [{ category: '' }]).map(function (game) {
        return {
          category: game.category || '',
          playersA: game.playersA || '',
          playersB: game.playersB || '',
          sets: [pair],
          status: 'completed',
          winner: winnerSide
        };
      });
    } else if (sport.kind === 'volleyball') {
      patch.sets = [pair];
    } else if (sport.kind === 'basketball') {
      patch.quarters = [pair];
    }
    return patch;
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
      scoring: defaultScoring(tpl.kind),
      tablePoints: defaultTablePoints(),
      maxRosterSize: 0
    };
  }

  const BUILTIN_STAGE_IDS = { league: 1, semifinal: 1, final: 1, third_place: 1 };

  // Which stages are enabled for a given sport within a tournament.
  // League / Semifinal / Final are always available; 3rd Place is opt-in.
  function enabledStagesFor(sportConfig) {
    const stages = ['league', 'semifinal', 'final'];
    if (sportConfig && sportConfig.hasThirdPlace !== false) stages.push('third_place');
    return stages;
  }

  function defaultStageList(sport) {
    return enabledStagesFor(sport).map(function (id) {
      return { id: id, name: STAGE_LABEL[id] || id };
    });
  }

  function stageLabelOf(sport, stageId) {
    const list = (sport && sport.stageList) || [];
    const found = list.find(function (s) { return s.id === stageId; });
    if (found && found.name) return found.name;
    return STAGE_LABEL[stageId] || stageId || 'Stage';
  }

  function stageListFor(sport) {
    const raw = (sport && Array.isArray(sport.stageList) && sport.stageList.length)
      ? sport.stageList
      : defaultStageList(sport);
    const out = [];
    raw.forEach(function (st) {
      if (!st || !st.id) return;
      if (st.id === 'third_place' && sport && sport.hasThirdPlace === false) return;
      if (out.some(function (x) { return x.id === st.id; })) return;
      out.push({ id: st.id, name: st.name || STAGE_LABEL[st.id] || st.id });
    });
    if (!out.some(function (s) { return s.id === 'league'; })) out.unshift({ id: 'league', name: 'League' });
    if (!out.some(function (s) { return s.id === 'semifinal'; })) out.push({ id: 'semifinal', name: 'Semifinal' });
    if (!out.some(function (s) { return s.id === 'final'; })) out.push({ id: 'final', name: 'Final' });
    if (sport && sport.hasThirdPlace !== false && !out.some(function (s) { return s.id === 'third_place'; })) {
      out.push({ id: 'third_place', name: '3rd Place' });
    }
    return out;
  }

  function disabledStagesOf(division) {
    const raw = (division && Array.isArray(division.disabledStages)) ? division.disabledStages : [];
    const out = [];
    raw.forEach(function (id) {
      const stageId = String(id || '').trim();
      if (!stageId || out.indexOf(stageId) !== -1) return;
      out.push(stageId);
    });
    return out;
  }

  function copyDisabledStages(division) {
    return disabledStagesOf(division).slice();
  }

  function stageListForDivision(sport, division) {
    return categoryStages(sport, division);
  }

  function activeStageId(sport, division) {
    const stages = stageListForDivision(sport, division);
    if (!stages.length) return 'league';
    for (let i = 0; i < stages.length; i++) {
      if (!stageIsMarkedComplete(division, stages[i].id)) return stages[i].id;
    }
    return stages[stages.length - 1].id;
  }

  function resolveDivisionStageId(sport, division, requested) {
    const stages = stageListForDivision(sport, division);
    if (requested && stages.some(function (st) { return st.id === requested; })) return requested;
    return activeStageId(sport, division);
  }

  function matchStageApplies(sport, match) {
    if (!sport || !match) return true;
    if (!usesRegistrationCategories(sport) || !match.categoryId) return true;
    const division = findDivision(sport, match.categoryId);
    if (!division) return true;
    const stageId = match.stage || 'league';
    return stageListForDivision(sport, division).some(function (st) { return st.id === stageId; });
  }

  function ensureStageList(sport) {
    if (!sport) return;
    sport.stageList = stageListFor(sport);
    if (!sport.scoring) sport.scoring = defaultScoring(sport.kind);
    sport.stageList.forEach(function (st) {
      if (!sport.scoring[st.id]) {
        const base = sport.scoring.league || defaultScoring(sport.kind).league || {};
        sport.scoring[st.id] = Object.assign({}, base);
      }
    });
    if (!sport.tablePoints) sport.tablePoints = legacyTablePoints();
    else sport.tablePoints = tablePointsFor(sport);
  }

  function bracketStageId(bracket) {
    return (bracket && bracket.stageId) || 'league';
  }

  function bracketsInStage(division, stageId) {
    const id = stageId || 'league';
    return ((division && division.brackets) || []).filter(function (b) {
      return bracketStageId(b) === id;
    });
  }

  function bracketTeamIds(bracket) {
    return ((bracket && bracket.teamIds) || []).filter(Boolean);
  }

  function normalizeScheduleTag(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 12);
  }

  function bracketTeamTags(bracket) {
    const src = (bracket && bracket.teamTags && typeof bracket.teamTags === 'object') ? bracket.teamTags : {};
    const allowed = {};
    bracketTeamIds(bracket).forEach(function (id) { allowed[id] = true; });
    const out = {};
    Object.keys(src).forEach(function (id) {
      if (!allowed[id]) return;
      const tag = normalizeScheduleTag(src[id]);
      if (tag) out[id] = tag;
    });
    return out;
  }

  function scheduleTagOf(bracket, teamId) {
    if (!bracket || !teamId || !isAdminUi()) return '';
    return bracketTeamTags(bracket)[teamId] || '';
  }

  function writeBracketTeamTags(bracket, tags) {
    if (!bracket) return;
    const cleaned = {};
    const allowed = {};
    bracketTeamIds(bracket).forEach(function (id) { allowed[id] = true; });
    Object.keys(tags || {}).forEach(function (id) {
      if (!allowed[id]) return;
      const tag = normalizeScheduleTag(tags[id]);
      if (tag) cleaned[id] = tag;
    });
    if (Object.keys(cleaned).length) bracket.teamTags = cleaned;
    else delete bracket.teamTags;
  }

  function scheduleTagChipHtml(tag) {
    const value = normalizeScheduleTag(tag);
    if (!value || !isAdminUi()) return '';
    return ' <span class="t-sched-tag">' + escapeHtml(value) + '</span>';
  }

  function isAllSchedulesView(bracketId) {
    return String(bracketId || '') === ALL_SCHEDULES;
  }

  function bracketHasTeams(bracket) {
    return bracketTeamIds(bracket).length > 0;
  }

  function bracketIsComplete(bracket) {
    return !!(bracket && bracket.complete);
  }

  function openBracketsInStage(division, stageId) {
    return bracketsInStage(division, stageId).filter(function (b) {
      return !bracketIsComplete(b);
    });
  }

  function skippedStageIds(division) {
    const raw = []
      .concat((division && division.skippedStages) || [])
      .concat((division && division.disabledStages) || []);
    const out = [];
    raw.forEach(function (id) {
      id = String(id || '').trim();
      if (!id || out.indexOf(id) !== -1) return;
      out.push(id);
    });
    return out;
  }

  function stageIsSkipped(division, stageId) {
    return skippedStageIds(division).indexOf(stageId) !== -1;
  }

  function categoryStages(sport, division) {
    const all = stageListFor(sport);
    const skip = skippedStageIds(division);
    const out = all.filter(function (st) { return skip.indexOf(st.id) === -1; });
    if (out.length) return out;
    return all.length ? [all[0]] : [{ id: 'league', name: 'League' }];
  }

  function advancedRecord(division) {
    const src = (division && division.advanced && typeof division.advanced === 'object') ? division.advanced : {};
    const out = {};
    Object.keys(src).forEach(function (stageId) {
      if (!stageId) return;
      const ids = [];
      const list = Array.isArray(src[stageId]) ? src[stageId] : [];
      list.forEach(function (id) {
        id = String(id || '').trim();
        if (!id || ids.indexOf(id) !== -1) return;
        ids.push(id);
      });
      if (ids.length) out[stageId] = ids;
    });
    return out;
  }

  function advancedTeamIds(division, stageId) {
    const ids = advancedRecord(division)[stageId] || [];
    const known = {};
    ((division && division.teams) || []).forEach(function (tm) { if (tm && tm.id) known[tm.id] = true; });
    return ids.filter(function (id) { return known[id]; });
  }

  function rankingRecord(division) {
    const src = (division && division.ranking && typeof division.ranking === 'object' && !Array.isArray(division.ranking))
      ? division.ranking
      : {};
    const out = {};
    Object.keys(src).forEach(function (stageId) {
      if (!stageId) return;
      const ids = [];
      const list = Array.isArray(src[stageId]) ? src[stageId] : [];
      list.forEach(function (id) {
        id = String(id || '').trim();
        if (!id || ids.indexOf(id) !== -1) return;
        ids.push(id);
      });
      if (ids.length) out[stageId] = ids;
    });
    return out;
  }

  function rankingIdsForStage(division, stageId) {
    const ids = rankingRecord(division)[stageId] || [];
    const known = {};
    ((division && division.teams) || []).forEach(function (tm) { if (tm && tm.id) known[tm.id] = true; });
    return ids.filter(function (id) { return known[id]; });
  }

  function applyRankingOverride(rows, division, stageId) {
    const list = (rows || []).slice();
    const order = rankingIdsForStage(division, stageId);
    if (!order.length || !list.length) {
      return list.map(function (row, i) {
        return Object.assign({}, row, { rank: i + 1 });
      });
    }
    const byId = {};
    list.forEach(function (row) {
      if (row && row.id) byId[row.id] = row;
    });
    const used = {};
    const out = [];
    order.forEach(function (id) {
      if (byId[id] && !used[id]) {
        out.push(byId[id]);
        used[id] = true;
      }
    });
    list.forEach(function (row) {
      if (row && row.id && !used[row.id]) {
        out.push(row);
        used[row.id] = true;
      }
    });
    return out.map(function (row, i) {
      return Object.assign({}, row, { rank: i + 1 });
    });
  }

  function placesOverride(division) {
    const winnerId = String((division && division.winnerId) || '').trim();
    const runnerId = String((division && division.runnerId) || '').trim();
    const ids = [];
    if (winnerId) ids.push(winnerId);
    if (runnerId && runnerId !== winnerId) ids.push(runnerId);
    return ids;
  }

  function completedStageIds(division) {
    const raw = (division && division.completedStages) || [];
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (id) {
      id = String(id || '').trim();
      if (!id || out.indexOf(id) !== -1) return;
      out.push(id);
    });
    return out;
  }

  function stageIsMarkedComplete(division, stageId) {
    return completedStageIds(division).indexOf(stageId) !== -1;
  }

  function stageMatchList(tournament, sport, division, stageId) {
    const sportId = sport && sport.id;
    const categoryId = division && division.id;
    const stage = stageId || 'league';
    return (state.matches || []).filter(function (match) {
      if (!match || match.sport !== sportId) return false;
      if ((match.stage || 'league') !== stage) return false;
      if (categoryId) return match.categoryId === categoryId;
      return !match.categoryId;
    });
  }

  function unfinishedStageMatches(tournament, sport, division, stageId, bracketId) {
    return stageMatchList(tournament, sport, division, stageId).filter(function (match) {
      if (bracketId && match.bracketId !== bracketId) return false;
      return match.status !== 'completed';
    });
  }

  function stageMatchesAreComplete(tournament, sport, division, stageId) {
    const matches = stageMatchList(tournament, sport, division, stageId);
    return matches.length > 0 && !unfinishedStageMatches(tournament, sport, division, stageId).length;
  }

  function stageAdvanceBlockedReason(tournament, sport, division, fromStageId) {
    if (!sport || !division || !fromStageId) return 'Choose the stage you are advancing from.';
    if (stageIsMarkedComplete(division, fromStageId)) return '';
    const label = stageLabelOf(sport, fromStageId);
    const matches = stageMatchList(tournament, sport, division, fromStageId);
    const leftover = unfinishedStageMatches(tournament, sport, division, fromStageId);
    if (!matches.length) {
      return 'Complete every match in ' + label + ' before advancing anyone to the next stage.';
    }
    if (leftover.length) {
      return leftover.length + ' match' + (leftover.length === 1 ? '' : 'es') + ' in ' + label
        + ' still open. Finish every match and mark the stage complete before advancing.';
    }
    return 'Mark ' + label + ' complete before advancing teams to the next stage.';
  }

  function previousStageUnlocked(sport, division, stageId) {
    const prev = previousStageBefore(sport, division, stageId);
    if (!prev) return true;
    return stageIsMarkedComplete(division, prev.id);
  }

  function stageStartBlockedReason(sport, division, stageId) {
    const prev = previousStageBefore(sport, division, stageId);
    if (!prev) return '';
    if (stageIsMarkedComplete(division, prev.id)) return '';
    return 'Mark ' + (prev.name || 'the previous stage') + ' complete before starting '
      + stageLabelOf(sport, stageId) + '. Every match in that stage must be finished first.';
  }

  function scheduleStageBlockedReason(sport, scope) {
    if (!sport || !scope || !scope.categoryId || !scope.bracket) return '';
    return stageStartBlockedReason(sport, findDivision(sport, scope.categoryId), bracketStageId(scope.bracket));
  }

  function copyDivisionResultFields(src, out) {
    const ranking = rankingRecord(src);
    if (Object.keys(ranking).length) out.ranking = ranking;
    const winnerId = String((src && src.winnerId) || '').trim();
    const runnerId = String((src && src.runnerId) || '').trim();
    if (winnerId) out.winnerId = winnerId;
    if (runnerId) out.runnerId = runnerId;
    const completed = completedStageIds(src);
    if (completed.length) out.completedStages = completed;
    return out;
  }

  function isEntryStage(sport, division, stageId) {
    const stages = categoryStages(sport, division);
    return !stages.length || stages[0].id === (stageId || 'league');
  }

  function nextStageAfter(sport, division, stageId) {
    const stages = categoryStages(sport, division);
    const idx = stages.findIndex(function (st) { return st.id === stageId; });
    if (idx >= 0) return stages[idx + 1] || null;
    const all = stageListFor(sport);
    const at = all.findIndex(function (st) { return st.id === stageId; });
    for (let i = at + 1; i < all.length; i++) {
      if (!stageIsSkipped(division, all[i].id)) return all[i];
    }
    return null;
  }

  function previousStageBefore(sport, division, stageId) {
    const stages = categoryStages(sport, division);
    const idx = stages.findIndex(function (st) { return st.id === stageId; });
    return idx > 0 ? stages[idx - 1] : null;
  }

  function teamsForStage(division, sport, stageId) {
    const all = (division && division.teams) || [];
    if (isEntryStage(sport, division, stageId)) return all.slice();
    const ids = advancedTeamIds(division, stageId);
    return ids.map(function (id) {
      return all.find(function (tm) { return tm && tm.id === id; });
    }).filter(Boolean);
  }

  // Seed on a later stage is the team's order in advanced[stageId]
  // (previous-stage overall rank). Seed 1 is the best remaining rank.
  function stageSeedOf(division, sport, stageId, teamId) {
    if (!division || !teamId || isEntryStage(sport, division, stageId)) return 0;
    const idx = advancedTeamIds(division, stageId).indexOf(teamId);
    return idx >= 0 ? idx + 1 : 0;
  }

  function teamLabelsHtml(tags, seedNo, kind) {
    const chips = [];
    if (seedNo > 0) chips.push('Seed ' + seedNo);
    return teamTagsHtml(chips.concat(stripSeedTags(tags)), kind);
  }

  function teamsOfferedInStage(division, sport, stageId) {
    const pool = teamsForStage(division, sport, stageId);
    const seen = {};
    pool.forEach(function (tm) { if (tm && tm.id) seen[tm.id] = true; });
    const extra = [];
    bracketsInStage(division, stageId).forEach(function (b) {
      (b.teamIds || []).forEach(function (id) {
        if (!id || seen[id]) return;
        const tm = ((division && division.teams) || []).find(function (t) { return t.id === id; });
        if (!tm) return;
        seen[id] = true;
        extra.push(tm);
      });
    });
    return pool.concat(extra);
  }

  // A removed custom stage sends its brackets back to League.
  function remapBracketStages(divisions, stageIds) {
    const allowed = stageIds || [];
    return (divisions || []).map(function (d) {
      const advanced = {};
      const record = advancedRecord(d);
      Object.keys(record).forEach(function (stageId) {
        if (allowed.indexOf(stageId) === -1) return;
        advanced[stageId] = record[stageId];
      });
      return Object.assign({}, d, {
        skippedStages: skippedStageIds(d).filter(function (id) { return allowed.indexOf(id) !== -1; }),
        advanced: advanced,
        brackets: (d.brackets || []).map(function (b) {
          const stageId = bracketStageId(b);
          const next = allowed.indexOf(stageId) === -1 ? 'league' : stageId;
          if (b.stageId === next) return b;
          return Object.assign({}, b, { stageId: next });
        })
      });
    });
  }

  function resultKind(match) {
    if (!match || match.status !== 'completed') return 'none';
    if (match.resultType === 'no_result') return 'no_result';
    if (match.resultType === 'walkover') return 'walkover';
    if (match.resultType === 'draw' || match.winner === 'tie') return 'draw';
    if (match.winner === 'A' || match.winner === 'B') return 'win';
    return 'none';
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

  // Per-sport roster cap. 0 / missing = no limit.
  function parseMaxRosterSize(value) {
    const n = parseInt(String(value == null ? '' : value).trim(), 10);
    if (!isFinite(n) || n < 1) return 0;
    return Math.min(n, 999);
  }

  function maxRosterSize(sport) {
    return parseMaxRosterSize(sport && sport.maxRosterSize);
  }

  function hasCaptain(team) {
    return !!(team && (team.captainUid || team.captainName || team.captainEmail));
  }

  // Captain stored as team fields, shaped like a roster row so they can
  // match, count, and display as a regular team member.
  function captainMember(team) {
    if (!hasCaptain(team)) return null;
    const split = splitName(team.captainName || '');
    return {
      uid: team.captainUid || '',
      email: team.captainEmail || '',
      firstName: split.firstName || '',
      lastName: split.lastName || '',
      familyId: team.captainFamilyId || '',
      memberId: '',
      name: team.captainName || '',
      isCaptain: true
    };
  }

  function isCaptainPerson(team, person) {
    const cap = captainMember(team);
    return !!(cap && person && membersMatch(cap, person));
  }

  // Unique people on the team: roster rows plus the captain when they are
  // not already listed. Existing captains who were never added to roster[]
  // still count toward the max and show in the member total.
  function teamMembers(team) {
    const roster = Array.isArray(team && team.roster) ? team.roster.slice() : [];
    const cap = captainMember(team);
    if (cap && !roster.some(function (r) { return membersMatch(cap, r); })) {
      roster.unshift(cap);
    }
    return roster;
  }

  function personDisplayName(person) {
    if (!person) return '';
    return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim()
      || String(person.name || '').trim();
  }

  function rosterCountOf(team) {
    return teamMembers(team).length;
  }

  function memberRowFromPerson(person) {
    return {
      memberId: person.memberId || '',
      familyId: person.familyId ? String(person.familyId) : '',
      firstName: person.firstName || '',
      middleName: person.middleName || '',
      lastName: person.lastName || '',
      familyName: person.familyName || '',
      uid: person.uid || '',
      email: (person.email || '').toLowerCase() || '',
      addedByUid: currentUid() || '',
      addedByName: signedInDisplayName(),
      addedAt: new Date().toISOString()
    };
  }

  function ensureCaptainOnRosterList(team, roster) {
    const cap = captainMember(team);
    if (!cap) return roster;
    if (roster.some(function (r) { return membersMatch(cap, r); })) return roster;
    roster.push(memberRowFromPerson(cap));
    return roster;
  }

  function isRosterAtCap(sport, team) {
    const max = maxRosterSize(sport);
    if (!max) return false;
    return rosterCountOf(team) >= max;
  }

  function rosterCountLabel(sport, team) {
    const count = rosterCountOf(team);
    const max = maxRosterSize(sport);
    return max ? (count + ' / ' + max) : String(count);
  }

  function newId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function courtOf(item) {
    if (!item) return '';
    return String(item.court || item.venue || '').trim();
  }

  function scheduledAtIso(value) {
    if (!value) return '';
    if (typeof value === 'object') {
      if (typeof value.toDate === 'function') {
        const fromTs = value.toDate();
        return isNaN(fromTs) ? '' : fromTs.toISOString();
      }
      if (typeof value.seconds === 'number') {
        const fromSeconds = new Date(value.seconds * 1000);
        return isNaN(fromSeconds) ? '' : fromSeconds.toISOString();
      }
    }
    const d = new Date(value);
    return isNaN(d) ? '' : d.toISOString();
  }

  function scheduledAtMs(value) {
    const iso = scheduledAtIso(value);
    if (!iso) return 0;
    const d = new Date(iso);
    return isNaN(d) ? 0 : d.getTime();
  }

  function sortByScheduledTime(a, b) {
    const sa = scheduledAtMs(a && a.scheduledAt);
    const sb = scheduledAtMs(b && b.scheduledAt);
    if (sa !== sb) {
      if (!sa) return 1;
      if (!sb) return -1;
      return sa - sb;
    }
    return String((a && (a.id || a.matchId)) || '').localeCompare(String((b && (b.id || b.matchId)) || ''));
  }

  function emptyScheduleEntry(overrides) {
    const base = {
      id: newId('slot'),
      stage: 'league',
      a: '',
      b: '',
      scheduledAt: '',
      venue: '',
      court: '',
      showUpcoming: false,
      matchId: ''
    };
    const merged = Object.assign(base, overrides || {});
    const court = courtOf(merged);
    merged.court = court;
    merged.venue = court;
    merged.scheduledAt = scheduledAtIso(merged.scheduledAt);
    merged.showUpcoming = !!merged.showUpcoming;
    return merged;
  }

  function sanitizeScheduleEntries(entries) {
    return (entries || []).map(function (e) {
      const court = courtOf(e);
      return {
        id: e.id || newId('slot'),
        stage: e.stage || 'league',
        a: String(e.a || ''),
        b: String(e.b || ''),
        scheduledAt: scheduledAtIso(e.scheduledAt),
        venue: court,
        court: court,
        showUpcoming: !!e.showUpcoming,
        matchId: e.matchId || ''
      };
    }).sort(sortByScheduledTime);
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

  function bracketScheduleCount(bracket) {
    const sch = getSchedule(bracket);
    const draft = (sch.draft && sch.draft.entries && sch.draft.entries.length) || 0;
    const published = (sch.published && sch.published.entries && sch.published.entries.length) || 0;
    return Math.max(draft, published);
  }

  function scheduleBracketPickerHtml(brackets, selectedId, opts) {
    const list = brackets || [];
    const allowAll = !!(opts && opts.allowAll);
    const chosen = isAllSchedulesView(selectedId)
      ? ALL_SCHEDULES
      : (list.some(function (b) { return b.id === selectedId; }) ? selectedId : (list[0] && list[0].id));
    let options = list.map(function (b) {
      const count = bracketScheduleCount(b);
      return '<option value="' + escapeHtml(b.id) + '"' + (b.id === chosen ? ' selected' : '') + '>'
        + escapeHtml(b.name || 'Bracket')
        + (count ? ' · ' + count + ' fixture' + (count === 1 ? '' : 's') : '')
        + (bracketIsComplete(b) ? ' · Complete' : '')
        + '</option>';
    }).join('');
    if (allowAll && list.length) {
      options = '<option value="' + ALL_SCHEDULES + '"' + (chosen === ALL_SCHEDULES ? ' selected' : '') + '>All schedules</option>' + options;
    }
    return '<label class="t-schedule-picker">Bracket <select class="t-select" data-act="schedule-bracket">' + options + '</select></label>';
  }

  // Single-sport tournaments have no tournament-wide rules. Multi-sport
  // tournaments do. Older docs infer the mode from how many sports they have.
  function sportModeOf(tournament) {
    if (!tournament) return 'single';
    if (tournament.sportMode === 'multi' || tournament.sportMode === 'single') return tournament.sportMode;
    return (tournament.sports || []).length > 1 ? 'multi' : 'single';
  }

  function isMultiSportTournament(tournament) {
    return sportModeOf(tournament) === 'multi';
  }

  function tournamentHasStarted(tournament) {
    return !!(tournament && tournament.started);
  }

  function clampMaxPlayers(value) {
    const n = parseInt(String(value == null ? '' : value).trim(), 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(n, 20);
  }

  function blankDivision(opts) {
    opts = opts || {};
    const division = {
      id: opts.id || newId('cat'),
      name: opts.name || 'Category',
      open: !!opts.open,
      maxPlayers: clampMaxPlayers(opts.maxPlayers || 2),
      teams: opts.teams ? JSON.parse(JSON.stringify(opts.teams)) : [],
      brackets: opts.brackets ? JSON.parse(JSON.stringify(opts.brackets)) : []
    };
    const skipped = skippedStageIds(opts);
    if (skipped.length) division.skippedStages = skipped;
    return division;
  }

  function usesRegistrationCategories(sport) {
    const mode = sport && sport.categoryMode;
    return mode === 'open' || mode === 'split';
  }

  function ensureDivisionsForMode(sport, mode) {
    if (!sport) return;
    sport.divisions = Array.isArray(sport.divisions) ? sport.divisions : [];
    if (mode === 'open') {
      const keep = sport.divisions.find(function (d) { return d && d.open; }) || sport.divisions[0];
      const division = keep
        ? Object.assign({}, keep, { open: true, name: (keep.name || 'Open') })
        : blankDivision({ name: 'Open', open: true, maxPlayers: 2 });
      division.open = true;
      if (!division.name) division.name = 'Open';
      division.teams = Array.isArray(division.teams) ? division.teams : [];
      division.brackets = Array.isArray(division.brackets) ? division.brackets : [];
      division.maxPlayers = clampMaxPlayers(division.maxPlayers);
      sport.divisions = [division];
      sport.categoryMode = 'open';
      return;
    }
    if (mode === 'split') {
      sport.categoryMode = 'split';
      if (!sport.divisions.length) {
        sport.divisions = [blankDivision({ name: 'Category 1', open: false, maxPlayers: 2 })];
      }
      sport.divisions = sport.divisions.map(function (d) {
        return Object.assign({}, d, {
          open: false,
          name: d.name || 'Category',
          maxPlayers: clampMaxPlayers(d.maxPlayers),
          teams: Array.isArray(d.teams) ? d.teams : [],
          brackets: Array.isArray(d.brackets) ? d.brackets : []
        });
      });
      return;
    }
    sport.categoryMode = '';
  }

  function findDivision(sport, divisionId) {
    const list = (sport && sport.divisions) || [];
    if (!list.length) return null;
    if (divisionId) {
      const found = list.find(function (d) { return d.id === divisionId; });
      if (found) return found;
    }
    return null;
  }

  function findBracket(division, bracketId) {
    const list = (division && division.brackets) || [];
    if (!bracketId) return null;
    return list.find(function (b) { return b.id === bracketId; }) || null;
  }

  function teamPlayersLabel(team) {
    return ((team && team.players) || []).map(function (p) {
      return String(p || '').trim();
    }).filter(Boolean).join(', ');
  }

  function parseTeamTags(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    const seen = {};
    const out = [];
    list.forEach(function (item) {
      const tag = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!tag) return;
      const key = tag.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      if (out.length < 6) out.push(tag);
    });
    return out;
  }

  function teamTagsHtml(tags, kind) {
    const list = parseTeamTags(tags);
    if (!list.length) return '';
    const row = kind === 'watch' ? 'w-tags' : 't-tag-row';
    const chip = kind === 'watch' ? 'w-tag' : 't-tag';
    return '<span class="' + row + '">' + list.map(function (tag) {
      const extra = isSeedTag(tag) ? (kind === 'watch' ? ' w-seed-tag' : ' t-seed-tag') : '';
      return '<span class="' + chip + extra + '">' + escapeHtml(tag) + '</span>';
    }).join('') + '</span>';
  }

  function findEntryTeam(tournament, sportId, id) {
    if (!id) return null;
    const sport = getSportConfig(tournament, sportId);
    const divs = (sport && sport.divisions) || [];
    for (let i = 0; i < divs.length; i++) {
      const teams = divs[i].teams || [];
      const idx = teams.findIndex(function (t) { return t.id === id; });
      if (idx >= 0) return { team: teams[idx], index: idx, division: divs[i] };
    }
    const legacy = teamsFor(tournament, sport || sportId);
    const idx = legacy.findIndex(function (t) { return t.id === id; });
    if (idx >= 0) return { team: legacy[idx], index: idx, division: null };
    return null;
  }

  function bracketForTeam(division, teamId, stageId) {
    const brackets = (division && division.brackets) || [];
    for (let i = 0; i < brackets.length; i++) {
      if (stageId && bracketStageId(brackets[i]) !== stageId) continue;
      const ids = brackets[i].teamIds || [];
      if (ids.indexOf(teamId) !== -1) return brackets[i];
    }
    return null;
  }

  function teamsInBracket(sport, categoryId, bracketId) {
    const division = findDivision(sport, categoryId);
    const bracket = findBracket(division, bracketId);
    if (!division || !bracket) return [];
    const ids = bracket.teamIds || [];
    return (division.teams || []).filter(function (tm) { return ids.indexOf(tm.id) !== -1; });
  }

  function matchUsesTeams(tournament, sport) {
    if (sport && usesRegistrationCategories(sport)) return true;
    return !!(tournament && tournament.format === 'teams');
  }

  function isIndividualTournament(tournament) {
    return !!(tournament && tournament.format === 'individual');
  }

  function showsOverallPointsTable(tournament) {
    return !isIndividualTournament(tournament);
  }

  // Legacy fixtures have no category. Bracket fixtures must match both ids.
  function entryInScope(match, sportId, categoryId, bracketId) {
    if (!match || match.sport !== sportId) return false;
    if (!categoryId && !bracketId) return !match.categoryId && !match.bracketId;
    return (match.categoryId || '') === (categoryId || '') && (match.bracketId || '') === (bracketId || '');
  }

  function scopeIds(scope) {
    scope = scope || {};
    return {
      categoryId: scope.categoryId || (scope.division && scope.division.id) || '',
      bracketId: scope.bracketId || (scope.bracket && scope.bracket.id) || ''
    };
  }

  function scheduleOwner(sport, categoryId, bracketId) {
    if (!categoryId) return sport || null;
    const division = findDivision(sport, categoryId);
    if (!division || !bracketId) return null;
    return findBracket(division, bracketId);
  }

  function mergeDivisionsForSave(draftSport, liveSport) {
    const liveDivs = (liveSport && liveSport.divisions) || [];
    return (draftSport.divisions || []).map(function (d) {
      const live = liveDivs.find(function (x) { return x.id === d.id; });
      const open = draftSport.categoryMode === 'open';
      const out = {
        id: d.id,
        name: String(d.name || '').trim() || (open ? 'Open' : 'Category'),
        open: open ? true : false,
        maxPlayers: clampMaxPlayers(d.maxPlayers),
        teams: ((live && Array.isArray(live.teams)) ? live.teams : (Array.isArray(d.teams) ? d.teams : [])).map(function (tm) {
          const players = Array.isArray(tm.players) ? tm.players.map(function (p) { return String(p || '').trim(); }).filter(Boolean) : [];
          return Object.assign({}, tm, { players: players.slice(0, clampMaxPlayers(d.maxPlayers)) });
        }),
        brackets: (live && Array.isArray(live.brackets)) ? live.brackets : (Array.isArray(d.brackets) ? d.brackets : []),
        skippedStages: skippedStageIds(live || d),
        advanced: advancedRecord(live || d)
      };
      return copyDivisionResultFields(live || d, out);
    });
  }

  // Koinonia seed used when the tournament list is empty and admin clicks "Seed".
  function koinoniaSeed() {
    const teams = JSON.parse(JSON.stringify(DEFAULT_TEAMS));
    return {
      name: 'Koinonia 2026',
      format: 'teams',
      sportMode: 'multi',
      sports: [
        sportTemplateForConfig('badminton',   { teams: teams }),
        sportTemplateForConfig('pickleball',  { teams: teams }),
        sportTemplateForConfig('tabletennis', { teams: teams }),
        sportTemplateForConfig('volleyball',  { teams: teams }),
        sportTemplateForConfig('basketball',  { teams: teams })
      ],
      archived: false,
      published: false
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
    const value = scheduledAtIso(iso) || iso;
    if (!value) return 'TBD';
    const d = new Date(value);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fmtDate(iso) {
    if (!iso) return 'TBD';
    const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function toDatetimeLocal(iso) {
    const value = scheduledAtIso(iso);
    if (!value) return '';
    const d = new Date(value);
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
    const requestedPanel = params.get('panel');
    const panel = requestedPanel === 'rules' || requestedPanel === 'matches' ? requestedPanel : 'summary';
    const view = params.get('create') === '1' ? 'create'
                : params.get('manage') === '1' && t ? 'manage'
                : t ? 'tournament'
                : 'list';
    return {
      view,
      tournamentId: t || null,
      sportId: sport || null,
      panel,
      categoryId: params.get('cat') || null,
      bracketId: params.get('bracket') || null,
      teamId: params.get('team') || null,
      stageId: params.get('st') || null
    };
  }

  function navigate(params, opts) {
    const search = new URLSearchParams();
    if (params.tournamentId) search.set('t', params.tournamentId);
    if (params.sportId) search.set('sport', params.sportId);
    if (params.panel === 'rules' || params.panel === 'matches') search.set('panel', params.panel);
    if (params.categoryId) search.set('cat', params.categoryId);
    if (params.bracketId) search.set('bracket', params.bracketId);
    if (params.teamId) search.set('team', params.teamId);
    if (params.stageId) search.set('st', params.stageId);
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
    isScorer: false,
    isLabUser: false,
    currentProfile: null,
    adminUi: true,
    authLoading: true,
    tournaments: [],       // all tournaments (subscribed once)
    matches: [],           // matches for the current tournament only
    currentId: null,       // tournamentId currently subscribed for matches
    users: [],             // signed-in user profiles (from `users` collection)
    rsvpResponses: [],     // raw docs from rsvpResponses (existing app data)
    members: [],           // parishioner directory loaded from members.csv for roster selection
    membersLoaded: false,  // becomes true once members.csv is fetched and parsed
    unsubTournaments: null,
    unsubMatches: null,
    unsubUsers: null,
    unsubRsvp: null,
    ready: { tournaments: false, matches: false, users: false, rsvp: false },
    scorerDirectory: null,
    adminDirectory: null,
    // Last error surfaced by each data source, for diagnostics in the UI.
    errors: { users: null, rsvp: null, upsert: null }
  };
  let scorerDirectoryPromise = null;
  let scorerDirectoryLoading = false;

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
  function signedInDisplayName() {
    const profile = state.currentProfile || {};
    const profileName = [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ').trim();
    return profileName || (state.user && (state.user.displayName || state.user.email)) || '';
  }

  const ADMIN_UI_KEY = 'smash.tournament.adminUi';

  function readAdminUiPref() {
    try {
      const v = localStorage.getItem(ADMIN_UI_KEY);
      if (v === '0' || v === 'false') return false;
    } catch (_) {}
    return true;
  }

  // Real admin role (from Firestore). Lab users never have this.
  function isRealAdmin() { return !!state.isAdmin; }

  function hasScorerRole() { return !!state.isScorer; }

  // Admin tools in the UI. Admins can turn this off to preview the member view.
  function isAdminUi() { return !!(state.isAdmin && state.adminUi); }

  function setAdminUi(on) {
    if (!state.isAdmin) return;
    state.adminUi = !!on;
    try { localStorage.setItem(ADMIN_UI_KEY, state.adminUi ? '1' : '0'); } catch (_) {}
    render();
  }

  function canEditTournamentConfig() { return isAdminUi(); }

  function canManageCaptains() { return isAdminUi(); }

  function canEditSchedule() { return isAdminUi(); }

  function isAssignedScorer(match) {
    return !!(match && hasScorerRole() && currentUid() && match.scorerUid === currentUid());
  }

  function isActivePublishedTournament(tournament) {
    return !!(tournament && tournament.started === true && tournament.published === true);
  }

  function tournamentForMatch(match) {
    return match && state.tournaments.find(function (item) { return item.id === match.tournamentId; });
  }

  function isTournamentScorer(tournament) {
    if (isRealAdmin()) return true;
    const uid = currentUid();
    return !!(uid && tournament && (tournament.scorers || []).some(function (scorer) {
      return scorer && scorer.uid === uid;
    }));
  }

  function canScoreMatch(match) {
    if (isAdminUi()) return !!match;
    if (isRealAdmin()) return !!(match && match.status !== 'scheduled');
    const tournament = tournamentForMatch(match);
    return !!(isAssignedScorer(match)
      && match.status === 'in_progress'
      && isActivePublishedTournament(tournament)
      && isTournamentScorer(tournament));
  }

  function assertCanScoreMatch(match) {
    const latest = match && state.matches.find(function (item) { return item.id === match.id; });
    const target = latest || match;
    if (isRealAdmin()) return target;
    if (!target || !isAssignedScorer(target)) throw new Error('Only the assigned scorer or an admin can score this match.');
    const tournament = tournamentForMatch(target);
    if (!isActivePublishedTournament(tournament)) throw new Error('Scoring is available only while the tournament is active and published.');
    if (!isTournamentScorer(tournament)) throw new Error('You are no longer assigned as a scorer for this tournament.');
    if (target.status !== 'in_progress') throw new Error('Scoring is available only after an admin starts the match and before it is completed.');
    return target;
  }

  function teamForMatchSide(tournament, match, side) {
    const p = participantsOf(match, tournament);
    const id = side === 'B' ? p.b : p.a;
    if (!id) return null;
    const found = findEntryTeam(tournament, match.sport, id);
    if (found && found.team) return found.team;
    return (teamsFor(tournament, match.sport) || []).find(function (tm) { return tm && tm.id === id; }) || null;
  }

  function matchAckOf(match, side) {
    if (!match) return null;
    const name = String(match['ack' + side + 'Name'] || '').trim();
    const at = match['ack' + side + 'At'];
    const uid = match['ack' + side + 'Uid'];
    if (!name && !at && !uid) return null;
    return {
      uid: uid || '',
      name: name,
      at: at || ''
    };
  }

  function uniquePlayerNames(list) {
    const seen = {};
    const out = [];
    (list || []).forEach(function (raw) {
      const name = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(name);
    });
    return out;
  }

  function splitPlayerNameList(raw) {
    return String(raw || '').split(/\s*(?:,|\/|&| and )\s*/i);
  }

  function matchSidePlayerNames(tournament, match, side) {
    const names = [];
    const team = teamForMatchSide(tournament, match, side);
    if (team) {
      (team.players || []).forEach(function (p) { names.push(p); });
      teamMembers(team).forEach(function (member) { names.push(personDisplayName(member)); });
    }
    (match && match.games || []).forEach(function (game) {
      splitPlayerNameList(side === 'B' ? game.playersB : game.playersA).forEach(function (p) {
        names.push(p);
      });
    });
    return uniquePlayerNames(names);
  }

  function matchSideCaptains(tournament, match) {
    const a = teamForMatchSide(tournament, match, 'A');
    const b = teamForMatchSide(tournament, match, 'B');
    return {
      captainAUid: (a && a.captainUid) || '',
      captainAEmail: String((a && a.captainEmail) || '').trim().toLowerCase(),
      captainBUid: (b && b.captainUid) || '',
      captainBEmail: String((b && b.captainEmail) || '').trim().toLowerCase()
    };
  }

  function matchCaptainPatch(tournament, match) {
    const caps = matchSideCaptains(tournament, match);
    const out = {};
    if (caps.captainAUid) out.captainAUid = caps.captainAUid;
    if (caps.captainAEmail) out.captainAEmail = caps.captainAEmail;
    if (caps.captainBUid) out.captainBUid = caps.captainBUid;
    if (caps.captainBEmail) out.captainBEmail = caps.captainBEmail;
    return out;
  }

  function canAckMatchSide(match, tournament, side) {
    if (!match || (match.status !== 'in_progress' && match.status !== 'completed')) return false;
    if (matchAckOf(match, side)) return false;
    if (isAdminUi()) return true;
    return canScoreMatch(match);
  }

  function canUnackMatchSide(match, side) {
    return !!(isAdminUi() && matchAckOf(match, side));
  }

  function matchSideAckHtml(match, tournament, side) {
    const ack = matchAckOf(match, side);
    if (ack) {
      const who = ack.name ? ' · ' + escapeHtml(ack.name) : '';
      return '<span class="t-ack-row">'
        + '<span class="t-ack-done">Acked' + who + '</span>'
        + (canUnackMatchSide(match, side)
          ? '<button type="button" class="t-btn sm" data-act="unack" data-side="' + side + '">Unack</button>'
          : '')
        + '</span>';
    }
    if (!canAckMatchSide(match, tournament, side)) return '';
    return '<span class="t-ack-row"><button type="button" class="t-btn success sm" data-act="ack" data-side="' + side + '">Ack</button></span>';
  }

  function bindMatchAckButtons(root, match, tournament) {
    if (!root) return;
    root.querySelectorAll('[data-act="ack"], [data-act="unack"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const side = btn.getAttribute('data-side');
        if (btn.getAttribute('data-act') === 'ack') openAckPicker(match, tournament, side);
        else setMatchAck(match, tournament, side, false);
      });
    });
  }

  function closeAckPicker() {
    const modal = document.getElementById('tAckPicker');
    if (modal) modal.classList.remove('open');
  }

  function openAckPicker(match, tournament, side) {
    if (side !== 'A' && side !== 'B') return;
    const latest = (state.matches || []).find(function (item) { return item.id === match.id; }) || match;
    if (!canAckMatchSide(latest, tournament, side)) {
      return toast('Only the assigned scorer or an admin can acknowledge.', 'error');
    }
    const team = teamForMatchSide(tournament, latest, side);
    const teamName = teamPublicName(team) || (side === 'B' ? 'Team B' : 'Team A');
    const names = matchSidePlayerNames(tournament, latest, side);
    const shell = getOrCreateModal('tAckPicker', 'Who acknowledged?');
    shell.body.innerHTML = `
      <p class="t-ack-pick-note">Select the player from <b>${escapeHtml(teamName)}</b>. This name is stored on the acknowledgement — not the person signed in.</p>
      <div class="t-ack-pick">
        ${names.map(function (name) {
          return '<button type="button" class="t-btn" data-ack-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
        }).join('')}
      </div>
      ${names.length ? '' : '<p class="t-empty">No players listed on this side yet.</p>'}
      <label class="t-ack-other">
        <span>${names.length ? 'Or type another name' : 'Type the player name'}</span>
        <input type="text" class="t-input" id="tAckOtherName" maxlength="80" placeholder="Player name" />
      </label>
      <div class="t-modal-foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" class="t-btn" data-ack-cancel>Cancel</button>
        <button type="button" class="t-btn success" data-ack-typed>Use this name</button>
      </div>
    `;
    shell.body.querySelectorAll('[data-ack-name]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMatchAck(latest, tournament, side, true, btn.getAttribute('data-ack-name'));
      });
    });
    shell.body.querySelector('[data-ack-cancel]').addEventListener('click', closeAckPicker);
    shell.body.querySelector('[data-ack-typed]').addEventListener('click', function () {
      const typed = String((shell.body.querySelector('#tAckOtherName') || {}).value || '').replace(/\s+/g, ' ').trim();
      if (!typed) return toast('Select or type the player who acknowledged.', 'error');
      setMatchAck(latest, tournament, side, true, typed);
    });
    document.body.appendChild(shell.modal);
    shell.modal.classList.add('open');
  }

  async function setMatchAck(match, tournament, side, on, ackName) {
    if (side !== 'A' && side !== 'B') return;
    const latest = (state.matches || []).find(function (item) { return item.id === match.id; }) || match;
    try {
      if (on) {
        if (!canAckMatchSide(latest, tournament, side)) {
          return toast('Only the assigned scorer or an admin can acknowledge.', 'error');
        }
        const who = String(ackName || '').replace(/\s+/g, ' ').trim();
        if (!who) return toast('Select the player who acknowledged.', 'error');
        const patch = { updatedAt: FieldValue.serverTimestamp() };
        patch['ack' + side + 'Name'] = who;
        patch['ack' + side + 'At'] = new Date().toISOString();
        patch['ack' + side + 'Uid'] = FieldValue.delete();
        if (isAdminUi()) Object.assign(patch, matchCaptainPatch(tournament, latest));
        await db.collection('tournament_matches').doc(latest.id).update(patch);
        closeAckPicker();
        toast(who + ' acknowledged for team ' + side);
      } else {
        if (!canUnackMatchSide(latest, side)) {
          return toast('Only an admin can remove an acknowledgement.', 'error');
        }
        const patch = { updatedAt: FieldValue.serverTimestamp() };
        patch['ack' + side + 'Uid'] = FieldValue.delete();
        patch['ack' + side + 'Name'] = FieldValue.delete();
        patch['ack' + side + 'At'] = FieldValue.delete();
        await db.collection('tournament_matches').doc(latest.id).update(patch);
        toast('Acknowledgement removed');
      }
      render();
    } catch (err) {
      console.error(err);
      toast('Could not update acknowledgement: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function tournamentOpenToEveryone() {
    return !!(window.TournamentAccess && TournamentAccess.isOpenToEveryone());
  }

  function isLabUser() {
    return !!state.isLabUser;
  }

  function canAccessLab() {
    return !!(state.isAdmin || isLabUser() || (window.SmashAuth && SmashAuth.canAccessLab()));
  }

  function canUseTournamentPage() {
    if (!state.user) return false;
    return !!(tournamentOpenToEveryone() || canAccessLab() || hasScorerRole());
  }

  // Members only see a tournament after an admin publishes it.
  // Missing published field (existing docs) counts as unpublished.
  function isTournamentPublished(t) {
    return !!(t && t.published === true);
  }

  function canSeeUnpublishedTournaments() {
    return !!(isRealAdmin() || isLabUser());
  }

  function canOpenTournament(t) {
    if (!t) return false;
    if (isTournamentPublished(t)) return true;
    return canSeeUnpublishedTournaments();
  }

  // SmashAuth may still be resolving isAdmin/isLabUser after a refresh.
  // Do not treat unpublished tournaments as forbidden until that settles.
  function unpublishedAccessPending(t) {
    return !!(t && !isTournamentPublished(t) && state.authLoading);
  }

  function visibleTournaments() {
    return (state.tournaments || []).filter(function (t) {
      return canOpenTournament(t);
    });
  }

  function tournamentAccessPending() {
    // Role (admin/lab/scorer) is used both to open unpublished tournaments and
    // to keep admin URLs. Wait until SmashAuth settles, even if Tournament is
    // already open to everyone — otherwise a refresh treats an admin as a member.
    if (state.authLoading) return true;
    if (tournamentOpenToEveryone() || canAccessLab()) return false;
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

  function teamIsHere(team) {
    return !!(team && team.here);
  }

  function canMarkTeamHere(team) {
    if (!team) return false;
    if (isAdminUi()) return true;
    return isCaptainOf(team) || isRosterMemberOf(team);
  }

  function canClearTeamHere(team) {
    return !!(isAdminUi() && teamIsHere(team));
  }

  function teamHereTitle(team) {
    if (!teamIsHere(team)) return 'Not checked in at registration';
    const bits = ['Checked in'];
    if (team.hereAt) bits.push(fmtDateTime(team.hereAt));
    if (team.hereBy) bits.push(team.hereBy);
    return bits.join(' · ');
  }

  function teamHereControlsHtml(team) {
    if (!team) return '';
    if (teamIsHere(team)) {
      return '<span class="t-here-row">'
        + '<span class="t-badge here" title="' + escapeHtml(teamHereTitle(team)) + '">Here</span>'
        + (canClearTeamHere(team)
          ? '<button type="button" class="t-btn sm" data-act="here" data-team="' + escapeHtml(team.id) + '" data-on="0">Undo</button>'
          : '')
        + '</span>';
    }
    if (!canMarkTeamHere(team)) {
      return '<span class="t-here-row"><span class="t-badge not-here" title="Not checked in at registration">Not here</span></span>';
    }
    return '<span class="t-here-row">'
      + '<span class="t-badge not-here">Not here</span>'
      + '<button type="button" class="t-btn success sm" data-act="here" data-team="' + escapeHtml(team.id) + '" data-on="1">Here</button>'
      + '</span>';
  }

  function teamHereSuffix(team) {
    return teamIsHere(team) ? ' · Here' : '';
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
    const profile = state.currentProfile
      || (state.users || []).find(function (u) { return u.uid === uid; })
      || {};
    const rsvp = (state.rsvpResponses || []).find(function (r) {
      return (r.uid && r.uid === uid) || (r.email && r.email.toLowerCase() === email);
    }) || {};
    const split = splitName(state.user.displayName);
    const firstName = profile.firstName || rsvp.firstName || split.firstName || '';
    const lastName = profile.lastName || rsvp.lastName || split.lastName || '';
    const familyId = String(profile.familyId || profile.FID || rsvp.familyId || rsvp.FID || '').trim();
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
    if (isCaptainPerson(team, me)) return true;
    return (team.roster || []).some(function (r) { return membersMatch(me, r); });
  }

  // Within a sport, a person may belong to only one team. Returns the other
  // team that already lists `member` (roster or captain), or null if free.
  function findOtherTeamForMember(teams, teamId, member) {
    teams = Array.isArray(teams) ? teams : [];
    for (let i = 0; i < teams.length; i++) {
      const tm = teams[i];
      if (tm.id === teamId) continue;
      if (isCaptainPerson(tm, member)) return tm;
      const hit = (tm.roster || []).some(function (r) { return membersMatch(member, r); });
      if (hit) return tm;
    }
    return null;
  }

  // Only admins can toggle the lock. Once locked, no captain can edit.
  function canLockRoster()      { return isAdminUi(); }

  // Edit permissions: admin any time; captain only when unlocked.
  function canEditRoster(team) {
    if (isAdminUi()) return true;
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
    if (isAdminUi()) return true;
    if (isCaptainOf(team)) return true;
    if (isRosterMemberOf(team)) return true;
    if (isRosterLocked(team) && tournament && tournament.revealLockedRosters) return true;
    return false;
  }

  // Human-friendly explainer for why the current user can't view the roster.
  // Used in the "Roster hidden" placeholder on the team card.
  function whyCantView(tournament, team) {
    if (!state.user) return 'Sign in to view rosters.';
    const cap = toCamelCase(team && (team.captainName || team.captainEmail));
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
  // PARISHIONER DIRECTORY (client-side cache)
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
    if (state.membersLoaded || state._membersLoadStarted) return;
    state._membersLoadStarted = true;
    try {
      const response = await fetch('members.csv', { cache: 'no-cache' });
      if (!response.ok) throw new Error('members.csv HTTP ' + response.status);
      const list = parseMembersCsv(await response.text());
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
      state._membersLoadStarted = false;
      console.error('[tournament] Failed to load members.csv:', err);
      toast('Could not load members.csv. Roster search is unavailable.', 'error');
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

  function racketCategoriesForMatch(tournament, sport, match) {
    if (sport && usesRegistrationCategories(sport) && match && match.categoryId) {
      const division = findDivision(sport, match.categoryId);
      return [(division && division.name) || match.categoryId || 'Match'];
    }
    return (sport && sport.categories && sport.categories.length) ? sport.categories : DEFAULT_CATEGORIES;
  }

  function gameHasRecordedScore(game) {
    if (!game) return false;
    if (game.winner || game.playersA || game.playersB) return true;
    return (game.sets || []).some(function (set) { return (set.a || 0) > 0 || (set.b || 0) > 0; });
  }

  function finalizedPlayersForSide(tournament, match, side) {
    const sport = getSportConfig(tournament, match && match.sport);
    if (!sport || !usesRegistrationCategories(sport) || !match || !match.categoryId) return '';
    const participants = participantsOf(match, tournament);
    const found = findEntryTeam(tournament, match.sport, side === 'B' ? participants.b : participants.a);
    return found ? teamPlayersLabel(found.team) : '';
  }

  function racketGamesForMatch(match, tournament, sport) {
    const categories = racketCategoriesForMatch(tournament, sport, match);
    const existing = (match.games || []).map(function (game) {
      return Object.assign({}, game, {
        sets: (game.sets || []).map(function (set) { return Object.assign({}, set); })
      });
    });
    const categorized = !!(sport && usesRegistrationCategories(sport) && match && match.categoryId);
    let games = existing;
    if (categorized) {
      const label = categories[0];
      const chosen = existing.find(function (game) {
        return game.category === label || game.category === match.categoryId;
      }) || existing.find(gameHasRecordedScore) || existing[0] || {};
      games = [Object.assign({}, chosen, { category: label })];
    } else if (!games.length) {
      games = categories.map(function (category) { return { category: category }; });
    }
    const playersA = finalizedPlayersForSide(tournament, match, 'A');
    const playersB = finalizedPlayersForSide(tournament, match, 'B');
    return games.map(function (game) {
      return Object.assign({}, game, {
        playersA: playersA || game.playersA || '',
        playersB: playersB || game.playersB || '',
        sets: game.sets && game.sets.length ? game.sets : [{ a: 0, b: 0 }],
        status: game.status || 'pending',
        winner: game.winner || null
      });
    });
  }

  function racketMatchWinner(match, tournament) {
    const sportCfg = getSportConfig(tournament, match.sport);
    const cats = racketCategoriesForMatch(tournament, sportCfg, match);
    const need = Math.ceil(cats.length / 2);
    let a = 0, b = 0;
    racketGamesForMatch(match, tournament, sportCfg).forEach(function (g) {
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

  function usesRacketSetPoints(match, tournament) {
    if (!tournament || tournament.format !== 'individual') return false;
    const sport = getSportConfig(tournament, match && match.sport);
    if (!sport || sport.kind !== 'racket') return false;
    if (usesRegistrationCategories(sport) && match && match.categoryId) return true;
    return racketGamesForMatch(match, tournament, sport).length <= 1;
  }

  function racketSetScoreLine(match, tournament) {
    const sport = getSportConfig(tournament, match && match.sport);
    const games = racketGamesForMatch(match, tournament, sport);
    const game = games[0] || {};
    const sets = (game.sets || []).filter(function (set, index, list) {
      return (set.a || 0) > 0 || (set.b || 0) > 0 || index === list.length - 1;
    });
    const shown = sets.length ? sets : [{ a: 0, b: 0 }];
    return shown.map(function (set) {
      return (set.a || 0) + '–' + (set.b || 0);
    }).join('  ');
  }

  function latestRacketSet(match, tournament) {
    const sport = getSportConfig(tournament, match && match.sport);
    const sets = (racketGamesForMatch(match, tournament, sport)[0] || {}).sets || [];
    let set = sets[0] || { a: 0, b: 0 };
    for (let i = sets.length - 1; i >= 0; i--) {
      if ((sets[i].a || 0) > 0 || (sets[i].b || 0) > 0 || i === 0) {
        set = sets[i];
        break;
      }
    }
    return { a: set.a || 0, b: set.b || 0 };
  }

  function matchScoreDisplay(match, tournament) {
    const sc = getSportConfig(tournament, match.sport);
    if (!sc) return { a: '—', b: '—' };
    if (sc.kind === 'racket') {
      if (usesRacketSetPoints(match, tournament)) {
        const set = latestRacketSet(match, tournament);
        return { a: String(set.a), b: String(set.b), label: 'Points' };
      }
      let a = 0, b = 0;
      racketGamesForMatch(match, tournament, sc).forEach(function (g) {
        if (g.winner === 'A') a++;
        else if (g.winner === 'B') b++;
      });
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

  function matchPointTotals(match, tournament) {
    const sport = getSportConfig(tournament, match && match.sport);
    if (!sport || !match || resultKind(match) === 'no_result') {
      return { a: 0, b: 0 };
    }
    if (sport.kind === 'racket') {
      return racketGamesForMatch(match, tournament, sport).reduce(function (totals, game) {
        (game.sets || []).forEach(function (set) {
          totals.a += Number(set.a) || 0;
          totals.b += Number(set.b) || 0;
        });
        return totals;
      }, { a: 0, b: 0 });
    }
    if (sport.kind === 'volleyball') {
      return (match.sets || []).reduce(function (totals, set) {
        totals.a += Number(set.a) || 0;
        totals.b += Number(set.b) || 0;
        return totals;
      }, { a: 0, b: 0 });
    }
    if (sport.kind === 'basketball') return basketballTotals(match);
    return { a: 0, b: 0 };
  }

  function matchHasEnteredScores(match, tournament) {
    if (!match) return false;
    const totals = matchPointTotals(match, tournament);
    if ((totals.a || 0) > 0 || (totals.b || 0) > 0) return true;
    return !!(match.winner && match.status !== 'completed');
  }

  function scheduleRowKind(match, tournament) {
    if (!match) return 'upcoming';
    if (match.status === 'completed') return 'completed';
    if (match.status === 'in_progress' || matchHasEnteredScores(match, tournament)) return 'live';
    return 'upcoming';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STANDINGS
  // ═══════════════════════════════════════════════════════════════════════════

  function participantsOf(match, tournament) {
    if (!match) return { a: '', b: '' };
    if (match.teamA || match.teamB) return { a: match.teamA || '', b: match.teamB || '' };
    if (!tournament) return { a: '', b: '' };
    if (tournament.format === 'teams') return { a: match.teamA || '', b: match.teamB || '' };
    return { a: match.playerA || '', b: match.playerB || '' };
  }

  function toCamelCase(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return '';
    if (s.indexOf('@') !== -1) return s;
    return s.toLowerCase().split(/\s+/).map(function (word) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
  }

  function formatCaptainHtml(raw) {
    const text = toCamelCase(raw) || '(captain)';
    return '<b class="t-captain-name">' + escapeHtml(text) + '</b>';
  }

  // Public team label: ward name when set, otherwise G1 / team id.
  function teamPublicName(team) {
    if (!team) return '—';
    const wards = String(team.wards || '').trim();
    if (wards) return wards;
    return String(team.name || team.id || '—').trim() || '—';
  }

  function displayName(tournament, sportId, id) {
    if (!id) return '—';
    const found = findEntryTeam(tournament, sportId, id);
    if (found) return teamPublicName(found.team);
    return id;
  }

  function teamMeta(tournament, sportId, id) {
    const found = findEntryTeam(tournament, sportId, id);
    if (!found) {
      return {
        name: id || '—',
        id: id || '',
        wards: '',
        tags: [],
        color: id ? TEAM_COLORS[Math.abs(hashCode(String(id))) % TEAM_COLORS.length] : 'var(--t-muted)'
      };
    }
    const t = found.team;
    const publicName = teamPublicName(t);
    const wards = String(t.wards || '').trim();
    const players = teamPlayersLabel(t);
    const detail = wards && wards !== publicName ? wards : players;
    return {
      name: publicName,
      id: t.id || id || '',
      wards: detail || '',
      tags: parseTeamTags(t.tags),
      color: TEAM_COLORS[found.index % TEAM_COLORS.length]
    };
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return h;
  }

  function computeStandings(tournament, matches, sportId, scope) {
    if (!tournament) return [];
    scope = scope || {};
    const sport = sportId ? getSportConfig(tournament, sportId) : null;
    const useTeams = scope.useTeams != null ? scope.useTeams : matchUsesTeams(tournament, sport);
    const stageId = scope.stageId != null ? scope.stageId : 'league';
    const points = tablePointsForScope(sport, scope);
    const scoped = (matches || []).filter(function (m) {
      if (sportId && m.sport !== sportId) return false;
      if (m.status !== 'completed') return false;
      if (stageId && (m.stage || 'league') !== stageId) return false;
      if (scope.categoryId && m.categoryId !== scope.categoryId) return false;
      if (scope.bracketId && m.bracketId !== scope.bracketId) return false;
      // Parish-group standings ignore category fixtures.
      if (!scope.categoryId && !scope.bracketId && (m.categoryId || m.bracketId)) return false;
      if (scope.teamIds) {
        const p = participantsOf(m, tournament);
        if (scope.teamIds.indexOf(p.a) === -1 || scope.teamIds.indexOf(p.b) === -1) return false;
      }
      return true;
    });

    // Collect participant IDs
    const seen = {};
    if (useTeams) {
      if (scope.bracketId) {
        (scope.teamIds || []).forEach(function (id) { if (id) seen[id] = true; });
      } else if (Array.isArray(scope.teamIds)) {
        scope.teamIds.forEach(function (id) { if (id) seen[id] = true; });
      } else if (scope.categoryId && sport) {
        const division = findDivision(sport, scope.categoryId);
        const stageBrackets = ((division && division.brackets) || []).filter(function (b) {
          return !stageId || bracketStageId(b) === stageId;
        });
        const seeded = [];
        stageBrackets.forEach(function (b) {
          (b.teamIds || []).forEach(function (id) {
            if (id && seeded.indexOf(id) === -1) seeded.push(id);
          });
        });
        if (seeded.length) seeded.forEach(function (id) { seen[id] = true; });
        else ((division && division.teams) || []).forEach(function (t) { seen[t.id] = true; });
      } else if (!stageId || stageId === 'league') {
        teamsFor(tournament, sportId).forEach(function (t) { seen[t.id] = true; });
      } else {
        (matches || []).forEach(function (m) {
          if (sportId && m.sport !== sportId) return;
          if ((m.stage || 'league') !== stageId) return;
          if (m.categoryId || m.bracketId) return;
          const p = participantsOf(m, tournament);
          if (p.a) seen[p.a] = true;
          if (p.b) seen[p.b] = true;
        });
      }
    } else {
      scoped.forEach(function (m) { if (m.playerA) seen[m.playerA] = true; if (m.playerB) seen[m.playerB] = true; });
    }
    const table = {};
    Object.keys(seen).forEach(function (id) {
      table[id] = { id: id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, pointsFor: 0, pointsAgainst: 0, h2h: {} };
    });

    function blankRow(id) {
      return { id: id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, pointsFor: 0, pointsAgainst: 0, h2h: {} };
    }

    scoped.forEach(function (m) {
      const p = participantsOf(m, tournament);
      const A = p.a, B = p.b;
      if (!A || !B) return;
      if (!table[A]) table[A] = blankRow(A);
      if (!table[B]) table[B] = blankRow(B);
      const kind = resultKind(m);
      if (kind === 'none') return;
      if (kind === 'no_result') {
        // Neither team showed up, so the configured value is not given to either side.
        return;
      }
      table[A].played++; table[B].played++;
      const score = matchPointTotals(m, tournament);
      table[A].pointsFor += score.a; table[A].pointsAgainst += score.b;
      table[B].pointsFor += score.b; table[B].pointsAgainst += score.a;
      if (kind === 'draw') {
        table[A].drawn++; table[B].drawn++;
        table[A].points += points.draw;
        table[B].points += points.draw;
        return;
      }
      const award = points.win;
      if (m.winner === 'A') {
        table[A].won++; table[A].points += award;
        table[B].lost++;
        table[A].h2h[B] = 'W'; table[B].h2h[A] = 'L';
      } else if (m.winner === 'B') {
        table[B].won++; table[B].points += award;
        table[A].lost++;
        table[B].h2h[A] = 'W'; table[A].h2h[B] = 'L';
      }
    });

    const rows = Object.values(table);
    rows.sort(compareStandingRows);
    return rows;
  }

  function compareStandingRows(x, y) {
    if ((y.points || 0) !== (x.points || 0)) return (y.points || 0) - (x.points || 0);
    const xDiff = (x.pointsFor || 0) - (x.pointsAgainst || 0);
    const yDiff = (y.pointsFor || 0) - (y.pointsAgainst || 0);
    if (yDiff !== xDiff) return yDiff - xDiff;
    if (x.h2h && y.h2h) {
      if (x.h2h[y.id] === 'W' && y.h2h[x.id] !== 'W') return -1;
      if (y.h2h[x.id] === 'W' && x.h2h[y.id] !== 'W') return 1;
    }
    return String(x.id).localeCompare(String(y.id));
  }

  function computeStageRanking(tournament, matches, sport, division, stageId) {
    if (!tournament || !sport || !division) return [];
    const groups = bracketsInStage(division, stageId).filter(bracketHasTeams);
    if (!groups.length) {
      const stageTeamIds = teamsForStage(division, sport, stageId).map(function (tm) { return tm.id; });
      return applyRankingOverride(computeStandings(tournament, matches, sport.id, {
        categoryId: division.id,
        stageId: stageId,
        teamIds: stageTeamIds.length ? stageTeamIds : undefined,
        useTeams: true
      }).map(function (row, i) {
        return Object.assign({}, row, { rank: i + 1, groupName: '', groupRank: i + 1 });
      }), division, stageId);
    }
    const byTeam = {};
    groups.forEach(function (bracket) {
      const rows = computeStandings(tournament, matches, sport.id, {
        categoryId: division.id,
        bracketId: bracket.id,
        teamIds: bracketTeamIds(bracket),
        stageId: stageId,
        useTeams: true
      });
      rows.forEach(function (row, i) {
        byTeam[row.id] = Object.assign({}, row, {
          groupName: bracket.name || 'Group',
          groupRank: i + 1,
          groupComplete: !!bracket.complete
        });
      });
    });
    const list = Object.keys(byTeam).map(function (id) { return byTeam[id]; });
    list.sort(compareStandingRows);
    return applyRankingOverride(list, division, stageId);
  }

  function isSeedTag(tag) {
    return /^seed\s+\d+$/i.test(String(tag || '').trim());
  }

  function stripSeedTags(tags) {
    return parseTeamTags(tags).filter(function (tag) { return !isSeedTag(tag); });
  }

  function rankIdsByPreviousStage(tournament, sport, division, fromStageId, teamIds) {
    const ranking = computeStageRanking(tournament, state.matches, sport, division, fromStageId);
    const pos = {};
    ranking.forEach(function (row) {
      if (row && row.id) pos[row.id] = row.rank;
    });
    return (teamIds || []).slice().sort(function (a, b) {
      const ra = pos[a] != null ? pos[a] : 9999;
      const rb = pos[b] != null ? pos[b] : 9999;
      if (ra !== rb) return ra - rb;
      return String(a).localeCompare(String(b));
    });
  }

  function applyAdvanceSeeds(division, orderedIds) {
    const assigned = {};
    (orderedIds || []).forEach(function (id, i) { assigned[id] = i + 1; });
    (division.teams || []).forEach(function (tm) {
      if (!tm || !tm.id) return;
      if (assigned[tm.id]) {
        tm.tags = stripSeedTags(tm.tags).concat(['Seed ' + assigned[tm.id]]);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTopbar() {
    const bar = document.getElementById('tTopbar');
    if (!bar) return;
    document.body.classList.toggle('t-admin-ui-on', isAdminUi());
    document.body.classList.toggle('t-member-preview', isRealAdmin() && !state.adminUi);
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
        ${isAdminUi() ? '<a href="admin-users.html" class="t-nav-btn" title="Members &amp; Admins">👥 <span class="hide-sm">Members</span></a>' : ''}
        ${isRealAdmin() ? `
          <label class="t-admin-switch" title="Turn on to see admin tools. Turn off to preview the member view.">
            <input type="checkbox" ${state.adminUi ? 'checked' : ''} onchange="window.__tournament.setAdminUi(this.checked)" />
            <span class="t-admin-switch-ui"></span>
            <span class="t-admin-switch-label">${state.adminUi ? 'Admin controls' : 'Member view'}</span>
          </label>
        ` : ''}
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
      const label = isAdminUi()
        ? 'Admin'
        : (hasScorerRole() ? 'Scorer · ' + (signedInDisplayName() || 'You') : (signedInDisplayName() || 'You'));
      box.innerHTML = `
        <span class="t-user-chip"><span class="dot"></span>${escapeHtml(label)}</span>
        <a class="t-nav-btn" href="profile.html?return=tournament.html">Profile</a>
        <button class="t-nav-btn" onclick="window.__tournament.signOut()">Sign out</button>
      `;
    }
  }

  function renderRosterProfileWarning() {
    if (!state.user || isAdminUi()) return '';
    const profile = state.currentProfile || {};
    const firstName = String(profile.firstName || '').trim();
    const familyId = String(profile.familyId || profile.FID || '').trim();
    if (firstName && familyId) return '';
    return `
      <section class="t-profile-warning" role="status">
        <span class="t-profile-warning-icon">⚠️</span>
        <span>To see the team roster you are part of, update your first name and FID in Profile Settings.</span>
        <a href="profile.html?return=tournament.html">Update profile</a>
      </section>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST VIEW — /tournament.html
  // ═══════════════════════════════════════════════════════════════════════════

  function renderList() {
    document.title = 'Church Tournament — All Tournaments';
    const container = document.getElementById('tContent');
    const tournaments = visibleTournaments().slice().sort(function (a, b) {
      if (isTournamentPublished(a) !== isTournamentPublished(b)) return isTournamentPublished(a) ? 1 : -1;
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return (b.createdAt && b.createdAt.seconds || 0) - (a.createdAt && a.createdAt.seconds || 0);
    });
    const canCreate = isAdminUi();
    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>🏆 Church Tournaments</h1>
          <p>Every tournament run at the parish — Koinonia, SMASH, and anything you set up. Live scores, standings, and playoff progress in one place.</p>
        </div>
        <div class="t-emoji">🏆</div>
      </section>

      ${renderAccessBanner()}
      ${renderRosterProfileWarning()}

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
    `;

    const grid = document.getElementById('tTournamentGrid');
    if (!tournaments.length) {
      grid.innerHTML = `
        <div class="t-empty" style="padding: 50px 20px;">
          <div style="font-size: 2.4rem; margin-bottom: 8px;">🏆</div>
          <div style="color:var(--t-fg);font-size:1.05rem;font-weight:600;margin-bottom:4px;">No tournaments yet</div>
          <div>${canCreate ? 'Create your first tournament to get started.' : (canSeeUnpublishedTournaments() ? 'No tournaments yet.' : 'No published tournaments yet. Check back soon.')}</div>
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
      const formatLabel = (isMultiSportTournament(t) ? 'Multi sport' : 'Single sport')
        + ' · ' + (t.format === 'individual' ? 'Individual / Doubles' : 'Team-based');

      // Show the max team count across sports (each sport has its own roster now).
      let maxTeams = 0;
      (t.sports || []).forEach(function (s) {
        let n = 0;
        if (usesRegistrationCategories(s)) {
          (s.divisions || []).forEach(function (d) { n += (d.teams || []).length; });
        } else {
          n = (s.teams || []).length;
        }
        if (n > maxTeams) maxTeams = n;
      });
      if (!maxTeams && Array.isArray(t.teams)) maxTeams = t.teams.length; // legacy fallback

      const card = el('div', { class: 't-tournament-card ' + (t.archived ? 'archived' : '') + (isTournamentPublished(t) ? '' : ' draft') });
      card.innerHTML = `
        <div class="t-format">${escapeHtml(formatLabel)}${t.archived ? ' · Archived' : ''}${isTournamentPublished(t) ? '' : ' · Unpublished'}</div>
        <div class="t-name">${escapeHtml(t.name)}</div>
        <div class="t-sports">${sports || '<span class="t-sport-chip">No sports yet</span>'}${extra}</div>
        <div class="t-stats">
          <span><b>${(t.sports || []).length}</b> sports</span>
          ${maxTeams ? `<span>up to <b>${maxTeams}</b> teams</span>` : ''}
        </div>
        ${isAdminUi() ? `
          <div class="t-card-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px dashed var(--t-border);">
            <button class="t-btn sm" data-act="open">🔎 Open</button>
            <button class="t-btn sm" data-act="manage">⚙️ Manage</button>
            <button class="t-btn sm" data-act="clone">📄 Clone</button>
            <button class="t-btn sm ${isTournamentPublished(t) ? '' : 'primary'}" data-act="publish">${isTournamentPublished(t) ? '🙈 Unpublish' : '📢 Publish'}</button>
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
          if (act === 'clone') return cloneTournament(t);
          if (act === 'publish') return setTournamentPublished(t.id, !isTournamentPublished(t));
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
    if (!isAdminUi()) {
      renderAdminGate();
      return;
    }
    ensureScorerDirectoryThenRender();
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
      draft = { name: '', format: 'teams', sportMode: 'single', sports: [], archived: false, published: false };
    }
    draft.sportMode = sportModeOf(draft);
    editState.draft = draft;

    container.innerHTML = `
      <section class="t-hero" style="--hero-a:#3b82f6;--hero-b:#7c3aed;">
        <div>
          <h1>${mode === 'manage' ? '⚙️ Manage tournament' : '➕ Create tournament'}</h1>
          <p>${mode === 'manage' ? 'Change the sport mode, sports, categories, dates, and scoring. Single-sport tournaments can be switched to multi sport later.' : 'Choose single sport or multi sport. Multi-sport tournaments use tournament-wide rules. Categories, teams, and brackets are set up after you save.'}</p>
        </div>
        <div class="t-emoji">${mode === 'manage' ? '⚙️' : '➕'}</div>
      </section>

      <section class="t-section">
        <div class="t-card">
          <div class="t-card-body">
            <div class="t-form-grid">
              <div class="t-form-field">
                <label>Tournament name *</label>
                <input type="text" class="t-input" id="tfName" placeholder="e.g. Koinonia 2026" value="${escapeHtml(draft.name)}" />
              </div>
              <div class="t-form-field">
                <label>Sports</label>
                <select class="t-select" id="tfSportMode">
                  <option value="single" ${draft.sportMode !== 'multi' ? 'selected' : ''}>Single sport</option>
                  <option value="multi" ${draft.sportMode === 'multi' ? 'selected' : ''}>Multi sport</option>
                </select>
              </div>
              <div class="t-form-field">
                <label>Format</label>
                <select class="t-select" id="tfFormat">
                  <option value="teams" ${draft.format === 'teams' ? 'selected' : ''}>Team-based (groups play each other)</option>
                  <option value="individual" ${draft.format === 'individual' ? 'selected' : ''}>Individual / Doubles</option>
                </select>
              </div>
            </div>
            <p class="t-mode-note" id="tfSportModeNote"></p>
            <div id="tfArchivedWrap" style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;">
                <input type="checkbox" id="tfArchived" ${draft.archived ? 'checked' : ''}/> Archive this tournament (hides from active list)
              </label>
              ${mode === 'manage' ? `
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;" title="Members cannot see this tournament until it is published. Admins and lab users can always open it. Existing tournaments without this flag stay unpublished.">
                <input type="checkbox" id="tfPublished" ${draft.published ? 'checked' : ''}/> Published (visible to members)
              </label>
              ` : `
              <div style="color:var(--t-muted);font-size:.85rem;">New tournaments stay unpublished. Members will not see this until you publish it. Admins and lab users can open it immediately.</div>
              `}
              <label style="display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);font-size:.85rem;" title="When enabled, any signed-in user can view rosters that have been locked. Unlocked rosters remain visible only to team members, the team captain, and admins.">
                <input type="checkbox" id="tfRevealLocked" ${draft.revealLockedRosters ? 'checked' : ''}/> Reveal locked rosters to everyone signed in
              </label>
            </div>
          </div>
        </div>
      </section>

      ${mode === 'manage' && draft.id ? `
      <section class="t-section">
        <div class="t-card">
          <div class="t-card-body">
            <h2 class="t-section-title" style="margin:0 0 8px;">Tournament scorers</h2>
            <p class="t-mode-note" style="margin-top:0;">Grant the scorer role on Members &amp; Admins first. Then choose who can be assigned to matches here. Assigned scorers also appear in the match dropdown.</p>
            <p style="margin:0 0 12px;color:var(--t-fg);">${(draft.scorers || []).length
              ? escapeHtml((draft.scorers || []).map(function (scorer) { return scorer.name || scorer.email || 'Scorer'; }).join(', '))
              : 'No scorers assigned to this tournament yet.'}</p>
            <button type="button" class="t-btn primary" onclick="window.__tournament.openTournamentScorers('${escapeHtml(draft.id)}')">Choose scorers</button>
          </div>
        </div>
      </section>
      ` : ''}

      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">Sports <small>categories, date & scoring per sport</small></h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <select class="t-select" id="tfAddSport" style="width:auto;">
              <option value="">Add sport…</option>
              ${Object.values(SPORT_TEMPLATES).map(function (s) { return `<option value="${s.id}">${s.emoji} ${s.label}</option>`; }).join('')}
              <option value="__custom__">➕ Custom sport…</option>
            </select>
            <span class="t-mode-note" id="tfAddSportNote" style="margin:0;"></span>
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
    document.getElementById('tfSportMode').addEventListener('change', function (e) {
      const next = e.target.value === 'multi' ? 'multi' : 'single';
      if (next === 'single' && (draft.sports || []).length > 1) {
        e.target.value = 'multi';
        draft.sportMode = 'multi';
        toast('Remove sports until only one remains before switching to single sport.', 'error');
        updateSportModeChrome(draft);
        return;
      }
      draft.sportMode = next;
      updateSportModeChrome(draft);
    });
    updateSportModeChrome(draft);

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
      const rosterCount = rosterCountOf(t);
      const capAssigned = t.captainUid || t.captainName || t.captainEmail;
      const captainLabel = capAssigned
        ? '👤 ' + formatCaptainHtml(t.captainName || t.captainEmail || '(assigned)')
          + (t.captainUid ? '' : ' <span class="t-badge nologin" style="font-size:.62rem;">no login</span>')
        : '<span style="color:var(--t-muted);">No captain</span>';
      row.innerHTML = `
        <input type="text" placeholder="Id" value="${escapeHtml(t.id)}" data-team-key="id" />
        <input type="text" placeholder="Wards / description" value="${escapeHtml(t.wards || '')}" data-team-key="wards" />
        <input type="text" placeholder="Tags, optional" value="${escapeHtml(parseTeamTags(t.tags).join(', '))}" data-team-key="tags" title="Optional labels, separated by commas" />
        <div class="t-team-captain-cell">
          <span class="cap-lbl">${captainLabel}</span>
          <div class="cap-actions">
            <button class="t-btn sm" type="button" data-team-captain="1">${capAssigned ? 'Change' : 'Assign captain'}</button>
            ${rosterCount ? '<button class="t-btn sm" type="button" data-team-roster="1">Roster (' + rosterCount + ')</button>' : ''}
          </div>
        </div>
        <button class="t-btn danger sm" data-team-remove="1">Remove</button>
      `;
      row.querySelector('[data-team-key="id"]').addEventListener('input', function () { t.id = this.value.trim() || t.id; t.name = t.id; });
      row.querySelector('[data-team-key="wards"]').addEventListener('input', function () { t.wards = this.value; });
      row.querySelector('[data-team-key="tags"]').addEventListener('input', function () { t.tags = parseTeamTags(this.value); });
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

  function updateSportModeChrome(draft) {
    const note = document.getElementById('tfSportModeNote');
    const addNote = document.getElementById('tfAddSportNote');
    const addSel = document.getElementById('tfAddSport');
    const multi = sportModeOf(draft) === 'multi';
    const blocked = !multi && (draft.sports || []).length >= 1;
    if (note) {
      note.textContent = multi
        ? 'Multi sport: add every sport here. Tournament rules apply to all of them and can be edited on the tournament page.'
        : 'Single sport: one sport, and sport rules only. Tournament-wide rules stay hidden. Switch to multi sport here any time to add more sports.';
    }
    if (addSel) addSel.disabled = blocked;
    if (addNote) {
      addNote.textContent = blocked
        ? 'Switch to multi sport above to add another sport.'
        : '';
    }
  }

  function configureOpenCategory(sport, maxPlayers) {
    sport.teams = [];
    sport.categoryMode = 'open';
    sport.divisions = [blankDivision({
      name: 'Open',
      open: true,
      maxPlayers: maxPlayers || 2
    })];
    return sport;
  }

  function addSport(draft, templateId) {
    if (sportModeOf(draft) === 'single' && (draft.sports || []).length >= 1) {
      toast('This is a single-sport tournament. Switch to multi sport to add another.', 'error');
      return;
    }
    if ((draft.sports || []).find(function (s) { return s.id === templateId; })) {
      toast(templateId + ' is already in this tournament', 'error');
      return;
    }
    draft.sports = draft.sports || [];
    const sport = sportTemplateForConfig(templateId, { teams: [] });
    const maxPlayers = draft.format === 'individual' ? 1 : 2;
    draft.sports.push(configureOpenCategory(sport, maxPlayers));
  }

  function addCustomSport(draft) {
    const name = prompt('Custom sport name (e.g. Chess)');
    if (!name) return;
    const kindLabels = CUSTOM_KINDS.map(function (k, i) { return (i + 1) + ') ' + k.label; }).join('\n');
    const pick = prompt('Which scoring template?\n' + kindLabels, '1');
    const idx = Math.max(0, Math.min(CUSTOM_KINDS.length - 1, (parseInt(pick, 10) || 1) - 1));
    const kind = CUSTOM_KINDS[idx].kind;
    if (sportModeOf(draft) === 'single' && (draft.sports || []).length >= 1) {
      toast('This is a single-sport tournament. Switch to multi sport to add another.', 'error');
      return;
    }
    const id = slugify(name);
    if ((draft.sports || []).find(function (s) { return s.id === id; })) {
      toast('A sport with this id already exists', 'error');
      return;
    }
    const maxPlayers = draft.format === 'individual' ? 1 : 2;
    draft.sports.push(configureOpenCategory({
      id: id, label: name, kind: kind, emoji: '🏅', color: '#64748b',
      date: '',
      hasThirdPlace: true,
      categories: kind === 'racket' ? [...DEFAULT_CATEGORIES] : [],
      teams: [],
      scoring: defaultScoring(kind),
      tablePoints: defaultTablePoints(),
      maxRosterSize: 0
    }, maxPlayers));
  }

  function paintSports(draft) {
    const wrap = document.getElementById('tfSports');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!draft.sports || !draft.sports.length) {
      wrap.innerHTML = '<div class="t-empty">No sports yet. Use the dropdown above to add one.</div>';
      updateSportModeChrome(draft);
      return;
    }
    draft.sports.forEach(function (s, i) {
      if (s.hasThirdPlace === undefined) s.hasThirdPlace = true;
      ensureStageList(s);
      s.teams = s.teams || [];
      if ((s.categoryMode === 'open' || s.categoryMode === 'split') && (!s.divisions || !s.divisions.length)) {
        ensureDivisionsForMode(s, s.categoryMode);
      }
      const card = el('div', { class: 't-config-sport' });
      const categorized = usesRegistrationCategories(s);
      const teamFormat = draft.format === 'teams';
      const teamOnlyFields = teamFormat ? `
            <div class="t-form-field">
              <label>Max roster size</label>
              <input type="number" class="t-input" data-field="maxRosterSize" min="0" placeholder="No limit" value="${maxRosterSize(s) || ''}" />
              <div style="color:var(--t-muted);font-size:.75rem;margin-top:2px;">Per team for this sport, including the captain. Blank or 0 = no limit.</div>
            </div>
            ${s.kind === 'racket' ? `
              <div class="t-form-field">
                <label>Games per match (comma-separated)</label>
                <input type="text" class="t-input" data-field="categories" placeholder="OD1, OD2, XD1, XD2, WD" value="${escapeHtml((s.categories || []).join(', '))}" />
              </div>
            ` : ''}
      ` : '';
      const sportGridCols = !teamFormat
        ? '1fr'
        : (s.kind === 'racket' ? '1fr 1fr 2fr' : '1fr 1fr');
      const teamsSectionHtml = teamFormat && !categorized ? `
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
          <div class="t-form-grid" style="grid-template-columns:${sportGridCols};">
            <div class="t-form-field">
              <label>Match date</label>
              <input type="date" class="t-input" data-field="date" value="${escapeHtml(s.date || '')}" />
            </div>
            ${teamOnlyFields}
          </div>
          ${divisionConfigHtml(s)}
          ${teamsSectionHtml}
          ${pointsEditorHtml(s)}
          ${stageListEditorHtml(s)}
          <div>
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t-muted);margin-bottom:6px;">Match format per stage</div>
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
      const maxInput = card.querySelector('[data-field="maxRosterSize"]');
      if (maxInput) maxInput.addEventListener('input', function () {
        s.maxRosterSize = parseMaxRosterSize(this.value);
      });
      const catInput = card.querySelector('[data-field="categories"]');
      if (catInput) catInput.addEventListener('input', function () {
        s.categories = this.value.split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
      });
      bindDivisionEditor(card, s, draft);
      bindPointsAndStages(card, s, draft);

      // Parish group teams stay on the sport. Category teams are entered
      // on the tournament page, one registration category at a time.
      if (draft.format === 'teams' && !categorized) {
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
      stageListFor(s).forEach(function (st) {
        if (!s.scoring[st.id]) s.scoring[st.id] = Object.assign({}, (s.scoring && s.scoring.league) || defaultScoring(s.kind).league || {});
        stagesWrap.appendChild(buildStageConfig(s, st.id));
      });
      wrap.appendChild(card);
    });
    updateSportModeChrome(draft);
  }

  function divisionConfigHtml(sport) {
    const mode = sport.categoryMode || '';
    const divisions = sport.divisions || [];
    let body = '';
    if (mode === 'open') {
      const d = divisions[0] || blankDivision({ name: 'Open', open: true, maxPlayers: 2 });
      body = `
        <div class="t-division-row">
          <div class="t-form-field">
            <label>Open category label</label>
            <input type="text" class="t-input" data-div-name value="${escapeHtml(d.name || 'Open')}" />
          </div>
          <div class="t-form-field">
            <label>Max players per team</label>
            <input type="number" class="t-input" min="1" max="20" data-div-max value="${clampMaxPlayers(d.maxPlayers)}" />
          </div>
        </div>
        <p class="t-mode-note">Open category means this sport is not split by age, skill, or event. Everyone registers here. After you save, add teams and brackets on the tournament page.</p>
      `;
    } else if (mode === 'split') {
      const rows = divisions.map(function (d, i) {
        return `
          <div class="t-division-row" data-div-index="${i}">
            <div class="t-form-field">
              <label>Category name</label>
              <input type="text" class="t-input" data-div-name value="${escapeHtml(d.name || '')}" placeholder="e.g. Men's singles" />
            </div>
            <div class="t-form-field">
              <label>Max players</label>
              <input type="number" class="t-input" min="1" max="20" data-div-max value="${clampMaxPlayers(d.maxPlayers)}" />
            </div>
            <button type="button" class="t-btn danger sm" data-div-remove="${i}">Remove</button>
          </div>
        `;
      }).join('');
      body = `
        ${rows || '<p class="t-mode-note">Add at least one category.</p>'}
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button type="button" class="t-btn sm" data-div-add>➕ Add category</button>
          <span class="t-mode-note" style="margin:0;">Registrations, brackets, and schedules belong to each category. Set them up on the tournament page after you save. A category can also hide a stage that does not apply to it.</span>
        </div>
      `;
    } else {
      body = '<p class="t-mode-note">Group teams use captains and a parish roster. Choose Open category or Multiple categories to register named teams — including singles and doubles — and then build brackets.</p>';
    }
    return `
      <div class="t-division-editor">
        <div class="t-form-field">
          <label>Registration</label>
          <select class="t-select" data-field="categoryMode">
            <option value="" ${mode === '' ? 'selected' : ''}>Group teams (captains and roster)</option>
            <option value="open" ${mode === 'open' ? 'selected' : ''}>Open category — open to everyone</option>
            <option value="split" ${mode === 'split' ? 'selected' : ''}>Multiple categories</option>
          </select>
        </div>
        ${body}
      </div>
    `;
  }

  function readDivisionFields(card, sport) {
    const rows = card.querySelectorAll('.t-division-editor .t-division-row');
    if (!rows.length || !sport.divisions) return;
    rows.forEach(function (row, i) {
      const division = sport.divisions[i];
      if (!division) return;
      const nameInput = row.querySelector('[data-div-name]');
      const maxInput = row.querySelector('[data-div-max]');
      if (nameInput) division.name = nameInput.value;
      if (maxInput) division.maxPlayers = clampMaxPlayers(maxInput.value);
    });
  }

  function bindDivisionEditor(card, sport, draft) {
    const modeSel = card.querySelector('[data-field="categoryMode"]');
    if (!modeSel) return;
    modeSel.addEventListener('change', function () {
      const next = this.value === 'open' || this.value === 'split' ? this.value : '';
      readDivisionFields(card, sport);
      if (next === 'open' && sport.categoryMode === 'split' && (sport.divisions || []).length > 1) {
        const keep = (sport.divisions[0] && sport.divisions[0].name) || 'the first category';
        if (!confirm('Open category keeps only ' + keep + '. Other categories are removed from this sport when you save. Continue?')) {
          this.value = 'split';
          return;
        }
      }
      ensureDivisionsForMode(sport, next);
      paintSports(draft);
    });
    card.querySelectorAll('[data-div-name]').forEach(function (input, i) {
      input.addEventListener('input', function () {
        if (sport.divisions && sport.divisions[i]) sport.divisions[i].name = this.value;
      });
    });
    card.querySelectorAll('[data-div-max]').forEach(function (input, i) {
      input.addEventListener('input', function () {
        if (sport.divisions && sport.divisions[i]) sport.divisions[i].maxPlayers = clampMaxPlayers(this.value);
      });
    });
    card.querySelectorAll('[data-div-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        readDivisionFields(card, sport);
        const idx = parseInt(btn.getAttribute('data-div-remove'), 10);
        if (!sport.divisions || sport.divisions.length < 2) {
          toast('A split sport needs at least one category. Switch to Open category if everyone plays together.', 'error');
          return;
        }
        const name = (sport.divisions[idx] && sport.divisions[idx].name) || 'this category';
        if (!confirm('Remove ' + name + '? Teams in that category are removed when you save.')) return;
        sport.divisions.splice(idx, 1);
        paintSports(draft);
      });
    });
    const addBtn = card.querySelector('[data-div-add]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        readDivisionFields(card, sport);
        sport.divisions = sport.divisions || [];
        sport.divisions.push(blankDivision({
          name: 'Category ' + (sport.divisions.length + 1),
          open: false,
          maxPlayers: draft.format === 'individual' ? 1 : 2
        }));
        paintSports(draft);
      });
    }
  }

  function pointsEditorHtml(sport) {
    const p = tablePointsFor(sport);
    return `
      <div class="t-points-editor">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t-muted);">Table points</div>
        <div class="t-points-grid">
          <label>Win <input type="number" min="0" class="t-input" data-pts="win" value="${p.win}" /></label>
          <label>Draw <input type="number" min="0" class="t-input" data-pts="draw" value="${p.draw}" /></label>
          <label>No result <input type="number" min="0" class="t-input" data-pts="noResult" value="${p.noResult}" /></label>
        </div>
        <p class="t-mode-note">Win points go to the winner of a played match and to the team that shows up for a walkover. Draw points go to both teams. No result is when neither team shows up, so neither team receives points — keep that value at 0. Set Walkover Score on each bracket for the recorded match score, for example 15–0.</p>
      </div>
    `;
  }

  function stageListEditorHtml(sport) {
    const stages = stageListFor(sport);
    const rows = stages.map(function (st, i) {
      const builtin = !!BUILTIN_STAGE_IDS[st.id];
      return `
        <div class="t-stage-row" data-stage-id="${escapeHtml(st.id)}">
          <input type="text" class="t-input" data-stage-name value="${escapeHtml(st.name || '')}" />
          <button type="button" class="t-btn sm" data-stage-up ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="t-btn sm" data-stage-down ${i === stages.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="t-btn sm" data-stage-after>Add stage after</button>
          ${builtin ? '' : '<button type="button" class="t-btn danger sm" data-stage-remove>Remove</button>'}
        </div>
      `;
    }).join('');
    return `
      <div class="t-stage-list-editor">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t-muted);">Stages</div>
        <p class="t-mode-note">This order applies to every category in the sport. League, semifinal, and final are included. Add a stage between them, such as Round of 32 or Round of 16. On a category, skip any stage that category does not play. Advance on that category's overall ranking sends a team into the next stage it still uses, seeded by previous-stage rank (best remaining rank is Seed 1), and brackets there are built from those teams.</p>
        ${rows}
        <label style="display:inline-flex;align-items:center;gap:8px;color:var(--t-fg);font-weight:600;font-size:.9rem;">
          <input type="checkbox" data-field="hasThirdPlace" ${sport.hasThirdPlace !== false ? 'checked' : ''} />
          Include 3rd-place match
        </label>
      </div>
    `;
  }

  function readStageEditor(card, sport) {
    const rows = card.querySelectorAll('[data-stage-id]');
    if (!rows.length) return;
    sport.stageList = Array.prototype.map.call(rows, function (row) {
      const nameInput = row.querySelector('[data-stage-name]');
      return {
        id: row.getAttribute('data-stage-id'),
        name: (nameInput && nameInput.value.trim()) || stageLabelOf(sport, row.getAttribute('data-stage-id'))
      };
    });
  }

  function bindPointsAndStages(card, sport, draft) {
    card.querySelectorAll('[data-pts]').forEach(function (input) {
      input.addEventListener('input', function () {
        const key = input.getAttribute('data-pts');
        sport.tablePoints = tablePointsFor(sport);
        sport.tablePoints[key] = clampTablePoint(input.value, 0);
      });
    });
    card.querySelectorAll('[data-stage-name]').forEach(function (input) {
      input.addEventListener('input', function () { readStageEditor(card, sport); });
    });
    card.querySelectorAll('[data-stage-up]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        readStageEditor(card, sport);
        const id = btn.closest('[data-stage-id]').getAttribute('data-stage-id');
        const idx = sport.stageList.findIndex(function (s) { return s.id === id; });
        if (idx <= 0) return;
        const tmp = sport.stageList[idx - 1];
        sport.stageList[idx - 1] = sport.stageList[idx];
        sport.stageList[idx] = tmp;
        paintSports(draft);
      });
    });
    card.querySelectorAll('[data-stage-down]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        readStageEditor(card, sport);
        const id = btn.closest('[data-stage-id]').getAttribute('data-stage-id');
        const idx = sport.stageList.findIndex(function (s) { return s.id === id; });
        if (idx < 0 || idx >= sport.stageList.length - 1) return;
        const tmp = sport.stageList[idx + 1];
        sport.stageList[idx + 1] = sport.stageList[idx];
        sport.stageList[idx] = tmp;
        paintSports(draft);
      });
    });
    card.querySelectorAll('[data-stage-after]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        readStageEditor(card, sport);
        const id = btn.closest('[data-stage-id]').getAttribute('data-stage-id');
        const name = prompt('Name for the stage to insert after ' + stageLabelOf(sport, id), 'Round of 16');
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) return toast('A stage name is required', 'error');
        const stage = { id: newId('stg'), name: trimmed };
        const idx = sport.stageList.findIndex(function (s) { return s.id === id; });
        sport.stageList.splice(idx + 1, 0, stage);
        if (!sport.scoring) sport.scoring = defaultScoring(sport.kind);
        sport.scoring[stage.id] = Object.assign({}, sport.scoring.league || defaultScoring(sport.kind).league || {});
        paintSports(draft);
      });
    });
    card.querySelectorAll('[data-stage-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        readStageEditor(card, sport);
        const id = btn.closest('[data-stage-id]').getAttribute('data-stage-id');
        if (BUILTIN_STAGE_IDS[id]) return;
        const label = stageLabelOf(sport, id);
        if (!confirm('Remove ' + label + '? Brackets in that stage move back to League when you save.')) return;
        sport.stageList = sport.stageList.filter(function (s) { return s.id !== id; });
        paintSports(draft);
      });
    });
    const third = card.querySelector('[data-field="hasThirdPlace"]');
    if (third) {
      third.addEventListener('change', function () {
        readStageEditor(card, sport);
        sport.hasThirdPlace = this.checked;
        if (this.checked) {
          if (!sport.stageList.some(function (s) { return s.id === 'third_place'; })) {
            sport.stageList.push({ id: 'third_place', name: '3rd Place' });
          }
        } else {
          sport.stageList = sport.stageList.filter(function (s) { return s.id !== 'third_place'; });
        }
        paintSports(draft);
      });
    }
  }

  function buildStageConfig(sport, stage) {
    const cfg = sport.scoring[stage];
    const box = el('div', { class: 't-stage-config' });
    box.innerHTML = `<h4>${escapeHtml(stageLabelOf(sport, stage))}</h4>`;
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
    draft.published = !!(document.getElementById('tfPublished') && document.getElementById('tfPublished').checked);
    draft.revealLockedRosters = document.getElementById('tfRevealLocked').checked;
    const modeSel = document.getElementById('tfSportMode');
    if (modeSel) draft.sportMode = modeSel.value === 'multi' ? 'multi' : 'single';
    if (!draft.name) return toast('Tournament name is required', 'error');
    if (!draft.sports || !draft.sports.length) return toast('Add at least 1 sport', 'error');
    if (draft.sportMode === 'single' && draft.sports.length > 1) {
      return toast('Single sport tournaments can only include one sport. Switch to multi sport, or remove the extra sports.', 'error');
    }

    if (draft.format === 'teams') {
      // Every parish-group sport should have at least 2 teams before you can
      // meaningfully run a round-robin. Category sports register teams later.
      // Warn but don't block: admins might want to save the shell first.
      const missing = draft.sports.filter(function (s) {
        return !usesRegistrationCategories(s) && (!s.teams || s.teams.length < 2);
      });
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
          roster: Array.isArray(liveTeam.roster) ? liveTeam.roster : (tm.roster || []),
          here: !!liveTeam.here,
          hereAt: liveTeam.hereAt || tm.hereAt || null,
          hereBy: liveTeam.hereBy || tm.hereBy || null
        });
      });
      let divisions;
      if (s.categoryMode === 'open' || s.categoryMode === 'split') {
        ensureDivisionsForMode(s, s.categoryMode);
        divisions = mergeDivisionsForSave(s, liveSport);
      } else if (liveSport && Array.isArray(liveSport.divisions)) {
        divisions = liveSport.divisions;
      } else {
        divisions = Array.isArray(s.divisions) ? s.divisions : [];
      }
      ensureStageList(s);
      const stageIds = stageListFor(s).map(function (st) { return st.id; });
      return Object.assign({}, s, {
        teams: teams,
        categoryMode: s.categoryMode || '',
        divisions: remapBracketStages(divisions, stageIds),
        tablePoints: tablePointsFor(s),
        stageList: stageListFor(s),
        schedule: (liveSport && liveSport.schedule) ? liveSport.schedule : (s.schedule || null),
        maxRosterSize: parseMaxRosterSize(s.maxRosterSize)
      });
    });

    const payload = {
      name: draft.name,
      format: draft.format,
      sportMode: draft.sportMode === 'multi' ? 'multi' : 'single',
      // teams field is now per-sport; we explicitly clear the legacy
      // tournament-level field on every save.
      teams: FieldValue.delete(),
      sports: mergedSports,
      archived: !!draft.archived,
      published: !!draft.published,
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
        payload.published = false;
        payload.started = false;
        const ref = await db.collection('tournaments').add(payload);
        // Optimistically add to local state so navigate() doesn't beat the
        // onSnapshot delivery and render "Tournament not found".
        if (!state.tournaments.some(function (x) { return x.id === ref.id; })) {
          state.tournaments.push(Object.assign({ id: ref.id }, payload));
        }
        toast('Tournament created — unpublished until you publish it');
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

  function buildClonedTournament(src, newName) {
    const sports = (src.sports || []).map(function (s) {
      return {
        id: s.id,
        label: s.label,
        kind: s.kind,
        emoji: s.emoji,
        color: s.color,
        date: s.date || '',
        hasThirdPlace: s.hasThirdPlace !== false,
        categories: Array.isArray(s.categories) ? s.categories.slice() : [],
        categoryMode: s.categoryMode || '',
        divisions: (s.divisions || []).map(function (d) {
          const cloned = {
            id: d.id,
            name: d.name || (d.open ? 'Open' : 'Category'),
            open: !!d.open,
            maxPlayers: clampMaxPlayers(d.maxPlayers),
            teams: (d.teams || []).map(function (tm) {
              return {
                id: tm.id,
                name: tm.name || '',
                players: Array.isArray(tm.players) ? tm.players.slice() : [],
                tags: parseTeamTags(tm.tags)
              };
            }),
            skippedStages: skippedStageIds(d),
            advanced: advancedRecord(d),
            brackets: (d.brackets || []).map(function (b) {
              return {
                id: b.id,
                name: b.name || 'Bracket',
                stageId: b.stageId || 'league',
                teamIds: Array.isArray(b.teamIds) ? b.teamIds.slice() : [],
                walkoverPoints: walkoverScoreForBracket(s, b, b.stageId),
                walkoverScore: walkoverScoreForBracket(s, b, b.stageId)
              };
            })
          };
          return copyDivisionResultFields(d, cloned);
        }),
        tablePoints: tablePointsFor(s),
        stageList: stageListFor(s),
        scoring: s.scoring ? JSON.parse(JSON.stringify(s.scoring)) : defaultScoring(s.kind),
        maxRosterSize: parseMaxRosterSize(s.maxRosterSize),
        rules: s.rules ? JSON.parse(JSON.stringify(s.rules)) : null,
        teams: (s.teams || []).map(function (tm) {
          return { id: tm.id, name: tm.name || tm.id, wards: tm.wards || '', tags: parseTeamTags(tm.tags) };
        })
      };
    });
    return {
      name: newName,
      format: src.format || 'teams',
      sportMode: sportModeOf(src),
      sports: sports,
      rules: src.rules ? JSON.parse(JSON.stringify(src.rules)) : null,
      revealLockedRosters: !!src.revealLockedRosters,
      archived: false,
      published: false
    };
  }

  async function cloneTournament(src) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    if (typeof src === 'string') {
      src = state.tournaments.find(function (x) { return x.id === src; });
    }
    if (!src) return;
    const suggested = (src.name || 'Tournament') + ' (copy)';
    const name = prompt('Name for the cloned tournament', suggested);
    if (name == null) return;
    const trimmed = String(name).trim();
    if (!trimmed) return toast('A name is required', 'error');
    try {
      const payload = buildClonedTournament(src, trimmed);
      payload.createdAt = FieldValue.serverTimestamp();
      payload.updatedAt = FieldValue.serverTimestamp();
      payload.createdBy = (state.user && state.user.email) || '';
      payload.clonedFrom = src.id || '';
      const ref = await db.collection('tournaments').add(payload);
      if (!state.tournaments.some(function (x) { return x.id === ref.id; })) {
        state.tournaments.push(Object.assign({ id: ref.id }, payload));
      }
      toast('Cloned as "' + trimmed + '" — unpublished, no matches or schedule', 'success');
      navigate({ view: 'tournament', tournamentId: ref.id });
    } catch (err) {
      console.error(err);
      toast('Clone failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  async function setTournamentPublished(tournamentId, published) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const next = !!published;
    const ok = next
      ? confirm('Publish "' + t.name + '"? Signed-in members will be able to see it.')
      : confirm('Unpublish "' + t.name + '"? Members will no longer see it. Admins and lab users still can.' + (t.publicBoard ? ' The spectator link will stop working.' : ''));
    if (!ok) return;
    try {
      const patch = {
        published: next,
        publishedAt: next ? new Date().toISOString() : null,
        publishedBy: next ? ((state.user && (state.user.email || state.user.displayName)) || '') : '',
        updatedAt: FieldValue.serverTimestamp()
      };
      if (!next) patch.publicBoard = false;
      await db.collection('tournaments').doc(t.id).update(patch);
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) {
        state.tournaments[idx] = Object.assign({}, state.tournaments[idx], {
          published: next,
          publicBoard: next ? state.tournaments[idx].publicBoard : false
        });
      }
      if (!next) syncPublicBoardNow(t.id, { forceClose: true });
      toast(next ? 'Tournament published' : 'Tournament unpublished', 'success');
      render();
    } catch (err) {
      console.error(err);
      toast('Could not update publish state: ' + (err.message || err.code || 'unknown'), 'error');
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
    if (!isAdminUi()) return toast('Admin only', 'error');
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
      toast('Koinonia 2026 created — unpublished until you publish it');
      navigate({ view: 'tournament', tournamentId: ref.id });
    } catch (err) {
      console.error(err);
      toast('Seed failed: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function renderTournamentPublishBanner(t) {
    if (!t || isTournamentPublished(t)) return '';
    if (isAdminUi()) {
      return `
      <section class="t-section">
        <div class="t-card t-access-banner t-publish-banner">
          <div class="t-card-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:700;color:var(--t-fg);">Unpublished</div>
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Members cannot see this tournament yet. Publish it when you are ready. Admins and lab users can still open it.</div>
            </div>
            <button class="t-btn primary" type="button" onclick="window.__tournament.setTournamentPublished('${escapeHtml(t.id)}', true)">📢 Publish now</button>
          </div>
        </div>
      </section>`;
    }
    if (canSeeUnpublishedTournaments()) {
      return `
      <section class="t-section">
        <div class="t-card t-access-banner t-publish-banner">
          <div class="t-card-body">
            <div style="font-weight:700;color:var(--t-fg);">Unpublished lab tournament</div>
            <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Members will not see this until an admin publishes it.</div>
          </div>
        </div>
      </section>`;
    }
    return '';
  }

  function renderAccessBanner() {
    if (!isAdminUi()) return '';
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
              <div style="color:var(--t-muted);font-size:.88rem;margin-top:2px;">Lab users can open this page as members. Grant the lab-user role from Members &amp; Admins. Lab users see the member view (no admin tools). Open it to everyone when you are ready.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <a class="t-btn" href="admin-users.html">Manage lab users</a>
              <button class="t-btn primary" type="button" onclick="window.__tournament.setTournamentOpen(true)">Open to everyone</button>
            </div>
          </div>
        </div>
      </section>`;
  }

  function setTournamentOpen(open) {
    if (!isAdminUi()) return toast('Admin only', 'error');
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

  function looksLikeHtml(s) {
    return /<\/?[a-z][\s\S]*>/i.test(String(s || ''));
  }

  function sanitizeRulesHtml(html) {
    const allowed = {
      B: 1, STRONG: 1, I: 1, EM: 1, U: 1, UL: 1, OL: 1, LI: 1,
      BR: 1, P: 1, DIV: 1, SPAN: 1, MARK: 1
    };
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    function isUnsafeCss(raw) {
      return /url\(|expression|javascript/i.test(String(raw || ''));
    }

    function isBoldWeight(v) {
      const s = String(v || '').toLowerCase().trim();
      if (!s || s === 'normal' || s === 'lighter') return false;
      if (s === 'bold' || s === 'bolder') return true;
      const n = parseInt(s, 10);
      return n >= 600;
    }

    function hasUnderline(v) {
      return /underline/i.test(String(v || ''));
    }

    function wrapContents(el, tagName) {
      if (!el) return;
      if (el.childNodes.length === 1 && el.firstChild.nodeType === 1 && el.firstChild.tagName === tagName) return;
      const wrap = document.createElement(tagName);
      while (el.firstChild) wrap.appendChild(el.firstChild);
      el.appendChild(wrap);
    }

    function cleanStyle(el) {
      const st = el.style || {};
      const bg = st.backgroundColor || st.background;
      const bold = isBoldWeight(st.fontWeight);
      const underline = hasUnderline(st.textDecoration) || hasUnderline(st.textDecorationLine);
      el.removeAttribute('style');
      if (bg && !isUnsafeCss(bg)) el.style.backgroundColor = bg;
      if (bold) {
        el.style.fontWeight = '700';
        wrapContents(el, 'B');
      }
      if (underline) {
        el.style.textDecoration = 'underline';
        wrapContents(el, 'U');
      }
    }
    function walk(node) {
      const kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function (child) {
        if (child.nodeType === 3) return;
        if (child.nodeType !== 1) { child.parentNode.removeChild(child); return; }
        let el = child;
        if (el.tagName === 'FONT') {
          const span = document.createElement('span');
          const bg = (el.style && (el.style.backgroundColor || el.style.background)) || el.getAttribute('bgcolor') || '';
          const bold = isBoldWeight(el.style && el.style.fontWeight) || String(el.getAttribute('weight') || '') === 'bold';
          const underline = hasUnderline(el.style && el.style.textDecoration);
          while (el.firstChild) span.appendChild(el.firstChild);
          el.parentNode.replaceChild(span, el);
          if (bg && !isUnsafeCss(bg)) span.style.backgroundColor = bg;
          if (bold) span.style.fontWeight = '700';
          if (underline) span.style.textDecoration = 'underline';
          el = span;
        }
        const tag = el.tagName;
        if (!allowed[tag]) {
          const ref = el.nextSibling;
          const holder = document.createElement('div');
          while (el.firstChild) holder.appendChild(el.firstChild);
          el.parentNode.removeChild(el);
          walk(holder);
          while (holder.firstChild) node.insertBefore(holder.firstChild, ref);
          return;
        }
        const attrs = Array.prototype.slice.call(el.attributes || []);
        attrs.forEach(function (a) {
          if (a.name.toLowerCase() === 'style' && (tag === 'SPAN' || tag === 'MARK')) {
            cleanStyle(el);
          } else {
            el.removeAttribute(a.name);
          }
        });
        walk(el);
      });
    }
    walk(wrap);
    return wrap.innerHTML;
  }

  function rulesToDisplayHtml(text) {
    const raw = String(text || '');
    if (!raw.trim()) return '';
    if (looksLikeHtml(raw)) return sanitizeRulesHtml(raw);
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }

  function formatRulesHtml(text) {
    const html = rulesToDisplayHtml(text);
    if (!String(html).trim()) return '<p class="t-empty">No rules posted yet.</p>';
    return '<div class="t-rules-text">' + html + '</div>';
  }

  function readRulesEditor(editorId) {
    const box = document.getElementById(editorId);
    if (!box) return '';
    return sanitizeRulesHtml(box.innerHTML || '');
  }

  function formatRules(editorId, cmd) {
    const box = document.getElementById(editorId);
    if (!box) return;
    box.focus();
    try {
      if (cmd === 'highlight') {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('hiliteColor', false, '#fde047');
        document.execCommand('backColor', false, '#fde047');
      } else {
        // Bold/underline must be real <b>/<u> tags. styleWithCSS would wrap
        // them as <span style="font-weight/text-decoration">, which used to
        // get stripped on save because only highlight color was kept.
        document.execCommand('styleWithCSS', false, false);
        document.execCommand(cmd, false, null);
      }
    } catch (_) {}
  }

  function rulesToolbarHtml(editorId) {
    const id = escapeHtml(editorId);
    return `
      <div class="t-rules-toolbar">
        <button type="button" class="t-btn sm" title="Bold" onmousedown="event.preventDefault()" onclick="window.__tournament.formatRules('${id}','bold')"><b>B</b></button>
        <button type="button" class="t-btn sm" title="Underline" onmousedown="event.preventDefault()" onclick="window.__tournament.formatRules('${id}','underline')"><u>U</u></button>
        <button type="button" class="t-btn sm" title="Highlight" onmousedown="event.preventDefault()" onclick="window.__tournament.formatRules('${id}','highlight')" style="background:#fde047;">Highlight</button>
        <button type="button" class="t-btn sm" title="Bulleted list" onmousedown="event.preventDefault()" onclick="window.__tournament.formatRules('${id}','insertUnorderedList')">• List</button>
      </div>`;
  }

  function renderRulesCard(opts) {
    const text = opts.text || '';
    if (!isAdminUi() && !String(text).trim()) return '';
    const title = escapeHtml(opts.title || 'Rules');
    const subtitle = escapeHtml(opts.subtitle || '');
    const editorId = escapeHtml(opts.textareaId);
    if (isAdminUi()) {
      return `
      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">${title}${subtitle ? ' <small>' + subtitle + '</small>' : ''}</h2>
          <button class="t-btn sm primary" type="button" onclick="window.__tournament.${opts.saveCall}">Save rules</button>
        </div>
        <div class="t-card"><div class="t-card-body">
          ${rulesToolbarHtml(opts.textareaId)}
          <div class="t-rules-editor" id="${editorId}" contenteditable="true" data-placeholder="${escapeHtml(opts.placeholder || '')}">${rulesToDisplayHtml(text)}</div>
          <div class="t-schedule-note" style="margin-top:8px;">Select text, then Bold, Underline, Highlight, or List. Only admins can edit.</div>
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
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const rules = {
      text: readRulesEditor('tTournamentRules'),
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

  async function saveSportRules(tournamentId, sportId, editorId) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const rules = {
      text: readRulesEditor(editorId || 'tSportRules'),
      updatedAt: new Date().toISOString(),
      updatedBy: (state.user && (state.user.email || state.user.displayName)) || ''
    };
    try {
      await writeSportPatch(t, sportId, { rules: rules });
      toast((sport.label || 'Sport') + ' rules saved', 'success');
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  async function saveMaxRosterSize(tournamentId, sportId) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const sport = getSportConfig(t, sportId);
    if (!sport) return;
    const box = document.getElementById('tMaxRosterSize');
    const next = parseMaxRosterSize(box ? box.value : sport.maxRosterSize);
    try {
      await writeSportPatch(t, sportId, { maxRosterSize: next });
      toast(next
        ? (sport.label || 'Sport') + ' max roster size set to ' + next + ' per team'
        : (sport.label || 'Sport') + ' roster size limit removed', 'success');
      render();
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  window.__tournament.seedKoinonia = seedKoinonia;
  window.__tournament.cloneTournament = cloneTournament;
  window.__tournament.setTournamentPublished = setTournamentPublished;
  window.__tournament.setTournamentOpen = setTournamentOpen;
  window.__tournament.openCaptainPicker = openCaptainPicker;
  window.__tournament.openRoster = openRoster;
  window.__tournament.openMemberPicker = openMemberPicker;
  window.__tournament.setRosterLock = setRosterLock;
  window.__tournament.setTeamHere = setTeamHere;
  window.__tournament.addScheduleRow = addScheduleRow;
  window.__tournament.removeScheduleRow = removeScheduleRow;
  window.__tournament.generateLeagueSchedule = generateLeagueSchedule;
  window.__tournament.promptRoundRobin = promptRoundRobin;
  window.__tournament.saveScheduleDraft = saveScheduleDraft;
  window.__tournament.publishSchedule = publishSchedule;
  window.__tournament.clearSchedule = clearSchedule;
  window.__tournament.setSportMode = setSportMode;
  window.__tournament.setTournamentStarted = setTournamentStarted;
  window.__tournament.openTournamentScorers = openTournamentScorers;
  window.__tournament.shareLiveBoard = shareLiveBoard;
  window.__tournament.stopLiveBoard = stopLiveBoard;
  window.__tournament.copySpectatorLink = copySpectatorLink;
  window.__tournament.openEntryTeam = openEntryTeam;
  window.__tournament.saveTournamentRules = saveTournamentRules;
  window.__tournament.saveSportRules = saveSportRules;
  window.__tournament.saveMaxRosterSize = saveMaxRosterSize;
  window.__tournament.formatRules = formatRules;
  window.__tournament.setAdminUi = setAdminUi;

  // ═══════════════════════════════════════════════════════════════════════════
  // TOURNAMENT VIEW
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTournamentViewTabs(tournament, panel) {
    const tabs = [
      { id: 'summary', label: 'Summary', icon: '📋' },
      { id: 'rules', label: 'Rules', icon: '📖' },
      { id: 'matches', label: 'All Matches', icon: '🏆' }
    ];
    return `<nav class="t-tabs t-view-tabs" aria-label="Tournament views">${tabs.map(function (tab) {
      return `<button type="button" class="t-tab ${panel === tab.id ? 'active' : ''}" aria-current="${panel === tab.id ? 'page' : 'false'}" onclick="window.__tournament.navigate({view:'tournament',tournamentId:'${escapeHtml(tournament.id)}',panel:'${tab.id}'})">${tab.icon} ${tab.label}</button>`;
    }).join('')}</nav>`;
  }

  function renderTournamentRulesPanel(tournament) {
    const cards = [];
    if (isMultiSportTournament(tournament)) {
      cards.push(renderRulesCard({
        title: 'Tournament rules',
        subtitle: 'applies to every sport',
        text: rulesText(tournament.rules),
        textareaId: 'tTournamentRules',
        placeholder: 'Eligibility, conduct, scoring notes, prize rules…',
        saveCall: "saveTournamentRules('" + tournament.id + "')"
      }));
    }
    (tournament.sports || []).forEach(function (sport, index) {
      const editorId = 'tSportRules-' + (slugify(sport.id) || index);
      cards.push(renderRulesCard({
        title: (sport.label || 'Sport') + ' rules',
        subtitle: 'this sport only',
        text: rulesText(sport.rules),
        textareaId: editorId,
        placeholder: 'Format, scoring, substitutions, court rules for this sport…',
        saveCall: "saveSportRules('" + tournament.id + "','" + sport.id + "','" + editorId + "')"
      }));
    });
    const visibleCards = cards.filter(Boolean).join('');
    return visibleCards || `
      <section class="t-section">
        <div class="t-empty">No rules have been posted yet.</div>
      </section>`;
  }

  function renderAllMatchesPanel(tournament) {
    const root = document.getElementById('tAllMatchesRoot');
    if (!root) return;
    root.innerHTML = '';
    let total = 0;

    (tournament.sports || []).forEach(function (sport) {
      const matches = visibleMatchesFor(tournament, sport.id);
      if (!matches.length) return;
      total += matches.length;

      const section = el('section', { class: 't-section' });
      section.innerHTML = `
        <div class="t-section-header">
          <h2 class="t-section-title">${sport.emoji || '🏅'} ${escapeHtml(sport.label || 'Sport')} <small>${matches.length} match${matches.length === 1 ? '' : 'es'}</small></h2>
        </div>
      `;
      const groups = [
        {
          title: 'Live now',
          matches: matches.filter(function (m) { return m.status === 'in_progress'; }).sort(sortMatches)
        },
        {
          title: 'Scheduled',
          matches: matches.filter(function (m) { return m.status === 'scheduled'; }).sort(sortMatches)
        },
        {
          title: 'Completed',
          matches: matches.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse(),
          compact: true
        }
      ];

      groups.forEach(function (group) {
        if (!group.matches.length) return;
        const heading = el('h3', { class: 't-stage-standing-title' });
        heading.textContent = group.title;
        section.appendChild(heading);
        const list = el('div', { class: 't-match-list' });
        group.matches.forEach(function (match) {
          list.appendChild(matchWithActions(match, tournament, {
            canEdit: isAdminUi(),
            compact: !!group.compact
          }));
        });
        section.appendChild(list);
      });
      root.appendChild(section);
    });

    if (!total) {
      root.innerHTML = '<section class="t-section"><div class="t-empty">No matches have been added yet.</div></section>';
    }
  }

  function decisiveResult(match, tournament) {
    const kind = resultKind(match);
    if (kind !== 'win' && kind !== 'walkover') return null;
    if (!match || (match.winner !== 'A' && match.winner !== 'B')) return null;
    const people = participantsOf(match, tournament);
    if (!people.a || !people.b) return null;
    return match.winner === 'A'
      ? { winnerId: people.a, loserId: people.b }
      : { winnerId: people.b, loserId: people.a };
  }

  function mainStagesFor(sport, division) {
    const stages = division ? categoryStages(sport, division) : stageListFor(sport);
    return stages.filter(function (st) { return st.id !== 'third_place'; });
  }

  function championshipStage(sport, division) {
    const main = mainStagesFor(sport, division);
    return main.length ? main[main.length - 1] : null;
  }

  function sportMatchPool(tournament, sportId) {
    if (tournament && Array.isArray(tournament.matches)) {
      return tournament.matches.filter(function (match) {
        return !sportId || match.sport === sportId;
      });
    }
    return visibleMatchesFor(tournament, sportId);
  }

  function matchesForPlacement(tournament, sport, division, stageId) {
    return sportMatchPool(tournament, sport.id).filter(function (match) {
      if ((match.stage || 'league') !== stageId) return false;
      if (division) return match.categoryId === division.id;
      return !match.categoryId && !match.bracketId;
    });
  }

  // A stage is finished only when a win or walkover has been recorded and
  // nothing in that stage is still scheduled or live. Marking a bracket
  // complete does not invent a winner when no match was scored.
  function stageIsFinished(tournament, sport, division, stageId) {
    const matches = matchesForPlacement(tournament, sport, division, stageId);
    if (matches.some(function (match) {
      return match.status === 'scheduled' || match.status === 'in_progress';
    })) return false;
    if (!matches.some(function (match) { return !!decisiveResult(match, tournament); })) return false;
    if (!division) return true;
    const brackets = bracketsInStage(division, stageId).filter(bracketHasTeams);
    if (!brackets.length) return true;
    return brackets.every(function (bracket) {
      if (bracketIsComplete(bracket)) return true;
      const own = matches.filter(function (match) { return match.bracketId === bracket.id; });
      if (!own.length) return false;
      return own.every(function (match) { return match.status === 'completed'; });
    });
  }

  function scoringResults(matches) {
    return (matches || []).filter(function (match) {
      const kind = resultKind(match);
      return kind === 'win' || kind === 'walkover' || kind === 'draw';
    });
  }

  function isKnockoutDecider(matches, tournament) {
    const decisive = (matches || []).filter(function (match) { return !!decisiveResult(match, tournament); });
    return decisive.length === 1 && scoringResults(matches).length === 1;
  }

  function participantIdsIn(matches, tournament) {
    const ids = [];
    (matches || []).forEach(function (match) {
      if (match.status !== 'completed') return;
      const people = participantsOf(match, tournament);
      [people.a, people.b].forEach(function (id) {
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return ids;
  }

  function rawRowsForStage(tournament, sport, division, stageId, visible) {
    const ids = participantIdsIn(matchesForPlacement(tournament, sport, division, stageId), tournament);
    if (!ids.length) return [];
    const scope = { stageId: stageId, teamIds: ids };
    if (division) scope.categoryId = division.id;
    return computeStandings(tournament, visible, sport.id, scope);
  }

  function earlierRankLookups(tournament, sport, division, beforeStageId, visible) {
    const main = mainStagesFor(sport, division);
    const idx = main.findIndex(function (st) { return st.id === beforeStageId; });
    const prior = idx > 0 ? main.slice(0, idx).reverse() : [];
    return prior.map(function (st) {
      const rank = {};
      rawRowsForStage(tournament, sport, division, st.id, visible).forEach(function (row, index) {
        if (row.played > 0) rank[row.id] = index;
      });
      return function (id) {
        return Object.prototype.hasOwnProperty.call(rank, id) ? rank[id] : null;
      };
    });
  }

  function orderedRowsForStage(tournament, sport, division, stageId, visible) {
    const rows = rawRowsForStage(tournament, sport, division, stageId, visible).filter(function (row) {
      return row.played > 0;
    });
    const lookups = earlierRankLookups(tournament, sport, division, stageId, visible);
    rows.sort(function (x, y) {
      if (y.points !== x.points) return y.points - x.points;
      if (x.h2h[y.id] === 'W' && y.h2h[x.id] !== 'W') return -1;
      if (y.h2h[x.id] === 'W' && x.h2h[y.id] !== 'W') return 1;
      for (let i = 0; i < lookups.length; i++) {
        const rankX = lookups[i](x.id);
        const rankY = lookups[i](y.id);
        if (rankX != null && rankY != null && rankX !== rankY) return rankX - rankY;
        if (rankX != null && rankY == null) return -1;
        if (rankY != null && rankX == null) return 1;
      }
      return String(x.id).localeCompare(String(y.id));
    });
    return rows;
  }

  function pushPlace(list, id) {
    if (!id || list.indexOf(id) !== -1) return;
    list.push(id);
  }

  function firstDecisive(matches, tournament) {
    for (let i = 0; i < (matches || []).length; i++) {
      const decided = decisiveResult(matches[i], tournament);
      if (decided) return decided;
    }
    return null;
  }

  function categoryPlaceIdsFromDecider(tournament, sport, division) {
    const champ = championshipStage(sport, division);
    if (!champ) return null;
    const completed = matchesForPlacement(tournament, sport, division, champ.id)
      .filter(function (match) { return match.status === 'completed'; });
    if (!isKnockoutDecider(completed, tournament)) return null;
    const decided = firstDecisive(completed, tournament);
    if (!decided) return null;
    const ids = [];
    pushPlace(ids, decided.winnerId);
    pushPlace(ids, decided.loserId);
    return ids.length ? ids : null;
  }

  function categoryRankingPlaceIds(tournament, sport, division) {
    const champ = championshipStage(sport, division);
    if (!champ || !division) return [];
    const edited = rankingIdsForStage(division, champ.id);
    if (edited.length) return edited;
    const brackets = bracketsInStage(division, champ.id).filter(bracketHasTeams);
    if (!brackets.length || !brackets.every(bracketIsComplete)) return [];
    return computeStageRanking(tournament, sportMatchPool(tournament, sport.id), sport, division, champ.id)
      .filter(function (row) { return (row.played || 0) > 0; })
      .map(function (row) { return row.id; });
  }

  function categoryPlaceIdsFromResults(tournament, sport, division) {
    const champ = championshipStage(sport, division);
    if (!champ || !stageIsFinished(tournament, sport, division, champ.id)) return null;
    const visible = sportMatchPool(tournament, sport.id);
    const matches = matchesForPlacement(tournament, sport, division, champ.id);
    const placed = [];
    if (isKnockoutDecider(matches, tournament)) {
      const decided = firstDecisive(matches, tournament);
      pushPlace(placed, decided.winnerId);
      pushPlace(placed, decided.loserId);
      const stages = division ? categoryStages(sport, division) : stageListFor(sport);
      const third = stages.find(function (st) { return st.id === 'third_place'; }) || null;
      if (third && stageIsFinished(tournament, sport, division, third.id)) {
        const thirdMatches = matchesForPlacement(tournament, sport, division, third.id);
        if (isKnockoutDecider(thirdMatches, tournament)) {
          const thirdDecided = firstDecisive(thirdMatches, tournament);
          pushPlace(placed, thirdDecided.winnerId);
          pushPlace(placed, thirdDecided.loserId);
        } else {
          orderedRowsForStage(tournament, sport, division, third.id, visible).forEach(function (row) {
            pushPlace(placed, row.id);
          });
        }
      }
      const main = mainStagesFor(sport, division);
      for (let i = main.length - 2; i >= 0; i--) {
        orderedRowsForStage(tournament, sport, division, main[i].id, visible).forEach(function (row) {
          pushPlace(placed, row.id);
        });
      }
    } else {
      orderedRowsForStage(tournament, sport, division, champ.id, visible).forEach(function (row) {
        pushPlace(placed, row.id);
      });
    }
    const pool = division ? ((division && division.teams) || []) : teamsFor(tournament, sport);
    const main = mainStagesFor(sport, division);
    const entry = main[0];
    const entryIds = pool.map(function (team) { return team && team.id; }).filter(Boolean);
    const entryRank = {};
    if (entry && entryIds.length) {
      const scope = { stageId: entry.id, teamIds: entryIds };
      if (division) scope.categoryId = division.id;
      computeStandings(tournament, visible, sport.id, scope).forEach(function (row, index) {
        entryRank[row.id] = index;
      });
    }
    const rest = pool.filter(function (team) { return team && team.id && placed.indexOf(team.id) === -1; });
    rest.sort(function (a, b) {
      const rankA = Object.prototype.hasOwnProperty.call(entryRank, a.id) ? entryRank[a.id] : null;
      const rankB = Object.prototype.hasOwnProperty.call(entryRank, b.id) ? entryRank[b.id] : null;
      if (rankA != null && rankB != null && rankA !== rankB) return rankA - rankB;
      if (rankA != null && rankB == null) return -1;
      if (rankB != null && rankA == null) return 1;
      return displayName(tournament, sport.id, a.id).localeCompare(displayName(tournament, sport.id, b.id));
    });
    rest.forEach(function (team) { pushPlace(placed, team.id); });
    return placed.length ? placed : null;
  }

  function categoryPlaceIds(tournament, sport, division) {
    const override = placesOverride(division);
    const auto = categoryPlaceIdsFromResults(tournament, sport, division);
    const decider = categoryPlaceIdsFromDecider(tournament, sport, division);
    const ranked = categoryRankingPlaceIds(tournament, sport, division);
    if (!override.length && !auto && !decider && !ranked.length) return null;
    const placed = [];
    override.forEach(function (id) { pushPlace(placed, id); });
    if (auto) auto.forEach(function (id) { pushPlace(placed, id); });
    else if (decider) decider.forEach(function (id) { pushPlace(placed, id); });
    ranked.forEach(function (id) { pushPlace(placed, id); });
    return placed.length ? placed : null;
  }

  let podiumSvgSeq = 0;

  function championTrophySvg() {
    podiumSvgSeq += 1;
    const id = 'podiumGold' + podiumSvgSeq;
    return `
      <svg class="t-podium-icon" viewBox="0 0 80 80" role="img" aria-label="Champion trophy">
        <defs>
          <linearGradient id="${id}" x1="18" y1="8" x2="62" y2="72" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#fff6cc"/>
            <stop offset="0.42" stop-color="#f6c445"/>
            <stop offset="1" stop-color="#c8890a"/>
          </linearGradient>
          <linearGradient id="${id}d" x1="20" y1="48" x2="60" y2="74" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#e6b325"/>
            <stop offset="1" stop-color="#8a5a08"/>
          </linearGradient>
        </defs>
        <path d="M22 26c-12 1-16 12-11 18 4 5 12 5 15 1" fill="none" stroke="url(#${id})" stroke-width="4" stroke-linecap="round"/>
        <path d="M58 26c12 1 16 12 11 18-4 5-12 5-15 1" fill="none" stroke="url(#${id})" stroke-width="4" stroke-linecap="round"/>
        <path d="M24 16h32c0 18-5 30-16 34C29 46 24 34 24 16z" fill="url(#${id})"/>
        <ellipse cx="40" cy="16" rx="16" ry="5" fill="#ffe89a"/>
        <path d="M40 24.5l2.1 4.3 4.7.7-3.4 3.3.8 4.7L40 35.3l-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z" fill="#fff8e6"/>
        <rect x="36" y="50" width="8" height="9" rx="2" fill="url(#${id}d)"/>
        <rect x="27" y="59" width="26" height="5" rx="2" fill="url(#${id})"/>
        <rect x="22" y="65" width="36" height="6" rx="2.5" fill="url(#${id}d)"/>
      </svg>
    `;
  }

  function runnerMedalSvg() {
    podiumSvgSeq += 1;
    const id = 'podiumSilver' + podiumSvgSeq;
    return `
      <svg class="t-podium-icon" viewBox="0 0 80 80" role="img" aria-label="Runner-up medal">
        <defs>
          <linearGradient id="${id}" x1="22" y1="30" x2="60" y2="74" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#ffffff"/>
            <stop offset="0.45" stop-color="#d7dee8"/>
            <stop offset="1" stop-color="#8e9aab"/>
          </linearGradient>
        </defs>
        <path d="M27 6h12l7 26H33z" fill="#dc2626"/>
        <path d="M41 6h12l-7 26H34z" fill="#fb7185"/>
        <circle cx="40" cy="50" r="20" fill="url(#${id})" stroke="#64748b" stroke-width="1.5"/>
        <circle cx="40" cy="50" r="14" fill="none" stroke="#f8fafc" stroke-width="2"/>
        <text x="40" y="56" text-anchor="middle" font-size="18" font-family="Barlow Condensed, sans-serif" font-weight="700" fill="#334155">2</text>
      </svg>
    `;
  }

  function placeLabel(rank) {
    const mod100 = rank % 100;
    if (mod100 >= 11 && mod100 <= 13) return rank + 'th';
    const mod10 = rank % 10;
    if (mod10 === 1) return rank + 'st';
    if (mod10 === 2) return rank + 'nd';
    if (mod10 === 3) return rank + 'rd';
    return rank + 'th';
  }

  function podiumBlocks(tournament, sport) {
    if (!sport) return [];
    if (usesRegistrationCategories(sport)) {
      return (sport.divisions || []).map(function (division) {
        const ids = categoryPlaceIds(tournament, sport, division);
        if (!ids) return null;
        const champ = championshipStage(sport, division);
        return {
          key: division.id,
          title: division.name || 'Category',
          stageName: champ ? (champ.name || stageLabelOf(sport, champ.id)) : '',
          ids: ids
        };
      }).filter(Boolean);
    }
    const ids = categoryPlaceIds(tournament, sport, null);
    if (!ids) return [];
    const champ = championshipStage(sport, null);
    return [{
      key: sport.id,
      title: sport.label || 'Sport',
      stageName: champ ? (champ.name || stageLabelOf(sport, champ.id)) : '',
      ids: ids
    }];
  }

  function podiumPlayerNames(tournament, sportId, teamId) {
    const found = findEntryTeam(tournament, sportId, teamId);
    if (!found || !found.team) return [];
    const listed = ((found.team.players) || []).map(function (name) {
      return String(name || '').trim();
    }).filter(Boolean);
    if (listed.length) return listed;
    return teamMembers(found.team).map(function (member) {
      return [member.firstName, member.middleName, member.lastName].filter(Boolean).join(' ').trim()
        || String(member.name || '').trim();
    }).filter(Boolean);
  }

  function podiumPlayersHtml(tournament, sportId, teamId) {
    const names = podiumPlayerNames(tournament, sportId, teamId);
    if (!names.length) return '';
    return '<b class="t-podium-players">' + names.map(escapeHtml).join(', ') + '</b>';
  }

  function podiumBlockHtml(tournament, sport, block, opts) {
    const ids = block.ids || [];
    const champion = ids[0] ? teamMeta(tournament, sport.id, ids[0]) : null;
    const runner = ids[1] ? teamMeta(tournament, sport.id, ids[1]) : null;
    const rest = (opts && opts.topOnly) ? '' : ids.slice(2).map(function (id, index) {
      const meta = teamMeta(tournament, sport.id, id);
      const rank = index + 3;
      return `
        <li>
          <span class="t-place-rank">${placeLabel(rank)}</span>
          <span class="t-place-team">
            <span class="t-place-name">${escapeHtml(meta.name)}</span>
            ${podiumPlayersHtml(tournament, sport.id, id)}
          </span>
        </li>
      `;
    }).join('');
    return `
      <article class="t-podium" data-category="${escapeHtml(block.key || '')}">
        <h3 class="t-podium-title">${escapeHtml(block.title)}${block.stageName ? '<small>' + escapeHtml(block.stageName) + '</small>' : ''}</h3>
        <div class="t-podium-top">
          ${champion ? `
            <div class="t-podium-card is-champion" data-place="1" data-team="${escapeHtml(champion.id)}">
              ${championTrophySvg()}
              <div class="t-podium-place">Champion</div>
              <div class="t-podium-name">${escapeHtml(champion.name)}</div>
              ${podiumPlayersHtml(tournament, sport.id, champion.id)}
            </div>
          ` : ''}
          ${runner ? `
            <div class="t-podium-card is-runner" data-place="2" data-team="${escapeHtml(runner.id)}">
              ${runnerMedalSvg()}
              <div class="t-podium-place">Runner-up</div>
              <div class="t-podium-name">${escapeHtml(runner.name)}</div>
              ${podiumPlayersHtml(tournament, sport.id, runner.id)}
            </div>
          ` : ''}
        </div>
        ${rest ? '<ol class="t-place-list">' + rest + '</ol>' : ''}
      </article>
    `;
  }

  function renderSummaryPodium(tournament, sport) {
    const root = document.getElementById('tSummaryPodium');
    if (!root || !sport) return;
    const section = document.getElementById('tSummaryPodiumSection');
    const blocks = podiumBlocks(tournament, sport);
    if (!blocks.length) {
      root.innerHTML = '';
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = '';
    root.innerHTML = '<div class="t-podium-grid">' + blocks.map(function (block) {
      return podiumBlockHtml(tournament, sport, block, { topOnly: true });
    }).join('') + '</div>';
  }

  function renderSummaryCurrentMatches(tournament, sport) {
    const list = document.getElementById('tSummaryCurrentMatches');
    if (!list || !sport) return;
    const current = visibleMatchesFor(tournament, sport.id)
      .filter(function (match) { return match.status === 'in_progress'; })
      .sort(sortMatches);
    list.innerHTML = '';
    if (!current.length) {
      list.innerHTML = '<div class="t-empty">No matches are currently in progress.</div>';
      return;
    }
    current.forEach(function (match) {
      list.appendChild(matchWithActions(match, tournament, { canEdit: isAdminUi() }));
    });
  }

  function matchBracketName(tournament, match) {
    const sport = getSportConfig(tournament, match && match.sport);
    const division = findDivision(sport, match && match.categoryId);
    const bracket = findBracket(division, match && match.bracketId);
    return (bracket && bracket.name) || '';
  }

  function renderSummaryUpcoming(tournament, sport) {
    const root = document.getElementById('tSummaryUpcoming');
    if (!root || !sport) return;
    const split = sport.categoryMode === 'split';
    const rows = visibleMatchesFor(tournament, sport.id).filter(function (match) {
      if (match.status !== 'scheduled' || !match.showUpcoming) return false;
      if (usesRegistrationCategories(sport) && !match.categoryId) return false;
      return categoryMatchVisible(sport, match);
    }).sort(sortMatches);
    if (!rows.length) {
      root.innerHTML = '<p class="t-empty">No upcoming matches yet. Publish a bracket schedule and mark the fixtures you want listed here.</p>';
      return;
    }
    root.innerHTML = `
      <div class="t-schedule-wrap"><table class="t-schedule-table t-summary-upcoming">
        <thead><tr>
          ${split ? '<th>Category</th>' : ''}
          <th>Bracket</th>
          <th>Stage</th>
          <th>Match</th>
          <th>When</th>
          <th>Court</th>
        </tr></thead>
        <tbody>
          ${rows.map(function (match) {
            const division = findDivision(sport, match.categoryId);
            const people = participantsOf(match, tournament);
            const bracketName = matchBracketName(tournament, match) || '—';
            return `
              <tr>
                ${split ? '<td>' + escapeHtml((division && division.name) || 'Category') + '</td>' : ''}
                <td>${escapeHtml(bracketName)}</td>
                <td>${escapeHtml(stageLabelOf(sport, match.stage))}</td>
                <td class="t-schedule-vs"><b>${escapeHtml(displayName(tournament, sport.id, people.a))}</b> <span>vs</span> <b>${escapeHtml(displayName(tournament, sport.id, people.b))}</b></td>
                <td>${match.scheduledAt ? escapeHtml(fmtDateTime(match.scheduledAt)) : '—'}</td>
                <td>${courtOf(match) ? escapeHtml(courtOf(match)) : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table></div>
    `;
  }

  function renderTournament() {
    ensureScorerDirectoryThenRender();
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
    if (unpublishedAccessPending(t)) {
      document.getElementById('tContent').innerHTML = '<div class="t-empty">Loading tournament…</div>';
      return;
    }
    if (!canOpenTournament(t)) {
      toast('This tournament is not published yet', 'error');
      navigate({ view: 'list' }, { replace: true });
      return;
    }
    document.title = t.name + ' — Church Tournament';
    const panel = parsed.panel;

    // Pick active sport
    let sportId = parsed.sportId;
    if (!sportId || !getSportConfig(t, sportId)) sportId = (t.sports && t.sports[0] && t.sports[0].id) || null;
    const sport = getSportConfig(t, sportId);
    const categorized = !!(sport && usesRegistrationCategories(sport));

    const container = document.getElementById('tContent');
    const tabsHtml = (t.sports || []).map(function (s) {
      const count = visibleMatchesFor(t, s.id).length;
      return `<button class="t-tab ${s.id === sportId ? 'active' : ''}" style="--sport-color:${s.color || 'var(--t-primary)'}" onclick="window.__tournament.navigate({view:'tournament',tournamentId:'${t.id}',sportId:'${s.id}'})">${s.emoji || '🏅'} ${escapeHtml(s.label)}${count ? '<span class="count">' + count + '</span>' : ''}</button>`;
    }).join('');

    container.innerHTML = `
      <section class="t-hero" style="--hero-a:${sport ? sport.color : '#3b82f6'};--hero-b:#1e293b;">
        <div>
          <h1>${escapeHtml(t.name)} <small style="opacity:.9;font-family:'Outfit',sans-serif;font-weight:500;font-size:.6em;letter-spacing:normal;text-transform:none;">${isMultiSportTournament(t) ? 'Multi sport' : 'Single sport'} · ${t.format === 'individual' ? 'Individual / Doubles' : 'Team-based'}${tournamentHasStarted(t) ? ' · Started' : ''}${isTournamentPublished(t) ? '' : ' · Unpublished'}</small></h1>
          <p>${sport ? (sport.emoji || '🏅') + ' ' + escapeHtml(sport.label) + (sport.date ? ' · ' + fmtDate(sport.date) : '') : 'Configure sports for this tournament'}</p>
        </div>
        <div class="t-emoji">${sport ? (sport.emoji || '🏆') : '🏆'}</div>
      </section>

      ${renderAccessBanner()}
      ${renderTournamentPublishBanner(t)}

      ${renderTournamentViewTabs(t, panel)}

      ${isAdminUi() ? `
      <section class="t-section" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="t-btn" type="button" onclick="window.__tournament.cloneTournament('${escapeHtml(t.id)}')">📄 Clone</button>
        ${isMultiSportTournament(t)
          ? ''
          : `<button class="t-btn" type="button" onclick="window.__tournament.setSportMode('${escapeHtml(t.id)}','multi')">⇄ Make multi sport</button>`}
        ${tournamentHasStarted(t)
          ? `<button class="t-btn" type="button" onclick="window.__tournament.setTournamentStarted('${escapeHtml(t.id)}', false)">⏸ Mark not started</button>`
          : `<button class="t-btn primary" type="button" onclick="window.__tournament.setTournamentStarted('${escapeHtml(t.id)}', true)">▶ Start tournament</button>`}
        <button class="t-btn ${(t.scorers || []).length ? '' : 'primary'}" type="button" onclick="window.__tournament.openTournamentScorers('${escapeHtml(t.id)}')">🧑‍⚖️ Tournament scorers (${(t.scorers || []).length})</button>
        <button class="t-btn" type="button" onclick="window.__tournament.shareLiveBoard('${escapeHtml(t.id)}')">${t.publicBoard ? '📺 Spectator link on' : '📺 Spectator link'}</button>
        ${t.publicBoard ? `<button class="t-btn danger" type="button" onclick="window.__tournament.stopLiveBoard('${escapeHtml(t.id)}')">Disable spectator link</button>` : ''}
        ${isTournamentPublished(t)
          ? `<button class="t-btn" type="button" onclick="window.__tournament.setTournamentPublished('${escapeHtml(t.id)}', false)">🙈 Unpublish</button>`
          : `<button class="t-btn primary" type="button" onclick="window.__tournament.setTournamentPublished('${escapeHtml(t.id)}', true)">📢 Publish</button>`}
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

      ${panel === 'rules' ? renderTournamentRulesPanel(t) : ''}

      ${panel === 'matches' ? '<div id="tAllMatchesRoot"></div>' : ''}

      ${panel === 'summary' && (t.sports || []).length ? `<div class="t-tabs">${tabsHtml}</div>` : panel === 'summary' ? `
        <section class="t-section">
          <div class="t-empty">
            No sports have been added to this tournament yet.
            ${isAdminUi() ? '<div style="margin-top:12px;"><button class="t-btn primary" onclick="window.__tournament.navigate({view:\'manage\',tournamentId:\'' + t.id + '\'})">⚙️ Manage tournament</button></div>' : ''}
          </div>
        </section>
      ` : ''}

      ${panel === 'summary' && sport && categorized ? `
        <section class="t-section">
          <div class="t-section-header"><h2 class="t-section-title">Current matches <small>all categories</small></h2></div>
          <div class="t-match-list" id="tSummaryCurrentMatches"></div>
        </section>
        <section class="t-section">
          <div class="t-section-header"><h2 class="t-section-title">Upcoming matches <small>all categories</small></h2></div>
          <div class="t-card"><div class="t-card-body" id="tSummaryUpcoming"></div></div>
        </section>
        <section class="t-section" id="tSummaryPodiumSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Winners <small>champion and runner-up for each category</small></h2></div>
          <div id="tSummaryPodium"></div>
        </section>
      ` : ''}

      ${panel === 'summary' && sport && categorized ? '<div id="tCategoryRoot"></div>' : ''}
      ${panel === 'summary' && sport && !categorized ? `
        ${t.format === 'teams' ? `
        <section class="t-section" id="tRostersSection">
          <div class="t-section-header">
            <h2 class="t-section-title">Team rosters <small>captain counts as a member${maxRosterSize(sport) ? ' · max ' + maxRosterSize(sport) + ' per team' : ''}</small></h2>
            ${isAdminUi() ? `
              <div class="t-roster-cap">
                <label for="tMaxRosterSize">Max per team</label>
                <input type="number" min="0" class="t-input sm" id="tMaxRosterSize" placeholder="No limit" value="${maxRosterSize(sport) || ''}" onkeydown="if(event.key==='Enter'){event.preventDefault();window.__tournament.saveMaxRosterSize('${t.id}','${sport.id}');}" />
                <button class="t-btn sm primary" type="button" onclick="window.__tournament.saveMaxRosterSize('${t.id}','${sport.id}')">Save</button>
              </div>
            ` : ''}
          </div>
          <div class="t-rosters-grid" id="tRostersGrid"></div>
        </section>
        ` : ''}

        <section class="t-section" id="tScheduleSection">
          <div class="t-section-header">
            <h2 class="t-section-title">Schedule <small>fixtures for this sport</small></h2>
            <div id="tScheduleActions" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
          </div>
          <div class="t-card"><div class="t-card-body" id="tScheduleBody"><p class="t-empty">Loading…</p></div></div>
        </section>

        <section class="t-section">
          <div class="t-section-header"><h2 class="t-section-title">Standings <small>one table per stage</small></h2></div>
          <div class="t-card"><div class="t-card-body" id="tStandings"><p class="t-empty">Loading…</p></div></div>
        </section>

        <section class="t-section" id="tLiveSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">🔴 Live now</h2></div>
          <div class="t-match-list" id="tLiveList"></div>
        </section>

        <section class="t-section" id="tUpcomingSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">${isAdminUi() ? 'Scheduled <small>mark Upcoming so members and the spectator board list that match</small>' : 'Upcoming'}</h2></div>
          <div class="t-match-list" id="tUpcomingList"></div>
        </section>

        <section class="t-section" id="tSummaryPodiumSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Winners <small>champion and runner-up when decided</small></h2></div>
          <div id="tSummaryPodium"></div>
        </section>

        <section class="t-section" id="tCompletedSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Completed</h2></div>
          <div class="t-match-list" id="tCompletedList"></div>
        </section>

        <section class="t-section" id="tPlayoffsSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Playoffs</h2></div>
          <div class="t-bracket" id="tPlayoffs"></div>
        </section>

        ${isAdminUi() ? `
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

    if (panel === 'matches') {
      renderAllMatchesPanel(t);
    } else if (panel === 'summary' && sport && categorized) {
      renderSummaryPodium(t, sport);
      renderSummaryCurrentMatches(t, sport);
      renderSummaryUpcoming(t, sport);
      renderCategoryWorkspace(t, sport, parsed);
    } else if (panel === 'summary' && sport) {
      renderSummaryPodium(t, sport);
      if (t.format === 'teams') renderRostersFor(t, sport);
      renderScheduleFor(t, sport);
      renderStandingsFor(t, sport.id);
      renderMatchListsFor(t, sport.id);
      renderPlayoffsFor(t, sport.id);
    }
  }

  function categoryMatchVisible(sport, match) {
    if (isAdminUi()) return true;
    if (!(match.fromSchedule || match.scheduleEntryId)) return true;
    if (match.bracketId) {
      const division = findDivision(sport, match.categoryId);
      return scheduleIsPublished(findBracket(division, match.bracketId));
    }
    return scheduleIsPublished(sport);
  }

  function rankOf(rows, id) {
    const index = (rows || []).findIndex(function (r) { return r.id === id; });
    if (index < 0) return null;
    const row = rows[index];
    return { rank: row.rank || index + 1, row: row };
  }

  function standingLine(rank) {
    if (!rank) return 'No results yet';
    const r = rank.row;
    return '#' + rank.rank + ' · P ' + r.played + ' · W ' + r.won + ' · D ' + (r.drawn || 0) + ' · L ' + r.lost + ' · Pts ' + r.points;
  }

  function teamNavigate(tournament, sport, division, teamId, bracketId) {
    navigate({
      view: 'tournament',
      tournamentId: tournament.id,
      sportId: sport.id,
      categoryId: division ? division.id : '',
      bracketId: bracketId || '',
      teamId: teamId || ''
    });
  }

  async function setSportMode(tournamentId, mode) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const next = mode === 'multi' ? 'multi' : 'single';
    if (next === sportModeOf(t)) return;
    if (next === 'single' && (t.sports || []).length > 1) {
      return toast('This tournament has more than one sport. Remove the extra sports before switching to single sport.', 'error');
    }
    const ok = next === 'multi'
      ? confirm('Switch "' + t.name + '" to multi sport? You can add more sports, and tournament rules will apply to every sport.')
      : confirm('Switch "' + t.name + '" to single sport? Tournament-wide rules will be hidden.');
    if (!ok) return;
    try {
      await db.collection('tournaments').doc(t.id).update({
        sportMode: next,
        updatedAt: FieldValue.serverTimestamp()
      });
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { sportMode: next });
      toast(next === 'multi' ? 'Switched to multi sport. Tournament rules are now available.' : 'Switched to single sport.', 'success');
      render();
    } catch (err) {
      console.error(err);
      toast('Could not update sport mode: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function scorerProfileName(profile) {
    if (!profile) return '';
    const parts = [profile.firstName, profile.middleName, profile.lastName].map(function (part) {
      return String(part || '').trim();
    }).filter(Boolean);
    return parts.join(' ') || String(profile.displayName || profile.email || '').trim();
  }

  function sortScorers(a, b) {
    return String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
  }

  async function loadScorerDirectory(force) {
    if (force) {
      state.scorerDirectory = null;
      state.adminDirectory = null;
      scorerDirectoryPromise = null;
    }
    if (state.scorerDirectory) return state.scorerDirectory;
    if (scorerDirectoryPromise) return scorerDirectoryPromise;
    function peopleWithRole(role) {
      return db.collection('users').where('role', '==', role).get().then(function (snap) {
        const list = [];
        snap.forEach(function (doc) {
          const data = doc.data() || {};
          list.push({
            uid: doc.id,
            name: scorerProfileName(data),
            email: String(data.email || '').trim().toLowerCase(),
            admin: role === 'admin'
          });
        });
        return list;
      });
    }
    scorerDirectoryPromise = Promise.all([peopleWithRole('scorer'), peopleWithRole('admin')])
      .then(function (groups) {
        const scorers = groups[0];
        const admins = groups[1];
        scorers.sort(sortScorers);
        admins.sort(sortScorers);
        state.scorerDirectory = scorers;
        state.adminDirectory = admins;
        return scorers;
      })
      .catch(function (err) {
        scorerDirectoryPromise = null;
        throw err;
      });
    return scorerDirectoryPromise;
  }

  function ensureScorerDirectoryThenRender() {
    if (!isAdminUi() || state.scorerDirectory || scorerDirectoryLoading) return;
    scorerDirectoryLoading = true;
    loadScorerDirectory().then(function () {
      scorerDirectoryLoading = false;
      render();
    }).catch(function (err) {
      scorerDirectoryLoading = false;
      console.warn('[tournament] scorer directory:', err);
    });
  }

  function listedAdmins() {
    return (state.adminDirectory || []).slice().sort(sortScorers);
  }

  function listedRoleScorers() {
    return (state.scorerDirectory || []).slice().sort(sortScorers);
  }

  function availableMatchScorers(tournament) {
    const byUid = {};
    function put(scorer) {
      if (!scorer || !scorer.uid) return;
      const prev = byUid[scorer.uid] || {};
      byUid[scorer.uid] = {
        uid: scorer.uid,
        name: scorer.name || prev.name || '',
        email: scorer.email || prev.email || '',
        admin: !!(scorer.admin || prev.admin)
      };
    }
    listedAdmins().forEach(put);
    listedRoleScorers().forEach(put);
    ((tournament && tournament.scorers) || []).forEach(put);
    return Object.keys(byUid).map(function (uid) { return byUid[uid]; }).sort(function (a, b) {
      if (!!a.admin !== !!b.admin) return a.admin ? -1 : 1;
      return sortScorers(a, b);
    });
  }

  async function ensureTournamentHasScorer(tournament, scorer) {
    if (!tournament || !scorer || !scorer.uid) return;
    const exists = (tournament.scorers || []).some(function (item) { return item.uid === scorer.uid; });
    if (exists) return;
    const next = (tournament.scorers || []).concat([{
      uid: scorer.uid,
      name: scorer.name || scorer.email || 'Scorer',
      email: scorer.email || ''
    }]);
    await db.collection('tournaments').doc(tournament.id).update({
      scorers: next,
      scorerUids: next.map(function (item) { return item.uid; }),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  async function openTournamentScorers(tournamentId) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const tournament = state.tournaments.find(function (item) { return item.id === tournamentId; });
    if (!tournament) return toast('Tournament not found', 'error');
    const dialog = getOrCreateModal('tTournamentScorers', 'Tournament scorers', { wide: false });
    const modal = dialog.modal;
    const body = dialog.body;
    body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Loading registered scorers…</p>';
    modal.classList.add('open');
    try {
      await loadScorerDirectory(true);
      const admins = listedAdmins();
      const roleScorers = listedRoleScorers();
      const candidates = admins.concat(roleScorers);
      const selected = {};
      (tournament.scorers || []).forEach(function (scorer) { if (scorer && scorer.uid) selected[scorer.uid] = true; });
      function personRow(scorer, locked) {
        return `<label class="t-scorer-person">
          <input type="checkbox" data-scorer-uid="${escapeHtml(scorer.uid)}" ${locked || selected[scorer.uid] ? 'checked' : ''} ${locked ? 'disabled' : ''} />
          <span><b>${escapeHtml(scorer.name || scorer.email || (locked ? 'Admin' : 'Registered scorer'))}${locked ? ' (Admin)' : ''}</b>${scorer.email ? '<small>' + escapeHtml(scorer.email) + '</small>' : ''}</span>
        </label>`;
      }
      body.innerHTML = `
        <p class="t-mode-note" style="margin-top:0;">Admins are always scorers and must be assignable on a game. Members with the scorer role can be added here, or picked on a match — that also adds them to this tournament.</p>
        <div class="t-scorer-list">
          ${admins.map(function (scorer) { return personRow(scorer, true); }).join('')}
          ${roleScorers.map(function (scorer) { return personRow(scorer, false); }).join('')}
          ${candidates.length ? '' : '<div class="t-empty" style="padding:18px;">No admins or scorers yet. Grant a role from Members &amp; Admins first.</div>'}
        </div>
        <div class="t-modal-foot" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="t-btn" data-close-scorers>Cancel</button>
          ${candidates.length ? '<button type="button" class="t-btn primary" data-save-scorers>Save scorers</button>' : ''}
        </div>
      `;
      body.querySelector('[data-close-scorers]').addEventListener('click', function () { closeLiveModal('tTournamentScorers'); });
      const save = body.querySelector('[data-save-scorers]');
      if (save) {
        save.addEventListener('click', async function () {
          save.disabled = true;
          save.textContent = 'Saving…';
          const chosen = {};
          admins.forEach(function (scorer) { chosen[scorer.uid] = true; });
          body.querySelectorAll('[data-scorer-uid]:checked').forEach(function (input) {
            chosen[input.getAttribute('data-scorer-uid')] = true;
          });
          const next = candidates.filter(function (scorer) { return chosen[scorer.uid]; });
          const removed = {};
          (tournament.scorers || []).forEach(function (scorer) {
            if (scorer && scorer.uid && !chosen[scorer.uid] && !admins.some(function (admin) { return admin.uid === scorer.uid; })) {
              removed[scorer.uid] = true;
            }
          });
          try {
            const batch = db.batch();
            batch.update(db.collection('tournaments').doc(tournament.id), {
              scorers: next,
              scorerUids: next.map(function (scorer) { return scorer.uid; }),
              updatedAt: FieldValue.serverTimestamp()
            });
            state.matches.forEach(function (match) {
              if (match.tournamentId !== tournament.id || !removed[match.scorerUid] || match.status === 'completed') return;
              batch.update(db.collection('tournament_matches').doc(match.id), {
                scorerUid: FieldValue.delete(),
                scorerName: FieldValue.delete(),
                scorerEmail: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp()
              });
            });
            await batch.commit();
            closeLiveModal('tTournamentScorers');
            toast('Tournament scorers updated');
          } catch (err) {
            console.error(err);
            toast('Could not update tournament scorers: ' + (err.message || err.code || 'unknown'), 'error');
            save.disabled = false;
            save.textContent = 'Save scorers';
          }
        });
      }
    } catch (err) {
      console.error(err);
      body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Could not load scorers. ' + escapeHtml(err.message || err.code || 'Try again.') + '</p>';
    }
  }

  async function setTournamentStarted(tournamentId, started) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const next = !!started;
    const ok = next
      ? confirm('Start "' + t.name + '"? Members will see bracket standings, overall standings, the current match, and upcoming matches. You can then create a spectator link that works without sign-in.')
      : confirm('Mark "' + t.name + '" as not started? Members will no longer see the live standings board.' + (t.publicBoard ? ' The spectator link will stop working.' : ''));
    if (!ok) return;
    try {
      const patch = {
        started: next,
        startedAt: next ? new Date().toISOString() : null,
        updatedAt: FieldValue.serverTimestamp()
      };
      if (!next) patch.publicBoard = false;
      await db.collection('tournaments').doc(t.id).update(patch);
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { started: next, publicBoard: next ? state.tournaments[idx].publicBoard : false });
      if (!next) syncPublicBoardNow(t.id, { forceClose: true });
      toast(next ? 'Tournament started' : 'Tournament marked as not started', 'success');
      render();
    } catch (err) {
      console.error(err);
      toast('Could not update tournament: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  async function mutateDivision(tournamentId, sportId, divisionId, mutator) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    if (!t || !sport) return;
    const divisions = (sport.divisions || []).map(function (d) {
      if (d.id !== divisionId) return d;
      const copy = JSON.parse(JSON.stringify(d));
      mutator(copy);
      return copy;
    });
    await writeSportPatch(t, sportId, { divisions: divisions });
  }

  async function setDivisionStageEnabled(tournamentId, sportId, divisionId, stageId, enabled) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!t || !sport || !division || !stageId) return;
    const allIds = stageListFor(sport).map(function (st) { return st.id; });
    if (allIds.indexOf(stageId) === -1) return;
    const hidden = disabledStagesOf(division);
    let next;
    if (enabled) {
      next = hidden.filter(function (id) { return id !== stageId; });
    } else {
      next = hidden.indexOf(stageId) === -1 ? hidden.concat([stageId]) : hidden.slice();
      const remaining = allIds.filter(function (id) { return next.indexOf(id) === -1; });
      if (!remaining.length) {
        toast('Keep at least one stage for this category.', 'error');
        return;
      }
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        if (next.length) div.disabledStages = next;
        else delete div.disabledStages;
      });
      const nextStageId = resolveDivisionStageId(sport, Object.assign({}, division, {
        disabledStages: next
      }), parseUrl().stageId || stageId);
      toast(enabled ? 'Stage restored for this category' : 'Stage hidden for this category', 'success');
      schedulePublicBoardSync(tournamentId);
      navigate({
        view: 'tournament',
        tournamentId: tournamentId,
        sportId: sportId,
        categoryId: divisionId,
        stageId: nextStageId
      });
    } catch (_) { /* toasted */ }
  }

  function openEntryTeam(tournamentId, sportId, divisionId, teamId) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!t || !division) return;
    const existing = teamId ? (division.teams || []).find(function (tm) { return tm.id === teamId; }) : null;
    const max = clampMaxPlayers(division.maxPlayers);
    const players = ((existing && existing.players) || []).slice(0, max);
    while (players.length < max) players.push('');
    const { modal, body } = getOrCreateModal('tEntryTeam', (existing ? 'Edit team' : 'Add team') + ' — ' + (division.name || 'Category'), { wide: false });
    const fields = players.map(function (name, i) {
      return `
        <div class="t-form-field">
          <label>Player ${i + 1}</label>
          <input type="text" class="t-input" data-player value="${escapeHtml(name)}" placeholder="Player name" />
        </div>
      `;
    }).join('');
    body.innerHTML = `
      <p class="t-mode-note">This category allows ${max} player${max === 1 ? '' : 's'} on a team. Singles and doubles still register as a team.</p>
      <div class="t-form-field">
        <label>Team name</label>
        <input type="text" class="t-input" id="tEntryTeamName" value="${escapeHtml((existing && existing.name) || '')}" placeholder="Team name" />
      </div>
      <div class="t-form-field">
        <label>Tags</label>
        <input type="text" class="t-input" id="tEntryTeamTags" value="${escapeHtml(parseTeamTags(existing && existing.tags).join(', '))}" placeholder="Optional labels, separated by commas" />
      </div>
      ${fields}
      <div class="t-modal-foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" class="t-btn" data-cancel>Cancel</button>
        <button type="button" class="t-btn primary" data-save>${existing ? 'Save team' : 'Add team'}</button>
      </div>
    `;
    modal.classList.add('open');
    const nameInput = body.querySelector('#tEntryTeamName');
    if (nameInput) nameInput.focus();
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeLiveModal('tEntryTeam'); });
    body.querySelector('[data-save]').addEventListener('click', async function () {
      const name = nameInput.value.trim();
      const playerNames = Array.prototype.map.call(body.querySelectorAll('[data-player]'), function (input) {
        return input.value.trim();
      });
      if (!name) return toast('Enter a team name', 'error');
      if (playerNames.some(function (p) { return !p; })) return toast('Enter all ' + max + ' player name' + (max === 1 ? '' : 's'), 'error');
      const team = {
        id: (existing && existing.id) || newId('team'),
        name: name,
        players: playerNames,
        tags: parseTeamTags(body.querySelector('#tEntryTeamTags').value)
      };
      try {
        await mutateDivision(tournamentId, sportId, divisionId, function (div) {
          div.teams = Array.isArray(div.teams) ? div.teams : [];
          const idx = div.teams.findIndex(function (tm) { return tm.id === team.id; });
          if (idx >= 0) div.teams[idx] = Object.assign({}, div.teams[idx], team);
          else div.teams.push(team);
        });
        closeLiveModal('tEntryTeam');
        toast(existing ? 'Team updated' : 'Team added', 'success');
        render();
      } catch (_) { /* toasted */ }
    });
  }

  async function removeEntryTeam(tournamentId, sportId, divisionId, teamId) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const division = t ? findDivision(getSportConfig(t, sportId), divisionId) : null;
    const team = division && (division.teams || []).find(function (tm) { return tm.id === teamId; });
    if (!team) return;
    if (!confirm('Remove ' + (team.name || 'this team') + ' from ' + (division.name || 'this category') + '?')) return;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        div.teams = (div.teams || []).filter(function (tm) { return tm.id !== teamId; });
        (div.brackets || []).forEach(function (b) {
          b.teamIds = (b.teamIds || []).filter(function (id) { return id !== teamId; });
          const tags = bracketTeamTags(b);
          delete tags[teamId];
          writeBracketTeamTags(b, tags);
        });
        const record = advancedRecord(div);
        Object.keys(record).forEach(function (stageKey) {
          record[stageKey] = record[stageKey].filter(function (id) { return id !== teamId; });
          if (!record[stageKey].length) delete record[stageKey];
        });
        div.advanced = record;
        const ranking = rankingRecord(div);
        Object.keys(ranking).forEach(function (stageKey) {
          ranking[stageKey] = ranking[stageKey].filter(function (id) { return id !== teamId; });
          if (!ranking[stageKey].length) delete ranking[stageKey];
        });
        div.ranking = ranking;
        if (div.winnerId === teamId) delete div.winnerId;
        if (div.runnerId === teamId) delete div.runnerId;
      });
      toast('Team removed', 'success');
      if (parseUrl().teamId === teamId) {
        navigate({ view: 'tournament', tournamentId: tournamentId, sportId: sportId, categoryId: divisionId }, { replace: true });
      } else {
        render();
      }
    } catch (_) { /* toasted */ }
  }

  async function addBracket(tournamentId, sportId, divisionId, stageId, afterBracketId) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!division) return;
    const stage = stageId || 'league';
    const blocked = stageStartBlockedReason(sport, division, stage);
    if (blocked) return toast(blocked, 'error');
    const pool = teamsForStage(division, sport, stage);
    if (pool.length < 2) {
      return toast(isEntryStage(sport, division, stage)
        ? 'Add at least two teams before creating a bracket'
        : 'Advance at least two teams into ' + stageLabelOf(sport, stage) + ' before creating a bracket', 'error');
    }
    const n = bracketsInStage(division, stage).length + 1;
    const bracket = {
      id: newId('brk'),
      name: 'Bracket ' + n,
      stageId: stage,
      teamIds: [],
      walkoverPoints: defaultWalkoverScore(sport, stage),
      walkoverScore: defaultWalkoverScore(sport, stage)
    };
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        div.brackets = div.brackets || [];
        let insertAt = div.brackets.length;
        if (afterBracketId) {
          const after = div.brackets.findIndex(function (b) { return b.id === afterBracketId; });
          if (after >= 0) insertAt = after + 1;
        } else {
          let last = -1;
          div.brackets.forEach(function (b, i) {
            if (bracketStageId(b) === stage) last = i;
          });
          if (last >= 0) insertAt = last + 1;
        }
        div.brackets.splice(insertAt, 0, bracket);
      });
      toast(
        (division.teams || []).length < 2
          ? 'Bracket created in ' + stageLabelOf(sport, stage) + '. Add teams, then pull them in.'
          : 'Bracket created in ' + stageLabelOf(sport, stage) + '. Pull teams into it, then build the schedule.',
        'success'
      );
      navigate({
        view: 'tournament',
        tournamentId: tournamentId,
        sportId: sportId,
        categoryId: divisionId,
        bracketId: bracket.id,
        stageId: stage
      });
    } catch (_) { /* toasted */ }
  }

  async function moveBracket(tournamentId, sportId, divisionId, bracketId, dir) {
    if (!isAdminUi()) return;
    const step = dir < 0 ? -1 : 1;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const brackets = div.brackets || [];
        const idx = brackets.findIndex(function (b) { return b.id === bracketId; });
        if (idx < 0) return;
        const stage = bracketStageId(brackets[idx]);
        const same = [];
        brackets.forEach(function (b, i) {
          if (bracketStageId(b) === stage) same.push(i);
        });
        const pos = same.indexOf(idx);
        const swapAt = pos + step;
        if (swapAt < 0 || swapAt >= same.length) return;
        const other = same[swapAt];
        const tmp = brackets[idx];
        brackets[idx] = brackets[other];
        brackets[other] = tmp;
      });
    } catch (_) { /* toasted */ }
  }

  async function renameBracket(tournamentId, sportId, divisionId, bracketId, name) {
    if (!isAdminUi()) return;
    const trimmed = String(name || '').trim();
    if (!trimmed) return toast('Bracket name is required', 'error');
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const bracket = (div.brackets || []).find(function (b) { return b.id === bracketId; });
        if (bracket) bracket.name = trimmed;
      });
    } catch (_) { /* toasted */ }
  }

  async function setBracketWalkoverPoints(tournamentId, sportId, divisionId, bracketId, value) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    if (!sport) return;
    const fallback = defaultWalkoverScore(sport, 'league');
    const score = clampTablePoint(value, fallback);
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const bracket = (div.brackets || []).find(function (b) { return b.id === bracketId; });
        if (bracket) {
          bracket.walkoverPoints = score;
          bracket.walkoverScore = score;
        }
      });
      toast('Walkover Score set to ' + score + '–0', 'success');
    } catch (_) { /* toasted */ }
  }

  async function removeBracket(tournamentId, sportId, divisionId, bracketId) {
    if (!isAdminUi()) return;
    if (!confirm('Remove this bracket? Published matches that already started are kept. Clear the bracket schedule first if you want scheduled matches removed.')) return;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        div.brackets = (div.brackets || []).filter(function (b) { return b.id !== bracketId; });
      });
      toast('Bracket removed', 'success');
      navigate({
        view: 'tournament',
        tournamentId: tournamentId,
        sportId: sportId,
        categoryId: divisionId,
        stageId: parseUrl().stageId || ''
      });
    } catch (_) { /* toasted */ }
  }

  async function toggleBracketTeam(tournamentId, sportId, divisionId, bracketId, teamId, on) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    const target = findBracket(division, bracketId);
    if (!division || !target) return;
    const stage = bracketStageId(target);
    const blocked = stageStartBlockedReason(sport, division, stage);
    if (on && blocked) return toast(blocked, 'error');
    if (on && teamsForStage(division, sport, stage).every(function (tm) { return tm.id !== teamId; })) {
      return toast('Pull in a team that belongs in ' + stageLabelOf(sport, stage) + '. Later stages only list teams advanced into them.', 'error');
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const target = (div.brackets || []).find(function (b) { return b.id === bracketId; });
        const stage = bracketStageId(target);
        (div.brackets || []).forEach(function (b) {
          if (bracketStageId(b) !== stage) return;
          const keepHere = on && b.id === bracketId;
          const tags = bracketTeamTags(b);
          b.teamIds = (b.teamIds || []).filter(function (id) { return id !== teamId; });
          if (keepHere) b.teamIds.push(teamId);
          else delete tags[teamId];
          writeBracketTeamTags(b, tags);
        });
      });
      render();
      if (on) {
        const input = document.querySelector('[data-bracket-tag][data-bracket="' + bracketId + '"][data-team="' + teamId + '"]');
        if (input) {
          input.focus();
          input.select();
        }
      }
    } catch (_) { /* toasted */ }
  }

  async function setBracketTeamTag(tournamentId, sportId, divisionId, bracketId, teamId, tag) {
    if (!isAdminUi()) return;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const target = (div.brackets || []).find(function (b) { return b.id === bracketId; });
        if (!target || (target.teamIds || []).indexOf(teamId) === -1) return;
        const tags = bracketTeamTags(target);
        const next = normalizeScheduleTag(tag);
        if (next) tags[teamId] = next;
        else delete tags[teamId];
        writeBracketTeamTags(target, tags);
      });
      render();
    } catch (_) { /* toasted */ }
  }

  async function moveStageRank(tournamentId, sportId, divisionId, stageId, teamId, dir) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!t || !sport || !division || !stageId || !teamId) return;
    const rows = computeStageRanking(t, state.matches, sport, division, stageId);
    const ids = rows.map(function (row) { return row.id; });
    const from = ids.indexOf(teamId);
    const to = from + (dir < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    const swap = ids[from];
    ids[from] = ids[to];
    ids[to] = swap;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const record = rankingRecord(div);
        record[stageId] = ids.slice();
        div.ranking = record;
      });
      toast('Ranking updated', 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  async function resetStageRanking(tournamentId, sportId, divisionId, stageId) {
    if (!isAdminUi()) return;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const record = rankingRecord(div);
        delete record[stageId];
        if (Object.keys(record).length) div.ranking = record;
        else delete div.ranking;
      });
      toast('Ranking reset to points order', 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  async function setCategoryPlace(tournamentId, sportId, divisionId, field, teamId) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!division) return;
    const known = {};
    (division.teams || []).forEach(function (tm) { if (tm && tm.id) known[tm.id] = true; });
    const id = known[teamId] ? teamId : '';
    if (field === 'runnerId' && id && id === String(division.winnerId || '')) {
      return toast('Runner-up must be a different team', 'error');
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        if (field === 'winnerId') {
          if (id && div.runnerId === id) {
            const previous = div.winnerId || '';
            if (previous && previous !== id) div.runnerId = previous;
            else delete div.runnerId;
          }
          if (id) div.winnerId = id;
          else delete div.winnerId;
        } else if (field === 'runnerId') {
          if (id && div.winnerId === id) return;
          if (id) div.runnerId = id;
          else delete div.runnerId;
        } else {
          delete div.winnerId;
          delete div.runnerId;
        }
      });
      toast(field === 'clear' ? 'Winner cleared' : 'Winner updated', 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  async function setTeamAdvanced(tournamentId, sportId, divisionId, fromStageId, teamId, on) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!division) return;
    const next = nextStageAfter(sport, division, fromStageId);
    if (!next) return toast('This category has no later stage. Stage order is set on Manage tournament.', 'error');
    if (on) {
      const blocked = stageAdvanceBlockedReason(t, sport, division, fromStageId);
      if (blocked) return toast(blocked, 'error');
    }
    const team = (division.teams || []).find(function (tm) { return tm.id === teamId; });
    if (!team) return toast('That team is not in this category.', 'error');
    const turningOn = !!on;
    const nextIds = (advancedTeamIds(division, next.id) || []).slice();
    if (turningOn && nextIds.indexOf(teamId) === -1) nextIds.push(teamId);
    if (!turningOn) {
      const drop = nextIds.indexOf(teamId);
      if (drop >= 0) nextIds.splice(drop, 1);
    }
    const rankedPreview = rankIdsByPreviousStage(t, sport, division, fromStageId, nextIds);
    const seedNo = turningOn ? rankedPreview.indexOf(teamId) + 1 : 0;
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const record = advancedRecord(div);
        const list = (record[next.id] || []).slice();
        const idx = list.indexOf(teamId);
        if (turningOn && idx === -1) list.push(teamId);
        if (!turningOn && idx >= 0) list.splice(idx, 1);
        const ranked = rankIdsByPreviousStage(t, sport, div, fromStageId, list);
        if (ranked.length) record[next.id] = ranked;
        else delete record[next.id];
        if (!turningOn) {
          (div.brackets || []).forEach(function (b) {
            if (bracketStageId(b) !== next.id) return;
            b.teamIds = (b.teamIds || []).filter(function (id) { return id !== teamId; });
          });
          (div.teams || []).forEach(function (tm) {
            if (tm && tm.id === teamId) tm.tags = stripSeedTags(tm.tags);
          });
        }
        applyAdvanceSeeds(div, ranked);
        div.advanced = record;
      });
      toast(turningOn
        ? (team.name || 'Team') + ' advanced to ' + next.name + (seedNo > 0 ? ' as Seed ' + seedNo : '')
        : (team.name || 'Team') + ' removed from ' + next.name, 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  async function setCategoryStageSkipped(tournamentId, sportId, divisionId, stageId, skipped) {
    if (!isAdminUi()) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!division) return;
    const label = stageLabelOf(sport, stageId);
    const catName = division.name || 'this category';
    const turningOff = !!skipped;
    if (turningOff) {
      const remaining = categoryStages(sport, division).filter(function (st) { return st.id !== stageId; });
      if (!remaining.length) return toast(catName + ' needs at least one stage.', 'error');
      if (!confirm('Skip ' + label + ' for ' + catName + '? This category will not show that stage. Teams already advanced into it move to the next stage that is still included.')) return;
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const ids = skippedStageIds(div).filter(function (id) { return id !== stageId; });
        if (turningOff) ids.push(stageId);
        div.skippedStages = ids;
        if (turningOff) {
          const moving = advancedTeamIds(div, stageId);
          const record = advancedRecord(div);
          if (moving.length) {
            const next = nextStageAfter(sport, div, stageId);
            if (next) {
              const dest = (record[next.id] || []).slice();
              moving.forEach(function (id) {
                if (dest.indexOf(id) === -1) dest.push(id);
              });
              const from = previousStageBefore(sport, div, next.id);
              record[next.id] = from
                ? rankIdsByPreviousStage(t, sport, div, from.id, dest)
                : dest;
              applyAdvanceSeeds(div, record[next.id]);
            }
            delete record[stageId];
          }
          div.advanced = record;
        }
      });
      toast(turningOff ? label + ' skipped for ' + catName : label + ' included for ' + catName, 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  function standingsTableHtml(tournament, sportId, rows, division, bracketId, emptyLabel, fromStageId) {
    if (!rows.length) return '<p class="t-empty">' + escapeHtml(emptyLabel || 'No matches completed yet.') + '</p>';
    const showGroups = rows.some(function (r) { return r && r.groupName; });
    const showPointBreakdown = !!bracketId || showGroups || rows.some(function (r) { return r && r.rank; });
    const sport = getSportConfig(tournament, sportId);
    const next = (isAdminUi() && division && fromStageId) ? nextStageAfter(sport, division, fromStageId) : null;
    const canRank = !!(isAdminUi() && division && fromStageId && !bracketId && rows.length > 1);
    return `
      <div class="t-standings-scroll"><table class="t-standings-table">
        <thead>
          <tr><th>#</th><th>Team</th>${showGroups ? '<th>Group</th><th class="num" title="Rank in group">Grp</th>' : ''}<th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th>${showPointBreakdown ? '<th class="num" title="Points for">PF</th><th class="num" title="Points against">PA</th><th class="num" title="Points difference">PD</th>' : ''}<th class="num">Pts</th>${next ? '<th>Next stage</th>' : ''}</tr>
        </thead>
        <tbody>
          ${rows.map(function (r, i) {
            const place = r.rank || (i + 1);
            const meta = teamMeta(tournament, sportId, r.id);
            const already = next ? advancedTeamIds(division, next.id).indexOf(r.id) !== -1 : false;
            const advanceBlocked = next && !already ? stageAdvanceBlockedReason(tournament, sport, division, fromStageId) : '';
            const advanceCell = next
              ? '<td class="t-advance-cell"><button type="button" class="t-btn sm t-advance-btn' + (advanceBlocked ? ' is-blocked' : '') + '" data-act="advance-team" data-team="' + escapeHtml(r.id) + '" data-from="' + escapeHtml(fromStageId) + '" data-on="' + (already ? '0' : '1') + '"' + (advanceBlocked ? ' title="' + escapeHtml(advanceBlocked) + '"' : '') + '>' + escapeHtml(already ? ('In ' + next.name) : (advanceBlocked ? 'Advance after stage complete' : ('Advance to ' + next.name))) + '</button></td>'
              : '';
            const rankControls = canRank
              ? '<div class="t-rank-edit"><button type="button" class="t-btn sm t-rank-btn" data-act="rank-up" data-team="' + escapeHtml(r.id) + '" data-from="' + escapeHtml(fromStageId) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button><button type="button" class="t-btn sm t-rank-btn" data-act="rank-down" data-team="' + escapeHtml(r.id) + '" data-from="' + escapeHtml(fromStageId) + '"' + (i === rows.length - 1 ? ' disabled' : '') + '>↓</button></div>'
              : '';
            return `
              <tr class="rank-${place} is-link" data-open-team="${escapeHtml(r.id)}" data-bracket="${escapeHtml(bracketId || '')}">
                <td><div class="t-rank-cell"><span class="rank-badge">${place}</span>${rankControls}</div></td>
                <td>
                  <div class="t-team-cell">
                    <span class="t-team-swatch" style="--team-color:${meta.color}"></span>
                    <div>
                      <span class="t-team-name">${escapeHtml(meta.name)}</span>
                      ${meta.wards ? '<span class="t-team-wards">' + escapeHtml(meta.wards) + '</span>' : ''}
                      ${teamLabelsHtml(meta.tags, division ? stageSeedOf(division, sport, fromStageId, r.id) : 0)}
                    </div>
                  </div>
                </td>
                ${showGroups ? '<td>' + escapeHtml(r.groupName || '—') + '</td><td class="num">' + (r.groupRank || '—') + '</td>' : ''}
                <td class="num">${r.played}</td>
                <td class="num">${r.won}</td>
                <td class="num">${r.drawn || 0}</td>
                <td class="num">${r.lost}</td>
                ${showPointBreakdown ? '<td class="num">' + (r.pointsFor || 0) + '</td><td class="num">' + (r.pointsAgainst || 0) + '</td><td class="num">' + ((r.pointsFor || 0) - (r.pointsAgainst || 0)) + '</td>' : ''}
                <td class="num">${r.points}</td>
                ${advanceCell}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table></div>
    `;
  }

  function categoryWinnerEditorHtml(tournament, sport, division) {
    if (!isAdminUi() || !division) return '';
    const teams = division.teams || [];
    const winnerId = String(division.winnerId || '');
    const runnerId = String(division.runnerId || '');
    function options(selected) {
      return '<option value="">Not set</option>' + teams.map(function (tm) {
        if (!tm || !tm.id) return '';
        return '<option value="' + escapeHtml(tm.id) + '"' + (tm.id === selected ? ' selected' : '') + '>' + escapeHtml(tm.name || 'Team') + '</option>';
      }).join('');
    }
    return `
      <section class="t-section">
        <div class="t-section-header"><h2 class="t-section-title">Winner <small>shown on Matches after you set a champion, or when the last stage is complete</small></h2></div>
        <div class="t-card"><div class="t-card-body t-winner-edit">
          <label>Champion
            <select class="t-select" data-act="set-winner">${options(winnerId)}</select>
          </label>
          <label>Runner-up
            <select class="t-select" data-act="set-runner">${options(runnerId)}</select>
          </label>
          ${(winnerId || runnerId) ? '<button type="button" class="t-btn sm" data-act="clear-winner">Clear</button>' : ''}
        </div></div>
      </section>
    `;
  }

  function teamFocusHtml(tournament, sport, division, team) {
    const showResults = isAdminUi() || tournamentHasStarted(tournament);
    const players = (team.players || []).filter(function (p) { return String(p || '').trim(); });
    const stages = categoryStages(sport, division);
    let results = '';
    if (showResults) {
      const stageBlocks = stages.map(function (st) {
        const bracket = bracketForTeam(division, team.id, st.id);
        const ranking = computeStageRanking(tournament, state.matches, sport, division, st.id);
        const bracketRows = bracket ? computeStandings(tournament, state.matches, sport.id, {
          categoryId: division.id,
          bracketId: bracket.id,
          teamIds: bracket.teamIds || [],
          stageId: st.id,
          useTeams: true
        }) : [];
        return `
          <div class="t-stage-focus">
            <div class="t-stage-standing-title">${escapeHtml(st.name)}${bracket ? ' · ' + escapeHtml(bracket.name || 'Bracket') : ''}${stageSeedOf(division, sport, st.id, team.id) ? ' · Seed ' + stageSeedOf(division, sport, st.id, team.id) : ''}</div>
            <div class="t-focus-grid">
              <div><div class="lbl">Bracket standing</div><div class="val">${escapeHtml(bracket ? standingLine(rankOf(bracketRows, team.id)) : 'Not placed in a bracket')}</div></div>
              <div><div class="lbl">Overall ranking</div><div class="val">${escapeHtml(standingLine(rankOf(ranking, team.id)))}</div></div>
            </div>
          </div>
        `;
      }).join('');
      const remaining = state.matches.filter(function (m) {
        if (!categoryMatchVisible(sport, m)) return false;
        if (m.sport !== sport.id || m.categoryId !== division.id) return false;
        if (m.status === 'completed') return false;
        const p = participantsOf(m, tournament);
        return p.a === team.id || p.b === team.id;
      }).sort(sortMatches);
      const left = remaining.map(function (m) {
        const p = participantsOf(m, tournament);
        const opp = p.a === team.id ? p.b : p.a;
        return `<li><b>${escapeHtml(displayName(tournament, sport.id, opp))}</b> · ${escapeHtml(stageLabelOf(sport, m.stage))} · ${escapeHtml(STATUS_LABEL[m.status] || m.status)} · ${m.scheduledAt ? escapeHtml(fmtDateTime(m.scheduledAt)) : 'Time TBD'}</li>`;
      }).join('');
      results = `
        ${stageBlocks}
        <div class="lbl" style="margin-top:10px;">Matches left</div>
        ${left ? '<ul class="t-left-matches">' + left + '</ul>' : '<p class="t-empty">No matches left.</p>'}
      `;
    } else {
      results = '<p class="t-mode-note">Standings and remaining matches show here once an admin starts the tournament.</p>';
    }
    return `
      <section class="t-section" id="tTeamFocus">
        <div class="t-card t-team-focus">
          <div class="t-card-body">
            <div class="t-section-header" style="margin-bottom:8px;">
              <h2 class="t-section-title">${escapeHtml(team.name || 'Team')} <small>${escapeHtml(division.name || '')}</small></h2>
              ${teamHereControlsHtml(team)}
              <button type="button" class="t-btn sm" data-act="close-team">Close</button>
            </div>
            <div class="t-player-list">${players.map(function (p) { return '<span>' + escapeHtml(p) + '</span>'; }).join('') || '<span>No players listed</span>'}</div>
            ${teamTagsHtml(team.tags)}
            ${results}
          </div>
        </div>
      </section>
    `;
  }

  function renderCategoryWorkspace(tournament, sport, parsed) {
    const root = document.getElementById('tCategoryRoot');
    if (!root) return;
    const divisions = sport.divisions || [];
    if (!divisions.length) {
      root.innerHTML = `
        <section class="t-section"><div class="t-empty">
          No registration category yet.
          ${isAdminUi() ? '<div style="margin-top:12px;"><button class="t-btn primary" onclick="window.__tournament.navigate({view:\'manage\',tournamentId:\'' + tournament.id + '\'})">⚙️ Set categories</button></div>' : ''}
        </div></section>`;
      return;
    }
    let division = findDivision(sport, parsed.categoryId) || divisions[0];
    if (parsed.teamId) {
      const located = findEntryTeam(tournament, sport.id, parsed.teamId);
      if (located && located.division && located.division.id) division = located.division;
    }
    const teams = division.teams || [];
    const stages = categoryStages(sport, division);
    const viewingAllSchedules = isAllSchedulesView(parsed.bracketId);
    const requestedBracket = viewingAllSchedules ? null : findBracket(division, parsed.bracketId);
    let stageId = stages[0] ? stages[0].id : 'league';
    if (parsed.stageId && stages.some(function (st) { return st.id === parsed.stageId; })) stageId = parsed.stageId;
    if (requestedBracket && stages.some(function (st) { return st.id === bracketStageId(requestedBracket); }) && (!parsed.stageId || bracketStageId(requestedBracket) === stageId)) {
      stageId = bracketStageId(requestedBracket);
    }
    const entryStage = isEntryStage(sport, division, stageId);
    const stageTeams = teamsForStage(division, sport, stageId);
    const offeredTeams = teamsOfferedInStage(division, sport, stageId);
    const nextStage = nextStageAfter(sport, division, stageId);
    const prevStage = previousStageBefore(sport, division, stageId);
    const stageName = stageLabelOf(sport, stageId);
    const brackets = bracketsInStage(division, stageId);
    const bracket = viewingAllSchedules
      ? null
      : ((requestedBracket && bracketStageId(requestedBracket) === stageId ? requestedBracket : null) || brackets[0] || null);
    const focusTeam = parsed.teamId ? teams.find(function (tm) { return tm.id === parsed.teamId; }) : null;
    const showBoard = isAdminUi() || tournamentHasStarted(tournament);
    const emptyStage = 'No ' + stageName + ' matches completed yet.';
    const stageMatchCount = stageMatchList(tournament, sport, division, stageId).length;
    const leftoverCount = unfinishedStageMatches(tournament, sport, division, stageId).length;
    const stageMarked = stageIsMarkedComplete(division, stageId);
    const stageLocked = !previousStageUnlocked(sport, division, stageId);
    const canMarkStage = stageMatchCount > 0 && leftoverCount === 0;

    const stageTabs = `<div class="t-tabs t-subtabs">${stages.map(function (st) {
      const active = st.id === stageId;
      const count = bracketsInStage(division, st.id).length;
      const done = stageIsMarkedComplete(division, st.id);
      const locked = !previousStageUnlocked(sport, division, st.id);
      return `<button type="button" class="t-tab ${active ? 'active' : ''} ${locked ? 'is-locked' : ''}" style="--sport-color:${sport.color || 'var(--t-primary)'}" data-act="select-stage" data-stage="${escapeHtml(st.id)}">${escapeHtml(st.name || st.id)}${done ? ' · Done' : ''}${locked ? ' · Locked' : ''}<span class="count">${count}</span></button>`;
    }).join('')}</div>`;
    const stageToolbar = isAdminUi()
      ? `<div class="t-stage-toolbar">
          <div class="t-stage-toolbar-label"><b>${escapeHtml(stageName)}</b> · ${brackets.length} bracket${brackets.length === 1 ? '' : 's'} in this category${stageMarked ? ' · complete' : ''}</div>
          ${stageLocked ? '' : '<button type="button" class="t-btn sm" data-act="round-robin">↺ Generate round-robin</button>'}
          ${stageLocked ? '' : '<button type="button" class="t-btn sm primary" data-act="add-bracket">➕ Create bracket in ' + escapeHtml(stageName) + '</button>'}
          ${stageMarked
            ? '<button type="button" class="t-btn sm" data-act="toggle-stage-complete" data-on="0">Reopen stage</button>'
            : '<button type="button" class="t-btn sm' + (canMarkStage ? ' primary' : '') + '" data-act="toggle-stage-complete" data-on="1"' + (canMarkStage ? '' : ' disabled title="Finish every match in this stage first"') + '>Mark stage complete</button>'}
        </div>
        ${stageLocked ? '<p class="t-mode-note">This stage is locked until ' + escapeHtml(prevStage ? prevStage.name : 'the previous stage') + ' is marked complete. Finish every match there first.</p>' : ''}
        ${!stageMarked && leftoverCount ? '<p class="t-mode-note">' + leftoverCount + ' match' + (leftoverCount === 1 ? '' : 'es') + ' in ' + escapeHtml(stageName) + ' still open. Finish them before marking this stage complete.</p>' : ''}
        ${!stageMarked && !leftoverCount && !stageMatchCount && !stageLocked ? '<p class="t-mode-note">Complete every match in ' + escapeHtml(stageName) + ' before marking this stage complete. The next stage stays locked until then.</p>' : ''}`
      : '';
    const stageSkip = isAdminUi() ? `
      <div class="t-stage-skip">
        <div class="t-stage-skip-label">Stages for this category</div>
        <div class="t-stage-skip-row">${stageListFor(sport).map(function (st) {
          const skipped = stageIsSkipped(division, st.id);
          return `<button type="button" class="t-btn sm ${skipped ? '' : 'primary'}" data-act="toggle-skip-stage" data-stage="${escapeHtml(st.id)}" data-skipped="${skipped ? '1' : '0'}">${escapeHtml(st.name || st.id)}${skipped ? ' · skipped' : ''}</button>`;
        }).join('')}</div>
        <p class="t-mode-note">Highlighted stages are included. Stage order is set on Manage tournament. Skip a stage to leave it out of this category. Mark a stage complete after every match in it is finished. Advance and the next stage stay locked until then.</p>
      </div>
    ` : '';

    const categoryTabs = sport.categoryMode === 'split'
      ? `<div class="t-tabs t-subtabs">${divisions.map(function (d) {
          const active = d.id === division.id;
          return `<button type="button" class="t-tab ${active ? 'active' : ''}" style="--sport-color:${sport.color || 'var(--t-primary)'}" data-act="select-category" data-category="${escapeHtml(d.id)}">${escapeHtml(d.name || 'Category')}<span class="count">${(d.teams || []).length}</span></button>`;
        }).join('')}</div>`
      : `<div class="t-open-banner"><b>Open category.</b> ${escapeHtml(division.name || 'Open')} is open to everyone. This sport is not split into separate categories.</div>`;

    const listedTeams = entryStage ? teams : offeredTeams;
    const hereCount = listedTeams.filter(teamIsHere).length;
    const teamCards = listedTeams.map(function (team) {
      const meta = teamMeta(tournament, sport.id, team.id);
      const owned = bracketForTeam(division, team.id, stageId);
      const players = teamPlayersLabel(team);
      const advancedTo = nextStage && advancedTeamIds(division, nextStage.id).indexOf(team.id) !== -1;
      return `
        <div class="t-roster-card is-link ${teamIsHere(team) ? 'is-here' : ''}" data-open-team="${escapeHtml(team.id)}" style="--team-color:${meta.color}">
          <div class="t-roster-card-head">
            <div class="t-roster-team">
              <span class="t-roster-dot" style="background:${meta.color};"></span>
              <div>
                <div class="t-roster-name">${escapeHtml(team.name || team.id)}</div>
                ${teamLabelsHtml(team.tags, stageSeedOf(division, sport, stageId, team.id))}
              </div>
            </div>
            ${teamHereControlsHtml(team)}
          </div>
          <div class="t-roster-card-body">
            <div class="t-roster-line"><span class="lbl">Players:</span><span class="val t-roster-player-names">${players ? escapeHtml(players) : 'No players yet'}</span></div>
            ${stageSeedOf(division, sport, stageId, team.id) ? '<div class="t-roster-line"><span class="lbl">Seed</span><span class="val">Seed ' + stageSeedOf(division, sport, stageId, team.id) + '</span></div>' : ''}
            <div class="t-roster-line"><span class="lbl">Bracket:</span><span class="val">${owned ? escapeHtml(owned.name || 'Bracket') : 'Unassigned'}</span></div>
            ${advancedTo ? '<div class="t-roster-line"><span class="lbl">Next</span><span class="val">Advanced to ' + escapeHtml(nextStage.name) + '</span></div>' : ''}
          </div>
          <div class="t-roster-card-foot">
            <button type="button" class="t-btn sm" data-act="open-team" data-team="${escapeHtml(team.id)}">Standing</button>
            ${isAdminUi() ? `<button type="button" class="t-btn sm" data-act="edit-team" data-team="${escapeHtml(team.id)}">Edit</button>` : ''}
            ${isAdminUi() && entryStage ? `<button type="button" class="t-btn danger sm" data-act="delete-team" data-team="${escapeHtml(team.id)}">Remove</button>` : ''}
            ${isAdminUi() && !entryStage ? `<button type="button" class="t-btn danger sm" data-act="drop-stage-team" data-team="${escapeHtml(team.id)}">Drop from ${escapeHtml(stageName)}</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const bracketCards = brackets.map(function (b, index) {
      const selected = !!(bracket && bracket.id === b.id);
      const walkoverScore = walkoverScoreForBracket(sport, b, stageId);
      const checks = offeredTeams.map(function (tm) {
        const owner = bracketForTeam(division, tm.id, stageId);
        const checked = !!(owner && owner.id === b.id);
        const elsewhere = !!(owner && owner.id !== b.id);
        const tag = checked ? scheduleTagOf(b, tm.id) : '';
        return `
          <div class="t-check-line">
            <label class="t-check-main">
              <input type="checkbox" data-bracket-team data-bracket="${escapeHtml(b.id)}" data-team="${escapeHtml(tm.id)}" ${checked ? 'checked' : ''} ${isAdminUi() && !stageLocked ? '' : 'disabled'} />
              <span>${escapeHtml(tm.name || tm.id)}${teamHereSuffix(tm)}</span>
            </label>
            ${isAdminUi() && checked
              ? '<input type="text" class="t-input sm t-sched-tag-input" data-bracket-tag data-bracket="' + escapeHtml(b.id) + '" data-team="' + escapeHtml(tm.id) + '" value="' + escapeHtml(tag) + '" maxlength="12" placeholder="Tag" title="Short tag for scheduling" />'
              : ''}
            ${teamIsHere(tm) ? '<span class="t-badge here">Here</span>' : '<span class="t-badge not-here">Not here</span>'}
            ${elsewhere ? '<em>In ' + escapeHtml(owner.name || 'another bracket') + ' — check to pull in</em>' : ''}
          </div>
        `;
      }).join('');
      return `
        <div class="t-bracket-card ${selected ? 'is-selected' : ''} ${bracketIsComplete(b) ? 'is-complete' : ''}">
          <div class="t-bracket-card-head">
            <input type="text" class="t-input" data-rename-bracket="${escapeHtml(b.id)}" value="${escapeHtml(b.name || '')}" ${isAdminUi() ? '' : 'readonly'} />
            ${bracketIsComplete(b) ? '<span class="t-badge complete">Complete</span>' : ''}
            ${isAdminUi() ? `<button type="button" class="t-btn sm" data-act="move-bracket" data-bracket="${escapeHtml(b.id)}" data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button>` : ''}
            ${isAdminUi() ? `<button type="button" class="t-btn sm" data-act="move-bracket" data-bracket="${escapeHtml(b.id)}" data-dir="1" ${index === brackets.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
            <button type="button" class="t-btn sm ${selected ? 'primary' : ''}" data-act="select-bracket" data-bracket="${escapeHtml(b.id)}">${selected ? 'Viewing schedule' : 'Schedule'}</button>
            ${isAdminUi() ? `<button type="button" class="t-btn sm" data-act="toggle-complete" data-bracket="${escapeHtml(b.id)}">${bracketIsComplete(b) ? 'Reopen' : 'Mark complete'}</button>` : ''}
            ${isAdminUi() && !stageLocked ? `<button type="button" class="t-btn sm" data-act="add-bracket-after" data-bracket="${escapeHtml(b.id)}">Add below</button>` : ''}
            ${isAdminUi() ? `<button type="button" class="t-btn danger sm" data-act="delete-bracket" data-bracket="${escapeHtml(b.id)}">Remove</button>` : ''}
          </div>
          <div class="t-bracket-points">
            <label>Walkover Score
              ${isAdminUi()
                ? `<input type="number" min="0" max="99" class="t-input sm" data-bracket-walkover="${escapeHtml(b.id)}" value="${walkoverScore}" />`
                : `<b>${walkoverScore}</b>`}
            </label>
            <span>Recorded as ${walkoverScore}–0. The team that shows up still receives the win points.</span>
          </div>
          <div class="t-check-list">${checks || '<p class="t-empty">' + (entryStage ? 'Add teams, then pull them into this bracket.' : 'Advance teams into ' + escapeHtml(stageName) + ', then pull them into this bracket.') + '</p>'}</div>
        </div>
      `;
    }).join('');

    let bracketTables = '';
    if (showBoard) {
      bracketTables = brackets.filter(bracketHasTeams).map(function (b) {
        const rows = computeStandings(tournament, state.matches, sport.id, {
          categoryId: division.id,
          bracketId: b.id,
          teamIds: bracketTeamIds(b),
          stageId: stageId,
          useTeams: true
        });
        const viewing = bracket && bracket.id === b.id;
        return `
          <section class="t-section">
            <div class="t-section-header"><h2 class="t-section-title">Points table <small>${escapeHtml(b.name || 'Bracket')}${viewing ? ' · schedule open' : ''}${bracketIsComplete(b) ? ' · Complete' : ''} · ${escapeHtml(stageName)}</small></h2></div>
            <div class="t-card"><div class="t-card-body">${standingsTableHtml(tournament, sport.id, rows, division, b.id, 'No ' + (b.name || 'bracket') + ' matches completed yet.', stageId)}</div></div>
          </section>
        `;
      }).join('');
    }
    const rankingRows = showBoard ? computeStageRanking(tournament, state.matches, sport, division, stageId) : [];
    const populatedGroups = brackets.filter(bracketHasTeams);
    const stageComplete = stageMarked;

    const scheduleBlock = brackets.length ? `
      <section class="t-section" id="tScheduleSection">
        <div class="t-section-header">
          <h2 class="t-section-title">Schedule <small>${escapeHtml(stageName)}</small></h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${scheduleBracketPickerHtml(brackets, viewingAllSchedules ? ALL_SCHEDULES : (bracket ? bracket.id : ''), { allowAll: isAdminUi() })}
            <div id="tScheduleActions" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
          </div>
        </div>
        <div class="t-card"><div class="t-card-body" id="tScheduleBody"><p class="t-empty">Loading…</p></div></div>
      </section>
    ` : `
      <section class="t-section">
        <div class="t-card"><div class="t-card-body t-mode-note" style="margin:0;">
          ${entryStage
            ? 'Once the teams are in, create a bracket and pull teams into it. The schedule for those teams lives in that bracket.'
            : (stageLocked
              ? escapeHtml(prevStage ? prevStage.name : 'The previous stage') + ' must be marked complete before you can start ' + escapeHtml(stageName) + '.'
              : 'Create a bracket from the teams advanced into ' + escapeHtml(stageName) + '. The schedule for those teams lives in that bracket.')}
        </div></div>
      </section>
    `;

    root.innerHTML = `
      ${categoryTabs}
      ${stageSkip}
      ${stageTabs}
      ${stageToolbar}
      ${focusTeam ? teamFocusHtml(tournament, sport, division, focusTeam) : ''}
      ${isAdminUi() ? `
      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">${entryStage
            ? (sport.categoryMode === 'open' ? 'Teams' : escapeHtml(division.name || 'Category')) + ' <small>max ' + clampMaxPlayers(division.maxPlayers) + ' player' + (clampMaxPlayers(division.maxPlayers) === 1 ? '' : 's') + ' · ' + hereCount + ' here</small>'
            : 'Teams in ' + escapeHtml(stageName) + ' <small>' + stageTeams.length + ' advanced' + (prevStage ? ' from ' + escapeHtml(prevStage.name) : '') + ' · seeded by overall ranking · ' + hereCount + ' here</small>'}</h2>
          ${entryStage ? `<button type="button" class="t-btn sm primary" data-act="add-team">➕ Add team</button>` : ''}
        </div>
        ${entryStage ? '<p class="t-mode-note">Mark <b>Here</b> when a team checks in at registration. Use that flag when you schedule games for teams that have arrived.</p>' : '<p class="t-mode-note">' + (stageLocked
          ? escapeHtml(prevStage ? prevStage.name : 'The previous stage') + ' must be marked complete before teams can be advanced into ' + escapeHtml(stageName) + '.'
          : 'These are the teams advanced into ' + escapeHtml(stageName) + ', ordered and tagged as Seed 1, Seed 2, … from the previous stage\'s overall ranking. Create brackets from this list.') + '</p>'}
        <div class="t-rosters-grid">${teamCards || '<div class="t-empty">' + (entryStage ? 'No teams yet. Add a team with its name and player names.' : (stageLocked
          ? 'Locked until ' + escapeHtml(prevStage ? prevStage.name : 'the previous stage') + ' is marked complete.'
          : 'No teams advanced into ' + escapeHtml(stageName) + ' yet. Mark the previous stage complete, then use Advance on its overall ranking.')) + '</div>'}</div>
      </section>
      <section class="t-section">
        <div class="t-section-header">
          <h2 class="t-section-title">Brackets <small>${escapeHtml(stageName)} — pull teams in, then schedule inside the bracket</small></h2>
          ${isAdminUi() && !stageLocked ? `<button type="button" class="t-btn sm" data-act="round-robin">↺ Generate round-robin</button>` : ''}
          ${isAdminUi() && !stageLocked ? `<button type="button" class="t-btn sm primary" data-act="add-bracket">➕ Create bracket in ${escapeHtml(stageName)}</button>` : ''}
        </div>
        <p class="t-mode-note">${stageLocked
          ? escapeHtml(prevStage ? prevStage.name : 'The previous stage') + ' must be marked complete before ' + escapeHtml(stageName) + ' can start.'
          : (entryStage
            ? 'A team can sit in one bracket of ' + escapeHtml(stageName) + '. After this stage is marked complete, Advance sends a team to ' + escapeHtml(nextStage ? nextStage.name : 'the next stage') + ', seeded in that rank order.'
            : 'Brackets in ' + escapeHtml(stageName) + ' are filled from the teams advanced into this stage. A team can sit in one bracket here, and in a different bracket in another stage.')
          }${isAdminUi() ? ' After you pull a team in, give it a short tag for the schedule. Tags stay on this admin page only.' : ''}</p>
        <div class="t-bracket-grid">${bracketCards || '<div class="t-empty">No brackets in ' + escapeHtml(stageName) + ' yet.' + (isAdminUi() && !stageLocked ? ' <button type="button" class="t-btn sm primary" data-act="add-bracket">➕ Create bracket in ' + escapeHtml(stageName) + '</button>' : '') + '</div>'}</div>
      </section>
      ${scheduleBlock}
      ` : ''}
      ${showBoard ? `
        ${tournamentHasStarted(tournament) ? '' : '<p class="t-mode-note">Members see this board after you start the tournament. You can score matches before that.</p>'}
        <section class="t-section" id="tUpcomingSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">${isAdminUi() ? 'Schedule <small>' + escapeHtml(stageName) + ' · ordered by date and time · Upcoming marks the Matches summary</small>' : 'Schedule <small>' + escapeHtml(stageName) + '</small>'}</h2></div>
          <div class="t-match-list" id="tUpcomingList"></div>
        </section>
        ${bracketTables}
        <section class="t-section">
          <div class="t-section-header">
            <h2 class="t-section-title">Overall ranking <small>${escapeHtml(stageName)}${stageComplete ? ' · Stage complete' : ''}${rankingIdsForStage(division, stageId).length ? ' · Edited' : ''}</small></h2>
            ${isAdminUi() && rankingIdsForStage(division, stageId).length ? '<button type="button" class="t-btn sm" data-act="reset-ranking" data-from="' + escapeHtml(stageId) + '">Reset ranking</button>' : ''}
          </div>
          <p class="t-mode-note">${populatedGroups.length
            ? 'This ranking is across every group in ' + escapeHtml(stageName) + '.'
            : 'This ranking is for every team in ' + escapeHtml(stageName) + '.'}
            ${isAdminUi() ? ' Use ↑↓ to change the order.' : ''}
            ${nextStage
              ? (stageMarked
                ? ' Advance uses this order to seed ' + escapeHtml(nextStage.name) + ' — rank 2 and rank 6 become Seed 1 and Seed 2.'
                : ' Mark this stage complete after every match is finished. Then Advance can seed ' + escapeHtml(nextStage.name) + '.')
              : ''}</p>
          <div class="t-card"><div class="t-card-body">${standingsTableHtml(tournament, sport.id, rankingRows, division, '', emptyStage, stageId)}</div></div>
        </section>
        ${categoryWinnerEditorHtml(tournament, sport, division)}
        ${isAdminUi() ? `
        <section class="t-section" id="tCompletedSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Completed</h2></div>
          <div class="t-match-list" id="tCompletedList"></div>
        </section>
        <section class="t-section" id="tPlayoffsSection" style="display:none;">
          <div class="t-section-header"><h2 class="t-section-title">Playoffs</h2></div>
          <div class="t-bracket" id="tPlayoffs"></div>
        </section>
        ` : ''}
      ` : `
        <section class="t-section"><div class="t-card"><div class="t-card-body t-mode-note" style="margin:0;">Point tables and upcoming matches appear once an admin starts the tournament.</div></div></section>
      `}
    `;

    bindCategoryWorkspace(root, tournament, sport, division, stageId);

    if (viewingAllSchedules) renderCombinedSchedule(tournament, sport, division, stageId);
    else if (bracket) renderScheduleFor(tournament, sport, { division: division, bracket: bracket });
    if (showBoard) {
      const pool = state.matches.filter(function (m) {
        if (m.sport !== sport.id || m.categoryId !== division.id) return false;
        if ((m.stage || 'league') !== stageId) return false;
        return categoryMatchVisible(sport, m);
      });
      const upcoming = pool.filter(function (m) { return m && m.status === 'scheduled'; }).sort(sortMatches);
      const completed = pool.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse();
      fillMatchList('tUpcomingList', 'tUpcomingSection', upcoming, tournament);
      fillMatchList('tCompletedList', 'tCompletedSection', completed, tournament, { compact: true });
      renderPlayoffsFor(tournament, sport.id, pool);
    }
  }

  function bindCategoryWorkspace(root, tournament, sport, division, stageId) {
    function go(extra) {
      navigate(Object.assign({
        view: 'tournament',
        tournamentId: tournament.id,
        sportId: sport.id,
        categoryId: division.id,
        stageId: stageId || 'league'
      }, extra || {}));
    }
    root.querySelectorAll('[data-act="select-category"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const nextId = btn.getAttribute('data-category');
        const nextDiv = findDivision(sport, nextId);
        navigate({
          view: 'tournament',
          tournamentId: tournament.id,
          sportId: sport.id,
          categoryId: nextId,
          stageId: resolveDivisionStageId(sport, nextDiv, stageId)
        });
      });
    });
    root.querySelectorAll('[data-stage-enabled]').forEach(function (input) {
      input.addEventListener('change', function () {
        setDivisionStageEnabled(
          tournament.id,
          sport.id,
          division.id,
          input.getAttribute('data-stage-enabled'),
          input.checked
        );
      });
    });
    root.querySelectorAll('[data-act="select-stage"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go({ stageId: btn.getAttribute('data-stage') });
      });
    });
    root.querySelectorAll('[data-act="toggle-skip-stage"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-stage');
        const skipped = btn.getAttribute('data-skipped') === '1';
        setCategoryStageSkipped(tournament.id, sport.id, division.id, id, !skipped);
      });
    });
    root.querySelectorAll('[data-act="advance-team"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setTeamAdvanced(
          tournament.id,
          sport.id,
          division.id,
          btn.getAttribute('data-from') || stageId,
          btn.getAttribute('data-team'),
          btn.getAttribute('data-on') !== '0'
        );
      });
    });
    root.querySelectorAll('[data-act="rank-up"], [data-act="rank-down"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        moveStageRank(
          tournament.id,
          sport.id,
          division.id,
          btn.getAttribute('data-from') || stageId,
          btn.getAttribute('data-team'),
          btn.getAttribute('data-act') === 'rank-up' ? -1 : 1
        );
      });
    });
    root.querySelectorAll('[data-act="reset-ranking"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        resetStageRanking(tournament.id, sport.id, division.id, btn.getAttribute('data-from') || stageId);
      });
    });
    root.querySelectorAll('[data-act="set-winner"], [data-act="set-runner"]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        setCategoryPlace(
          tournament.id,
          sport.id,
          division.id,
          sel.getAttribute('data-act') === 'set-winner' ? 'winnerId' : 'runnerId',
          sel.value
        );
      });
    });
    root.querySelectorAll('[data-act="clear-winner"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setCategoryPlace(tournament.id, sport.id, division.id, 'clear', '');
      });
    });
    root.querySelectorAll('[data-act="drop-stage-team"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const prev = previousStageBefore(sport, division, stageId);
        if (!prev) return toast('This is the first stage for this category.', 'error');
        setTeamAdvanced(tournament.id, sport.id, division.id, prev.id, btn.getAttribute('data-team'), false);
      });
    });
    bindTeamHereButtons(root, tournament, sport.id);
    root.querySelectorAll('[data-act="add-team"]').forEach(function (btn) {
      btn.addEventListener('click', function () { openEntryTeam(tournament.id, sport.id, division.id, ''); });
    });
    root.querySelectorAll('[data-act="edit-team"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openEntryTeam(tournament.id, sport.id, division.id, btn.getAttribute('data-team'));
      });
    });
    root.querySelectorAll('[data-act="delete-team"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        removeEntryTeam(tournament.id, sport.id, division.id, btn.getAttribute('data-team'));
      });
    });
    root.querySelectorAll('[data-act="open-team"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const teamId = btn.getAttribute('data-team');
        const owned = bracketForTeam(division, teamId, stageId);
        go({ teamId: teamId, bracketId: owned ? owned.id : '', stageId: stageId });
      });
    });
    root.querySelectorAll('[data-open-team]').forEach(function (node) {
      node.addEventListener('click', function (e) {
        if (e.target.closest('button, a, input, select, label')) return;
        const teamId = node.getAttribute('data-open-team');
        const owned = bracketForTeam(division, teamId, stageId);
        const rowBracket = node.getAttribute('data-bracket');
        go({ teamId: teamId, bracketId: rowBracket || (owned ? owned.id : ''), stageId: stageId });
      });
    });
    root.querySelectorAll('[data-act="close-team"]').forEach(function (btn) {
      btn.addEventListener('click', function () { go({}); });
    });
    root.querySelectorAll('[data-act="add-bracket"]').forEach(function (btn) {
      btn.addEventListener('click', function () { addBracket(tournament.id, sport.id, division.id, stageId); });
    });
    root.querySelectorAll('[data-act="round-robin"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        promptRoundRobin(tournament.id, sport.id, division.id, stageId, parseUrl().bracketId || '');
      });
    });
    root.querySelectorAll('[data-act="toggle-complete"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-bracket');
        const target = findBracket(division, id);
        setBracketComplete(tournament.id, sport.id, division.id, id, !(target && target.complete));
      });
    });
    root.querySelectorAll('[data-act="toggle-stage-complete"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setStageComplete(tournament.id, sport.id, division.id, stageId, btn.getAttribute('data-on') !== '0');
      });
    });
    root.querySelectorAll('[data-act="add-bracket-after"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        addBracket(tournament.id, sport.id, division.id, stageId, btn.getAttribute('data-bracket'));
      });
    });
    root.querySelectorAll('[data-act="move-bracket"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        moveBracket(tournament.id, sport.id, division.id, btn.getAttribute('data-bracket'), parseInt(btn.getAttribute('data-dir'), 10));
      });
    });
    root.querySelectorAll('[data-act="select-bracket"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        go({ bracketId: btn.getAttribute('data-bracket') });
      });
    });
    root.querySelectorAll('[data-act="schedule-bracket"]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        go({ bracketId: sel.value || '' });
      });
    });
    root.querySelectorAll('[data-act="delete-bracket"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeBracket(tournament.id, sport.id, division.id, btn.getAttribute('data-bracket'));
      });
    });
    root.querySelectorAll('[data-rename-bracket]').forEach(function (input) {
      input.addEventListener('change', function () {
        renameBracket(tournament.id, sport.id, division.id, input.getAttribute('data-rename-bracket'), input.value);
      });
      input.addEventListener('click', function (e) { e.stopPropagation(); });
    });
    root.querySelectorAll('[data-bracket-walkover]').forEach(function (input) {
      input.addEventListener('change', function () {
        setBracketWalkoverPoints(
          tournament.id,
          sport.id,
          division.id,
          input.getAttribute('data-bracket-walkover'),
          input.value
        );
      });
      input.addEventListener('click', function (e) { e.stopPropagation(); });
    });
    root.querySelectorAll('[data-bracket-team]').forEach(function (box) {
      box.addEventListener('change', function () {
        toggleBracketTeam(tournament.id, sport.id, division.id, box.getAttribute('data-bracket'), box.getAttribute('data-team'), box.checked);
      });
    });
    root.querySelectorAll('[data-bracket-tag]').forEach(function (input) {
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      input.addEventListener('change', function (e) {
        e.stopPropagation();
        setBracketTeamTag(
          tournament.id,
          sport.id,
          division.id,
          input.getAttribute('data-bracket'),
          input.getAttribute('data-team'),
          input.value
        );
      });
    });
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
        ? formatCaptainHtml(team.captainName || team.captainEmail || '(captain)')
          + (team.captainUid
              ? ''
              : ' <span class="t-badge nologin" style="margin-left:4px;font-size:.65rem;">no login yet</span>')
        : '<span style="color:var(--t-muted);">Not assigned</span>';
      const rosterCount = rosterCountOf(team);
      const atCap = isRosterAtCap(sport, team);
      const overCap = maxRosterSize(sport) > 0 && rosterCount > maxRosterSize(sport);
      const isMine = isCaptainOf(team) || isRosterMemberOf(team);
      const canManage = isAdminUi();
      const locked = isRosterLocked(team);
      const canView = canViewRoster(tournament, team);
      const canEdit = canEditRoster(team);
      const lockChip = locked
        ? '<span class="t-badge locked" title="Locked ' + escapeHtml(team.lockedAt || '') + '">🔒 Locked</span>'
        : '<span class="t-badge unlocked">🔓 Open</span>';
      return `
        <div class="t-roster-card ${locked ? 'is-locked' : ''} ${teamIsHere(team) ? 'is-here' : ''}" style="--team-color:${meta.color || '#3b82f6'}">
          <div class="t-roster-card-head">
            <div class="t-roster-team">
              <span class="t-roster-dot" style="background:${meta.color || '#3b82f6'};"></span>
              <div>
                <div class="t-roster-name">${escapeHtml(teamPublicName(team))}${isMine ? ' <span class="t-badge you">Your team</span>' : ''} ${lockChip}</div>
                ${team.id && teamPublicName(team) !== team.id ? '<div class="t-roster-sub">' + escapeHtml(team.id) + '</div>' : ''}
                ${teamTagsHtml(team.tags)}
              </div>
            </div>
            <div class="t-here-row">
              ${teamHereControlsHtml(team)}
              ${canManage ? `<button class="t-btn sm" onclick="window.__tournament.openCaptainPicker('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">${captainAssigned ? 'Change captain' : 'Assign captain'}</button>` : ''}
            </div>
          </div>
          <div class="t-roster-card-body">
            <div class="t-roster-line"><span class="lbl">Captain</span><span class="val">${captainName}</span></div>
            <div class="t-roster-line"><span class="lbl">Members</span><span class="val ${overCap ? 'is-over' : ''}"><b>${canView ? rosterCountLabel(sport, team) : '—'}</b></span></div>
            ${overCap && canView ? '<div class="t-roster-hidden">Over the limit — remove members to get to ' + maxRosterSize(sport) + '.</div>' : ''}
            ${!canView ? '<div class="t-roster-hidden">' + escapeHtml(whyCantView(tournament, team)) + '</div>' : ''}
          </div>
          <div class="t-roster-card-foot">
            ${canView ? `<button class="t-btn sm" onclick="window.__tournament.openRoster('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">View roster</button>` : ''}
            ${canEdit && !atCap ? `<button class="t-btn sm primary" onclick="window.__tournament.openMemberPicker('${tournament.id}','${sport.id}','${escapeHtml(team.id)}')">➕ Add member</button>` : ''}
            ${canEdit && atCap ? '<span class="t-badge locked">Roster full</span>' : ''}
            ${canManage ? `<button class="t-btn sm ${locked ? 'warn' : ''}" onclick="window.__tournament.setRosterLock('${tournament.id}','${sport.id}','${escapeHtml(team.id)}',${!locked})">${locked ? '🔓 Unlock' : '🔒 Lock roster'}</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
    bindTeamHereButtons(wrap, tournament, sport.id);
  }

  function renderStandingsFor(tournament, sportId) {
    const wrap = document.getElementById('tStandings');
    if (!wrap) return;
    const sport = getSportConfig(tournament, sportId);
    const stages = stageListFor(sport);
    const who = tournament.format === 'teams' ? 'Team' : 'Player / Pair';
    wrap.innerHTML = stages.map(function (st) {
      const rows = computeStandings(tournament, state.matches, sportId, { stageId: st.id });
      const body = !rows.length
        ? '<p class="t-empty">No ' + escapeHtml(st.name || 'stage') + ' matches completed yet.</p>'
        : `
          <table class="t-standings-table">
            <thead>
              <tr><th>#</th><th>${who}</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">Pts</th></tr>
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
                          ${teamTagsHtml(meta.tags)}
                        </div>
                      </div>
                    </td>
                    <td class="num">${r.played}</td>
                    <td class="num">${r.won}</td>
                    <td class="num">${r.drawn || 0}</td>
                    <td class="num">${r.lost}</td>
                    <td class="num">${r.points}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
      return `<h3 class="t-stage-standing-title">${escapeHtml(st.name || st.id)}</h3>${body}`;
    }).join('');
  }

  function visibleMatchesFor(tournament, sportId) {
    const sport = getSportConfig(tournament, sportId);
    return state.matches.filter(function (m) {
      if (m.sport !== sportId) return false;
      if (isAdminUi()) return true;
      if (m.categoryId || m.bracketId) return categoryMatchVisible(sport, m);
      if (m.fromSchedule || m.scheduleEntryId) return scheduleIsPublished(sport);
      return true;
    });
  }

  function renderMatchListsFor(tournament, sportId) {
    const scoped = visibleMatchesFor(tournament, sportId);
    const live = scoped.filter(function (m) { return m.status === 'in_progress'; }).sort(sortMatches);
    const upcoming = scheduledMatchesForBoard(scoped);
    const completed = scoped.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse();
    fillMatchList('tLiveList', 'tLiveSection', live, tournament);
    fillMatchList('tUpcomingList', 'tUpcomingSection', upcoming, tournament);
    fillMatchList('tCompletedList', 'tCompletedSection', completed, tournament, { compact: true });
  }

  function renderPlayoffsFor(tournament, sportId, preset) {
    const source = Array.isArray(preset) ? preset : visibleMatchesFor(tournament, sportId);
    const scoped = source.filter(function (m) { return m.stage !== 'league'; });
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
      items.forEach(function (m) { body.appendChild(matchWithActions(m, tournament, { canEdit: isAdminUi() })); });
      return card;
    };
    const sportCfg = getSportConfig(tournament, sportId);
    const stages = stageListFor(sportCfg).filter(function (st) { return st.id !== 'league'; });
    const known = {};
    stages.forEach(function (st) { known[st.id] = true; });
    stages.forEach(function (st) {
      const items = scoped.filter(function (m) { return m.stage === st.id; });
      if (!items.length) return;
      wrap.appendChild(section(st.name || st.id, items));
    });
    if (sportCfg && sportCfg.hasThirdPlace === false) {
      const orphan = scoped.filter(function (m) { return m.stage === 'third_place'; });
      if (orphan.length) wrap.appendChild(section('3rd Place (disabled — clean up)', orphan));
    }
    const other = scoped.filter(function (m) { return m.stage && !known[m.stage] && m.stage !== 'third_place'; });
    if (other.length) wrap.appendChild(section('Other stages', other));
  }

  function scheduledMatchesForBoard(list) {
    return (list || []).filter(function (m) {
      if (!m || m.status !== 'scheduled') return false;
      if (isAdminUi()) return true;
      return !!m.showUpcoming;
    }).sort(sortMatches);
  }

  function sortMatches(a, b) {
    const timed = sortByScheduledTime(a, b);
    if (timed) return timed;
    return (a.createdAt && a.createdAt.seconds || 0) - (b.createdAt && b.createdAt.seconds || 0);
  }

  function fillMatchList(listId, sectionId, matches, tournament, opts) {
    const sec = document.getElementById(sectionId);
    const list = document.getElementById(listId);
    if (!sec || !list) return;
    if (!matches.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    list.innerHTML = '';
    matches.forEach(function (m) { list.appendChild(matchWithActions(m, tournament, Object.assign({ canEdit: isAdminUi() }, opts || {}))); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MATCH CARD RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function renderMatchHeadline(match, tournament, opts) {
    opts = opts || {};
    const sport = getSportConfig(tournament, match.sport);
    const p = participantsOf(match, tournament);
    const aMeta = teamMeta(tournament, match.sport, p.a);
    const bMeta = teamMeta(tournament, match.sport, p.b);
    const division = findDivision(sport, match.categoryId);
    const stageId = match.stage || 'league';
    const s = matchScoreDisplay(match, tournament);
    const aWin = match.winner === 'A';
    const bWin = match.winner === 'B';
    return `
      <div class="t-match-head">
        <div class="t-match-meta">
          <span class="t-badge stage-${escapeHtml(match.stage || '')}">${escapeHtml(stageLabelOf(sport, match.stage))}</span>
          ${resultKind(match) === 'walkover' ? '<span class="t-badge">Walkover</span>' : ''}
          ${resultKind(match) === 'no_result' ? '<span class="t-badge">No result</span>' : ''}
          ${resultKind(match) === 'draw' ? '<span class="t-badge">Draw</span>' : ''}
          ${match.categoryId ? '<span class="t-badge">' + escapeHtml((function () { const d = findDivision(sport, match.categoryId); return (d && d.name) || 'Category'; })()) + '</span>' : ''}
          ${match.bracketId ? '<span class="t-badge">' + escapeHtml((function () { const d = findDivision(sport, match.categoryId); const b = findBracket(d, match.bracketId); return (b && b.name) || 'Bracket'; })()) + '</span>' : ''}
          <span class="t-badge status-${match.status || 'scheduled'}">${escapeHtml(STATUS_LABEL[match.status] || 'Scheduled')}</span>
          ${match.status === 'scheduled' && match.showUpcoming ? '<span class="t-badge upcoming">Upcoming</span>' : ''}
          ${match.scorerName ? '<span class="t-badge scorer">Scorer: ' + escapeHtml(match.scorerName) + '</span>' : ''}
          ${courtOf(match) ? '<span class="t-badge">🏟 ' + escapeHtml(courtOf(match)) + '</span>' : ''}
          ${match.scheduledAt ? '<span class="t-badge">🕒 ' + escapeHtml(fmtDateTime(match.scheduledAt)) + '</span>' : ''}
        </div>
      </div>
      <div class="t-match-body">
        <div class="t-match-team ${aWin ? 'winner' : ''}">
          <span class="avatar" style="--team-color:${aMeta.color}">${escapeHtml((aMeta.id || aMeta.name || 'A').slice(0, 2).toUpperCase())}</span>
          <div class="info">
            <div class="name">${match.categoryId && p.a ? '<button type="button" class="t-text-btn" onclick="event.stopPropagation();window.__tournament.navigate({view:\'tournament\',tournamentId:\'' + tournament.id + '\',sportId:\'' + match.sport + '\',categoryId:\'' + match.categoryId + '\',bracketId:\'' + (match.bracketId || '') + '\',teamId:\'' + p.a + '\',stageId:\'' + (match.stage || '') + '\'})">' + escapeHtml(aMeta.name) + '</button>' : escapeHtml(aMeta.name)}</div>
            ${aMeta.wards ? '<div class="wards">' + escapeHtml(aMeta.wards) + '</div>' : ''}
            ${teamLabelsHtml(aMeta.tags, stageSeedOf(division, sport, stageId, p.a))}
            ${matchSideAckHtml(match, tournament, 'A')}
          </div>
        </div>
        <div class="t-match-score">${(opts && opts.hideScore) || match.status === 'scheduled'
          ? '<span class="dash">vs</span>'
          : (s.label === 'Points'
            ? '<span class="sets">' + escapeHtml(racketSetScoreLine(match, tournament)) + '</span>'
            : '<span>' + s.a + '</span><span class="dash">–</span><span>' + s.b + '</span>')}</div>
        <div class="t-match-team right ${bWin ? 'winner' : ''}">
          <div class="info">
            <div class="name">${match.categoryId && p.b ? '<button type="button" class="t-text-btn" onclick="event.stopPropagation();window.__tournament.navigate({view:\'tournament\',tournamentId:\'' + tournament.id + '\',sportId:\'' + match.sport + '\',categoryId:\'' + match.categoryId + '\',bracketId:\'' + (match.bracketId || '') + '\',teamId:\'' + p.b + '\',stageId:\'' + (match.stage || '') + '\'})">' + escapeHtml(bMeta.name) + '</button>' : escapeHtml(bMeta.name)}</div>
            ${bMeta.wards ? '<div class="wards">' + escapeHtml(bMeta.wards) + '</div>' : ''}
            ${teamLabelsHtml(bMeta.tags, stageSeedOf(division, sport, stageId, p.b))}
            ${matchSideAckHtml(match, tournament, 'B')}
          </div>
          <span class="avatar" style="--team-color:${bMeta.color}">${escapeHtml((bMeta.id || bMeta.name || 'B').slice(0, 2).toUpperCase())}</span>
        </div>
      </div>
    `;
  }

  function renderRacketDetail(match, tournament) {
    const sport = getSportConfig(tournament, match.sport);
    const rows = racketGamesForMatch(match, tournament, sport).map(function (g) {
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

  function matchScorerSelect(match, tournament) {
    const scorers = availableMatchScorers(tournament);
    const known = scorers.some(function (scorer) { return scorer.uid === match.scorerUid; });
    const options = ['<option value="">No scorer assigned</option>'];
    if (match.scorerUid && !known) {
      options.push('<option value="' + escapeHtml(match.scorerUid) + '" selected>'
        + escapeHtml(match.scorerName || match.scorerEmail || 'Unavailable scorer') + ' (role removed)</option>');
    }
    scorers.forEach(function (scorer) {
      const label = (scorer.name || scorer.email || 'Registered scorer') + (scorer.admin ? ' (Admin)' : '');
      options.push('<option value="' + escapeHtml(scorer.uid) + '"' + (scorer.uid === match.scorerUid ? ' selected' : '') + '>'
        + escapeHtml(label) + '</option>');
    });
    const emptyHint = scorers.length
      ? ''
      : '<span class="t-mode-note" style="margin:0;">No scorers loaded yet. Admins should appear here so they can be assigned to the game.</span>';
    return `<label class="t-match-scorer"><span>Match scorer</span><select class="t-select sm" data-scorer-select>${options.join('')}</select><button type="button" class="t-btn sm" data-act="tournament-scorers">Choose tournament scorers</button>${emptyHint}</label>`;
  }

  async function assignMatchScorer(match, tournament, uid) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    if (match.status === 'completed') return toast('A completed match cannot be assigned to a scorer.', 'error');
    const scorer = availableMatchScorers(tournament).find(function (item) { return item.uid === uid; }) || null;
    if (uid && !scorer) return toast('Choose a registered scorer.', 'error');
    const patch = {
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: (state.user && state.user.email) || ''
    };
    if (scorer) {
      patch.scorerUid = scorer.uid;
      patch.scorerName = scorer.name || scorer.email || 'Scorer';
      patch.scorerEmail = scorer.email || '';
    } else {
      patch.scorerUid = FieldValue.delete();
      patch.scorerName = FieldValue.delete();
      patch.scorerEmail = FieldValue.delete();
    }
    try {
      if (scorer) await ensureTournamentHasScorer(tournament, scorer);
      await db.collection('tournament_matches').doc(match.id).update(patch);
      toast(scorer ? 'Match assigned to ' + patch.scorerName : 'Match scorer cleared');
    } catch (err) {
      console.error(err);
      toast('Could not assign scorer: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function matchWithActions(match, tournament, opts) {
    opts = opts || {};
    const classes = ['t-match'];
    if (match.status === 'in_progress') classes.push('live');
    if (match.status === 'completed') classes.push('completed');
    const node = el('div', { class: classes.join(' ') });
    node.innerHTML = renderMatchHeadline(match, tournament, opts) + ((opts.compact || match.status === 'scheduled') ? '' : renderMatchDetail(match, tournament));
    const adminCanEdit = !!opts.canEdit;
    const scorerCanEdit = !adminCanEdit && canScoreMatch(match);
    if (adminCanEdit || scorerCanEdit) {
      const actions = el('div', { class: 't-match-details', style: { borderTop: '1px solid var(--t-border)', paddingTop: '12px' } });
      const btns = [];
      if (scorerCanEdit) {
        btns.push('<button class="t-btn primary sm" data-act="score">🎯 Enter scores</button>');
        btns.push('<button class="t-btn sm" data-act="complete">✔ Mark complete</button>');
      } else {
        if (match.status === 'scheduled') {
          const startBlock = match.categoryId
            ? stageStartBlockedReason(getSportConfig(tournament, match.sport), findDivision(getSportConfig(tournament, match.sport), match.categoryId), match.stage || 'league')
            : '';
          btns.push(startBlock
            ? '<button class="t-btn sm" disabled title="' + escapeHtml(startBlock) + '">▶ Start after previous stage</button>'
            : '<button class="t-btn success sm" data-act="start">▶ Start match</button>');
          btns.push('<button class="t-btn sm" data-act="schedule">📅 Reschedule</button>');
          btns.push(match.showUpcoming
            ? '<button class="t-btn sm" data-act="upcoming">Remove from upcoming</button>'
            : '<button class="t-btn sm" data-act="upcoming">Show in Upcoming</button>');
        } else if (match.status === 'in_progress') {
          btns.push('<button class="t-btn primary sm" data-act="score">🎯 Enter scores</button>');
          btns.push('<button class="t-btn sm" data-act="complete">✔ Mark complete</button>');
          btns.push('<button class="t-btn sm" data-act="reopen">↺ Back to scheduled</button>');
        } else {
          btns.push('<button class="t-btn primary sm" data-act="score">✏ Edit scores</button>');
          btns.push('<button class="t-btn sm" data-act="reopen">↺ Reopen</button>');
        }
        btns.push('<button class="t-btn sm" data-act="court">' + (courtOf(match) ? 'Change court' : 'Set court') + '</button>');
        btns.push('<button class="t-btn sm" data-act="draw">Draw</button>');
        btns.push('<button class="t-btn sm" data-act="walkover">Walkover</button>');
        btns.push('<button class="t-btn sm" data-act="noresult">No result</button>');
        // Delete is always available to admins, regardless of match status.
        btns.push('<button class="t-btn danger sm" data-act="delete">🗑 Delete</button>');
      }
      actions.innerHTML = (adminCanEdit && match.status !== 'completed'
        ? matchScorerSelect(match, tournament)
        : '') + '<div class="t-match-action-buttons">' + btns.join(' ') + '</div>';
      const scorerSelect = actions.querySelector('[data-scorer-select]');
      if (scorerSelect) {
        scorerSelect.addEventListener('click', function (e) { e.stopPropagation(); });
        scorerSelect.addEventListener('change', function (e) {
          e.stopPropagation();
          assignMatchScorer(match, tournament, scorerSelect.value);
        });
      }
      actions.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          handleMatchAction(match, tournament, btn.getAttribute('data-act'));
        });
      });
      node.appendChild(actions);
    }
    bindMatchAckButtons(node, match, tournament);
    return node;
  }

  async function handleMatchAction(match, tournament, act) {
    try {
      if (!isAdminUi()) {
        assertCanScoreMatch(match);
        if (act !== 'score' && act !== 'complete') {
          throw new Error('Scorers can enter live scores and mark their assigned match complete only.');
        }
      }
      const ref = db.collection('tournament_matches').doc(match.id);
      const sport = getSportConfig(tournament, match.sport);
      if (act === 'tournament-scorers') {
        return openTournamentScorers(tournament.id);
      }
      if (act === 'delete') {
        const p = participantsOf(match, tournament);
        const label = displayName(tournament, match.sport, p.a) + ' vs ' + displayName(tournament, match.sport, p.b);
        const warn = match.status === 'completed'
          ? '\n\nThis match is COMPLETED. Deleting it will remove it from standings and cannot be undone.'
          : match.status === 'in_progress'
            ? '\n\nThis match is LIVE. Deleting it will remove all entered scores and cannot be undone.'
            : '\n\nThis cannot be undone.';
        if (!confirm('Delete ' + stageLabelOf(sport, match.stage) + ' — ' + label + '?' + warn)) return;
        await ref.delete();
        if (shouldMirrorPublicMatch(tournament)) {
          try {
            await db.collection('tournament_public').doc(publicBoardDocId(tournament))
              .collection('matches').doc(match.id).delete();
          } catch (publicErr) {
            console.warn('[tournament] public match delete failed:', publicErr);
          }
        }
        toast('Match deleted');
      } else if (act === 'start') {
        if (match.categoryId) {
          const blocked = stageStartBlockedReason(sport, findDivision(sport, match.categoryId), match.stage || 'league');
          if (blocked) return toast(blocked, 'error');
        }
        const update = Object.assign({ status: 'in_progress', updatedAt: FieldValue.serverTimestamp() }, matchCaptainPatch(tournament, match));
        if (sport.kind === 'racket' && (!match.games || !match.games.length)) {
          const bestOf = (getStageScoring(tournament, match.sport, match.stage) || {}).bestOf || 1;
          update.games = racketGamesForMatch(match, tournament, sport).map(function (game) {
            const sets = (game.sets || []).map(function (set) { return { a: set.a || 0, b: set.b || 0 }; });
            while (sets.length < bestOf) sets.push({ a: 0, b: 0 });
            return Object.assign({}, game, { sets: sets });
          });
        }
        if (sport.kind === 'volleyball' && (!match.sets || !match.sets.length)) {
          const bestOf = (getStageScoring(tournament, match.sport, match.stage) || {}).bestOf || 3;
          update.sets = Array.from({ length: bestOf }, function () { return { a: 0, b: 0 }; });
        }
        if (sport.kind === 'basketball' && (!match.quarters || !match.quarters.length)) {
          const total = (getStageScoring(tournament, match.sport, match.stage) || {}).quarters || 4;
          update.quarters = Array.from({ length: total }, function () { return { a: 0, b: 0 }; });
        }
        await updateMatchAndPublicScore(match, tournament, update);
        toast('Match started');
      } else if (act === 'complete') {
        const winner = matchWinner(match, tournament);
        if (!winner && !confirm('No clear winner detected. Mark complete anyway?')) return;
        await updateMatchAndPublicScore(match, tournament, Object.assign({
          status: 'completed',
          winner: winner || null,
          resultType: 'played',
          updatedAt: FieldValue.serverTimestamp()
        }, isAdminUi() ? matchCaptainPatch(tournament, match) : {}));
        toast('Match completed');
      } else if (act === 'draw') {
        await updateMatchAndPublicScore(match, tournament, {
          status: 'completed',
          winner: 'tie',
          resultType: 'draw',
          updatedAt: FieldValue.serverTimestamp()
        });
        toast('Recorded as a draw. Both teams receive the draw points.');
      } else if (act === 'walkover') {
        const sides = participantsOf(match, tournament);
        const aName = displayName(tournament, match.sport, sides.a);
        const bName = displayName(tournament, match.sport, sides.b);
        const woScore = walkoverScoreForMatch(tournament, match);
        const who = prompt('Who showed up and receives the win?\nThe score will be recorded as ' + woScore + '–0.\nEnter 1 for ' + aName + '\nEnter 2 for ' + bName, '1');
        if (who === null) return;
        const choice = String(who).trim().toLowerCase();
        let side = null;
        if (choice === '1' || choice === 'a') side = 'A';
        else if (choice === '2' || choice === 'b') side = 'B';
        else return toast('Enter 1 or 2 for the team that showed up', 'error');
        await updateMatchAndPublicScore(match, tournament, walkoverScorePatch(match, tournament, side));
        const award = tablePointsFor(sport).win;
        const line = side === 'B' ? ('0–' + woScore) : (woScore + '–0');
        toast('Walkover recorded as ' + line + '. ' + (side === 'B' ? bName : aName) + ' receives ' + award + ' win point' + (award === 1 ? '' : 's') + '.');
      } else if (act === 'noresult') {
        if (!confirm('Record a no result? Neither team showed up, so neither team receives points.')) return;
        await updateMatchAndPublicScore(match, tournament, {
          status: 'completed',
          winner: null,
          resultType: 'no_result',
          updatedAt: FieldValue.serverTimestamp()
        });
        toast('No result recorded');
      } else if (act === 'reopen') {
        await updateMatchAndPublicScore(match, tournament, {
          status: 'scheduled',
          winner: null,
          resultType: null,
          updatedAt: FieldValue.serverTimestamp()
        });
        toast('Match reopened');
      } else if (act === 'schedule') {
        const cur = toDatetimeLocal(match.scheduledAt);
        const val = prompt('New date/time (YYYY-MM-DDTHH:mm) — leave blank to clear', cur);
        if (val === null) return;
        await ref.update({ scheduledAt: fromDatetimeLocal(val), updatedAt: FieldValue.serverTimestamp() });
        toast('Schedule updated');
      } else if (act === 'upcoming') {
        const next = !match.showUpcoming;
        await ref.update({ showUpcoming: next, updatedAt: FieldValue.serverTimestamp() });
        rememberLocalMatch(match.id, { showUpcoming: next });
        await mirrorMatchPlan(tournament, match, { showUpcoming: next });
        toast(next ? 'Marked as upcoming' : 'Removed from upcoming');
      } else if (act === 'court') {
        const val = prompt('Court for this match. Leave blank when there is one court, or none.', courtOf(match));
        if (val === null) return;
        const court = String(val).trim();
        await ref.update({ court: court, venue: court, updatedAt: FieldValue.serverTimestamp() });
        await mirrorMatchPlan(tournament, match, { court: court, venue: court });
        toast(court ? 'Court set to ' + court : 'Court cleared');
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

  function scheduleKey(tournamentId, sportId, categoryId, bracketId) {
    return [tournamentId || '', sportId || '', categoryId || '', bracketId || ''].join('|');
  }

  function scheduleTableAttrs(tournament, sport, scope) {
    const ids = scopeIds(scope);
    return 'data-tournament="' + escapeHtml(tournament.id)
      + '" data-sport="' + escapeHtml(sport.id)
      + '" data-category="' + escapeHtml(ids.categoryId)
      + '" data-bracket="' + escapeHtml(ids.bracketId) + '"';
  }

  function tableMatchesScope(table, tournament, sport, scope) {
    if (!table || !tournament || !sport) return false;
    const ids = scopeIds(scope);
    return table.getAttribute('data-tournament') === tournament.id
      && table.getAttribute('data-sport') === sport.id
      && (table.getAttribute('data-category') || '') === ids.categoryId
      && (table.getAttribute('data-bracket') || '') === ids.bracketId;
  }

  function harvestScheduleEditor() {
    const table = document.getElementById('tScheduleEditor');
    if (!table) return;
    const tId = table.getAttribute('data-tournament');
    const sId = table.getAttribute('data-sport');
    if (!tId || !sId) return;
    const categoryId = table.getAttribute('data-category') || '';
    const bracketId = table.getAttribute('data-bracket') || '';
    const key = scheduleKey(tId, sId, categoryId, bracketId);
    const prev = scheduleEditByKey[key] || { entries: [], dirty: false };
    scheduleEditByKey[key] = {
      entries: readScheduleEntriesFromDom(),
      dirty: !!prev.dirty
    };
  }

  function readWorkingEntries(tournament, sport, scope) {
    const table = document.getElementById('tScheduleEditor');
    if (tableMatchesScope(table, tournament, sport, scope)) {
      const entries = readScheduleEntriesFromDom();
      const ids = scopeIds(scope);
      const key = scheduleKey(tournament.id, sport.id, ids.categoryId, ids.bracketId);
      const prev = scheduleEditByKey[key] || { dirty: false };
      scheduleEditByKey[key] = { entries: entries, dirty: !!prev.dirty };
      return entries;
    }
    return workingScheduleEntries(tournament, sport, scope);
  }

  function readScheduleEntriesFromDom() {
    const rows = document.querySelectorAll('#tScheduleEditor tbody tr[data-entry-id]');
    const out = [];
    rows.forEach(function (row) {
      const stageEl = row.querySelector('[data-f="stage"]');
      const aEl = row.querySelector('[data-f="a"]');
      const bEl = row.querySelector('[data-f="b"]');
      const whenEl = row.querySelector('[data-f="when"]');
      const courtEl = row.querySelector('[data-f="court"]') || row.querySelector('[data-f="venue"]');
        const upcomingEl = row.querySelector('[data-f="upcoming"]');
      const whenVal = whenEl ? whenEl.value : '';
      const court = courtEl ? courtEl.value.trim() : '';
      out.push({
        id: row.getAttribute('data-entry-id'),
        stage: stageEl ? stageEl.value : 'league',
        a: aEl ? aEl.value.trim() : '',
        b: bEl ? bEl.value.trim() : '',
        scheduledAt: whenVal ? fromDatetimeLocal(whenVal) : '',
        venue: court,
        court: court,
        showUpcoming: upcomingEl ? !!upcomingEl.checked : row.getAttribute('data-upcoming') === '1',
        matchId: row.getAttribute('data-match-id') || ''
      });
    });
    return out;
  }

  function markScheduleDirty(tournamentId, sportId, categoryId, bracketId) {
    const key = scheduleKey(tournamentId, sportId, categoryId, bracketId);
    const cur = scheduleEditByKey[key] || { entries: [], dirty: false };
    cur.dirty = true;
    scheduleEditByKey[key] = cur;
  }

  function entriesFromMatches(tournament, sportId, categoryId, bracketId) {
    return state.matches
      .filter(function (m) { return entryInScope(m, sportId, categoryId || '', bracketId || ''); })
      .sort(sortMatches)
      .map(function (m) {
        const p = participantsOf(m, tournament);
        return emptyScheduleEntry({
          id: m.scheduleEntryId || m.id,
          stage: m.stage || 'league',
          a: p.a || '',
          b: p.b || '',
          scheduledAt: m.scheduledAt || '',
          venue: courtOf(m),
          court: courtOf(m),
          showUpcoming: !!m.showUpcoming,
          matchId: m.id
        });
      });
  }

  function scheduleRecord(sport, scope) {
    const ids = scopeIds(scope);
    if (!ids.categoryId) return getSchedule(sport);
    const owner = scheduleOwner(sport, ids.categoryId, ids.bracketId);
    return getSchedule(owner);
  }

  function workingScheduleEntries(tournament, sport, scope) {
    const ids = scopeIds(scope);
    const key = scheduleKey(tournament.id, sport.id, ids.categoryId, ids.bracketId);
    const local = scheduleEditByKey[key];
    if (local && local.dirty && Array.isArray(local.entries)) return local.entries;
    const sch = scheduleRecord(sport, scope);
    if (sch.draft && Array.isArray(sch.draft.entries) && sch.draft.entries.length) {
      return sanitizeScheduleEntries(sch.draft.entries);
    }
    if (sch.published && Array.isArray(sch.published.entries) && sch.published.entries.length) {
      return sanitizeScheduleEntries(sch.published.entries);
    }
    const fromMatches = entriesFromMatches(tournament, sport.id, ids.categoryId, ids.bracketId);
    if (fromMatches.length) return fromMatches;
    return [];
  }

  function schedulePlanSignature(entries) {
    return JSON.stringify(sanitizeScheduleEntries(entries).map(function (e) {
      return [e.id, e.stage, e.a, e.b, e.scheduledAt, e.court || '', e.venue || '', e.matchId || ''];
    }));
  }

  function scheduleHasUnpublishedChanges(tournament, sport, scope) {
    const ids = scopeIds(scope);
    const key = scheduleKey(tournament.id, sport.id, ids.categoryId, ids.bracketId);
    const local = scheduleEditByKey[key];
    const sch = scheduleRecord(sport, scope);
    if (!sch.published) {
      if (local && local.dirty && Array.isArray(local.entries)) return !!local.entries.length;
      return !!(sch.draft && (sch.draft.entries || []).length);
    }
    const publishedSig = schedulePlanSignature(sch.published.entries || []);
    if (local && local.dirty && Array.isArray(local.entries)) {
      return schedulePlanSignature(local.entries) !== publishedSig;
    }
    return schedulePlanSignature((sch.draft && sch.draft.entries) || []) !== publishedSig;
  }

  function rememberLocalMatch(matchId, fields) {
    const idx = state.matches.findIndex(function (m) { return m && m.id === matchId; });
    if (idx >= 0) state.matches[idx] = Object.assign({}, state.matches[idx], fields);
  }

  async function applyUpcomingFromEditor(tournament, sport, categoryId, bracketId) {
    harvestScheduleEditor();
    const scope = scheduleScope(categoryId, bracketId, sport);
    const entries = readWorkingEntries(tournament, sport, scope);
    const key = scheduleKey(tournament.id, sport.id, categoryId || '', bracketId || '');
    const cur = scheduleEditByKey[key] || { entries: entries, dirty: false };
    const wasDirty = !!cur.dirty;
    cur.entries = sanitizeScheduleEntries(entries);
    cur.dirty = true;
    cur.dirty = wasDirty && scheduleHasUnpublishedChanges(tournament, sport, scope);
    scheduleEditByKey[key] = cur;
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const match = scheduleEntryMatch(e, sport, scope);
        if (!match) continue;
        if (!!match.showUpcoming === !!e.showUpcoming) continue;
        const next = !!e.showUpcoming;
        await db.collection('tournament_matches').doc(match.id).update({
          showUpcoming: next,
          updatedAt: FieldValue.serverTimestamp()
        });
        rememberLocalMatch(match.id, { showUpcoming: next });
        await mirrorMatchPlan(tournament, Object.assign({}, match, { showUpcoming: next }), { showUpcoming: next });
      }
      render();
    } catch (err) {
      console.error(err);
      toast('Could not update upcoming: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  function participantSelectHtml(tournament, sport, field, selected, teamList, bracket) {
    const teams = teamList || (tournament.format === 'teams' ? teamsFor(tournament, sport) : null);
    if (teams) {
      const opts = ['<option value="">Select team…</option>'].concat(teams.map(function (tm) {
        const label = teamPublicName(tm);
        const tag = scheduleTagOf(bracket, tm.id);
        const tagBit = tag ? ' · ' + tag : '';
        return '<option value="' + escapeHtml(tm.id) + '"' + (tm.id === selected ? ' selected' : '') + '>'
          + escapeHtml(label) + escapeHtml(tagBit) + escapeHtml(teamHereSuffix(tm))
          + '</option>';
      }));
      return '<select class="t-select" data-f="' + field + '">' + opts.join('') + '</select>';
    }
    return '<input type="text" class="t-input" data-f="' + field + '" value="' + escapeHtml(selected || '') + '" placeholder="Player / pair" />';
  }

  function scheduleSideHtml(tournament, sport, teamId, bracket) {
    const found = findEntryTeam(tournament, sport.id, teamId);
    return '<b>' + escapeHtml(displayName(tournament, sport.id, teamId)) + '</b>'
      + escapeHtml(teamHereSuffix(found && found.team))
      + scheduleTagChipHtml(scheduleTagOf(bracket, teamId));
  }

  function scheduleEntryMatch(entry, sport, scope) {
    if (!entry) return null;
    const list = state.matches || [];
    if (entry.matchId) {
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === entry.matchId) return list[i];
      }
    }
    if (!entry.id || !sport) return null;
    const ids = scopeIds(scope);
    for (let i = 0; i < list.length; i++) {
      const match = list[i];
      if (!match || match.scheduleEntryId !== entry.id) continue;
      if (entryInScope(match, sport.id, ids.categoryId, ids.bracketId)) return match;
    }
    return null;
  }

  function scheduleStatusCellHtml(tournament, sport, entry, scope, editable) {
    const match = scheduleEntryMatch(entry, sport, scope);
    const kind = scheduleRowKind(match, tournament);
    if (kind === 'completed') return '<span class="t-badge status-completed">Completed</span>';
    if (kind === 'live') return '<span class="t-badge status-in_progress">Live</span>';
    if (editable) {
      return '<label class="t-check-line"><input type="checkbox" data-f="upcoming" ' + (entry.showUpcoming ? 'checked' : '') + ' /> Upcoming</label>';
    }
    return entry.showUpcoming ? '<span class="t-badge upcoming">Upcoming</span>' : '—';
  }

  function scheduleArgs(tournament, sport, scope) {
    const ids = scopeIds(scope);
    return "'" + tournament.id + "','" + sport.id + "','" + ids.categoryId + "','" + ids.bracketId + "'";
  }

  function renderScheduleFor(tournament, sport, scope) {
    const body = document.getElementById('tScheduleBody');
    const actions = document.getElementById('tScheduleActions');
    if (!body) return;
    scope = scope || {};

    const sch = scheduleRecord(sport, scope);
    const owner = scopeIds(scope).categoryId ? scheduleOwner(sport, scopeIds(scope).categoryId, scopeIds(scope).bracketId) : sport;
    const published = scheduleIsPublished(owner);
    const canEdit = canEditSchedule();
    const entries = canEdit
      ? workingScheduleEntries(tournament, sport, scope)
      : sanitizeScheduleEntries((sch.published && sch.published.entries) || []);
    const ids = scopeIds(scope);
    const pool = ids.categoryId ? teamsInBracket(sport, ids.categoryId, ids.bracketId) : teamsFor(tournament, sport);
    const canGenerate = pool.length >= 2 && (ids.categoryId || tournament.format === 'teams');
    const args = scheduleArgs(tournament, sport, scope);

    if (actions) {
      if (canEdit) {
        const dirty = scheduleHasUnpublishedChanges(tournament, sport, scope);
        actions.innerHTML = `
          ${dirty && published
            ? '<span class="t-badge nologin">Unpublished changes</span>'
            : (published
              ? '<span class="t-badge locked">Published</span>'
              : '<span class="t-badge unlocked">Draft</span>')}
          <button class="t-btn sm" type="button" onclick="window.__tournament.addScheduleRow(${args})">➕ Add match</button>
          ${canGenerate
            ? (ids.categoryId
              ? '<button class="t-btn sm" type="button" onclick="window.__tournament.promptRoundRobin(\'' + tournament.id + '\',\'' + sport.id + '\',\'' + ids.categoryId + '\',\'' + ((scope.bracket && bracketStageId(scope.bracket)) || 'league') + '\',\'' + ids.bracketId + '\')">↺ Generate round-robin</button>'
              : '<button class="t-btn sm" type="button" onclick="window.__tournament.generateLeagueSchedule(' + args + ')">↺ Generate round-robin</button>')
            : ''}
          <button class="t-btn sm" type="button" onclick="window.__tournament.saveScheduleDraft(${args})">💾 Save draft</button>
          <button class="t-btn sm primary" type="button" onclick="window.__tournament.publishSchedule(${args})">📢 Publish</button>
          <button class="t-btn sm danger" type="button" onclick="window.__tournament.clearSchedule(${args})">Clear schedule</button>
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
      body.innerHTML = renderScheduleReadOnly(tournament, sport, entries, sch.published, scope);
      return;
    }

    body.innerHTML = renderScheduleEditor(tournament, sport, entries, sch, scope);
    bindScheduleEditor(tournament, sport);
  }

  function combinedScheduleRows(tournament, sport, division, stageId) {
    const rows = [];
    bracketsInStage(division, stageId).forEach(function (b) {
      const scope = { division: division, bracket: b, categoryId: division.id, bracketId: b.id };
      const sch = scheduleRecord(sport, scope);
      const entries = canEditSchedule()
        ? workingScheduleEntries(tournament, sport, scope)
        : sanitizeScheduleEntries((sch.published && sch.published.entries) || []);
      entries.forEach(function (e) {
        rows.push({ entry: e, bracket: b });
      });
    });
    rows.sort(function (a, b) { return sortByScheduledTime(a.entry, b.entry); });
    return rows;
  }

  function renderCombinedSchedule(tournament, sport, division, stageId) {
    const body = document.getElementById('tScheduleBody');
    const actions = document.getElementById('tScheduleActions');
    if (!body) return;
    if (actions) {
      actions.innerHTML = '<span class="t-mode-note" style="margin:0;">All brackets in this stage. Select a bracket to edit its fixtures.</span>';
    }
    const rows = combinedScheduleRows(tournament, sport, division, stageId);
    if (!rows.length) {
      body.innerHTML = '<div class="t-schedule-empty">No fixtures in this stage yet. Open a bracket to add matches.</div>';
      return;
    }
    const tableRows = rows.map(function (row) {
      const e = row.entry;
      const bracket = row.bracket;
      return `
        <tr>
          <td>${escapeHtml(bracket.name || 'Bracket')}</td>
          <td><span class="t-badge stage-${escapeHtml(e.stage)}">${escapeHtml(stageLabelOf(sport, e.stage))}</span></td>
          <td class="t-schedule-vs">${scheduleSideHtml(tournament, sport, e.a, bracket)} <span>vs</span> ${scheduleSideHtml(tournament, sport, e.b, bracket)}</td>
          <td>${e.scheduledAt ? escapeHtml(fmtDateTime(e.scheduledAt)) : '—'}</td>
          <td>${courtOf(e) ? escapeHtml(courtOf(e)) : '—'}</td>
          <td>${scheduleStatusCellHtml(tournament, sport, e, { division: division, bracket: bracket, categoryId: division.id, bracketId: bracket.id }, false)}</td>
        </tr>
      `;
    }).join('');
    body.innerHTML = `
      <div class="t-schedule-note">Fixtures from every bracket in ${escapeHtml(stageLabelOf(sport, stageId))}, ordered by date and time. Tags are the short labels set on each bracket team.</div>
      <div class="t-schedule-wrap">
        <table class="t-schedule-table">
          <thead><tr><th>Bracket</th><th>Stage</th><th>Match</th><th>When</th><th>Court</th><th>Status</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `;
  }

  function renderScheduleReadOnly(tournament, sport, entries, publishedMeta, scope) {
    if (!entries.length) {
      return '<div class="t-schedule-empty">No fixtures in the published schedule.</div>';
    }
    const bracket = scope && scope.bracket;
    const bracketName = bracket && bracket.name;
    const sorted = sanitizeScheduleEntries(entries);
    const whenNote = publishedMeta && publishedMeta.publishedAt
      ? '<div class="t-schedule-note">Published ' + escapeHtml(fmtDateTime(publishedMeta.publishedAt))
        + (publishedMeta.publishedBy ? ' by ' + escapeHtml(publishedMeta.publishedBy) : '') + '</div>'
      : '';
    const rows = sorted.map(function (e) {
      return `
        <tr>
          ${bracketName ? '<td>' + escapeHtml(bracketName) + '</td>' : ''}
          <td><span class="t-badge stage-${escapeHtml(e.stage)}">${escapeHtml(stageLabelOf(sport, e.stage))}</span></td>
          <td class="t-schedule-vs">${scheduleSideHtml(tournament, sport, e.a, bracket)} <span>vs</span> ${scheduleSideHtml(tournament, sport, e.b, bracket)}</td>
          <td>${e.scheduledAt ? escapeHtml(fmtDateTime(e.scheduledAt)) : '—'}</td>
          <td>${courtOf(e) ? escapeHtml(courtOf(e)) : '—'}</td>
          <td>${scheduleStatusCellHtml(tournament, sport, e, scope, false)}</td>
        </tr>
      `;
    }).join('');
    return `
      ${whenNote}
      <div class="t-schedule-wrap">
        <table class="t-schedule-table">
          <thead><tr>${bracketName ? '<th>Bracket</th>' : ''}<th>Stage</th><th>Match</th><th>When</th><th>Court</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function scheduleStageOptions(sport, scope, current) {
    if (scope && scope.bracket) {
      const id = bracketStageId(scope.bracket);
      return '<option value="' + escapeHtml(id) + '" selected>' + escapeHtml(stageLabelOf(sport, id)) + '</option>';
    }
    return stageListFor(sport).map(function (st) {
      return '<option value="' + escapeHtml(st.id) + '"' + (current === st.id ? ' selected' : '') + '>' + escapeHtml(st.name || st.id) + '</option>';
    }).join('');
  }

  function renderScheduleEditor(tournament, sport, entries, sch, scope) {
    const ids = scopeIds(scope);
    const pool = ids.categoryId ? teamsInBracket(sport, ids.categoryId, ids.bracketId) : null;
    const savedNote = sch.draft && sch.draft.savedAt
      ? 'Last draft saved ' + fmtDateTime(sch.draft.savedAt)
        + (sch.draft.savedBy ? ' by ' + sch.draft.savedBy : '')
      : 'Not saved yet — use Save draft to keep your work.';
    const attrs = scheduleTableAttrs(tournament, sport, scope);
    if (!entries.length) {
      return `
        <div class="t-schedule-empty">
          No fixtures yet. Add a match or generate a round-robin, then <b>Save draft</b>.
          Publish when the schedule is ready for everyone to see.
        </div>
        <div class="t-schedule-note">${escapeHtml(savedNote)}</div>
        <table class="t-schedule-table" id="tScheduleEditor" ${attrs} style="display:none;">
          <tbody></tbody>
        </table>
      `;
    }
    const bracketName = scope && scope.bracket && scope.bracket.name;
    const rows = sanitizeScheduleEntries(entries).map(function (e) {
      const stageOpts = scheduleStageOptions(sport, scope, e.stage);
      return `
        <tr data-entry-id="${escapeHtml(e.id)}" data-match-id="${escapeHtml(e.matchId || '')}" data-upcoming="${e.showUpcoming ? '1' : '0'}">
          ${bracketName ? '<td>' + escapeHtml(bracketName) + '</td>' : ''}
          <td><select class="t-select" data-f="stage">${stageOpts}</select></td>
          <td>${participantSelectHtml(tournament, sport, 'a', e.a, pool, scope && scope.bracket)}</td>
          <td class="t-schedule-vs-cell">vs</td>
          <td>${participantSelectHtml(tournament, sport, 'b', e.b, pool, scope && scope.bracket)}</td>
          <td><input type="datetime-local" class="t-input" data-f="when" value="${escapeHtml(toDatetimeLocal(e.scheduledAt))}" /></td>
          <td><input type="text" class="t-input" data-f="court" value="${escapeHtml(courtOf(e))}" placeholder="Court (optional)" /></td>
          <td class="t-schedule-flag">${scheduleStatusCellHtml(tournament, sport, e, scope, true)}</td>
          <td><button type="button" class="t-btn danger sm" data-remove-row="${escapeHtml(e.id)}">Remove</button></td>
        </tr>
      `;
    }).join('');
    return `
      <div class="t-schedule-note">${escapeHtml(savedNote)} Court is optional — leave it blank when there is one court, or none. Rows with a time sort by date and time. Status shows Live or Completed once the match has started or has scores. Otherwise check Upcoming to list it on the Matches summary — that flag is saved right away.</div>
      <div class="t-schedule-wrap">
        <table class="t-schedule-table" id="tScheduleEditor" ${attrs}>
          <thead>
            <tr>
              ${bracketName ? '<th>Bracket</th>' : ''}
              <th>Stage</th>
              <th>Side A</th>
              <th></th>
              <th>Side B</th>
              <th>When</th>
              <th>Court</th>
              <th>Status</th>
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
    const categoryId = table.getAttribute('data-category') || '';
    const bracketId = table.getAttribute('data-bracket') || '';
    table.addEventListener('input', function (e) {
      if (e.target && e.target.getAttribute('data-f') === 'upcoming') return;
      markScheduleDirty(tournament.id, sport.id, categoryId, bracketId);
    });
    table.addEventListener('change', function (e) {
      if (e.target && e.target.getAttribute('data-f') === 'upcoming') {
        applyUpcomingFromEditor(tournament, sport, categoryId, bracketId);
        return;
      }
      markScheduleDirty(tournament.id, sport.id, categoryId, bracketId);
      if (e.target && e.target.getAttribute('data-f') === 'when') {
        harvestScheduleEditor();
        const key = scheduleKey(tournament.id, sport.id, categoryId, bracketId);
        const cur = scheduleEditByKey[key];
        if (cur && Array.isArray(cur.entries)) {
          cur.entries = sanitizeScheduleEntries(cur.entries);
          scheduleEditByKey[key] = cur;
        }
        renderScheduleFor(tournament, sport, scheduleScope(categoryId, bracketId, sport));
      }
    });
    table.querySelectorAll('[data-remove-row]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeScheduleRow(tournament.id, sport.id, btn.getAttribute('data-remove-row'), categoryId, bracketId);
      });
    });
  }

  function currentScheduleContext(tournamentId, sportId) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    return { t: t, sport: sport };
  }

  function persistLocalEntries(tournamentId, sportId, entries, dirty, categoryId, bracketId) {
    scheduleEditByKey[scheduleKey(tournamentId, sportId, categoryId, bracketId)] = {
      entries: sanitizeScheduleEntries(entries),
      dirty: dirty !== false
    };
  }

  function scheduleScope(categoryId, bracketId, sport) {
    const scope = { categoryId: categoryId || '', bracketId: bracketId || '' };
    if (scope.categoryId && sport) {
      scope.division = findDivision(sport, scope.categoryId);
      scope.bracket = findBracket(scope.division, scope.bracketId);
    }
    return scope;
  }

  function addScheduleRow(tournamentId, sportId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    if (scope.categoryId && !scope.bracket) return toast('Create a bracket and open it before adding matches', 'error');
    const blocked = scheduleStageBlockedReason(sport, scope);
    if (blocked) return toast(blocked, 'error');
    const entries = readWorkingEntries(t, sport, scope).slice();
    const teams = scope.categoryId ? teamsInBracket(sport, scope.categoryId, scope.bracketId) : teamsFor(t, sport);
    const useTeams = matchUsesTeams(t, sport);
    const a = teams[0] ? teams[0].id : '';
    const b = teams[1] ? teams[1].id : '';
    entries.push(emptyScheduleEntry({
      stage: (scope.bracket && bracketStageId(scope.bracket)) || 'league',
      a: useTeams ? a : '',
      b: useTeams ? b : '',
      scheduledAt: sport.date ? new Date(sport.date + 'T18:00:00').toISOString() : ''
    }));
    persistLocalEntries(tournamentId, sportId, entries, true, scope.categoryId, scope.bracketId);
    renderScheduleFor(t, sport, scope);
  }

  function removeScheduleRow(tournamentId, sportId, entryId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    const entries = readWorkingEntries(t, sport, scope).filter(function (e) { return e.id !== entryId; });
    persistLocalEntries(tournamentId, sportId, entries, true, scope.categoryId, scope.bracketId);
    renderScheduleFor(t, sport, scope);
  }

  function promptRoundRobin(tournamentId, sportId, categoryId, stageId, preferredBracketId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    if (!categoryId) return generateLeagueSchedule(tournamentId, sportId, '', '');
    const division = findDivision(sport, categoryId);
    if (!division) return toast('Open a category before generating a round-robin', 'error');
    const stage = stageId || 'league';
    const blocked = stageStartBlockedReason(sport, division, stage);
    if (blocked) return toast(blocked, 'error');
    const stageName = stageLabelOf(sport, stage);
    const all = bracketsInStage(division, stage);
    const open = openBracketsInStage(division, stage);
    if (!all.length) return toast('Create a bracket in ' + stageName + ' before generating a round-robin', 'error');
    if (!open.length) return toast('Every bracket in ' + stageName + ' is marked complete. Reopen one to generate its round-robin.', 'error');
    const { modal, body } = getOrCreateModal('tRoundRobin', 'Generate round-robin — ' + stageName, { wide: false });
    let preferredChosen = false;
    const options = open.map(function (b) {
      const count = (b.teamIds || []).length;
      const ready = count >= 2;
      const prefer = ready && b.id === preferredBracketId && !preferredChosen;
      if (prefer) preferredChosen = true;
      return { b: b, count: count, ready: ready, prefer: prefer };
    });
    let fallbackUsed = false;
    const optionHtml = options.map(function (item) {
      let selected = item.prefer;
      if (!selected && item.ready && !preferredChosen && !fallbackUsed) {
        selected = true;
        fallbackUsed = true;
      }
      return '<option value="' + escapeHtml(item.b.id) + '"' + (item.ready ? '' : ' disabled') + (selected ? ' selected' : '') + '>'
        + escapeHtml(item.b.name || 'Bracket') + ' · ' + item.count + ' team' + (item.count === 1 ? '' : 's')
        + (item.ready ? '' : ' — pull in at least 2')
        + '</option>';
    }).join('');
    body.innerHTML = `
      <p class="t-mode-note" style="margin-top:0;">The round-robin is built from the teams pulled into the bracket you choose, and it is saved on that bracket's schedule. Completed brackets are not listed.</p>
      <div class="t-form-field">
        <label for="tRoundRobinBracket">Bracket</label>
        <select class="t-select" id="tRoundRobinBracket">${optionHtml}</select>
      </div>
      <div class="t-modal-foot" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" class="t-btn" data-cancel>Cancel</button>
        <button type="button" class="t-btn primary" data-go>Generate</button>
      </div>
    `;
    modal.classList.add('open');
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeLiveModal('tRoundRobin'); });
    body.querySelector('[data-go]').addEventListener('click', function () {
      const select = body.querySelector('#tRoundRobinBracket');
      const bracketId = select ? select.value : '';
      const chosen = findBracket(division, bracketId);
      if (!chosen || bracketIsComplete(chosen)) return toast('Choose a bracket that is not complete', 'error');
      if ((chosen.teamIds || []).length < 2) return toast('Pull at least 2 teams into ' + (chosen.name || 'that bracket'), 'error');
      const made = generateLeagueSchedule(tournamentId, sportId, categoryId, bracketId);
      if (made) closeLiveModal('tRoundRobin');
    });
  }

  async function setBracketComplete(tournamentId, sportId, divisionId, bracketId, complete) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    const bracket = findBracket(division, bracketId);
    if (!bracket) return;
    const next = !!complete;
    const stage = bracketStageId(bracket);
    if (next) {
      const leftover = unfinishedStageMatches(t, sport, division, stage, bracket.id);
      if (leftover.length) {
        return toast('Finish every match in ' + (bracket.name || 'this bracket') + ' before marking it complete. ' + leftover.length + ' still open.', 'error');
      }
      if (!confirm('Mark "' + (bracket.name || 'this bracket') + '" complete? It stays on the page. Generate round-robin will skip it until you reopen it.')) return;
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const target = (div.brackets || []).find(function (b) { return b.id === bracketId; });
        if (target) target.complete = next;
      });
      toast(next ? 'Bracket marked complete' : 'Bracket reopened', 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  async function setStageComplete(tournamentId, sportId, divisionId, stageId, complete) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const sport = t ? getSportConfig(t, sportId) : null;
    const division = sport ? findDivision(sport, divisionId) : null;
    if (!t || !sport || !division || !stageId) return;
    const label = stageLabelOf(sport, stageId);
    const next = !!complete;
    if (next) {
      const matches = stageMatchList(t, sport, division, stageId);
      const leftover = unfinishedStageMatches(t, sport, division, stageId);
      if (!matches.length) {
        return toast('Complete every match in ' + label + ' first. None are recorded yet.', 'error');
      }
      if (leftover.length) {
        return toast('Finish every match in ' + label + ' before marking the stage complete. ' + leftover.length + ' still open.', 'error');
      }
      if (!confirm('Mark ' + label + ' complete? Teams can then be advanced and the next stage can start.')) return;
    } else if (!confirm('Reopen ' + label + '? The next stage cannot start again until this stage is marked complete.')) {
      return;
    }
    try {
      await mutateDivision(tournamentId, sportId, divisionId, function (div) {
        const ids = completedStageIds(div).filter(function (id) { return id !== stageId; });
        if (next) ids.push(stageId);
        if (ids.length) div.completedStages = ids;
        else delete div.completedStages;
        if (next) {
          (div.brackets || []).forEach(function (b) {
            if (bracketStageId(b) === stageId) b.complete = true;
          });
        }
      });
      toast(next ? label + ' marked complete' : label + ' reopened', 'success');
      render();
    } catch (_) { /* toasted */ }
  }

  function generateLeagueSchedule(tournamentId, sportId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    if (scope.categoryId && !scope.bracket) return toast('Choose a bracket before generating a round-robin', 'error');
    const blocked = scheduleStageBlockedReason(sport, scope);
    if (blocked) return toast(blocked, 'error');
    if (scope.bracket && bracketIsComplete(scope.bracket)) {
      return toast((scope.bracket.name || 'This bracket') + ' is marked complete. Reopen it before generating a round-robin.', 'error');
    }
    const teams = scope.categoryId ? teamsInBracket(sport, scope.categoryId, scope.bracketId) : teamsFor(t, sport);
    if (teams.length < 2) {
      toast(scope.categoryId
        ? 'Pull at least 2 teams into ' + ((scope.bracket && scope.bracket.name) || 'this bracket') + ' before generating a round-robin'
        : 'Add at least 2 teams before generating a league schedule', 'error');
      return false;
    }
    harvestScheduleEditor();
    const existing = readWorkingEntries(t, sport, scope);
    const stageId = (scope.bracket && bracketStageId(scope.bracket)) || 'league';
    const stageName = stageLabelOf(sport, stageId);
    const where = scope.bracket ? ((scope.bracket.name || 'this bracket') + ' · ' + stageName) : stageName;
    const kept = existing.filter(function (e) { return e.stage && e.stage !== stageId; });
    if (existing.length && !confirm('Replace the fixtures in ' + where + ' with a round-robin of its teams?')) return false;
    const generated = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        generated.push(emptyScheduleEntry({
          stage: stageId,
          a: teams[i].id,
          b: teams[j].id,
          scheduledAt: sport.date ? new Date(sport.date + 'T18:00:00').toISOString() : ''
        }));
      }
    }
    persistLocalEntries(tournamentId, sportId, generated.concat(kept), true, scope.categoryId, scope.bracketId);
    const parsed = parseUrl();
    const viewing = parsed.view === 'tournament'
      && parsed.tournamentId === tournamentId
      && parsed.sportId === sportId
      && (parsed.categoryId || '') === (scope.categoryId || '')
      && (parsed.bracketId || '') === (scope.bracketId || '');
    if (viewing) renderScheduleFor(t, sport, scope);
    else {
      navigate({
        view: 'tournament',
        tournamentId: tournamentId,
        sportId: sportId,
        panel: parsed.panel,
        categoryId: scope.categoryId,
        bracketId: scope.bracketId,
        stageId: stageId
      });
    }
    toast(where + ' round-robin generated — save draft or publish when ready');
    return true;
  }

  function bindTeamHereButtons(root, tournament, sportId) {
    if (!root || !tournament) return;
    root.querySelectorAll('[data-act="here"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setTeamHere(tournament.id, sportId, btn.getAttribute('data-team'), btn.getAttribute('data-on') !== '0');
      });
    });
  }

  async function setTeamHere(tournamentId, sportId, teamId, on) {
    on = !!on;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    const found = t ? findEntryTeam(t, sportId, teamId) : null;
    if (!found || !found.team) return;
    const team = found.team;
    if (on) {
      if (teamIsHere(team)) return;
      if (!canMarkTeamHere(team)) return toast('Only this team or an admin can check in.', 'error');
    } else if (!canClearTeamHere(team)) {
      return toast('Only an admin can undo check-in.', 'error');
    }
    const stamp = {
      here: on,
      hereAt: on ? new Date().toISOString() : null,
      hereBy: on ? (signedInDisplayName() || '') : null
    };
    try {
      if (found.division) {
        await mutateDivision(tournamentId, sportId, found.division.id, function (div) {
          (div.teams || []).forEach(function (tm) {
            if (!tm || tm.id !== teamId) return;
            tm.here = stamp.here;
            tm.hereAt = stamp.hereAt;
            tm.hereBy = stamp.hereBy;
          });
        });
        toast(on ? ((team.name || 'Team') + ' is here') : ((team.name || 'Team') + ' check-in cleared'), 'success');
        render();
      } else {
        await writeTeamPatch(t, sportId, teamId, stamp);
        toast(on ? ((teamPublicName(team) || 'Team') + ' is here') : ((teamPublicName(team) || 'Team') + ' check-in cleared'), 'success');
      }
    } catch (_) { /* already toasted */ }
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

  async function mirrorMatchPlan(tournament, match, fields) {
    if (!match || (!match.scheduleEntryId && !match.fromSchedule)) return;
    const sport = getSportConfig(tournament, match.sport);
    if (!sport) return;
    const categoryId = match.categoryId || '';
    const bracketId = match.bracketId || '';
    const key = scheduleKey(tournament.id, match.sport, categoryId, bracketId);
    const local = scheduleEditByKey[key];
    if (local && Array.isArray(local.entries)) {
      local.entries = local.entries.map(function (e) {
        const hit = (match.scheduleEntryId && e.id === match.scheduleEntryId) || e.matchId === match.id;
        return hit ? Object.assign({}, e, fields) : e;
      });
    }
    const scope = scheduleScope(categoryId, bracketId, sport);
    const owner = categoryId ? scope.bracket : sport;
    if (!owner) return;
    const sch = getSchedule(owner);
    let changed = false;
    function touch(block) {
      if (!block || !Array.isArray(block.entries)) return block || null;
      return Object.assign({}, block, {
        entries: block.entries.map(function (e) {
          const hit = (match.scheduleEntryId && e.id === match.scheduleEntryId) || e.matchId === match.id;
          if (!hit) return e;
          changed = true;
          return Object.assign({}, e, fields);
        })
      });
    }
    if (!sch.draft && !sch.published) return;
    const next = { draft: touch(sch.draft), published: touch(sch.published) };
    if (!changed) return;
    try {
      await writeSchedule(tournament, sport.id, categoryId, bracketId, next);
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  async function writeSchedule(tournament, sportId, categoryId, bracketId, schedule) {
    if (!categoryId) return writeSportPatch(tournament, sportId, { schedule: schedule });
    const sport = getSportConfig(tournament, sportId);
    if (!sport) throw new Error('Sport not found');
    const divisions = (sport.divisions || []).map(function (d) {
      if (d.id !== categoryId) return d;
      return Object.assign({}, d, {
        brackets: (d.brackets || []).map(function (b) {
          if (b.id !== bracketId) return b;
          return Object.assign({}, b, { schedule: schedule });
        })
      });
    });
    return writeSportPatch(tournament, sportId, { divisions: divisions });
  }

  async function saveScheduleDraft(tournamentId, sportId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can edit the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    if (scope.categoryId && !scope.bracket) return toast('Open a bracket before saving its schedule', 'error');
    const entries = sanitizeScheduleEntries(readWorkingEntries(t, sport, scope));
    const nowIso = new Date().toISOString();
    const who = (state.user && (state.user.email || state.user.displayName)) || '';
    const prev = scheduleRecord(sport, scope);
    const schedule = {
      draft: { entries: entries, savedAt: nowIso, savedBy: who },
      published: prev.published || null
    };
    try {
      await writeSchedule(t, sportId, scope.categoryId, scope.bracketId, schedule);
      persistLocalEntries(tournamentId, sportId, entries, false, scope.categoryId, scope.bracketId);
      toast('Draft saved — not visible to others until you publish', 'success');
      render();
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  async function publishSchedule(tournamentId, sportId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can publish the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    if (scope.categoryId && !scope.bracket) return toast('Open a bracket before publishing its schedule', 'error');
    const blocked = scheduleStageBlockedReason(sport, scope);
    if (blocked) return toast(blocked, 'error');
    const entries = sanitizeScheduleEntries(readWorkingEntries(t, sport, scope));
    if (!entries.length) return toast('Add at least one match before publishing', 'error');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.a || !e.b) return toast('Every match needs two sides before publishing', 'error');
      if (e.a === e.b) return toast('A match cannot have the same side on both sides', 'error');
    }
    if (!confirm('Publish this schedule? Everyone signed in will be able to view it.')) return;

    const nowIso = new Date().toISOString();
    const who = (state.user && (state.user.email || state.user.displayName)) || '';
    const schedule = {
      draft: { entries: entries, savedAt: nowIso, savedBy: who },
      published: { entries: entries, publishedAt: nowIso, publishedBy: who }
    };

    try {
      await syncPublishedMatches(t, sport, entries, scope);
      await writeSchedule(t, sportId, scope.categoryId, scope.bracketId, schedule);
      persistLocalEntries(tournamentId, sportId, entries, false, scope.categoryId, scope.bracketId);
      toast('Schedule published', 'success');
      render();
    } catch (_) { /* already toasted */ }
  }

  async function deleteScheduleMatches(tournament, sport, scope) {
    const ids = scopeIds(scope);
    const existing = state.matches.filter(function (m) {
      return entryInScope(m, sport.id, ids.categoryId, ids.bracketId);
    });
    const col = db.collection('tournament_matches');
    for (let i = 0; i < existing.length; i++) {
      const m = existing[i];
      if (!m.fromSchedule && !m.scheduleEntryId) continue;
      if (m.status && m.status !== 'scheduled') continue;
      await col.doc(m.id).delete();
    }
  }

  async function clearSchedule(tournamentId, sportId, categoryId, bracketId) {
    if (!canEditSchedule()) return toast('Only admins can clear the schedule', 'error');
    harvestScheduleEditor();
    const { t, sport } = currentScheduleContext(tournamentId, sportId);
    if (!t || !sport) return;
    const scope = scheduleScope(categoryId, bracketId, sport);
    const owner = scope.categoryId ? scope.bracket : sport;
    if (scope.categoryId && !owner) return toast('Open a bracket before clearing its schedule', 'error');
    const published = scheduleIsPublished(owner);
    const sch = scheduleRecord(sport, scope);
    const local = scheduleEditByKey[scheduleKey(tournamentId, sportId, scope.categoryId, scope.bracketId)];
    const hasDraft = !!(sch.draft && Array.isArray(sch.draft.entries) && sch.draft.entries.length);
    const hasLocal = !!(local && Array.isArray(local.entries) && local.entries.length);
    if (!published && !hasDraft && !hasLocal) return toast('Schedule is already empty');

    const where = scope.bracket ? (scope.bracket.name || 'this bracket') : 'this sport';
    if (published) {
      if (!confirm('This schedule is published and everyone can see it. Clear it anyway?')) return;
      if (!confirm('This cannot be undone. Remove all published fixtures and scheduled match cards for ' + where + '? Live or completed matches will be kept.')) return;
    } else if (!confirm('Clear the schedule draft for ' + where + '? This cannot be undone.')) {
      return;
    }

    try {
      await deleteScheduleMatches(t, sport, scope);
      await writeSchedule(t, sportId, scope.categoryId, scope.bracketId, { draft: null, published: null });
      persistLocalEntries(tournamentId, sportId, [], false, scope.categoryId, scope.bracketId);
      delete scheduleEditByKey[scheduleKey(tournamentId, sportId, scope.categoryId, scope.bracketId)];
      toast('Schedule cleared', 'success');
      if (published) {
        confirm('The published schedule was cleared. Members will no longer see those fixtures. Click OK to continue.');
      }
      render();
    } catch (_) { /* writeSportPatch already toasted */ }
  }

  function buildMatchData(tournament, sport, entry, scope) {
    const stageCfg = getStageScoring(tournament, sport.id, entry.stage);
    const ids = scopeIds(scope);
    const data = {
      tournamentId: tournament.id,
      sport: sport.id,
      stage: entry.stage || 'league',
      scheduledAt: entry.scheduledAt || '',
      venue: courtOf(entry),
      court: courtOf(entry),
      showUpcoming: !!entry.showUpcoming,
      status: 'scheduled',
      winner: null,
      scoringConfig: stageCfg,
      published: true,
      fromSchedule: true,
      scheduleEntryId: entry.id,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: (state.user && state.user.email) || ''
    };
    if (ids.categoryId) data.categoryId = ids.categoryId;
    if (ids.bracketId) data.bracketId = ids.bracketId;
    if (matchUsesTeams(tournament, sport)) {
      data.teamA = entry.a;
      data.teamB = entry.b;
    } else {
      data.playerA = entry.a;
      data.playerB = entry.b;
    }
    if (sport.kind === 'racket') data.games = [];
    else if (sport.kind === 'volleyball') data.sets = [];
    else if (sport.kind === 'basketball') data.quarters = [];
    return Object.assign(data, matchCaptainPatch(tournament, data));
  }

  async function syncPublishedMatches(tournament, sport, entries, scope) {
    const ids = scopeIds(scope);
    const existing = state.matches.filter(function (m) {
      return entryInScope(m, sport.id, ids.categoryId, ids.bracketId);
    });
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
          venue: courtOf(e),
          court: courtOf(e),
          showUpcoming: !!e.showUpcoming,
          published: true,
          fromSchedule: true,
          scheduleEntryId: e.id,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: (state.user && state.user.email) || ''
        };
        if (ids.categoryId) patch.categoryId = ids.categoryId;
        if (ids.bracketId) patch.bracketId = ids.bracketId;
        if (matchUsesTeams(tournament, sport)) {
          patch.teamA = e.a;
          patch.teamB = e.b;
        } else {
          patch.playerA = e.a;
          patch.playerB = e.b;
        }
        Object.assign(patch, matchCaptainPatch(tournament, Object.assign({}, found, patch)));
        // Don't clobber scores on matches that have already started.
        if (found.status === 'scheduled') {
          await col.doc(found.id).update(patch);
        } else {
          await col.doc(found.id).update({
            scheduledAt: patch.scheduledAt,
            venue: patch.venue,
            court: patch.court,
            showUpcoming: patch.showUpcoming,
            scheduleEntryId: e.id,
            published: true,
            fromSchedule: true,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      } else {
        const data = buildMatchData(tournament, sport, e, scope);
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
  // CAPTAIN PICKER (admin only) — one users/{email} lookup
  // ═══════════════════════════════════════════════════════════════════════════

  async function lookupUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || e.indexOf('@') < 1) {
      throw new Error('Enter a valid email address');
    }
    const snap = await db.collection('users').where('email', '==', e).limit(1).get();
    if (snap.empty) return { email: e, found: false };
    const doc = snap.docs[0];
    const d = doc.data() || {};
    const split = splitName(d.displayName || '');
    return {
      found: true,
      uid: doc.id,
      email: (d.email || e).toLowerCase(),
      firstName: d.firstName || split.firstName || '',
      middleName: d.middleName || '',
      lastName: d.lastName || split.lastName || '',
      familyId: d.familyId != null ? String(d.familyId) : (d.FID != null ? String(d.FID) : ''),
      memberId: d.memberId != null ? String(d.memberId) : '',
      photoURL: d.photoURL || '',
      hasLogin: true
    };
  }

  function openCaptainPicker(tournamentId, sportId, teamId) {
    if (!canManageCaptains()) return;
    openLiveModal = 'userPicker';
    openLiveModalContext = { tournamentId, sportId, teamId, query: '', result: null, looking: false, error: '' };
    rerenderUserPicker();
  }

  function rerenderUserPicker() {
    if (openLiveModal !== 'userPicker') return;
    const ctx = openLiveModalContext || {};
    const t = state.tournaments.find(function (x) { return x.id === ctx.tournamentId; });
    const sport = t ? getSportConfig(t, ctx.sportId) : null;
    const teams = sport ? (sport.teams || []) : [];
    const team = teams.find(function (x) { return x.id === ctx.teamId; });
    const teamLabel = team ? teamPublicName(team) : ctx.teamId;
    const sportLabel = sport ? ((sport.emoji || '') + ' ' + sport.label) : ctx.sportId;

    const { modal, body } = getOrCreateModal('tCaptainPicker', 'Assign captain — ' + sportLabel + ' · ' + teamLabel, { wide: false });
    const currentCaptainRow = team && (team.captainUid || team.captainName || team.captainEmail)
      ? `<div class="t-captain-current">
           <div>
             <div class="lbl">Current captain</div>
             <div class="val">👤 ${formatCaptainHtml(team.captainName || team.captainEmail || team.captainUid)}</div>
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

    let resultHtml = '';
    if (ctx.looking) {
      resultHtml = '<div style="padding:12px;color:var(--t-muted);">Looking up that email…</div>';
    } else if (ctx.error) {
      resultHtml = '<div style="padding:12px;color:#991b1b;">' + escapeHtml(ctx.error) + '</div>';
    } else if (ctx.result && ctx.result.found) {
      const u = ctx.result;
      const fullName = [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ').trim();
      const isCurrent = team && (
        (team.captainUid && u.uid && u.uid === team.captainUid) ||
        (team.captainEmail && u.email && u.email === String(team.captainEmail).toLowerCase())
      );
      const meta = [
        u.familyId ? 'FID ' + escapeHtml(u.familyId) : null,
        u.email ? escapeHtml(u.email) : null
      ].filter(Boolean).join(' · ');
      resultHtml = `
        <div class="t-user-row">
          <div class="who">
            ${u.photoURL ? '<img src="' + escapeHtml(u.photoURL) + '" alt="">' : '<span class="avatar-placeholder">👤</span>'}
            <div>
              <div class="name">${escapeHtml(fullName || u.email)} <span class="t-badge login">✓ has login</span></div>
              <div class="email">${meta}</div>
            </div>
          </div>
          ${isCurrent
            ? '<span class="t-badge">Current captain</span>'
            : '<button class="t-btn sm primary" data-assign-found>Assign</button>'}
        </div>`;
    } else if (ctx.result && !ctx.result.found) {
      resultHtml = `
        <div style="padding:12px;color:var(--t-muted);">
          No signed-in user with <b>${escapeHtml(ctx.result.email)}</b>. They must sign in with Google once first.
          You can still assign this email; they can manage the roster after they sign in with that account.
        </div>
        <button class="t-btn sm primary" data-assign-email>Assign ${escapeHtml(ctx.result.email)}</button>`;
    }

    body.innerHTML = `
      ${currentCaptainRow}
      <div style="margin-top:14px;">
        <label class="t-form-label" for="tCaptainSearch">Captain Google email</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input id="tCaptainSearch" type="email" class="t-input" placeholder="name@gmail.com" value="${escapeHtml(ctx.query || '')}" autocomplete="off" style="flex:1;min-width:180px;" />
          <button type="button" class="t-btn primary" data-lookup ${ctx.looking ? 'disabled' : ''}>Look up</button>
        </div>
        <div style="font-size:.78rem;color:var(--t-muted);margin-top:6px;">
          Looks up one signed-in user by email. Does not load the full members list.
        </div>
      </div>
      <div class="t-user-results" id="tCaptainResults">${resultHtml}</div>
    `;

    const input = body.querySelector('#tCaptainSearch');
    const lookupBtn = body.querySelector('[data-lookup]');
    const removeBtn = body.querySelector('[data-remove-captain]');
    if (removeBtn) {
      removeBtn.addEventListener('click', async function () {
        await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, null);
        closeLiveModal('tCaptainPicker');
      });
    }

    async function runLookup() {
      ctx.query = input.value;
      ctx.error = '';
      ctx.result = null;
      ctx.looking = true;
      rerenderUserPicker();
      try {
        ctx.result = await lookupUserByEmail(ctx.query);
      } catch (err) {
        ctx.error = err.message || String(err);
      }
      ctx.looking = false;
      rerenderUserPicker();
    }

    if (lookupBtn) lookupBtn.addEventListener('click', runLookup);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runLookup(); }
    });
    input.addEventListener('input', function () { ctx.query = input.value; });

    const assignFound = body.querySelector('[data-assign-found]');
    if (assignFound) {
      assignFound.addEventListener('click', async function () {
        await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, ctx.result);
        closeLiveModal('tCaptainPicker');
      });
    }
    const assignEmail = body.querySelector('[data-assign-email]');
    if (assignEmail) {
      assignEmail.addEventListener('click', async function () {
        await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, {
          uid: '',
          email: ctx.result.email,
          firstName: '',
          lastName: '',
          familyId: '',
          hasLogin: false
        });
        closeLiveModal('tCaptainPicker');
      });
    }

    modal.classList.add('open');
    setTimeout(function () { if (input) input.focus(); }, 30);
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
                             [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim()
                             || person.displayName || person.email || null
                           ),
          captainEmail:    (person.email || '').toLowerCase() || null,
          captainFamilyId: person.familyId ? String(person.familyId) : null
        }
      : {
          captainUid: null, captainName: null, captainEmail: null, captainFamilyId: null
        };

    // Captain is a roster member and counts toward max. Explicit removal
    // removes the outgoing captain from the roster as well. Direct
    // replacement keeps the outgoing captain as a regular roster member.
    let nextRoster = Array.isArray(targetTeam.roster) ? targetTeam.roster.slice() : [];
    if (person) {
      nextRoster = ensureCaptainOnRosterList(targetTeam, nextRoster);
    } else {
      const outgoingCaptain = captainMember(targetTeam);
      if (outgoingCaptain) {
        nextRoster = nextRoster.filter(function (member) {
          return !membersMatch(outgoingCaptain, member);
        });
      }
    }
    if (person) {
      const incoming = {
        memberId: person.memberId || '',
        familyId: person.familyId ? String(person.familyId) : '',
        firstName: person.firstName || '',
        middleName: person.middleName || '',
        lastName: person.lastName || '',
        familyName: person.familyName || '',
        uid: person.uid || '',
        email: (person.email || '').toLowerCase() || '',
        name: [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim()
          || person.displayName || person.email || ''
      };
      const alreadyHere = nextRoster.some(function (r) { return membersMatch(incoming, r); })
        || isCaptainPerson(targetTeam, incoming);
      if (!alreadyHere) {
        const otherTeam = findOtherTeamForMember(targetSport.teams || [], teamId, incoming);
        if (otherTeam) {
          toast(([person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ').trim() || 'That person')
            + ' is already on ' + (otherTeam.name || otherTeam.id)
            + ' for this sport. A person can only be on one team per sport.', 'error');
          return;
        }
        if (isRosterAtCap(targetSport, Object.assign({}, targetTeam, { roster: nextRoster }))) {
          toast('This team is at the maximum of ' + maxRosterSize(targetSport)
            + ' members, including the captain. Remove someone before assigning a new captain.', 'error');
          return;
        }
        nextRoster.push(memberRowFromPerson(incoming));
      }
    }

    const sports = (t.sports || []).map(function (s) {
      if (s.id !== sportId) return s;
      const teams = (s.teams || []).map(function (tm) {
        if (tm.id !== teamId) return tm;
        return Object.assign({}, tm, captainPatch, { roster: nextRoster });
      });
      return Object.assign({}, s, { teams: teams });
    });

    const ref = db.collection('tournaments').doc(tournamentId);
    console.log('[tournament] setTeamCaptain →', {
      tournamentId: tournamentId, sportId: sportId, teamId: teamId, patch: captainPatch
    });

    try {
      await ref.update({ sports: sports, updatedAt: FieldValue.serverTimestamp() });
      const wroteWhat = person
        ? (toCamelCase(captainPatch.captainName || captainPatch.captainEmail) || '(assigned)')
        : 'removed';
      const idx = state.tournaments.findIndex(function (x) { return x.id === tournamentId; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { sports: sports });
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
    const atCap      = isRosterAtCap(sport, team);
    const maxSize    = maxRosterSize(sport);
    const count      = rosterCountOf(team);
    const rawRoster = Array.isArray(team.roster) ? team.roster : [];
    const rosterEntries = rawRoster.map(function (member, rawIndex) {
      return { member: member, rawIndex: rawIndex, syntheticCaptain: false };
    });
    const captain = captainMember(team);
    if (captain && !rawRoster.some(function (member) { return membersMatch(captain, member); })) {
      rosterEntries.unshift({ member: captain, rawIndex: -1, syntheticCaptain: true });
    }
    rosterEntries.sort(function (a, b) {
      const aCap = isCaptainPerson(team, a.member) ? 0 : 1;
      const bCap = isCaptainPerson(team, b.member) ? 0 : 1;
      if (aCap !== bCap) return aCap - bCap;
      return [a.member.firstName, a.member.middleName, a.member.lastName].filter(Boolean).join(' ')
        .localeCompare([b.member.firstName, b.member.middleName, b.member.lastName].filter(Boolean).join(' '));
    });

    const title = (sport.emoji || '🏅') + ' ' + (sport.label || sport.id) + ' — ' + teamPublicName(team) + ' roster';
    const { modal, body } = getOrCreateModal('tRoster', title, { wide: true });

    const captainAssigned = team.captainUid || team.captainName || team.captainEmail;
    const captainLine = captainAssigned
      ? '👤 Captain: ' + formatCaptainHtml(team.captainName || team.captainEmail || '')
        + (team.captainFamilyId ? ' <small style="color:var(--t-muted);">· FID ' + escapeHtml(team.captainFamilyId) + '</small>' : '')
        + (team.captainUid ? '' : ' <span class="t-badge nologin">no login yet</span>')
      : '<span style="color:var(--t-muted);">No captain assigned yet.</span>';
    const removeCaptainAction = captainAssigned && canManageCaptains()
      ? '<button class="t-btn danger sm" data-remove-roster-captain>Remove captain</button>'
      : '';

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
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${captainLine}${removeCaptainAction}</div>
        <div class="t-roster-count${maxSize && count > maxSize ? ' is-over' : ''}">${rosterCountLabel(sport, team)} member${count === 1 ? '' : 's'}${maxSize ? ' max' : ''}</div>
      </div>
      ${lockBanner}
      ${canEdit && !atCap ? `
        <div class="t-roster-actions">
          <button class="t-btn primary" data-add-member>➕ Add member from directory</button>
          ${!state.membersLoaded ? '<span style="color:var(--t-muted);font-size:.85rem;">Loading members.csv…</span>' : ''}
        </div>
      ` : (canEdit && atCap
        ? '<div style="color:var(--t-muted);font-size:.85rem;margin:8px 0 12px;">Roster is full (' + maxSize + ' max, including the captain). Remove someone to add another.</div>'
        : (locked
        ? '<div style="color:var(--t-muted);font-size:.85rem;margin:8px 0 12px;">This roster is locked. Only an admin can unlock it.</div>'
        : '<div style="color:var(--t-muted);font-size:.85rem;margin:8px 0 12px;">You can view this roster but only the team captain (or an admin) can edit it.</div>'
      ))}
      <div class="t-roster-list">
        ${rosterEntries.length === 0
          ? '<div class="t-empty-note">No members added yet.</div>'
          : rosterEntries.map(function (entry) {
              const r = entry.member;
              const nm = [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' ').trim() || r.name || '(unnamed)';
              const isCap = isCaptainPerson(team, r);
              let rowAction = '';
              if (isCap && canManageCaptains()) {
                rowAction = entry.syntheticCaptain
                  ? '<button class="t-btn danger sm" data-remove-roster-captain>Remove captain</button>'
                  : '<button class="t-btn danger sm" data-remove-roster-index="' + entry.rawIndex + '">Remove</button>';
              } else if (!isCap && canEdit) {
                rowAction = '<button class="t-btn danger sm" data-remove-roster-index="' + entry.rawIndex + '">Remove</button>';
              } else if (isCap) {
                rowAction = '<span class="t-badge">Captain</span>';
              }
              return `
                <div class="t-roster-row">
                  <div class="who">
                    <div class="name">${escapeHtml(nm)}${isCap ? ' <span class="t-badge you">Captain</span>' : ''}</div>
                    <div class="meta">Family: ${escapeHtml(r.familyName || '—')} · FID ${escapeHtml(r.familyId || '—')}${r.memberId ? ' · MID ' + escapeHtml(r.memberId) : ''}</div>
                    ${r.addedByName ? '<div class="sub">Added by ' + escapeHtml(r.addedByName) + '</div>' : ''}
                  </div>
                  ${rowAction}
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
    body.querySelectorAll('[data-remove-roster-captain]').forEach(function (removeCaptainBtn) {
      removeCaptainBtn.addEventListener('click', async function () {
        if (!confirm('Remove this captain and remove them from the team roster?')) return;
        await setTeamCaptain(ctx.tournamentId, ctx.sportId, ctx.teamId, null);
        rerenderRoster();
      });
    });
    body.querySelectorAll('[data-remove-roster-index]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const rawIndex = parseInt(btn.getAttribute('data-remove-roster-index'), 10);
        if (!confirm('Remove exactly this roster entry?')) return;
        await removeRosterMemberAtIndex(ctx.tournamentId, ctx.sportId, ctx.teamId, rawIndex);
        rerenderRoster();
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
  // MEMBER PICKER (captain/admin) — search members.csv
  // ═══════════════════════════════════════════════════════════════════════════

  // Explains — for a specific team — why the current user is not allowed to
  // edit the roster right now. Used by every edit entry point so admins and
  // captains see the actual reason instead of a generic "denied" toast.
  function whyCantEdit(team) {
    if (isAdminUi()) return null; // admin tools on: always can
    if (isRosterLocked(team)) {
      return 'This roster is locked. Only an admin can unlock it.';
    }
    if (!isCaptainOf(team)) {
      const cap = toCamelCase(team && (team.captainName || team.captainEmail));
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
    if (isRosterAtCap(sport, team)) {
      toast('This team is at the maximum of ' + maxRosterSize(sport) + ' members (including the captain) for ' + (sport.label || 'this sport') + '.', 'error');
      return;
    }
    openLiveModal = 'memberPicker';
    openLiveModalContext = { tournamentId, sportId, teamId, query: '' };
    loadMembersCsv();
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
      'Add member — ' + (sport.label || sport.id) + ' · ' + teamPublicName(team),
      { wide: true }
    );

    const existingKeys = new Set((team.roster || []).map(function (r) {
      return r.memberId ? ('M:' + r.memberId) : ('N:' + (r.firstName + '|' + r.lastName + '|' + r.familyId).toLowerCase());
    }));

    body.innerHTML = `
      <div>
        <label class="t-form-label" for="tMemberSearch">Search members.csv (name or Family ID)</label>
        <input id="tMemberSearch" type="text" class="t-input" placeholder="e.g. Joseph, or 16" value="${escapeHtml(ctx.query || '')}" autocomplete="off" />
        <div style="font-size:.78rem;color:var(--t-muted);margin-top:6px;">
          ${state.membersLoaded ? state.members.length + ' members in members.csv' : 'Loading members.csv…'}
          · A person can only be on one team in this sport.
          ${maxRosterSize(sport) ? ' · Max ' + maxRosterSize(sport) + ' members per team, including the captain.' : ''}
        </div>
      </div>
      <div class="t-member-results" id="tMemberResults"></div>
    `;

    const input = body.querySelector('#tMemberSearch');
    const results = body.querySelector('#tMemberResults');

    function paintResults() {
      if (!state.membersLoaded) {
        results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">Loading members.csv…</div>';
        return;
      }
      const list = searchMembers(input.value);
      if (!list.length) {
        results.innerHTML = '<div style="padding:12px;color:var(--t-muted);">No matches. Try a different name or a Family ID.</div>';
        return;
      }
      results.innerHTML = list.map(function (m, idx) {
        const key = m.memberId ? ('M:' + m.memberId) : ('N:' + (m.firstName + '|' + m.lastName + '|' + m.familyId).toLowerCase());
        const already = existingKeys.has(key)
          || (team.roster || []).some(function (r) { return membersMatch(m, r); })
          || isCaptainPerson(team, m);
        const otherTeam = already ? null : findOtherTeamForMember(teamsFor(t, sport), team.id, m);
        let actionHtml;
        if (already) {
          actionHtml = '<span class="t-badge">Already on roster</span>';
        } else if (otherTeam) {
          actionHtml = '<span class="t-badge" title="A person can only be on one team per sport">Already on ' + escapeHtml(otherTeam.name || otherTeam.id) + '</span>';
        } else if (isRosterAtCap(sport, team)) {
          actionHtml = '<span class="t-badge locked">Roster full</span>';
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
    if (roster.some(function (r) { return membersMatch(member, r); }) || isCaptainPerson(team, member)) {
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
    if (isRosterAtCap(sport, team)) {
      toast('This team is at the maximum of ' + maxRosterSize(sport) + ' members (including the captain) for ' + (sport.label || 'this sport') + '.', 'error');
      return;
    }
    const newEntry = {
      memberId: member.memberId || '',
      familyId: member.familyId || '',
      firstName: member.firstName || '',
      lastName: member.lastName || '',
      familyName: member.familyName || '',
      uid: '',
      email: '',
      addedByUid: currentUid() || '',
      addedByName: signedInDisplayName(),
      // Use an ISO string rather than serverTimestamp — Firestore does not
      // allow FieldValue sentinels inside nested arrays.
      addedAt: new Date().toISOString()
    };
    roster.push(newEntry);
    await writeTeamPatch(t, sportId, teamId, { roster: roster });
    toast('Added ' + (member.firstName + ' ' + member.lastName).trim(), 'success');
  }

  async function removeRosterMemberAtIndex(tournamentId, sportId, teamId, rawIndex) {
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const sport = getSportConfig(t, sportId);
    if (!sport) return;
    const team = (sport.teams || []).find(function (x) { return x.id === teamId; });
    if (!team) return;
    const roster = Array.isArray(team.roster) ? team.roster.slice() : [];
    const member = roster[rawIndex];
    if (!member) {
      toast('That roster entry no longer exists.', 'error');
      return;
    }
    const isCaptainRow = isCaptainPerson(team, member);
    if (isCaptainRow && !canManageCaptains()) {
      toast('Only admins can remove a captain roster entry.', 'error');
      return;
    }
    if (!isCaptainRow && !canEditRoster(team)) {
      toast(whyCantEdit(team) || 'You can\'t edit this roster.', 'error');
      return;
    }
    roster.splice(rawIndex, 1);
    await writeTeamPatch(t, sportId, teamId, { roster: roster });
    toast(isCaptainRow ? 'Captain roster entry removed' : 'Member removed', 'success');
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
      <div class="t-modal-content t-score-modal">
        <button class="t-modal-close t-score-modal-close" type="button" onclick="document.getElementById('tScorerModal').classList.remove('open');">×</button>
        <div class="t-modal-body" id="tScorerBody"></div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function scorerParticipantsHtml(match, tournament) {
    const sport = getSportConfig(tournament, match.sport);
    if (!sport || !usesRegistrationCategories(sport)) return '';
    const participants = participantsOf(match, tournament);
    const sides = [
      { id: participants.a, label: 'A' },
      { id: participants.b, label: 'B' }
    ];
    return `
      <div class="t-scorer-participants">
        ${sides.map(function (side) {
          const found = findEntryTeam(tournament, match.sport, side.id);
          const team = found && found.team;
          return `
            <div>
              <span>${side.label}</span>
              <b>${escapeHtml(teamPublicName(team) || side.id || '—')}</b>
              <strong>${escapeHtml(teamPlayersLabel(team) || 'Players not listed')}</strong>
            </div>`;
        }).join('')}
      </div>`;
  }

  function shouldMirrorPublicMatch(tournament) {
    return !!(tournament
      && tournament.publicBoard === true
      && tournament.published === true
      && tournament.started === true
      && tournament.spectatorToken);
  }

  function publicBoardDocId(tournament) {
    return String((tournament && tournament.spectatorToken) || '').trim();
  }

  function newSpectatorToken() {
    if (window.crypto && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += ('0' + bytes[i].toString(16)).slice(-2);
      }
      return out;
    }
    return db.collection('tournament_public').doc().id;
  }

  async function ensureSpectatorToken(tournament) {
    if (tournament.spectatorToken) return tournament.spectatorToken;
    const token = newSpectatorToken();
    await db.collection('tournaments').doc(tournament.id).update({
      spectatorToken: token,
      updatedAt: FieldValue.serverTimestamp()
    });
    tournament.spectatorToken = token;
    const idx = state.tournaments.findIndex(function (item) { return item.id === tournament.id; });
    if (idx >= 0) {
      state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { spectatorToken: token });
    }
    return token;
  }

  async function mirrorPublicMatch(match, tournament, patch) {
    if (!shouldMirrorPublicMatch(tournament) || !match || !match.id) return;
    const boardId = publicBoardDocId(tournament);
    if (!boardId) return;
    const merged = Object.assign({}, match, patch || {});
    const payload = sanitizePublicMatch(merged, tournament);
    payload.updatedAt = FieldValue.serverTimestamp();
    await db.collection('tournament_public').doc(boardId)
      .collection('matches').doc(match.id).set(payload);
  }

  async function updateMatchAndPublicScore(match, tournament, patch) {
    await db.collection('tournament_matches').doc(match.id).update(patch);
    try {
      await mirrorPublicMatch(match, tournament, patch);
    } catch (err) {
      // The canonical score is already saved. Keep score entry usable even if
      // public mirroring has not been enabled in Firestore rules yet.
      console.warn('[tournament] public score mirror failed:', err);
    }
  }

  function createScoreAutosaver() {
    let chain = Promise.resolve();
    return function (write) {
      chain = chain.catch(function () {}).then(write).catch(function (err) {
        console.error(err);
        toast('Could not save score: ' + (err.message || err.code || 'unknown'), 'error');
      });
    };
  }

  function scoreCardHeaderEl(match, tournament) {
    const p = participantsOf(match, tournament);
    const a = teamMeta(tournament, match.sport, p.a);
    const b = teamMeta(tournament, match.sport, p.b);
    const head = el('div', { class: 't-score-card-head' });
    head.innerHTML = `
      <div class="t-score-card-team">
        <span class="t-team-swatch" style="--team-color:${a.color}"></span>
        <b>${escapeHtml(a.name)}</b>
        ${matchSideAckHtml(match, tournament, 'A')}
      </div>
      <div class="t-score-card-team">
        <span class="t-team-swatch" style="--team-color:${b.color}"></span>
        <b>${escapeHtml(b.name)}</b>
        ${matchSideAckHtml(match, tournament, 'B')}
      </div>
    `;
    bindMatchAckButtons(head, match, tournament);
    return head;
  }

  function openScorer(match, tournament) {
    assertCanScoreMatch(match);
    const sport = getSportConfig(tournament, match.sport);
    const modal = getScorerModal();
    const body = modal.querySelector('#tScorerBody');
    body.innerHTML = '';
    if (sport.kind === 'racket') body.appendChild(buildRacketScorer(match, tournament, sport));
    else if (sport.kind === 'volleyball') body.appendChild(buildVolleyballScorer(match, tournament, sport));
    else if (sport.kind === 'basketball') body.appendChild(buildBasketballScorer(match, tournament, sport));
    modal.classList.add('open');
  }

  function scoreMatchStatePatch(match, winner, tournament) {
    const keepCompleted = isAdminUi() && match.status === 'completed';
    const patch = {
      winner: winner || null,
      status: keepCompleted ? 'completed' : 'in_progress',
      resultType: keepCompleted && winner ? 'played' : null
    };
    if (isAdminUi() && tournament) Object.assign(patch, matchCaptainPatch(tournament, match));
    return patch;
  }

  function buildRacketScorer(match, tournament, sport) {
    const cfg = getStageScoring(tournament, match.sport, match.stage) || {};
    const participants = participantsOf(match, tournament);
    const aName = displayName(tournament, match.sport, participants.a);
    const bName = displayName(tournament, match.sport, participants.b);
    const aColor = teamMeta(tournament, match.sport, participants.a).color;
    const bColor = teamMeta(tournament, match.sport, participants.b).color;
    const finalizedPlayers = usesRegistrationCategories(sport) && !!match.categoryId;
    const playersReadOnly = finalizedPlayers || !isAdminUi();
    const canChangeStructure = isAdminUi();
    const games = racketGamesForMatch(match, tournament, sport);

    const wrap = el('div', { class: 't-score-card' });
    wrap.appendChild(scoreCardHeaderEl(match, tournament));
    const autoSave = createScoreAutosaver();

    function queueGamesSave() {
      games.forEach(function (game) {
        game.winner = racketGameWinner(game, cfg);
        game.status = game.winner ? 'completed' : (game.sets.some(function (set) { return set.a || set.b; }) ? 'in_progress' : 'pending');
      });
      const fresh = games.map(function (game) {
        return {
          category: game.category,
          playersA: game.playersA || '',
          playersB: game.playersB || '',
          sets: game.sets.map(function (set) { return { a: set.a || 0, b: set.b || 0 }; }),
          status: game.status,
          winner: game.winner || null
        };
      });
      const overall = racketMatchWinner(Object.assign({}, match, { games: fresh }), tournament);
      const patch = Object.assign({
        games: fresh,
        updatedAt: FieldValue.serverTimestamp()
      }, scoreMatchStatePatch(match, overall, tournament));
      autoSave(function () {
        assertCanScoreMatch(match);
        return updateMatchAndPublicScore(match, tournament, patch);
      });
    }

    games.forEach(function (game) {
      const gameWrap = el('div', { class: 't-card', style: { marginBottom: '12px' } });
      gameWrap.innerHTML = `
        <div class="t-card-header">
          <h3>${escapeHtml(game.category)} ${finalizedPlayers ? '' : '<small style="font-weight:500;color:var(--t-muted);">' + escapeHtml(CATEGORY_LABEL[game.category] || '') + '</small>'}</h3>
          <span class="t-badge status-${game.status || 'pending'}">${STATUS_LABEL[game.status] || 'Pending'}</span>
        </div>
        <div class="t-card-body">
          <div class="t-form-grid" style="margin-bottom:12px;">
            <div class="t-form-field">
              <label>${escapeHtml(aName)} players</label>
              ${playersReadOnly
                ? `<div class="t-fixed-players">${escapeHtml(game.playersA || 'Players not listed')}</div>`
                : `<input type="text" class="t-input" data-players="A" value="${escapeHtml(game.playersA || '')}" />`}
            </div>
            <div class="t-form-field">
              <label>${escapeHtml(bName)} players</label>
              ${playersReadOnly
                ? `<div class="t-fixed-players">${escapeHtml(game.playersB || 'Players not listed')}</div>`
                : `<input type="text" class="t-input" data-players="B" value="${escapeHtml(game.playersB || '')}" />`}
            </div>
          </div>
          <div data-sets></div>
          ${canChangeStructure ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
            <button class="t-btn sm" data-act="add-set">+ Add set</button>
            <button class="t-btn sm danger" data-act="remove-set">− Remove last set</button>
          </div>` : ''}
        </div>
      `;

      function repaint() {
        const container = gameWrap.querySelector('[data-sets]');
        container.innerHTML = '';
        game.sets.forEach(function (set, si) {
          const w = racketSetWinner(set, cfg);
          const row = el('div', { class: 't-scorer', style: { marginBottom: '8px' } });
          row.innerHTML = `
            <div class="t-scorer-period">Set ${si + 1}${w ? ' · ' + w : ''}</div>
            <div class="side">
              <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
              <div class="t-score-stepper">
                <button class="t-score-button" data-inc="A" data-set="${si}" data-delta="-1" aria-label="Decrease ${escapeHtml(aName)} score">−</button>
                <input type="number" min="0" class="t-input t-score-input" value="${set.a || 0}" data-side="A" data-set="${si}" />
                <button class="t-score-button add" data-inc="A" data-set="${si}" data-delta="1" aria-label="Increase ${escapeHtml(aName)} score">+</button>
              </div>
            </div>
            <div class="side">
              <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
              <div class="t-score-stepper">
                <button class="t-score-button" data-inc="B" data-set="${si}" data-delta="-1" aria-label="Decrease ${escapeHtml(bName)} score">−</button>
                <input type="number" min="0" class="t-input t-score-input" value="${set.b || 0}" data-side="B" data-set="${si}" />
                <button class="t-score-button add" data-inc="B" data-set="${si}" data-delta="1" aria-label="Increase ${escapeHtml(bName)} score">+</button>
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
              queueGamesSave();
            });
          });
          row.querySelectorAll('input[data-side]').forEach(function (inp) {
            inp.addEventListener('change', function () {
              const side = inp.getAttribute('data-side');
              const idx = +inp.getAttribute('data-set');
              const key = side === 'A' ? 'a' : 'b';
              game.sets[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
              queueGamesSave();
            });
          });
          container.appendChild(row);
        });
      }
      repaint();

      gameWrap.querySelectorAll('[data-players]').forEach(function (input) {
        input.addEventListener('change', function () {
          if (input.getAttribute('data-players') === 'A') game.playersA = input.value.trim();
          else game.playersB = input.value.trim();
          queueGamesSave();
        });
      });
      if (canChangeStructure) {
        gameWrap.querySelector('[data-act="add-set"]').addEventListener('click', function () {
          if (game.sets.length >= (cfg.bestOf || 1)) return toast('Best of ' + (cfg.bestOf || 1) + ' — cannot add more sets', 'error');
          game.sets.push({ a: 0, b: 0 });
          repaint();
          queueGamesSave();
        });
        gameWrap.querySelector('[data-act="remove-set"]').addEventListener('click', function () {
          if (game.sets.length <= 1) return;
          game.sets.pop();
          repaint();
          queueGamesSave();
        });
      }

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
    const canChangeStructure = isAdminUi();
    const sets = (match.sets && match.sets.length) ? match.sets.map(function (s) { return Object.assign({}, s); }) : [{ a: 0, b: 0 }];

    const wrap = el('div', { class: 't-score-card t-card' });
    wrap.appendChild(scoreCardHeaderEl(match, tournament));
    const body = el('div', { class: 't-card-body' });
    wrap.appendChild(body);
    const autoSave = createScoreAutosaver();
    const setsBox = el('div'); body.appendChild(setsBox);
    let controls = null;
    if (canChangeStructure) {
      controls = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } });
      controls.innerHTML = `
        <button class="t-btn sm" data-act="add-set">+ Add set</button>
        <button class="t-btn sm danger" data-act="remove-set">− Remove last set</button>
      `;
      body.appendChild(controls);
    }

    function queueScoreSave() {
      const snapshot = sets.map(function (set) { return { a: set.a || 0, b: set.b || 0 }; });
      const winner = volleyballMatchWinner({ sets: snapshot }, cfg);
      const patch = Object.assign({
        sets: snapshot,
        updatedAt: FieldValue.serverTimestamp()
      }, scoreMatchStatePatch(match, winner, tournament));
      autoSave(function () {
        assertCanScoreMatch(match);
        return updateMatchAndPublicScore(match, tournament, patch);
      });
    }

    function paint() {
      setsBox.innerHTML = '';
      sets.forEach(function (s, i) {
        const isDeciding = i === bestOf - 1;
        const w = volleyballSetWinner(s, cfg, isDeciding);
        const row = el('div', { class: 't-scorer', style: { marginBottom: '8px' } });
        row.innerHTML = `
          <div class="t-scorer-period">Set ${i + 1}${w ? ' · ' + w : ''}${isDeciding ? ' (deciding)' : ''}</div>
          <div class="side">
            <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
            <div class="t-score-stepper">
              <button class="t-score-button" data-inc="A" data-set="${i}" data-delta="-1" aria-label="Decrease ${escapeHtml(aName)} score">−</button>
              <input type="number" min="0" class="t-input t-score-input" value="${s.a || 0}" data-side="A" data-set="${i}" />
              <button class="t-score-button add" data-inc="A" data-set="${i}" data-delta="1" aria-label="Increase ${escapeHtml(aName)} score">+</button>
            </div>
          </div>
          <div class="side">
            <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
            <div class="t-score-stepper">
              <button class="t-score-button" data-inc="B" data-set="${i}" data-delta="-1" aria-label="Decrease ${escapeHtml(bName)} score">−</button>
              <input type="number" min="0" class="t-input t-score-input" value="${s.b || 0}" data-side="B" data-set="${i}" />
              <button class="t-score-button add" data-inc="B" data-set="${i}" data-delta="1" aria-label="Increase ${escapeHtml(bName)} score">+</button>
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
            queueScoreSave();
          });
        });
        row.querySelectorAll('input[data-side]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            const side = inp.getAttribute('data-side');
            const idx = +inp.getAttribute('data-set');
            const key = side === 'A' ? 'a' : 'b';
            sets[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
            queueScoreSave();
          });
        });
        setsBox.appendChild(row);
      });
    }
    paint();

    if (controls) {
      controls.querySelector('[data-act="add-set"]').addEventListener('click', function () {
        if (sets.length >= bestOf) return toast('Best of ' + bestOf + ' — max ' + bestOf + ' sets', 'error');
        sets.push({ a: 0, b: 0 }); paint(); queueScoreSave();
      });
      controls.querySelector('[data-act="remove-set"]').addEventListener('click', function () {
        if (sets.length <= 1) return;
        sets.pop(); paint(); queueScoreSave();
      });
    }
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
    const canChangeStructure = isAdminUi();
    const quarters = (match.quarters && match.quarters.length) ? match.quarters.map(function (q) { return Object.assign({}, q); }) : [{ a: 0, b: 0 }];

    const wrap = el('div', { class: 't-score-card t-card' });
    wrap.appendChild(scoreCardHeaderEl(match, tournament));
    const body = el('div', { class: 't-card-body' });
    wrap.appendChild(body);
    const autoSave = createScoreAutosaver();
    const totalsBox = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '18px', margin: '8px 0 12px', fontFamily: 'Barlow Condensed, sans-serif' } });
    body.appendChild(totalsBox);
    const quartersBox = el('div'); body.appendChild(quartersBox);
    let controls = null;
    if (canChangeStructure) {
      controls = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } });
      controls.innerHTML = `
        <button class="t-btn sm" data-act="add-q">+ Add quarter</button>
        <button class="t-btn sm danger" data-act="remove-q">− Remove last quarter</button>
      `;
      body.appendChild(controls);
    }

    function queueScoreSave() {
      const snapshot = quarters.map(function (quarter) { return { a: quarter.a || 0, b: quarter.b || 0 }; });
      const winner = basketballWinner({ quarters: snapshot }, cfg);
      const patch = Object.assign({
        quarters: snapshot,
        updatedAt: FieldValue.serverTimestamp()
      }, scoreMatchStatePatch(match, winner, tournament));
      autoSave(function () {
        assertCanScoreMatch(match);
        return updateMatchAndPublicScore(match, tournament, patch);
      });
    }

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
          <div class="t-card-body">
            <div class="t-scorer">
              <div class="t-scorer-period">Quarter ${i + 1}</div>
              <div class="side">
                <div class="team-name"><span class="t-team-swatch" style="--team-color:${aColor};width:6px;height:16px;"></span>${escapeHtml(aName)}</div>
                <div class="t-score-stepper">
                  <button class="t-score-button" data-inc="A" data-q="${i}" data-delta="-1" aria-label="Decrease ${escapeHtml(aName)} score">−</button>
                  <input type="number" min="0" class="t-input t-score-input" value="${q.a || 0}" data-side="A" data-q="${i}" />
                  <button class="t-score-button add" data-inc="A" data-q="${i}" data-delta="1" aria-label="Increase ${escapeHtml(aName)} score">+</button>
                </div>
              </div>
              <div class="side">
                <div class="team-name"><span class="t-team-swatch" style="--team-color:${bColor};width:6px;height:16px;"></span>${escapeHtml(bName)}</div>
                <div class="t-score-stepper">
                  <button class="t-score-button" data-inc="B" data-q="${i}" data-delta="-1" aria-label="Decrease ${escapeHtml(bName)} score">−</button>
                  <input type="number" min="0" class="t-input t-score-input" value="${q.b || 0}" data-side="B" data-q="${i}" />
                  <button class="t-score-button add" data-inc="B" data-q="${i}" data-delta="1" aria-label="Increase ${escapeHtml(bName)} score">+</button>
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
            queueScoreSave();
          });
        });
        row.querySelectorAll('input[data-side]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            const side = inp.getAttribute('data-side');
            const idx = +inp.getAttribute('data-q');
            const key = side === 'A' ? 'a' : 'b';
            quarters[idx][key] = Math.max(0, parseInt(inp.value, 10) || 0);
            queueScoreSave();
          });
        });
        quartersBox.appendChild(row);
      });
    }
    paint();

    if (controls) {
      controls.querySelector('[data-act="add-q"]').addEventListener('click', function () {
        if (quarters.length >= totalQuarters) return toast('Only ' + totalQuarters + ' quarters allowed', 'error');
        quarters.push({ a: 0, b: 0 }); paint(); queueScoreSave();
      });
      controls.querySelector('[data-act="remove-q"]').addEventListener('click', function () {
        if (quarters.length <= 1) return;
        quarters.pop(); paint(); queueScoreSave();
      });
    }
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
      if (state.currentId) schedulePublicBoardSync(state.currentId);
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

  function unsubscribeUserData() {
    if (state.unsubUsers) { state.unsubUsers(); state.unsubUsers = null; }
    if (state.unsubRsvp)  { state.unsubRsvp();  state.unsubRsvp  = null; }
    state.users = [];
    state.rsvpResponses = [];
    state.scorerDirectory = null;
    state.adminDirectory = null;
    scorerDirectoryPromise = null;
    state.ready.users = false;
    state.ready.rsvp  = false;
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
        schedulePublicBoardSync(tournamentId);
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

  function isPublicWatchPage() {
    const file = ((location.pathname || '').split('/').pop() || '').toLowerCase();
    return file === 'watch.html';
  }

  function spectatorUrl(tournament, opts) {
    const token = typeof tournament === 'string'
      ? (state.tournaments.find(function (item) { return item.id === tournament; }) || {}).spectatorToken
      : publicBoardDocId(tournament);
    if (!token) return '';
    const url = new URL('watch.html', location.href);
    url.search = '';
    url.searchParams.set('s', token);
    if (opts && opts.live) url.searchParams.set('live', '1');
    return url.href;
  }

  function sanitizePublicTeam(team) {
    if (!team || !team.id) return null;
    const out = { id: team.id, name: team.name || team.id };
    if (team.wards) out.wards = String(team.wards);
    const tags = parseTeamTags(team.tags);
    if (tags.length) out.tags = tags;
    if (Array.isArray(team.players)) {
      out.players = team.players.map(function (p) { return String(p || '').trim(); }).filter(Boolean);
    }
    return out;
  }

  function sanitizePublicSport(sport) {
    return {
      id: sport.id,
      label: sport.label || sport.id,
      kind: sport.kind || '',
      emoji: sport.emoji || '🏅',
      color: sport.color || '#3b82f6',
      date: sport.date || '',
      hasThirdPlace: sport.hasThirdPlace !== false,
      categoryMode: sport.categoryMode || '',
      tablePoints: tablePointsFor(sport),
      stageList: stageListFor(sport),
      rulesText: rulesText(sport.rules),
      teams: (sport.teams || []).map(sanitizePublicTeam).filter(Boolean),
      divisions: (sport.divisions || []).map(function (d) {
        const pub = {
          id: d.id,
          name: d.name || '',
          open: !!d.open,
          maxPlayers: clampMaxPlayers(d.maxPlayers),
          teams: (d.teams || []).map(sanitizePublicTeam).filter(Boolean),
          skippedStages: skippedStageIds(d),
          advanced: advancedRecord(d),
          brackets: (d.brackets || []).map(function (b) {
            return {
              id: b.id,
              name: b.name || 'Bracket',
              stageId: bracketStageId(b),
              complete: !!b.complete,
              teamIds: Array.isArray(b.teamIds) ? b.teamIds.slice() : [],
              walkoverPoints: walkoverScoreForBracket(sport, b, bracketStageId(b)),
              walkoverScore: walkoverScoreForBracket(sport, b, bracketStageId(b))
            };
          })
        };
        return copyDivisionResultFields(d, pub);
      })
    };
  }

  function sanitizePublicMatch(match, tournament) {
    const out = {
      id: match.id,
      sport: match.sport || '',
      stage: match.stage || 'league',
      status: match.status || 'scheduled',
      scheduledAt: scheduledAtIso(match.scheduledAt),
      venue: courtOf(match),
      court: courtOf(match),
      showUpcoming: !!match.showUpcoming,
      winner: match.winner || null
    };
    if (match.resultType) out.resultType = match.resultType;
    if (match.categoryId) out.categoryId = match.categoryId;
    if (match.bracketId) out.bracketId = match.bracketId;
    if (match.teamA) out.teamA = match.teamA;
    if (match.teamB) out.teamB = match.teamB;
    if (match.playerA) out.playerA = match.playerA;
    if (match.playerB) out.playerB = match.playerB;
    if (Array.isArray(match.sets) && match.sets.length) {
      out.sets = match.sets.map(function (s) { return { a: s.a || 0, b: s.b || 0 }; });
    }
    if (Array.isArray(match.quarters) && match.quarters.length) {
      out.quarters = match.quarters.map(function (q) { return { a: q.a || 0, b: q.b || 0 }; });
    }
    const sport = tournament ? getSportConfig(tournament, match.sport) : null;
    const publicGames = sport && sport.kind === 'racket'
      ? racketGamesForMatch(match, tournament, sport)
      : match.games;
    if (Array.isArray(publicGames) && publicGames.length) {
      out.games = publicGames.map(function (g) {
        return {
          category: g.category || '',
          playersA: g.playersA || '',
          playersB: g.playersB || '',
          winner: g.winner || null,
          sets: (g.sets || []).map(function (s) { return { a: s.a || 0, b: s.b || 0 }; })
        };
      });
    }
    return out;
  }

  function publicMatchVisible(tournament, match) {
    if (!match) return false;
    const sport = getSportConfig(tournament, match.sport);
    if (!sport) return false;
    if (!matchStageApplies(sport, match)) return false;
    if (match.fromSchedule || match.scheduleEntryId) {
      if (match.bracketId) {
        const division = findDivision(sport, match.categoryId);
        return scheduleIsPublished(findBracket(division, match.bracketId));
      }
      return scheduleIsPublished(sport);
    }
    return true;
  }

  function publicBoardDocument(tournament, matches) {
    const visible = (matches || []).filter(function (m) { return publicMatchVisible(tournament, m); });
    return {
      publicBoard: true,
      published: true,
      started: true,
      name: tournament.name || 'Tournament',
      format: tournament.format || 'teams',
      sportMode: sportModeOf(tournament),
      rulesText: isMultiSportTournament(tournament) ? rulesText(tournament.rules) : '',
      sports: (tournament.sports || []).map(sanitizePublicSport),
      matches: visible.map(function (match) { return sanitizePublicMatch(match, tournament); }),
      updatedAt: FieldValue.serverTimestamp()
    };
  }

  const publicSyncKeys = {};
  let publicSyncTimer = null;

  function schedulePublicBoardSync(tournamentId) {
    if (!tournamentId || !isRealAdmin()) return;
    clearTimeout(publicSyncTimer);
    publicSyncTimer = setTimeout(function () { syncPublicBoardNow(tournamentId); }, 700);
  }

  async function commitPublicWrites(writes) {
    const chunk = 400;
    for (let i = 0; i < writes.length; i += chunk) {
      const batch = db.batch();
      writes.slice(i, i + chunk).forEach(function (item) {
        if (item.type === 'delete') batch.delete(item.ref);
        else batch.set(item.ref, item.data);
      });
      await batch.commit();
    }
  }

  async function deletePublicBoardDocs(tournament) {
    const keys = [];
    const token = publicBoardDocId(tournament);
    if (token) keys.push(token);
    if (tournament && tournament.id && keys.indexOf(tournament.id) === -1) keys.push(tournament.id);
    for (let i = 0; i < keys.length; i++) {
      const ref = db.collection('tournament_public').doc(keys[i]);
      try {
        const existing = await ref.collection('matches').get();
        const writes = [{ type: 'delete', ref: ref }];
        existing.forEach(function (doc) { writes.push({ type: 'delete', ref: doc.ref }); });
        await commitPublicWrites(writes);
      } catch (err) {
        console.warn('[tournament] public board delete skipped:', keys[i], err);
      }
    }
  }

  async function syncPublicMatchDocs(tournament, matches, open) {
    const boardId = publicBoardDocId(tournament);
    if (!boardId) return;
    const col = db.collection('tournament_public').doc(boardId).collection('matches');
    const existing = await col.get();
    const keep = {};
    const writes = [];
    if (open) {
      (matches || []).forEach(function (match) {
        if (!match || !match.id || !publicMatchVisible(tournament, match)) return;
        keep[match.id] = true;
        writes.push({
          type: 'set',
          ref: col.doc(match.id),
          data: Object.assign({}, sanitizePublicMatch(match, tournament), {
            updatedAt: FieldValue.serverTimestamp()
          })
        });
      });
    }
    existing.forEach(function (doc) {
      if (!keep[doc.id]) writes.push({ type: 'delete', ref: doc.ref });
    });
    await commitPublicWrites(writes);
  }

  async function syncPublicBoardNow(tournamentId, opts) {
    if (!isRealAdmin() || !tournamentId) return;
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const open = !!(t.publicBoard && isTournamentPublished(t) && tournamentHasStarted(t));
    if (!open && !(opts && opts.forceClose)) return;
    if (open && (state.currentId !== t.id || !state.ready.matches)) return;
    if (!open) {
      await deletePublicBoardDocs(t);
      publicSyncKeys[t.id] = 'closed';
      return;
    }
    if (!publicBoardDocId(t)) return;
    const matches = state.matches || [];
    const payload = publicBoardDocument(t, matches);
    const comparable = Object.assign({}, payload);
    delete comparable.updatedAt;
    const key = JSON.stringify(comparable);
    if (publicSyncKeys[t.id] === key && !(opts && opts.force)) return;
    await db.collection('tournament_public').doc(publicBoardDocId(t)).set(payload);
    if (t.spectatorToken && t.spectatorToken !== t.id) {
      try { await deletePublicBoardDocs({ id: t.id, spectatorToken: '' }); } catch (err) {
        console.warn('[tournament] legacy public board cleanup failed:', err);
      }
    }
    if (opts && opts.force) {
      try {
        await syncPublicMatchDocs(t, matches, true);
      } catch (err) {
        console.warn('[tournament] public match docs sync failed:', err);
      }
    }
    publicSyncKeys[t.id] = key;
  }

  function copySpectatorLink(tournament, opts) {
    const url = spectatorUrl(tournament, opts);
    if (!url) return toast('Enable the spectator link first', 'error');
    const label = (opts && opts.live) ? 'Live display link copied' : 'Share link copied';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        toast(label);
      }).catch(function () {
        prompt(label.replace(' copied', ''), url);
      });
      return;
    }
    prompt(label.replace(' copied', ''), url);
  }

  function bindSpectatorLinkModal(t) {
    const { modal, body } = getOrCreateModal('tShareBoard', 'Spectator link', { wide: false });
    const shareUrl = spectatorUrl(t);
    const liveUrl = spectatorUrl(t, { live: true });
    body.innerHTML = `
      <p class="t-mode-note" style="margin-top:0;">This tournament has one spectator token and two links. Share the refresh link with everyone. Use the live display link on venue screens. Disable either to expire both and stop public reads. Enable again later to turn the same links back on.</p>
      <div class="t-form-field">
        <label>Share link — people refresh for the latest scores</label>
        <input type="text" class="t-input" id="tSpectatorShareUrl" readonly value="${escapeHtml(shareUrl)}" />
      </div>
      <div class="t-modal-foot" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:8px;">
        <a class="t-btn" href="${escapeHtml(shareUrl)}" target="_blank" rel="noopener">Open</a>
        <button type="button" class="t-btn primary" data-copy-share>Copy share link</button>
      </div>
      <div class="t-form-field" style="margin-top:16px;">
        <label>Live display — auto-refresh for venue screens</label>
        <input type="text" class="t-input" id="tSpectatorLiveUrl" readonly value="${escapeHtml(liveUrl)}" />
      </div>
      <div class="t-modal-foot" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:8px;">
        <a class="t-btn" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">Open live</a>
        <button type="button" class="t-btn primary" data-copy-live>Copy live link</button>
      </div>
      <div class="t-modal-foot" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button type="button" class="t-btn danger" data-stop-share>Disable spectator link</button>
      </div>
    `;
    modal.classList.add('open');
    const shareInput = body.querySelector('#tSpectatorShareUrl');
    const liveInput = body.querySelector('#tSpectatorLiveUrl');
    if (shareInput) shareInput.addEventListener('focus', function () { shareInput.select(); });
    if (liveInput) liveInput.addEventListener('focus', function () { liveInput.select(); });
    body.querySelector('[data-copy-share]').addEventListener('click', function () { copySpectatorLink(t); });
    body.querySelector('[data-copy-live]').addEventListener('click', function () { copySpectatorLink(t, { live: true }); });
    body.querySelector('[data-stop-share]').addEventListener('click', function () { stopLiveBoard(t.id); });
  }

  async function shareLiveBoard(tournamentId) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    const ready = isTournamentPublished(t) && tournamentHasStarted(t);
    const { modal, body } = getOrCreateModal('tShareBoard', 'Spectator link', { wide: false });
    if (!ready) {
      body.innerHTML = `
        <p class="t-mode-note" style="margin-top:0;">Anyone with the spectator link can follow scores without signing in. Publish this tournament and start it first. The link stays off until both are on.</p>
        <ul class="t-left-matches">
          <li>${isTournamentPublished(t) ? 'Published' : 'Not published yet'}</li>
          <li>${tournamentHasStarted(t) ? 'Started' : 'Not started yet'}</li>
        </ul>
        <div class="t-modal-foot" style="display:flex;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="t-btn" data-close-share>Close</button>
        </div>
      `;
      modal.classList.add('open');
      body.querySelector('[data-close-share]').addEventListener('click', function () { closeLiveModal('tShareBoard'); });
      return;
    }
    if (t.publicBoard) {
      if (!t.spectatorToken) {
        body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Creating this tournament\'s spectator link…</p>';
        modal.classList.add('open');
        try {
          await ensureSpectatorToken(t);
          await syncPublicBoardNow(t.id, { force: true });
          const latest = state.tournaments.find(function (item) { return item.id === t.id; }) || t;
          bindSpectatorLinkModal(latest);
        } catch (err) {
          console.error(err);
          body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Could not create the spectator link. ' + escapeHtml(err.message || err.code || 'Try again.') + '</p>';
        }
        return;
      }
      bindSpectatorLinkModal(t);
      return;
    }
    if (!state.ready.matches || state.currentId !== t.id) {
      body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Matches are still loading. Open the spectator link again in a moment.</p>';
      modal.classList.add('open');
      return;
    }
    body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Preparing the live board…</p>';
    modal.classList.add('open');
    try {
      const token = await ensureSpectatorToken(t);
      await db.collection('tournaments').doc(t.id).update({
        publicBoard: true,
        spectatorToken: token,
        publicBoardAt: new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp()
      });
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) {
        state.tournaments[idx] = Object.assign({}, state.tournaments[idx], {
          publicBoard: true,
          spectatorToken: token
        });
      }
      await syncPublicBoardNow(t.id, { force: true });
      bindSpectatorLinkModal(state.tournaments[idx] || Object.assign({}, t, { publicBoard: true, spectatorToken: token }));
      render();
    } catch (err) {
      console.error(err);
      body.innerHTML = '<p class="t-mode-note" style="margin-top:0;">Could not turn on the spectator board. ' + escapeHtml(err.message || err.code || 'Try again.') + '</p>';
    }
  }

  async function stopLiveBoard(tournamentId) {
    if (!isAdminUi()) return toast('Admin only', 'error');
    const t = state.tournaments.find(function (x) { return x.id === tournamentId; });
    if (!t) return;
    if (!t.publicBoard) return toast('The spectator link is already disabled');
    if (!confirm('Disable the spectator link for "' + t.name + '"? Anyone with the link will see that it has expired, and live scores will no longer be readable.')) return;
    try {
      await db.collection('tournaments').doc(t.id).update({
        publicBoard: false,
        updatedAt: FieldValue.serverTimestamp()
      });
      const idx = state.tournaments.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) state.tournaments[idx] = Object.assign({}, state.tournaments[idx], { publicBoard: false });
      await syncPublicBoardNow(t.id, { forceClose: true, force: true });
      closeLiveModal('tShareBoard');
      toast('Spectator link disabled. The public link now shows as expired.');
      render();
    } catch (err) {
      console.error(err);
      toast('Could not disable the spectator link: ' + (err.message || err.code || 'unknown'), 'error');
    }
  }

  const watch = {
    board: null,
    parentBoard: null,
    liveMatches: [],
    ready: false,
    missing: false,
    closed: false,
    expired: false,
    error: null,
    preview: false,
    autoRefresh: false,
    reload: null,
    completedOpen: {},
    completedPage: {}
  };

  const WATCH_THEME_KEY = 'smash-watch-theme';

  function watchTheme() {
    try {
      const stored = localStorage.getItem(WATCH_THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (_) {}
    return 'dark';
  }

  function applyWatchTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#f1f5f9' : '#070b14');
  }

  function setWatchTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    try { localStorage.setItem(WATCH_THEME_KEY, next); } catch (_) {}
    applyWatchTheme(next);
    if (isPublicWatchPage()) renderPublicWatch();
  }

  function watchThemeToggleHtml() {
    const light = watchTheme() === 'light';
    return '<button type="button" class="w-copy" data-act="theme" title="'
      + (light ? 'Switch to dark mode' : 'Switch to light mode') + '">'
      + (light ? 'Dark' : 'Light') + '</button>';
  }

  function watchChromeButtonsHtml(opts) {
    opts = opts || {};
    const bits = [watchThemeToggleHtml()];
    if (opts.refresh) bits.push('<button type="button" class="w-copy" data-act="reload-watch">Refresh</button>');
    if (opts.copy) bits.push('<button type="button" class="w-copy" data-act="copy">Copy link</button>');
    return bits.join('');
  }

  function mergeWatchMatches(parent, liveMatches) {
    if (!parent) return parent;
    const byId = {};
    const order = [];
    function put(match) {
      if (!match || !match.id) return;
      if (!byId[match.id]) order.push(match.id);
      byId[match.id] = Object.assign({}, byId[match.id] || {}, match);
    }
    (parent.matches || []).forEach(put);
    (liveMatches || []).forEach(put);
    return Object.assign({}, parent, {
      matches: order.map(function (id) { return byId[id]; })
    });
  }

  function watchBoardKey(board) {
    if (!board) return '';
    const stages = (board.sports || []).map(function (sport) {
      return [
        sport.id,
        (sport.stageList || []).map(function (st) { return st && st.id; }),
        (sport.divisions || []).map(function (d) {
          return [
            d && d.id,
            skippedStageIds(d),
            completedStageIds(d),
            d && d.winnerId,
            d && d.runnerId,
            rankingRecord(d),
            (d && d.teams || []).map(function (tm) {
              return [tm && tm.id, tm && tm.name, parseTeamTags(tm && tm.tags), tm && tm.players];
            })
          ];
        })
      ];
    });
    const matches = (board.matches || []).map(function (match) {
      return [
        match.id,
        match.status,
        match.winner,
        match.resultType,
        match.games,
        match.sets,
        match.quarters,
        match.showUpcoming,
        match.scheduledAt,
        match.court,
        match.venue,
        match.stage,
        match.categoryId
      ];
    });
    return JSON.stringify([stages, matches]);
  }

  function publicWatchIsOpen(data) {
    return !!(data && data.publicBoard === true && data.published === true && data.started === true);
  }

  function publishWatchBoard() {
    const data = watch.parentBoard;
    if (!data) {
      watch.board = null;
      watch.closed = true;
      watch.renderKey = 'expired';
      renderPublicWatch();
      return;
    }
    const open = publicWatchIsOpen(data);
    const next = open ? mergeWatchMatches(data, watch.liveMatches) : null;
    const nextKey = (open ? 'open:' : (data.expired || data.publicBoard === false ? 'expired:' : 'closed:')) + watchBoardKey(next);
    watch.closed = !open;
    watch.expired = !open && (data.expired === true || data.publicBoard === false);
    if (watch.board && watch.renderKey === nextKey) return;
    watch.renderKey = nextKey;
    watch.board = next;
    renderPublicWatch();
  }

  function liveMatchesFromSnapshot(snap) {
    const list = [];
    snap.forEach(function (doc) {
      list.push(Object.assign({ id: doc.id }, doc.data() || {}));
    });
    return list;
  }

  function applyWatchParent(snap) {
    watch.error = null;
    if (!snap.exists) {
      watch.parentBoard = null;
      watch.closed = true;
      watch.expired = true;
      return;
    }
    watch.parentBoard = Object.assign({ id: snap.id }, snap.data() || {});
  }

  function sampleWatchBoard() {
    const board = {
      publicBoard: true,
      published: true,
      started: true,
      name: 'Parish Games',
      format: 'teams',
      sportMode: 'multi',
      rulesText: 'Be ready when your match is called. A walkover is awarded if a team does not arrive.',
      sports: [
        {
          id: 'badminton', label: 'Badminton', kind: 'racket', emoji: '🏸', color: '#06b6d4', date: '2026-10-19',
          hasThirdPlace: false, categoryMode: 'split',
          tablePoints: { win: 2, draw: 1, walkover: 2, noResult: 0 },
          stageList: [
            { id: 'league', name: 'League' },
            { id: 'stg_r16', name: 'Round of 16' },
            { id: 'semifinal', name: 'Semifinal' },
            { id: 'final', name: 'Final' }
          ],
          rulesText: 'One game to 21, cap 25. Best of three from the semifinals on.',
          teams: [],
          divisions: [{
            id: 'open', name: 'Open', open: true, maxPlayers: 2,
            teams: [
              { id: 'A', name: 'Sunrise', players: ['Ann', 'Ben'], tags: ['Seed 1'] },
              { id: 'B', name: 'Harbor', players: ['Cia', 'Dev'], tags: ['Seed 2'] },
              { id: 'C', name: 'North', players: ['Eve', 'Finn'] },
              { id: 'D', name: 'West', players: ['Gia', 'Hugo'], tags: ['Late start'] }
            ],
            brackets: [
              { id: 'b1', name: 'Group 1', stageId: 'league', teamIds: ['A', 'B', 'C'] },
              { id: 'b2', name: 'Group 2', stageId: 'league', teamIds: ['D'] },
              { id: 'b3', name: 'Bracket A', stageId: 'stg_r16', teamIds: ['A', 'C'] }
            ]
          }, {
            id: 'mixed', name: 'Mixed doubles', open: false, maxPlayers: 2,
            disabledStages: ['stg_r16', 'semifinal'],
            teams: [
              { id: 'E', name: 'Rivers', players: ['Ivy', 'Jon'] },
              { id: 'F', name: 'Lake', players: ['Kim', 'Leo'] }
            ],
            brackets: [
              { id: 'b4', name: 'Mixed A', stageId: 'league', teamIds: ['E', 'F'] }
            ]
          }]
        },
        {
          id: 'volleyball', label: 'Volleyball', kind: 'volleyball', emoji: '🏐', color: '#d946ef', date: '2026-10-19',
          hasThirdPlace: true, categoryMode: '',
          tablePoints: { win: 2, draw: 1, walkover: 2, noResult: 0 },
          stageList: [
            { id: 'league', name: 'League' },
            { id: 'semifinal', name: 'Semifinal' },
            { id: 'final', name: 'Final' },
            { id: 'third_place', name: '3rd Place' }
          ],
          rulesText: '',
          teams: [
            { id: 'G1', name: 'G1', wards: 'St. Euphrasia', tags: ['Home'] },
            { id: 'G2', name: 'G2', wards: 'St. Francis' },
            { id: 'G3', name: 'G3', wards: 'St. Mary' },
            { id: 'G4', name: 'G4', wards: 'St. Joseph' }
          ],
          divisions: []
        }
      ],
      matches: [
        { id: 'm1', sport: 'badminton', categoryId: 'open', bracketId: 'b1', stage: 'league', status: 'in_progress', teamA: 'A', teamB: 'B', court: 'Court 1', venue: 'Court 1', scheduledAt: '2026-10-19T18:00:00.000Z', games: [{ category: 'OD1', playersA: 'Ann / Ben', playersB: 'Cia / Dev', sets: [{ a: 21, b: 16 }, { a: 18, b: 16 }], winner: 'A' }] },
        { id: 'm8', sport: 'badminton', categoryId: 'open', bracketId: 'b2', stage: 'league', status: 'in_progress', teamA: 'C', teamB: 'D', court: 'Court 2', venue: 'Court 2', scheduledAt: '2026-10-19T18:05:00.000Z', games: [{ category: 'OD1', playersA: 'Eve / Finn', playersB: 'Gia / Hugo', sets: [{ a: 11, b: 9 }], winner: null }] },
        { id: 'm2', sport: 'badminton', categoryId: 'open', bracketId: 'b1', stage: 'league', status: 'scheduled', showUpcoming: true, teamA: 'A', teamB: 'C', scheduledAt: '2026-10-19T18:40:00.000Z' },
        { id: 'm9', sport: 'badminton', categoryId: 'open', bracketId: 'b1', stage: 'league', status: 'scheduled', showUpcoming: false, teamA: 'B', teamB: 'D', court: 'Court 1', venue: 'Court 1', scheduledAt: '2026-10-19T19:10:00.000Z' },
        { id: 'm3', sport: 'badminton', categoryId: 'open', bracketId: 'b1', stage: 'league', status: 'completed', teamA: 'B', teamB: 'C', winner: 'A', resultType: 'played', court: 'Court 1', venue: 'Court 1', scheduledAt: '2026-10-19T17:10:00.000Z', games: [{ category: 'OD1', playersA: 'Cia / Dev', playersB: 'Eve / Finn', sets: [{ a: 21, b: 19 }, { a: 21, b: 17 }], winner: 'A' }] },
        { id: 'm4', sport: 'badminton', categoryId: 'open', bracketId: 'b3', stage: 'stg_r16', status: 'scheduled', showUpcoming: true, teamA: 'A', teamB: 'C', court: 'Court 1', venue: 'Court 1', scheduledAt: '2026-10-19T20:00:00.000Z' },
        { id: 'm5', sport: 'volleyball', stage: 'league', status: 'completed', teamA: 'G1', teamB: 'G2', winner: 'A', resultType: 'played', venue: 'Hall', scheduledAt: '2026-10-19T16:00:00.000Z', sets: [{ a: 25, b: 20 }, { a: 25, b: 22 }] },
        { id: 'm6', sport: 'volleyball', stage: 'league', status: 'scheduled', showUpcoming: false, teamA: 'G3', teamB: 'G4', venue: 'Hall', scheduledAt: '2026-10-19T19:15:00.000Z' },
        { id: 'm10', sport: 'volleyball', stage: 'league', status: 'scheduled', showUpcoming: true, teamA: 'G1', teamB: 'G4', scheduledAt: '2026-10-19T19:45:00.000Z' },
        { id: 'm7', sport: 'volleyball', stage: 'semifinal', status: 'completed', teamA: 'G1', teamB: 'G3', winner: 'B', resultType: 'walkover', venue: 'Hall', scheduledAt: '2026-10-19T21:00:00.000Z', sets: [{ a: 0, b: 15 }] },
        { id: 'm11', sport: 'badminton', categoryId: 'mixed', bracketId: 'b4', stage: 'league', status: 'completed', teamA: 'E', teamB: 'F', winner: 'B', resultType: 'played', court: 'Court 3', venue: 'Court 3', scheduledAt: '2026-10-19T16:40:00.000Z', games: [{ category: 'MX', playersA: 'Ivy / Jon', playersB: 'Kim / Leo', sets: [{ a: 19, b: 21 }, { a: 16, b: 21 }], winner: 'B' }] },
        { id: 'm13', sport: 'badminton', categoryId: 'mixed', stage: 'stg_r16', status: 'completed', teamA: 'E', teamB: 'F', winner: 'A', resultType: 'played', court: 'Court 3', venue: 'Court 3', scheduledAt: '2026-10-19T17:00:00.000Z', games: [{ category: 'MX', playersA: 'Ivy / Jon', playersB: 'Kim / Leo', sets: [{ a: 21, b: 12 }], winner: 'A' }] },
        { id: 'm14', sport: 'badminton', categoryId: 'mixed', stage: 'stg_r16', status: 'in_progress', teamA: 'E', teamB: 'F', court: 'Court 4', venue: 'Court 4', scheduledAt: '2026-10-19T18:10:00.000Z', games: [{ category: 'MX', playersA: 'Ivy / Jon', playersB: 'Kim / Leo', sets: [{ a: 8, b: 5 }], winner: null }] },
        { id: 'm12', sport: 'badminton', categoryId: 'open', bracketId: 'b1', stage: 'league', status: 'completed', teamA: 'A', teamB: 'D', winner: 'A', resultType: 'walkover', court: 'Court 2', venue: 'Court 2', scheduledAt: '2026-10-19T15:20:00.000Z', games: [{ category: 'OD1', playersA: 'Ann / Ben', playersB: 'Gia / Hugo', sets: [{ a: 15, b: 0 }], winner: 'A' }] }
      ]
    };
    const pairs = [
      ['A', 'B', 'Ann / Ben', 'Cia / Dev'],
      ['A', 'C', 'Ann / Ben', 'Eve / Finn'],
      ['A', 'D', 'Ann / Ben', 'Gia / Hugo'],
      ['B', 'C', 'Cia / Dev', 'Eve / Finn'],
      ['B', 'D', 'Cia / Dev', 'Gia / Hugo'],
      ['C', 'D', 'Eve / Finn', 'Gia / Hugo'],
      ['A', 'B', 'Ann / Ben', 'Cia / Dev'],
      ['C', 'A', 'Eve / Finn', 'Ann / Ben'],
      ['D', 'B', 'Gia / Hugo', 'Cia / Dev'],
      ['C', 'B', 'Eve / Finn', 'Cia / Dev']
    ];
    pairs.forEach(function (pair, i) {
      const winner = i % 2 === 0 ? 'A' : 'B';
      board.matches.push({
        id: 'mx' + i,
        sport: 'badminton',
        categoryId: 'open',
        bracketId: 'b1',
        stage: 'league',
        status: 'completed',
        teamA: pair[0],
        teamB: pair[1],
        winner: winner,
        resultType: 'played',
        court: 'Court 1',
        venue: 'Court 1',
        scheduledAt: '2026-10-19T' + String(10 + i).padStart(2, '0') + ':00:00.000Z',
        games: [{
          category: 'OD1',
          playersA: pair[2],
          playersB: pair[3],
          sets: winner === 'A'
            ? [{ a: 21, b: 16 }, { a: 21, b: 18 }]
            : [{ a: 18, b: 21 }, { a: 15, b: 21 }],
          winner: winner
        }]
      });
    });
    return board;
  }

  function watchParams() {
    const params = new URLSearchParams(location.search);
    return {
      token: params.get('s') || '',
      tournamentId: params.get('t') || '',
      sportId: params.get('sport') || '',
      panel: params.get('panel') === 'rules' || params.get('panel') === 'teams' ? params.get('panel') : 'summary',
      stageId: params.get('st') || '',
      categoryId: params.get('cat') || '',
      teamId: params.get('team') || '',
      live: params.get('live') === '1'
    };
  }

  function setWatchParams(next) {
    const params = new URLSearchParams(location.search);
    const token = params.get('s');
    const liveOn = Object.prototype.hasOwnProperty.call(next, 'live')
      ? !!next.live
      : params.get('live') === '1';
    ['sport', 'panel', 'st', 'cat', 'team'].forEach(function (key) {
      if (next[key]) params.set(key, next[key]);
      else params.delete(key);
    });
    if (token) params.set('s', token);
    else params.delete('s');
    if (liveOn) params.set('live', '1');
    else params.delete('live');
    params.delete('t');
    const qs = params.toString();
    history.replaceState(null, '', 'watch.html' + (qs ? '?' + qs : ''));
    renderPublicWatch();
  }

  function watchUpdatedLabel(board) {
    const u = board && board.updatedAt;
    let d = null;
    if (u && typeof u.toDate === 'function') d = u.toDate();
    else if (u && u.seconds) d = new Date(u.seconds * 1000);
    if (!d || isNaN(d.getTime())) return 'Live';
    return 'Updated ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function watchScoreText(match, tournament) {
    const kind = resultKind(match);
    if (kind === 'no_result') return { a: '–', b: '–', note: 'No result' };
    if (kind === 'walkover') {
      const sets = watchSetScores(match, tournament);
      if (sets.length) {
        const last = String(sets[sets.length - 1] || '0–0').split('–');
        return {
          a: last[0] || '0',
          b: last[1] || '0',
          note: 'Walkover',
          line: sets.join('  ')
        };
      }
      return { a: match.winner === 'A' ? 'W' : '0', b: match.winner === 'B' ? 'W' : '0', note: 'Walkover' };
    }
    if (usesRacketSetPoints(match, tournament)) {
      const line = racketSetScoreLine(match, tournament);
      const parts = line.split('  ');
      const last = parts[parts.length - 1] || '0–0';
      const split = last.split('–');
      return {
        a: split[0] || '0',
        b: split[1] || '0',
        note: kind === 'draw' ? 'Draw' : '',
        line: line
      };
    }
    if (match.status !== 'in_progress' && match.status !== 'completed') return { a: '', b: '', note: 'vs' };
    const s = matchScoreDisplay(match, tournament);
    return { a: s.a, b: s.b, note: kind === 'draw' ? 'Draw' : '' };
  }

  function watchDetailLine(match, tournament) {
    const sport = getSportConfig(tournament, match.sport);
    if (!sport) return '';
    if (sport.kind === 'volleyball') {
      return (match.sets || []).map(function (s) { return (s.a || 0) + '–' + (s.b || 0); }).join('  ·  ');
    }
    if (sport.kind === 'basketball') {
      return (match.quarters || []).map(function (q, i) { return 'Q' + (i + 1) + ' ' + (q.a || 0) + '–' + (q.b || 0); }).join('  ·  ');
    }
    if (sport.kind === 'racket') {
      return racketGamesForMatch(match, tournament, sport).map(function (g) {
        const sets = (g.sets || []).map(function (s) { return (s.a || 0) + '–' + (s.b || 0); }).join(', ');
        return (g.category || 'Game') + (sets ? ' ' + sets : '');
      }).join('  ·  ');
    }
    return '';
  }

  function watchSideHtml(tournament, sportId, teamId, winner) {
    const meta = teamMeta(tournament, sportId, teamId);
    return `
      <div class="w-side ${winner ? 'is-winner' : ''}">
        <span class="w-swatch" style="background:${meta.color}"></span>
        <div>
          <div class="w-side-name">${escapeHtml(meta.name)}</div>
          ${meta.wards ? '<div class="w-side-sub">' + escapeHtml(meta.wards) + '</div>' : ''}
          ${teamTagsHtml(meta.tags, 'watch')}
        </div>
      </div>
    `;
  }

  function watchScoreboardHtml(match, tournament, featured) {
    const sport = getSportConfig(tournament, match.sport);
    const p = participantsOf(match, tournament);
    const score = watchScoreText(match, tournament);
    const detail = watchDetailLine(match, tournament);
    const live = match.status === 'in_progress';
    const kind = resultKind(match);
    const stage = stageLabelOf(sport, match.stage);
    const when = match.scheduledAt ? fmtDateTime(match.scheduledAt) : 'Time to be set';
    const kicker = [
      live ? 'On now' : (match.status === 'completed' ? 'Final' : 'Next'),
      sport ? ((sport.emoji || '') + ' ' + (sport.label || '')) : '',
      stage,
      courtOf(match)
    ].filter(Boolean).join(' · ');
    const center = score.note === 'vs'
      ? '<div class="w-vs">VS</div>'
      : (score.line
        ? '<div class="w-score-num w-score-sets"><b>' + escapeHtml(score.line) + '</b></div>'
        : '<div class="w-score-num"><b>' + escapeHtml(score.a) + '</b><span>–</span><b>' + escapeHtml(score.b) + '</b></div>');
    return `
      <article class="w-scoreboard ${live ? 'is-live' : ''} ${featured ? 'is-featured' : ''} ${match.status === 'completed' ? 'is-done' : ''}">
        <div class="w-kicker">${live ? '<span class="w-live-dot"></span>' : ''}${escapeHtml(kicker)}</div>
        <div class="w-score-row">
          <button type="button" class="w-side-btn" data-act="team" data-team="${escapeHtml(p.a || '')}" data-sport="${escapeHtml(match.sport || '')}">
            ${watchSideHtml(tournament, match.sport, p.a, match.winner === 'A')}
          </button>
          ${center}
          <button type="button" class="w-side-btn right" data-act="team" data-team="${escapeHtml(p.b || '')}" data-sport="${escapeHtml(match.sport || '')}">
            ${watchSideHtml(tournament, match.sport, p.b, match.winner === 'B')}
          </button>
        </div>
        ${detail ? '<div class="w-detail">' + escapeHtml(detail) + '</div>' : ''}
        <div class="w-meta">${escapeHtml(when)}${kind === 'draw' ? ' · Draw' : ''}${kind === 'walkover' ? ' · Walkover' : ''}${kind === 'no_result' ? ' · No result' : ''}</div>
      </article>
    `;
  }

  function watchFixtureHtml(match, tournament, opts) {
    const sport = getSportConfig(tournament, match.sport);
    const p = participantsOf(match, tournament);
    const a = teamMeta(tournament, match.sport, p.a);
    const b = teamMeta(tournament, match.sport, p.b);
    const hideScore = !!(opts && opts.hideScore) || (match.status !== 'in_progress' && match.status !== 'completed');
    const score = hideScore ? null : watchScoreText(match, tournament);
    const mid = hideScore ? 'vs' : (score.note === 'vs' ? 'vs' : (score.line || (score.a + '–' + score.b)));
    const division = findDivision(sport, match.categoryId);
    const showCategory = !!(opts && opts.showCategory && division);
    const bits = [];
    if (showCategory) bits.push(division.name || 'Category');
    bits.push(stageLabelOf(sport, match.stage));
    if (!hideScore && resultKind(match) === 'walkover') bits.push('Walkover');
    if (!hideScore && resultKind(match) === 'no_result') bits.push('No result');
    return `
      <div class="w-fixture">
        <div class="w-fix-when">${escapeHtml(match.scheduledAt ? fmtDateTime(match.scheduledAt) : 'Time TBD')}${courtOf(match) ? ' · ' + escapeHtml(courtOf(match)) : ''}</div>
        <div class="w-fix-row">
          <span class="w-swatch sm" style="background:${a.color}"></span>
          <span class="w-fix-name">${escapeHtml(a.name)}</span>
          <span class="w-fix-mid">${escapeHtml(mid)}</span>
          <span class="w-fix-name right">${escapeHtml(b.name)}</span>
          <span class="w-swatch sm" style="background:${b.color}"></span>
        </div>
        <div class="w-fix-stage">${escapeHtml(bits.join(' · '))}</div>
      </div>
    `;
  }

  function watchTableHtml(tournament, sportId, rows, emptyLabel, opts) {
    if (!rows.length) return '<p class="w-empty">' + escapeHtml(emptyLabel || 'No matches completed in this stage yet.') + '</p>';
    const showGroups = !!(opts && opts.showGroups) || rows.some(function (r) { return r && r.groupName; });
    const showPointBreakdown = !!(opts && opts.showPointBreakdown) || showGroups;
    const sport = getSportConfig(tournament, sportId);
    const division = opts && opts.division;
    const stageId = opts && opts.stageId;
    return `
      <div class="w-table-scroll"><table class="w-table">
        <thead><tr><th>#</th><th class="w-team-col">Team</th>${showGroups ? '<th>Group</th><th>Grp</th>' : ''}<th>P</th><th>W</th><th>D</th><th>L</th>${showPointBreakdown ? '<th title="Points for">PF</th><th title="Points against">PA</th><th title="Points difference">PD</th>' : ''}<th>Pts</th></tr></thead>
        <tbody>
          ${rows.map(function (r, i) {
            const place = r.rank || (i + 1);
            const meta = teamMeta(tournament, sportId, r.id);
            return `
              <tr class="rank-${place}" data-act="team" data-team="${escapeHtml(r.id)}" data-sport="${escapeHtml(sportId)}">
                <td><span class="w-rank">${place}</span></td>
                <td class="w-team-col"><span class="w-team"><span class="w-swatch sm" style="background:${meta.color}"></span><span><span>${escapeHtml(meta.name)}</span>${teamLabelsHtml(meta.tags, stageSeedOf(division, sport, stageId, r.id), 'watch')}</span></span></td>
                ${showGroups ? '<td>' + escapeHtml(r.groupName || '—') + '</td><td>' + (r.groupRank || '—') + '</td>' : ''}
                <td>${r.played}</td><td>${r.won}</td><td>${r.drawn || 0}</td><td>${r.lost}</td>${showPointBreakdown ? '<td>' + (r.pointsFor || 0) + '</td><td>' + (r.pointsAgainst || 0) + '</td><td>' + ((r.pointsFor || 0) - (r.pointsAgainst || 0)) + '</td>' : ''}<td class="pts">${r.points}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table></div>
    `;
  }

  function watchRulesPanelHtml(tournament, sport) {
    const blocks = [];
    if (String(tournament.rulesText || '').trim()) {
      blocks.push(`
        <section class="w-panel">
          <h3>Tournament rules</h3>
          <div class="w-rules-text">${rulesToDisplayHtml(tournament.rulesText)}</div>
        </section>
      `);
    }
    if (sport && String(sport.rulesText || '').trim()) {
      blocks.push(`
        <section class="w-panel">
          <h3>${escapeHtml((sport.emoji || '') + ' ' + (sport.label || 'Sport'))} rules</h3>
          <div class="w-rules-text">${rulesToDisplayHtml(sport.rulesText)}</div>
        </section>
      `);
    }
    if (!blocks.length) {
      return '<section class="w-quiet-card"><h2>No rules posted yet</h2><p>The organizer has not added tournament or sport rules.</p></section>';
    }
    return '<div class="w-rules-grid">' + blocks.join('') + '</div>';
  }

  const WATCH_COMPLETED_PAGE = 10;

  function watchCompletedPage(key) {
    const pages = watch.completedPage || {};
    return Math.max(1, parseInt(pages[key], 10) || 1);
  }

  function setWatchCompletedPage(key, page) {
    if (!watch.completedPage) watch.completedPage = {};
    watch.completedPage[key] = Math.max(1, page);
  }

  function watchCompletedIsOpen(key) {
    return !!(watch.completedOpen && watch.completedOpen[key]);
  }

  function setWatchCompletedOpen(key, open) {
    if (!watch.completedOpen) watch.completedOpen = {};
    watch.completedOpen[key] = !!open;
  }

  function watchPlayersForSide(match, tournament, side) {
    const sport = getSportConfig(tournament, match && match.sport);
    if (sport && sport.kind === 'racket') {
      const game = racketGamesForMatch(match, tournament, sport)[0] || {};
      const fromGame = String((side === 'B' ? game.playersB : game.playersA) || '').trim();
      if (fromGame) return fromGame;
    }
    const p = participantsOf(match, tournament);
    const id = side === 'B' ? p.b : p.a;
    const found = findEntryTeam(tournament, match.sport, id);
    return found ? teamPlayersLabel(found.team) : '';
  }

  function watchSideLines(match, tournament, side) {
    const p = participantsOf(match, tournament);
    const id = side === 'B' ? p.b : p.a;
    const meta = teamMeta(tournament, match.sport, id);
    const players = watchPlayersForSide(match, tournament, side);
    const same = !players || players.replace(/\s+/g, ' ').toLowerCase() === String(meta.name || '').replace(/\s+/g, ' ').toLowerCase();
    return {
      id: id || '',
      name: meta.name || '—',
      players: same ? '' : players,
      winner: match.winner === side,
      color: meta.color
    };
  }

  function watchSetScores(match, tournament) {
    const kind = resultKind(match);
    if (kind === 'no_result') return [];
    const sport = getSportConfig(tournament, match && match.sport);
    if (!sport) return [];
    function pairs(list) {
      return (list || []).filter(function (s, i, all) {
        return (s.a || 0) > 0 || (s.b || 0) > 0 || (all.length === 1 && i === 0);
      }).map(function (s) { return (s.a || 0) + '–' + (s.b || 0); });
    }
    if (sport.kind === 'racket') {
      return pairs((racketGamesForMatch(match, tournament, sport)[0] || {}).sets);
    }
    if (sport.kind === 'volleyball') return pairs(match.sets);
    if (sport.kind === 'basketball') {
      return (match.quarters || []).map(function (q, i) {
        return 'Q' + (i + 1) + ' ' + (q.a || 0) + '–' + (q.b || 0);
      });
    }
    return [];
  }

  function watchWinnerText(match, tournament) {
    const kind = resultKind(match);
    if (kind === 'no_result') return 'No result';
    if (kind === 'draw') return 'Draw';
    if (match.winner !== 'A' && match.winner !== 'B') return '';
    const side = watchSideLines(match, tournament, match.winner);
    const label = side.players ? side.name + ' · ' + side.players : side.name;
    return (kind === 'walkover' ? 'Walkover: ' : 'Winner: ') + label;
  }

  function watchCompletedMatchHtml(match, tournament) {
    const a = watchSideLines(match, tournament, 'A');
    const b = watchSideLines(match, tournament, 'B');
    const sets = watchSetScores(match, tournament);
    const winner = watchWinnerText(match, tournament);
    const sport = getSportConfig(tournament, match.sport);
    const kind = resultKind(match);
    const setsHtml = sets.length
      ? '<div class="w-result-sets" aria-label="Set scores">' + sets.map(function (s) {
        return '<span>' + escapeHtml(s) + '</span>';
      }).join('') + '</div>'
      : '<div class="w-result-sets is-empty">' + escapeHtml(kind === 'walkover' ? 'Walkover' : (kind === 'no_result' ? 'No result' : '—')) + '</div>';
    function sideHtml(side, align) {
      return `
        <div class="w-result-side ${align} ${side.winner ? 'is-winner' : ''}">
          <span class="w-swatch sm" style="background:${side.color}"></span>
          <div>
            <b>${escapeHtml(side.name)}</b>
            ${side.players ? '<small>' + escapeHtml(side.players) + '</small>' : ''}
          </div>
        </div>`;
    }
    return `
      <article class="w-result">
        <div class="w-result-when">${escapeHtml(match.scheduledAt ? fmtDateTime(match.scheduledAt) : 'Completed')}${courtOf(match) ? ' · ' + escapeHtml(courtOf(match)) : ''}${sport ? ' · ' + escapeHtml(stageLabelOf(sport, match.stage)) : ''}</div>
        <div class="w-result-row">
          ${sideHtml(a, '')}
          ${setsHtml}
          ${sideHtml(b, 'right')}
        </div>
        ${winner ? '<div class="w-result-win">' + escapeHtml(winner) + '</div>' : ''}
      </article>`;
  }

  function watchCompletedSectionHtml(matches, tournament, key, title) {
    const list = matches || [];
    if (!list.length) return '';
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / WATCH_COMPLETED_PAGE));
    let page = watchCompletedPage(key);
    if (page > pages) {
      page = pages;
      setWatchCompletedPage(key, page);
    }
    const start = (page - 1) * WATCH_COMPLETED_PAGE;
    const slice = list.slice(start, start + WATCH_COMPLETED_PAGE);
    const open = watchCompletedIsOpen(key);
    const pager = pages > 1
      ? `<div class="w-pager">
          <button type="button" class="w-copy" data-act="done-page" data-key="${escapeHtml(key)}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
          <span>Page ${page} of ${pages}</span>
          <button type="button" class="w-copy" data-act="done-page" data-key="${escapeHtml(key)}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
        </div>`
      : '';
    return `
      <section class="w-panel w-completed" id="wDone-${escapeHtml(key)}">
        <details class="w-done" data-done-key="${escapeHtml(key)}" ${open ? 'open' : ''}>
          <summary>
            <h3>Completed matches ${title ? '<small>' + escapeHtml(title) + '</small>' : ''} <i>${total}</i></h3>
          </summary>
          <div class="w-list">${slice.map(function (m) { return watchCompletedMatchHtml(m, tournament); }).join('')}</div>
          ${pager}
        </details>
      </section>`;
  }

  function bindWatchCompletedControls(root) {
    if (!root) return;
    root.querySelectorAll('details.w-done').forEach(function (node) {
      node.addEventListener('toggle', function () {
        setWatchCompletedOpen(node.getAttribute('data-done-key'), node.open);
      });
    });
    root.querySelectorAll('[data-act="done-page"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const key = btn.getAttribute('data-key');
        const page = parseInt(btn.getAttribute('data-page'), 10) || 1;
        if (btn.disabled || page < 1) return;
        setWatchCompletedOpen(key, true);
        setWatchCompletedPage(key, page);
        renderPublicWatch();
        const el = document.getElementById('wDone-' + key);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
    });
  }

  function completedMatchesForCategory(matches, sport, categoryId) {
    const sportId = sport && sport.id;
    return (matches || []).filter(function (m) {
      if (m.sport !== sportId || m.status !== 'completed' || m.categoryId !== categoryId) return false;
      return matchStageApplies(sport, m);
    }).sort(sortMatches).reverse();
  }

  function upcomingMatchesForWatch(matches) {
    return (matches || []).filter(function (m) {
      return m && m.status === 'scheduled' && m.showUpcoming;
    }).sort(sortMatches);
  }

  function scheduledMatchesForStage(matches, sport, categoryId, stageId) {
    const sportId = sport && sport.id;
    const stage = stageId || 'league';
    return (matches || []).filter(function (m) {
      if (!m || m.status !== 'scheduled') return false;
      if (sportId && m.sport !== sportId) return false;
      if (categoryId && m.categoryId !== categoryId) return false;
      if ((m.stage || 'league') !== stage) return false;
      return !sport || matchStageApplies(sport, m);
    }).sort(sortMatches);
  }

  function watchWinnersHtml(tournament, sport) {
    const blocks = podiumBlocks(tournament, sport);
    if (!blocks.length) return '';
    return `
      <section class="w-panel w-podium-panel">
        <h3>Winners</h3>
        <div class="t-podium-grid">${blocks.map(function (block) {
          return podiumBlockHtml(tournament, sport, block, { topOnly: true });
        }).join('')}</div>
      </section>
    `;
  }

  function watchCategoryTeamsHtml(tournament, sport, division) {
    const catName = (division && division.name) || 'Category';
    const teams = (division && division.teams) || [];
    if (!teams.length) {
      return `
        <section class="w-panel">
          <h3>Teams <small>${escapeHtml(catName)}</small></h3>
          <p class="w-empty">No teams in this category yet.</p>
        </section>`;
    }
    const cards = teams.map(function (team) {
      const meta = teamMeta(tournament, sport.id, team.id);
      const players = (team.players || []).map(function (p) {
        return String(p || '').trim();
      }).filter(Boolean);
      return `
        <article class="w-team-card">
          <div class="w-team-card-head">
            <span class="w-swatch" style="background:${meta.color}"></span>
            <div>
              <b>${escapeHtml(meta.name)}</b>
              ${teamTagsHtml(parseTeamTags(team.tags), 'watch')}
            </div>
          </div>
          <div class="w-team-players">${players.length
            ? players.map(function (p) { return '<span>' + escapeHtml(p) + '</span>'; }).join('')
            : '<span class="w-empty">No players listed</span>'}</div>
        </article>`;
    }).join('');
    return `
      <section class="w-panel">
        <h3>Teams <small>${escapeHtml(catName)} · ${teams.length}</small></h3>
        <div class="w-team-grid">${cards}</div>
      </section>`;
  }

  function watchUpcomingListHtml(matches, tournament, title, opts) {
    const list = matches || [];
    const showCategory = !!(opts && opts.showCategory);
    const heading = (opts && opts.heading) || 'Upcoming';
    const empty = (opts && opts.empty)
      || ('No ' + heading.toLowerCase() + ' matches' + (title ? ' in ' + title : '') + '.');
    const body = list.length
      ? '<div class="w-list">' + list.map(function (m) {
        return watchFixtureHtml(m, tournament, { showCategory: showCategory, hideScore: true });
      }).join('') + '</div>'
      : '<p class="w-empty">' + escapeHtml(empty) + '</p>';
    return `
      <section class="w-panel">
        <h3>${escapeHtml(heading)} ${title ? '<small>' + escapeHtml(title) + '</small>' : ''}${list.length ? '<i>' + list.length + '</i>' : ''}</h3>
        ${body}
      </section>`;
  }

  function bindWatchToolbar(scope) {
    const shell = scope || document.body;
    shell.querySelectorAll('[data-act="reload-watch"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof watch.reload === 'function') watch.reload();
      });
    });
    shell.querySelectorAll('[data-act="theme"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setWatchTheme(watchTheme() === 'light' ? 'dark' : 'light');
      });
    });
  }

  function renderPublicWatch() {
    const top = document.getElementById('wTop');
    const root = document.getElementById('wContent');
    if (!top || !root) return;
    applyWatchTheme(watchTheme());
    if (!watch.ready && !watch.preview) {
      document.title = 'Live scores';
      top.innerHTML = '<div class="w-brand"><img src="icons/smash-logo.png" alt="" /><span>' + (watch.autoRefresh ? 'Live' : 'Scores') + '</span></div>'
        + watchChromeButtonsHtml();
      root.innerHTML = '<div class="w-status">Loading scores…</div>';
      bindWatchToolbar();
      return;
    }
    if (watch.missing || watch.closed || watch.expired || watch.error || !watch.board) {
      document.title = watch.expired ? 'Link expired' : 'Live scores';
      const params = watchParams();
      top.innerHTML = '<div class="w-brand"><img src="icons/smash-logo.png" alt="" /><span>' + (watch.expired ? 'Expired' : (watch.autoRefresh ? 'Live' : 'Scores')) + '</span></div>'
        + watchChromeButtonsHtml({ refresh: !watch.preview && !watch.autoRefresh && !!params.token });
      const heading = watch.expired
        ? 'This spectator link has expired'
        : 'Scores stay here';
      const msg = watch.missing
        ? 'This link is missing a tournament. Ask the organizer for the spectator link.'
        : (watch.expired
          ? 'The organizer disabled this live board. Scores are no longer available on this link.'
          : 'This live board is not open yet. It appears after an admin publishes the tournament, starts it, and turns on the spectator link.');
      root.innerHTML = `
        <section class="w-closed ${watch.expired ? 'is-expired' : ''}">
          <div class="w-closed-mark">${watch.expired ? '⛔' : '🏆'}</div>
          <h1>${heading}</h1>
          <p>${msg}</p>
          ${params.tournamentId ? '<a class="w-quiet" href="tournament.html?t=' + encodeURIComponent(params.tournamentId) + '">Organizer sign-in</a>' : ''}
        </section>
      `;
      bindWatchToolbar();
      return;
    }

    const tournament = watch.board;
    const matches = tournament.matches || [];
    const params = watchParams();
    const sports = tournament.sports || [];
    let sport = sports.find(function (s) { return s.id === params.sportId; }) || null;
    if (!sport) {
      const liveMatch = matches.find(function (m) { return m.status === 'in_progress'; });
      sport = (liveMatch && sports.find(function (s) { return s.id === liveMatch.sport; })) || sports[0] || null;
    }
    if (!sport) {
      top.innerHTML = '<div class="w-brand"><img src="icons/smash-logo.png" alt="" /><span>' + escapeHtml(tournament.name || 'Live') + '</span></div>'
        + watchChromeButtonsHtml();
      root.innerHTML = '<div class="w-status">This tournament has no sports yet.</div>';
      bindWatchToolbar();
      return;
    }
    const divisions = sport.divisions || [];
    const categorized = usesRegistrationCategories(sport);
    const division = categorized && params.categoryId ? findDivision(sport, params.categoryId) : null;
    const categorySummary = categorized && !division;
    let panel = params.panel;
    if (panel === 'teams' && (!categorized || !division)) panel = 'summary';
    const sportPool = matches.filter(function (m) {
      return m.sport === sport.id && matchStageApplies(sport, m);
    });
    const pool = sportPool.filter(function (m) {
      if (m.sport !== sport.id) return false;
      if (division && m.categoryId !== division.id) return false;
      if (categorySummary) return true;
      if (!division && (m.categoryId || m.bracketId)) return false;
      return true;
    });
    const stages = division ? categoryStages(sport, division) : stageListFor(sport);
    let stageId = params.stageId;
    if (!stages.some(function (st) { return st.id === stageId; })) {
      const liveHere = pool.find(function (m) {
        return m.status === 'in_progress' && stages.some(function (st) { return st.id === (m.stage || 'league'); });
      });
      stageId = (liveHere && liveHere.stage) || resolveDivisionStageId(sport, division, '');
    }
    const stageName = stageLabelOf(sport, stageId);
    const stagePool = pool.filter(function (m) { return (m.stage || 'league') === stageId; });
    const live = (categorySummary ? pool : stagePool)
      .filter(function (m) { return m.status === 'in_progress'; })
      .sort(sortMatches);
    const upcoming = division
      ? scheduledMatchesForStage(sportPool, sport, division.id, stageId)
      : upcomingMatchesForWatch(stagePool);
    const summaryUpcoming = upcomingMatchesForWatch(pool);
    const done = stagePool.filter(function (m) { return m.status === 'completed'; }).sort(sortMatches).reverse();
    const categoryDone = division
      ? completedMatchesForCategory(sportPool, sport, division.id)
      : [];
    const completedByCategory = categorized
      ? divisions.map(function (d) {
        return {
          division: d,
          matches: completedMatchesForCategory(sportPool, sport, d.id)
        };
      }).filter(function (group) { return group.matches.length; })
      : [];
    const allLive = pool.filter(function (m) { return m.status === 'in_progress'; });
    const summaryCompletedHtml = categorySummary
      ? completedByCategory.map(function (group) {
        return watchCompletedSectionHtml(
          group.matches,
          tournament,
          'sum-' + sport.id + '-' + group.division.id,
          group.division.name || 'Category'
        );
      }).join('')
      : '';
    const categoryCompletedHtml = division
      ? watchCompletedSectionHtml(categoryDone, tournament, 'cat-' + sport.id + '-' + division.id, division.name || 'Category')
      : '';
    const teamCompletedHtml = !categorized
      ? watchCompletedSectionHtml(done, tournament, 'st-' + sport.id + '-' + stageId, stageName)
      : '';

    document.title = (tournament.name || 'Live') + ' — ' + (sport.label || 'Scores');
    const sportPills = sports.map(function (s) {
      const on = s.id === sport.id;
      const n = matches.filter(function (m) {
        return m.sport === s.id && m.status === 'in_progress' && matchStageApplies(s, m);
      }).length;
      return `<button type="button" class="w-pill ${on ? 'is-on' : ''}" style="--accent:${s.color || '#3b82f6'}" data-act="sport" data-sport="${escapeHtml(s.id)}">${escapeHtml((s.emoji || '') + ' ' + (s.label || s.id))}${n ? '<i>' + n + '</i>' : ''}</button>`;
    }).join('');
    const modeNote = watch.preview ? ' · Sample' : (watch.autoRefresh ? ' · Live' : ' · Refresh for latest');
    top.innerHTML = `
      <div class="w-brand"><img src="icons/smash-logo.png" alt="" /><div><b>${escapeHtml(tournament.name || 'Live')}</b><small>${escapeHtml(watchUpdatedLabel(tournament))}${modeNote}</small></div></div>
      <div class="w-pills">${sportPills}</div>
      ${watchChromeButtonsHtml({ refresh: !watch.preview && !watch.autoRefresh, copy: true })}
    `;

    const matchesOn = panel === 'summary' && (!categorized || categorySummary);
    const navPills = `<div class="w-pills w-sub w-view-tabs" aria-label="Spectator views">
        <button type="button" class="w-pill ${matchesOn ? 'is-on' : ''}" data-act="watch-panel" data-panel="summary">Matches</button>
        ${categorized ? divisions.map(function (d) {
          return `<button type="button" class="w-pill ${(panel === 'summary' || panel === 'teams') && division && d.id === division.id ? 'is-on' : ''}" data-act="cat" data-cat="${escapeHtml(d.id)}">${escapeHtml(d.name || 'Category')}</button>`;
        }).join('') : ''}
        <button type="button" class="w-pill ${panel === 'rules' ? 'is-on' : ''}" data-act="watch-panel" data-panel="rules">Rules</button>
      </div>`;
    const catTabs = division ? `<div class="w-pills w-sub" aria-label="Category views">
        <button type="button" class="w-pill ${panel !== 'teams' ? 'is-on' : ''}" data-act="cat-panel" data-panel="summary">Overview</button>
        <button type="button" class="w-pill ${panel === 'teams' ? 'is-on' : ''}" data-act="cat-panel" data-panel="teams">Teams</button>
      </div>` : '';
    const stagePills = categorySummary || panel === 'rules' || panel === 'teams' ? '' : `<div class="w-pills w-sub">${stages.map(function (st) {
      const count = pool.filter(function (m) { return m.stage === st.id && m.status === 'in_progress'; }).length;
      const done = division && stageIsMarkedComplete(division, st.id);
      return `<button type="button" class="w-pill ${st.id === stageId ? 'is-on' : ''}" data-act="stage" data-stage="${escapeHtml(st.id)}">${escapeHtml(st.name || st.id)}${done ? ' · Done' : ''}${count ? '<i>' + count + '</i>' : ''}</button>`;
    }).join('')}</div>`;

    const heroMatches = categorySummary
      ? live
      : (categorized ? [] : live);
    const hero = heroMatches.length
      ? `<div class="w-hero-row">${heroMatches.map(function (m, i) { return watchScoreboardHtml(m, tournament, i === 0); }).join('')}</div>`
      : (categorySummary
        ? '<section class="w-quiet-card"><h2>No current matches</h2><p>Live matches from every category will appear here.</p></section>'
        : (categorized ? '' : `<section class="w-quiet-card"><h2>No ${escapeHtml(stageName)} matches on the board yet</h2><p>Live scores show here. Upcoming matches on Matches appear after an admin marks them.</p></section>`));
    const standScope = { stageId: stageId, useTeams: true };
    if (division) standScope.categoryId = division.id;
    const brackets = division ? bracketsInStage(division, stageId) : [];
    const populatedBrackets = brackets.filter(bracketHasTeams);
    const rankingRows = division ? computeStageRanking(tournament, matches, sport, division, stageId) : [];
    const showOverallTable = !division && (showsOverallPointsTable(tournament) || !brackets.length);
    const overall = showOverallTable ? computeStandings(tournament, matches, sport.id, standScope) : [];
    const bracketBlocks = populatedBrackets.map(function (b) {
      const rows = computeStandings(tournament, matches, sport.id, {
        stageId: stageId,
        categoryId: division.id,
        bracketId: b.id,
        teamIds: bracketTeamIds(b),
        useTeams: true
      });
      return `<section class="w-panel"><h3>${escapeHtml(b.name || 'Bracket')}${b.complete ? ' · Complete' : ''}</h3>${watchTableHtml(tournament, sport.id, rows, 'No results in ' + (b.name || 'this bracket') + ' yet.', { showPointBreakdown: true, division: division, stageId: stageId })}</section>`;
    }).join('');

    let focus = '';
    if (params.teamId) {
      const ranking = division ? rankingRows : overall;
      const bracket = division ? bracketForTeam(division, params.teamId, stageId) : null;
      const bracketRows = bracket ? computeStandings(tournament, matches, sport.id, {
        stageId: stageId, categoryId: division.id, bracketId: bracket.id, teamIds: bracket.teamIds || [], useTeams: true
      }) : [];
      const mine = matches.filter(function (m) {
        if (m.sport !== sport.id || !matchStageApplies(sport, m)) return false;
        const p = participantsOf(m, tournament);
        return p.a === params.teamId || p.b === params.teamId;
      }).sort(sortMatches);
      const meta = teamMeta(tournament, sport.id, params.teamId);
      focus = `
        <section class="w-follow">
          <div class="w-follow-head">
            <div><span class="w-swatch" style="background:${meta.color}"></span><div><b>${escapeHtml(meta.name)}</b>${teamLabelsHtml(meta.tags, stageSeedOf(division, sport, stageId, params.teamId), 'watch')}<small>${escapeHtml(stageName)}${bracket ? ' · ' + escapeHtml(bracket.name || 'Bracket') : ''}${stageSeedOf(division, sport, stageId, params.teamId) ? ' · Seed ' + stageSeedOf(division, sport, stageId, params.teamId) : ''}</small></div></div>
            <button type="button" class="w-copy" data-act="clear-team">Close</button>
          </div>
          <div class="w-follow-stats">
            <div><span>Bracket</span><b>${escapeHtml(bracket ? standingLine(rankOf(bracketRows, params.teamId)) : 'Not in a bracket this stage')}</b></div>
            ${division || showsOverallPointsTable(tournament) ? '<div><span>Overall</span><b>' + escapeHtml(standingLine(rankOf(ranking, params.teamId))) + '</b></div>' : ''}
          </div>
          <div class="w-follow-matches">${mine.map(function (m) { return watchFixtureHtml(m, tournament); }).join('') || '<p class="w-empty">No matches for this team yet.</p>'}</div>
        </section>
      `;
    }

    root.innerHTML = `
      ${watch.preview ? '<div class="w-sample">Sample board — this is not a live tournament.</div>' : ''}
      <div class="w-accent" style="--accent:${sport.color || '#3b82f6'}"></div>
      ${navPills}
      ${panel === 'rules' ? watchRulesPanelHtml(tournament, sport) : `
      ${categorySummary ? hero + watchUpcomingListHtml(summaryUpcoming, tournament, 'all categories', { showCategory: true }) + watchWinnersHtml(tournament, sport) + summaryCompletedHtml : `
      ${catTabs}
      ${panel === 'teams' ? watchCategoryTeamsHtml(tournament, sport, division) : `
      ${stagePills}
      ${focus}
      ${categorized ? '' : hero}
      <div class="w-layout">
        <div class="w-col">
          ${watchUpcomingListHtml(
            upcoming,
            tournament,
            stageName,
            division
              ? {
                heading: 'Schedule',
                empty: 'No scheduled matches in ' + stageName + ' yet.'
              }
              : null
          )}
          ${!categorized ? watchWinnersHtml(tournament, sport) : ''}
          ${teamCompletedHtml}
        </div>
        <div class="w-col">
          ${bracketBlocks}
          ${division ? `
          <section class="w-panel">
            <h3>Overall ranking <small>${escapeHtml(stageName)}</small></h3>
            <p class="w-hint">${populatedBrackets.length ? 'Across every group in ' + escapeHtml(stageName) + '.' : 'Every team in ' + escapeHtml(stageName) + '.'} Teams advanced from here are seeded in this order.</p>
            ${watchTableHtml(tournament, sport.id, rankingRows, 'No ' + stageName + ' matches completed yet.', { showPointBreakdown: true, showGroups: populatedBrackets.length > 0, division: division, stageId: stageId })}
          </section>
          ` : ''}
          ${showOverallTable ? `
          <section class="w-panel">
            <h3>${brackets.length ? 'Overall' : 'Standing'} <small>${escapeHtml(stageName)}</small></h3>
            ${watchTableHtml(tournament, sport.id, overall, 'No ' + stageName + ' matches completed yet.')}
          </section>
          ` : ''}
        </div>
      </div>
      ${categoryCompletedHtml}
      ${!categorized && allLive.length && !live.length ? '<p class="w-hint">A match is on now in another stage. Switch stages to see that score.</p>' : ''}
      `}
      `}
      `}
    `;

    function goSport(id) { setWatchParams({ sport: id, panel: panel, st: '', cat: '', team: '' }); }
    function goStage(id) { setWatchParams({ sport: sport.id, panel: 'summary', st: id, cat: division ? division.id : '', team: '' }); }
    function goCat(id) {
      const nextDiv = id ? findDivision(sport, id) : null;
      const nextStage = nextDiv ? activeStageId(sport, nextDiv) : '';
      const stayOnTeams = panel === 'teams' && !!nextDiv;
      setWatchParams({
        sport: sport.id,
        panel: stayOnTeams ? 'teams' : 'summary',
        st: stayOnTeams ? '' : nextStage,
        cat: id,
        team: ''
      });
    }
    function goTeam(id) {
      const found = findEntryTeam(tournament, sport.id, id);
      const categoryId = (found && found.division && found.division.id) || (division && division.id) || '';
      setWatchParams({ sport: sport.id, panel: 'summary', st: stageId, cat: categoryId, team: id });
    }
    const shell = document.body;
    shell.querySelectorAll('[data-act="sport"]').forEach(function (btn) {
      btn.addEventListener('click', function () { goSport(btn.getAttribute('data-sport')); });
    });
    shell.querySelectorAll('[data-act="stage"]').forEach(function (btn) {
      btn.addEventListener('click', function () { goStage(btn.getAttribute('data-stage')); });
    });
    shell.querySelectorAll('[data-act="cat"]').forEach(function (btn) {
      btn.addEventListener('click', function () { goCat(btn.getAttribute('data-cat')); });
    });
    shell.querySelectorAll('[data-act="watch-panel"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setWatchParams({
          sport: sport.id,
          panel: btn.getAttribute('data-panel'),
          st: '',
          cat: '',
          team: ''
        });
      });
    });
    shell.querySelectorAll('[data-act="cat-panel"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const nextPanel = btn.getAttribute('data-panel') || 'summary';
        setWatchParams({
          sport: sport.id,
          panel: nextPanel,
          st: nextPanel === 'teams' ? '' : stageId,
          cat: division ? division.id : '',
          team: ''
        });
      });
    });
    shell.querySelectorAll('[data-act="team"]').forEach(function (node) {
      node.addEventListener('click', function () {
        const id = node.getAttribute('data-team');
        if (id) goTeam(id);
      });
    });
    shell.querySelectorAll('[data-act="clear-team"]').forEach(function (btn) {
      btn.addEventListener('click', function () { goStage(stageId); });
    });
    bindWatchCompletedControls(root);
    bindWatchToolbar(shell);
    shell.querySelectorAll('[data-act="copy"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const url = location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            btn.textContent = 'Copied';
            setTimeout(function () { btn.textContent = 'Copy link'; }, 1600);
          }).catch(function () { prompt('Copy this link', url); });
        } else prompt('Copy this link', url);
      });
    });
  }

  function initPublicWatch() {
    const params = new URLSearchParams(location.search);
    if (params.get('preview') === '1') {
      watch.preview = true;
      watch.autoRefresh = false;
      watch.ready = true;
      watch.board = sampleWatchBoard();
      renderPublicWatch();
      return;
    }
    const token = params.get('s');
    const autoRefresh = params.get('live') === '1';
    watch.autoRefresh = autoRefresh;
    watch.reload = null;
    if (!token) {
      watch.ready = true;
      watch.expired = true;
      watch.closed = true;
      watch.board = null;
      renderPublicWatch();
      return;
    }
    function failWatch() {
      watch.ready = true;
      watch.parentBoard = null;
      watch.board = null;
      watch.liveMatches = [];
      watch.error = null;
      watch.closed = true;
      watch.expired = true;
      renderPublicWatch();
    }
    async function loadWatchOnce() {
      watch.ready = false;
      watch.renderKey = '';
      renderPublicWatch();
      try {
        const snap = await db.collection('tournament_public').doc(token).get();
        watch.ready = true;
        applyWatchParent(snap);
        if (publicWatchIsOpen(watch.parentBoard)) {
          const matchesSnap = await db.collection('tournament_public').doc(token).collection('matches').get();
          watch.liveMatches = liveMatchesFromSnapshot(matchesSnap);
        } else {
          watch.liveMatches = [];
        }
        publishWatchBoard();
      } catch (err) {
        console.error('[watch]', err);
        failWatch();
      }
    }
    watch.reload = loadWatchOnce;
    if (!autoRefresh) {
      loadWatchOnce();
      return;
    }
    watch.ready = false;
    renderPublicWatch();
    let unsubWatchMatches = null;
    function stopWatchMatches() {
      if (unsubWatchMatches) {
        unsubWatchMatches();
        unsubWatchMatches = null;
      }
      watch.liveMatches = [];
    }
    function startWatchMatches() {
      if (unsubWatchMatches) return;
      unsubWatchMatches = db.collection('tournament_public').doc(token).collection('matches').onSnapshot(function (snap) {
        watch.liveMatches = liveMatchesFromSnapshot(snap);
        if (watch.ready) publishWatchBoard();
      }, function (err) {
        console.warn('[watch] live matches unavailable:', err);
        watch.liveMatches = [];
        if (watch.ready) publishWatchBoard();
      });
    }
    db.collection('tournament_public').doc(token).onSnapshot(function (snap) {
      watch.ready = true;
      applyWatchParent(snap);
      if (publicWatchIsOpen(watch.parentBoard)) startWatchMatches();
      else stopWatchMatches();
      publishWatchBoard();
    }, function (err) {
      console.error('[watch]', err);
      stopWatchMatches();
      failWatch();
    });
  }

  function render() {
    if (isPublicWatchPage()) return renderPublicWatch();
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

    if ((parsed.view === 'tournament' || parsed.view === 'manage') && parsed.tournamentId && state.ready.tournaments) {
      const requested = state.tournaments.find(function (x) { return x.id === parsed.tournamentId; });
      if (requested && unpublishedAccessPending(requested)) {
        renderCheckingAccess();
        return;
      }
      if (requested && !canOpenTournament(requested)) {
        toast('This tournament is not published yet', 'error');
        navigate({ view: 'list' }, { replace: true });
        return;
      }
    }

    // Non-admin, non-captain users hitting an admin-only URL get bounced to
    // the tournament view (or the list if no tournament is selected).
    if (parsed.view === 'create' && !isAdminUi()) {
      navigate({ view: 'list' }, { replace: true });
      return;
    }
    if (parsed.view === 'manage' && !isAdminUi()) {
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
  }

  function init() {
    if (isPublicWatchPage()) {
      initPublicWatch();
      return;
    }
    state.adminUi = readAdminUiPref();
    render();
    auth.onAuthStateChanged(function (user) {
      state.user = user;
      sessionInitialized = true;
      if (user) {
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
        const nextScorer = !!(s.user && s.isScorer);
        const nextLab = !!(s.user && s.isLabUser);
        const nextLoading = !!s.loading;
        const nextProfile = s.profile || null;
        const changed = state.isAdmin !== nextAdmin
          || state.isScorer !== nextScorer
          || state.isLabUser !== nextLab
          || state.authLoading !== nextLoading
          || state.currentProfile !== nextProfile;
        state.isAdmin = nextAdmin;
        state.isScorer = nextScorer;
        state.isLabUser = nextLab;
        state.authLoading = nextLoading;
        state.currentProfile = nextProfile;
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
