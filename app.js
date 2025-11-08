/*********************
 * CONFIG & CONSTANTS
 *********************/
const TIME_BLOCKS = [
  { id: "6-8",   label: "6–8 AM" },
  { id: "1-5",   label: "1–5 PM" },
  { id: "6-9",   label: "6–9 PM" },
  { id: "8-10",  label: "8–10 PM" },
  { id: "9-11",  label: "9–11 PM" },
];
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

/* sport meta for color + min/max defaults (used when seeding and for badges) */
const SPORT_META = {
  "Open Badminton":     { key:"badminton", min:4, max:12 },
  "Women’s Badminton":  { key:"badminton", min:4, max:12 },
  "Pickleball":         { key:"pickleball", min:4, max:12 },
  "Women’s Pickleball": { key:"pickleball", min:4, max:12 },
  "Volleyball":         { key:"volleyball", min:8, max:14 },
  "Basketball":         { key:"basketball", min:6, max:12 },
  "Table Tennis":       { key:"tabletennis", min:4, max:8 },
  "Kids Games":         { key:"kids", min:4, max:12 },
  "No Games":           { key:"", min:0, max:0 },
};

/* cutoff per slot (local time). Adjust as needed. */
const DEFAULT_CUTOFF_HOUR = 12; // noon of the day

/* Admin emails who can run seed / overrides (edit this) */
const ADMIN_EMAILS = [
"jue.george@gmail.com"
  // "you@example.com"
];

let currentUser = null;

/*********************
 * AUTH UI
 *********************/
