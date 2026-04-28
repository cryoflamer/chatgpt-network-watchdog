function isOpenFreshChatCommand(command) {
  return command === "open-fresh-chat" || command === "open_fresh_chat";
}

export function createCommandController({ chromeApi, openFreshChatForCurrentWindow }) {
  function attach() {
    chromeApi.commands.onCommand.addListener((command) => {
      console.log("[CTR:BG] command received", { command });

      if (!isOpenFreshChatCommand(command)) {
        return;
      }

      console.log("[CTR:BG] opening fresh ChatGPT tab from hotkey", { command });

      openFreshChatForCurrentWindow((response) => {
        if (!response?.ok) {
          console.warn("[CTR:BG] hotkey open fresh chat failed", response);
        }
      });
    });
  }

  return { attach };
}
