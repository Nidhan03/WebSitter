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
    enableTextToSpeech();
  } else {
    styleEl?.remove();
    disableScamDetection();
    disableExplainOverlay();
    disableTextToSpeech();
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

let unsafeDomains = null;
let linkClickHandler = null;

async function loadUnsafeDomains() {
  if (unsafeDomains) return unsafeDomains;
  const res = await fetch(chrome.runtime.getURL("data/unsafeDomains.json"));
  const bundled = await res.json();
  const { customUnsafeDomains } = await chrome.storage.sync.get(["customUnsafeDomains"]);
  unsafeDomains = [...bundled, ...(customUnsafeDomains || [])];
  return unsafeDomains;
}

function isUnsafeHostname(hostname, domains) {
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
      <p style="margin:0 0 8px; font-size:18px;">⚠️ Risky site ahead</p>
      <p style="margin:0 0 20px; color:#555; word-break:break-word;">This link goes to <strong>${url}</strong>, which is on WebSitter's blocked list. Continue anyway?</p>
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

  const domains = await loadUnsafeDomains();
  if (!isUnsafeHostname(url.hostname, domains)) return;

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

// --- Toxic text filtering (Kid-Safe Mode) — comments, reviews, and general
// page text (paragraphs, list items, etc.), not just comment-shaped elements.

const TEXT_SELECTOR =
  '[class*="comment"], [class*="review"], [class*="reply"], [role="comment"], p, li, blockquote';
const BATCH_SIZE = 20;
let commentScanTimer = null;
let commentObserver = null;
let commentBatchInterval = null;
let scoredCommentIds = new WeakSet();
let commentIdCounter = 0;

function findCandidateComments() {
  const nodes = document.querySelectorAll(TEXT_SELECTOR);
  const candidates = [];
  nodes.forEach((node) => {
    if (scoredCommentIds.has(node)) return;
    // Skip a wrapper if one of its own descendants also matches — avoids
    // sending the same text twice (e.g. a comment <div> and the <p> inside it).
    if (node.querySelector(TEXT_SELECTOR)) return;
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
  const candidates = findCandidateComments().slice(0, BATCH_SIZE);
  if (candidates.length === 0) return;

  // Only mark the ones actually sent as scored — anything beyond the batch
  // size stays a candidate so a later scan picks it up instead of being
  // silently skipped forever.
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
  if (!commentBatchInterval) {
    // Mutation events alone won't re-trigger on a static page with more
    // text than one batch — periodically work through the backlog too.
    commentBatchInterval = setInterval(scanForToxicComments, 4000);
  }
}

function disableCommentFiltering() {
  clearTimeout(commentScanTimer);
  commentObserver?.disconnect();
  commentObserver = null;
  clearInterval(commentBatchInterval);
  commentBatchInterval = null;
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
    position: fixed; z-index: 2147483647; width: 40px; height: 40px;
    border-radius: 50%; background: #2e86de; color: #fff; border: 3px solid #fff;
    font: bold 22px system-ui, sans-serif; line-height: 1; cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,0.4); padding: 0;
    display: flex; align-items: center; justify-content: center;
  `;
  explainBadge.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (explainTargetEl) requestExplanation(explainTargetEl);
  });
  // Appended to <html>, not <body> — Elderly Mode applies `zoom` to body,
  // and a descendant of a zoomed element gets its own absolute-positioned
  // px offsets re-scaled by that zoom factor, throwing off our
  // getBoundingClientRect()-based math. <html> itself is never zoomed.
  document.documentElement.appendChild(explainBadge);
  return explainBadge;
}

function positionBadgeNear(el) {
  const rect = el.getBoundingClientRect();
  const badge = getExplainBadge();
  // position: fixed is viewport-relative, same as getBoundingClientRect(),
  // so no scrollX/scrollY math needed here.
  badge.style.top = `${rect.top - 20}px`;
  badge.style.left = `${rect.right - 20}px`;
  badge.style.display = "flex";
}

function hideBadge() {
  if (explainBadge) explainBadge.style.display = "none";
}

function getExplainTooltip() {
  if (explainTooltip) return explainTooltip;
  explainTooltip = document.createElement("div");
  explainTooltip.id = "websitter-explain-tooltip";
  explainTooltip.style.cssText = `
    position: fixed; z-index: 2147483647; max-width: 400px;
    background: #1a1a1a; color: #fff; font: 18px/1.5 system-ui, sans-serif;
    padding: 16px 20px; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: none;
  `;
  document.documentElement.appendChild(explainTooltip);
  return explainTooltip;
}

function showTooltipNear(el, text) {
  const rect = el.getBoundingClientRect();
  const tooltip = getExplainTooltip();
  tooltip.textContent = text;
  // Render (invisibly) first so we can measure its real size before placing
  // it — needed to know whether it'll fit below/right of the target.
  tooltip.style.visibility = "hidden";
  tooltip.style.display = "block";
  const tooltipRect = tooltip.getBoundingClientRect();
  const margin = 8;

  let top = rect.bottom + 6;
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = rect.top - tooltipRect.height - 6; // flip above the target
  }
  top = Math.max(margin, top);

  let left = rect.left;
  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tooltipRect.width - margin;
  }
  left = Math.max(margin, left);

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
  tooltip.style.visibility = "visible";
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

  // Don't show the explain badge while the user is actively selecting text
  // (e.g. dragging across a paragraph that happens to contain an inline
  // link) — the Listen button takes priority for a text selection.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    hideBadge();
    explainTargetEl = null;
    return;
  }

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

// --- Text-to-speech on selection (Elderly Mode) ---

let speechButton = null;
let selectionChangeHandler = null;
let selectionDebounceTimer = null;

function getSpeechButton() {
  if (speechButton) return speechButton;
  speechButton = document.createElement("button");
  speechButton.id = "websitter-speech-button";
  speechButton.textContent = "🔊 Listen";
  speechButton.style.cssText = `
    position: fixed; z-index: 2147483647; display: none;
    background: #f39c12; color: #fff; border: 2px solid #fff;
    border-radius: 999px; padding: 8px 16px; font: bold 15px system-ui, sans-serif;
    cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  `;
  // Prevent the button click from collapsing the text selection first.
  speechButton.addEventListener("mousedown", (e) => e.preventDefault());
  speechButton.addEventListener("click", () => {
    const text = speechButton.dataset.text;
    if (!text) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    hideSpeechButton();
  });
  document.documentElement.appendChild(speechButton);
  return speechButton;
}

function hideSpeechButton() {
  if (speechButton) speechButton.style.display = "none";
}

function handleSelectionChange() {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || text.length < 2 || selection.rangeCount === 0) {
    hideSpeechButton();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideSpeechButton();
    return;
  }

  // Don't show both floating badges at once — a text selection takes priority.
  hideBadge();
  hideTooltip();

  const button = getSpeechButton();
  button.dataset.text = text;
  button.style.top = `${Math.max(8, rect.top - 44)}px`;
  button.style.left = `${Math.max(8, rect.left)}px`;
  button.style.display = "block";
}

function enableTextToSpeech() {
  if (selectionChangeHandler) return;
  selectionChangeHandler = () => {
    clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = setTimeout(handleSelectionChange, 150);
  };
  document.addEventListener("selectionchange", selectionChangeHandler);
}

function disableTextToSpeech() {
  if (selectionChangeHandler) {
    document.removeEventListener("selectionchange", selectionChangeHandler);
    selectionChangeHandler = null;
  }
  clearTimeout(selectionDebounceTimer);
  speechSynthesis.cancel();
  speechButton?.remove();
  speechButton = null;
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
  if ("customUnsafeDomains" in changes) {
    unsafeDomains = null; // force a re-fetch + re-merge on the next link click
  }
});
