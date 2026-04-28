export function isChatGptBackendRequest(details) {
  try {
    const url = new URL(details.url);
    return url.hostname.endsWith("chatgpt.com") && url.pathname.startsWith("/backend-api/");
  } catch (_error) {
    return false;
  }
}

export function isGenerationRequest(details, generationPath) {
  try {
    const url = new URL(details.url);
    return details.method === "POST" && url.hostname === "chatgpt.com" && url.pathname === generationPath;
  } catch (_error) {
    return false;
  }
}

export function conversationIdFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "chatgpt.com") {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const markerIndex = parts.indexOf("c");
    if (markerIndex >= 0 && parts[markerIndex + 1]) {
      return parts[markerIndex + 1];
    }
  } catch (_error) {
    return null;
  }

  return null;
}
