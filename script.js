const container = document.getElementById("slots");
const userInfo = document.getElementById("userInfo");
let currentUser = null;

// === AUTH SECTION ===
function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider)
    .then(result => {
      currentUser = result.user;
      updateUserUI();
      fetchSlots();
    })
    .catch(err => alert("Login failed: " + err.message));
}

function signOutUser() {
  auth.signOut().then(() => {
    currentUser = null;
    updateUserUI();
    container.innerHTML = "<p>Please sign in to view games.</p>";
  });
}

function updateUserUI() {
  if (currentUser) {
    userInfo.innerHTML = `
      <span style="font-size:13px;color:#333;">Hi, ${currentUser.displayName}</span>
      <button class="leave" style="margin-left:8px;" onclick="signOutUser()">Sign Out</button>
    `;
  } else {
    userInfo.innerHTML = `
      <button class="join" onclick="signInWithGoogle()">Sign In with Google</button>
    `;
  }
}

// === GAME FETCHING ===
function fetchSlots() {
  if (!currentUser) {
    container.innerHTML = "<p>Please sign in to view games.</p>";
    return;
  }

  container.innerHTML = "<p>Loading games...</p>";

  db.collection("games")
    .orderBy("date")
    .onSnapshot(snapshot => {
      if (snapshot.empty) {
        container.innerHTML = "<p>No games available.</p>";
        return;
      }

      container.innerHTML = "";
      snapshot.forEach(doc => {
        const slot = doc.data();
        renderSlotCard(doc.id, slot);
      });
    });
}

// === RENDER SLOT ===
function renderSlotCard(id, slot) {
  const card = document.createElement("div");
  card.className = "slot-card";

  const players = slot.players || [];
  const maxPlayers = slot.maxPlayers || 8;
  const isJoined = currentUser && players.includes(currentUser.displayName);

  card.innerHTML = `
    <div class="slot-header">
      <div>
        <div class="slot-title">${slot.sport}</div>
        <div class="slot-meta">${slot.date} • ${slot.time}</div>
        <div class="slot-meta" style="font-size:12px;color:#888;">${slot.court}</div>
      </div>
      <div class="slot-meta">${players.length}/${maxPlayers}</div>
    </div>
    <div class="player-list">
      ${players.map(p => `<span>${p}</span>`).join("")}
    </div>
    <div class="button-row">
      ${isJoined
        ? `<button class="leave" onclick="leaveGame('${id}')">Leave</button>`
        : `<button class="join" onclick="joinGame('${id}')">Join</button>`}
    </div>
  `;
  container.appendChild(card);
}

// === JOIN & LEAVE LOGIC ===
function joinGame(id) {
  if (!currentUser) return alert("Please sign in first.");
  const name = currentUser.displayName;

  const slotRef = db.collection("games").doc(id);
  slotRef.get().then(doc => {
    if (!doc.exists) return;
    const data = doc.data();
    const players = data.players || [];
    if (players.includes(name)) return alert("You're already in!");
    if (players.length >= data.maxPlayers) return alert("Slot full!");

    players.push(name);
    slotRef.update({ players }).then(() => console.log("Joined"));
  });
}

function leaveGame(id) {
  if (!currentUser) return alert("Please sign in first.");
  const name = currentUser.displayName;

  const slotRef = db.collection("games").doc(id);
  slotRef.get().then(doc => {
    if (!doc.exists) return;
    const data = doc.data();
    const players = (data.players || []).filter(p => p !== name);
    slotRef.update({ players }).then(() => console.log("Left"));
  });
}

// === INIT ===
auth.onAuthStateChanged(user => {
  currentUser = user;
  updateUserUI();
  if (user) fetchSlots();
  else container.innerHTML = "<p>Please sign in to view games.</p>";
});
