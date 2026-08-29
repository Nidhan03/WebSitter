// WebSitter content script — runs on every page.

const ELDERLY_STYLE_ID = "websitter-elderly-style";
const DEFAULT_ELDERLY_ZOOM = 1.15;

function elderlyCss(zoomLevel) {
  return `
    body.websitter-elderly {
      zoom: ${zoomLevel};
    }
  `;
}

function applyElderlyZoom(zoomLevel) {
  const styleEl = document.getElementById(ELDERLY_STYLE_ID);
  if (styleEl) {
    styleEl.textContent = elderlyCss(zoomLevel || DEFAULT_ELDERLY_ZOOM);
  }
}

function applyElderlyMode(enabled, zoomLevel) {
  document.body?.classList.toggle("websitter-elderly", enabled);

  let styleEl = document.getElementById(ELDERLY_STYLE_ID);
  if (enabled) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = ELDERLY_STYLE_ID;
      document.head?.appendChild(styleEl);
    }
    styleEl.textContent = elderlyCss(zoomLevel || DEFAULT_ELDERLY_ZOOM);
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
  if (enabled) {
    enableLinkWarnings();
    enableCommentFiltering();
    enableImageBlurring();
  } else {
    disableLinkWarnings();
    disableCommentFiltering();
    disableImageBlurring();
  }
}

// --- Image blurring (Kid-Safe Mode, via NSFW.js) ---

const NSFW_FLAGGED_CLASSES = ["Porn", "Hentai", "Sexy"];
const NSFW_THRESHOLD = 0.7;
const MIN_IMAGE_DIMENSION = 60;

let nsfwModelPromise = null;
let imageObserver = null;
const scannedImages = new WeakSet();

function getNsfwModel() {
  if (typeof nsfwjs === "undefined") {
    return Promise.reject(new Error("NSFW.js failed to load"));
  }
  if (!nsfwModelPromise) {
    // No argument = the bundled default MobileNetV2 model, embedded in
    // nsfwjs.min.js itself. No network fetch, no separate model files.
    nsfwModelPromise = nsfwjs.load();
  }
  return nsfwModelPromise;
}

function blurImage(img) {
  img.style.filter = "blur(20px)";
  img.style.cursor = "pointer";
  img.title = "Hidden potentially inappropriate image — click to reveal";
  const reveal = () => {
    img.style.filter = "";
    img.removeEventListener("click", reveal);
  };
  img.addEventListener("click", reveal, { once: true });
}

async function classifyImage(img) {
  if (scannedImages.has(img)) return;
  scannedImages.add(img);

  if (img.naturalWidth < MIN_IMAGE_DIMENSION || img.naturalHeight < MIN_IMAGE_DIMENSION) return;

  try {
    const model = await getNsfwModel();
    const predictions = await model.classify(img);
    const flagged = predictions.find(
      (p) => NSFW_FLAGGED_CLASSES.includes(p.className) && p.probability >= NSFW_THRESHOLD
    );
    if (flagged) blurImage(img);
  } catch {
    // Cross-origin images without CORS headers can't be read by the model,
    // and the model may fail to load — fail silently, don't break the page.
  }
}

function observeImage(img) {
  if (scannedImages.has(img) || !imageObserver) return;
  if (img.complete && img.naturalWidth > 0) {
    imageObserver.observe(img);
  } else {
    img.addEventListener("load", () => imageObserver?.observe(img), { once: true });
  }
}

function scanExistingImages() {
  document.querySelectorAll("img").forEach(observeImage);
}

function enableImageBlurring() {
  if (imageObserver) return;
  imageObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          imageObserver.unobserve(entry.target);
          classifyImage(entry.target);
        }
      });
    },
    { rootMargin: "200px" }
  );
  scanExistingImages();
}

function disableImageBlurring() {
  imageObserver?.disconnect();
  imageObserver = null;
}

// --- Link warnings (Kid-Safe Mode) ---

let safeDomains = null;
let linkClickHandler = null;

async function loadSafeDomains() {
  if (safeDomains) return safeDomains;
  const res = await fetch(chrome.runtime.getURL("data/safeDomains.json"));
  safeDomains = await res.json();
  return safeDomains;
}

