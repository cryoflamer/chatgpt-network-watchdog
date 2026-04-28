# chatgpt-network-watchdog

A lightweight Chromium/Opera extension prototype for detecting when ChatGPT responses finish at the network level, instead of relying on fragile DOM or button-state heuristics.

## Why

Long ChatGPT conversations can become heavy enough that the page UI freezes or responds slowly. A DOM-based userscript can freeze with the page, so this project separates two signals:

- **Network completion**: the ChatGPT backend response request has completed.
- **Page health**: the ChatGPT tab is still sending heartbeat messages from a content script.

The first useful target is the ChatGPT generation request:

```text
POST https://chatgpt.com/backend-api/f/conversation
```

When this request completes, the answer has arrived from the backend even if the UI is still struggling to render it.

## Current MVP

The extension observes ChatGPT runtime state from the background worker and exposes safe recovery actions:

- Tracks `/backend-api/f/conversation` request start, completion, and errors.
- Maintains per-tab network state in the extension background worker.
- Sends a lightweight heartbeat from the ChatGPT tab to detect page responsiveness.
- Updates the extension badge with compact one-letter states: `G`, `D`, `F`, `E`, `S`, `R`, and `L`, plus a tooltip with current state details.
- Shows popup diagnostics for network state, page heartbeat, generation duration, last request, and errors.
- Shows a polished multi-tab state view for all open ChatGPT tabs, sorted by active tab, severity, and recency, with concise status labels, activity ages, per-tab **Open fresh**, and **Reload** actions.
- Shows a readable recent event log for state transitions such as `GEN`, `DONE`, `ERR`, `RLD`, `FRZ`, `STALE`, `STUCK`, `DESYNC`, `OPEN`, and `ALERT`, with tab context and key request details.
- Provides optional quiet sound alerts and desktop notifications for `DONE`, `ERR`, and `FRZ` state changes.
- Shows an **Open current chat in fresh tab** button after generation completion or freeze detection.
- Shows a **Reload tab** button for network error states, where opening a fresh tab may not help.
- Provides an optional **Auto-recover frozen tabs** mode that opens the current chat URL in a fresh tab only when the backend response is done and the page heartbeat is stale.

## Install in Opera / Chrome

1. Open `opera://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Open `https://chatgpt.com/` and send a message.

## Expected behavior

During generation, the popup and badge should show something like:

```text
Network: generating
Page: alive
```

After the backend request completes:

```text
Network: done
Page: alive
```

If the page stops sending heartbeat messages for a while, the background worker marks it as frozen:

```text
Page: frozen
```

## Next steps

Planned follow-up patches:

1. Add defensive handling for regenerated responses.
2. Add import/export for watchdog settings.

## Runtime settings

The popup exposes lightweight runtime settings stored in `chrome.storage.local`:

- heartbeat timeout: how long a ChatGPT tab can stop sending content-script heartbeat messages before it becomes `FRZ` or `STALE`;
- auto-recovery cooldown: the minimum delay between automatic fresh-tab recovery attempts for a frozen tab;
- sound volume, sound alerts, desktop notifications, and auto-recovery toggles.

These settings make the watchdog easier to tune for slow machines, suspended background tabs, or more aggressive recovery preferences.

## Multi-tab view

The popup lists all detected ChatGPT tabs and shows a compact state for each one. The active tab is shown first, followed by higher-severity states and more recent activity:

```text
DONE · 36.0s · active · /c/...
GEN · 12.4s · background · /c/...
ERR · 4.8s · background · /c/...
STUCK · 90.0s · background · /c/...
```

Each tab row has a status badge, a colored left border, its activity age, and its own **Open fresh** action. The **Reload** action is enabled for tabs in `ERR` state.

## Sound alerts

Sound alerts are off by default and can be enabled from the popup. When enabled, the extension requests a quiet Web Audio cue from the active ChatGPT content script:

- `DONE`: short high tick
- `ERR`: short low bump
- `FRZ`: double tick

Alerts are debounced so state churn cannot create repeated sounds. The popup includes a volume slider and test buttons for DONE, ERR, and FRZ cues. Audio is optional and may require a user gesture in the ChatGPT tab before the browser allows playback.


## Desktop notifications

Desktop notifications are off by default and can be enabled from the popup independently from sound alerts. When enabled, the background worker sends system notifications for the same high-signal state changes:

- `DONE`: response completed
- `ERR`: network error
- `FRZ`: response done but page heartbeat stale

Notifications are debounced so state churn cannot spam the system notification tray. The popup includes test buttons for DONE, ERR, and FRZ notifications.

## Event log

The popup includes the latest watchdog events, for example:

```text
GEN · Generation started · tab 12 · /backend-api/f/conversation
DONE · Generation completed · tab 12 · 36.0s
ERR · Generation failed · tab 12 · net::ERR_QUIC_PROTOCOL_ERROR
STUCK · Generation marked stuck · tab 12 · 90.0s
RLD · Tab reload started · tab 12
OPEN · Fresh chat opened · tab 12 · /c/...
```

The log is kept in the background service worker and capped to a 30-item in-memory history so it stays lightweight. Event rows include tab context, duration, errors, request ids, target URLs, and sound volume where relevant.

## STALE vs FRZ

`FRZ` is reserved for the important recovery case: the backend response has completed (`DONE`), but the page heartbeat is stale. That state can trigger sound alerts and optional auto-recovery.

`STALE`/`STL` is neutral: an idle tab stopped sending heartbeat, usually because the browser throttled an inactive page. It is shown for clarity, but it does not play a sound and does not trigger auto-recovery.

## Generation desync guard

The watchdog keeps the active generation request id in the background worker. Completion or error events only resolve `GEN` when they match the same request that started the generation. Stale completions are ignored and logged as `DESYNC` instead of silently dropping the tab back to a neutral state.

## Stuck generation detection

If a ChatGPT generation request stays active for longer than 90 seconds without a network completion or error, and no backend activity has been seen for at least 30 seconds, the watchdog marks it as:

```text
STUCK
```

This is distinct from `ERR` and `FRZ`: the request has not failed at the transport level, and the page heartbeat may still be alive, but the generation has been running unusually long and the backend has been quiet long enough to avoid false positives while routine ChatGPT backend traffic is still active.

## Hotkey

Use `Alt+Shift+N` to open the current ChatGPT conversation URL in a fresh tab. If the active tab is not a ChatGPT conversation, the extension falls back to `https://chatgpt.com/`.

## Error recovery

When the state is `ERR`, the popup enables **Reload tab**. This is intentionally separate from **Open current chat in fresh tab** because transport-level errors such as `net::ERR_QUIC_PROTOCOL_ERROR` can affect new tabs too. Reloading the current tab is the safer first recovery action.

## Frozen-tab auto-recovery

Auto-recovery is off by default and can be enabled from the popup. When enabled, it only acts on the safe frozen-tab condition:

```text
Network: done
Page: frozen
```

In that state, the backend response has completed but the content script heartbeat is stale. The extension opens the current chat URL in a fresh tab and leaves the old tab open. It does not auto-recover `ERR` states. Auto-recovery is capped at two attempts per frozen-tab cycle and uses a cooldown before retrying, then logs that it gave up instead of opening tabs indefinitely.
