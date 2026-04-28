const statusEl = document.getElementById("status");
const statusSummaryEl = document.getElementById("statusSummary");
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
const desktopNotificationsInput = document.getElementById("desktopNotifications");
const debugModeInput = document.getElementById("debugMode");
const soundVolumeInput = document.getElementById("soundVolume");
const soundVolumeValueEl = document.getElementById("soundVolumeValue");
const heartbeatTimeoutInput = document.getElementById("heartbeatTimeout");
const heartbeatTimeoutValueEl = document.getElementById("heartbeatTimeoutValue");
const autoRecoverCooldownInput = document.getElementById("autoRecoverCooldown");
const autoRecoverCooldownValueEl = document.getElementById("autoRecoverCooldownValue");
const testDoneSoundButton = document.getElementById("testDoneSound");
const testErrSoundButton = document.getElementById("testErrSound");
const testFrzSoundButton = document.getElementById("testFrzSound");
const testDoneNotificationButton = document.getElementById("testDoneNotification");
const testErrNotificationButton = document.getElementById("testErrNotification");
const testFrzNotificationButton = document.getElementById("testFrzNotification");

let currentState = null;
let currentTabs = [];
let currentEvents = [];

function formatRelativeAge(timestamp, { withAgo = true } = {}) {
  if (!timestamp) {
    return "never";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  let value;
  if (seconds < 3) {
    value = "now";
  } else if (seconds < 60) {
    value = `${seconds}s`;
  } else {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    value = remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  return withAgo && value !== "now" ? `${value} ago` : value;
}

function formatAge(timestamp) {
  return formatRelativeAge(timestamp);
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) {
    return "n/a";
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatShortAge(timestamp) {
  return formatRelativeAge(timestamp, { withAgo: false });
}

function statusLabel(status) {
  const labels = {
    IDLE: "Idle",
    STALE: "Stale",
    GEN: "Generating",
    STUCK: "Stuck",
    RLD: "Reloading",
    DONE: "Done",
    FRZ: "Frozen",
    ERR: "Error",
  };
  return labels[status] || status;
}

function statusSummary(state) {
  const status = displayStatus(state);
  if (status === "GEN") {
    return `Generation running for ${formatDuration(state.generationDurationMs)}.`;
  }
  if (status === "STUCK") {
    return `Generation appears stuck after ${formatDuration(state.generationDurationMs)}.`;
  }
  if (status === "DONE") {
    return `Response completed ${formatAge(state.lastDoneAt)}.`;
  }
  if (status === "FRZ") {
    return "Response is done, but the page heartbeat is stale.";
  }
  if (status === "ERR") {
    return `Network error${state.lastError ? `: ${state.lastError}` : ""}.`;
  }
  if (status === "RLD") {
    return "Tab reload is in progress.";
  }
  if (status === "STALE") {
    return "Idle tab heartbeat is stale; no recovery needed.";
  }
  return "Waiting for the next generation request.";
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

  if (state.networkState === "idle" && state.pageState === "frozen") {
    return "STALE";
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

  if (status === "STALE") {
    return "stale";
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
    STALE: 6,
    IDLE: 7,
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
    return `running · ${formatDuration(state.generationDurationMs)}`;
  }

  if (status === "DONE") {
    return `done · ${formatAge(state.lastDoneAt)}`;
  }

  if (status === "ERR") {
    return `error · ${formatAge(state.lastErrorAt)}`;
  }

  if (status === "RLD") {
    return `reloading · ${formatAge(state.lastReloadStartedAt)}`;
  }

  if (status === "FRZ") {
    const attempts = state.autoRecoverAttempts || 0;
    const maxAttempts = state.autoRecoverMaxAttempts || 0;
    const attemptText = maxAttempts ? ` · auto ${attempts}/${maxAttempts}` : "";
    return `heartbeat stale · ${formatAge(state.lastHeartbeatAt)}${attemptText}`;
  }

  if (status === "STALE") {
    return `inactive · ${formatAge(state.lastHeartbeatAt)}`;
  }

  return state.lastHeartbeatAt ? `alive · ${formatAge(state.lastHeartbeatAt)}` : "not attached yet";
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
function setRangeSecondsUi(input, valueEl, seconds, suffix = "s") {
  const normalized = Math.max(Number(input.min) || 0, Math.min(Number(input.max) || seconds, Number(seconds) || 0));
  input.value = String(normalized);
  valueEl.textContent = `${normalized}${suffix}`;
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

function setTestNotificationButtonsDisabled(disabled) {
  testDoneNotificationButton.disabled = disabled;
  testErrNotificationButton.disabled = disabled;
  testFrzNotificationButton.disabled = disabled;
}

function requestTestNotification(alertType) {
  setTestNotificationButtonsDisabled(true);
  sendPopupMessage({ type: "watchdog-popup-test-notification", alertType }, (response) => {
    setTestNotificationButtonsDisabled(false);

    if (!response?.ok) {
      hintEl.textContent = response?.error || "Unable to test " + alertType + " notification.";
      return;
    }

    hintEl.textContent = alertType + " notification requested.";
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
    badge.textContent = statusLabel(status);
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
  statusEl.textContent = statusLabel(status);
  statusEl.className = `status status-${statusClass(status)}`;
  statusSummaryEl.textContent = statusSummary(state);

  networkEl.textContent = state.networkState || "unknown";
  pageEl.textContent = state.pageState || "unknown";
  durationEl.textContent = formatDuration(state.generationDurationMs);
  doneEl.textContent = formatAge(state.lastDoneAt);
  errorEl.textContent = state.lastError || "none";
  lastEl.textContent = formatBackendPath(state.lastBackendRequestUrl);

  openFreshChatButton.disabled = !(state.networkState === "done");
  reloadTabButton.disabled = state.networkState !== "error";
  autoRecoverFrozenTabsInput.checked = Boolean(state.settings?.autoRecoverFrozenTabs);
  soundAlertsInput.checked = Boolean(state.settings?.soundAlerts);
  desktopNotificationsInput.checked = Boolean(state.settings?.desktopNotifications);
  debugModeInput.checked = Boolean(state.settings?.debugMode);
  setSoundVolumeUi(state.settings?.soundVolumePercent ?? Math.round((state.settings?.soundVolume ?? 0.35) * 100));
  setRangeSecondsUi(heartbeatTimeoutInput, heartbeatTimeoutValueEl, state.settings?.heartbeatTimeoutSec ?? 15);
  setRangeSecondsUi(autoRecoverCooldownInput, autoRecoverCooldownValueEl, state.settings?.autoRecoverCooldownSec ?? 60);
  renderTabs(tabs);
  renderEvents(events);

  if (state.networkState === "reloading" || state.pageState === "reloading") {
    hintEl.textContent = "The ChatGPT tab is reloading. Waiting for the page to reconnect.";
  } else if (state.networkState === "error") {
    hintEl.textContent = "Network error detected. Reloading the current ChatGPT tab is safer than opening a fresh one.";
  } else if (state.networkState === "done" && state.pageState === "frozen") {
    const attempts = state.autoRecoverAttempts || 0;
    const maxAttempts = state.autoRecoverMaxAttempts || 0;
    hintEl.textContent = state.settings?.autoRecoverFrozenTabs
      ? `The page heartbeat is stale after response completion. Auto-recovery attempts: ${attempts}/${maxAttempts}.`
      : "The response is done, but the page heartbeat is stale. Opening a fresh chat is safe.";
  } else if (state.networkState === "idle" && state.pageState === "frozen") {
    hintEl.textContent = "The tab is inactive/stale while idle. This is not a freeze and no recovery action is needed.";
  } else if (state.pageState === "frozen") {
    hintEl.textContent = "The page heartbeat is stale, but no completed response is waiting for recovery.";
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


desktopNotificationsInput.addEventListener("change", () => {
  desktopNotificationsInput.disabled = true;

  sendPopupMessage(
    {
      type: "watchdog-popup-set-desktop-notifications",
      enabled: desktopNotificationsInput.checked,
    },
    (response) => {
      desktopNotificationsInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update desktop notifications setting.";
        desktopNotificationsInput.checked = Boolean(currentState?.settings?.desktopNotifications);
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

debugModeInput.addEventListener("change", () => {
  debugModeInput.disabled = true;

  sendPopupMessage(
    {
      type: "watchdog-popup-set-debug-mode",
      enabled: debugModeInput.checked,
    },
    (response) => {
      debugModeInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update debug mode setting.";
        debugModeInput.checked = Boolean(currentState?.settings?.debugMode);
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

heartbeatTimeoutInput.addEventListener("input", () => {
  setRangeSecondsUi(heartbeatTimeoutInput, heartbeatTimeoutValueEl, heartbeatTimeoutInput.value);
});

heartbeatTimeoutInput.addEventListener("change", () => {
  heartbeatTimeoutInput.disabled = true;
  const seconds = Math.max(5, Math.min(60, Number(heartbeatTimeoutInput.value) || 15));

  sendPopupMessage(
    {
      type: "watchdog-popup-set-heartbeat-timeout",
      seconds,
    },
    (response) => {
      heartbeatTimeoutInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update heartbeat timeout.";
        setRangeSecondsUi(heartbeatTimeoutInput, heartbeatTimeoutValueEl, currentState?.settings?.heartbeatTimeoutSec ?? 15);
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

autoRecoverCooldownInput.addEventListener("input", () => {
  setRangeSecondsUi(autoRecoverCooldownInput, autoRecoverCooldownValueEl, autoRecoverCooldownInput.value);
});

autoRecoverCooldownInput.addEventListener("change", () => {
  autoRecoverCooldownInput.disabled = true;
  const seconds = Math.max(10, Math.min(300, Number(autoRecoverCooldownInput.value) || 60));

  sendPopupMessage(
    {
      type: "watchdog-popup-set-auto-recover-cooldown",
      seconds,
    },
    (response) => {
      autoRecoverCooldownInput.disabled = false;

      if (!response?.ok) {
        hintEl.textContent = response?.error || "Unable to update auto-recovery cooldown.";
        setRangeSecondsUi(
          autoRecoverCooldownInput,
          autoRecoverCooldownValueEl,
          currentState?.settings?.autoRecoverCooldownSec ?? 60,
        );
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
testDoneNotificationButton.addEventListener("click", () => requestTestNotification("DONE"));
testErrNotificationButton.addEventListener("click", () => requestTestNotification("ERR"));
testFrzNotificationButton.addEventListener("click", () => requestTestNotification("FRZ"));

requestState();
setInterval(requestState, 1000);