function isSafeHostname(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function showLinkWarningModal(url, onContinue) {
  const overlay = document.createElement("div");
  overlay.id = "websitter-link-warning";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background:#fff; border-radius:12px; padding:24px; max-width:360px; text-align:center; box-shadow:0 4px 20px rgba(0,0,0,0.3);">
      <p style="margin:0 0 8px; font-size:18px;">🔗 Leaving a safe site</p>
      <p style="margin:0 0 20px; color:#555; word-break:break-word;">This link goes to <strong>${url}</strong>, which isn't on the approved list. Continue?</p>
      <div style="display:flex; gap:12px; justify-content:center;">
        <button id="websitter-link-cancel" style="padding:10px 18px; border-radius:8px; border:1px solid #ccc; background:#fff; cursor:pointer; font-size:15px;">Go back</button>
        <button id="websitter-link-continue" style="padding:10px 18px; border-radius:8px; border:none; background:#2e86de; color:#fff; cursor:pointer; font-size:15px;">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#websitter-link-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#websitter-link-continue").addEventListener("click", () => {
    overlay.remove();
    onContinue();
  });
}

async function handleLinkClick(e) {
  const anchor = e.target.closest("a[href]");
  if (!anchor) return;

  let url;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  const domains = await loadSafeDomains();
  if (isSafeHostname(url.hostname, domains)) return;

  e.preventDefault();
  e.stopPropagation();
  showLinkWarningModal(url.hostname, () => {
    window.location.href = anchor.href;
  });
}

function enableLinkWarnings() {
  if (linkClickHandler) return;
  linkClickHandler = (e) => {
    handleLinkClick(e);
  };
  document.addEventListener("click", linkClickHandler, true);
}

function disableLinkWarnings() {
  if (linkClickHandler) {
    document.removeEventListener("click", linkClickHandler, true);
    linkClickHandler = null;
  }
  document.getElementById("websitter-link-warning")?.remove();
}

// --- Comment filtering (Kid-Safe Mode) ---

const COMMENT_SELECTOR = '[class*="comment"], [class*="review"], [class*="reply"], [role="comment"]';
let commentScanTimer = null;
let commentObserver = null;
let scoredCommentIds = new WeakSet();
let commentIdCounter = 0;

function findCandidateComments() {
  const nodes = document.querySelectorAll(COMMENT_SELECTOR);
  const candidates = [];
  nodes.forEach((node) => {
    if (scoredCommentIds.has(node)) return;
    const text = node.innerText?.trim();
    if (!text || text.length < 15 || text.length > 2000) return;
    node.dataset.websitterCommentId = String(commentIdCounter++);
    candidates.push({ id: node.dataset.websitterCommentId, text, node });
  });
  return candidates;
}

function blurComment(node) {
  node.style.filter = "blur(6px)";
  node.style.cursor = "pointer";
  node.title = "Hidden potentially inappropriate comment — click to reveal";
  const reveal = () => {
    node.style.filter = "";
    node.removeEventListener("click", reveal);
  };
  node.addEventListener("click", reveal, { once: true });
}

async function scanForToxicComments() {
  const candidates = findCandidateComments();
  if (candidates.length === 0) return;

  candidates.forEach(({ node }) => scoredCommentIds.add(node));

  chrome.runtime.sendMessage(
    { type: "SCORE_COMMENTS", payload: { comments: candidates.map(({ id, text }) => ({ id, text })) } },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) return;
      const nodeById = new Map(candidates.map(({ id, node }) => [id, node]));
      response.scores.forEach(({ id, toxicity }) => {
        if (toxicity >= 0.7) {
          const node = nodeById.get(id);
          if (node) blurComment(node);
        }
      });
    }
  );
}

function scheduleCommentScan() {
  clearTimeout(commentScanTimer);
  commentScanTimer = setTimeout(scanForToxicComments, 800);
}

function enableCommentFiltering() {
  scheduleCommentScan();
  if (!commentObserver) {
    commentObserver = new MutationObserver(scheduleCommentScan);
    commentObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function disableCommentFiltering() {
  clearTimeout(commentScanTimer);
  commentObserver?.disconnect();
  commentObserver = null;
  scoredCommentIds = new WeakSet();
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
  applyElderlyMode(Boolean(settings.elderlyMode), settings.elderlyZoomLevel);
  applyKidSafeMode(Boolean(settings.kidSafeMode));
}

function init() {
  chrome.storage.sync.get(["elderlyMode", "kidSafeMode", "elderlyZoomLevel"], (settings) => {
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
    chrome.storage.sync.get(["elderlyZoomLevel"], ({ elderlyZoomLevel }) => {
      applyElderlyMode(Boolean(changes.elderlyMode.newValue), elderlyZoomLevel);
    });
  }
  if ("elderlyZoomLevel" in changes) {
    applyElderlyZoom(changes.elderlyZoomLevel.newValue);
  }
  if ("kidSafeMode" in changes) {
    applyKidSafeMode(Boolean(changes.kidSafeMode.newValue));
  }
});
