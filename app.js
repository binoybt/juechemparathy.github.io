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
  "Open Badminton":    { key:"badminton", min:4, max:20, mainLimit:10, waitingList:10 },
  "Women Badminton":   { key:"badminton", min:4, max:20, mainLimit:10, waitingList:10 },
  "Pickleball":        { key:"pickleball", min:4, max:20, mainLimit:10, waitingList:10 },
  "Volleyball":        { key:"volleyball", min:8, max:25, mainLimit:14, waitingList:11 },
  "Basketball":        { key:"basketball", min:6, max:20, mainLimit:10, waitingList:10 },
  "Table Tennis":      { key:"tabletennis", min:4, max:20, mainLimit:10, waitingList:10 },
  "Kids Games":        { key:"kids", min:4, max:20, mainLimit:10, waitingList:10 },
  "No Games":          { key:"", min:0, max:0, mainLimit:0, waitingList:0 },
};

/* cutoff per slot (local time). Adjust as needed. */
const DEFAULT_CUTOFF_HOUR = 12; // noon of the day

/* Admin access is granted via users/{uid}.role === 'admin' — managed on the
 * admin-users.html page. This file no longer contains any admin email list.
 * `currentUserIsAdmin` is kept in sync by the SmashAuth.onChange handler
 * further down. */
let currentUserIsAdmin = false;
function isCurrentUserAdmin() { return !!currentUserIsAdmin; }

let currentUser = null;
let showAllSignups = false; // Admin toggle state - default to show upcoming only
let userPreferences = null; // User's sport preferences
let deepLinkHandled = false; // Track if deep link has been handled
let initialTabSet = false; // Track if initial tab has been determined
let blockedDays = {}; // Store blocked days: { dayIndex: { note: "reason", blockedAt: timestamp } }
let blockedSlots = {}; // Store blocked slots: { slotId_prio: { note: "reason", blockedAt: timestamp } }

// Global function to clear all caches (can be called from console)
window.clearAllCaches = async function() {
  try {
    // Clear localStorage
    localStorage.clear();
    console.log("✅ localStorage cleared");
    
    // Clear service worker caches
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      console.log("✅ Service Worker caches cleared");
    }
    
    // Unregister service workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
      console.log("✅ Service Workers unregistered");
    }
    
    console.log("✅ All caches cleared! Reloading...");
    setTimeout(() => location.reload(true), 500);
  } catch (error) {
    console.error("Error clearing caches:", error);
  }
};

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

// Normalize apostrophes and quotes to handle different character encodings
function normalizeSportName(name) {
  if (!name) return name;
  // Replace all types of apostrophes with standard single quote
  return name
    .replace(/[\u2018\u2019]/g, "'")  // Smart quotes ' '
    .replace(/[\u201C\u201D]/g, '"')  // Smart double quotes " "
    .trim();
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
const patronsBox = document.getElementById("patronsBox");

function renderUser() {
  if (currentUser) {
    const isAdmin = isCurrentUserAdmin();
    
    // Show Patrons button to all logged-in users
    patronsBox.innerHTML = `
      <a href="patrons.html" class="patrons-link" title="Thank you to our Patrons">
        <span class="heart-icon">❤️</span>
        <span class="patrons-text">Our Patrons</span>
      </a>
    `;
    
    userBox.innerHTML = `
      <div class="user-menu">
        <button id="userMenuBtn" class="user-menu-btn">
          <span>${toCamelCase(currentUser.displayName)}</span>
          <span class="dropdown-arrow">▼</span>
        </button>
        <div id="userDropdown" class="user-dropdown">
          <button class="dropdown-item" onclick="openPreferencesModal()">
            <span>⚙️</span> Sport Preferences
          </button>
          ${isAdmin ? `
            <div class="dropdown-divider"></div>
            <a class="dropdown-item admin-item" href="admin-users.html" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit;">
              <span>👥</span> Members &amp; Admins
            </a>
            <a class="dropdown-item admin-item" href="ledger.html" style="display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit;">
              <span>💰</span> Financial Ledger
            </a>
            <button class="dropdown-item" onclick="toggleViewMode()">
              <span>${showAllSignups ? '📅' : '📋'}</span> ${showAllSignups ? 'Upcoming Only' : 'All Sign-ups'}
            </button>
            <button class="dropdown-item admin-item" onclick="openBlockDaysModal()">
              <span>🚫</span> Block Days
            </button>
            <button class="dropdown-item admin-item" onclick="openReservePracticeModal()">
              <span>🟢</span> Reserve Practice
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item admin-item" onclick="seedWeeklyIfEmpty()">
              <span>🌱</span> Seed Schedule
            </button>
            <button class="dropdown-item admin-item" onclick="backupAndResetWeekly()">
              <span>💾</span> Backup & Reset
            </button>
            <div class="dropdown-divider"></div>
          ` : ""}
          <button class="dropdown-item logout-item" onclick="auth.signOut()">
            <span>🚪</span> Sign Out
          </button>
        </div>
      </div>
    `;
    
    // Toggle dropdown on click
    document.getElementById("userMenuBtn").onclick = (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById("userDropdown");
      dropdown.classList.toggle("show");
    };
    
    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const dropdown = document.getElementById("userDropdown");
      if (dropdown && !e.target.closest(".user-menu")) {
        dropdown.classList.remove("show");
      }
    });
  } else {
    // Hide patrons button when not logged in
    patronsBox.innerHTML = "";
    
    userBox.innerHTML = `<button id="loginBtn">Sign in with Google</button>`;
    document.getElementById("loginBtn").onclick = () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(e => alert("Login failed: " + e.message));
    };
  }
}

function toggleViewMode() {
  showAllSignups = !showAllSignups;
  document.getElementById("userDropdown").classList.remove("show");
  renderUser();
  
  // Rebuild tabs to show all sports when in "All Sign-ups" mode
  const sportSet = new Set();
  latestSlots.forEach(slot => {
    const p0Sport = slot.p0?.sport;
    const p1Sport = slot.p1?.sport;
    
    // Only add sports that pass the preference filter (which includes admin override)
    if (p0Sport && p0Sport !== "No Games" && shouldShowSport(p0Sport)) {
      sportSet.add(p0Sport);
    }
    if (p1Sport && p1Sport !== "No Games" && shouldShowSport(p1Sport)) {
      sportSet.add(p1Sport);
    }
  });
  
  const sports = ["My Games", "All Games", ...Array.from(sportSet).sort()];
  renderTabs(sports);
  renderTabContent();
}


// Keep admin state up-to-date whenever role changes in Firestore.
if (window.SmashAuth) {
  SmashAuth.onChange(s => {
    const was = currentUserIsAdmin;
    currentUserIsAdmin = !!(s.user && s.isAdmin);
    if (was !== currentUserIsAdmin && currentUser) renderUser();
  });
}

