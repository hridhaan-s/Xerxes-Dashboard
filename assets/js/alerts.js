/**
 * When to interrupt a human being.
 *
 * v1 beeped every second frame while out of range — roughly fifteen tones a
 * second. This version requires the fault to persist for a dwell period, fires
 * once, then stays quiet for a cooldown, escalating only if you have ignored it
 * for minutes. The goal is to be believed, not to be loud.
 */

import { ALERTS, SCORING } from "./config.js";

/** One AudioContext for the page lifetime. Constructing one per tone hits
 *  Chrome's hardware-context cap in seconds and then audio dies silently. */
let audioCtx = null;

function context() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/** Autoplay policy: must be called from a user gesture, once. */
export async function unlockAudio() {
  const ctx = context();
  if (ctx && ctx.state === "suspended") await ctx.resume();
}

/**
 * A short two-tone figure with an envelope. A raw square-edged sine produces an
 * audible click at both ends; the ramp is the difference between "signal" and
 * "something broke".
 */
export function tone({ hz = ALERTS.toneHz, ms = ALERTS.toneMs, gain = 0.06, firm = false } = {}) {
  const ctx = context();
  if (!ctx || ctx.state !== "running") return;

  const play = (frequency, startOffset, duration) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const t0 = ctx.currentTime + startOffset;

    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, t0);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration / 1000);

    osc.connect(env).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration / 1000 + 0.05);
  };

  play(hz, 0, ms);
  if (firm) play(hz * 0.75, ms / 1000 + 0.06, ms);
}

/**
 * The alert state machine.
 *
 * NOMINAL ──deviation≥1.0──> PENDING ──held for dwellSec──> FIRED
 *    ^                          │                             │
 *    └──────deviation<0.7───────┴────────────────────────────┘
 */
export class AlertEngine extends EventTarget {
  constructor(prefs) {
    super();
    this.prefs = prefs;
    this.reset();
  }

  reset() {
    this.phase = "NOMINAL";
    this.outOfRangeSince = null;
    this.lastFiredAt = 0;
    this.firedInCurrentFault = 0;
    this.snoozedUntil = 0;
    this.alertCount = 0;
  }

  snooze(minutes) {
    this.snoozedUntil = Date.now() + minutes * 60_000;
    this.phase = "NOMINAL";
    this.outOfRangeSince = null;
  }

  clearSnooze() {
    this.snoozedUntil = 0;
  }

  get snoozed() {
    return Date.now() < this.snoozedUntil;
  }

  /**
   * @param {number} deviation  smoothed deviation in tolerance units
   * @param {string} worst      component key driving it
   */
  update(deviation, worst) {
    const now = Date.now();

    if (deviation < SCORING.driftAt) {
      // Recovered. Reset the fault entirely so the next one starts clean.
      this.phase = "NOMINAL";
      this.outOfRangeSince = null;
      this.firedInCurrentFault = 0;
      return null;
    }

    if (deviation < SCORING.alertAt) {
      this.phase = "DRIFT";
      return null;
    }

    if (this.outOfRangeSince === null) this.outOfRangeSince = now;
    const heldSec = (now - this.outOfRangeSince) / 1000;

    if (heldSec < ALERTS.dwellSec) {
      this.phase = "PENDING";
      return null;
    }

    if (this.snoozed) return null;

    const sinceLast = (now - this.lastFiredAt) / 1000;
    const needed = this.firedInCurrentFault === 0
      ? ALERTS.localCooldownSec
      : ALERTS.escalationSec;

    if (this.lastFiredAt && sinceLast < needed) return null;

    this.phase = "FIRED";
    this.lastFiredAt = now;
    this.firedInCurrentFault += 1;
    this.alertCount += 1;

    const alert = {
      worst,
      deviation,
      heldSec: Math.round(heldSec),
      escalated: this.firedInCurrentFault > 1
    };

    if (this.prefs.soundEnabled) {
      tone({ firm: alert.escalated, gain: alert.escalated ? 0.08 : 0.06 });
    }

    this.dispatchEvent(new CustomEvent("alert", { detail: alert }));
    return alert;
  }
}

/**
 * Break timer. Separate from posture on purpose: eyes need a break at 30
 * minutes whether or not your spine is behaving.
 */
export class BreakTimer extends EventTarget {
  constructor(workMin) {
    super();
    this.workMin = workMin;
    this.elapsedMs = 0;
    this.fired = 0;
  }

  tick(deltaMs) {
    this.elapsedMs += deltaMs;
    const due = this.workMin * 60_000 * (this.fired + 1);
    if (this.elapsedMs >= due) {
      this.fired += 1;
      this.dispatchEvent(
        new CustomEvent("break", { detail: { number: this.fired, atMin: this.workMin * this.fired } })
      );
      return true;
    }
    return false;
  }

  reset() {
    this.elapsedMs = 0;
    this.fired = 0;
  }

  get untilNextMs() {
    return Math.max(0, this.workMin * 60_000 * (this.fired + 1) - this.elapsedMs);
  }
}