const userBox = document.getElementById("userBox");
function renderUser() {
  if (currentUser) {
    userBox.innerHTML = `
      <span style="margin-right:8px;">Hi, ${currentUser.displayName}</span>
      ${ADMIN_EMAILS.includes(currentUser.email) ? `<button id="seedBtn" title="Seed weekly schedule">Seed</button>` : ""}
      <button id="logoutBtn">Sign out</button>
    `;
    document.getElementById("logoutBtn").onclick = () => auth.signOut();
    const seedBtn = document.getElementById("seedBtn");
    if (seedBtn) seedBtn.onclick = seedWeeklyIfEmpty;
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
  subscribeSchedule();
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
 * RENDER WEEK GRID
 *********************/
const grid = document.getElementById("weekGrid");
let unsubscribe = null;

function subscribeSchedule() {
  if (unsubscribe) unsubscribe();

  // live query of all slots for the week
  unsubscribe = db.collection("slots")
    .orderBy("dayIndex")
    .orderBy("blockId")
    .onSnapshot(snap => {
      const byDay = new Map();
      DAYS.forEach((d,i)=>byDay.set(i,[]));
      snap.forEach(doc => {
        const data = doc.data();
        byDay.get(data.dayIndex)?.push({ id: doc.id, ...data });
      });
      renderGrid(byDay);
    }, err => {
      console.error(err);
      grid.innerHTML = `<div class="empty">Failed to load schedule.</div>`;
    });
}

function renderGrid(byDay) {
  grid.innerHTML = "";
  DAYS.forEach((day, dayIndex) => {
    const daySlots = (byDay.get(dayIndex) || []).sort((a,b) =>
      TIME_BLOCKS.findIndex(t=>t.id===a.blockId) - TIME_BLOCKS.findIndex(t=>t.id===b.blockId)
    );

    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "header";
    header.innerHTML = `<div class="day">${day}</div>`;
    card.appendChild(header);

    if (daySlots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No slots configured";
      card.appendChild(empty);
    } else {
      daySlots.forEach(slot => card.appendChild(renderSlot(slot)));
    }

    grid.appendChild(card);
  });
}

function renderSlot(slot) {
  const wrap = document.createElement("div");
  const active = computeActivePriority(slot);

  const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
  const top = document.createElement("div");
  top.className = "row";
  top.innerHTML = `
    <div class="slot">${block?.label ?? slot.blockId}
      ${active === 0 ? ' <span class="pill active">Active</span>' : ''}
      ${active === 1 ? ' <span class="pill active">Active</span>' : ''}
    </div>
  `;
  wrap.appendChild(top);

  // P0 row
  wrap.appendChild(renderPriorityRow(slot, 0, active === 0));
  // divider
  const hr = document.createElement("div"); hr.className = "hr"; wrap.appendChild(hr);
  // P1 row
  wrap.appendChild(renderPriorityRow(slot, 1, active === 1));

  return wrap;
}

function renderPriorityRow(slot, prio, isActive) {
  const row = document.createElement("div");
  row.className = "row";

  const p = slot[`p${prio}`] || { sport: "No Games", minPlayers: 0, maxPlayers: 0, players: [] };
  const meta = SPORT_META[p.sport] || { key: "", min: 0, max: 0 };

  const sportSpan = document.createElement("span");
  sportSpan.className = `sport ${meta.key}`;
  sportSpan.textContent = p.sport;

  const tag = document.createElement("span");
  tag.className = `badge`;
  tag.innerHTML = `<span class="pill ${prio===0?'p0':'p1'}">${prio===0?'P0':'P1'}</span>
    Min ${p.minPlayers ?? meta.min} • Max ${p.maxPlayers ?? meta.max}`;

  row.appendChild(sportSpan);
  row.appendChild(tag);
  if (isActive) {
    const a = document.createElement("span");
    a.className = "badge";
    a.style.background = "#e0f2fe";
    a.style.color = "#0369a1";
    a.textContent = "Currently Active";
    row.appendChild(a);
  }

  // players
  const playersList = document.createElement("div");
  playersList.className = "players";
  (p.players || []).forEach(pl => {
    const chip = document.createElement("span");
    chip.className = "player";
    chip.textContent = pl.name;
    playersList.appendChild(chip);
  });
  row.appendChild(playersList);

  // buttons (only if signed in and sport != No Games)
  const btnbar = document.createElement("div");
  btnbar.className = "btnbar";

  const canJoin = currentUser && p.sport !== "No Games" && (p.players || []).length < (p.maxPlayers ?? meta.max);
  const isIn = !!currentUser && (p.players || []).some(pl => pl.uid === currentUser.uid);

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.textContent = isIn ? "Joined" : `Join ${prio===0?'P0':'P1'}`;
  joinBtn.disabled = !currentUser || isIn || !canJoin;
  joinBtn.onclick = () => updateSignup(slot.id, prio, "join");

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn";
  leaveBtn.textContent = "Leave";
  leaveBtn.disabled = !currentUser || !isIn;
  leaveBtn.onclick = () => updateSignup(slot.id, prio, "leave");

  btnbar.appendChild(joinBtn);
  btnbar.appendChild(leaveBtn);

  row.appendChild(btnbar);

  return row;
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
      const max = p.maxPlayers ?? (SPORT_META[p.sport]?.max ?? 0);
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
      "Monday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Open Badminton", p1: "Pickleball" },
        "8-10": { p0: "Pickleball", p1: "Open Badminton" }
      },
      "Tuesday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Open Badminton", p1: "Pickleball" }
      },
      "Wednesday": {
        "6-8":  { p0: "Open Badminton", p1: "Pickleball" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Women’s Badminton", p1: "Open Badminton" }
      },
      "Thursday": {
        "6-8":  { p0: "Open Badminton", p1: "Pickleball" },
        "1-5":  { p0: "Open Badminton", p1: "Pickleball" },
        "8-10": { p0: "Pickleball", p1: "Open Badminton" }
      },
      "Friday": {
        "6-8":  { p0: "Pickleball", p1: "Open Badminton" },
        "1-5":  { p0: "Pickleball", p1: "Open Badminton" },
        "8-10": { p0: "Volleyball", p1: "Kids Games" },
        "9-11": { p0: "Volleyball", p1: "Kids Games" }
      },
      "Saturday": {
        "6-8":  { p0: "Volleyball", p1: "Pickleball" },
        "1-5":  { p0: "Kids Games", p1: "Pickleball" },
        "6-9":  { p0: "Basketball", p1: "Open Badminton" }
      },
      "Sunday": {
        "1-5":  { p0: "Volleyball", p1: "Pickleball" },
        "6-9":  { p0: "Pickleball", p1: "Open Badminton" }
      }
    };

  const batch = db.batch();
  Object.entries(schedule).forEach(([day, blocks]) => {
    const dayIndex = DAYS.indexOf(day);
    Object.entries(blocks).forEach(([blockId, def]) => {
      const p0meta = SPORT_META[def.p0] || {};
      const p1meta = SPORT_META[def.p1] || {};
      const docRef = db.collection("slots").doc(`${dayIndex}_${blockId}`);

      // cutoff = next occurrence of this day at DEFAULT_CUTOFF_HOUR local
      const cutoff = new Date();
      const todayIndex = (new Date().getDay() + 6) % 7; // make Monday=0
      const delta = (dayIndex - todayIndex + 7) % 7;
      cutoff.setDate(cutoff.getDate() + delta);
      cutoff.setHours(DEFAULT_CUTOFF_HOUR, 0, 0, 0);

      batch.set(docRef, {
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
