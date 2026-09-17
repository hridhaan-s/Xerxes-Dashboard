/**
 * Xerxes dashboard — application wiring.
 *
 * Flow: load model → start camera → calibrate → track → end → store → review.
 * Nothing is scored before calibration, because before calibration there is no
 * reference and any number shown would be invented.
 */

import { CALIBRATION, ALERTS, SCORING, CAPTURE } from "./config.js";
import {
  buildBaseline, score, deviationToScore, stateFor, estimateDistanceCm, ema,
  REASON_COPY, COMPONENT_COPY
} from "./metrics.js";
import { Tracker } from "./tracker.js";
import { AlertEngine, BreakTimer, unlockAudio } from "./alerts.js";
import { Bridge } from "./bridge.js";
import { Trace, drawPreview, renderHistory, renderCollapseCurve } from "./charts.js";
import * as store from "./store.js";

const $ = (sel) => document.querySelector(sel);

const app = {
  tracker: new Tracker(),
  bridge: new Bridge(),
  alerts: null,
  breaks: null,
  trace: null,
  prefs: null,
  baseline: null,

  phase: "boot",          // boot | ready | calibrating | tracking | paused | ended
  smoothed: null,
  lastSeenAt: 0,
  calibrationSamples: [],
  calibrationEndsAt: 0,

  session: null
};

boot();

/* -------------------------------------------------------------------- boot */

async function boot() {
  app.prefs = await store.getPrefs();
  app.baseline = await store.getBaseline();
  app.alerts = new AlertEngine(app.prefs);
  app.alerts.addEventListener("alert", onAlert);   // bound once, not per session
  app.breaks = new BreakTimer(app.prefs.workMin);
  app.trace = new Trace($("#trace"));

  wireUI();
  wireBridge();
  await refreshHistory();

  setPhase("boot");
  drawPreviewPlaceholder("Camera off");
  setStatus("Loading the pose model…");

  app.tracker.addEventListener("loading", (e) => {
    setStatus(e.detail.stage === "model" ? "Loading the pose model…" : "Starting the runtime…");
  });

  app.tracker.addEventListener("sample", onSample);

  app.tracker.addEventListener("camera-lost", () => {
    setStatus("Camera was disconnected.");
    if (app.phase === "tracking") endSession("camera-lost");
    setPhase("ready");
  });

  app.tracker.addEventListener("visibility", (e) => {
    $("#rate").textContent = e.detail.hidden
      ? `background · ${(1000 / CAPTURE.hiddenIntervalMs).toFixed(0)} Hz`
      : `foreground · ${CAPTURE.visibleFps} Hz`;
  });

  try {
    await app.tracker.load();
  } catch (err) {
    console.error(err);
    return fail("The pose model failed to load. Check your connection and reload.");
  }

  setStatus(app.baseline
    ? "Ready. Your saved baseline is loaded."
    : "Ready. Calibrate once before your first session.");
  setPhase("ready");
  if (app.baseline) showBaselineAge();
}

/* ---------------------------------------------------------------- camera */

async function ensureCamera() {
  if (app.tracker.stream) return true;
  try {
    setStatus("Waiting for camera permission…");
    await app.tracker.startCamera($("#webcam"));
    app.tracker.start();
    setStatus("Camera on. Nothing is being recorded.");
    return true;
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    fail(denied
      ? "Camera access was blocked. Allow it from the icon in the address bar, then reload."
      : "No usable camera found. Connect one and reload.");
    return false;
  }
}

/* ----------------------------------------------------------- calibration */

