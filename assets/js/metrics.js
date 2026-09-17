/**
 * Posture geometry.
 *
 * Design rule: every quantity here is either an angle or a ratio against the
 * user's own shoulder width. Nothing is measured in pixels, so a 720p webcam
 * and a 480p webcam produce the same numbers for the same body.
 *
 * What is actually measurable from a frontal webcam, honestly stated:
 *   - Head height above the shoulder line  (the usable slouch proxy)
 *   - Lateral drift of the head off the shoulder midline
 *   - Head roll and shoulder roll
 *   - Change in distance to the camera, relative to calibration
 *
 * What is NOT measurable this way, and is therefore not claimed anywhere in the
 * UI: true cervical angle, lumbar curve, or absolute distance in centimetres
 * without a calibration reference. v1 claimed all three. It should not have.
 */

import { LM, CALIBRATION, TOLERANCE, WEIGHTS, SCORING } from "./config.js";

/* ------------------------------------------------------------- primitives */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * MediaPipe returns x,y normalised to [0,1] against frame width and height
 * independently. Distances computed on those raw values are wrong whenever the
 * frame is not square — a 4:3 frame stretches every vertical measurement by
 * 33%. Convert to a square aspect space first.
 */
function toAspectSpace(landmark, aspect) {
  return { x: landmark.x * aspect, y: landmark.y, v: landmark.visibility ?? 1 };
}

/* ------------------------------------------------------- frame -> metrics */

/**
 * @param {Array} landmarks  33 normalised pose landmarks
 * @param {number} aspect    frame width / height
 * @returns {{ok: boolean, reason?: string, metrics?: object}}
 */
export function readFrame(landmarks, aspect) {
  if (!landmarks || landmarks.length < 13) {
    return { ok: false, reason: "no-body" };
  }

  const p = (i) => toAspectSpace(landmarks[i], aspect);
  const shL = p(LM.shoulderL);
  const shR = p(LM.shoulderR);
  const earL = p(LM.earL);
  const earR = p(LM.earR);
  const eyeL = p(LM.eyeL);
  const eyeR = p(LM.eyeR);

  if (shL.v < CALIBRATION.minShoulderVisibility || shR.v < CALIBRATION.minShoulderVisibility) {
    return { ok: false, reason: "shoulders-out-of-frame" };
  }
  if (earL.v < CALIBRATION.minEarVisibility && earR.v < CALIBRATION.minEarVisibility) {
    return { ok: false, reason: "head-not-visible" };
  }

  const shoulderW = dist(shL, shR);
  if (shoulderW < CALIBRATION.minShoulderWidthFrac * aspect) {
    return { ok: false, reason: "too-far-from-camera" };
  }

  const shoulderMid = mid(shL, shR);
  const earMid = mid(earL, earR);
  const eyeMid = mid(eyeL, eyeR);

  /**
   * Yaw guard. Turning your head shortens the visible ear-to-ear span while
   * the shoulders stay put. Without this, glancing at a second monitor reads
   * as a posture fault — the single most common false positive in this class
   * of tool.
   */
  const earSpan = dist(earL, earR);
  const yawIndex = clamp(earSpan / (shoulderW * 0.42), 0, 1.4);
  const turned = yawIndex < 0.62;

  return {
    ok: true,
    metrics: {
      /** Head height above the shoulder line, as a fraction of shoulder width. */
      neckRatio: (shoulderMid.y - earMid.y) / shoulderW,
      /** Head offset from the shoulder midline. Positive = drifted right. */
      lateralRatio: (earMid.x - shoulderMid.x) / shoulderW,
      headTiltDeg: angleDeg(earR, earL),
      shoulderTiltDeg: angleDeg(shR, shL),
      /** Raw scale. Only ever used as a ratio against the baseline. */
      shoulderW,
      eyeY: eyeMid.y,
      yawIndex,
      turned,
      confidence: Math.min(shL.v, shR.v)
    },
    /** Kept for the preview overlay only. */
    points: { shL, shR, earL, earR, earMid, shoulderMid }
  };
}

/* ------------------------------------------------------------ calibration */

/**
 * The baseline is the whole product. "Sit the way you want to sit for the next
 * hour" beats any population average, because posture quality is personal and
 * webcam geometry is not portable.
 *
 * Median, not mean: a single frame where you reached for a mug should not move
 * the reference you will be judged against for the next two hours.
 */
