export function createRuntimeRouter({
  chromeApi,
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
  maxEventLogItems,
  minHeartbeatTimeoutMs,
  maxHeartbeatTimeoutMs,
  defaultHeartbeatTimeoutMs,
  minAutoRecoverCooldownMs,
  maxAutoRecoverCooldownMs,
  defaultAutoRecoverCooldownMs,
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
}) {
  const chrome = chromeApi;

  function attach() {
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
              events: recentEvents(maxEventLogItems, settings.debugMode),
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
    
    if (message?.type === "watchdog-popup-clear-events") {
      getActiveChatGptTab((tab) => {
        const state = tab?.id ? getTabState(tab.id) : null;
        clearEventLog(state?.tabId ?? null);
        if (state) {
          state.lastActionAt = now();
          state.lastAction = "event log cleared";
          notifyTab(state);
        }
    
        getChatGptTabs((tabsResponse) => {
          sendResponse({
            ok: true,
            state: state ? publicState(state) : null,
            tabs: tabsResponse.tabs || [],
            events: recentEvents(maxEventLogItems, settings.debugMode),
          });
        });
      });
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
              settings: publicSettings(),
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
              settings: publicSettings(),
            });
          });
        });
        return true;
      }
    
      if (message?.type === "watchdog-popup-set-desktop-notifications") {
        settings.desktopNotifications = Boolean(message.enabled);
        chrome.storage.local.set({ desktopNotifications: settings.desktopNotifications }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
    
          getActiveChatGptTab((tab) => {
            const state = tab?.id ? getTabState(tab.id) : null;
            if (state) {
              state.lastActionAt = now();
              state.lastAction = settings.desktopNotifications
                ? "desktop notifications enabled"
                : "desktop notifications disabled";
              addEvent("SET", state.tabId, state.lastAction);
              notifyTab(state);
            }
    
            sendResponse({
              ok: true,
              state: state ? publicState(state) : null,
              settings: publicSettings(),
            });
          });
        });
        return true;
      }
    
      if (message?.type === "watchdog-popup-set-debug-mode") {
        settings.debugMode = Boolean(message.enabled);
        chrome.storage.local.set({ debugMode: settings.debugMode }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
    
          getActiveChatGptTab((tab) => {
            const state = tab?.id ? getTabState(tab.id) : null;
            if (state) {
              state.lastActionAt = now();
              state.lastAction = settings.debugMode ? "debug mode enabled" : "debug mode disabled";
              addEvent("SET", state.tabId, state.lastAction);
              notifyTab(state);
            }
    
            sendResponse({
              ok: true,
              state: state ? publicState(state) : null,
              settings: publicSettings(),
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
              settings: publicSettings(),
            });
          });
        });
        return true;
      }
    
      if (message?.type === "watchdog-popup-set-heartbeat-timeout") {
        settings.heartbeatTimeoutMs = clampMs(
          Number(message.seconds) * 1000,
          minHeartbeatTimeoutMs,
          maxHeartbeatTimeoutMs,
          defaultHeartbeatTimeoutMs,
        );
        chrome.storage.local.set({ heartbeatTimeoutMs: settings.heartbeatTimeoutMs }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
    
          getActiveChatGptTab((tab) => {
            const state = tab?.id ? getTabState(tab.id) : null;
            if (state) {
              state.lastActionAt = now();
              state.lastAction = `heartbeat timeout set to ${secondsFromMs(settings.heartbeatTimeoutMs)}s`;
              addEvent("SET", state.tabId, state.lastAction);
              notifyTab(state);
            }
    
            sendResponse({
              ok: true,
              state: state ? publicState(state) : null,
              settings: publicSettings(),
            });
          });
        });
        return true;
      }
    
      if (message?.type === "watchdog-popup-set-auto-recover-cooldown") {
        settings.autoRecoverCooldownMs = clampMs(
          Number(message.seconds) * 1000,
          minAutoRecoverCooldownMs,
          maxAutoRecoverCooldownMs,
          defaultAutoRecoverCooldownMs,
        );
        chrome.storage.local.set({ autoRecoverCooldownMs: settings.autoRecoverCooldownMs }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
    
          getActiveChatGptTab((tab) => {
            const state = tab?.id ? getTabState(tab.id) : null;
            if (state) {
              state.lastActionAt = now();
              state.lastAction = `auto-recovery cooldown set to ${secondsFromMs(settings.autoRecoverCooldownMs)}s`;
              addEvent("SET", state.tabId, state.lastAction);
              notifyTab(state);
            }
    
            sendResponse({
              ok: true,
              state: state ? publicState(state) : null,
              settings: publicSettings(),
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
                settings: publicSettings(),
              });
            },
          );
        });
        return true;
      }
    
      if (message?.type === "watchdog-popup-test-notification") {
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
          addEvent("ALERT", state.tabId, `Test desktop notification requested: ${alertType}`);
          triggerDesktopNotification(state, alertType, { durationMs: generationDurationMs(state), force: true });
          sendResponse({
            ok: true,
            state: publicState(state),
            settings: publicSettings(),
          });
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
        if (state.pageState === "frozen") {
          resetAutoRecovery(state);
        }
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
        if (state.pageState === "frozen") {
          resetAutoRecovery(state);
        }
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
  }

  return { attach };
}
