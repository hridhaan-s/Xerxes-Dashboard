/**
 * Camera, model, and the sampling loop.
 *
 * Two loops, chosen by document visibility:
 *   visible → requestAnimationFrame, throttled to CAPTURE.visibleFps
 *   hidden  → a worker-driven interval at 1 Hz
 *
 * The <video> element keeps decoding a live MediaStream while the tab is
 * hidden, so drawing and inference still work; only the *scheduling* needs
 * replacing. Posture changes on a timescale of seconds, so 1 Hz loses nothing
 * that matters.
 */

import { CDN, CAPTURE } from "./config.js";
import { readFrame } from "./metrics.js";

export class Tracker extends EventTarget {
  constructor() {
    super();
    this.video = null;
    this.stream = null;
    this.landmarker = null;
    this.worker = null;
    this.running = false;
    this.rafHandle = null;
    this.lastInferenceAt = 0;
    this.lastSampleAt = 0;
    this.frameCount = 0;
    this._onVisibility = this._onVisibility.bind(this);
  }

  /** Load the wasm fileset and pose model. Slow, so it is done once, up front. */
  async load() {
    this.emit("loading", { stage: "runtime" });
    const { FilesetResolver, PoseLandmarker } = await import(
      /* @vite-ignore */ `${CDN.tasksVision}/vision_bundle.mjs`
    );

    const fileset = await FilesetResolver.forVisionTasks(CDN.wasm);

    this.emit("loading", { stage: "model" });
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CDN.poseModel, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    }).catch(async (gpuError) => {
      // Integrated graphics and locked-down machines fail GPU delegation.
      console.warn("[xerxes] GPU delegate unavailable, falling back to CPU", gpuError);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CDN.poseModel, delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: 1
      });
    });

    this.emit("loaded", {});
  }

  async startCamera(videoEl) {
    this.video = videoEl;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CAPTURE.width },
        height: { ideal: CAPTURE.height },
        facingMode: "user"
      },
      audio: false
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    // Chrome can revoke the camera from the address bar mid-session.
    this.stream.getVideoTracks()[0].addEventListener("ended", () => {
      this.stop();
      this.emit("camera-lost", {});
    });

    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.addEventListener("loadeddata", resolve, { once: true });
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastSampleAt = Date.now();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._route();
  }

  stop() {
    this.running = false;
    document.removeEventListener("visibilitychange", this._onVisibility);
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this._stopWorker();
  }

  /** Full teardown: also releases the camera so the browser indicator goes out. */
  release() {
    this.stop();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /* --------------------------------------------------------- loop routing */

  _onVisibility() {
    if (!this.running) return;
    this._route();
    this.emit("visibility", { hidden: document.hidden });
  }

  _route() {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this._stopWorker();

    if (document.hidden) this._startWorkerLoop();
    else this._startRafLoop();
  }

  _startRafLoop() {
    const minGap = 1000 / CAPTURE.visibleFps;
    const step = () => {
      if (!this.running || document.hidden) return;
      const now = performance.now();
      if (now - this.lastInferenceAt >= minGap) {
        this.lastInferenceAt = now;
        this._infer();
      }
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  _startWorkerLoop() {
    if (!this.worker) {
      this.worker = new Worker(new URL("./timer.worker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = () => {
        if (this.running && document.hidden) this._infer();
      };
    }
    this.worker.postMessage({ command: "start", intervalMs: CAPTURE.hiddenIntervalMs });
  }

  _stopWorker() {
    if (this.worker) this.worker.postMessage({ command: "stop" });
  }

  /* ------------------------------------------------------------ inference */

  _infer() {
    if (!this.landmarker || !this.video || this.video.readyState < 2) return;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, performance.now());
    } catch (err) {
      console.warn("[xerxes] inference failed", err);
      return;
    }

    this.frameCount += 1;
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    const landmarks = result?.landmarks?.[0];
    const read = readFrame(landmarks, aspect);

    this.lastSampleAt = Date.now();
    this.emit("sample", {
      ok: read.ok,
      reason: read.reason,
      metrics: read.metrics,
      points: read.points,
      hidden: document.hidden,
      at: this.lastSampleAt
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
