/**
 * A timer that lives in a worker.
 *
 * Why: requestAnimationFrame stops entirely when a tab is hidden, and v1 drove
 * the whole capture loop off it. That meant tracking died the moment you tabbed
 * away — the exact situation the product exists for.
 *
 * A worker timer is not immune to throttling either, but it keeps ticking in a
 * hidden tab where rAF gives you nothing, and the main thread reports every tick
 * it actually receives so the UI can tell the truth about sample rate.
 */

let handle = null;

self.onmessage = (e) => {
  const { command, intervalMs } = e.data || {};

  if (command === "start") {
    if (handle) clearInterval(handle);
    handle = setInterval(() => self.postMessage({ tick: Date.now() }), intervalMs || 1000);
  }

  if (command === "stop") {
    clearInterval(handle);
    handle = null;
  }
};
