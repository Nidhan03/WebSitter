// WebSitter options page logic — persists mode toggles to chrome.storage.sync.

const elderlyToggle = document.getElementById("elderlyModeToggle");
const kidSafeToggle = document.getElementById("kidSafeModeToggle");
const savedNote = document.getElementById("savedNote");

chrome.storage.sync.get(["elderlyMode", "kidSafeMode"], (settings) => {
  elderlyToggle.checked = Boolean(settings.elderlyMode);
  kidSafeToggle.checked = Boolean(settings.kidSafeMode);
});

function showSavedNote() {
  savedNote.hidden = false;
  clearTimeout(showSavedNote._timer);
  showSavedNote._timer = setTimeout(() => {
    savedNote.hidden = true;
  }, 1200);
}

elderlyToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ elderlyMode: elderlyToggle.checked }, showSavedNote);
});

kidSafeToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ kidSafeMode: kidSafeToggle.checked }, showSavedNote);
});
