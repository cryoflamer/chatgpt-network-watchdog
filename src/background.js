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
import { createCommandController } from "./background/commands.js";
import { createTabLifecycleController } from "./background/tab-lifecycle.js";
import { createNetworkController } from "./background/network-controller.js";
import { isChatGptBackendRequest } from "./background/network.js";
import { createConversationStore } from "./background/conversations.js";

const requests = new Map();
const tabs = createTabRegistry();
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

const {
  conversationPatchFromState,
  syncStateFromConversation,
  updateConversationFromTab,
} = createConversationStore({
  chromeApi: chrome,
  now,
  addEvent,
  getTabState,
  notifyTab,
});

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

const networkController = createNetworkController({
  chromeApi: chrome,
  generationPath: GENERATION_PATH,
  requestFilter: REQUEST_FILTER,
  requests,
  now,
  debugLog,
  addEvent,
  getTabState,
  notifyTab,
  markBackendRequest,
  resetAutoRecovery,
  updateConversationFromTab,
  conversationPatchFromState,
  triggerAlerts,
  autoRecoverFrozenTab,
});
networkController.attach();

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


const commandController = createCommandController({
  chromeApi: chrome,
  openFreshChatForCurrentWindow,
});
commandController.attach();

const tabLifecycle = createTabLifecycleController({
  chromeApi: chrome,
  tabs,
  requests,
  getTabState,
  markTabReloading,
  completeTabReload,
});
tabLifecycle.attach();

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
