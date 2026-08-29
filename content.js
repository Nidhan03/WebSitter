// WebSitter content script — runs on every page.

const ELDERLY_STYLE_ID = "websitter-elderly-style";

const ELDERLY_CSS = `
  body.websitter-elderly {
    font-size: 120% !important;
    line-height: 1.6 !important;
  }
  body.websitter-elderly * {
    letter-spacing: 0.01em;
  }
  body.websitter-elderly button,
  body.websitter-elderly input[type="button"],
  body.websitter-elderly input[type="submit"],
  body.websitter-elderly a {
    min-height: 44px !important;
    min-width: 44px !important;
    padding: 10px 16px !important;
    font-size: 1.1em !important;
  }
  body.websitter-elderly input,
  body.websitter-elderly select,
  body.websitter-elderly textarea {
    font-size: 1.1em !important;
    padding: 8px !important;
  }
`;

function applyElderlyMode(enabled) {
  document.body?.classList.toggle("websitter-elderly", enabled);

  let styleEl = document.getElementById(ELDERLY_STYLE_ID);
  if (enabled) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = ELDERLY_STYLE_ID;
      styleEl.textContent = ELDERLY_CSS;
      document.head?.appendChild(styleEl);
    }
  } else {
    styleEl?.remove();
  }
}

function applyKidSafeMode(enabled) {
  document.body?.classList.toggle("websitter-kidsafe", enabled);
  // Stages 6-7 will add link warnings, comment filtering, and image blurring here.
}

function applyModes(settings) {
  applyElderlyMode(Boolean(settings.elderlyMode));
  applyKidSafeMode(Boolean(settings.kidSafeMode));
}

function init() {
  chrome.storage.sync.get(["elderlyMode", "kidSafeMode"], (settings) => {
    applyModes(settings);
  });
}

if (document.body) {
  init();
} else {
  document.addEventListener("DOMContentLoaded", init, { once: true });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if ("elderlyMode" in changes) {
    applyElderlyMode(Boolean(changes.elderlyMode.newValue));
  }
  if ("kidSafeMode" in changes) {
    applyKidSafeMode(Boolean(changes.kidSafeMode.newValue));
  }
});
