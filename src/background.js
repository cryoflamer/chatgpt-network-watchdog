const GENERATION_PATH = "/backend-api/f/conversation";
const HEARTBEAT_TIMEOUT_MS = 15000;
const WATCH_INTERVAL_MS = 3000;
const DONE_RESET_MS = 120000;
const AUTO_RECOVER_DEBOUNCE_MS = 60000;
const RELOAD_MIN_DISPLAY_MS = 3000;
const STUCK_GENERATION_TIMEOUT_MS = 90000;
const MAX_EVENT_LOG_ITEMS = 20;
const SOUND_ALERT_DEBOUNCE_MS = 3000;
const DEFAULT_SOUND_VOLUME = 0.35;
const REQUEST_FILTER = { urls: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"] };
const DIAGNOSTIC_LOG = false;

const requests = new Map();
const tabs = new Map();
const conversations = new Map();
const eventLog = [];
let nextEventId = 1;
const settings = {
  autoRecoverFrozenTabs: false,
  soundAlerts: false,
  soundVolume: DEFAULT_SOUND_VOLUME,
};
let lastSoundAlertAt = 0;

console.log("[CTR:BG] service worker loaded", {
  href: chrome.runtime.getURL("src/background.js"),
});

chrome.storage.local.get(
  { autoRecoverFrozenTabs: false, soundAlerts: false, soundVolume: DEFAULT_SOUND_VOLUME },
  (stored) => {
    settings.autoRecoverFrozenTabs = Boolean(stored.autoRecoverFrozenTabs);
    settings.soundAlerts = Boolean(stored.soundAlerts);
    settings.soundVolume = clampSoundVolume(stored.soundVolume);
    console.log("[CTR:BG] settings loaded", settings);
  },
);

function now() {
  return Date.now();
}

function debugLog(message, payload = {}) {
  if (!DIAGNOSTIC_LOG) {
    return;
  }

  console.log(`[CTR:BG] ${message}`, payload);
}

function clampSoundVolume(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SOUND_VOLUME;
  }

  return Math.min(1, Math.max(0, parsed));
}

function soundVolumePercent() {
  return Math.round(settings.soundVolume * 100);
}

function addEvent(type, tabId, message, details = {}) {
  eventLog.unshift({
    id: nextEventId,
    at: now(),
    type,
    tabId: typeof tabId === "number" ? tabId : null,
    message,
    details,
  });
  nextEventId += 1;

  if (eventLog.length > MAX_EVENT_LOG_ITEMS) {
    eventLog.length = MAX_EVENT_LOG_ITEMS;
  }
}

function recentEvents(limit = 10) {
  return eventLog.slice(0, limit).map((event) => ({
    ...event,
    details: { ...event.details },
  }));
}

function triggerSoundAlert(state, alertType) {
  if (!settings.soundAlerts || !state?.tabId) {
    return;
  }

  const currentTime = now();
  if (currentTime - lastSoundAlertAt < SOUND_ALERT_DEBOUNCE_MS) {
    return;
  }
  lastSoundAlertAt = currentTime;

  addEvent("ALERT", state.tabId, `Sound alert requested: ${alertType}`, { volume: soundVolumePercent() });
  chrome.tabs.sendMessage(
    state.tabId,
    { type: "watchdog-play-sound", alertType, volume: settings.soundVolume },
    () => {
      void chrome.runtime.lastError;
    },
  );
}

function isChatGptBackendRequest(details) {
  try {
    const url = new URL(details.url);
    return url.hostname.endsWith("chatgpt.com") && url.pathname.startsWith("/backend-api/");
  } catch (_error) {
    return false;
  }
}

function isGenerationRequest(details) {
  try {
    const url = new URL(details.url);
    return details.method === "POST" && url.hostname === "chatgpt.com" && url.pathname === GENERATION_PATH;
  } catch (_error) {
    return false;
  }
}

function conversationIdFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "chatgpt.com") {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = parts.indexOf("c");
    if (markerIndex >= 0 && parts[markerIndex + 1]) {
      return parts[markerIndex + 1];
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function conversationPatchFromState(state) {
  return {
    networkState: state.networkState,
    generationStartedAt: state.generationStartedAt,
    lastDoneAt: state.lastDoneAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastStuckAt: state.lastStuckAt,
    lastBackendRequestAt: state.lastBackendRequestAt,
    lastBackendRequestUrl: state.lastBackendRequestUrl,
  };
}

function updateConversationState(conversationId, patch) {
  if (!conversationId) {
    return;
  }

  const currentTime = now();
  const previous = conversations.get(conversationId) || {};
  conversations.set(conversationId, {
    ...previous,
    ...patch,
    conversationId,
    updatedAt: currentTime,
  });
}

function canMirrorConversationState(state, conversation) {
  if (!conversation || !conversation.updatedAt) {
    return false;
  }

  if (state.networkState === "generating" && conversation.networkState !== "generating") {
    const localStartedAt = state.generationStartedAt || 0;
    const conversationUpdatedAt = conversation.updatedAt || 0;
    if (localStartedAt && conversationUpdatedAt < localStartedAt) {
      addEvent("DESYNC", state.tabId, "Ignored stale conversation state during generation", {
        localNetworkState: state.networkState,
        conversationNetworkState: conversation.networkState || "unknown",
        localStartedAt,
        conversationUpdatedAt,
      });
      return false;
    }
  }

  return true;
}

function syncStateFromConversation(state, tabUrl) {
  const conversationId = conversationIdFromUrl(tabUrl) || state.conversationId;
  if (!conversationId) {
    return false;
  }

  if (state.networkState === "reloading" || state.pageState === "reloading") {
    return false;
  }

  state.conversationId = conversationId;
  const conversation = conversations.get(conversationId);
  if (!canMirrorConversationState(state, conversation)) {
    return false;
  }

  if (state.mirroredConversationUpdatedAt && state.mirroredConversationUpdatedAt >= conversation.updatedAt) {
    return false;
  }

  const shouldMirror =
    conversation.networkState === "generating" ||
    state.mirroredConversationState ||
    state.networkState === "idle" ||
    !state.generationStartedAt;

  if (!shouldMirror) {
    return false;
  }

  state.networkState = conversation.networkState || state.networkState;
  state.generationStartedAt = conversation.generationStartedAt || state.generationStartedAt;
  state.lastDoneAt = conversation.lastDoneAt || null;
  state.lastErrorAt = conversation.lastErrorAt || null;
  state.lastError = conversation.lastError || null;
  state.lastStuckAt = conversation.lastStuckAt || null;
  state.lastBackendRequestAt = conversation.lastBackendRequestAt || state.lastBackendRequestAt;
  state.lastBackendRequestUrl = conversation.lastBackendRequestUrl || state.lastBackendRequestUrl;
  if (conversation.networkState !== "generating") {
    state.currentRequestId = null;
    state.activeGenerationRequestId = null;
  }
  state.mirroredConversationState = true;
  state.mirroredConversationUpdatedAt = conversation.updatedAt;

  return true;
}

function updateConversationFromTab(tabId, patch) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) {
      return;
    }

    const conversationId = conversationIdFromUrl(tab.url);
    if (!conversationId) {
      return;
    }

    const state = getTabState(tabId);
    state.conversationId = conversationId;
    updateConversationState(conversationId, {
      ...patch,
      sourceTabId: tabId,
      sourceUrl: tab.url,
    });
    syncKnownTabsForConversation(conversationId);
  });
}

function syncKnownTabsForConversation(conversationId) {
  chrome.tabs.query({ url: "https://chatgpt.com/*" }, (chatTabs) => {
    if (chrome.runtime.lastError) {
      return;
    }

    for (const tab of chatTabs || []) {
      if (typeof tab.id !== "number" || conversationIdFromUrl(tab.url) !== conversationId) {
        continue;
      }

      const state = getTabState(tab.id);
      if (syncStateFromConversation(state, tab.url)) {
        notifyTab(state);
      }
    }
  });
}

function getTabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      tabId,
      networkState: "idle",
      pageState: "unknown",
      backgroundState: "connected",
      lastHeartbeatAt: 0,
      currentRequestId: null,
      activeGenerationRequestId: null,
      generationStartedAt: null,
      lastDoneAt: null,
      lastErrorAt: null,
      lastError: null,
      lastStuckAt: null,
      lastBackendRequestAt: null,
      lastBackendRequestUrl: null,
      lastActionAt: null,
      lastAction: null,
      lastAutoRecoverAt: null,
      conversationId: null,
      mirroredConversationState: false,
      mirroredConversationUpdatedAt: null,
    });
  }

  return tabs.get(tabId);
}

function generationDurationMs(state) {
  if (!state.generationStartedAt) {
    return null;
  }

  const end = state.lastDoneAt || state.lastErrorAt || now();
  return Math.max(0, end - state.generationStartedAt);
}

function publicState(state) {
  return {
    tabId: state.tabId,
    networkState: state.networkState,
    pageState: state.pageState,
    backgroundState: state.backgroundState,
    generationDurationMs: generationDurationMs(state),
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastDoneAt: state.lastDoneAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastStuckAt: state.lastStuckAt,
    lastBackendRequestAt: state.lastBackendRequestAt,
    lastBackendRequestUrl: state.lastBackendRequestUrl,
    activeGenerationRequestId: state.activeGenerationRequestId,
    lastActionAt: state.lastActionAt,
    lastAction: state.lastAction,
    lastAutoRecoverAt: state.lastAutoRecoverAt,
    lastReloadStartedAt: state.lastReloadStartedAt,
    lastReloadCompletedAt: state.lastReloadCompletedAt,
    settings: { ...settings, soundVolumePercent: soundVolumePercent() },
  };
}

function tabSummary(tab) {
  const state = getTabState(tab.id);
  syncStateFromConversation(state, tab.url);

  return {
    id: tab.id,
    title: tab.title || "ChatGPT",
    url: tab.url || "",
    active: Boolean(tab.active),
    windowId: tab.windowId,
    state: publicState(state),
  };
}

function getChatGptTabs(callback) {
  chrome.tabs.query({ url: "https://chatgpt.com/*" }, (chatTabs) => {
    if (chrome.runtime.lastError) {
      callback({ ok: false, error: chrome.runtime.lastError.message, tabs: [] });
      return;
    }

    callback({
      ok: true,
      tabs: (chatTabs || [])
        .filter((tab) => typeof tab.id === "number")
        .map(tabSummary),
    });
  });
}

function badgeForState(state) {
  if (state.networkState === "reloading" || state.pageState === "reloading") {
    return { text: "RLD", color: "#1d4ed8" };
  }

  if (state.networkState === "error") {
    return { text: "ERR", color: "#991b1b" };
  }

  if (state.networkState === "stuck") {
    return { text: "STK", color: "#b45309" };
  }

  if (state.networkState === "generating") {
    return { text: "GEN", color: "#7a5a1f" };
  }

  if (state.networkState === "done" && state.pageState === "frozen") {
    return { text: "FRZ", color: "#5c2d91" };
  }

  if (state.networkState === "done") {
    return { text: "DONE", color: "#1f6f3a" };
  }

  return { text: "", color: "#444444" };
}

function updateBadge(state) {
  const badge = badgeForState(state);

  chrome.action.setBadgeText({
    tabId: state.tabId,
    text: badge.text,
  });
  chrome.action.setBadgeBackgroundColor({
    tabId: state.tabId,
    color: badge.color,
  });
}

function notifyTab(state) {
  updateBadge(state);

  chrome.tabs.sendMessage(
    state.tabId,
    {
      type: "watchdog-state",
      state: publicState(state),
    },
    () => {
      void chrome.runtime.lastError;
    },
  );
}

