# PRANVAYU Dashboard — Web Developer Handoff Guide

You are building a small control panel for a solar-powered pond aerator in Budhiganga. An ESP32 in the field and your website both talk to the **same Firebase Realtime Database (RTDB)** — the database *is* the API. There is no backend server to build. Your page just listens to a few paths and writes to a few paths; Firebase pushes every change to both sides over websockets in a few hundred milliseconds.

A complete working reference implementation is included as `dashboard/index.html` — you can ship it as-is, restyle it, or rebuild it in React/Vue. This document is the contract you must not break.

---

## 1. The data contract (read this twice)

Everything lives under `/aerator`. The golden rule: **the website writes only to `/aerator/control`; the ESP32 writes only to `/aerator/status` and `/aerator/security`.** Never write to status/security from the web.

| Path | Type | Written by | Meaning |
|---|---|---|---|
| `/aerator/control/mode` | string | website | `"manual"` or `"schedule"` — who decides the motor state |
| `/aerator/control/manualOn` | boolean | website | Desired motor state when mode is manual |
| `/aerator/control/schedule/start` | string | website | `"HH:MM"` 24-hour, Nepal time (e.g. `"18:00"`) |
| `/aerator/control/schedule/end` | string | website | `"HH:MM"` — window may cross midnight (`"20:00"`→`"06:00"` is valid) |
| `/aerator/control/alarmArmed` | boolean | website | Theft protection on/off |
| `/aerator/status/temperature` | number | ESP32 | Water temperature °C, updates every ~15 s |
| `/aerator/status/motorOn` | boolean | ESP32 | **Actual** motor state (ground truth) |
| `/aerator/status/rssi` | number | ESP32 | WiFi signal dBm (nice-to-have display) |
| `/aerator/status/clockSynced` | boolean | ESP32 | Whether the device has NTP time (schedule reliability) |
| `/aerator/status/lastSeen` | number | ESP32 | Server timestamp (ms) heartbeat, every 15 s |
| `/aerator/security/alert` | boolean | ESP32 | Theft alarm currently latched |
| `/aerator/security/lastAlertAt` | number | ESP32 | Server timestamp (ms) of last alarm |

**Desired vs actual — the key UX concept.** `control/manualOn` is what the user *asked for*; `status/motorOn` is what the pump is *actually doing*. Bind the toggle switch to `control/manualOn`, but bind the big "PUMP RUNNING / STOPPED" indicator to `status/motorOn`. When the user taps the toggle, the indicator will follow ~0.5–1.5 s later once the ESP32 confirms — that visible confirmation loop is exactly the "proper synchronization" the project needs, and it honestly shows judges the round trip.

`schedule/start` / `end` map perfectly to `<input type="time">`, which already yields `"HH:MM"` strings. Validate before writing: must match `/^\d{2}:\d{2}$/`.

---

## 2. Firebase project access

Chandan will send you the `firebaseConfig` object from the Firebase console (Project settings → Your apps), plus a login email/password for the dashboard. The database rules require authentication (`auth != null`), so the page must sign in before any data flows. Do **not** hardcode the login password into the public page — show a small login form (the reference implementation includes one).

---

## 3. SDK setup (use the current modular SDK, v12+)

No build tools needed — the modular SDK loads straight from Google's CDN as an ES module. Current version is 12.x; pin whatever version the console snippet gives you.

```html
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged }
        from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getDatabase, ref, onValue, update, set, serverTimestamp }
        from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

const firebaseConfig = { /* paste the object Chandan sends you */ };
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);
</script>
```

If you prefer React/Vite, `npm install firebase` gives the identical API with `import ... from "firebase/database"`.

---

## 4. Reading — always `onValue`, never polling

`onValue` opens one websocket and pushes every change instantly. Attach listeners once after login; never `setInterval` + `get()`.

```js
onAuthStateChanged(auth, (user) => {
  if (!user) return;               // show login form

  onValue(ref(db, "aerator/status"), (snap) => {
    const s = snap.val() ?? {};
    tempEl.textContent  = s.temperature?.toFixed?.(1) ?? "--";
    pumpEl.textContent  = s.motorOn ? "RUNNING" : "STOPPED";
    lastSeenMs          = s.lastSeen ?? 0;   // for the online pill, see §6
  });

  onValue(ref(db, "aerator/control"), (snap) => {
    const c = snap.val() ?? {};
    modeInput.value      = c.mode ?? "manual";
    manualToggle.checked = !!c.manualOn;
    startInput.value     = c.schedule?.start ?? "18:00";
    endInput.value       = c.schedule?.end   ?? "22:00";
    armToggle.checked    = !!c.alarmArmed;
  });

  onValue(ref(db, "aerator/security/alert"), (snap) => {
    alertBanner.hidden = !snap.val();
  });
});
```