auth.onAuthStateChanged(u => {
  currentUser = u;
  renderUser();
  
  // Reset initial tab flag on auth change to allow smart selection
  initialTabSet = false;
  
  const legend = document.querySelector(".legend");
  const filtersSection = document.getElementById("filtersSection");
  
  if (currentUser) {
    // User logged in - show legend, filters and schedule
    if (legend) legend.style.display = "flex";
    if (filtersSection) filtersSection.style.display = "flex";
    loadUserPreferences(); // Load preferences
    subscribeBlockedDays(); // Load blocked days
    subscribeBlockedSlots(); // Load blocked slots
    subscribeSchedule();
    subscribeWishlistAds();
    // Handle deep link after login (in case user clicked link before logging in)
    setTimeout(() => handleDeepLink(), 500);
  } else {
    // User not logged in - hide legend, filters and clear the schedule
    if (legend) legend.style.display = "none";
    if (filtersSection) filtersSection.style.display = "none";
    if (unsubscribe) unsubscribe();
    if (unsubscribeBlockedDays) unsubscribeBlockedDays();
    if (unsubscribeBlockedSlots) unsubscribeBlockedSlots();
    if (unsubscribeAds) unsubscribeAds();
    userPreferences = null;
    blockedDays = {};
    blockedSlots = {};
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
 * USER PREFERENCES
 *********************/
async function loadUserPreferences() {
  if (!currentUser) return;
  
  try {
    // Try to load from localStorage first (faster)
    const cachedPrefs = localStorage.getItem(`prefs_${currentUser.uid}`);
    if (cachedPrefs) {
      const parsed = JSON.parse(cachedPrefs);
      // Normalize sports when loading from cache
      userPreferences = {
        ...parsed,
        selectedSports: (parsed.selectedSports || []).map(s => normalizeSportName(s))
      };
    }
    
    // Then load from Firestore (authoritative)
    const doc = await db.collection("userPreferences").doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();
      // Normalize sports when loading from Firestore
      userPreferences = {
        ...data,
        selectedSports: (data.selectedSports || []).map(s => normalizeSportName(s))
      };
      console.log("Loaded preferences from Firestore (normalized):", userPreferences.selectedSports);
      // Update cache with normalized values
      localStorage.setItem(`prefs_${currentUser.uid}`, JSON.stringify(userPreferences));
    } else {
      // No preferences set - show all sports
      userPreferences = { selectedSports: [] };
    }
  } catch (error) {
    console.error("Error loading preferences:", error);
    userPreferences = { selectedSports: [] };
  }
}

function openPreferencesModal() {
  const modal = document.getElementById("preferencesModal");
  const checkboxContainer = document.getElementById("sportCheckboxes");
  
  // Close dropdown
  const dropdown = document.getElementById("userDropdown");
  if (dropdown) dropdown.classList.remove("show");
  
  // Get all unique sports from SPORT_META and sort alphabetically
  const allSports = Object.keys(SPORT_META)
    .filter(sport => sport !== "No Games")
    .sort();
  
  // Build checkboxes
  checkboxContainer.innerHTML = "";
  allSports.forEach(sport => {
    const normalizedSport = normalizeSportName(sport);
    const normalizedPrefs = (userPreferences?.selectedSports || []).map(s => normalizeSportName(s));
    const isChecked = normalizedPrefs.includes(normalizedSport);
    
    const checkbox = document.createElement("div");
    checkbox.className = "sport-checkbox-item";
    
    // Create elements directly to avoid HTML escaping issues
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "sport";
    input.value = normalizedSport;  // Use normalized value
    input.checked = isChecked;
    
    const span = document.createElement("span");
    span.textContent = sport;  // Display original for readability
    
    label.appendChild(input);
    label.appendChild(span);
    checkbox.appendChild(label);
    checkboxContainer.appendChild(checkbox);
  });
  
  modal.style.display = "flex";
}

function closePreferencesModal() {
  document.getElementById("preferencesModal").style.display = "none";
}

async function savePreferences() {
  if (!currentUser) return;
  
  const checkboxes = document.querySelectorAll('#sportCheckboxes input[type="checkbox"]');
  const selectedSports = Array.from(checkboxes)
    .filter(cb => cb.checked)
    .map(cb => normalizeSportName(cb.value));  // Normalize apostrophes
  
  console.log("Saving preferences (normalized):", selectedSports); // Debug log
  console.log("Character codes for each sport:"); // Debug character encoding
  selectedSports.forEach(sport => {
    console.log(`  "${sport}": [${Array.from(sport).map(c => c.charCodeAt(0)).join(', ')}]`);
  });
  
  try {
    const prefsData = {
      uid: currentUser.uid,
      selectedSports: selectedSports,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection("userPreferences").doc(currentUser.uid).set(prefsData, { merge: true });
    
    // Update local state and cache
    userPreferences = { selectedSports };
    localStorage.setItem(`prefs_${currentUser.uid}`, JSON.stringify(userPreferences));
    
    console.log("Preferences saved to state:", userPreferences); // Debug log
    
    closePreferencesModal();
    
    alert("✅ Preferences saved successfully!");
    
    // Refresh the page to apply changes
    setTimeout(() => {
      location.reload();
    }, 500);
  } catch (error) {
    console.error("Error saving preferences:", error);
    alert("❌ Failed to save preferences: " + error.message);
  }
}

function shouldShowSport(sport) {
  // Admin override: if showing all sign-ups, ignore preferences
  if (currentUser && isCurrentUserAdmin() && showAllSignups) {
    console.log(`Admin mode: showing ${sport}`); // Debug
    return true;
  }
  
  // If no preferences or empty array, show all sports
  if (!userPreferences || !userPreferences.selectedSports || userPreferences.selectedSports.length === 0) {
    console.log(`No preferences: showing ${sport}`); // Debug
    return true;
  }
  
  // Normalize both the sport and preferences for comparison
  const normalizedSport = normalizeSportName(sport);
  const normalizedPrefs = userPreferences.selectedSports.map(s => normalizeSportName(s));
  const shouldShow = normalizedPrefs.includes(normalizedSport);
  
  console.log(`Filter check for "${sport}" (normalized: "${normalizedSport}"):`, shouldShow, "| Preferences:", normalizedPrefs); // Debug
  return shouldShow;
}

/*********************
 * BLOCKED DAYS MANAGEMENT
 *********************/
function subscribeBlockedDays() {
  if (unsubscribeBlockedDays) unsubscribeBlockedDays();
  
  unsubscribeBlockedDays = db.collection("blockedDays")
    .onSnapshot(snap => {
      blockedDays = {};
      snap.forEach(doc => {
        const data = doc.data();
        blockedDays[data.dayIndex] = {
          note: data.note,
          blockedAt: data.blockedAt,
          blockedBy: data.blockedBy
        };
      });
      console.log("Blocked days loaded:", blockedDays);
      // Re-render content to show blocked days
      if (latestSlots.length > 0) {
        renderTabContent();
      }
    }, err => {
      console.error("Error loading blocked days:", err);
    });
}

function isDayBlocked(dayIndex) {
  return blockedDays.hasOwnProperty(dayIndex);
}

function subscribeBlockedSlots() {
  if (unsubscribeBlockedSlots) unsubscribeBlockedSlots();
  
  unsubscribeBlockedSlots = db.collection("blockedSlots")
    .onSnapshot(snap => {
      blockedSlots = {};
      snap.forEach(doc => {
        const data = doc.data();
        const key = `${data.slotId}_${data.prio}`;
        blockedSlots[key] = {
          note: data.note,
          blockedAt: data.blockedAt,
          blockedBy: data.blockedBy
        };
      });
      console.log("Blocked slots loaded:", blockedSlots);
      // Re-render content to show blocked slots
      if (latestSlots.length > 0) {
        renderTabContent();
      }
    }, err => {
      console.error("Error loading blocked slots:", err);
    });
}

function isSlotBlocked(slotId, prio) {
  const key = `${slotId}_${prio}`;
  return blockedSlots.hasOwnProperty(key);
}

async function toggleBlockSlot(slotId, prio, slot, p, block) {
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Admins only.");
  }
  
  const key = `${slotId}_${prio}`;
  const docRef = db.collection("blockedSlots").doc(key);
  
  try {
    if (block) {
      // Block the slot - prompt for reason
      const note = prompt(`Block this ${p.sport} slot?\nEnter reason (e.g., "Maintenance", "Special Event"):`);
      if (!note || !note.trim()) {
        return; // User cancelled or entered empty note
      }
      
      await docRef.set({
        slotId: slotId,
        prio: prio,
        dayIndex: slot.dayIndex,
        dayName: DAYS[slot.dayIndex],
        blockId: slot.blockId,
        sport: p.sport,
        note: note.trim(),
        blockedAt: firebase.firestore.FieldValue.serverTimestamp(),
        blockedBy: currentUser.email
      });
      
      console.log(`Blocked slot: ${key}`);
    } else {
      // Unblock the slot
      if (confirm(`Unblock this ${p.sport} slot?`)) {
        await docRef.delete();
        console.log(`Unblocked slot: ${key}`);
      }
    }
  } catch (error) {
    console.error("Error toggling block slot:", error);
    alert("❌ Failed to update: " + error.message);
  }
}

function openBlockDaysModal() {
  const modal = document.getElementById("blockDaysModal");
  const checkboxContainer = document.getElementById("dayCheckboxes");
  
  if (!modal || !checkboxContainer) {
    console.error("Modal elements not found");
    return;
  }
  
  // Close dropdown
  const dropdown = document.getElementById("userDropdown");
  if (dropdown) dropdown.classList.remove("show");
  
  // Build controls for each day
  checkboxContainer.innerHTML = "";
  DAYS.forEach((day, dayIndex) => {
    const isBlocked = isDayBlocked(dayIndex);
    const blockInfo = blockedDays[dayIndex];
    
    // Day container
    const dayContainer = document.createElement("div");
    dayContainer.className = "day-block-container";
    
    // Day header with checkbox and note
    const dayHeader = document.createElement("div");
    dayHeader.className = "day-checkbox-item";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "day";
    checkbox.value = dayIndex;
    checkbox.checked = isBlocked;
    checkbox.id = `day_${dayIndex}`;
    
    const label = document.createElement("label");
    label.htmlFor = `day_${dayIndex}`;
    label.textContent = day;
    label.style.fontWeight = "600";
    label.style.cursor = "pointer";
    label.style.flex = "1";
    
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.placeholder = "Reason (e.g., Christmas break)";
    noteInput.value = blockInfo?.note || "";
    noteInput.id = `note_${dayIndex}`;
    noteInput.disabled = !isBlocked;
    noteInput.style.flex = "2";
    noteInput.style.padding = "6px 10px";
    noteInput.style.border = "1px solid var(--border)";
    noteInput.style.borderRadius = "6px";
    noteInput.style.fontSize = "13px";
    
    // Enable/disable note input based on checkbox
    checkbox.addEventListener("change", () => {
      noteInput.disabled = !checkbox.checked;
      if (checkbox.checked) {
        noteInput.focus();
      }
    });
    
    dayHeader.appendChild(checkbox);
    dayHeader.appendChild(label);
    dayHeader.appendChild(noteInput);
    dayContainer.appendChild(dayHeader);
    
    // Time slots section
    const slotsSection = document.createElement("div");
    slotsSection.className = "time-slots-section";
    slotsSection.id = `slots_${dayIndex}`;
    
    // Get all slots for this day (check if latestSlots is loaded)
    const daySlots = (latestSlots && latestSlots.length > 0) 
      ? latestSlots.filter(slot => slot.dayIndex === dayIndex) 
      : [];
    
    if (daySlots.length > 0) {
      const slotsTitle = document.createElement("div");
      slotsTitle.className = "slots-title";
      slotsTitle.textContent = "Time Slots:";
      slotsSection.appendChild(slotsTitle);
      
      // Sort slots by time block order
      daySlots.sort((a, b) => {
        const orderA = TIME_BLOCKS.findIndex(t => t.id === a.blockId);
        const orderB = TIME_BLOCKS.findIndex(t => t.id === b.blockId);
        return orderA - orderB;
      });
      
      daySlots.forEach(slot => {
        const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
        
        // Create slot items for P0 and P1
        [0, 1].forEach(prio => {
          const p = slot[`p${prio}`];
          if (!p || !p.sport || p.sport === "No Games") return;
          
          const slotKey = `${slot.id}_${prio}`;
          const isSlotBlockedNow = isSlotBlocked(slot.id, prio);
          const slotBlockInfo = blockedSlots[slotKey];
          
          const slotItem = document.createElement("div");
          slotItem.className = "slot-block-item";
          
          const slotCheckbox = document.createElement("input");
          slotCheckbox.type = "checkbox";
          slotCheckbox.checked = isSlotBlockedNow;
          slotCheckbox.id = `slot_${slotKey}`;
          slotCheckbox.dataset.slotId = slot.id;
          slotCheckbox.dataset.prio = prio;
          
          const slotLabel = document.createElement("label");
          slotLabel.htmlFor = `slot_${slotKey}`;
          slotLabel.innerHTML = `<span class="time-label">${block?.label || slot.blockId}</span> <span class="priority-badge ${prio === 0 ? 'p0' : 'p1'}">${prio === 0 ? 'P0' : 'P1'}</span> <span class="sport-label">${p.sport}</span>`;
          slotLabel.style.cursor = "pointer";
          slotLabel.style.flex = "1";
          
          const slotNoteInput = document.createElement("input");
          slotNoteInput.type = "text";
          slotNoteInput.placeholder = "Reason";
          slotNoteInput.value = slotBlockInfo?.note || "";
          slotNoteInput.id = `slotnote_${slotKey}`;
          slotNoteInput.disabled = !isSlotBlockedNow;
          slotNoteInput.style.flex = "1.5";
          slotNoteInput.style.padding = "4px 8px";
          slotNoteInput.style.border = "1px solid var(--border)";
          slotNoteInput.style.borderRadius = "4px";
          slotNoteInput.style.fontSize = "12px";
          
          slotCheckbox.addEventListener("change", () => {
            slotNoteInput.disabled = !slotCheckbox.checked;
            if (slotCheckbox.checked) {
              slotNoteInput.focus();
            }
          });
          
          slotItem.appendChild(slotCheckbox);
          slotItem.appendChild(slotLabel);
          slotItem.appendChild(slotNoteInput);
          slotsSection.appendChild(slotItem);
        });
      });
    }
    
    dayContainer.appendChild(slotsSection);
    checkboxContainer.appendChild(dayContainer);
  });
  
  modal.style.display = "flex";
}

function closeBlockDaysModal() {
  document.getElementById("blockDaysModal").style.display = "none";
}

async function saveBlockedDays() {
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Admins only.");
  }
  
  try {
    const batch = db.batch();
    const blockedDaysRef = db.collection("blockedDays");
    const blockedSlotsRef = db.collection("blockedSlots");
    
    // Get all current blocked days to clear removed ones
    const currentDaysSnapshot = await blockedDaysRef.get();
    const currentDayIndexes = new Set();
    currentDaysSnapshot.forEach(doc => {
      currentDayIndexes.add(doc.data().dayIndex);
    });
    
    // Get all current blocked slots to clear removed ones
    const currentSlotsSnapshot = await blockedSlotsRef.get();
    const currentSlotKeys = new Set();
    currentSlotsSnapshot.forEach(doc => {
      currentSlotKeys.add(doc.id);
    });
    
    // Process each day checkbox
    const newBlockedDays = new Set();
    DAYS.forEach((day, dayIndex) => {
      const checkbox = document.getElementById(`day_${dayIndex}`);
      const noteInput = document.getElementById(`note_${dayIndex}`);
      
      if (checkbox && checkbox.checked) {
        const note = noteInput ? noteInput.value.trim() : "";
        if (!note) {
          throw new Error(`Please provide a reason for blocking ${day}`);
        }
        
        newBlockedDays.add(dayIndex);
        const docRef = blockedDaysRef.doc(`day_${dayIndex}`);
        batch.set(docRef, {
          dayIndex: dayIndex,
          dayName: day,
          note: note,
          blockedAt: firebase.firestore.FieldValue.serverTimestamp(),
          blockedBy: currentUser.email
        });
      }
    });
    
    // Delete days that were unblocked
    currentDayIndexes.forEach(dayIndex => {
      if (!newBlockedDays.has(dayIndex)) {
        const docRef = blockedDaysRef.doc(`day_${dayIndex}`);
        batch.delete(docRef);
      }
    });
    
    // Process slot checkboxes
    const newBlockedSlots = new Set();
    document.querySelectorAll('[id^="slot_"]').forEach(slotCheckbox => {
      if (!slotCheckbox.dataset.slotId) return;
      
      const slotId = slotCheckbox.dataset.slotId;
      const prio = parseInt(slotCheckbox.dataset.prio);
      const slotKey = `${slotId}_${prio}`;
      const noteInput = document.getElementById(`slotnote_${slotKey}`);
      
      if (slotCheckbox.checked) {
        const note = noteInput ? noteInput.value.trim() : "";
        if (!note) {
          throw new Error(`Please provide a reason for blocking the slot`);
        }
        
        newBlockedSlots.add(slotKey);
        
        // Find the slot data
        const slot = latestSlots.find(s => s.id === slotId);
        if (slot) {
          const p = slot[`p${prio}`];
          const docRef = blockedSlotsRef.doc(slotKey);
          batch.set(docRef, {
            slotId: slotId,
            prio: prio,
            dayIndex: slot.dayIndex,
            dayName: DAYS[slot.dayIndex],
            blockId: slot.blockId,
            sport: p?.sport || "",
            note: note,
            blockedAt: firebase.firestore.FieldValue.serverTimestamp(),
            blockedBy: currentUser.email
          });
        }
      }
    });
    
    // Delete slots that were unblocked
    currentSlotKeys.forEach(slotKey => {
      if (!newBlockedSlots.has(slotKey)) {
        const docRef = blockedSlotsRef.doc(slotKey);
        batch.delete(docRef);
      }
    });
    
    await batch.commit();
    closeBlockDaysModal();
    alert("✅ Blocks updated successfully!");
  } catch (error) {
    console.error("Error saving blocks:", error);
    alert("❌ Failed to save: " + error.message);
  }
}

/*********************
 * GROUP PRACTICE RESERVATIONS
 * Overlay on a day + time window. Original P0/P1 sports are unchanged.
 *********************/
function getWindowReservation(slot) {
  const r = slot && slot.reservation;
  if (!r || !r.title) return null;
  return r;
}

function listReservations() {
  const seen = new Set();
  const items = [];
  (latestSlots || []).forEach(slot => {
    const res = getWindowReservation(slot);
    if (!res) return;
    const key = `${slot.dayIndex}_${slot.blockId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      slotId: slot.id,
      title: res.title,
      dayIndex: slot.dayIndex,
      dayName: res.dayName || DAYS[slot.dayIndex],
      blockId: slot.blockId
    });
  });
  return items.sort((a, b) => {
    const dayDiff = (a.dayIndex ?? 0) - (b.dayIndex ?? 0);
    if (dayDiff !== 0) return dayDiff;
    const orderA = TIME_BLOCKS.findIndex(t => t.id === a.blockId);
    const orderB = TIME_BLOCKS.findIndex(t => t.id === b.blockId);
    return orderA - orderB;
  });
}

function refreshReservePracticeModal() {
  const modal = document.getElementById("reservePracticeModal");
  if (!modal || modal.style.display !== "flex") return;
  populateReserveTimeOptions();
  renderCurrentReservations();
}

function openReservePracticeModal() {
  const modal = document.getElementById("reservePracticeModal");
  if (!modal) return;

  const dropdown = document.getElementById("userDropdown");
  if (dropdown) dropdown.classList.remove("show");

  const daySelect = document.getElementById("reserveDay");
  daySelect.innerHTML = DAYS.map((day, idx) => `<option value="${idx}">${day}</option>`).join("");
  const todayIndex = new Date().getDay();
  daySelect.value = String(todayIndex);
  daySelect.onchange = populateReserveTimeOptions;

  document.getElementById("reserveTitle").value = "";
  populateReserveTimeOptions();
  renderCurrentReservations();
  modal.style.display = "flex";
}

function closeReservePracticeModal() {
  const modal = document.getElementById("reservePracticeModal");
  if (modal) modal.style.display = "none";
}

function populateReserveTimeOptions() {
  const daySelect = document.getElementById("reserveDay");
  const timeSelect = document.getElementById("reserveTime");
  if (!daySelect || !timeSelect) return;

  const dayIndex = parseInt(daySelect.value, 10);
  const prev = timeSelect.value;
  const daySlots = (latestSlots || [])
    .filter(slot => slot.dayIndex === dayIndex)
    .sort((a, b) => {
      const orderA = TIME_BLOCKS.findIndex(t => t.id === a.blockId);
      const orderB = TIME_BLOCKS.findIndex(t => t.id === b.blockId);
      return orderA - orderB;
    });

  if (!daySlots.length) {
    timeSelect.innerHTML = `<option value="">No time windows for this day</option>`;
    return;
  }

  timeSelect.innerHTML = daySlots.map(slot => {
    const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
    const label = block?.label || slot.blockId;
    const reserved = getWindowReservation(slot);
    const suffix = reserved ? ` — reserved: ${reserved.title}` : "";
    return `<option value="${slot.blockId}">${label}${suffix}</option>`;
  }).join("");

  if (prev && [...timeSelect.options].some(o => o.value === prev)) {
    timeSelect.value = prev;
  }
}

function renderCurrentReservations() {
  const list = document.getElementById("currentReservations");
  if (!list) return;

  const items = listReservations();
  if (!items.length) {
    list.innerHTML = `<div class="reserve-empty">No group-practice reservations.</div>`;
    return;
  }

  list.innerHTML = "";
  items.forEach(res => {
    const block = TIME_BLOCKS.find(t => t.id === res.blockId);
    const item = document.createElement("div");
    item.className = "reserve-item";

    const info = document.createElement("div");
    info.className = "reserve-item-info";
    info.innerHTML = `
      <div class="reserve-item-title">${escapeHtmlJs(res.title)}</div>
      <div class="reserve-item-meta">${escapeHtmlJs(res.dayName || DAYS[res.dayIndex] || "")} · ${escapeHtmlJs(block?.label || res.blockId || "")}</div>
    `;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn danger";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = () => clearGroupReservation(res.slotId);

    item.appendChild(info);
    item.appendChild(clearBtn);
    list.appendChild(item);
  });
}

async function saveGroupReservation(event) {
  event.preventDefault();
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Admins only.");
  }

  const title = (document.getElementById("reserveTitle").value || "").trim();
  const dayIndex = parseInt(document.getElementById("reserveDay").value, 10);
  const blockId = document.getElementById("reserveTime").value;

  if (!title) return alert("Please enter a title.");
  if (Number.isNaN(dayIndex) || !blockId) return alert("Please choose a day and time.");

  const slot = (latestSlots || []).find(s => s.dayIndex === dayIndex && s.blockId === blockId);
  if (!slot) return alert("That time window is not on the schedule.");

  const existing = getWindowReservation(slot);
  if (existing && !confirm(`This window is already reserved for "${existing.title}". Replace it with "${title}"?`)) {
    return;
  }

  const reservation = {
    title,
    dayIndex,
    dayName: DAYS[dayIndex],
    blockId,
    players: (existing && existing.players) || [],
    reservedBy: currentUser.email
  };

  try {
    reservation.reservedAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection("slots").doc(slot.id).update({ reservation });
    document.getElementById("reserveTitle").value = "";
  } catch (error) {
    console.error("Error saving reservation:", error);
    alert("❌ Failed to reserve: " + error.message);
  }
}

async function clearGroupReservation(slotId) {
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Admins only.");
  }
  if (!slotId) return;
  if (!confirm("Clear this reservation and restore the original game slots?")) return;

  try {
    await db.collection("slots").doc(slotId).update({
      reservation: firebase.firestore.FieldValue.delete()
    });
  } catch (error) {
    console.error("Error clearing reservation:", error);
    alert("❌ Failed to clear: " + error.message);
  }
}

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
let unsubscribeBlockedDays = null;
let unsubscribeBlockedSlots = null;
let unsubscribeAds = null;
let selectedSport = null;
let latestSlots = [];
let latestAdItems = [];

function subscribeWishlistAds() {
  if (unsubscribeAds) unsubscribeAds();

  unsubscribeAds = db.collection("wishlistItems")
    .where("adEnabled", "==", true)
    .onSnapshot(snap => {
      latestAdItems = snap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(item => item.status !== "secured");
      renderTabContent();
    }, err => console.error(err));
}

function subscribeSchedule() {
  if (unsubscribe) unsubscribe();

  unsubscribe = db.collection("slots")
    .orderBy("dayIndex")
    .onSnapshot(snap => {
      latestSlots = [];
      const sportSet = new Set();
      const allSportsFound = new Set();

      snap.forEach(doc => {
        const data = { id: doc.id, ...doc.data() };
        latestSlots.push(data);
        const p0Sport = data.p0?.sport;
        const p1Sport = data.p1?.sport;
        
        // Track all sports found in database
        if (p0Sport && p0Sport !== "No Games") allSportsFound.add(p0Sport);
        if (p1Sport && p1Sport !== "No Games") allSportsFound.add(p1Sport);
        
        // Only add sports that pass the preference filter
        if (p0Sport && p0Sport !== "No Games" && shouldShowSport(p0Sport)) {
          sportSet.add(p0Sport);
        }
        if (p1Sport && p1Sport !== "No Games" && shouldShowSport(p1Sport)) {
          sportSet.add(p1Sport);
        }
      });
      
      // Debug: Show all sports found in database
      console.log("All sports found in database:", Array.from(allSportsFound));
      console.log("Sports after preference filter:", Array.from(sportSet));

      const sports = [MY_GAMES_TAB, ALL_GAMES_TAB, ...Array.from(sportSet).sort()];
      
      // Smart initial tab selection (only on first load)
      if (!initialTabSet && currentUser) {
        // Check if user has joined any games
        const userHasGames = latestSlots.some(slot => {
          const p0Players = slot.p0?.players || [];
          const p1Players = slot.p1?.players || [];
          const reservationPlayers = getWindowReservation(slot)?.players || [];
          return p0Players.some(p => p.uid === currentUser.uid) || 
                 p1Players.some(p => p.uid === currentUser.uid) ||
                 reservationPlayers.some(p => p.uid === currentUser.uid);
        });
        
        // Default to "My Games" if user has games, otherwise "All Games"
        selectedSport = userHasGames ? MY_GAMES_TAB : ALL_GAMES_TAB;
        initialTabSet = true;
        console.log(`Smart tab selection: ${selectedSport} (user has games: ${userHasGames})`);
      } else if (!selectedSport || !sports.includes(selectedSport)) {
        // Fallback if sport is invalid
        selectedSport = sports[0] || MY_GAMES_TAB;
      }

      renderTabs(sports);
      renderTabContent();
      refreshReservePracticeModal();
      
      // Handle deep link after content is rendered
      handleDeepLink();
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
    if (isDayBlocked(dayIndex)) {
      daySection.classList.add("blocked");
    }

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);
    
    // Show blocked day notice if day is blocked
    if (isDayBlocked(dayIndex)) {
      const blockNotice = document.createElement("div");
      blockNotice.className = "block-notice";
      blockNotice.innerHTML = `<span class="block-icon">🚫</span><span class="block-text">${blockedDays[dayIndex].note}</span>`;
      daySection.appendChild(blockNotice);
    }

    const matching = latestSlots
      .filter(slot => slot.dayIndex === dayIndex)
      .filter(slot => !isTimeSlotInPast(slot.dayIndex, slot.blockId))
      .flatMap(slot => {
        const entries = [];
        if (slot.p0?.sport === selectedSport && matchesFilters(slot, 0) && shouldShowSport(slot.p0.sport)) {
          entries.push({ slot, prio: 0 });
        }
        if (slot.p1?.sport === selectedSport && matchesFilters(slot, 1) && shouldShowSport(slot.p1.sport)) {
          entries.push({ slot, prio: 1 });
        }
        return entries;
      })
      .sort((a, b) => {
        const orderA = TIME_BLOCKS.findIndex(t => t.id === a.slot.blockId);
        const orderB = TIME_BLOCKS.findIndex(t => t.id === b.slot.blockId);
        return orderA - orderB || a.prio - b.prio;
      });

    // Don't show slots if the entire day is blocked
    if (!isDayBlocked(dayIndex)) {
      const track = document.createElement("div");
      track.className = "slot-track";

      if (matching.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = `No ${selectedSport} games.`;
        track.appendChild(empty);
      } else {
        appendToTrack(track, matching);
      }

      daySection.appendChild(track);
    }

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
        const reservation = getWindowReservation(slot);
        if (reservation) {
          const hasCheckedIn = (reservation.players || []).some(pl => pl.uid === currentUser.uid);
          return hasCheckedIn ? [{ slot, prio: "reservation" }] : result;
        }
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
    if (isDayBlocked(dayIndex)) {
      daySection.classList.add("blocked");
    }

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);
    
    // Show blocked day notice if day is blocked
    if (isDayBlocked(dayIndex)) {
      const blockNotice = document.createElement("div");
      blockNotice.className = "block-notice";
      blockNotice.innerHTML = `<span class="block-icon">🚫</span><span class="block-text">${blockedDays[dayIndex].note}</span>`;
      daySection.appendChild(blockNotice);
    }

    // Don't show slots if the entire day is blocked
    if (!isDayBlocked(dayIndex)) {
      const track = document.createElement("div");
      track.className = "slot-track";
      appendToTrack(track, entries);
      daySection.appendChild(track);
    }

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
        if (getWindowReservation(slot)) {
          return [{ slot, prio: "reservation" }];
        }
        ["p0", "p1"].forEach(key => {
          const prio = key === "p0" ? 0 : 1;
          const payload = slot[key];
          if (payload?.sport && payload.sport !== "No Games" && matchesFilters(slot, prio) && shouldShowSport(payload.sport)) {
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
    if (isDayBlocked(dayIndex)) {
      daySection.classList.add("blocked");
    }

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `<span>${day}</span><span class="date">${getDateLabel(dayIndex)}</span>`;
    daySection.appendChild(header);
    
    // Show blocked day notice if day is blocked
    if (isDayBlocked(dayIndex)) {
      const blockNotice = document.createElement("div");
      blockNotice.className = "block-notice";
      blockNotice.innerHTML = `<span class="block-icon">🚫</span><span class="block-text">${blockedDays[dayIndex].note}</span>`;
      daySection.appendChild(blockNotice);
    }

    // Don't show slots if the entire day is blocked
    if (!isDayBlocked(dayIndex)) {
      const track = document.createElement("div");
      track.className = "slot-track";
      appendToTrack(track, entries);
      daySection.appendChild(track);
    }

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
  const dayBlocked = isDayBlocked(slot.dayIndex);
  const slotBlocked = isSlotBlocked(slot.id, prio);
  const reservation = getWindowReservation(slot);
  const isAdmin = currentUser && isCurrentUserAdmin();

  const mainLimit = meta.mainLimit || 10;
  const totalPlayers = (p.players || []).length;
  const waitingPlayers = Math.max(0, totalPlayers - mainLimit);

  const card = document.createElement("div");
  card.className = `slot-card${active ? " active" : ""}${reservation ? " reserved" : ""}`;
  card.setAttribute("data-slot-id", slot.id);
  card.setAttribute("data-prio", prio);

  const maxPlayers = meta.max ? meta.max : 20;
  const canAddGuest = currentUser && p.sport !== "No Games" && (p.players || []).length < maxPlayers;

  const top = document.createElement("div");
  top.className = "slot-time";
  top.innerHTML = `<span>${block?.label ?? slot.blockId}</span>`;
  
  const ICON = {
    share:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    block:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/></svg>`,
    unblock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
    guest:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    join:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`,
    joined:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`,
    leave:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,
  };

  // Action buttons row
  const buttonContainer = document.createElement("div");
  buttonContainer.style.display = "flex";
  buttonContainer.style.gap = "8px";
  buttonContainer.style.alignItems = "center";

  // Share button (always visible)
  const shareBtn = document.createElement("button");
  shareBtn.className = "btn share-btn-top";
  shareBtn.innerHTML = ICON.share;
  shareBtn.title = "Share on WhatsApp";
  shareBtn.onclick = () => shareSlotOnWhatsApp(slot, prio, p, block);
  buttonContainer.appendChild(shareBtn);

  // Block/Unblock button (admin only)
  if (isAdmin && p.sport !== "No Games") {
    const blockSlotBtn = document.createElement("button");
    blockSlotBtn.className = slotBlocked ? "btn unblock-btn-top" : "btn block-btn-top";
    blockSlotBtn.innerHTML = slotBlocked ? ICON.unblock : ICON.block;
    blockSlotBtn.title = slotBlocked ? "Unblock this slot" : "Block this slot";
    blockSlotBtn.onclick = () => toggleBlockSlot(slot.id, prio, slot, p, !slotBlocked);
    buttonContainer.appendChild(blockSlotBtn);
  }

  // Guest button (conditional)
  if (canAddGuest && !slotBlocked) {
    const addGuestBtn = document.createElement("button");
    addGuestBtn.className = "btn guest-btn-top";
    addGuestBtn.innerHTML = ICON.guest;
    addGuestBtn.title = "Add Guest";
    addGuestBtn.onclick = () => showGuestModal(slot.id, prio);
    buttonContainer.appendChild(addGuestBtn);
  }

  if (isAdmin && reservation && prio === 0) {
    const clearReserveBtn = document.createElement("button");
    clearReserveBtn.className = "btn clear-reserve-btn-top";
    clearReserveBtn.textContent = "Clear";
    clearReserveBtn.title = "Clear this group-practice reservation";
    clearReserveBtn.onclick = () => clearGroupReservation(slot.id);
    buttonContainer.appendChild(clearReserveBtn);
  }
  
  card.appendChild(top);

  const sportTag = document.createElement("div");
  sportTag.className = "sport-tag";
  if (reservation) {
    sportTag.innerHTML = `<span class="priority-pill reserved">Reserved</span><span class="priority-pill ${prio === 0 ? "p0" : "p1"}">${prio === 0 ? "P0" : "P1"}</span><span>${escapeHtmlJs(reservation.title)}</span>`;
  } else {
    sportTag.innerHTML = `<span class="priority-pill ${prio === 0 ? "p0" : "p1"}">${prio === 0 ? "P0" : "P1"}</span><span>${escapeHtmlJs(p.sport)}</span>`;
  }
  card.appendChild(sportTag);

  if (reservation) {
    const reserveNotice = document.createElement("div");
    reserveNotice.className = "slot-reserve-notice";
    reserveNotice.innerHTML = `<span class="block-icon">🟢</span><span class="block-text">Reserved for ${escapeHtmlJs(reservation.title)}</span>`;
    card.appendChild(reserveNotice);

    const orig = document.createElement("div");
    orig.className = "reserved-original";
    orig.textContent = `Original: ${p.sport}`;
    card.appendChild(orig);
  }
  
  // Show blocked slot notice if individual slot is blocked
  if (slotBlocked) {
    const slotBlockNotice = document.createElement("div");
    slotBlockNotice.className = "slot-block-notice";
    slotBlockNotice.innerHTML = `<span class="block-icon">🚫</span><span class="block-text">${escapeHtmlJs(blockedSlots[`${slot.id}_${prio}`].note)}</span>`;
    card.appendChild(slotBlockNotice);
  }

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
  
  const allPlayers = p.players || [];
  if (allPlayers.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No players yet";
    playersList.appendChild(empty);
  } else {
    // Render in explicit rows of 4
    for (let rowStart = 0; rowStart < allPlayers.length; rowStart += 4) {
      const rowEl = document.createElement("div");
      rowEl.className = "player-row";

      allPlayers.slice(rowStart, rowStart + 4).forEach((pl, i) => {
        const index = rowStart + i;
        const playerWrapper = document.createElement("span");
        playerWrapper.className = "player-wrapper";

        const chip = document.createElement("span");
        chip.className = index >= mainLimit ? "player waiting-list" : "player";
        chip.textContent = pl.isGuest ? `*${toCamelCase(pl.name)}` : toCamelCase(pl.name);
        if (pl.isGuest) {
          chip.title = `Guest - Parishioner: ${pl.parishionerName || 'N/A'}, Family ID: ${pl.familyId || 'N/A'}`;
        }
        playerWrapper.appendChild(chip);

        if (pl.isGuest && isAdmin) {
          const removeBtn = document.createElement("span");
          removeBtn.className = "remove-guest";
          removeBtn.textContent = "×";
          removeBtn.title = "Remove guest player";
          removeBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Remove guest player ${pl.name}?`)) removeGuest(slot.id, prio, pl.uid);
          };
          playerWrapper.appendChild(removeBtn);
        }

        rowEl.appendChild(playerWrapper);
      });

      playersList.appendChild(rowEl);
    }
  }
  card.appendChild(playersList);

  const btnbar = document.createElement("div");
  btnbar.className = "btnbar";

  // Always use the current metadata max value, ignore stored maxPlayers
  const blocked = dayBlocked || slotBlocked;
  const canJoin = currentUser && p.sport !== "No Games" && (p.players || []).length < maxPlayers && !blocked;
  const isIn = !!currentUser && (p.players || []).some(pl => pl.uid === currentUser.uid);

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.innerHTML = isIn ? ICON.joined : ICON.join;
  joinBtn.title = blocked ? "Slot is blocked" : (isIn ? "Joined" : "Join");
  joinBtn.disabled = !currentUser || isIn || !canJoin || blocked;
  joinBtn.onclick = () => updateSignup(slot.id, prio, "join");

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn";
  leaveBtn.innerHTML = ICON.leave;
  leaveBtn.title = blocked ? "Slot is blocked" : "Leave";
  leaveBtn.disabled = !currentUser || !isIn || blocked;
  leaveBtn.onclick = () => updateSignup(slot.id, prio, "leave");

  btnbar.appendChild(joinBtn);
  btnbar.appendChild(leaveBtn);

  card.appendChild(btnbar);
  card.appendChild(buttonContainer);

  return card;
}

function renderReservedWindowCard(slot) {
  const reservation = getWindowReservation(slot);
  const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
  const players = (reservation && reservation.players) || [];
  const isAdmin = currentUser && isCurrentUserAdmin();
  const isIn = !!currentUser && players.some(pl => pl.uid === currentUser.uid);
  const blocked = isDayBlocked(slot.dayIndex);

  const ICON = {
    share:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    guest:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    join:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`,
    joined: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`,
    leave:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`
  };

  const card = document.createElement("div");
  card.className = "slot-card reserved reservation-window-card";
  card.setAttribute("data-slot-id", slot.id);
  card.setAttribute("data-reservation", "true");

  const top = document.createElement("div");
  top.className = "slot-time";
  top.innerHTML = `<span>${escapeHtmlJs(block?.label ?? slot.blockId)}</span><span class="reserved-header-badge">Reserved</span>`;
  card.appendChild(top);

  const title = document.createElement("div");
  title.className = "reservation-title";
  title.textContent = reservation.title;
  card.appendChild(title);

  const notice = document.createElement("div");
  notice.className = "slot-reserve-notice";
  notice.innerHTML = `<span class="block-icon">🟢</span><span class="block-text">Reserved for ${escapeHtmlJs(reservation.title)}</span>`;
  card.appendChild(notice);

  const metrics = document.createElement("div");
  metrics.className = "metrics";
  metrics.textContent = `${players.length} checked in`;
  card.appendChild(metrics);

  const playersList = document.createElement("div");
  playersList.className = "players";
  if (!players.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No players yet";
    playersList.appendChild(empty);
  } else {
    for (let rowStart = 0; rowStart < players.length; rowStart += 4) {
      const row = document.createElement("div");
      row.className = "player-row";
      players.slice(rowStart, rowStart + 4).forEach(pl => {
        const wrapper = document.createElement("span");
        wrapper.className = "player-wrapper";
        const chip = document.createElement("span");
        chip.className = "player";
        chip.textContent = pl.isGuest ? `*${toCamelCase(pl.name)}` : toCamelCase(pl.name);
        if (pl.isGuest) {
          chip.title = `Guest - Parishioner: ${pl.parishionerName || "N/A"}, Family ID: ${pl.familyId || "N/A"}`;
        }
        wrapper.appendChild(chip);
        if (pl.isGuest && isAdmin) {
          const removeBtn = document.createElement("span");
          removeBtn.className = "remove-guest";
          removeBtn.textContent = "×";
          removeBtn.title = "Remove guest player";
          removeBtn.onclick = e => {
            e.stopPropagation();
            if (confirm(`Remove guest player ${pl.name}?`)) {
              removeReservationGuest(slot.id, pl.uid);
            }
          };
          wrapper.appendChild(removeBtn);
        }
        row.appendChild(wrapper);
      });
      playersList.appendChild(row);
    }
  }
  card.appendChild(playersList);

  const actions = document.createElement("div");
  actions.className = "reservation-actions";

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.innerHTML = isIn ? ICON.joined : ICON.join;
  joinBtn.title = blocked ? "Day is blocked" : (isIn ? "Checked in" : "Check in");
  joinBtn.disabled = !currentUser || isIn || blocked;
  joinBtn.onclick = () => updateReservationSignup(slot.id, "join");
  actions.appendChild(joinBtn);

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn";
  leaveBtn.innerHTML = ICON.leave;
  leaveBtn.title = blocked ? "Day is blocked" : "Leave";
  leaveBtn.disabled = !currentUser || !isIn || blocked;
  leaveBtn.onclick = () => updateReservationSignup(slot.id, "leave");
  actions.appendChild(leaveBtn);

  const guestBtn = document.createElement("button");
  guestBtn.className = "btn guest-btn-top";
  guestBtn.innerHTML = ICON.guest;
  guestBtn.title = "Add Guest";
  guestBtn.disabled = !currentUser || blocked;
  guestBtn.onclick = () => showGuestModal(slot.id, "reservation");
  actions.appendChild(guestBtn);

  const shareBtn = document.createElement("button");
  shareBtn.className = "btn share-btn-top";
  shareBtn.innerHTML = ICON.share;
  shareBtn.title = "Share on WhatsApp";
  shareBtn.onclick = () => shareReservationOnWhatsApp(slot);
  actions.appendChild(shareBtn);

  if (isAdmin) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn clear-reserve-btn-top";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Clear this group-practice reservation";
    clearBtn.onclick = () => clearGroupReservation(slot.id);
    actions.appendChild(clearBtn);
  }

  card.appendChild(actions);
  return card;
}

function escapeHtmlJs(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatMoneyJs(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function renderAdCard(item) {
  const card = document.createElement("div");
  card.className = "slot-card ad-card";

  const goal = Number(item.goalAmount) || 0;
  const raised = Number(item.raisedAmount) || 0;
  const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  const storeLabel = item.store === "walmart" ? "Walmart" : "Amazon";
  const nameEsc = escapeHtmlJs(item.name).replace(/'/g, "\\'");

  card.innerHTML = `
    <div class="ad-card-image">
      <span class="wishlist-pill">Wishlist</span>
      ${item.imageUrl
        ? `<img src="${escapeHtmlJs(item.imageUrl)}" alt="${escapeHtmlJs(item.name)}" onerror="this.remove()" />`
        : `<span class="ad-card-placeholder">🎁</span>`}
    </div>
    <div class="ad-card-body">
      <div class="ad-card-name">${escapeHtmlJs(item.name)}</div>
      ${item.notes ? `<div class="ad-card-notes">${escapeHtmlJs(item.notes)}</div>` : ""}
      ${item.productUrl ? `<a href="${escapeHtmlJs(item.productUrl)}" target="_blank" rel="noopener" class="ad-card-link">View on ${storeLabel} →</a>` : ""}
      <div>
        <div class="progress-label"><span>$${formatMoneyJs(raised)} of $${formatMoneyJs(goal)}</span><span>${pct}%</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
      </div>
      <button type="button" class="contribute-btn" onclick="openContributeModal('${item.id}', '${nameEsc}')">Contribute</button>
      <a href="wishlist.html" class="ad-card-wishlist-link">Go to Wishlist →</a>
    </div>
  `;
  return card;
}

let activeAdItemId = null;

function openContributeModal(itemId, itemName) {
  activeAdItemId = itemId;
  document.getElementById("modalItemName").textContent = itemName;
  document.getElementById("contributeForm").reset();
  document.getElementById("contributeModal").style.display = "flex";
}

function closeContributeModal() {
  document.getElementById("contributeModal").style.display = "none";
  activeAdItemId = null;
}

async function submitContribution(ev) {
  ev.preventDefault();
  if (!activeAdItemId) return;

  const contributorName = document.getElementById("contributorName").value.trim();
  const amount = parseFloat(document.getElementById("contributionAmount").value);
  const note = document.getElementById("contributionNote").value.trim();

  if (!contributorName || !(amount > 0)) {
    alert("Please enter your name and a valid amount.");
    return;
  }

  const btn = document.getElementById("contributeSubmitBtn");
  btn.disabled = true;

  const itemRef = db.collection("wishlistItems").doc(activeAdItemId);
  const contributionRef = itemRef.collection("contributions").doc();

  try {
    await db.runTransaction(async tx => {
      const itemDoc = await tx.get(itemRef);
      if (!itemDoc.exists) throw new Error("This item no longer exists.");

      const item = itemDoc.data();
      if (item.status === "secured") throw new Error("This item is already fully funded.");

      const goal = Number(item.goalAmount) || 0;
      const newRaised = (Number(item.raisedAmount) || 0) + amount;
      const newStatus = goal > 0 && newRaised >= goal ? "secured" : "open";

      tx.update(itemRef, {
        raisedAmount: newRaised,
        status: newStatus,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      tx.set(contributionRef, {
        contributorName,
        amount,
        note,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    alert("Thank you for your contribution!");
    closeContributeModal();
  } catch (err) {
    console.error("Contribution error:", err);
    alert(err.message || "Failed to record contribution.");
  }
  btn.disabled = false;
}

function appendToTrack(track, entries) {
  // Group entries by slot.id so P0 + P1 of the same slot share a wrapper
  const seen = new Map();
  entries.forEach(e => {
    if (!seen.has(e.slot.id)) seen.set(e.slot.id, []);
    seen.get(e.slot.id).push(e);
  });
  let unitCount = 0;
  let adIndex = 0;

  seen.forEach(slotEntries => {
    const slot = slotEntries[0].slot;
    if (getWindowReservation(slot)) {
      track.appendChild(renderReservedWindowCard(slot));
    } else if (slotEntries.length === 1) {
      track.appendChild(renderSlotCard(slotEntries[0].slot, slotEntries[0].prio));
    } else {
      const pair = document.createElement("div");
      pair.className = "slot-pair";
      const pairBlock = TIME_BLOCKS.find(b => b.id === slotEntries[0].slot.blockId);
      const pairHeader = document.createElement("div");
      pairHeader.className = "slot-pair-header";
      pairHeader.textContent = pairBlock?.label ?? slotEntries[0].slot.blockId;
      pair.appendChild(pairHeader);
      slotEntries.forEach(e => pair.appendChild(renderSlotCard(e.slot, e.prio)));
      track.appendChild(pair);
    }

    unitCount++;
    if (unitCount % 2 === 0 && latestAdItems.length > 0) {
      track.appendChild(renderAdCard(latestAdItems[adIndex % latestAdItems.length]));
      adIndex++;
    }
  });
}

function renderSlotRow(slot, prio) {
  const p = slot[`p${prio}`] || { sport: "No Games", players: [] };
  const meta = SPORT_META[normalizeSportName(p.sport)] || { min: 0, max: 20, mainLimit: 10, waitingList: 10 };
  const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
  const active = computeActivePriority(slot) === prio;
  const dayBlocked = isDayBlocked(slot.dayIndex);
  const slotBlocked = isSlotBlocked(slot.id, prio);
  const isAdmin = currentUser && isCurrentUserAdmin();
  const blocked = dayBlocked || slotBlocked;

  const mainLimit = meta.mainLimit || 10;
  const maxPlayers = meta.max || 20;
  const players = p.players || [];
  const totalPlayers = players.length;
  const mainPlayers = Math.min(totalPlayers, mainLimit);
  const waitingPlayers = Math.max(0, totalPlayers - mainLimit);
  const fillPct = mainLimit > 0 ? Math.min(100, Math.round(mainPlayers / mainLimit * 100)) : 0;
  const canAddGuest = currentUser && p.sport !== "No Games" && totalPlayers < maxPlayers;
  const canJoin = currentUser && p.sport !== "No Games" && totalPlayers < maxPlayers && !blocked;
  const isIn = !!currentUser && players.some(pl => pl.uid === currentUser.uid);

  const SVG = {
    share:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    block:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/></svg>`,
    unblock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
    guest:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    join:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`,
    joined:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`,
    leave:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,
  };

  const row = document.createElement("div");
  row.className = "slot-row";
  row.setAttribute("data-slot-id", slot.id);
  row.setAttribute("data-prio", prio);

  // ── Main info ──
  const mainInfo = document.createElement("div");
  mainInfo.className = "slot-row-main";

  const prioBadge = document.createElement("span");
  prioBadge.className = `priority-pill ${prio === 0 ? "p0" : "p1"}`;
  prioBadge.textContent = prio === 0 ? "P0" : "P1";
  mainInfo.appendChild(prioBadge);

  const sportEl = document.createElement("div");
  sportEl.className = "slot-row-sport";
  sportEl.textContent = p.sport;
  mainInfo.appendChild(sportEl);

  if (!dayBlocked) {
    const fillSection = document.createElement("div");
    fillSection.className = "slot-row-fill";

    const barWrap = document.createElement("div");
    barWrap.className = "fill-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "fill-bar" + (waitingPlayers > 0 ? " waiting" : fillPct >= 100 ? " full" : "");
    bar.style.width = fillPct + "%";
    barWrap.appendChild(bar);
    fillSection.appendChild(barWrap);

    const countEl = document.createElement("span");
    countEl.className = "fill-count";
    countEl.textContent = `${mainPlayers}/${mainLimit}`;
    fillSection.appendChild(countEl);

    if (waitingPlayers > 0) {
      const waitEl = document.createElement("span");
      waitEl.className = "waiting-chip";
      waitEl.textContent = `+${waitingPlayers}`;
      fillSection.appendChild(waitEl);
    }

    mainInfo.appendChild(fillSection);
  }

  if (slotBlocked) {
    const blockNotice = document.createElement("span");
    blockNotice.className = "slot-row-block-notice";
    blockNotice.textContent = blockedSlots[`${slot.id}_${prio}`]?.note || "Blocked";
    mainInfo.appendChild(blockNotice);
  }

  row.appendChild(mainInfo);

  // ── Action buttons ──
  const actions = document.createElement("div");
  actions.className = "slot-row-actions";

  const shareBtn = document.createElement("button");
  shareBtn.className = "btn share-btn-top";
  shareBtn.innerHTML = SVG.share;
  shareBtn.title = "Share on WhatsApp";
  shareBtn.onclick = () => shareSlotOnWhatsApp(slot, prio, p, block);
  actions.appendChild(shareBtn);

  if (isAdmin && p.sport !== "No Games") {
    const blockBtn = document.createElement("button");
    blockBtn.className = slotBlocked ? "btn unblock-btn-top" : "btn block-btn-top";
    blockBtn.innerHTML = slotBlocked ? SVG.unblock : SVG.block;
    blockBtn.title = slotBlocked ? "Unblock this slot" : "Block this slot";
    blockBtn.onclick = () => toggleBlockSlot(slot.id, prio, slot, p, !slotBlocked);
    actions.appendChild(blockBtn);
  }

  if (canAddGuest && !slotBlocked) {
    const guestBtn = document.createElement("button");
    guestBtn.className = "btn guest-btn-top";
    guestBtn.innerHTML = SVG.guest;
    guestBtn.title = "Add Guest";
    guestBtn.onclick = () => showGuestModal(slot.id, prio);
    actions.appendChild(guestBtn);
  }

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.innerHTML = isIn ? SVG.joined : SVG.join;
  joinBtn.title = blocked ? "Slot is blocked" : (isIn ? "Joined" : "Join");
  joinBtn.disabled = !currentUser || isIn || !canJoin || blocked;
  joinBtn.onclick = () => updateSignup(slot.id, prio, "join");
  actions.appendChild(joinBtn);

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn";
  leaveBtn.innerHTML = SVG.leave;
  leaveBtn.title = blocked ? "Slot is blocked" : "Leave";
  leaveBtn.disabled = !currentUser || !isIn || blocked;
  leaveBtn.onclick = () => updateSignup(slot.id, prio, "leave");
  actions.appendChild(leaveBtn);

  row.appendChild(actions);
  return row;
}

function renderTimeBlock(entries) {
  // Group by blockId (TIME_BLOCKS order), then by slot.id within each block
  const blockMap = new Map();
  entries.forEach(({ slot, prio }) => {
    if (!blockMap.has(slot.blockId)) blockMap.set(slot.blockId, new Map());
    const slotMap = blockMap.get(slot.blockId);
    if (!slotMap.has(slot.id)) slotMap.set(slot.id, []);
    slotMap.get(slot.id).push({ slot, prio });
  });

  const fragment = document.createDocumentFragment();

  TIME_BLOCKS.forEach(tb => {
    if (!blockMap.has(tb.id)) return;

    const timeBlock = document.createElement("div");
    timeBlock.className = "time-block";

    const label = document.createElement("div");
    label.className = "time-block-label";
    label.textContent = tb.label;
    timeBlock.appendChild(label);

    blockMap.get(tb.id).forEach((slotEntries, slotId) => {
      const group = document.createElement("div");
      group.className = "slot-group";

      // Mark group active if any priority is the computed active one
      const hasActive = slotEntries.some(e => computeActivePriority(e.slot) === e.prio);
      if (hasActive) group.classList.add("active");

      // Mark group blocked if the slot itself is blocked at day level
      if (slotEntries.length && isDayBlocked(slotEntries[0].slot.dayIndex)) {
        group.classList.add("slot-group-blocked");
      }

      slotEntries.forEach(({ slot, prio }, idx) => {
        if (idx > 0) {
          const divider = document.createElement("div");
          divider.className = "slot-group-divider";
          group.appendChild(divider);
        }
        group.appendChild(renderSlotRow(slot, prio));
      });

      timeBlock.appendChild(group);
    });

    fragment.appendChild(timeBlock);
  });

  return fragment;
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
  if (currentUser && isCurrentUserAdmin() && showAllSignups) {
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
  if (currentUser && isCurrentUserAdmin() && showAllSignups) {
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
 * GUEST MODAL
 *********************/
function showGuestModal(slotId, prio) {
  const modal = document.getElementById("guestModal");
  const form = document.getElementById("guestForm");
  
  // Store slot info for submission
  form.dataset.slotId = slotId;
  form.dataset.prio = prio;
  
  // Clear form fields
  document.getElementById("fullName").value = "";
  document.getElementById("familyId").value = "";
  
  // Auto-fill parishioner name from signed-in user (after clearing other fields)
  if (currentUser && currentUser.displayName) {
    const parishionerNameField = document.getElementById("parishionerName");
    parishionerNameField.value = toCamelCase(currentUser.displayName);
  }
  
  // Show modal
  modal.style.display = "flex";
}

function closeGuestModal() {
  const modal = document.getElementById("guestModal");
  modal.style.display = "none";
}

async function submitGuest(event) {
  event.preventDefault();
  
  const form = event.target;
  const slotId = form.dataset.slotId;
  const isReservation = form.dataset.prio === "reservation";
  const prio = isReservation ? null : parseInt(form.dataset.prio);
  
  const guestData = {
    fullName: form.fullName.value.trim(),
    parishionerName: form.parishionerName.value.trim(),
    familyId: form.familyId.value.trim()
  };
  
  if (!guestData.fullName || !guestData.parishionerName || !guestData.familyId) {
    alert("Please fill in all fields");
    return;
  }
  
  if (isReservation) {
    await addReservationGuest(slotId, guestData);
  } else {
    await addGuest(slotId, prio, guestData);
  }
  closeGuestModal();
}

async function addGuest(slotId, prio, guestData) {
  if (!currentUser) return alert("Please sign in first.");
  const ref = db.collection("slots").doc(slotId);

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const data = snap.data();
    const key = `p${prio}`;
    const p = data[key] || { players: [], minPlayers: 0, maxPlayers: 0, sport: "No Games" };

    // Always use the current metadata max value, ignore stored maxPlayers
    const sportMeta = SPORT_META[p.sport] || { max: 20 };
    const max = sportMeta.max;
    if ((p.players || []).length >= max) throw new Error("Full");
    
    // Create guest player object
    const guestPlayer = {
      uid: `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: guestData.fullName,
      isGuest: true,
      parishionerName: guestData.parishionerName,
      familyId: guestData.familyId,
      addedBy: currentUser.email,
      addedAt: new Date().toISOString()
    };
    
    p.players = [...(p.players || []), guestPlayer];

    // persist update
    tx.update(ref, { [key]: p });

    // recompute and persist activePriority for visibility
    const active = computeActivePriority({ ...data, [key]: p });
    tx.update(ref, { activePriority: active });
  }).catch(e => alert(e.message));
}

async function addReservationGuest(slotId, guestData) {
  if (!currentUser) return alert("Please sign in first.");
  const guestPlayer = {
    uid: `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: guestData.fullName,
    isGuest: true,
    parishionerName: guestData.parishionerName,
    familyId: guestData.familyId,
    addedBy: currentUser.email,
    addedAt: new Date().toISOString()
  };

  const ref = db.collection("slots").doc(slotId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const reservation = snap.data().reservation;
    if (!reservation || !reservation.title) throw new Error("Reservation not found");
    reservation.players = [...(reservation.players || []), guestPlayer];
    tx.update(ref, { reservation });
  }).catch(e => alert(e.message));
}

async function removeReservationGuest(slotId, guestUid) {
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Only admins can remove guest players.");
  }

  const ref = db.collection("slots").doc(slotId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const reservation = snap.data().reservation;
    if (!reservation || !reservation.title) throw new Error("Reservation not found");
    reservation.players = (reservation.players || []).filter(player => player.uid !== guestUid);
    tx.update(ref, { reservation });
  }).catch(e => alert(e.message));
}

async function removeGuest(slotId, prio, guestUid) {
  if (!currentUser || !isCurrentUserAdmin()) {
    return alert("Only admins can remove guest players.");
  }
  
  const ref = db.collection("slots").doc(slotId);

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const data = snap.data();
    const key = `p${prio}`;
    const p = data[key] || { players: [], minPlayers: 0, maxPlayers: 0, sport: "No Games" };

    // Remove the guest player
    p.players = (p.players || []).filter(player => player.uid !== guestUid);

    // persist update
    tx.update(ref, { [key]: p });

    // recompute and persist activePriority for visibility
    const active = computeActivePriority({ ...data, [key]: p });
    tx.update(ref, { activePriority: active });
  }).catch(e => alert(e.message));
}

/*********************
 * JOIN / LEAVE (transaction)
 *********************/
async function updateReservationSignup(slotId, action) {
  if (!currentUser) return alert("Please sign in first.");
  const me = { uid: currentUser.uid, name: currentUser.displayName || "Player" };

  const ref = db.collection("slots").doc(slotId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Slot not found");
    const reservation = snap.data().reservation;
    if (!reservation || !reservation.title) throw new Error("Reservation not found");
    const players = reservation.players || [];
    const exists = players.some(player => player.uid === me.uid);
    reservation.players = action === "join"
      ? (exists ? players : [...players, me])
      : players.filter(player => player.uid !== me.uid);
    tx.update(ref, { reservation });
  }).catch(e => alert(e.message));
}

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
  if (!currentUser || !isCurrentUserAdmin()) return alert("Admins only");
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
        "8-10": { p0: "Women Badminton", p1: "Open Badminton" },
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

/*********************
 * SHARE FUNCTIONALITY
 *********************/
function shareReservationOnWhatsApp(slot) {
  const reservation = getWindowReservation(slot);
  if (!reservation) return;
  const block = TIME_BLOCKS.find(b => b.id === slot.blockId);
  const dayName = DAYS[slot.dayIndex];
  const dateLabel = getDateLabel(slot.dayIndex);
  const timeLabel = block?.label ?? slot.blockId;
  const players = reservation.players || [];
  const playerNames = players.map(pl => toCamelCase(pl.name || "Player")).join(", ");
  const baseUrl = window.location.origin + window.location.pathname;
  const deepLink = `${baseUrl}?slotId=${encodeURIComponent(slot.id)}&reservation=1`;
  const message = `🟢 *${reservation.title} — Reserved*\n` +
    `📅 ${dayName}, ${dateLabel}\n` +
    `⏰ ${timeLabel}\n` +
    `👥 ${players.length} checked in\n` +
    (playerNames ? `\n${playerNames}\n` : "") +
    `\nTap to check in:\n \n${deepLink}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_self");
}

function shareSlotOnWhatsApp(slot, prio, p, block) {
  const dayName = DAYS[slot.dayIndex];
  const dateLabel = getDateLabel(slot.dayIndex);
  const timeLabel = block?.label ?? slot.blockId;
  const reservation = getWindowReservation(slot);
  const sport = reservation ? reservation.title : p.sport;
  const totalPlayers = (p.players || []).length;
  const maxPlayers = (SPORT_META[p.sport] || { max: 20 }).max;
  
  // Create deep link URL
  const baseUrl = window.location.origin + window.location.pathname;
  const deepLink = `${baseUrl}?slotId=${encodeURIComponent(slot.id)}&prio=${prio}`;
  
  // Create share message
  // Add space before URL to help WhatsApp Web recognize it as clickable
  const playerNames = (p.players || [])
    .map(pl => toCamelCase(pl.name || "Player"))
    .join(", ");
  const reservedLine = reservation ? `🟢 *Reserved* for ${reservation.title}\n` : "";
  const message = `🏸 *Come join us for ${sport}!* 🎉\n` +
    reservedLine +
    `📅 ${dayName}, ${dateLabel}\n` +
    `⏰ ${timeLabel}\n` +
    `👥 ${totalPlayers}/${maxPlayers} spots filled\n` +
    (playerNames ? `\n${playerNames}\n` : "") +
    `\nTap to join:\n \n${deepLink}`;
  
  // WhatsApp share URL
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  
  // Open WhatsApp in new window
  window.open(whatsappUrl, '_self');
}

function handleDeepLink() {
  // Only handle deep link once per page load
  if (deepLinkHandled) return;
  
  const urlParams = new URLSearchParams(window.location.search);
  const slotId = urlParams.get('slotId');
  const prio = urlParams.get('prio');
  const isReservationLink = urlParams.get('reservation') === '1';
  
  if (!slotId || (!isReservationLink && prio === null)) return;
  
  deepLinkHandled = true; // Mark as handled
  
  // Wait for slots to load, then navigate
  const checkAndNavigate = () => {
    if (latestSlots.length === 0) {
      setTimeout(checkAndNavigate, 100);
      return;
    }
    
    const slot = latestSlots.find(s => s.id === slotId);
    if (!slot) return;
    
    const priority = isReservationLink ? null : parseInt(prio);
    if (isReservationLink) {
      if (!getWindowReservation(slot)) return;
      selectedSport = ALL_GAMES_TAB;
    } else {
      const sport = slot[`p${priority}`]?.sport;
      if (!sport || sport === "No Games") return;
      selectedSport = sport;
    }
    renderTabContent();
    
    // Scroll to the slot after a short delay to allow rendering
    setTimeout(() => {
      const selector = isReservationLink
        ? `[data-slot-id="${slotId}"][data-reservation="true"]`
        : `[data-slot-id="${slotId}"][data-prio="${priority}"]`;
      const slotCard = document.querySelector(selector);
      if (slotCard) {
        slotCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Highlight the card briefly
        slotCard.style.boxShadow = '0 0 0 4px rgba(59, 130, 246, 0.5)';
        setTimeout(() => {
          slotCard.style.boxShadow = '';
        }, 2000);
      }
    }, 300);
    
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
  };
  
  checkAndNavigate();
}

async function backupAndResetWeekly() {
  if (!currentUser || !isCurrentUserAdmin()) {
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