function markBackendRequest(details) {
  if (!isChatGptBackendRequest(details) || details.tabId < 0) {
    return;
  }

  const state = getTabState(details.tabId);
  state.lastBackendRequestAt = now();
  state.lastBackendRequestUrl = details.url;
  notifyTab(state);
}

function normalizeChatGptUrl(url) {
  if (!url) {
    return "https://chatgpt.com/";
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname === "chatgpt.com") {
      return parsed.toString();
    }
  } catch (_error) {
    // Fall through to the safe default.
  }

  return "https://chatgpt.com/";
}

function openFreshChat(state, callback, sourceUrl = null) {
  const targetUrl = normalizeChatGptUrl(sourceUrl);

  chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
    if (chrome.runtime.lastError) {
      state.lastActionAt = now();
      state.lastAction = `open failed: ${chrome.runtime.lastError.message}`;
      addEvent("ERR", state.tabId, "Open fresh chat failed", { error: chrome.runtime.lastError.message });
      notifyTab(state);
      callback?.({ ok: false, error: chrome.runtime.lastError.message, state: publicState(state) });
      return;
    }

    state.lastActionAt = now();
    state.lastAction = `fresh chat opened: ${tab?.id ?? "unknown"}`;
    addEvent("OPEN", state.tabId, "Fresh chat opened", { newTabId: tab?.id ?? null, targetUrl });
    console.log("[CTR:BG] fresh ChatGPT tab opened", {
      sourceTabId: state.tabId,
      newTabId: tab?.id,
      targetUrl,
    });
    notifyTab(state);
    callback?.({ ok: true, tabId: tab?.id, state: publicState(state) });
  });
}


function markTabReloading(state, source = "tab reloading") {
  state.networkState = "reloading";
  state.pageState = "reloading";
  state.currentRequestId = null;
  state.activeGenerationRequestId = null;
  state.lastReloadStartedAt = now();
  state.lastActionAt = state.lastReloadStartedAt;
  state.lastAction = source;
  addEvent("RLD", state.tabId, "Tab reload started", { source });
  notifyTab(state);
}

function finishTabReload(state) {
  if (state.networkState === "reloading") {
    state.networkState = "idle";
  }

  if (state.pageState === "reloading") {
    state.pageState = state.lastHeartbeatAt ? "alive" : "unknown";
  }

  state.reloadCompletePending = false;
  state.lastReloadCompletedAt = now();
  state.lastActionAt = state.lastReloadCompletedAt;
  state.lastAction = "tab reload completed";
  addEvent("RLD", state.tabId, "Tab reload completed");
  notifyTab(state);
}

function completeTabReload(state) {
  if (state.networkState !== "reloading" && state.pageState !== "reloading") {
    return;
  }

  const currentTime = now();
  const startedAt = state.lastReloadStartedAt || currentTime;
  const remainingMs = RELOAD_MIN_DISPLAY_MS - (currentTime - startedAt);

  if (remainingMs > 0) {
    if (!state.reloadCompletePending) {
      state.reloadCompletePending = true;
      setTimeout(() => {
        if (state.networkState === "reloading" || state.pageState === "reloading") {
          finishTabReload(state);
        }
      }, remainingMs);
    }
    notifyTab(state);
    return;
  }

  finishTabReload(state);
}

function reloadChatGptTab(state, callback) {
  markTabReloading(state, "tab reload requested");

  chrome.tabs.reload(state.tabId, {}, () => {
    if (chrome.runtime.lastError) {
      state.lastActionAt = now();
      state.lastAction = `reload failed: ${chrome.runtime.lastError.message}`;
      addEvent("ERR", state.tabId, "Tab reload failed", { error: chrome.runtime.lastError.message });
      notifyTab(state);
      callback?.({ ok: false, error: chrome.runtime.lastError.message, state: publicState(state) });
      return;
    }

    console.log("[CTR:BG] ChatGPT tab reload requested", {
      tabId: state.tabId,
    });
    notifyTab(state);
    callback?.({ ok: true, state: publicState(state) });
  });
}

