const statusEl = document.getElementById("status");
const networkEl = document.getElementById("network");
const pageEl = document.getElementById("page");
const durationEl = document.getElementById("duration");
const doneEl = document.getElementById("done");
const errorEl = document.getElementById("error");
const lastEl = document.getElementById("last");
const hintEl = document.getElementById("hint");
const openFreshChatButton = document.getElementById("openFreshChat");
const reloadTabButton = document.getElementById("reloadTab");

let currentState = null;

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
    return "n/a";
  }

  try {
    return new URL(url).pathname;
  } catch (_error) {
    return url;
  }
}

function displayStatus(state) {
  if (state.pageState === "frozen") {
    return "FRZ";
  }

  if (state.networkState === "generating") {
    return "GEN";
  }

  if (state.networkState === "done") {
    return "DONE";
  }

  if (state.networkState === "error") {
    return "ERR";
  }

  return "IDLE";
}

function renderState(state) {
  currentState = state;

  const status = displayStatus(state);
  statusEl.textContent = status;
  statusEl.className = `status status-${status.toLowerCase() === "frz" ? "frozen" : status.toLowerCase() === "gen" ? "generating" : status.toLowerCase() === "err" ? "error" : status.toLowerCase()}`;

  networkEl.textContent = state.networkState || "unknown";
  pageEl.textContent = state.pageState || "unknown";
  durationEl.textContent = formatDuration(state.generationDurationMs);
  doneEl.textContent = formatAge(state.lastDoneAt);
  errorEl.textContent = state.lastError || "none";
  lastEl.textContent = formatBackendPath(state.lastBackendRequestUrl);

  openFreshChatButton.disabled = !(state.networkState === "done" || state.pageState === "frozen");
  reloadTabButton.disabled = state.networkState !== "error";

  if (state.networkState === "error") {
    hintEl.textContent = "Network error detected. Reloading the current ChatGPT tab is safer than opening a fresh one.";
  } else if (state.pageState === "frozen") {
    hintEl.textContent = "The page heartbeat is stale. Opening a fresh chat is safe.";
  } else if (state.networkState === "done") {
    hintEl.textContent = "The response has finished at the network level. Alt+Shift+N opens the current chat in a fresh tab.";
  } else if (state.networkState === "generating") {
    hintEl.textContent = "A ChatGPT generation request is in progress.";
  } else {
    hintEl.textContent = "Waiting for the next ChatGPT generation request. Hotkey: Alt+Shift+N opens the current chat in a fresh tab.";
  }
}

function requestState() {
  chrome.runtime.sendMessage({ type: "watchdog-popup-state" }, (response) => {
    if (chrome.runtime.lastError) {
      hintEl.textContent = chrome.runtime.lastError.message;
      return;
    }

    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to read watchdog state.";
      return;
    }

    renderState(response.state);
  });
}

openFreshChatButton.addEventListener("click", () => {
  openFreshChatButton.disabled = true;
  openFreshChatButton.textContent = "Opening...";

  chrome.runtime.sendMessage({ type: "watchdog-popup-open-fresh-chat" }, (response) => {
    openFreshChatButton.textContent = "Open fresh chat";

    if (chrome.runtime.lastError) {
      hintEl.textContent = chrome.runtime.lastError.message;
      return;
    }

    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to open fresh chat.";
      openFreshChatButton.disabled = false;
      return;
    }

    if (response.state) {
      renderState(response.state);
    } else if (currentState) {
      renderState(currentState);
    }
  });
});


reloadTabButton.addEventListener("click", () => {
  reloadTabButton.disabled = true;
  reloadTabButton.textContent = "Reloading...";

  chrome.runtime.sendMessage({ type: "watchdog-popup-reload-tab" }, (response) => {
    reloadTabButton.textContent = "Reload tab";

    if (chrome.runtime.lastError) {
      hintEl.textContent = chrome.runtime.lastError.message;
      return;
    }

    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to reload tab.";
      reloadTabButton.disabled = currentState?.networkState !== "error";
      return;
    }

    if (response.state) {
      renderState(response.state);
    } else if (currentState) {
      renderState(currentState);
    }
  });
});

requestState();
setInterval(requestState, 1000);