async function startCalibration() {
  if (!(await ensureCamera())) return;
  await unlockAudio();

  app.calibrationSamples = [];
  app.calibrationEndsAt = Date.now() + CALIBRATION.durationSec * 1000;
  setPhase("calibrating");
  $("#calibration-copy").textContent =
    "Sit the way you want to sit for the next hour. Hold still.";

  // Deliberately setInterval, not rAF: on a slow machine the inference loop
  // saturates the animation frame queue and the countdown visibly freezes.
  const bar = $("#cal-bar");
  bar.classList.remove("run");
  bar.style.setProperty("--cal-duration", `${CALIBRATION.durationSec}s`);
  void bar.offsetWidth;            // force reflow so the animation restarts
  bar.classList.add("run");

  clearInterval(calibrationHandle);
  calibrationHandle = setInterval(tickCalibration, 100);
  tickCalibration();
}

let calibrationHandle = null;

function tickCalibration() {
  if (app.phase !== "calibrating") return clearInterval(calibrationHandle);
  const left = Math.max(0, app.calibrationEndsAt - Date.now());
  $("#calibration-count").textContent = (left / 1000).toFixed(1);
  if (left > 0) return;

  clearInterval(calibrationHandle);
  const result = buildBaseline(app.calibrationSamples);

  if (!result.ok) {
    setPhase("ready");
    const copy = {
      "not-enough-samples":
        "Couldn't see you clearly enough. Make sure your head and both shoulders are in frame, then try again.",
      "too-much-movement":
        "You moved too much to set a reference. Settle into position first, then recalibrate."
    };
    setStatus(copy[result.reason] || "Calibration failed. Try again.");
    return;
  }

  app.baseline = result.baseline;
  store.saveBaseline(app.baseline);
  setPhase("ready");
  setStatus("Baseline set. Everything from here is measured against this position.");
  showBaselineAge();
}

/* -------------------------------------------------------------- sessions */

async function startSession() {
  if (!app.baseline) {
    setStatus("Calibrate first — there is nothing to measure against yet.");
    return;
  }
  if (!(await ensureCamera())) return;
  await unlockAudio();

  app.session = {
    id: `s-${Date.now()}`,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: 0,
    score: null,
    alerts: 0,
    breaks: 0,
    faults: {},
    series: [],           // one point per minute: { m, d, s }
    _bucket: { sum: 0, n: 0, minute: 0 },
    _inRangeTicks: 0,
    _ticks: 0
  };

  app.smoothed = null;
  app.alerts.reset();
  app.breaks = new BreakTimer(app.prefs.workMin);
  app.breaks.addEventListener("break", onBreakDue);
  app.trace.clear();

  setPhase("tracking");
  setStatus("Tracking. Alerts reach you in any tab if the extension is installed.");
  app.bridge.sessionStart();
  app.lastSeenAt = Date.now();
  startClock();
}

async function endSession(reason = "manual") {
  if (!app.session) return;
  stopClock();

  const s = app.session;
  s.endedAt = Date.now();
  s.durationMs = s.endedAt - s.startedAt;
  s.score = s._ticks ? Math.round((s._inRangeTicks / s._ticks) * 100) : null;
  flushBucket(true);

  delete s._bucket;
  delete s._inRangeTicks;
  delete s._ticks;

  // Sessions shorter than a minute are noise in the history charts.
  if (s.durationMs > 60_000) {
    await store.saveSession(s);
    await store.prune();
  }

  app.bridge.sessionEnd(s.score, summaryLine(s));
  app.tracker.release();
  drawPreviewPlaceholder();
  setPhase("ended");
  renderSummary(s, reason);
  await refreshHistory();
  app.session = null;
}

function summaryLine(s) {
  const mins = Math.round(s.durationMs / 60000);
  return `${mins} min · ${s.score ?? "—"}% in range · ${s.alerts} alert${s.alerts === 1 ? "" : "s"}`;
}

/* ---------------------------------------------------------- sample handler */

