import { conversationIdFromUrl } from "./network.js";

export function createConversationStore({
  chromeApi,
  now,
  addEvent,
  getTabState,
  notifyTab,
}) {
  const conversations = new Map();

  function conversationPatchFromState(state) {
    return {
      networkState: state.networkState,
      generationStartedAt: state.generationStartedAt,
      lastDoneAt: state.lastDoneAt,
      lastErrorAt: state.lastErrorAt,
      lastError: state.lastError,
      lastStuckAt: state.lastStuckAt,
      lastBackendRequestAt: state.lastBackendRequestAt,
      lastBackendRequestUrl: state.lastBackendRequestUrl,
    };
  }

  function updateConversationState(conversationId, patch) {
    if (!conversationId) {
      return;
    }

    const currentTime = now();
    const previous = conversations.get(conversationId) || {};
    conversations.set(conversationId, {
      ...previous,
      ...patch,
      conversationId,
      updatedAt: currentTime,
    });
  }

  function canMirrorConversationState(state, conversation) {
    if (!conversation || !conversation.updatedAt) {
      return false;
    }

    if (state.networkState === "generating" && conversation.networkState !== "generating") {
      const localStartedAt = state.generationStartedAt || 0;
      const conversationUpdatedAt = conversation.updatedAt || 0;
      if (localStartedAt && conversationUpdatedAt < localStartedAt) {
        addEvent("DESYNC", state.tabId, "Ignored stale conversation state during generation", {
          localNetworkState: state.networkState,
          conversationNetworkState: conversation.networkState || "unknown",
          localStartedAt,
          conversationUpdatedAt,
        });
        return false;
      }
    }

    return true;
  }

  function syncStateFromConversation(state, tabUrl) {
    const conversationId = conversationIdFromUrl(tabUrl) || state.conversationId;
    if (!conversationId) {
      return false;
    }

    if (state.networkState === "reloading" || state.pageState === "reloading") {
      return false;
    }

    state.conversationId = conversationId;
    const conversation = conversations.get(conversationId);
    if (!canMirrorConversationState(state, conversation)) {
      return false;
    }

    if (state.mirroredConversationUpdatedAt && state.mirroredConversationUpdatedAt >= conversation.updatedAt) {
      return false;
    }

    const shouldMirror =
      conversation.networkState === "generating" ||
      state.mirroredConversationState ||
      state.networkState === "idle" ||
      !state.generationStartedAt;

    if (!shouldMirror) {
      return false;
    }

    state.networkState = conversation.networkState || state.networkState;
    state.generationStartedAt = conversation.generationStartedAt || state.generationStartedAt;
    state.lastDoneAt = conversation.lastDoneAt || null;
    state.lastErrorAt = conversation.lastErrorAt || null;
    state.lastError = conversation.lastError || null;
    state.lastStuckAt = conversation.lastStuckAt || null;
    state.lastBackendRequestAt = conversation.lastBackendRequestAt || state.lastBackendRequestAt;
    state.lastBackendRequestUrl = conversation.lastBackendRequestUrl || state.lastBackendRequestUrl;
    if (conversation.networkState !== "generating") {
      state.currentRequestId = null;
      state.activeGenerationRequestId = null;
    }
    state.mirroredConversationState = true;
    state.mirroredConversationUpdatedAt = conversation.updatedAt;

    return true;
  }

  function syncKnownTabsForConversation(conversationId) {
    chromeApi.tabs.query({ url: "https://chatgpt.com/*" }, (chatTabs) => {
      if (chromeApi.runtime.lastError) {
        return;
      }

      for (const tab of chatTabs || []) {
        if (typeof tab.id !== "number" || conversationIdFromUrl(tab.url) !== conversationId) {
          continue;
        }

        const state = getTabState(tab.id);
        if (syncStateFromConversation(state, tab.url)) {
          notifyTab(state);
        }
      }
    });
  }

  function updateConversationFromTab(tabId, patch) {
    chromeApi.tabs.get(tabId, (tab) => {
      if (chromeApi.runtime.lastError || !tab?.url) {
        return;
      }

      const conversationId = conversationIdFromUrl(tab.url);
      if (!conversationId) {
        return;
      }

      const state = getTabState(tabId);
      state.conversationId = conversationId;
      updateConversationState(conversationId, {
        ...patch,
        sourceTabId: tabId,
        sourceUrl: tab.url,
      });
      syncKnownTabsForConversation(conversationId);
    });
  }

  return {
    conversationPatchFromState,
    syncStateFromConversation,
    updateConversationFromTab,
  };
}
