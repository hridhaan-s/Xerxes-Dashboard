/**
 * Drawing. Canvas for the live trace (it repaints constantly), inline SVG for
 * the history charts (they are static, accessible and scale crisply).
 *
 * No chart library. Three chart types, each with a specific job, is less code
 * than configuring a general-purpose one — and it keeps the page dependency-free
 * apart from the pose model itself.
 */

const INK = {
  paper: "#0e1013",
  grid: "#1b1e23",
  band: "rgba(92, 156, 127, 0.10)",
  bandLine: "#2c4c3e",
  nominal: "#e8e6e1",
  drift: "#e3b23c",
  alert: "#d9524a",
  muted: "#6b7078"
};

/* -------------------------------------------------------------- live trace */

/**
 * A chart recorder. Deviation scrolls right to left; the shaded band is your
 * tolerance. The value of drawing it this way rather than as a number is that
 * you can see a slow slide coming ten seconds before it trips.
 */
export class Trace {
  constructor(canvas, { windowSec = 180 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.windowSec = windowSec;
    this.points = [];
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  push(deviation, at = Date.now()) {
    this.points.push({ d: deviation, at });
    const cutoff = at - this.windowSec * 1000;
    while (this.points.length && this.points[0].at < cutoff) this.points.shift();
    this.draw();
  }

  clear() {
    this.points = [];
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);

    // Scale: 0 at the bottom, 2.0 deviation at the top.
    const maxDev = 2;
    const y = (d) => h - (Math.min(d, maxDev) / maxDev) * h;

    // Tolerance band: everything under 1.0 is acceptable.
    ctx.fillStyle = INK.band;
    ctx.fillRect(0, y(1), w, h - y(1));
    ctx.strokeStyle = INK.bandLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(1) + 0.5);
    ctx.lineTo(w, y(1) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // Minute gridlines, so the window has a sense of time.
    ctx.strokeStyle = INK.grid;
    for (let s = 60; s < this.windowSec; s += 60) {
      const x = w - (s / this.windowSec) * w;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    if (this.points.length < 2) return;

    const now = Date.now();
    const xFor = (at) => w - ((now - at) / (this.windowSec * 1000)) * w;

    // Draw in segments so colour can change with state mid-trace.
    let prev = this.points[0];
    for (let i = 1; i < this.points.length; i += 1) {
      const point = this.points[i];
      ctx.strokeStyle = point.d >= 1 ? INK.alert : point.d >= 0.7 ? INK.drift : INK.nominal;
      ctx.lineWidth = point.d >= 1 ? 1.8 : 1.3;
      ctx.beginPath();
      ctx.moveTo(xFor(prev.at), y(prev.d));
      ctx.lineTo(xFor(point.at), y(point.d));
      ctx.stroke();
      prev = point;
    }

    // Live head.
    const last = this.points[this.points.length - 1];
    ctx.fillStyle = last.d >= 1 ? INK.alert : last.d >= 0.7 ? INK.drift : INK.nominal;
    ctx.beginPath();
    ctx.arc(xFor(last.at), y(last.d), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ------------------------------------------------------------ pose preview */

/**
 * Draws only the four landmarks the scoring actually uses, plus a ghost of the
 * calibrated baseline. v1 drew all 468 face points, which looked impressive and
 * told the user nothing about why they were being warned.
 */
export function drawPreview(canvas, video, points, baseline, state) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1); // mirror: people expect to see themselves, not a stranger
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  ctx.fillStyle = "rgba(10,11,13,0.55)";
  ctx.fillRect(0, 0, w, h);

  if (!points) return;

  const aspect = video.videoWidth / video.videoHeight || 4 / 3;
  const px = (p) => ({ x: w - (p.x / aspect) * w, y: p.y * h }); // mirrored

  const shL = px(points.shL);
  const shR = px(points.shR);
  const earMid = px(points.earMid);
  const shoulderMid = px(points.shoulderMid);

  const colour = state === "ALERT" ? INK.alert : state === "DRIFT" ? INK.drift : INK.nominal;

  // Baseline ghost: where your head sat when you calibrated.
  if (baseline) {
    const shoulderW = Math.hypot(shL.x - shR.x, shL.y - shR.y);
    const ghostY = shoulderMid.y - baseline.neckRatio * shoulderW;
    const ghostX = shoulderMid.x + baseline.lateralRatio * shoulderW * (shL.x > shR.x ? -1 : 1);
    ctx.strokeStyle = "rgba(232,230,225,0.35)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(ghostX, ghostY, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.6;

  // Shoulder line.
  ctx.beginPath();
  ctx.moveTo(shL.x, shL.y);
  ctx.lineTo(shR.x, shR.y);
  ctx.stroke();

  // Spine reference: shoulder midpoint up to the head.
  ctx.beginPath();
  ctx.moveTo(shoulderMid.x, shoulderMid.y);
  ctx.lineTo(earMid.x, earMid.y);
  ctx.stroke();

  for (const p of [shL, shR, earMid]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* --------------------------------------------------------- history charts */

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Recent sessions as a lollipop chart: height = alignment score, dot = alerts. */
export function renderHistory(container, sessions) {
  container.replaceChildren();

  const recent = sessions.slice(0, 14).reverse();
  if (recent.length < 1) {
    container.append(emptyState("Your first finished session will appear here."));
    return;
  }

  const w = 100;
  const h = 44;
  const pad = 3;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `Alignment score across your last ${recent.length} sessions`
  });
  svg.classList.add("chart-svg");

  const step = (w - pad * 2) / Math.max(recent.length, 1);

  recent.forEach((session, i) => {
    const x = pad + step * (i + 0.5);
    const value = session.score ?? 0;
    const y = h - pad - ((h - pad * 2) * value) / 100;

    svg.append(
      svgEl("line", {
        x1: x, x2: x, y1: h - pad, y2: y,
        stroke: value >= 70 ? INK.nominal : value >= 45 ? INK.drift : INK.alert,
        "stroke-width": 0.9,
        "stroke-linecap": "round",
        opacity: 0.85
      })
    );
    svg.append(
      svgEl("circle", {
        cx: x, cy: y, r: session.alerts > 0 ? 1.7 : 1.1,
        fill: value >= 70 ? INK.nominal : value >= 45 ? INK.drift : INK.alert
      })
    );
  });

  svg.append(
    svgEl("line", {
      x1: pad, x2: w - pad, y1: h - pad, y2: h - pad,
      stroke: INK.grid, "stroke-width": 0.4
    })
  );

  container.append(svg);
}

/**
 * The collapse curve: how far your posture drifts as a function of how long you
 * have been sitting, pooled across every session you have recorded.
 */
export function renderCollapseCurve(container, curve) {
  container.replaceChildren();

  if (!curve.length) {
    container.append(
      emptyState("Needs a few sessions before a pattern is worth showing.")
    );
    return;
  }

  const w = 100;
  const h = 44;
  const pad = 4;
  const maxMin = Math.max(...curve.map((c) => c.minute), 30);
  const maxDev = Math.max(1.3, ...curve.map((c) => c.deviation));

  const x = (m) => pad + ((w - pad * 2) * m) / maxMin;
  const y = (d) => h - pad - ((h - pad * 2) * d) / maxDev;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": "Average posture deviation against minutes into a session"
  });
  svg.classList.add("chart-svg");

  // Tolerance line at deviation 1.0.
  svg.append(
    svgEl("line", {
      x1: pad, x2: w - pad, y1: y(1), y2: y(1),
      stroke: INK.bandLine, "stroke-width": 0.5, "stroke-dasharray": "1.5 1.5"
    })
  );

  const d = curve.map((c, i) => `${i ? "L" : "M"}${x(c.minute).toFixed(2)} ${y(c.deviation).toFixed(2)}`).join(" ");

  svg.append(
    svgEl("path", {
      d: `${d} L${x(curve[curve.length - 1].minute)} ${h - pad} L${x(curve[0].minute)} ${h - pad} Z`,
      fill: "rgba(227,178,60,0.10)"
    })
  );
  svg.append(svgEl("path", { d, fill: "none", stroke: INK.drift, "stroke-width": 1 }));

  curve.forEach((c) => {
    svg.append(svgEl("circle", { cx: x(c.minute), cy: y(c.deviation), r: 0.9, fill: INK.drift }));
  });

  container.append(svg);
}

function emptyState(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}
