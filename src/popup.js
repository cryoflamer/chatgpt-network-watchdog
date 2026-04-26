const statusEl = document.getElementById("status");
const networkEl = document.getElementById("network");
const pageEl = document.getElementById("page");
const durationEl = document.getElementById("duration");
const doneEl = document.getElementById("done");
const errorEl = document.getElementById("error");
const lastEl = document.getElementById("last");
const hintEl = document.getElementById("hint");
const tabsListEl = document.getElementById("tabsList");
const openFreshChatButton = document.getElementById("openFreshChat");
const reloadTabButton = document.getElementById("reloadTab");
const autoRecoverFrozenTabsInput = document.getElementById("autoRecoverFrozenTabs");

let currentState = null;
let currentTabs = [];

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

function formatChatPath(url) {
  if (!url) {
    return "n/a";
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" ? "/" : parsed.pathname;
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

function statusClass(status) {
  if (status === "FRZ") {
    return "frozen";
  }

  if (status === "GEN") {
    return "generating";
  }

  if (status === "ERR") {
    return "error";
  }

  return status.toLowerCase();
}

function tabLine(tab) {
  const status = displayStatus(tab.state);
  const duration = formatDuration(tab.state.generationDurationMs);
  const path = formatChatPath(tab.url);
  const active = tab.active ? "active" : "background";

  return `${status} · ${duration} · ${active} · ${path}`;
}

function sendPopupMessage(message, callback) {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      hintEl.textContent = chrome.runtime.lastError.message;
      callback?.({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    callback?.(response);
  });
}

function renderTabs(tabs) {
  currentTabs = tabs || [];
  tabsListEl.replaceChildren();

  if (!currentTabs.length) {
    tabsListEl.textContent = "No ChatGPT tabs detected.";
    return;
  }

  for (const tab of currentTabs) {
    const card = document.createElement("div");
    card.className = `tab-card${tab.active ? " active" : ""}`;

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || "ChatGPT";
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "tab-meta";
    meta.textContent = tabLine(tab);
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "tab-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open fresh";
    openButton.addEventListener("click", () => {
      openButton.disabled = true;
      sendPopupMessage(
        { type: "watchdog-popup-open-tab-fresh-chat", tabId: tab.id },
        (response) => {
          if (!response?.ok) {
            hintEl.textContent = response?.error || "Unable to open fresh chat.";
            openButton.disabled = false;
            return;
          }

          hintEl.textContent = "Fresh chat tab opened.";
          requestState();
        },
      );
    });
    actions.appendChild(openButton);

    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.className = "secondary";
    reloadButton.textContent = "Reload";
    reloadButton.disabled = tab.state.networkState !== "error";
    reloadButton.addEventListener("click", () => {
      reloadButton.disabled = true;
      sendPopupMessage(
        { type: "watchdog-popup-reload-tab-by-id", tabId: tab.id },
        (response) => {
          if (!response?.ok) {
            hintEl.textContent = response?.error || "Unable to reload tab.";
            reloadButton.disabled = tab.state.networkState !== "error";
            return;
          }

          hintEl.textContent = "Tab reload requested.";
          requestState();
        },
      );
    });
    actions.appendChild(reloadButton);

    card.appendChild(actions);
    tabsListEl.appendChild(card);
  }
}

function renderState(state, tabs = currentTabs) {
  currentState = state;

  const status = displayStatus(state);
  statusEl.textContent = status;
  statusEl.className = `status status-${statusClass(status)}`;

  networkEl.textContent = state.networkState || "unknown";
  pageEl.textContent = state.pageState || "unknown";
  durationEl.textContent = formatDuration(state.generationDurationMs);
  doneEl.textContent = formatAge(state.lastDoneAt);
  errorEl.textContent = state.lastError || "none";
  lastEl.textContent = formatBackendPath(state.lastBackendRequestUrl);

  openFreshChatButton.disabled = !(state.networkState === "done" || state.pageState === "frozen");
  reloadTabButton.disabled = state.networkState !== "error";
  autoRecoverFrozenTabsInput.checked = Boolean(state.settings?.autoRecoverFrozenTabs);
  renderTabs(tabs);

  if (state.networkState === "error") {
    hintEl.textContent = "Network error detected. Reloading the current ChatGPT tab is safer than opening a fresh one.";
  } else if (state.pageState === "frozen") {
    hintEl.textContent = state.settings?.autoRecoverFrozenTabs
      ? "The page heartbeat is stale. Auto-recovery can open this chat in a fresh tab."
      : "The page heartbeat is stale. Opening a fresh chat is safe.";
  } else if (state.networkState === "done") {
    hintEl.textContent = "The response has finished at the network level. Alt+Shift+N opens the current chat in a fresh tab.";
  } else if (state.networkState === "generating") {
    hintEl.textContent = "A ChatGPT generation request is in progress.";
  } else {
    hintEl.textContent = "Waiting for the next ChatGPT generation request. Hotkey: Alt+Shift+N opens the current chat in a fresh tab.";
  }
}

function requestState() {
  sendPopupMessage({ type: "watchdog-popup-state" }, (response) => {
    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to read watchdog state.";
      return;
    }

    renderState(response.state, response.tabs || []);
  });
}

openFreshChatButton.addEventListener("click", () => {
  openFreshChatButton.disabled = true;
  openFreshChatButton.textContent = "Opening...";

  sendPopupMessage({ type: "watchdog-popup-open-fresh-chat" }, (response) => {
    openFreshChatButton.textContent = "Open current chat in fresh tab";

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
    requestState();
  });
});

reloadTabButton.addEventListener("click", () => {
  reloadTabButton.disabled = true;
  reloadTabButton.textContent = "Reloading...";

  sendPopupMessage({ type: "watchdog-popup-reload-tab" }, (response) => {
    reloadTabButton.textContent = "Reload tab";

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
    requestState();
  });
});

autoRecoverFrozenTabsInput.addEventListener("change", () => {
  autoRecoverFrozenTabsInput.disabled = true;

  sendPopupMessage(
    {
      type: "watchdog-popup-set-auto-recover",
      enabled: autoRecoverFrozenTabsInput.checked,
    },
    (response) => {
      autoRecoverFrozenTabsInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update auto-recovery setting.";
        autoRecoverFrozenTabsInput.checked = Boolean(currentState?.settings?.autoRecoverFrozenTabs);
        return;
      }

      if (response.state) {
        renderState(response.state);
      } else if (currentState) {
        currentState.settings = response.settings || currentState.settings;
        renderState(currentState);
      }
      requestState();
    },
  );
});

requestState();
setInterval(requestState, 1000);
