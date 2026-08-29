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
    enableScamDetection();
    enableExplainOverlay();
  } else {
    styleEl?.remove();
    disableScamDetection();
    disableExplainOverlay();
  }
}

function applyKidSafeMode(enabled) {
  document.body?.classList.toggle("websitter-kidsafe", enabled);
  // Stages 6-7 will add link warnings, comment filtering, and image blurring here.
}

// --- Scam keyword detection (Elderly Mode) ---

const SCAM_BANNER_ID = "websitter-scam-banner";
let scamKeywords = null;
let scamScanTimer = null;
let scamObserver = null;
let scamBannerDismissed = false;

async function loadScamKeywords() {
  if (scamKeywords) return scamKeywords;
  const res = await fetch(chrome.runtime.getURL("data/scamKeywords.json"));
  scamKeywords = await res.json();
  return scamKeywords;
}

function showScamBanner(matchedKeyword) {
  if (scamBannerDismissed || document.getElementById(SCAM_BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = SCAM_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    background: #b91c1c; color: #fff; font-family: system-ui, sans-serif;
    font-size: 15px; padding: 12px 16px; display: flex; align-items: center;
    justify-content: space-between; gap: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;
  banner.innerHTML = `
    <span>⚠️ This page contains language often used in scams ("${matchedKeyword}"). Be careful before entering personal information or payment details.</span>
  `;
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.style.cssText = `
    background: #fff; color: #b91c1c; border: none; border-radius: 6px;
    padding: 6px 12px; font-weight: 600; cursor: pointer; flex-shrink: 0;
  `;
  dismissBtn.addEventListener("click", () => {
    banner.remove();
    scamBannerDismissed = true;
  });
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);
}

async function scanForScamKeywords() {
  const keywords = await loadScamKeywords();
  const pageText = document.body?.innerText?.toLowerCase();
  if (!pageText) return;

  const match = keywords.find((keyword) => pageText.includes(keyword.toLowerCase()));
  if (match) {
    showScamBanner(match);
  }
}

function scheduleScamScan() {
  clearTimeout(scamScanTimer);
  scamScanTimer = setTimeout(scanForScamKeywords, 500);
}

function enableScamDetection() {
  scheduleScamScan();
  if (!scamObserver) {
    scamObserver = new MutationObserver(scheduleScamScan);
    scamObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

function disableScamDetection() {
  clearTimeout(scamScanTimer);
  scamObserver?.disconnect();
  scamObserver = null;
  document.getElementById(SCAM_BANNER_ID)?.remove();
  scamBannerDismissed = false;
}

// --- Tap-to-explain (Elderly Mode) ---

const EXPLAIN_SELECTOR = 'button, a, input[type="button"], input[type="submit"]';
let explainBadge = null;
let explainTooltip = null;
let explainTargetEl = null;
let explainHoverHandler = null;
let explainScrollHandler = null;

function getExplainBadge() {
  if (explainBadge) return explainBadge;
  explainBadge = document.createElement("button");
  explainBadge.id = "websitter-explain-badge";
  explainBadge.textContent = "?";
  explainBadge.title = "Explain this";
  explainBadge.style.cssText = `
    position: absolute; z-index: 2147483647; width: 22px; height: 22px;
    border-radius: 50%; background: #2e86de; color: #fff; border: 2px solid #fff;
    font: bold 13px system-ui, sans-serif; line-height: 1; cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4); padding: 0;
  `;
  explainBadge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (explainTargetEl) requestExplanation(explainTargetEl);
  });
  document.body.appendChild(explainBadge);
  return explainBadge;
}

function positionBadgeNear(el) {
  const rect = el.getBoundingClientRect();
  const badge = getExplainBadge();
  badge.style.top = `${window.scrollY + rect.top - 10}px`;
  badge.style.left = `${window.scrollX + rect.right - 10}px`;
  badge.style.display = "block";
}

function hideBadge() {
  if (explainBadge) explainBadge.style.display = "none";
}

function getExplainTooltip() {
  if (explainTooltip) return explainTooltip;
  explainTooltip = document.createElement("div");
  explainTooltip.id = "websitter-explain-tooltip";
  explainTooltip.style.cssText = `
    position: absolute; z-index: 2147483647; max-width: 280px;
    background: #1a1a1a; color: #fff; font: 14px/1.4 system-ui, sans-serif;
    padding: 10px 12px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    display: none;
  `;
  document.body.appendChild(explainTooltip);
  return explainTooltip;
}

function showTooltipNear(el, text) {
  const rect = el.getBoundingClientRect();
  const tooltip = getExplainTooltip();
  tooltip.textContent = text;
  tooltip.style.display = "block";
  tooltip.style.top = `${window.scrollY + rect.bottom + 6}px`;
  tooltip.style.left = `${window.scrollX + rect.left}px`;
}

function hideTooltip() {
  if (explainTooltip) explainTooltip.style.display = "none";
}

function requestExplanation(el) {
  const text = el.innerText?.trim() || el.value?.trim() || el.getAttribute("aria-label") || "this button";
  showTooltipNear(el, "Explaining…");
  chrome.runtime.sendMessage({ type: "EXPLAIN_BUTTON", payload: { text } }, (response) => {
    if (chrome.runtime.lastError) {
      showTooltipNear(el, "Couldn't reach WebSitter's explain service.");
      return;
    }
    if (response?.ok) {
      showTooltipNear(el, response.explanation);
    } else {
      showTooltipNear(el, response?.error || "Couldn't generate an explanation.");
    }
  });
}

function handleExplainHover(e) {
  if (e.target.id === "websitter-explain-badge") return;
  const target = e.target.closest(EXPLAIN_SELECTOR);
  if (!target) {
    hideBadge();
    explainTargetEl = null;
    return;
  }
  explainTargetEl = target;
  positionBadgeNear(target);
}

function enableExplainOverlay() {
  if (explainHoverHandler) return;
  explainHoverHandler = handleExplainHover;
  explainScrollHandler = () => {
    if (explainTargetEl) positionBadgeNear(explainTargetEl);
  };
  document.addEventListener("mouseover", explainHoverHandler);
  document.addEventListener("scroll", explainScrollHandler, true);
  document.addEventListener("click", hideTooltip, true);
}

function disableExplainOverlay() {
  if (explainHoverHandler) {
    document.removeEventListener("mouseover", explainHoverHandler);
    document.removeEventListener("scroll", explainScrollHandler, true);
    document.removeEventListener("click", hideTooltip, true);
    explainHoverHandler = null;
    explainScrollHandler = null;
  }
  explainBadge?.remove();
  explainBadge = null;
  explainTooltip?.remove();
  explainTooltip = null;
  explainTargetEl = null;
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
