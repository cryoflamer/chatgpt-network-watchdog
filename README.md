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

This initial version does not auto-close or auto-open tabs. It only observes and displays state:

- Tracks `/backend-api/f/conversation` request start, completion, and errors.
- Maintains per-tab network state in the extension background worker.
- Sends a lightweight heartbeat from the ChatGPT tab to detect page responsiveness.
- Shows a small debug panel on ChatGPT pages with:
  - network state,
  - page heartbeat state,
  - generation duration,
  - last completion/error time.
- Updates the extension badge with compact states.

## Install in Opera / Chrome

1. Open `opera://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Open `https://chatgpt.com/` and send a message.

## Expected behavior

During generation, the debug panel should show something like:

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

1. Add a safe manual action button: **Open fresh ChatGPT tab**.
2. Add optional automatic tab rotation when `network done + page frozen` is detected.
3. Add settings for timeouts and auto-action behavior.
4. Add defensive handling for multiple ChatGPT tabs and regenerated responses.
