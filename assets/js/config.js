/**
 * Every magic number in Xerxes lives here.
 *
 * Rule for this file: a constant is only allowed if it is either (a) a
 * tolerance expressed as a *fraction of the user's own calibrated baseline*,
 * or (b) a timing value in seconds. Absolute pixel values are forbidden —
 * they are what made v1 unusable on any webcam other than the author's.
 */

export const CDN = {
  // Pinned, not @latest. A silent upstream major bump should not be able to
  // break a page that is telling someone their posture is fine.
  tasksVision: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",
  wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  poseModel:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
};

export const CAPTURE = {
  width: 640,
  height: 480,
  visibleFps: 12,      // plenty for a body that moves at human speed
  hiddenIntervalMs: 1000
};

/** Pose landmark indices (MediaPipe Pose, 33-point topology). */
export const LM = {
  nose: 0,
  eyeL: 2, eyeR: 5,
  earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12
};

export const CALIBRATION = {
  durationSec: 6,
  minSamples: 20,
  /** Below this, we do not have a usable read of the body. */
  minShoulderVisibility: 0.55,
  minEarVisibility: 0.4,
  /** Shoulders narrower than this fraction of frame width = too far / cropped. */
  minShoulderWidthFrac: 0.14
};

/**
 * Tolerances. Each is the deviation from *your* baseline that counts as 1.0 —
 * the edge of acceptable. Everything downstream is expressed in these units,
 * so all five metrics become directly comparable.
 */
export const TOLERANCE = {
  slumpFrac: 0.13,      // 13% loss of head-above-shoulders height
  leanFrac: 0.17,       // lateral drift, as a fraction of shoulder width
  headTiltDeg: 9,
  shoulderTiltDeg: 7,
  proximityFrac: 0.16   // 16% closer to the screen than at calibration
};

export const WEIGHTS = {
  slump: 1.0,
  lean: 0.85,
  headTilt: 0.7,
  shoulderTilt: 0.7,
  proximity: 0.95
};

export const SCORING = {
  emaAlpha: 0.22,           // smoothing on deviation; kills single-frame jitter
  driftAt: 0.70,            // deviation entering the warning band
  alertAt: 1.00,            // deviation out of range
  pointsPerDeviation: 45    // score = 100 - 45 * deviation
};

export const ALERTS = {
  dwellSec: 12,             // must stay out of range this long before interrupting
  localCooldownSec: 90,
  escalationSec: 180,       // still out of range this long later = firmer nudge
  toneHz: 392,              // G4. Audible, not piercing.
  toneMs: 220,
  absenceGraceSec: 20       // gone from frame longer than this = session paused
};

export const BREAKS = {
  defaultWorkMin: 30,
  defaultBreakSec: 40
};

export const STORAGE = {
  dbName: "xerxes",
  dbVersion: 1,
  sessionStore: "sessions",
  metaStore: "meta",
  baselineKey: "baseline",
  prefsKey: "prefs",
  historyLimit: 90          // sessions kept; older ones are pruned
};

export const DEFAULT_PREFS = {
  referenceDistanceCm: 60,  // what you told us your eyes-to-screen distance was
  soundEnabled: true,
  workMin: BREAKS.defaultWorkMin,
  showPreview: true
};
