/**
 * Local persistence. IndexedDB, no server, no account.
 *
 * This is the file that turns a nagging widget into a product. A posture tool
 * that forgets everything when you close the tab can only ever tell you what is
 * happening right now — which you already know, because it is your body. The
 * interesting question is *when* you collapse, and that needs history.
 */

import { STORAGE, DEFAULT_PREFS } from "./config.js";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(STORAGE.dbName, STORAGE.dbVersion);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORAGE.sessionStore)) {
        const store = db.createObjectStore(STORAGE.sessionStore, { keyPath: "id" });
        store.createIndex("startedAt", "startedAt");
      }
      if (!db.objectStoreNames.contains(STORAGE.metaStore)) {
        db.createObjectStore(STORAGE.metaStore);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = fn(store);
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
      })
  );
}

/* ------------------------------------------------------------------ meta */

export const getBaseline = () =>
  tx(STORAGE.metaStore, "readonly", (s) => s.get(STORAGE.baselineKey));

export const saveBaseline = (baseline) =>
  tx(STORAGE.metaStore, "readwrite", (s) => s.put(baseline, STORAGE.baselineKey));

export const clearBaseline = () =>
  tx(STORAGE.metaStore, "readwrite", (s) => s.delete(STORAGE.baselineKey));

export async function getPrefs() {
  const stored = await tx(STORAGE.metaStore, "readonly", (s) => s.get(STORAGE.prefsKey));
  return { ...DEFAULT_PREFS, ...(stored || {}) };
}

export async function savePrefs(patch) {
  const next = { ...(await getPrefs()), ...patch };
  await tx(STORAGE.metaStore, "readwrite", (s) => s.put(next, STORAGE.prefsKey));
  return next;
}

/* -------------------------------------------------------------- sessions */

export const saveSession = (session) =>
  tx(STORAGE.sessionStore, "readwrite", (s) => s.put(session));

export function getSessions(limit = STORAGE.historyLimit) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const store = db
          .transaction(STORAGE.sessionStore, "readonly")
          .objectStore(STORAGE.sessionStore);
        const out = [];
        const cursor = store.index("startedAt").openCursor(null, "prev");
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || out.length >= limit) return resolve(out);
          out.push(c.value);
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      })
  );
}

export const clearSessions = () =>
  tx(STORAGE.sessionStore, "readwrite", (s) => s.clear());

/** Keeps the database from growing without bound on a daily-use machine. */
export async function prune() {
  const sessions = await getSessions(1000);
  const excess = sessions.slice(STORAGE.historyLimit);
  if (!excess.length) return 0;
  await Promise.all(
    excess.map((s) => tx(STORAGE.sessionStore, "readwrite", (store) => store.delete(s.id)))
  );
  return excess.length;
}

/* ------------------------------------------------------------ aggregates */

/**
 * The differentiating number: average deviation as a function of *minutes into
 * a session*, pooled across your history. Nobody who copies a posture widget
 * copies this, because it only exists if you stored every session.
 *
 * @returns {Array<{minute:number, deviation:number, n:number}>}
 */
export function collapseCurve(sessions, bucketMin = 5, maxMin = 120) {
  const buckets = new Map();

  for (const session of sessions) {
    for (const point of session.series || []) {
      if (point.m > maxMin) continue;
      const key = Math.floor(point.m / bucketMin) * bucketMin;
      const bucket = buckets.get(key) || { sum: 0, n: 0 };
      bucket.sum += point.d;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([minute, b]) => ({ minute, deviation: b.sum / b.n, n: b.n }))
    .filter((b) => b.n >= 3) // one session is an anecdote, not a curve
    .sort((a, b) => a.minute - b.minute);
}

/** Which fault dominates your history, summed across sessions. */
export function dominantFault(sessions) {
  const totals = {};
  for (const session of sessions) {
    for (const [key, count] of Object.entries(session.faults || {})) {
      totals[key] = (totals[key] || 0) + count;
    }
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const total = ranked.reduce((sum, [, n]) => sum + n, 0);
  return { key: ranked[0][0], share: ranked[0][1] / total, total };
}

/** Median minute at which deviation first crosses the alert line. */
export function medianCollapseMinute(sessions) {
  const minutes = [];
  for (const session of sessions) {
    const hit = (session.series || []).find((p) => p.d >= 1);
    if (hit) minutes.push(hit.m);
  }
  if (minutes.length < 3) return null;
  minutes.sort((a, b) => a - b);
  return minutes[Math.floor(minutes.length / 2)];
}

/** Export everything as JSON. Your data, in a file you can take elsewhere. */
export async function exportAll() {
  const [sessions, baseline, prefs] = await Promise.all([
    getSessions(1000),
    getBaseline(),
    getPrefs()
  ]);
  return {
    app: "xerxes",
    version: 2,
    exportedAt: new Date().toISOString(),
    baseline,
    prefs,
    sessions
  };
}
