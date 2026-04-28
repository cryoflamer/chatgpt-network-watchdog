export function createTabLifecycleController({
  chromeApi,
  tabs,
  requests,
  getTabState,
  markTabReloading,
  completeTabReload,
}) {
  function handleTabUpdated(tabId, changeInfo, tab) {
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
  }

  function handleTabRemoved(tabId) {
    tabs.delete(tabId);

    for (const [requestId, request] of requests.entries()) {
      if (request.tabId === tabId) {
        requests.delete(requestId);
      }
    }
  }

  function attach() {
    chromeApi.tabs.onUpdated.addListener(handleTabUpdated);
    chromeApi.tabs.onRemoved.addListener(handleTabRemoved);
  }

  return {
    attach,
  };
}
