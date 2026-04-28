function compactChatTitle(title) {
  const normalized = String(title || "ChatGPT").replace(/\s*(?:\||—|-)\s*ChatGPT\s*$/i, "").trim();
  return normalized || "ChatGPT chat";
}

function notificationText(alertType, state, details = {}, tab = null, generationDurationMs) {
  const chatTitle = compactChatTitle(details.chatTitle || tab?.title);
  const title = `ChatGPT: ${chatTitle}`;

  if (alertType === "DONE") {
    return {
      title,
      message: `Response ready after ${((details.durationMs ?? generationDurationMs(state) ?? 0) / 1000).toFixed(1)}s`,
    };
  }

  if (alertType === "ERR") {
    return {
      title,
      message: state.lastError || details.error || "Generation failed",
    };
  }

  if (alertType === "FRZ") {
    return {
      title,
      message: "Response is ready, but the tab heartbeat is stale.",
    };
  }

  return { title, message: alertType };
}

export function createAlertController({
  chromeApi,
  now,
  settings,
  addEvent,
  soundVolumePercent,
  generationDurationMs,
  soundAlertDebounceMs,
  notificationDebounceMs,
}) {
  let lastSoundAlertAt = 0;
  let lastNotificationAt = 0;
  const notificationTargets = new Map();

  function triggerSoundAlert(state, alertType) {
    if (!settings.soundAlerts || !state?.tabId) {
      return;
    }

    const currentTime = now();
    if (currentTime - lastSoundAlertAt < soundAlertDebounceMs) {
      return;
    }
    lastSoundAlertAt = currentTime;

    addEvent("ALERT", state.tabId, `Sound alert requested: ${alertType}`, { volume: soundVolumePercent() });
    chromeApi.tabs.sendMessage(
      state.tabId,
      { type: "watchdog-play-sound", alertType, volume: settings.soundVolume },
      () => {
        void chromeApi.runtime.lastError;
      },
    );
  }

  function createDesktopNotification(state, alertType, details, tab) {
    const currentTime = now();
    const text = notificationText(alertType, state, details, tab, generationDurationMs);
    const notificationId = `cnw-${state.tabId}-${alertType.toLowerCase()}-${currentTime}`;

    notificationTargets.set(notificationId, {
      tabId: state.tabId,
      windowId: tab?.windowId ?? null,
      url: tab?.url || details.url || null,
      alertType,
      createdAt: currentTime,
    });

    chromeApi.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: chromeApi.runtime.getURL("icons/icon128.png"),
        title: text.title,
        message: text.message,
        priority: alertType === "ERR" || alertType === "FRZ" ? 1 : 0,
      },
      () => {
        if (chromeApi.runtime.lastError) {
          notificationTargets.delete(notificationId);
          addEvent("ERR", state.tabId, "Desktop notification failed", { error: chromeApi.runtime.lastError.message });
          return;
        }

        addEvent("ALERT", state.tabId, `Desktop notification sent: ${alertType}`, {
          notificationId,
          title: text.title,
          chatTitle: compactChatTitle(tab?.title),
        });
      },
    );
  }

  function triggerDesktopNotification(state, alertType, details = {}) {
    if ((!settings.desktopNotifications && !details.force) || !state?.tabId) {
      return;
    }

    const currentTime = now();
    if (currentTime - lastNotificationAt < notificationDebounceMs) {
      return;
    }
    lastNotificationAt = currentTime;

    chromeApi.tabs.get(state.tabId, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.id) {
        createDesktopNotification(state, alertType, details, null);
        return;
      }

      createDesktopNotification(state, alertType, details, tab);
    });
  }

  function triggerAlerts(state, alertType, details = {}) {
    triggerSoundAlert(state, alertType);
    triggerDesktopNotification(state, alertType, details);
  }

  chromeApi.notifications.onClicked.addListener((notificationId) => {
    const target = notificationTargets.get(notificationId);
    if (!target?.tabId) {
      return;
    }

    chromeApi.tabs.update(target.tabId, { active: true }, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.id) {
        addEvent("ERR", target.tabId, "Notification click failed", {
          notificationId,
          error: chromeApi.runtime.lastError?.message || "tab not found",
        });
        notificationTargets.delete(notificationId);
        return;
      }

      const windowId = tab.windowId ?? target.windowId;
      if (typeof windowId === "number") {
        chromeApi.windows.update(windowId, { focused: true }, () => {
          void chromeApi.runtime.lastError;
        });
      }

      addEvent("OPEN", target.tabId, "Notification clicked; tab focused", {
        notificationId,
        alertType: target.alertType,
      });
      notificationTargets.delete(notificationId);
      chromeApi.notifications.clear(notificationId, () => {
        void chromeApi.runtime.lastError;
      });
    });
  });

  chromeApi.notifications.onClosed.addListener((notificationId) => {
    notificationTargets.delete(notificationId);
  });

  return {
    triggerAlerts,
    triggerDesktopNotification,
  };
}
