// WebSitter options page logic — persists mode toggles to chrome.storage.sync.

const DEFAULT_ELDERLY_ZOOM = "1.15";

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

// --- User-added custom domain lists (ad-block + unsafe-site blocklist) ---

function normalizeDomain(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function setupCustomDomainList({ storageKey, inputId, buttonId, listId }) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);
  const list = document.getElementById(listId);

  function render(domains) {
    list.innerHTML = "";
    domains.forEach((domain) => {
      const li = document.createElement("li");
      li.textContent = domain;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.title = `Remove ${domain}`;
      removeBtn.addEventListener("click", () => {
        chrome.storage.sync.get([storageKey], (settings) => {
          const updated = (settings[storageKey] || []).filter((d) => d !== domain);
          chrome.storage.sync.set({ [storageKey]: updated }, showSavedToast);
          render(updated);
        });
      });
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  function addDomain() {
    const domain = normalizeDomain(input.value);
    if (!domain || !domain.includes(".")) return;

    chrome.storage.sync.get([storageKey], (settings) => {
      const existing = settings[storageKey] || [];
      if (existing.includes(domain)) {
        input.value = "";
        return;
      }
      const updated = [...existing, domain];
      chrome.storage.sync.set({ [storageKey]: updated }, showSavedToast);
      render(updated);
      input.value = "";
    });
  }

  button.addEventListener("click", addDomain);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDomain();
    }
  });

  chrome.storage.sync.get([storageKey], (settings) => {
    render(settings[storageKey] || []);
  });
}

setupCustomDomainList({
  storageKey: "customAdDomains",
  inputId: "customAdDomainInput",
  buttonId: "addAdDomainBtn",
  listId: "customAdDomainList",
});

setupCustomDomainList({
  storageKey: "customUnsafeDomains",
  inputId: "customUnsafeDomainInput",
  buttonId: "addUnsafeDomainBtn",
  listId: "customUnsafeDomainList",
});
