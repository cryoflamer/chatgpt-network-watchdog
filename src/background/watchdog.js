import {
  DONE_RESET_MS,
  STUCK_BACKEND_QUIET_MS,
  STUCK_GENERATION_TIMEOUT_MS,
  WATCH_INTERVAL_MS,
} from "./constants.js";

export function createWatchdogController({
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
}) {
  function markGenerationStuck(state, currentTime) {
    if (state.networkState !== "generating" || !state.generationStartedAt) {
      return false;
    }

    if (state.pageState === "reloading" || state.networkState === "reloading") {
      return false;
    }

    const generationAgeMs = currentTime - state.generationStartedAt;
    if (generationAgeMs < STUCK_GENERATION_TIMEOUT_MS) {
      return false;
    }

    const lastActivityAt = Math.max(state.lastBackendRequestAt || 0, state.generationStartedAt || 0);
    const backendQuietMs = currentTime - lastActivityAt;
    if (backendQuietMs < STUCK_BACKEND_QUIET_MS) {
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
      backendQuietMs,
      requestId: state.currentRequestId,
    });
    addEvent("STUCK", state.tabId, "Generation marked stuck", {
      generationAgeMs,
      backendQuietMs,
      requestId: state.currentRequestId,
    });
    return true;
  }

  function checkTabState(state, currentTime) {
    let changed = false;

    if (
      state.pageState !== "reloading" &&
      state.lastHeartbeatAt &&
      currentTime - state.lastHeartbeatAt > settings.heartbeatTimeoutMs
    ) {
      if (state.pageState !== "frozen") {
        state.pageState = "frozen";
        const msSinceHeartbeat = currentTime - state.lastHeartbeatAt;
        console.warn("[CTR:BG] ChatGPT tab heartbeat missed", {
          tabId: state.tabId,
          msSinceHeartbeat,
          networkState: state.networkState,
        });
        if (state.networkState === "done") {
          addEvent("FRZ", state.tabId, "Page heartbeat missed after response completion", {
            msSinceHeartbeat,
            networkState: state.networkState,
          });
          triggerAlerts(state, "FRZ", { msSinceHeartbeat });
        } else if (state.networkState === "idle") {
          addEvent("STALE", state.tabId, "Idle tab heartbeat became stale", {
            msSinceHeartbeat,
            networkState: state.networkState,
          });
        } else {
          debugLog("heartbeat missed without freeze alert", {
            tabId: state.tabId,
            msSinceHeartbeat,
            networkState: state.networkState,
          });
        }
        changed = true;
      }
      if (state.networkState === "done") {
        autoRecoverFrozenTab(state);
      }
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

  function tick() {
    const currentTime = now();

    for (const state of tabs.values()) {
      checkTabState(state, currentTime);
    }
  }

  function start() {
    return setInterval(tick, WATCH_INTERVAL_MS);
  }

  return {
    start,
  };
}
