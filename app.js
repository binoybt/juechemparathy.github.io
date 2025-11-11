/*********************
 * CONFIG & CONSTANTS
 *********************/
const TIME_BLOCKS = [
  { id: "6-8",   label: "6–8 AM" },
  { id: "1-5",   label: "1–5 PM" },
  { id: "6-9",   label: "6–9 PM" },
  { id: "8-10",  label: "8–10 PM" },
  { id: "8-10TT",  label: "8–10 PM (TT Room)" },
  { id: "9-11",  label: "9–11 PM" },
];
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/* sport meta for color + min/max defaults (used when seeding and for badges) */
const SPORT_META = {
  "Open Badminton":     { key:"badminton", min:4, max:20, mainLimit:10, waitingList:10 },
  "Women's Badminton":  { key:"badminton", min:4, max:20, mainLimit:10, waitingList:10 },
  "Pickleball":         { key:"pickleball", min:4, max:20, mainLimit:10, waitingList:10 },
  "Women's Pickleball": { key:"pickleball", min:4, max:20, mainLimit:10, waitingList:10 },
  "Volleyball":         { key:"volleyball", min:8, max:25, mainLimit:14, waitingList:11 },
  "Basketball":         { key:"basketball", min:6, max:20, mainLimit:10, waitingList:10 },
  "Table Tennis":       { key:"tabletennis", min:4, max:20, mainLimit:10, waitingList:10 },
  "Kids Games":         { key:"kids", min:4, max:20, mainLimit:10, waitingList:10 },
  "No Games":           { key:"", min:0, max:0, mainLimit:0, waitingList:0 },
};

/* cutoff per slot (local time). Adjust as needed. */
const DEFAULT_CUTOFF_HOUR = 12; // noon of the day

/* Admin emails who can run seed / overrides (edit this) */
const ADMIN_EMAILS = [
  "jue.george@gmail.com",
  "binoybt@gmail.com",
  "geojins@gmail.com"
  // "you@example.com"
];

let currentUser = null;
let showAllSignups = false; // Admin toggle state - default to show upcoming only

/*********************
 * UTILITY FUNCTIONS
 *********************/
function toCamelCase(name) {
  if (!name) return name;
  return name
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/*********************
 * FILTERS
 *********************/
const filters = {
  day: ""
};

function initializeFilters() {
  const filterDay = document.getElementById("filterDay");
  const clearFilters = document.getElementById("clearFilters");

  if (filterDay) {
    filterDay.addEventListener("change", (e) => {
      filters.day = e.target.value;
      renderTabContent();
    });
  }

  if (clearFilters) {
    clearFilters.addEventListener("click", () => {
      filters.day = "";
      if (filterDay) filterDay.value = "";
      renderTabContent();
    });
  }
}

function matchesFilters(slot, prio) {
  // Day filter
  if (filters.day !== "" && slot.dayIndex !== parseInt(filters.day)) {
    return false;
  }

  return true;
}

// Initialize filters when DOM is ready
document.addEventListener("DOMContentLoaded", initializeFilters);

/*********************
 * AUTH UI
 *********************/
const userBox = document.getElementById("userBox");
function renderUser() {
  if (currentUser) {
    const isAdmin = ADMIN_EMAILS.includes(currentUser.email);
    userBox.innerHTML = `
      <span style="margin-right:8px;">Hi, ${toCamelCase(currentUser.displayName)}</span>
      ${isAdmin ? `
        <button id="toggleViewBtn" class="toggle-btn ${showAllSignups ? 'active' : ''}" title="Toggle between viewing all sign-ups or only upcoming ones">
          ${showAllSignups ? '📅 Upcoming Only' : '📋 All Sign-ups'}
        </button>
        <button id="seedBtn" title="Only once, or when adding/removing time slots or changing schedule template ; Creates /slots collection with default structure">Seed</button>
        <button id="backupBtn" title="Every Sunday Night(manual); Clears signups, moves cutoffs, backs up last week's data">Backup & Reset</button>
      ` : ""}
      <button id="logoutBtn">Sign out</button>
    `;
    document.getElementById("logoutBtn").onclick = () => auth.signOut();
    
    const toggleViewBtn = document.getElementById("toggleViewBtn");
    if (toggleViewBtn) {
      toggleViewBtn.onclick = () => {
        showAllSignups = !showAllSignups;
        renderUser();
        renderTabContent();
      };
    }
    
    const seedBtn = document.getElementById("seedBtn");
    if (seedBtn) seedBtn.onclick = seedWeeklyIfEmpty;

    const backupBtn = document.getElementById("backupBtn");
    if (backupBtn) backupBtn.onclick = backupAndResetWeekly;
  } else {
    userBox.innerHTML = `<button id="loginBtn">Sign in with Google</button>`;
    document.getElementById("loginBtn").onclick = () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(e => alert("Login failed: " + e.message));
    };
  }
}


