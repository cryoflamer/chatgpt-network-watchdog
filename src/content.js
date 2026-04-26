const HEARTBEAT_INTERVAL_MS = 2000;
const PANEL_ID = "chatgpt-network-watchdog-panel";
const OPEN_BUTTON_ID = "chatgpt-network-watchdog-open-button";

let lastState = null;

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);

  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.position = "fixed";
    panel.style.right = "20px";
    panel.style.bottom = "100px";
    panel.style.zIndex = "2147483647";
    panel.style.padding = "10px 14px";
    panel.style.borderRadius = "10px";
    panel.style.background = "#111111";
    panel.style.color = "#ffffff";
    panel.style.font = "13px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    panel.style.boxShadow = "0 4px 20px rgba(0, 0, 0, .25)";
    panel.style.whiteSpace = "pre-line";
    panel.style.pointerEvents = "auto";
    document.body.appendChild(panel);
  }

  return panel;
}

function formatAge(timestamp) {
  if (!timestamp) {
    return "never";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return `${seconds}s ago`;
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) {
    return "n/a";
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatBackendPath(url) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).pathname;
  } catch (_error) {
    return url;
  }
}

function panelColor(state) {
  if (state.pageState === "frozen") {
    return "#5c2d91";
  }

  if (state.networkState === "generating") {
    return "#7a1f1f";
  }

  if (state.networkState === "done") {
    return "#1f6f3a";
  }

  if (state.networkState === "error") {
    return "#7a5a1f";
  }

  return "#333333";
}


function shouldShowOpenButton(state) {
  return state.networkState === "done";
}

function openFreshChat() {
  const button = document.getElementById(OPEN_BUTTON_ID);
  if (button) {
    button.disabled = true;
    button.textContent = "Opening...";
  }

  sendMessage({ type: "watchdog-open-fresh-chat" });
}

function renderOpenButton(panel, state) {
  let button = document.getElementById(OPEN_BUTTON_ID);

  if (!shouldShowOpenButton(state)) {
    if (button) {
      button.remove();
    }
    return;
  }

  if (!button) {
    button = document.createElement("button");
    button.id = OPEN_BUTTON_ID;
    button.type = "button";
    button.style.marginTop = "8px";
    button.style.padding = "6px 10px";
    button.style.border = "0";
    button.style.borderRadius = "7px";
    button.style.background = "#ffffff";
    button.style.color = "#14532d";
    button.style.cursor = "pointer";
    button.style.font = "12px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    button.style.fontWeight = "600";
    button.addEventListener("click", openFreshChat);
  }

  button.disabled = false;
  button.textContent = "Open fresh chat";
  panel.appendChild(button);
}

function renderState(state) {
  lastState = state;

  const panel = ensurePanel();
  panel.style.background = panelColor(state);

  const lines = [
    `BG: ${state.backgroundState || "unknown"}`,
    `Network: ${state.networkState}`,
    `Page: ${state.pageState}`,
    `Duration: ${formatDuration(state.generationDurationMs)}`,
    `Done: ${formatAge(state.lastDoneAt)}`,
    state.lastBackendRequestAt ? `Backend: ${formatAge(state.lastBackendRequestAt)}` : null,
    state.lastBackendRequestUrl ? `Last: ${formatBackendPath(state.lastBackendRequestUrl)}` : null,
    state.lastAction ? `Action: ${state.lastAction}` : null,
    state.lastError ? `Error: ${state.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let body = panel.querySelector("[data-watchdog-body]");
  if (!body) {
    body = document.createElement("div");
    body.dataset.watchdogBody = "true";
    panel.appendChild(body);
  }
  body.textContent = lines;

  renderOpenButton(panel, state);
}

function sendMessage(message) {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      ensurePanel().textContent = [
        "BG: disconnected",
        `Error: ${chrome.runtime.lastError.message}`,
      ].join("\n");
      return;
    }

    if (response?.state) {
      renderState(response.state);
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "watchdog-state" && message.state) {
    renderState(message.state);
  }
});

function heartbeat() {
  sendMessage({ type: "watchdog-heartbeat" });
}

ensurePanel().textContent = "BG: connecting\nNetwork: unknown\nPage: starting";
sendMessage({ type: "watchdog-hello", href: window.location.href });
sendMessage({ type: "watchdog-get-state" });
heartbeat();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

window.addEventListener("pageshow", () => {
  if (lastState) {
    renderState(lastState);
  }

  heartbeat();
});
