export function createSettingsStore({ storage, defaults, limits, logger = console.log }) {
  const settings = { ...defaults };

  function clampSoundVolume(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return defaults.soundVolume;
    }

    return Math.min(1, Math.max(0, parsed));
  }

  function clampMs(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function normalizeStoredSettings(stored) {
    return {
      autoRecoverFrozenTabs: Boolean(stored.autoRecoverFrozenTabs),
      soundAlerts: Boolean(stored.soundAlerts),
      desktopNotifications: Boolean(stored.desktopNotifications),
      debugMode: Boolean(stored.debugMode),
      soundVolume: clampSoundVolume(stored.soundVolume),
      heartbeatTimeoutMs: clampMs(
        stored.heartbeatTimeoutMs,
        limits.heartbeatTimeoutMs.min,
        limits.heartbeatTimeoutMs.max,
        defaults.heartbeatTimeoutMs,
      ),
      autoRecoverCooldownMs: clampMs(
        stored.autoRecoverCooldownMs,
        limits.autoRecoverCooldownMs.min,
        limits.autoRecoverCooldownMs.max,
        defaults.autoRecoverCooldownMs,
      ),
    };
  }

  function load() {
    storage.get(defaults, (stored) => {
      Object.assign(settings, normalizeStoredSettings(stored));
      logger("[CTR:BG] settings loaded", settings);
    });
  }

  function secondsFromMs(value) {
    return Math.round(value / 1000);
  }

  function soundVolumePercent() {
    return Math.round(settings.soundVolume * 100);
  }

  function publicSettings() {
    return {
      ...settings,
      soundVolumePercent: soundVolumePercent(),
      heartbeatTimeoutSec: secondsFromMs(settings.heartbeatTimeoutMs),
      autoRecoverCooldownSec: secondsFromMs(settings.autoRecoverCooldownMs),
    };
  }

  return {
    settings,
    load,
    clampMs,
    clampSoundVolume,
    secondsFromMs,
    soundVolumePercent,
    publicSettings,
  };
}