auth.onAuthStateChanged(u => {
  currentUser = u;
  renderUser();
  
  const legend = document.querySelector(".legend");
  const filtersSection = document.getElementById("filtersSection");
  
  if (currentUser) {
    // User logged in - show legend, filters and schedule
    if (legend) legend.style.display = "flex";
    if (filtersSection) filtersSection.style.display = "flex";
    subscribeSchedule();
  } else {
    // User not logged in - hide legend, filters and clear the schedule
    if (legend) legend.style.display = "none";
    if (filtersSection) filtersSection.style.display = "none";
    if (unsubscribe) unsubscribe();
    tabs.innerHTML = "";
    tabContent.innerHTML = `
      <div class="title-bar" style="text-align: center; padding: 40px;">
        <p style="font-size: 18px; margin-bottom: 20px;">Please sign in to view the game schedule</p>
        <p style="color: #666;">Click the "Sign in with Google" button above to get started</p>
      </div>
      <div class="title-bar">
      <p>SMASH MINISTRY</p>
      <p>St.Thomas Syro Malabar Catholic Church of San Francisco</p>
      </div>
    `;
  }
});

/*********************
 * ACTIVE PRIORITY LOGIC
 * P0 is active unless (now >= cutoff AND P0 players < min) → then P1 is active
 *********************/
function computeActivePriority(slot) {
  try {
    const cutoff = slot.cutoff?.toDate ? slot.cutoff.toDate() : (slot.cutoff ? new Date(slot.cutoff) : null);
    const now = new Date();
    const p0Min = slot.p0?.minPlayers ?? 0;
    const p0Players = (slot.p0?.players ?? []).length;

    if (!cutoff) return 0; // default to P0 when no cutoff set
    if (now < cutoff) return 0; // still before cutoff → P0 active
    // after cutoff: if P0 meets min, stays; else P1 takes over
    return (p0Players >= p0Min) ? 0 : 1;
  } catch {
    return 0;
  }
}

/*********************
 * RENDER TABBED VIEW
 *********************/
const MY_GAMES_TAB = "My Games";
const ALL_GAMES_TAB = "All Games";
const tabs = document.getElementById("sportTabs");
const tabContent = document.getElementById("tabContent");
let unsubscribe = null;
let selectedSport = null;
let latestSlots = [];

function subscribeSchedule() {
  if (unsubscribe) unsubscribe();

  unsubscribe = db.collection("slots")
    .orderBy("dayIndex")
    .onSnapshot(snap => {
      latestSlots = [];
      const sportSet = new Set();

      snap.forEach(doc => {
        const data = { id: doc.id, ...doc.data() };
        latestSlots.push(data);
        const p0Sport = data.p0?.sport;
        const p1Sport = data.p1?.sport;
        if (p0Sport && p0Sport !== "No Games") sportSet.add(p0Sport);
        if (p1Sport && p1Sport !== "No Games") sportSet.add(p1Sport);
      });

      const sports = [MY_GAMES_TAB, ALL_GAMES_TAB, ...Array.from(sportSet).sort()];
      if (!selectedSport || !sports.includes(selectedSport)) {
        selectedSport = sports[0] || MY_GAMES_TAB;
      }

      renderTabs(sports);
      renderTabContent();
    }, err => {
      console.error(err);
      tabContent.innerHTML = `<div class="empty">Failed to load schedule.</div>`;
    });
}

function renderTabs(sports) {
  tabs.innerHTML = "";

  if (!sports.length) {
    tabContent.innerHTML = `<div class="empty">No schedule configured.</div>`;
    return;
  }

  sports.forEach(sport => {
    const btn = document.createElement("button");
    btn.className = `tab ${sport === selectedSport ? "active" : ""}`;
    btn.textContent = sport;
    btn.onclick = () => {
      selectedSport = sport;
      renderTabs(sports);
      renderTabContent();
    };
    tabs.appendChild(btn);
  });
}

