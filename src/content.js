const HEARTBEAT_INTERVAL_MS = 2000;

let watchdogAudioContext = null;
let watchdogAudioUnlocked = false;

function getAudioContext() {
  if (!watchdogAudioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    watchdogAudioContext = new AudioContextCtor();
  }
  return watchdogAudioContext;
}

function unlockWatchdogAudio() {
  const ctx = getAudioContext();
  if (!ctx || watchdogAudioUnlocked) {
    return;
  }

  ctx.resume().then(() => {
    watchdogAudioUnlocked = true;
  }).catch(() => {
    // Browsers may still block audio until the next user gesture.
  });
}

function playTone(frequency, durationMs, delayMs = 0, volume = 0.35) {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }

  ctx.resume().then(() => {
    const startAt = ctx.currentTime + delayMs / 1000;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    const safeVolume = Math.min(1, Math.max(0, Number(volume) || 0));
    const peakGain = Math.max(0.0001, safeVolume * 0.18);

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationMs / 1000);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationMs / 1000 + 0.02);
  }).catch(() => {
    // Audio is optional; ignore browser autoplay restrictions.
  });
}

function playWatchdogSound(alertType, volume = 0.35) {
  if (alertType === "DONE") {
    playTone(880, 100, 0, volume);
  } else if (alertType === "ERR") {
    playTone(220, 160, 0, volume);
  } else if (alertType === "FRZ") {
    playTone(660, 80, 0, volume);
    playTone(660, 80, 140, volume);
  }
}

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

  if (message?.type === "watchdog-play-sound") {
    playWatchdogSound(message.alertType, message.volume);
  }
});

sendMessage({ type: "watchdog-hello", href: window.location.href });
sendMessage({ type: "watchdog-get-state" });
heartbeat();
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

window.addEventListener("pageshow", heartbeat);
window.addEventListener("pointerdown", unlockWatchdogAudio, { once: true, passive: true });
window.addEventListener("keydown", unlockWatchdogAudio, { once: true });