Important detail: your own controls must also be driven by the `control` listener (as above), not only by local state. Then if Chandan flips something from the Firebase console, another phone, or a second browser tab, every screen stays in sync automatically — that's the demo moment.

---

## 5. Writing — `update()` on the control node

Use `update()` (a patch) so you only touch the fields that changed. The ESP32's live stream handles both patches and single-value sets.

```js
// Manual switch
manualToggle.onchange = () =>
  update(ref(db, "aerator/control"), { mode: "manual", manualOn: manualToggle.checked });

// Mode selector
modeInput.onchange = () =>
  update(ref(db, "aerator/control"), { mode: modeInput.value }); // "manual" | "schedule"

// Save schedule (validate first!)
saveScheduleBtn.onclick = () => {
  const start = startInput.value, end = endInput.value;   // "HH:MM" from <input type="time">
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return alert("Pick both times");
  update(ref(db, "aerator/control"), { mode: "schedule", schedule: { start, end } });
};

// Arm / disarm theft protection (disarming also silences + clears an active alarm)
armToggle.onchange = () =>
  update(ref(db, "aerator/control"), { alarmArmed: armToggle.checked });
```

Setting the manual switch also forces `mode: "manual"`, and saving a schedule forces `mode: "schedule"` — this matches what users expect ("I pressed ON, so it should turn on") and avoids a confusing hidden mode state. Keep that behavior.

**Optimistic UI + confirmation:** flip the toggle immediately (it's the user's own action), but reflect *actual* pump state only from `status/motorOn`. Optionally grey-out/spin the pump indicator until it matches the requested state, with a 5-second timeout message ("device not responding — check it's online").

---

## 6. Device online/offline indicator

The ESP32 heartbeats `status/lastSeen` (server timestamp) every 15 s. Consider the device **online** if `lastSeen` is fresher than 45 s. Recompute every few seconds on a timer *and* whenever the listener fires:

```js
function refreshOnlinePill() {
  const online = lastSeenMs && (Date.now() - lastSeenMs < 45000);
  pill.textContent = online ? "● Device online" : "● Device offline";
  pill.className   = online ? "pill on" : "pill off";
}
setInterval(refreshOnlinePill, 3000);
```

Because `lastSeen` uses Firebase's *server* timestamp and phone clocks can drift, you can optionally correct with `.info/serverTimeOffset` — for this project the 45 s margin already absorbs normal drift, so it's optional. Also surface `status.clockSynced === false` as a small warning ("device clock not synced — schedule may be inactive").

---

## 7. Latency & reliability rules (the "less delay or lag" requirements)

The stack is already push-based end to end (website ↔ RTDB over websocket, RTDB → ESP32 over a permanent SSE stream), so total button-to-motor latency is typically well under a second. To keep it that way: attach each `onValue` listener exactly once (re-attaching on every render duplicates callbacks and makes the UI look laggy); never poll; keep the page a single lightweight HTML file so it loads fast on judges' phones over mobile data; and don't write to the database in a loop or on every keystroke — write on explicit user actions only (a time input writes on "Save", not on every tick of the picker). The database is in `asia-southeast1` (Singapore), the closest region to Nepal.

---

## 8. Security rules (already applied — for your reference)

```json
{
  "rules": {
    "aerator": {
      ".read": "auth = null",
      ".write": "auth = null"
    }
  }
}
```

Anything outside `/aerator` is unreadable/unwritable. If you want extra polish, split write permission so the web user can only write `control` — nice but not required for the expo.

---

## 9. What the page needs, minimum (one screen)

A login form (email/password → `signInWithEmailAndPassword`); a big pump status indicator bound to `status/motorOn`; the live temperature with °C; the online/offline pill; a Manual/Schedule mode switch; the manual ON/OFF toggle (disabled or visually secondary while in schedule mode); two time inputs + Save for the schedule; an Arm/Disarm toggle; and a red alert banner bound to `security/alert` showing the `lastAlertAt` time. Everything must work well on a phone screen — judges will scan a QR code.

`dashboard/index.html` implements all of the above in one file with zero dependencies beyond the Firebase CDN. Open it, paste the `firebaseConfig`, and it runs from a double-click for local testing.

---

## 10. Testing without the hardware

You don't need the ESP32 to build the UI. Open the Firebase console → Realtime Database → Data, and hand-edit values: change `status/temperature` and watch your page update instantly; set `security/alert` to `true` to test the banner; bump `status/lastSeen` (paste `Date.now()`) to flip the online pill. Conversely, when your page writes to `control/*`, verify the values change in the console. If both directions work against the console, they will work against the device.

## 11. Hosting

Any static host works (it's one HTML file), but **Firebase Hosting** is free, is already attached to this project, and gives you HTTPS + a clean URL for the QR code: `npm i -g firebase-tools`, `firebase login`, `firebase init hosting` (public dir = the dashboard folder), `firebase deploy`. Total time: ~5 minutes.
