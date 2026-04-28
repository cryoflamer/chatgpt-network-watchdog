import {
  AUTO_RECOVER_MAX_ATTEMPTS,
  DEBUG_EVENT_TYPES,
  DEFAULT_AUTO_RECOVER_COOLDOWN_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SOUND_VOLUME,
  GENERATION_PATH,
  MAX_AUTO_RECOVER_COOLDOWN_MS,
  MAX_EVENT_LOG_ITEMS,
  MAX_HEARTBEAT_TIMEOUT_MS,
  MIN_AUTO_RECOVER_COOLDOWN_MS,
  MIN_HEARTBEAT_TIMEOUT_MS,
  NOTIFICATION_DEBOUNCE_MS,
  REQUEST_FILTER,
  SOUND_ALERT_DEBOUNCE_MS,
} from "./background/constants.js";
import { createEventLog } from "./background/event-log.js";
import { createSettingsStore } from "./background/settings.js";
import { createTabRegistry } from "./background/tabs.js";
import { createAlertController } from "./background/alerts.js";
import { createRecoveryController } from "./background/recovery.js";
import { createWatchdogController } from "./background/watchdog.js";
import { createBadgeController } from "./background/badge.js";
import { createRuntimeRouter } from "./background/runtime.js";
import {
  conversationIdFromUrl,
  isChatGptBackendRequest,
  isGenerationRequest,
} from "./background/network.js";

const requests = new Map();
const tabs = createTabRegistry();
const conversations = new Map();
const settingsStore = createSettingsStore({
  storage: chrome.storage.local,
  defaults: {
    autoRecoverFrozenTabs: false,
    soundAlerts: false,
    desktopNotifications: false,
    soundVolume: DEFAULT_SOUND_VOLUME,
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    autoRecoverCooldownMs: DEFAULT_AUTO_RECOVER_COOLDOWN_MS,
    debugMode: false,
  },
  limits: {
    heartbeatTimeoutMs: {
      min: MIN_HEARTBEAT_TIMEOUT_MS,
      max: MAX_HEARTBEAT_TIMEOUT_MS,
    },
    autoRecoverCooldownMs: {
      min: MIN_AUTO_RECOVER_COOLDOWN_MS,
      max: MAX_AUTO_RECOVER_COOLDOWN_MS,
    },
  },
});
const {
  settings,
  clampMs,
  clampSoundVolume,
  secondsFromMs,
  soundVolumePercent,
  publicSettings,
} = settingsStore;

console.log("[CTR:BG] service worker loaded", {
  href: chrome.runtime.getURL("src/background.js"),
});

settingsStore.load();

function now() {
  return Date.now();
}

function debugLog(message, payload = {}) {
  if (!settings.debugMode) {
    return;
  }

  console.log(`[CTR:BG] ${message}`, payload);
}


const {
  addEvent,
  recentEvents,
  clearEventLog,
} = createEventLog({
  now,
  maxItems: MAX_EVENT_LOG_ITEMS,
  debugEventTypes: DEBUG_EVENT_TYPES,
});

const {
  triggerAlerts,
  triggerDesktopNotification,
} = createAlertController({
  chromeApi: chrome,
  now,
  settings,
  addEvent,
  soundVolumePercent,
  generationDurationMs,
  soundAlertDebounceMs: SOUND_ALERT_DEBOUNCE_MS,
  notificationDebounceMs: NOTIFICATION_DEBOUNCE_MS,
});

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
      autoRecoverAttempts: 0,
      autoRecoverGaveUpAt: null,
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
    autoRecoverAttempts: state.autoRecoverAttempts || 0,
    autoRecoverMaxAttempts: AUTO_RECOVER_MAX_ATTEMPTS,
    autoRecoverGaveUpAt: state.autoRecoverGaveUpAt || null,
    lastReloadStartedAt: state.lastReloadStartedAt,
    lastReloadCompletedAt: state.lastReloadCompletedAt,
    settings: publicSettings(),
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

const { updateBadge } = createBadgeController({
  chromeApi: chrome,
  generationDurationMs,
});

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

const {
  openFreshChat,
  markTabReloading,
  completeTabReload,
  reloadChatGptTab,
  openFreshChatForCurrentWindow,
  openFreshChatForTab,
  reloadChatGptTabById,
  resetAutoRecovery,
  autoRecoverFrozenTab,
} = createRecoveryController({
  chromeApi: chrome,
  now,
  settings,
  addEvent,
  notifyTab,
  publicState,
  getTabState,
  getActiveChatGptTab,
});

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

    if (!isGenerationRequest(details, GENERATION_PATH) || details.tabId < 0) {
      return;
    }

    const state = getTabState(details.tabId);
    state.networkState = "generating";
    resetAutoRecovery(state);
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
    triggerAlerts(state, "DONE", { durationMs });

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
    resetAutoRecovery(state);
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
    triggerAlerts(state, "ERR", { durationMs, error: details.error });

    requests.delete(details.requestId);
    notifyTab(state);
  },
  REQUEST_FILTER,
);

const runtime = createRuntimeRouter({
  chromeApi: chrome,
  settings,
  debugLog,
  now,
  addEvent,
  recentEvents,
  clearEventLog,
  publicSettings,
  clampMs,
  clampSoundVolume,
  secondsFromMs,
  soundVolumePercent,
  maxEventLogItems: MAX_EVENT_LOG_ITEMS,
  minHeartbeatTimeoutMs: MIN_HEARTBEAT_TIMEOUT_MS,
  maxHeartbeatTimeoutMs: MAX_HEARTBEAT_TIMEOUT_MS,
  defaultHeartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  minAutoRecoverCooldownMs: MIN_AUTO_RECOVER_COOLDOWN_MS,
  maxAutoRecoverCooldownMs: MAX_AUTO_RECOVER_COOLDOWN_MS,
  defaultAutoRecoverCooldownMs: DEFAULT_AUTO_RECOVER_COOLDOWN_MS,
  getActiveChatGptTab,
  getChatGptTabs,
  getTabState,
  publicState,
  notifyTab,
  resetAutoRecovery,
  autoRecoverFrozenTab,
  openFreshChat,
  openFreshChatForTab,
  reloadChatGptTab,
  reloadChatGptTabById,
  triggerDesktopNotification,
  generationDurationMs,
});
runtime.attach();


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

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);

  for (const [requestId, request] of requests.entries()) {
    if (request.tabId === tabId) {
      requests.delete(requestId);
    }
  }
});

const watchdog = createWatchdogController({
  now,
  tabs,
  settings,
  addEvent,
  debugLog,
  triggerAlerts,
  autoRecoverFrozenTab,
  notifyTab,
  updateConversationFromTab,
  conversationPatchFromState,
});

watchdog.start();