function renderTabContent() {
  tabContent.innerHTML = "";

  if (selectedSport === MY_GAMES_TAB) {
    renderMyGamesContent();
    return;
  }

  if (selectedSport === ALL_GAMES_TAB) {
    renderAllGamesContent();
    return;
  }

  if (!selectedSport) {
    tabContent.innerHTML = `<div class="empty">No games to show.</div>`;
    return;
  }

  renderSportContent();
}

function renderSportContent() {
  const todayIndex = new Date().getDay();

  DAYS.forEach((day, dayIndex) => {
    // Skip days that have already passed
    if (isDayInPast(dayIndex)) return;
    
    // Skip days that don't match the day filter
    if (filters.day !== "" && dayIndex !== parseInt(filters.day)) return;

    const daySection = document.createElement("section");
    daySection.className = `day-section${dayIndex === todayIndex ? " today" : ""}`;

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);

    const matching = latestSlots
      .filter(slot => slot.dayIndex === dayIndex)
      .filter(slot => !isTimeSlotInPast(slot.dayIndex, slot.blockId))
      .flatMap(slot => {
        const entries = [];
        if (slot.p0?.sport === selectedSport && matchesFilters(slot, 0)) {
          entries.push({ slot, prio: 0 });
        }
        if (slot.p1?.sport === selectedSport && matchesFilters(slot, 1)) {
          entries.push({ slot, prio: 1 });
        }
        return entries;
      })
      .sort((a, b) => {
        const orderA = TIME_BLOCKS.findIndex(t => t.id === a.slot.blockId);
        const orderB = TIME_BLOCKS.findIndex(t => t.id === b.slot.blockId);
        return orderA - orderB || a.prio - b.prio;
      });

    const track = document.createElement("div");
    track.className = "slot-track";

    if (matching.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = `No ${selectedSport} games.`;
      track.appendChild(empty);
    } else {
      matching.forEach(entry => track.appendChild(renderSlotCard(entry.slot, entry.prio)));
    }

    daySection.appendChild(track);
    tabContent.appendChild(daySection);
  });
}

function renderMyGamesContent() {
  if (!currentUser) {
    tabContent.innerHTML = `<div class="empty">Please sign in to view your games.</div>`;
    return;
  }

  const todayIndex = new Date().getDay();
  let renderedDays = 0;

  DAYS.forEach((day, dayIndex) => {
    // Skip days that have already passed
    if (isDayInPast(dayIndex)) return;
    
    // Skip days that don't match the day filter
    if (filters.day !== "" && dayIndex !== parseInt(filters.day)) return;

    const entries = latestSlots
      .filter(slot => slot.dayIndex === dayIndex)
      .filter(slot => !isTimeSlotInPast(slot.dayIndex, slot.blockId))
      .flatMap(slot => {
        const result = [];
        ["p0", "p1"].forEach(key => {
          const prio = key === "p0" ? 0 : 1;
          const payload = slot[key];
          // Only include if user has joined this priority slot
          if (payload?.sport && payload.sport !== "No Games") {
            const hasJoined = (payload.players || []).some(pl => pl.uid === currentUser.uid);
            if (hasJoined && matchesFilters(slot, prio)) {
              result.push({ slot, prio });
            }
          }
        });
        return result;
      })
      .sort((a, b) => {
        const orderA = TIME_BLOCKS.findIndex(t => t.id === a.slot.blockId);
        const orderB = TIME_BLOCKS.findIndex(t => t.id === b.slot.blockId);
        return orderA - orderB || a.prio - b.prio;
      });

    if (!entries.length) return;

    renderedDays += 1;
    const daySection = document.createElement("section");
    daySection.className = `day-section${dayIndex === todayIndex ? " today" : ""}`;

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);

    const track = document.createElement("div");
    track.className = "slot-track";
    entries.forEach(entry => track.appendChild(renderSlotCard(entry.slot, entry.prio)));

    daySection.appendChild(track);
    tabContent.appendChild(daySection);
  });

  if (!renderedDays) {
    tabContent.innerHTML = `<div class="empty">You haven't joined any games yet.</div>`;
  }
}

