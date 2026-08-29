// WebSitter background service worker (MV3).
// Stage 5-6 will add Gemini / Perspective API calls and the in-memory
// explanationCache here.

const AD_RULESET_ID = "ad_rules";

function setAdBlockingEnabled(enabled) {
  chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? [AD_RULESET_ID] : [],
    disableRulesetIds: enabled ? [] : [AD_RULESET_ID],
  });
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["elderlyMode"], (settings) => {
    setAdBlockingEnabled(Boolean(settings.elderlyMode));
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if ("elderlyMode" in changes) {
    setAdBlockingEnabled(Boolean(changes.elderlyMode.newValue));
  }
});
