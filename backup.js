#!/usr/bin/env node
/**
 * Simple Firestore backup script.
 * Requires FIREBASE_SERVICE_ACCOUNT env var containing the service account JSON (or base64 of it).
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
let FieldValue;
let Timestamp;

function readCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env var is not set.");
  }

  const trimmed = raw.trim();
  const jsonString = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    throw new Error("Failed to parse FIREBASE_SERVICE_ACCOUNT: " + err.message);
  }
}

async function exportCollections() {
  const credentials = readCredentials();
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });

  const db = admin.firestore();
  FieldValue = admin.firestore.FieldValue;
  Timestamp = admin.firestore.Timestamp;

  const collections = await db.listCollections();
  const payload = {};
  let slotsSnapshot = null;

  for (const col of collections) {
    const snap = await col.get();
    payload[col.id] = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    if (col.id === "slots") {
      slotsSnapshot = snap;
    }
  }

  const outDir = path.join(__dirname, "backups");
  fs.mkdirSync(outDir, { recursive: true });

  const date = new Date();
  const stamp = date.toISOString().split("T")[0];
  const filePath = path.join(outDir, `firestore-${stamp}.json`);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Backup saved to ${filePath}`);

  if (!slotsSnapshot) {
    console.warn("No slots collection found; skipping reset.");
    return;
  }

  await backupSlotsCollection(db, slotsSnapshot, stamp);
  await resetSlotsCollection(slotsSnapshot);
}

async function backupSlotsCollection(db, snapshot, stamp) {
  const slotsData = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  await db.collection("slots_backup").doc(stamp).set({
    createdAt: FieldValue.serverTimestamp(),
    slots: slotsData,
  });

  console.log(`Firestore backup saved to slots_backup/${stamp}`);
}

async function resetSlotsCollection(snapshot) {
  const docs = snapshot.docs;
  if (!docs.length) {
    console.log("No slots to reset.");
    return;
  }

  const chunkSize = 400; // stay under Firestore batch limit
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = admin.firestore().batch();
    const slice = docs.slice(i, i + chunkSize);

    slice.forEach((doc) => {
      const data = doc.data();
      const cutoffValue = data.cutoff;
      const cutoffDate =
        cutoffValue && typeof cutoffValue.toDate === "function"
          ? cutoffValue.toDate()
          : new Date(cutoffValue || Date.now());
      cutoffDate.setDate(cutoffDate.getDate() + 7);

      batch.update(doc.ref, {
        "p0.players": [],
        "p1.players": [],
        activePriority: 0,
        cutoff: Timestamp.fromDate(cutoffDate),
      });
    });

    await batch.commit();
  }

  console.log("Slots collection reset for next week.");
}

exportCollections().catch((err) => {
  console.error(err);
  process.exit(1);
});
