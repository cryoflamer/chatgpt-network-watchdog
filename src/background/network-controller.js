import {
  isChatGptBackendRequest,
  isGenerationRequest,
} from "./network.js";

export function createNetworkController({
  chromeApi,
  generationPath,
  requestFilter,
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
}) {
  function handleBeforeRequest(details) {
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

    if (!isGenerationRequest(details, generationPath) || details.tabId < 0) {
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
  }

  function handleCompleted(details) {
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
  }

  function handleErrorOccurred(details) {
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
  }

  function attach() {
    chromeApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, requestFilter);
    chromeApi.webRequest.onCompleted.addListener(handleCompleted, requestFilter);
    chromeApi.webRequest.onErrorOccurred.addListener(handleErrorOccurred, requestFilter);
  }

  return { attach };
}
