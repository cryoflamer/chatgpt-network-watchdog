const statusEl = document.getElementById("status");
const networkEl = document.getElementById("network");
const pageEl = document.getElementById("page");
const durationEl = document.getElementById("duration");
const doneEl = document.getElementById("done");
const errorEl = document.getElementById("error");
const lastEl = document.getElementById("last");
const hintEl = document.getElementById("hint");
const tabsListEl = document.getElementById("tabsList");
const eventListEl = document.getElementById("eventList");
const openFreshChatButton = document.getElementById("openFreshChat");
const reloadTabButton = document.getElementById("reloadTab");
const autoRecoverFrozenTabsInput = document.getElementById("autoRecoverFrozenTabs");
const soundAlertsInput = document.getElementById("soundAlerts");
const soundVolumeInput = document.getElementById("soundVolume");
const soundVolumeValueEl = document.getElementById("soundVolumeValue");
const testDoneSoundButton = document.getElementById("testDoneSound");
const testErrSoundButton = document.getElementById("testErrSound");
const testFrzSoundButton = document.getElementById("testFrzSound");

let currentState = null;
let currentTabs = [];
let currentEvents = [];

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

function formatShortAge(timestamp) {
  if (!timestamp) {
    return "never";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
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

function eventTypeClass(type) {
  const normalized = String(type || "EVT").toLowerCase();
  if (["err", "desync"].includes(normalized)) {
    return "event-type-error";
  }
  if (["frz", "stuck"].includes(normalized)) {
    return "event-type-warning";
  }
  if (["done", "open", "alert"].includes(normalized)) {
    return "event-type-success";
  }
  if (["gen", "rld", "set"].includes(normalized)) {
    return "event-type-info";
  }
  return "event-type-neutral";
}

function tabLabelForEvent(event) {
  if (typeof event.tabId !== "number") {
    return "system";
  }

  const tab = currentTabs.find((item) => item.id === event.tabId);
  if (!tab) {
    return `tab ${event.tabId}`;
  }

  const prefix = tab.active ? "active" : `tab ${event.tabId}`;
  return `${prefix} · ${displayStatus(tab.state)}`;
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
  if (state.networkState === "reloading" || state.pageState === "reloading") {
    return "RLD";
  }

  if (state.networkState === "error") {
    return "ERR";
  }

  if (state.networkState === "stuck") {
    return "STUCK";
  }

  if (state.networkState === "generating") {
    return "GEN";
  }

  if (state.networkState === "done" && state.pageState === "frozen") {
    return "FRZ";
  }

  if (state.networkState === "done") {
    return "DONE";
  }

  return "IDLE";
}

function statusClass(status) {
  if (status === "RLD") {
    return "reloading";
  }

  if (status === "FRZ") {
    return "frozen";
  }

  if (status === "STUCK") {
    return "stuck";
  }

  if (status === "GEN") {
    return "generating";
  }

  if (status === "ERR") {
    return "error";
  }

  return status.toLowerCase();
}

function statusPriority(status) {
  const priorities = {
    ERR: 0,
    FRZ: 1,
    STUCK: 2,
    GEN: 3,
    RLD: 4,
    DONE: 5,
    IDLE: 6,
  };

  return priorities[status] ?? 9;
}

function stateTimestamp(state) {
  return (
    state.lastErrorAt ||
    state.lastStuckAt ||
    state.lastDoneAt ||
    state.lastReloadStartedAt ||
    state.generationStartedAt ||
    state.lastHeartbeatAt ||
    0
  );
}

function sortedTabs(tabs) {
  return [...(tabs || [])].sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    const leftStatus = displayStatus(left.state);
    const rightStatus = displayStatus(right.state);
    const priorityDelta = statusPriority(leftStatus) - statusPriority(rightStatus);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return stateTimestamp(right.state) - stateTimestamp(left.state);
  });
}

