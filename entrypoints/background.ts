import { floatingReaderUrl, pageAccessGranted } from "../src/learning/reader-window.ts";
import { restrictModelStorage } from "../src/models/profiles.ts";
import { registerModelWorker } from "../src/models/worker.ts";

export default defineBackground(() => {
  registerModelWorker();
  void restrictModelStorage().catch(() => undefined);
  chrome.action.onClicked.addListener((tab) => {
    const { windowId, id: tabId } = tab;
    if (windowId === undefined)
      return;
    // The callback retains the toolbar click required by sidePanel.open().
    chrome.runtime.getContexts({ documentUrls: [floatingReaderUrl(windowId)] }, (contexts) => {
      const floating = contexts.find(context => context.windowId >= 0);
      const shown = floating
        ? chrome.windows.update(floating.windowId, { focused: true })
        : chrome.sidePanel.open({ windowId });
      void shown.then(async () => chrome.runtime.sendMessage({ type: pageAccessGranted, tabId })).catch(() => undefined);
    });
  });
});
