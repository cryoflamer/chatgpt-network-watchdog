import {
  AUTO_RECOVER_MAX_ATTEMPTS,
  AUTO_RECOVER_RETRY_BASE_DELAY_MS,
  RELOAD_MIN_DISPLAY_MS,
} from "./constants.js";

export function createRecoveryController({
  chromeApi,
  now,
  settings,
  addEvent,
  notifyTab,
  publicState,
  getTabState,
  getActiveChatGptTab,
}) {
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

    chromeApi.tabs.create({ url: targetUrl, active: true }, (tab) => {
      if (chromeApi.runtime.lastError) {
        state.lastActionAt = now();
        state.lastAction = `open failed: ${chromeApi.runtime.lastError.message}`;
        addEvent("ERR", state.tabId, "Open fresh chat failed", { error: chromeApi.runtime.lastError.message });
        notifyTab(state);
        callback?.({ ok: false, error: chromeApi.runtime.lastError.message, state: publicState(state) });
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
    resetAutoRecovery(state);
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

    chromeApi.tabs.reload(state.tabId, {}, () => {
      if (chromeApi.runtime.lastError) {
        state.lastActionAt = now();
        state.lastAction = `reload failed: ${chromeApi.runtime.lastError.message}`;
        addEvent("ERR", state.tabId, "Tab reload failed", { error: chromeApi.runtime.lastError.message });
        notifyTab(state);
        callback?.({ ok: false, error: chromeApi.runtime.lastError.message, state: publicState(state) });
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
    chromeApi.tabs.get(tabId, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.id) {
        callback?.({ ok: false, error: chromeApi.runtime.lastError?.message || "Tab not found" });
        return;
      }

      openFreshChat(getTabState(tab.id), callback, tab.url);
    });
  }

  function reloadChatGptTabById(tabId, callback) {
    chromeApi.tabs.get(tabId, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.id) {
        callback?.({ ok: false, error: chromeApi.runtime.lastError?.message || "Tab not found" });
        return;
      }

      reloadChatGptTab(getTabState(tab.id), callback);
    });
  }

  function resetAutoRecovery(state) {
    state.autoRecoverAttempts = 0;
    state.autoRecoverGaveUpAt = null;
  }

  function nextAutoRecoverDelayMs(state) {
    const attempts = state.autoRecoverAttempts || 0;
    if (attempts <= 0) {
      return 0;
    }

    return Math.max(settings.autoRecoverCooldownMs, AUTO_RECOVER_RETRY_BASE_DELAY_MS * (2 ** (attempts - 1)));
  }

  function autoRecoverFrozenTab(state) {
    if (!settings.autoRecoverFrozenTabs) {
      return;
    }

    if (state.networkState !== "done" || state.pageState !== "frozen") {
      return;
    }

    const currentTime = now();
    const attempts = state.autoRecoverAttempts || 0;
    if (attempts >= AUTO_RECOVER_MAX_ATTEMPTS) {
      if (!state.autoRecoverGaveUpAt) {
        state.autoRecoverGaveUpAt = currentTime;
        state.lastActionAt = currentTime;
        state.lastAction = "auto-recovery gave up for frozen tab";
        addEvent("FRZ", state.tabId, "Auto-recovery gave up for frozen tab", {
          attempts,
          maxAttempts: AUTO_RECOVER_MAX_ATTEMPTS,
        });
        notifyTab(state);
      }
      return;
    }

    const retryDelayMs = nextAutoRecoverDelayMs(state);
    if (state.lastAutoRecoverAt && currentTime - state.lastAutoRecoverAt < retryDelayMs) {
      return;
    }

    const nextAttempt = attempts + 1;
    state.autoRecoverAttempts = nextAttempt;
    state.lastAutoRecoverAt = currentTime;
    state.lastActionAt = currentTime;
    state.lastAction = `auto-recovery attempt ${nextAttempt}/${AUTO_RECOVER_MAX_ATTEMPTS} for frozen tab`;
    addEvent("FRZ", state.tabId, "Auto-recovery attempt for frozen tab", {
      attempt: nextAttempt,
      maxAttempts: AUTO_RECOVER_MAX_ATTEMPTS,
      retryDelayMs,
    });
    notifyTab(state);

    chromeApi.tabs.get(state.tabId, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.id) {
        state.lastActionAt = now();
        state.lastAction = `auto-recovery failed: ${chromeApi.runtime.lastError?.message || "tab not found"}`;
        addEvent("ERR", state.tabId, "Auto-recovery failed", {
          attempt: nextAttempt,
          maxAttempts: AUTO_RECOVER_MAX_ATTEMPTS,
          error: chromeApi.runtime.lastError?.message || "tab not found",
        });
        notifyTab(state);
        return;
      }

      console.warn("[CTR:BG] auto-recovering frozen ChatGPT tab", {
        sourceTabId: state.tabId,
        sourceUrl: tab.url,
        attempt: nextAttempt,
        maxAttempts: AUTO_RECOVER_MAX_ATTEMPTS,
      });
      openFreshChat(state, null, tab.url);
    });
  }

  return {
    openFreshChat,
    markTabReloading,
    completeTabReload,
    reloadChatGptTab,
    openFreshChatForCurrentWindow,
    openFreshChatForTab,
    reloadChatGptTabById,
    resetAutoRecovery,
    autoRecoverFrozenTab,
  };
}
