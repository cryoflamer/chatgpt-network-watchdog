export function createEventLog({ now, maxItems, debugEventTypes }) {
  const events = [];
  let nextEventId = 1;

  function addEvent(type, tabId, message, details = {}) {
    events.unshift({
      id: nextEventId,
      at: now(),
      type,
      tabId: typeof tabId === "number" ? tabId : null,
      message,
      details,
    });
    nextEventId += 1;

    if (events.length > maxItems) {
      events.length = maxItems;
    }
  }

  function recentEvents(limit = maxItems, includeDebug = false) {
    const visibleEvents = includeDebug
      ? events
      : events.filter((event) => !debugEventTypes.has(event.type));

    return visibleEvents.slice(0, limit).map((event) => ({
      ...event,
      details: { ...event.details },
    }));
  }

  function clearEventLog(tabId = null) {
    events.length = 0;
    nextEventId = 1;
    addEvent("SET", tabId, "Event log cleared");
  }

  return {
    addEvent,
    recentEvents,
    clearEventLog,
  };
}
