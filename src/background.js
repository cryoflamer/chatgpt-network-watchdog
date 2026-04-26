const GENERATION_PATH = "/backend-api/f/conversation";
const HEARTBEAT_TIMEOUT_MS = 15000;
const WATCH_INTERVAL_MS = 3000;
const REQUEST_FILTER = { urls: ["https://chatgpt.com/*", "https://*.chatgpt.com/*"] };
const DIAGNOSTIC_LOG = false;

const requests = new Map();
const tabs = new Map();

console.log("[CTR:BG] service worker loaded", {
  href: chrome.runtime.getURL("src/background.js"),
});

function now() {
  return Date.now();
}

function debugLog(message, payload = {}) {
  if (!DIAGNOSTIC_LOG) {
    return;
  }

  console.log(`[CTR:BG] ${message}`, payload);
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

function getTabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      tabId,
      networkState: "idle",
      pageState: "unknown",
      backgroundState: "connected",
      lastHeartbeatAt: 0,
      currentRequestId: null,
      generationStartedAt: null,
      lastDoneAt: null,
      lastErrorAt: null,
      lastError: null,
      lastBackendRequestAt: null,
      lastBackendRequestUrl: null,
      lastActionAt: null,
      lastAction: null,
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
    lastDoneAt: state.lastDoneAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastBackendRequestAt: state.lastBackendRequestAt,
    lastBackendRequestUrl: state.lastBackendRequestUrl,
    lastActionAt: state.lastActionAt,
    lastAction: state.lastAction,
  };
}

function updateBadge(state) {
  const textByState = {
    generating: "GEN",
    done: "DONE",
    error: "ERR",
    idle: "IDLE",
  };

  const colorByState = {
    generating: "#7a1f1f",
    done: "#1f6f3a",
    error: "#7a5a1f",
    idle: "#444444",
  };

  chrome.action.setBadgeText({
    tabId: state.tabId,
    text: state.pageState === "frozen" ? "FRZ" : textByState[state.networkState] || "",
  });
  chrome.action.setBadgeBackgroundColor({
    tabId: state.tabId,
    color: state.pageState === "frozen" ? "#5c2d91" : colorByState[state.networkState] || "#444444",
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

      if (details.tabId >= 0) {
        const state = getTabState(details.tabId);
        state.lastBackendRequestAt = now();
        state.lastBackendRequestUrl = details.url;
        notifyTab(state);
      }
    }

    if (!isGenerationRequest(details) || details.tabId < 0) {
      return;
    }

    const state = getTabState(details.tabId);
    state.networkState = "generating";
    state.currentRequestId = details.requestId;
    state.generationStartedAt = now();
    state.lastDoneAt = null;
    state.lastErrorAt = null;
    state.lastError = null;
    state.lastBackendRequestAt = state.generationStartedAt;
    state.lastBackendRequestUrl = details.url;

    requests.set(details.requestId, {
      tabId: details.tabId,
      startedAt: state.generationStartedAt,
      url: details.url,
    });

    console.log("[CTR:BG] ChatGPT generation started", {
      requestId: details.requestId,
      tabId: details.tabId,
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
    state.networkState = "done";
    state.currentRequestId = null;
    state.lastDoneAt = now();
    state.lastError = null;

    console.log("[CTR:BG] ChatGPT generation completed", {
      requestId: details.requestId,
      tabId: request.tabId,
      statusCode: details.statusCode,
      durationMs: state.lastDoneAt - request.startedAt,
      url: request.url,
    });

    requests.delete(details.requestId);
    notifyTab(state);
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
    state.networkState = "error";
    state.currentRequestId = null;
    state.lastErrorAt = now();
    state.lastError = details.error;

    console.warn("[CTR:BG] ChatGPT generation failed", {
      requestId: details.requestId,
      tabId: request.tabId,
      error: details.error,
      durationMs: state.lastErrorAt - request.startedAt,
      url: request.url,
    });

    requests.delete(details.requestId);
    notifyTab(state);
  },
  REQUEST_FILTER,
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab?.id) {
    debugLog("message without tab", { message });
    return false;
  }

  const state = getTabState(sender.tab.id);

  if (message?.type === "watchdog-heartbeat") {
    state.lastHeartbeatAt = now();
    state.pageState = "alive";
    state.backgroundState = "connected";
    notifyTab(state);
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  if (message?.type === "watchdog-hello") {
    state.lastHeartbeatAt = now();
    state.pageState = "alive";
    state.backgroundState = "connected";
    console.log("[CTR:BG] content script connected", {
      tabId: sender.tab.id,
      url: sender.tab.url,
      message,
    });
    notifyTab(state);
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  if (message?.type === "watchdog-open-fresh-chat") {
    chrome.tabs.create({ url: "https://chatgpt.com/", active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        state.lastActionAt = now();
        state.lastAction = `open failed: ${chrome.runtime.lastError.message}`;
        notifyTab(state);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message, state: publicState(state) });
        return;
      }

      state.lastActionAt = now();
      state.lastAction = `fresh chat opened: ${tab?.id ?? "unknown"}`;
      console.log("[CTR:BG] fresh ChatGPT tab opened", {
        sourceTabId: sender.tab.id,
        newTabId: tab?.id,
      });
      notifyTab(state);
      sendResponse({ ok: true, tabId: tab?.id, state: publicState(state) });
    });
    return true;
  }

  if (message?.type === "watchdog-get-state") {
    debugLog("state requested", { tabId: sender.tab.id });
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  debugLog("unknown message", { tabId: sender.tab.id, message });
  return false;
});

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
    if (state.lastHeartbeatAt && currentTime - state.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      if (state.pageState !== "frozen") {
        state.pageState = "frozen";
        console.warn("[CTR:BG] ChatGPT tab heartbeat missed", {
          tabId: state.tabId,
          msSinceHeartbeat: currentTime - state.lastHeartbeatAt,
          networkState: state.networkState,
        });
        notifyTab(state);
      }
    }
  }
}, WATCH_INTERVAL_MS);