function renderAllGamesContent() {
  const todayIndex = new Date().getDay();
  let renderedDays = 0;

  DAYS.forEach((day, dayIndex) => {
    // Skip days that have already passed
    if (isDayInPast(dayIndex)) return;
    
    // Skip days that don't match the day filter
    if (filters.day !== "" && dayIndex !== parseInt(filters.day)) return;

    const entries = latestSlots
      .filter(slot => slot.dayIndex === dayIndex)
      .filter(slot => !isTimeSlotInPast(slot.dayIndex, slot.blockId))
      .flatMap(slot => {
        const result = [];
        ["p0", "p1"].forEach(key => {
          const prio = key === "p0" ? 0 : 1;
          const payload = slot[key];
          if (payload?.sport && payload.sport !== "No Games" && matchesFilters(slot, prio)) {
            result.push({ slot, prio });
          }
        });
        return result;
      })
      .sort((a, b) => {
        const orderA = TIME_BLOCKS.findIndex(t => t.id === a.slot.blockId);
        const orderB = TIME_BLOCKS.findIndex(t => t.id === b.slot.blockId);
        return orderA - orderB || a.prio - b.prio;
      });

    if (!entries.length) return;

    renderedDays += 1;
    const daySection = document.createElement("section");
    daySection.className = `day-section${dayIndex === todayIndex ? " today" : ""}`;

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);

    const track = document.createElement("div");
    track.className = "slot-track";
    entries.forEach(entry => track.appendChild(renderSlotCard(entry.slot, entry.prio)));

    daySection.appendChild(track);
    tabContent.appendChild(daySection);
  });

  if (!renderedDays) {
    tabContent.innerHTML = `<div class="empty">No games scheduled.</div>`;
  }
}

function renderSlotCard(slot, prio) {
  const p = slot[`p${prio}`] || { sport: "No Games", minPlayers: 0, maxPlayers: 0, players: [] };
  const meta = SPORT_META[p.sport] || { min: 0, max: 20, mainLimit: 10, waitingList: 10 };
  const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
  const active = computeActivePriority(slot) === prio;

  const mainLimit = meta.mainLimit || 10;
  const totalPlayers = (p.players || []).length;
  const mainPlayers = Math.min(totalPlayers, mainLimit);
  const waitingPlayers = Math.max(0, totalPlayers - mainLimit);

  const card = document.createElement("div");
  card.className = `slot-card${active ? " active" : ""}`;

  const top = document.createElement("div");
  top.className = "slot-time";
  top.innerHTML = `
    <span>${block?.label ?? slot.blockId}</span>
    <span class="priority-pill ${prio === 0 ? "p0" : "p1"}">${prio === 0 ? "P0" : "P1"}</span>
  `;
  card.appendChild(top);

  const sportTag = document.createElement("div");
  sportTag.className = "sport-tag";
  sportTag.textContent = p.sport;
  card.appendChild(sportTag);

  const metrics = document.createElement("div");
  metrics.className = "metrics";
  
  if (waitingPlayers > 0) {
    metrics.innerHTML = `
      <span>${totalPlayers} joined</span>
      <span class="waiting-count">🟠 Waiting List: ${waitingPlayers}</span>
    `;
  } else {
    metrics.innerHTML = `
      <span>${totalPlayers} joined</span>
    `;
  }
  card.appendChild(metrics);

  const playersList = document.createElement("div");
  playersList.className = "players";
  if ((p.players || []).length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No players yet";
    playersList.appendChild(empty);
  } else {
    (p.players || []).forEach((pl, index) => {
      const chip = document.createElement("span");
      // Add waiting-list class if player is beyond mainLimit
      if (index >= mainLimit) {
        chip.className = "player waiting-list";
      } else {
        chip.className = "player";
      }
      chip.textContent = toCamelCase(pl.name);
      playersList.appendChild(chip);
    });
  }
  card.appendChild(playersList);

  const btnbar = document.createElement("div");
  btnbar.className = "btnbar";

  // Always use the current metadata max value, ignore stored maxPlayers
  const maxPlayers = meta.max ? meta.max : 20;
  const canJoin = currentUser && p.sport !== "No Games" && (p.players || []).length < maxPlayers;
  const isIn = !!currentUser && (p.players || []).some(pl => pl.uid === currentUser.uid);

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.textContent = isIn ? "Joined" : "Join";
  joinBtn.disabled = !currentUser || isIn || !canJoin;
  joinBtn.onclick = () => updateSignup(slot.id, prio, "join");

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn";
  leaveBtn.textContent = "Leave";
  leaveBtn.disabled = !currentUser || !isIn;
  leaveBtn.onclick = () => updateSignup(slot.id, prio, "leave");

  btnbar.appendChild(joinBtn);
  btnbar.appendChild(leaveBtn);
  card.appendChild(btnbar);

  return card;
}

