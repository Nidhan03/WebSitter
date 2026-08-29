// WebSitter options page logic — persists mode toggles to chrome.storage.sync.

const DEFAULT_ELDERLY_ZOOM = "1.15";

const elderlyToggle = document.getElementById("elderlyModeToggle");
const kidSafeToggle = document.getElementById("kidSafeModeToggle");
const elderlyZoomSelect = document.getElementById("elderlyZoomSelect");
const elderlyZoomOption = document.getElementById("elderlyZoomOption");
const savedNote = document.getElementById("savedNote");

function updateZoomOptionState() {
  elderlyZoomOption.classList.toggle("disabled", !elderlyToggle.checked);
}

chrome.storage.sync.get(["elderlyMode", "kidSafeMode", "elderlyZoomLevel"], (settings) => {
  elderlyToggle.checked = Boolean(settings.elderlyMode);
  kidSafeToggle.checked = Boolean(settings.kidSafeMode);
  elderlyZoomSelect.value = settings.elderlyZoomLevel || DEFAULT_ELDERLY_ZOOM;
  updateZoomOptionState();
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
  updateZoomOptionState();
});

kidSafeToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ kidSafeMode: kidSafeToggle.checked }, showSavedNote);
});

elderlyZoomSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ elderlyZoomLevel: parseFloat(elderlyZoomSelect.value) }, showSavedNote);
});