export function buildBaseline(samples) {
  if (samples.length < CALIBRATION.minSamples) {
    return { ok: false, reason: "not-enough-samples", got: samples.length };
  }

  const median = (key) => {
    const v = samples.map((s) => s[key]).sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  const spread = (key, med) => {
    const devs = samples.map((s) => Math.abs(s[key] - med)).sort((a, b) => a - b);
    return devs[Math.floor(devs.length / 2)]; // median absolute deviation
  };

  const neckRatio = median("neckRatio");

  // If you fidgeted through calibration the baseline is meaningless, and a
  // meaningless baseline produces confident nonsense for hours. Refuse it.
  const stability = spread("neckRatio", neckRatio) / Math.abs(neckRatio || 1);
  if (stability > 0.12) {
    return { ok: false, reason: "too-much-movement", stability };
  }

  return {
    ok: true,
    baseline: {
      neckRatio,
      lateralRatio: median("lateralRatio"),
      headTiltDeg: median("headTiltDeg"),
      shoulderTiltDeg: median("shoulderTiltDeg"),
      shoulderW: median("shoulderW"),
      capturedAt: Date.now(),
      samples: samples.length
    }
  };
}

/* --------------------------------------------------------------- scoring */

/**
 * Convert a frame's metrics into deviation units against the baseline.
 * 0 = exactly as calibrated. 1.0 = at the edge of tolerance. >1 = out of range.
 *
 * The composite is the *worst* component, not an average. Averaging lets a
 * perfect shoulder line hide a collapsing neck, which is precisely the failure
 * mode the tool exists to catch. Taking the max also means the UI can always
 * name the specific thing that is wrong.
 */
export function score(metrics, baseline) {
  const components = {
    slump: posOnly(
      (baseline.neckRatio - metrics.neckRatio) / (Math.abs(baseline.neckRatio) * TOLERANCE.slumpFrac)
    ),
    lean: Math.abs(metrics.lateralRatio - baseline.lateralRatio) / TOLERANCE.leanFrac,
    headTilt: Math.abs(metrics.headTiltDeg - baseline.headTiltDeg) / TOLERANCE.headTiltDeg,
    shoulderTilt:
      Math.abs(metrics.shoulderTiltDeg - baseline.shoulderTiltDeg) / TOLERANCE.shoulderTiltDeg,
    proximity: posOnly(
      (metrics.shoulderW / baseline.shoulderW - 1) / TOLERANCE.proximityFrac
    )
  };

  /**
   * A turned head invalidates the three metrics that depend on seeing both
   * ears. Zero them rather than let them fire. Shoulder tilt survives, because
   * it does not involve the head at all.
   */
  if (metrics.turned) {
    components.slump = 0;
    components.lean = 0;
    components.headTilt = 0;
  }

  let worst = "slump";
  let deviation = 0;
  for (const [key, raw] of Object.entries(components)) {
    const weighted = raw * WEIGHTS[key];
    if (weighted > deviation) {
      deviation = weighted;
      worst = key;
    }
  }

  return {
    deviation,
    worst,
    components,
    /** Relative distance change. 1.08 = you crept 8% closer to the screen. */
    proximity: metrics.shoulderW / baseline.shoulderW
  };
}

const posOnly = (v) => Math.max(0, v);

export function deviationToScore(deviation) {
  return Math.round(clamp(100 - SCORING.pointsPerDeviation * deviation, 0, 100));
}

export function stateFor(deviation) {
  if (deviation >= SCORING.alertAt) return "ALERT";
  if (deviation >= SCORING.driftAt) return "DRIFT";
  return "NOMINAL";
}

/**
 * Single-point distance estimate. Honest version: we know the shoulder width in
 * frame at a distance you told us, so we can report *changes* around it. The
 * number is only as good as the reference you gave, and the UI says so.
 */
export function estimateDistanceCm(proximity, referenceCm) {
  if (!proximity || !Number.isFinite(proximity)) return null;
  return Math.round(referenceCm / proximity);
}

/** Exponential moving average, used to smooth deviation across frames. */
export function ema(previous, next, alpha = SCORING.emaAlpha) {
  return previous == null ? next : previous + alpha * (next - previous);
}

export const REASON_COPY = {
  "no-body": "No one in frame",
  "shoulders-out-of-frame": "Your shoulders need to be in frame",
  "head-not-visible": "Can't see your head clearly",
  "too-far-from-camera": "You're too far from the camera to measure"
};

export const COMPONENT_COPY = {
  slump: {
    label: "Head dropping",
    fix: "Your head has sunk toward your shoulders. Lengthen the back of your neck."
  },
  lean: {
    label: "Leaning off-centre",
    fix: "You've drifted to one side. Bring your head back over your shoulders."
  },
  headTilt: {
    label: "Head tilted",
    fix: "Your head is cocked to one side. Level your eyeline."
  },
  shoulderTilt: {
    label: "Shoulders uneven",
    fix: "One shoulder is riding higher. Drop them both and square up."
  },
  proximity: {
    label: "Creeping toward the screen",
    fix: "You've moved closer than you started. Sit back to where you calibrated."
  }
};