function onSample(event) {
  const { ok, reason, metrics, points, at } = event.detail;

  if (app.phase === "calibrating") {
    if (ok) app.calibrationSamples.push(metrics);
    $("#calibration-copy").textContent = ok
      ? "Sit the way you want to sit for the next hour. Hold still."
      : REASON_COPY[reason] || "Adjust until you are fully in frame.";
  }

  if (app.prefs.showPreview && !document.hidden) {
    drawPreview($("#preview"), $("#webcam"), ok ? points : null, app.baseline, currentState());
  }

  if (app.phase !== "tracking") return;

  if (!ok) return handleAbsence(reason, at);

  app.lastSeenAt = at;
  const result = score(metrics, app.baseline);
  app.smoothed = ema(app.smoothed, result.deviation);

  const state = metrics.turned ? "LOW_CONFIDENCE" : stateFor(app.smoothed);
  const alignment = deviationToScore(app.smoothed);

  app.session._ticks += 1;
  if (app.smoothed < SCORING.alertAt) app.session._inRangeTicks += 1;
  app.session._bucket.sum += app.smoothed;
  app.session._bucket.n += 1;
  flushBucket(false);

  if (app.smoothed >= SCORING.driftAt) {
    app.session.faults[result.worst] = (app.session.faults[result.worst] || 0) + 1;
  }

  app.trace.push(app.smoothed, at);
  paintReadout(state, alignment, result, metrics);

  if (!metrics.turned) app.alerts.update(app.smoothed, result.worst);
  app.bridge.state(state, alignment);
}

/**
 * Leaving the desk is not good posture. v1 reported an empty chair as optimal
 * and kept the score climbing; this pauses instead.
 */
function handleAbsence(reason, at) {
  const goneSec = (at - app.lastSeenAt) / 1000;
  paintReadout("LOW_CONFIDENCE", null, null, null, REASON_COPY[reason]);

  if (goneSec > ALERTS.absenceGraceSec) {
    app.bridge.state("LOW_CONFIDENCE", null);
    $("#state-detail").textContent =
      "Paused — nothing is being scored while you are out of frame.";
  }
}

function flushBucket(force) {
  const s = app.session;
  if (!s) return;
  const minute = Math.floor((Date.now() - s.startedAt) / 60000);
  if (!force && minute === s._bucket.minute) return;
  if (s._bucket.n > 0) {
    s.series.push({
      m: s._bucket.minute,
      d: Number((s._bucket.sum / s._bucket.n).toFixed(3)),
      s: deviationToScore(s._bucket.sum / s._bucket.n)
    });
  }
  s._bucket = { sum: 0, n: 0, minute };
}

/* ------------------------------------------------------------- UI painting */

let lastState = null;

function paintReadout(state, alignment, result, metrics, note) {
  if (state !== lastState) {
    document.body.dataset.state = state;
    lastState = state;
  }

  $("#alignment").textContent = alignment == null ? "—" : alignment;

  const headline = {
    NOMINAL: "Holding your baseline",
    DRIFT: "Starting to drift",
    ALERT: "Out of range",
    LOW_CONFIDENCE: "Can't measure right now"
  }[state];

  $("#state-headline").textContent = headline;

  if (note) {
    $("#state-detail").textContent = note;
  } else if (state === "LOW_CONFIDENCE") {
    $("#state-detail").textContent = "Your head is turned, so head metrics are paused.";
  } else if (result && state !== "NOMINAL") {
    $("#state-detail").textContent = COMPONENT_COPY[result.worst].fix;
  } else {
    $("#state-detail").textContent = "Shoulders, head height and distance all match calibration.";
  }

  if (result && metrics) {
    $("#fault").textContent = state === "NOMINAL" ? "—" : COMPONENT_COPY[result.worst].label;
    $("#deviation").textContent = app.smoothed.toFixed(2);
    const cm = estimateDistanceCm(result.proximity, app.prefs.referenceDistanceCm);
    $("#distance").textContent = cm == null ? "—" : cm;
    const delta = Math.round((result.proximity - 1) * 100);
    $("#distance-delta").textContent =
      delta === 0 ? "as calibrated" : `${delta > 0 ? delta : -delta}% ${delta > 0 ? "closer" : "further"}`;
  }
}

