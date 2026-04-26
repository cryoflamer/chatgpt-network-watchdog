const HEARTBEAT_INTERVAL_MS = 2000;
const PANEL_ID = "chatgpt-network-watchdog-panel";

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
    panel.style.pointerEvents = "none";
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

function renderState(state) {
  lastState = state;

  const panel = ensurePanel();
  panel.style.background = panelColor(state);
  panel.textContent = [
    `Network: ${state.networkState}`,
    `Page: ${state.pageState}`,
    `Duration: ${formatDuration(state.generationDurationMs)}`,
    `Done: ${formatAge(state.lastDoneAt)}`,
    state.lastError ? `Error: ${state.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function sendMessage(message) {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
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

ensurePanel().textContent = "Network: unknown\nPage: starting";
sendMessage({ type: "watchdog-get-state" });
heartbeat();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

window.addEventListener("pageshow", () => {
  if (lastState) {
    renderState(lastState);
  }

  heartbeat();
});