function tabActivityLine(tab) {
  const state = tab.state;
  const status = displayStatus(state);

  if (status === "GEN" || status === "STUCK") {
    return `running ${formatDuration(state.generationDurationMs)}`;
  }

  if (status === "DONE") {
    return `done ${formatShortAge(state.lastDoneAt)} ago`;
  }

  if (status === "ERR") {
    return `error ${formatShortAge(state.lastErrorAt)} ago`;
  }

  if (status === "RLD") {
    return `reloading ${formatShortAge(state.lastReloadStartedAt)} ago`;
  }

  if (status === "FRZ") {
    const attempts = state.autoRecoverAttempts || 0;
    const maxAttempts = state.autoRecoverMaxAttempts || 0;
    const attemptText = maxAttempts ? ` · auto ${attempts}/${maxAttempts}` : "";
    return `heartbeat stale ${formatShortAge(state.lastHeartbeatAt)} ago${attemptText}`;
  }

  return state.lastHeartbeatAt ? `alive ${formatShortAge(state.lastHeartbeatAt)} ago` : "not attached yet";
}

function tabLine(tab) {
  const path = formatChatPath(tab.url);
  const activity = tabActivityLine(tab);
  const active = tab.active ? "active" : `window ${tab.windowId}`;

  return `${activity} · ${active} · ${path}`;
}

function formatEventDetail(event) {
  const parts = [];
  const details = event.details || {};

  parts.push(tabLabelForEvent(event));

  if (details.durationMs !== undefined) {
    parts.push(`duration ${formatDuration(details.durationMs)}`);
  }

  if (details.error) {
    parts.push(details.error);
  }

  if (details.statusCode) {
    parts.push(`HTTP ${details.statusCode}`);
  }

  if (details.attempt !== undefined && details.maxAttempts !== undefined) {
    parts.push(`attempt ${details.attempt}/${details.maxAttempts}`);
  }

  if (details.retryDelayMs !== undefined) {
    parts.push(`retry delay ${formatDuration(details.retryDelayMs)}`);
  }

  if (details.requestId) {
    parts.push(`request ${details.requestId}`);
  }

  if (details.activeGenerationRequestId) {
    parts.push(`active ${details.activeGenerationRequestId}`);
  }

  if (details.newTabId !== undefined && details.newTabId !== null) {
    parts.push(`new tab ${details.newTabId}`);
  }

  if (details.volume !== undefined) {
    parts.push(`volume ${details.volume}%`);
  }

  if (details.source) {
    parts.push(details.source);
  }

  if (details.localNetworkState || details.conversationNetworkState) {
    parts.push(`${details.localNetworkState || "local"} -> ${details.conversationNetworkState || "conversation"}`);
  }

  if (details.url) {
    parts.push(formatBackendPath(details.url));
  }

  if (details.targetUrl) {
    parts.push(formatChatPath(details.targetUrl));
  }

  return parts.join(" · ");
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

function setSoundVolumeUi(percent) {
  const normalized = Math.min(100, Math.max(0, Number(percent) || 0));
  soundVolumeInput.value = String(normalized);
  soundVolumeValueEl.textContent = `${normalized}%`;
}

function setTestSoundButtonsDisabled(disabled) {
  testDoneSoundButton.disabled = disabled;
  testErrSoundButton.disabled = disabled;
  testFrzSoundButton.disabled = disabled;
}

function requestTestSound(alertType) {
  setTestSoundButtonsDisabled(true);
  sendPopupMessage({ type: "watchdog-popup-test-sound", alertType }, (response) => {
    setTestSoundButtonsDisabled(false);

    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to test " + alertType + " sound.";
      return;
    }

    hintEl.textContent = alertType + " sound tested at " + soundVolumeInput.value + "%.";
    requestState();
  });
}

