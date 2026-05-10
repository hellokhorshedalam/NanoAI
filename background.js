// NanoAI — Background Service Worker
// Opens side panel when user clicks the extension icon

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error('sidePanel setup error:', err));
});

// Relay messages between sidebar and content script if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ ok: true });
  }

  if (message.action === 'getPageContent') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) { sendResponse({ error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tab.id, { action: 'getPageText' }, response => {
        if (chrome.runtime.lastError) {
          // Content script not injected yet — inject and retry
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          }).then(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'getPageText' }, r => {
              sendResponse(r || { error: 'Failed to get page text' });
            });
          }).catch(e => sendResponse({ error: e.message }));
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // async
  }
});
