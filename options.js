// WebSitter options page logic — persists mode toggles to chrome.storage.sync.

const DEFAULT_ELDERLY_ZOOM = "1.15";
const DEFAULT_UI_THEME = "dark";

const themeToggle = document.getElementById("themeToggle");
const themeToggleIcon = document.getElementById("themeToggleIcon");
const themeToggleLabel = document.getElementById("themeToggleLabel");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleIcon.textContent = theme === "dark" ? "🌙" : "☀️";
  themeToggleLabel.textContent = theme === "dark" ? "Dark" : "Light";
}

chrome.storage.sync.get(["uiTheme"], (settings) => {
  applyTheme(settings.uiTheme || DEFAULT_UI_THEME);
});

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage.sync.set({ uiTheme: next });
});

const elderlyToggle = document.getElementById("elderlyModeToggle");
const kidSafeToggle = document.getElementById("kidSafeModeToggle");
const elderlyZoomSelect = document.getElementById("elderlyZoomSelect");
const elderlyZoomOption = document.getElementById("elderlyZoomOption");
const savedToast = document.getElementById("savedToast");

function updateZoomOptionState() {
  elderlyZoomOption.classList.toggle("disabled", !elderlyToggle.checked);
}

chrome.storage.sync.get(["elderlyMode", "kidSafeMode", "elderlyZoomLevel"], (settings) => {
  elderlyToggle.checked = Boolean(settings.elderlyMode);
  kidSafeToggle.checked = Boolean(settings.kidSafeMode);
  elderlyZoomSelect.value = settings.elderlyZoomLevel || DEFAULT_ELDERLY_ZOOM;
  updateZoomOptionState();
});

function showSavedToast() {
  savedToast.hidden = false;
  clearTimeout(showSavedToast._timer);
  showSavedToast._timer = setTimeout(() => {
    savedToast.hidden = true;
  }, 1500);
}

elderlyToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ elderlyMode: elderlyToggle.checked }, showSavedToast);
  updateZoomOptionState();
});

kidSafeToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ kidSafeMode: kidSafeToggle.checked }, showSavedToast);
});

elderlyZoomSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ elderlyZoomLevel: parseFloat(elderlyZoomSelect.value) }, showSavedToast);
});

// Live stats strip — small "wow" touch showing the bundled lists aren't empty promises.
async function loadStats() {
  try {
    const [ads, scamKeywords, unsafeDomains] = await Promise.all(
      ["data/adDomains.json", "data/scamKeywords.json", "data/unsafeDomains.json"].map((path) =>
        fetch(chrome.runtime.getURL(path)).then((res) => res.json())
      )
    );
    document.getElementById("statAds").textContent = ads.length;
    document.getElementById("statScam").textContent = scamKeywords.length;
    document.getElementById("statUnsafe").textContent = unsafeDomains.length;
    document.getElementById("statsStrip").hidden = false;
  } catch {
    // Stats are a nice-to-have; fail silently if the data files can't be read.
  }
}

loadStats();