function renderEvents(events) {
  currentEvents = events || [];
  eventListEl.replaceChildren();

  if (!currentEvents.length) {
    eventListEl.textContent = "No events yet.";
    return;
  }

  for (const event of currentEvents) {
    const item = document.createElement("div");
    item.className = "event-item";

    const main = document.createElement("div");
    main.className = "event-main";

    const type = document.createElement("span");
    type.className = `event-type ${eventTypeClass(event.type)}`;
    type.textContent = event.type || "EVT";
    main.appendChild(type);

    const age = document.createElement("span");
    age.className = "event-age";
    age.textContent = formatAge(event.at);
    main.appendChild(age);

    item.appendChild(main);

    const message = document.createElement("div");
    message.className = "event-message";
    message.textContent = event.message || "Watchdog event";
    item.appendChild(message);

    const detail = document.createElement("div");
    detail.className = "event-detail";
    detail.textContent = formatEventDetail(event);
    item.appendChild(detail);

    eventListEl.appendChild(item);
  }
}

function renderTabs(tabs) {
  currentTabs = tabs || [];
  tabsListEl.replaceChildren();

  if (!currentTabs.length) {
    tabsListEl.textContent = "No ChatGPT tabs detected.";
    return;
  }

  for (const tab of sortedTabs(currentTabs)) {
    const status = displayStatus(tab.state);
    const card = document.createElement("div");
    card.className = `tab-card status-border-${statusClass(status)}${tab.active ? " active" : ""}`;

    const header = document.createElement("div");
    header.className = "tab-header";

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || "ChatGPT";
    header.appendChild(title);

    const badge = document.createElement("span");
    badge.className = `tab-status status status-${statusClass(status)}`;
    badge.textContent = status;
    header.appendChild(badge);

    card.appendChild(header);

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

function renderState(state, tabs = currentTabs, events = currentEvents) {
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
  soundAlertsInput.checked = Boolean(state.settings?.soundAlerts);
  setSoundVolumeUi(state.settings?.soundVolumePercent ?? Math.round((state.settings?.soundVolume ?? 0.35) * 100));
  renderTabs(tabs);
  renderEvents(events);

  if (state.networkState === "reloading" || state.pageState === "reloading") {
    hintEl.textContent = "The ChatGPT tab is reloading. Waiting for the page to reconnect.";
  } else if (state.networkState === "error") {
    hintEl.textContent = "Network error detected. Reloading the current ChatGPT tab is safer than opening a fresh one.";
  } else if (state.pageState === "frozen") {
    const attempts = state.autoRecoverAttempts || 0;
    const maxAttempts = state.autoRecoverMaxAttempts || 0;
    hintEl.textContent = state.settings?.autoRecoverFrozenTabs
      ? `The page heartbeat is stale. Auto-recovery attempts: ${attempts}/${maxAttempts}.`
      : "The page heartbeat is stale. Opening a fresh chat is safe.";
  } else if (state.networkState === "done") {
    hintEl.textContent = "The response has finished at the network level. Alt+Shift+N opens the current chat in a fresh tab.";
  } else if (state.networkState === "stuck") {
    hintEl.textContent = "The generation request has been running for unusually long without finishing or failing.";
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

    renderState(response.state, response.tabs || [], response.events || []);
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

soundAlertsInput.addEventListener("change", () => {
  soundAlertsInput.disabled = true;

  sendPopupMessage(
    {
      type: "watchdog-popup-set-sound-alerts",
      enabled: soundAlertsInput.checked,
    },
    (response) => {
      soundAlertsInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update sound alerts setting.";
        soundAlertsInput.checked = Boolean(currentState?.settings?.soundAlerts);
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


soundVolumeInput.addEventListener("input", () => {
  setSoundVolumeUi(soundVolumeInput.value);
});

soundVolumeInput.addEventListener("change", () => {
  soundVolumeInput.disabled = true;
  const volume = Math.min(100, Math.max(0, Number(soundVolumeInput.value) || 0)) / 100;

  sendPopupMessage(
    {
      type: "watchdog-popup-set-sound-volume",
      volume,
    },
    (response) => {
      soundVolumeInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update sound volume.";
        setSoundVolumeUi(currentState?.settings?.soundVolumePercent ?? 35);
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

testDoneSoundButton.addEventListener("click", () => requestTestSound("DONE"));
testErrSoundButton.addEventListener("click", () => requestTestSound("ERR"));
testFrzSoundButton.addEventListener("click", () => requestTestSound("FRZ"));

requestState();
setInterval(requestState, 1000);