function getDateLabel(dayIndex) {
  const today = new Date();
  const diff = dayIndex - today.getDay();
  const date = new Date(today);
  date.setDate(today.getDate() + diff);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isDayInPast(dayIndex) {
  // Admins can see all days when toggle is on
  if (currentUser && ADMIN_EMAILS.includes(currentUser.email) && showAllSignups) {
    return false;
  }
  
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Start of today
  const diff = dayIndex - today.getDay();
  const date = new Date(today);
  date.setDate(today.getDate() + diff);
  return date < today;
}

function getBlockEndTime(blockId) {
  // Parse the block ID to get the end time
  // Format examples: "6-8" (6-8 AM), "1-5" (1-5 PM), "8-10" (8-10 PM), "8-10TT" (8-10 PM TT Room), "9-11" (9-11 PM)
  const blockIdClean = blockId.replace("TT", ""); // Remove TT suffix
  const parts = blockIdClean.split("-");
  if (parts.length !== 2) return null;
  
  const endHour = parseInt(parts[1]);
  if (isNaN(endHour)) return null;
  
  // Determine if it's AM or PM based on the hour
  // Hours 1-5 are PM (13-17), 6-11 are based on context
  // 6-8 is AM, 1-5 is PM, 6-9 and up are PM, 8-10 and up are PM, 9-11 is PM
  const startHour = parseInt(parts[0]);
  let hour24 = endHour;
  
  if (endHour <= 5) {
    // 1-5 PM range
    hour24 = endHour + 12;
  } else if (endHour >= 6 && endHour <= 8 && startHour === 6) {
    // 6-8 AM
    hour24 = endHour;
  } else if (endHour >= 6) {
    // 6-9 PM, 8-10 PM, 9-11 PM
    hour24 = endHour + 12;
  }
  
  return hour24;
}

function isTimeSlotInPast(dayIndex, blockId) {
  // Admins can see all time slots when toggle is on
  if (currentUser && ADMIN_EMAILS.includes(currentUser.email) && showAllSignups) {
    return false;
  }
  
  const now = new Date();
  const todayIndex = now.getDay();
  
  // If the day is in the past, the slot is in the past
  if (isDayInPast(dayIndex)) return true;
  
  // If the day is in the future, the slot is not in the past
  if (dayIndex !== todayIndex) return false;
  
  // Same day - check the time
  const endHour = getBlockEndTime(blockId);
  if (endHour === null) return false;
  
  const currentHour = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeIn24 = currentHour + (currentMinutes / 60);
  
  return currentTimeIn24 >= endHour;
}

/*********************
 * JOIN / LEAVE (transaction)
 *********************/
async function updateSignup(slotId, prio, action) {
  if (!currentUser) return alert("Please sign in first.");
  const ref = db.collection("slots").doc(slotId);

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const data = snap.data();
    const key = `p${prio}`;
    const p = data[key] || { players: [], minPlayers: 0, maxPlayers: 0, sport: "No Games" };

    const me = { uid: currentUser.uid, name: currentUser.displayName || "Player" };
    const exists = (p.players || []).some(x => x.uid === me.uid);

    if (action === "join") {
      if (exists) return;
      // Always use the current metadata max value, ignore stored maxPlayers
      const sportMeta = SPORT_META[p.sport] || { max: 20 };
      const max = sportMeta.max;
      if ((p.players || []).length >= max) throw new Error("Full");
      p.players = [...(p.players || []), me];
    } else {
      p.players = (p.players || []).filter(x => x.uid !== me.uid);
    }

    // persist update
    tx.update(ref, { [key]: p });

    // recompute and persist activePriority for visibility
    const active = computeActivePriority({ ...data, [key]: p });
    tx.update(ref, { activePriority: active });
  }).catch(e => alert(e.message));
}

/*********************
 * OPTIONAL: seed if empty (admin only)
 *********************/
async function seedWeeklyIfEmpty() {
  if (!currentUser || !ADMIN_EMAILS.includes(currentUser.email)) return alert("Admins only");
  const col = await db.collection("slots").limit(1).get();
  if (!col.empty) return alert("Slots already exist");

  await seedWeeklyData();
  alert("Seeded weekly schedule.");
}

