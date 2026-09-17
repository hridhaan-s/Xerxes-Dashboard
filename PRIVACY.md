# Privacy policy — Xerxes

Last updated: 17 September 2026

## What this extension collects

Nothing. No personal data, no browsing history, no page content, no camera
access, no analytics, no network requests to any server.

## What it stores, and where

Two things, both local to your browser:

1. **Settings** (`chrome.storage.sync`) — whether alerts are on, the minimum gap
   between alerts, whether the break card is enabled. Chrome may sync these
   across your own signed-in Chrome profiles. That sync is handled by Google,
   not by us, and carries no identifying information.
2. **Live session state** (`chrome.storage.session`) — the current posture state
   and timestamps. Erased when Chrome closes.

## What it can see

The content script runs only on the Xerxes dashboard origin. It reads a single
structured message from that page containing a posture state label and a numeric
score. It does not read the page's content and is not injected anywhere else.

The optional break-card feature requires permission to draw on any site. It is
requested only when you switch the feature on, revoked when you switch it off,
and used only to render a countdown card. It does not read the page.

## Camera

The camera is used by the Xerxes dashboard website, not by this extension. Video
frames are processed in your browser and are never uploaded or recorded.

## Third parties

None. No data is sold, shared, or transmitted.

## Contact

Open an issue on the GitHub repository.
