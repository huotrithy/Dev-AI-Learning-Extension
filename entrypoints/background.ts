export default defineBackground(() => {
  chrome.action.onClicked.addListener((tab) => {
    if (tab.windowId === undefined) return;
    void chrome.sidePanel.open({ windowId: tab.windowId }).then(() =>
      chrome.runtime.sendMessage({ type: 'page-access-granted', tabId: tab.id }),
    ).catch(() => undefined);
  });
});
