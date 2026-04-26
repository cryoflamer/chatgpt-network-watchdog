const HEARTBEAT_INTERVAL_MS = 2000;

function sendMessage(message) {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

function heartbeat() {
  sendMessage({ type: "watchdog-heartbeat" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "watchdog-state") {
    // The persistent on-page overlay was intentionally removed.
    // State is now represented through the extension badge and popup.
  }
});

sendMessage({ type: "watchdog-hello", href: window.location.href });
sendMessage({ type: "watchdog-get-state" });
heartbeat();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

window.addEventListener("pageshow", heartbeat);