function openFreshChatForCurrentWindow(callback) {
  getActiveChatGptTab((tab) => {
    if (!tab?.id) {
      callback?.({ ok: false, error: "No active tab found" });
      return;
    }

    openFreshChat(getTabState(tab.id), callback, tab.url);
  });
}

function openFreshChatForTab(tabId, callback) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.id) {
      callback?.({ ok: false, error: chrome.runtime.lastError?.message || "Tab not found" });
      return;
    }

    openFreshChat(getTabState(tab.id), callback, tab.url);
  });
}

function reloadChatGptTabById(tabId, callback) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.id) {
      callback?.({ ok: false, error: chrome.runtime.lastError?.message || "Tab not found" });
      return;
    }

    reloadChatGptTab(getTabState(tab.id), callback);
  });
}

function autoRecoverFrozenTab(state) {
  if (!settings.autoRecoverFrozenTabs) {
    return;
  }

  if (state.networkState !== "done" || state.pageState !== "frozen") {
    return;
  }

  const currentTime = now();
  if (state.lastAutoRecoverAt && currentTime - state.lastAutoRecoverAt < AUTO_RECOVER_DEBOUNCE_MS) {
    return;
  }

  state.lastAutoRecoverAt = currentTime;
  state.lastActionAt = currentTime;
  state.lastAction = "auto-recovery requested for frozen tab";
  addEvent("FRZ", state.tabId, "Auto-recovery requested for frozen tab");
  notifyTab(state);

  chrome.tabs.get(state.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.id) {
      state.lastActionAt = now();
      state.lastAction = `auto-recovery failed: ${chrome.runtime.lastError?.message || "tab not found"}`;
      addEvent("ERR", state.tabId, "Auto-recovery failed", { error: chrome.runtime.lastError?.message || "tab not found" });
      notifyTab(state);
      return;
    }

    console.warn("[CTR:BG] auto-recovering frozen ChatGPT tab", {
      sourceTabId: state.tabId,
      sourceUrl: tab.url,
    });
    openFreshChat(state, null, tab.url);
  });
}

function getActiveChatGptTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
    const activeTab = activeTabs?.[0];
    if (activeTab?.id && activeTab.url?.startsWith("https://chatgpt.com/")) {
      callback(activeTab);
      return;
    }

    chrome.tabs.query({ url: "https://chatgpt.com/*", currentWindow: true }, (chatTabs) => {
      callback(chatTabs?.[0] || activeTab || null);
    });
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (isChatGptBackendRequest(details)) {
      debugLog("backend request seen", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        type: details.type,
        url: details.url,
      });
      markBackendRequest(details);
    }

    if (!isGenerationRequest(details) || details.tabId < 0) {
      return;
    }

    const state = getTabState(details.tabId);
    state.networkState = "generating";
    state.currentRequestId = details.requestId;
    state.activeGenerationRequestId = details.requestId;
    state.generationStartedAt = now();
    state.lastDoneAt = null;
    state.lastErrorAt = null;
    state.lastError = null;
    state.lastStuckAt = null;
    state.lastBackendRequestAt = state.generationStartedAt;
    state.lastBackendRequestUrl = details.url;

    requests.set(details.requestId, {
      tabId: details.tabId,
      startedAt: state.generationStartedAt,
      url: details.url,
    });

    updateConversationFromTab(details.tabId, conversationPatchFromState(state));

    console.log("[CTR:BG] ChatGPT generation started", {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
    });
    addEvent("GEN", details.tabId, "Generation started", {
      requestId: details.requestId,
      url: details.url,
    });

    notifyTab(state);
  },
  REQUEST_FILTER,
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (isChatGptBackendRequest(details)) {
      debugLog("backend request completed", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        statusCode: details.statusCode,
        url: details.url,
      });
    }

    const request = requests.get(details.requestId);
    if (!request) {
      return;
    }

    const state = getTabState(request.tabId);
    if (state.activeGenerationRequestId && state.activeGenerationRequestId !== details.requestId) {
      addEvent("DESYNC", request.tabId, "Ignored completion for stale generation request", {
        requestId: details.requestId,
        activeGenerationRequestId: state.activeGenerationRequestId,
        url: request.url,
      });
      requests.delete(details.requestId);
      notifyTab(state);
      return;
    }

    state.networkState = "done";
    state.currentRequestId = null;
    state.activeGenerationRequestId = null;
    state.lastDoneAt = now();
    state.lastError = null;
    state.lastStuckAt = null;

    updateConversationFromTab(request.tabId, conversationPatchFromState(state));

    const durationMs = state.lastDoneAt - request.startedAt;
    console.log("[CTR:BG] ChatGPT generation completed", {
      requestId: details.requestId,
      tabId: request.tabId,
      statusCode: details.statusCode,
      durationMs,
      url: request.url,
    });
    addEvent("DONE", request.tabId, "Generation completed", {
      requestId: details.requestId,
      statusCode: details.statusCode,
      durationMs,
      url: request.url,
    });
    triggerSoundAlert(state, "DONE");

    requests.delete(details.requestId);
    notifyTab(state);
    autoRecoverFrozenTab(state);
  },
  REQUEST_FILTER,
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (isChatGptBackendRequest(details)) {
      debugLog("backend request error", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        error: details.error,
        url: details.url,
      });
    }

    const request = requests.get(details.requestId);
    if (!request) {
      return;
    }

    const state = getTabState(request.tabId);
    if (state.activeGenerationRequestId && state.activeGenerationRequestId !== details.requestId) {
      addEvent("DESYNC", request.tabId, "Ignored error for stale generation request", {
        requestId: details.requestId,
        activeGenerationRequestId: state.activeGenerationRequestId,
        error: details.error,
        url: request.url,
      });
      requests.delete(details.requestId);
      notifyTab(state);
      return;
    }

    state.networkState = "error";
    state.currentRequestId = null;
    state.activeGenerationRequestId = null;
    state.lastErrorAt = now();
    state.lastError = details.error;
    state.lastStuckAt = null;

    updateConversationFromTab(request.tabId, conversationPatchFromState(state));

    const durationMs = state.lastErrorAt - request.startedAt;
    console.warn("[CTR:BG] ChatGPT generation failed", {
      requestId: details.requestId,
      tabId: request.tabId,
      error: details.error,
      durationMs,
      url: request.url,
    });
    addEvent("ERR", request.tabId, "Generation failed", {
      requestId: details.requestId,
      error: details.error,
      durationMs,
      url: request.url,
    });
    triggerSoundAlert(state, "ERR");

    requests.delete(details.requestId);
    notifyTab(state);
  },
  REQUEST_FILTER,
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  if (message?.type === "watchdog-popup-state") {
    getActiveChatGptTab((tab) => {
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab found" });
        return;
      }

      const state = getTabState(tab.id);
      getChatGptTabs((tabsResponse) => {
        sendResponse({
          ok: true,
          state: publicState(state),
          tab: { id: tab.id, url: tab.url },
          tabs: tabsResponse.tabs || [],
          events: recentEvents(),
        });
      });
    });
    return true;
  }

  if (message?.type === "watchdog-popup-open-fresh-chat") {
    getActiveChatGptTab((tab) => {
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No ChatGPT tab found" });
        return;
      }

      openFreshChat(getTabState(tab.id), sendResponse, tab.url);
    });
    return true;
  }

  if (message?.type === "watchdog-popup-reload-tab") {
    getActiveChatGptTab((tab) => {
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No ChatGPT tab found" });
        return;
      }

      reloadChatGptTab(getTabState(tab.id), sendResponse);
    });
    return true;
  }

  if (message?.type === "watchdog-popup-open-tab-fresh-chat") {
    if (typeof message.tabId !== "number") {
      sendResponse({ ok: false, error: "Missing tabId" });
      return false;
    }

    openFreshChatForTab(message.tabId, sendResponse);
    return true;
  }

  if (message?.type === "watchdog-popup-reload-tab-by-id") {
    if (typeof message.tabId !== "number") {
      sendResponse({ ok: false, error: "Missing tabId" });
      return false;
    }

    reloadChatGptTabById(message.tabId, sendResponse);
    return true;
  }

  if (message?.type === "watchdog-popup-tabs-state") {
    getChatGptTabs(sendResponse);
    return true;
  }

  if (message?.type === "watchdog-popup-set-auto-recover") {
    settings.autoRecoverFrozenTabs = Boolean(message.enabled);
    chrome.storage.local.set({ autoRecoverFrozenTabs: settings.autoRecoverFrozenTabs }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      getActiveChatGptTab((tab) => {
        const state = tab?.id ? getTabState(tab.id) : null;
        if (state) {
          state.lastActionAt = now();
          state.lastAction = settings.autoRecoverFrozenTabs
            ? "auto-recovery enabled"
            : "auto-recovery disabled";
          addEvent("SET", state.tabId, state.lastAction);
          notifyTab(state);
          autoRecoverFrozenTab(state);
        }

        sendResponse({
          ok: true,
          state: state ? publicState(state) : null,
          settings: { ...settings, soundVolumePercent: soundVolumePercent() },
        });
      });
    });
    return true;
  }

  if (message?.type === "watchdog-popup-set-sound-alerts") {
    settings.soundAlerts = Boolean(message.enabled);
    chrome.storage.local.set({ soundAlerts: settings.soundAlerts }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      getActiveChatGptTab((tab) => {
        const state = tab?.id ? getTabState(tab.id) : null;
        if (state) {
          state.lastActionAt = now();
          state.lastAction = settings.soundAlerts ? "sound alerts enabled" : "sound alerts disabled";
          addEvent("SET", state.tabId, state.lastAction);
          notifyTab(state);
        }

        sendResponse({
          ok: true,
          state: state ? publicState(state) : null,
          settings: { ...settings, soundVolumePercent: soundVolumePercent() },
        });
      });
    });
    return true;
  }

  if (message?.type === "watchdog-popup-set-sound-volume") {
    settings.soundVolume = clampSoundVolume(message.volume);
    chrome.storage.local.set({ soundVolume: settings.soundVolume }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      getActiveChatGptTab((tab) => {
        const state = tab?.id ? getTabState(tab.id) : null;
        if (state) {
          state.lastActionAt = now();
          state.lastAction = `sound volume set to ${soundVolumePercent()}%`;
          addEvent("SET", state.tabId, state.lastAction);
          notifyTab(state);
        }

        sendResponse({
          ok: true,
          state: state ? publicState(state) : null,
          settings: { ...settings, soundVolumePercent: soundVolumePercent() },
        });
      });
    });
    return true;
  }

  if (message?.type === "watchdog-popup-test-sound") {
    const alertType = typeof message.alertType === "string" ? message.alertType.toUpperCase() : "DONE";
    if (!["DONE", "ERR", "FRZ"].includes(alertType)) {
      sendResponse({ ok: false, error: "Unsupported alert type" });
      return false;
    }

    getActiveChatGptTab((tab) => {
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No ChatGPT tab found" });
        return;
      }

      const state = getTabState(tab.id);
      addEvent("ALERT", state.tabId, `Test sound requested: ${alertType}`, { volume: soundVolumePercent() });
      chrome.tabs.sendMessage(
        state.tabId,
        { type: "watchdog-play-sound", alertType, volume: settings.soundVolume },
        () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message, state: publicState(state) });
            return;
          }

          sendResponse({
            ok: true,
            state: publicState(state),
            settings: { ...settings, soundVolumePercent: soundVolumePercent() },
          });
        },
      );
    });
    return true;
  }

  if (!senderTabId) {
    debugLog("message without tab", { message });
    return false;
  }

  const state = getTabState(senderTabId);

  if (message?.type === "watchdog-heartbeat") {
    state.lastHeartbeatAt = now();
    if (state.pageState !== "reloading") {
      state.pageState = "alive";
    }
    state.backgroundState = "connected";
    notifyTab(state);
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  if (message?.type === "watchdog-hello") {
    state.lastHeartbeatAt = now();
    if (state.pageState !== "reloading") {
      state.pageState = "alive";
    }
    state.backgroundState = "connected";
    console.log("[CTR:BG] content script connected", {
      tabId: senderTabId,
      url: sender.tab.url,
      message,
    });
    notifyTab(state);
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  if (message?.type === "watchdog-open-fresh-chat") {
    openFreshChat(state, sendResponse, sender.tab?.url);
    return true;
  }

  if (message?.type === "watchdog-get-state") {
    debugLog("state requested", { tabId: senderTabId });
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  debugLog("unknown message", { tabId: senderTabId, message });
  return false;
});


function isOpenFreshChatCommand(command) {
  return command === "open-fresh-chat" || command === "open_fresh_chat";
}

chrome.commands.onCommand.addListener((command) => {
  console.log("[CTR:BG] command received", { command });

  if (!isOpenFreshChatCommand(command)) {
    return;
  }

  console.log("[CTR:BG] opening fresh ChatGPT tab from hotkey", { command });

  openFreshChatForCurrentWindow((response) => {
    if (!response?.ok) {
      console.warn("[CTR:BG] hotkey open fresh chat failed", response);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab?.url || changeInfo.url || "";
  if (!url.startsWith("https://chatgpt.com/")) {
    return;
  }

  const state = getTabState(tabId);

  if (changeInfo.status === "loading") {
    if (state.networkState !== "generating") {
      markTabReloading(state, "tab started loading");
    }
    return;
  }

  if (changeInfo.status === "complete") {
    if (state.networkState === "reloading" || state.pageState === "reloading") {
      completeTabReload(state);
    }
  }
});

function markGenerationStuck(state, currentTime) {
  if (state.networkState !== "generating" || !state.generationStartedAt) {
    return false;
  }

  const generationAgeMs = currentTime - state.generationStartedAt;
  if (generationAgeMs < STUCK_GENERATION_TIMEOUT_MS) {
    return false;
  }

  state.networkState = "stuck";
  state.lastStuckAt = currentTime;
  state.lastActionAt = currentTime;
  state.lastAction = "generation marked stuck";
  updateConversationFromTab(state.tabId, conversationPatchFromState(state));
  console.warn("[CTR:BG] ChatGPT generation marked stuck", {
    tabId: state.tabId,
    generationAgeMs,
    requestId: state.currentRequestId,
  });
  addEvent("STUCK", state.tabId, "Generation marked stuck", {
    generationAgeMs,
    requestId: state.currentRequestId,
  });
  return true;
}


chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);

  for (const [requestId, request] of requests.entries()) {
    if (request.tabId === tabId) {
      requests.delete(requestId);
    }
  }
});

setInterval(() => {
  const currentTime = now();

  for (const state of tabs.values()) {
    let changed = false;

    if (
      state.pageState !== "reloading" &&
      state.lastHeartbeatAt &&
      currentTime - state.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS
    ) {
      if (state.pageState !== "frozen") {
        state.pageState = "frozen";
        const msSinceHeartbeat = currentTime - state.lastHeartbeatAt;
        console.warn("[CTR:BG] ChatGPT tab heartbeat missed", {
          tabId: state.tabId,
          msSinceHeartbeat,
          networkState: state.networkState,
        });
        addEvent("FRZ", state.tabId, "Page heartbeat missed", {
          msSinceHeartbeat,
          networkState: state.networkState,
        });
        triggerSoundAlert(state, "FRZ");
        changed = true;
      }
      autoRecoverFrozenTab(state);
    }

    if (markGenerationStuck(state, currentTime)) {
      changed = true;
    }

    if (state.networkState === "done" && state.lastDoneAt && currentTime - state.lastDoneAt > DONE_RESET_MS) {
      state.networkState = "idle";
      changed = true;
    }

    if (changed) {
      notifyTab(state);
    }
  }
}, WATCH_INTERVAL_MS);