function drawPreviewPlaceholder(text = "Camera off") {
  const canvas = $("#preview");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0e1013";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#4b5058";
  ctx.font = "300 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function currentState() {
  return document.body.dataset.state || "NOMINAL";
}

/* ----------------------------------------------------------------- alerts */

function onAlert(e) {
  const { worst, escalated, heldSec } = e.detail;
  app.session.alerts += 1;
  const copy = COMPONENT_COPY[worst];
  app.bridge.alert({
    kind: "posture",
    title: escalated ? `Still out of range — ${copy.label.toLowerCase()}` : copy.label,
    body: `${copy.fix} Held for ${heldSec}s.`
  });
  flashBanner(copy.fix);
}

function onBreakDue(e) {
  app.session.breaks += 1;
  app.bridge.alert({
    kind: "break",
    title: `${e.detail.atMin} minutes sitting`,
    body: "Stand up, look at something far away for 40 seconds.",
    seconds: 40
  });
  flashBanner("Break due. Stand up and look at something far away.");
}

let bannerTimer = null;
function flashBanner(text) {
  const banner = $("#banner");
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 9000);
}

/* ------------------------------------------------------------------ clock */

let clockHandle = null;
let lastClockAt = 0;

function startClock() {
  lastClockAt = Date.now();
  clockHandle = setInterval(() => {
    const now = Date.now();
    const delta = now - lastClockAt;
    lastClockAt = now;

    if (app.phase !== "tracking" || !app.session) return;

    app.breaks.tick(delta);
    const elapsed = now - app.session.startedAt;
    $("#elapsed").textContent = formatDuration(elapsed);
    $("#next-break").textContent = formatDuration(app.breaks.untilNextMs);

    // Heartbeat keeps the extension watchdog from declaring us dead while the
    // body is genuinely still and nothing else is being sent.
    if (Math.round(elapsed / 1000) % 15 === 0) {
      app.bridge.heartbeat(currentState(), deviationToScore(app.smoothed ?? 0));
    }
  }, 1000);
}

