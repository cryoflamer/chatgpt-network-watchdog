export function createBadgeController({ chromeApi, generationDurationMs }) {
  function badgeForState(state) {
    if (state.networkState === "reloading" || state.pageState === "reloading") {
      return { text: "R", color: "#1d4ed8", label: "Reloading" };
    }

    if (state.networkState === "error") {
      return { text: "E", color: "#991b1b", label: "Error" };
    }

    if (state.networkState === "stuck") {
      return { text: "S", color: "#b45309", label: "Stuck" };
    }

    if (state.networkState === "generating") {
      return { text: "G", color: "#7a5a1f", label: "Generating" };
    }

    if (state.networkState === "done" && state.pageState === "frozen") {
      return { text: "F", color: "#5c2d91", label: "Frozen" };
    }

    if (state.networkState === "idle" && state.pageState === "frozen") {
      return { text: "L", color: "#4b5563", label: "Stale" };
    }

    if (state.networkState === "done") {
      return { text: "D", color: "#1f6f3a", label: "Done" };
    }

    return { text: "", color: "#444444", label: "Idle" };
  }

  function badgeTitle(state, badge) {
    const parts = [`ChatGPT Network Watchdog: ${badge.label}`];
    if (state.networkState === "generating" || state.networkState === "stuck") {
      parts.push(`running ${(generationDurationMs(state) / 1000).toFixed(1)}s`);
    }
    if (state.lastError) {
      parts.push(state.lastError);
    }
    if (state.lastBackendRequestUrl) {
      try {
        parts.push(new URL(state.lastBackendRequestUrl).pathname);
      } catch (_error) {
        parts.push(state.lastBackendRequestUrl);
      }
    }
    return parts.join(" · ");
  }

  function updateBadge(state) {
    const badge = badgeForState(state);

    chromeApi.action.setBadgeText({
      tabId: state.tabId,
      text: badge.text,
    });
    chromeApi.action.setBadgeBackgroundColor({
      tabId: state.tabId,
      color: badge.color,
    });
    chromeApi.action.setTitle({
      tabId: state.tabId,
      title: badgeTitle(state, badge),
    });
  }

  return {
    updateBadge,
  };
}
