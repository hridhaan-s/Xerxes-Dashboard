# Xerxes — dashboard

Desk posture, measured against a baseline you set yourself, entirely in the
browser. This repo is the measurement half. The
[extension](https://github.com/hridhaan-s/Xerxes-) is the alerting half.

Live: <https://xerxes.bitbuzz.app/>

---

## What it measures, honestly

A webcam sees you from the front. Four things are genuinely measurable from that
angle, and this tool measures exactly those four:

| Metric | Definition | Catches |
|---|---|---|
| Head height | Ear midpoint to shoulder midpoint, ÷ shoulder width | Head sinking into the shoulders |
| Lateral drift | Head offset from the shoulder midline, ÷ shoulder width | Leaning onto one elbow |
| Head roll | Angle of the ear-to-ear line | Cocked head, phone-on-shoulder posture |
| Shoulder roll | Angle of the shoulder line | One shoulder riding high |
| Proximity | Shoulder width now ÷ shoulder width at calibration | Creeping toward the screen |

**What it does not measure, and does not claim to:** lumbar curve, true
cervical angle, and absolute distance in centimetres. A frontal camera cannot
see any of them. The distance readout is anchored to one number you supply, and
the interface says so next to the input.

Every quantity above is either an angle or a ratio against your own shoulder
width. Nothing is in pixels, which is why the same body produces the same
numbers on a 480p laptop camera and a 1080p external one.

### Calibration is the product

Nothing is scored before you calibrate. Six seconds of sitting how you intend to
sit, reduced to a per-metric median — medians, so one frame where you reached for
a mug does not move the reference you are judged against for the next two hours.

If you moved too much during those six seconds, calibration is **rejected**. A
meaningless baseline produces confident nonsense, which is worse than no tool.

### Things that are deliberately not faults

- **Turning your head.** Head metrics suspend while you are turned. Glancing at a
  second monitor is not a posture failure, and treating it as one is the most
  common way tools in this category lose trust in week one.
- **Leaving your desk.** Scoring pauses. An empty chair is not good posture.

---

## The part nobody copies

Every posture widget answers "are you slouching right now," which you already
know, because it is your body.

Xerxes stores every session locally and answers a question you cannot answer
yourself: **when does your posture give out?** Average deviation against minutes
into a session, pooled across your history, plus which fault dominates. After a
handful of sessions you get lines like:

> Your posture typically goes out of range about 42 minutes into a session.
> Head dropping accounts for 59% of your drift.

That is an argument for a 40-minute work block, backed by your own data.

---

## Running it

The camera requires a secure context, so `file:///` will not work. Any static
host over HTTPS will.

```bash
# local
python3 -m http.server 8123     # then open http://localhost:8123
```

`localhost` counts as a secure context, so the camera works in development.

**Deploy:** drop the folder on Vercel, Netlify, or GitHub Pages. There is no
build step and no dependencies to install. `vercel.json` sets a
`Permissions-Policy` header allowing camera access from this origin only.

---

## Architecture

```
index.html
assets/css/xerxes.css
assets/js/
  config.js        Every threshold and tolerance, in one file
  metrics.js       Pose landmarks -> scale-free metrics -> deviation
  tracker.js       Camera, model, and the two sampling loops
  timer.worker.js  Worker-driven tick for hidden tabs
  alerts.js        Dwell / cooldown / escalation state machine, audio
  store.js         IndexedDB: baseline, prefs, sessions, aggregates
  charts.js        Live trace (canvas), history and collapse curve (SVG)
  bridge.js        Page side of the extension protocol
  app.js           Wiring, calibration flow, session lifecycle
```

No framework, no chart library, no build step. One runtime dependency:
`@mediapipe/tasks-vision`, pinned to `0.10.14` rather than `@latest`, because a
silent upstream bump should not be able to break a page that is telling someone
their posture is fine.

### Foreground and background sampling

`requestAnimationFrame` stops entirely in a hidden tab. v1 drove its whole loop
off it, so tracking died the moment you tabbed away — the exact situation the
product exists for.

This version samples at 12 Hz via rAF when visible, and switches to a
worker-driven 1 Hz tick when hidden. A live `MediaStream` keeps decoding in a
hidden tab, so inference still works; only the scheduling needed replacing. Posture
changes over seconds, so 1 Hz loses nothing.

**Limit worth stating plainly:** Chrome can still discard a background tab under
memory pressure. When that happens the extension's watchdog tells you tracking
stopped rather than leaving you to assume it is running.

---

## Privacy

Video frames are processed by WebAssembly in your tab. They are never uploaded,
recorded, or sent anywhere — there is no server to send them to. The pose model
is fetched once from a public CDN; after that the page works offline.

Sessions and calibration live in IndexedDB in this browser. **Export data**
writes the lot to a JSON file. **Delete everything** removes it.

---

## Roadmap, in order of actual value

1. Side-profile calibration via a phone camera, which would make cervical angle
   genuinely measurable instead of proxied.
2. Per-time-of-day breakdown — posture at 9am against posture at 11pm.
3. A weekly digest of the collapse curve.

MIT licensed. Built by Hridhaan.