function stopClock() {
  clearInterval(clockHandle);
  clockHandle = null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- summary */

function renderSummary(session, reason) {
  const mins = Math.round(session.durationMs / 60000);
  $("#summary-score").textContent = session.score ?? "—";
  $("#summary-line").textContent =
    reason === "camera-lost"
      ? `Session cut short after ${mins} min — the camera disconnected.`
      : `${mins} minute${mins === 1 ? "" : "s"} tracked.`;

  const faults = Object.entries(session.faults).sort((a, b) => b[1] - a[1]);
  const list = $("#summary-faults");
  list.replaceChildren();

  if (!faults.length) {
    const li = document.createElement("li");
    li.textContent = "No drift worth reporting. That is unusual — well done.";
    list.append(li);
  } else {
    const total = faults.reduce((sum, [, n]) => sum + n, 0);
    for (const [key, n] of faults.slice(0, 3)) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${COMPONENT_COPY[key].label}</span><span class="pct">${Math.round((n / total) * 100)}%</span>`;
      list.append(li);
    }
  }

  const collapse = session.series.find((p) => p.d >= 1);
  $("#summary-collapse").textContent = collapse
    ? `First went out of range ${collapse.m} minute${collapse.m === 1 ? "" : "s"} in.`
    : "Never went out of range.";
}

/* ---------------------------------------------------------------- history */

async function refreshHistory() {
  const sessions = await store.getSessions();
  renderHistory($("#history-chart"), sessions);
  renderCollapseCurve($("#collapse-chart"), store.collapseCurve(sessions));

  const median = store.medianCollapseMinute(sessions);
  const dominant = store.dominantFault(sessions);

  $("#insight-collapse").textContent = median
    ? `Your posture typically goes out of range about ${median} minutes into a session.`
    : "Finish three sessions and this will tell you when your posture typically gives out.";

  $("#insight-fault").textContent = dominant
    ? `${COMPONENT_COPY[dominant.key].label} accounts for ${Math.round(dominant.share * 100)}% of your drift.`
    : "Your most common fault will show up here.";

  $("#session-count").textContent = sessions.length;
}

/* --------------------------------------------------------------- UI wiring */

function wireUI() {
  $("#calibrate").addEventListener("click", startCalibration);
  $("#recalibrate").addEventListener("click", startCalibration);
  $("#start").addEventListener("click", startSession);
  $("#end").addEventListener("click", () => endSession("manual"));
  $("#again").addEventListener("click", () => { setPhase("ready"); });

  $("#snooze").addEventListener("click", () => {
    if (app.alerts.snoozed) {
      app.alerts.clearSnooze();
      $("#snooze").textContent = "Snooze 20 min";
    } else {
      app.alerts.snooze(20);
      $("#snooze").textContent = "Resume alerts";
    }
  });

  $("#sound").addEventListener("change", async (e) => {
    app.prefs = await store.savePrefs({ soundEnabled: e.target.checked });
    app.alerts.prefs = app.prefs;
    if (e.target.checked) unlockAudio();
  });

  $("#preview-toggle").addEventListener("change", async (e) => {
    app.prefs = await store.savePrefs({ showPreview: e.target.checked });
    $(".preview-frame").hidden = !e.target.checked;
  });

  $("#work-min").addEventListener("change", async (e) => {
    const workMin = Math.max(5, Math.min(180, Number(e.target.value) || 30));
    e.target.value = workMin;
    app.prefs = await store.savePrefs({ workMin });
    app.breaks.workMin = workMin;
  });

  $("#reference-cm").addEventListener("change", async (e) => {
    const cm = Math.max(30, Math.min(120, Number(e.target.value) || 60));
    e.target.value = cm;
    app.prefs = await store.savePrefs({ referenceDistanceCm: cm });
  });

  $("#export").addEventListener("click", async () => {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xerxes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Delete every stored session and your calibration? This cannot be undone.")) return;
    await store.clearSessions();
    await store.clearBaseline();
    app.baseline = null;
    await refreshHistory();
    setPhase("ready");
    setStatus("All local data deleted. Calibrate to start again.");
  });

  // Restore control values from prefs once they are loaded.
  $("#sound").checked = app.prefs.soundEnabled;
  $("#preview-toggle").checked = app.prefs.showPreview;
  $("#work-min").value = app.prefs.workMin;
  $("#reference-cm").value = app.prefs.referenceDistanceCm;
  $(".preview-frame").hidden = !app.prefs.showPreview;

  window.addEventListener("beforeunload", (e) => {
    if (app.phase !== "tracking") return;
    e.preventDefault();
    e.returnValue = "";
  });
}

function wireBridge() {
  app.bridge.addEventListener("connected", () => {
    $("#bridge").dataset.status = "on";
    $("#bridge-label").textContent = "Extension connected";
  });
  app.bridge.addEventListener("unavailable", () => {
    $("#bridge").dataset.status = "off";
    $("#bridge-label").textContent = "Extension not detected";
  });
  app.bridge.addEventListener("command", (e) => {
    if (e.detail === "snooze") app.alerts.snooze(20);
    if (e.detail === "end") endSession("manual");
  });
}

function showBaselineAge() {
  const days = Math.floor((Date.now() - app.baseline.capturedAt) / 86_400_000);
  $("#baseline-age").textContent =
    days === 0 ? "set today" : `set ${days} day${days === 1 ? "" : "s"} ago`;
  $("#baseline-note").hidden = days < 14;
}

/* ----------------------------------------------------------------- phases */

function setPhase(phase) {
  app.phase = phase;
  document.body.dataset.phase = phase;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function fail(text) {
  setStatus(text);
  document.body.dataset.phase = "error";
  $("#error-copy").textContent = text;
}
