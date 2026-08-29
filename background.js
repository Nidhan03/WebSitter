// WebSitter background service worker (MV3).
// Stages 5-6 will add Gemini / Perspective API calls and the in-memory
// explanationCache here.

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