/* Seed helper (uses same data from your prompt) */
async function seedWeeklyData() {
  const schedule = {
        "Sunday": {
          "1-5":  { p0: "Volleyball", p1: "Pickleball" },
          "6-9":  { p0: "Pickleball", p1: "Open Badminton" },
          "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
        },
      "Monday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Open Badminton", p1: "Pickleball" },
        "8-10": { p0: "Pickleball", p1: "Open Badminton" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }

      },
      "Tuesday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Open Badminton", p1: "Pickleball" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
      },
      "Wednesday": {
        "6-8":  { p0: "Open Badminton", p1: "Pickleball" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Women’s Badminton", p1: "Open Badminton" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
      },
      "Thursday": {
        "6-8":  { p0: "Open Badminton", p1: "Pickleball" },
        "1-5":  { p0: "Open Badminton", p1: "Pickleball" },
        "8-10": { p0: "Pickleball", p1: "Open Badminton" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
      },
      "Friday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Volleyball", p1: "Kids Games" },
        "9-11": { p0: "Volleyball", p1: "Kids Games" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
      },
      "Saturday": {
        "6-8":  { p0: "Volleyball", p1: "Pickleball" },
        "1-5":  { p0: "Kids Games", p1: "Pickleball" },
        "6-9":  { p0: "Basketball", p1: "Open Badminton" },
        "8-10TT": { p0: "Table Tennis", p1: "Kids Games" }
      }
    };

  const batch = db.batch();
  Object.entries(schedule).forEach(([day, blocks]) => {
    const dayIndex = DAYS.indexOf(day);

      const cutoff = new Date();
      const today = new Date();
      const todayIndex = new Date().getDay(); // make Sunday=0
const diff = dayIndex - todayIndex ;
const date = new Date();
date.setDate(today.getDate() + diff);
//const dayDate = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
const dayDate = `${date.toString()}`;

    Object.entries(blocks).forEach(([blockId, def]) => {
      const p0meta = SPORT_META[def.p0] || {};
      const p1meta = SPORT_META[def.p1] || {};
      const docRef = db.collection("slots").doc(`${dayIndex}_${blockId}`);

      // cutoff = next occurrence of this day at DEFAULT_CUTOFF_HOUR local

      const delta = dayIndex - todayIndex;
      cutoff.setDate(cutoff.getDate() + delta);
      cutoff.setHours(DEFAULT_CUTOFF_HOUR, 0, 0, 0);

      batch.set(docRef, {
        dayDate,
        day,
        dayIndex,
        blockId,
        cutoff,
        activePriority: 0,
        p0: { sport: def.p0, minPlayers: p0meta.min ?? 0, maxPlayers: p0meta.max ?? 0, players: [] },
        p1: { sport: def.p1, minPlayers: p1meta.min ?? 0, maxPlayers: p1meta.max ?? 0, players: [] },
      });
    });
  });
  await batch.commit();
}

async function backupAndResetWeekly() {
  if (!currentUser || !ADMIN_EMAILS.includes(currentUser.email)) {
    alert("Admins only.");
    return;
  }

  if (!confirm("⚠️ This will back up all current signups and reset for the next week.\nContinue?")) {
    return;
  }

  const backupId = new Date().toISOString().split("T")[0];
  const slotsRef = db.collection("slots");
  const backupRef = db.collection("slots_backup").doc(backupId);

  try {
    const snapshot = await slotsRef.get();
    const slots = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // 1️⃣ Backup current week
    await backupRef.set({
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      slots: slots,
    });

    // 2️⃣ Prepare batch update
    const batch = db.batch();
    snapshot.forEach((doc) => {
      const data = doc.data();
      const cutoff = data.cutoff?.toDate ? data.cutoff.toDate() : new Date(data.cutoff);
      cutoff.setDate(cutoff.getDate() + 7); // next week

      const ref = slotsRef.doc(doc.id);
      batch.update(ref, {
        "p0.players": [],
        "p1.players": [],
        activePriority: 0,
        cutoff: cutoff,
      });
    });

    await batch.commit();
    alert(`✅ Backup saved as "${backupId}" and signups reset for next week!`);

    console.log("Backup & reset complete:", backupId);
  } catch (error) {
    console.error("Backup & Reset failed:", error);
    alert("❌ Backup & Reset failed: " + error.message);
  }
}
