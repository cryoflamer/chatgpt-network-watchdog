const GENERATION_PATH = "/backend-api/f/conversation";
const HEARTBEAT_TIMEOUT_MS = 15000;
const WATCH_INTERVAL_MS = 3000;

const requests = new Map();
const tabs = new Map();

function now() {
  return Date.now();
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
      lastHeartbeatAt: 0,
      currentRequestId: null,
      generationStartedAt: null,
      lastDoneAt: null,
      lastErrorAt: null,
      lastError: null,
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
    generationDurationMs: generationDurationMs(state),
    lastDoneAt: state.lastDoneAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
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

    requests.set(details.requestId, {
      tabId: details.tabId,
      startedAt: state.generationStartedAt,
      url: details.url,
    });

    console.log("ChatGPT generation started", {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
    });

    notifyTab(state);
  },
  { urls: ["https://chatgpt.com/backend-api/f/conversation"] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) {
      return;
    }

    const state = getTabState(request.tabId);
    state.networkState = "done";
    state.currentRequestId = null;
    state.lastDoneAt = now();
    state.lastError = null;

    console.log("ChatGPT generation completed", {
      requestId: details.requestId,
      tabId: request.tabId,
      statusCode: details.statusCode,
      durationMs: state.lastDoneAt - request.startedAt,
      url: request.url,
    });

    requests.delete(details.requestId);
    notifyTab(state);
  },
  { urls: ["https://chatgpt.com/backend-api/f/conversation"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) {
      return;
    }

    const state = getTabState(request.tabId);
    state.networkState = "error";
    state.currentRequestId = null;
    state.lastErrorAt = now();
    state.lastError = details.error;

    console.warn("ChatGPT generation failed", {
      requestId: details.requestId,
      tabId: request.tabId,
      error: details.error,
      durationMs: state.lastErrorAt - request.startedAt,
      url: request.url,
    });

    requests.delete(details.requestId);
    notifyTab(state);
  },
  { urls: ["https://chatgpt.com/backend-api/f/conversation"] },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab?.id) {
    return false;
  }

  const state = getTabState(sender.tab.id);

  if (message?.type === "watchdog-heartbeat") {
    state.lastHeartbeatAt = now();
    state.pageState = "alive";
    notifyTab(state);
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

  if (message?.type === "watchdog-get-state") {
    sendResponse({ ok: true, state: publicState(state) });
    return true;
  }

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
        console.warn("ChatGPT tab heartbeat missed", {
          tabId: state.tabId,
          msSinceHeartbeat: currentTime - state.lastHeartbeatAt,
          networkState: state.networkState,
        });
        notifyTab(state);
      }
    }
  }
}, WATCH_INTERVAL_MS);
