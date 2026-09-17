/**
 * Page side of the extension bridge.
 *
 * The dashboard is fully functional without the extension — it just cannot
 * reach you once you tab away. The UI states that plainly rather than pretending
 * everything is fine, which is what v1 did.
 */

const PROTOCOL_VERSION = 2;

export class Bridge extends EventTarget {
  constructor() {
    super();
    this.connected = false;
    this.lastState = null;

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;

      const data = event.data;
      if (!data || data.source !== "xerxes-ext" || data.v !== PROTOCOL_VERSION) return;

      if (data.type === "BRIDGE_READY" && !this.connected) {
        this.connected = true;
        this.dispatchEvent(new CustomEvent("connected"));
      }

      if (data.type === "COMMAND") {
        this.dispatchEvent(new CustomEvent("command", { detail: data.command }));
      }
    });

    // The content script may have loaded before us, or not at all.
    this.ping();
    setTimeout(() => this.ping(), 400);
    setTimeout(() => {
      if (!this.connected) this.dispatchEvent(new CustomEvent("unavailable"));
    }, 1500);
  }

  ping() {
    this.post("BRIDGE_PING", {});
  }

  post(type, payload) {
    window.postMessage(
      { source: "xerxes", v: PROTOCOL_VERSION, type, payload },
      window.location.origin
    );
  }

  sessionStart() {
    this.post("SESSION_START", {});
  }

  sessionEnd(score, summary) {
    this.post("SESSION_END", { score, summary });
  }

  /** Only sent on transition. Posting every frame floods the worker for nothing. */
  state(state, score) {
    if (state === this.lastState) return;
    this.lastState = state;
    this.post("STATE", { state, score });
  }

  /** Heartbeat so the extension watchdog knows tracking is alive. */
  heartbeat(state, score) {
    this.post("STATE", { state, score });
  }

  alert({ title, body, kind, seconds }) {
    this.post("ALERT", { title, body, kind, seconds });
  }
}
