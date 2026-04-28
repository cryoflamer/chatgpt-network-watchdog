export function createTabRegistry() {
  const tabs = new Map();

  function get(tabId) {
    return tabs.get(tabId);
  }

  function set(tabId, state) {
    tabs.set(tabId, state);
    return state;
  }

  function has(tabId) {
    return tabs.has(tabId);
  }

  function remove(tabId) {
    return tabs.delete(tabId);
  }

  function values() {
    return tabs.values();
  }

  return {
    get,
    set,
    has,
    delete: remove,
    values,
  };
}
