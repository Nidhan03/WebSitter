// WebSitter content script — runs on every page.
// Stage 3 will add real mode detection and Elderly Mode enlargement.

chrome.storage.sync.get(["elderlyMode", "kidSafeMode"], (settings) => {
  console.log("[WebSitter] loaded, settings:", settings);
});
