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

// Link warnings protect against scam/unsafe link destinations, which is
// relevant to both modes — an elderly user clicking a "claim your prize"
// link needs the same warning a kid clicking a random link does. So it's
// enabled whenever *either* mode is on, not gated to just one.
let elderlyModeEnabled = false;
let kidSafeModeEnabled = false;

function updateLinkWarnings() {
  if (elderlyModeEnabled || kidSafeModeEnabled) {
    enableLinkWarnings();
  } else {
    disableLinkWarnings();
  }
}

function applyElderlyMode(enabled, zoomLevel) {
  elderlyModeEnabled = enabled;
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
    enableAdPlaceholders();
  } else {
    styleEl?.remove();
    disableScamDetection();
    disableExplainOverlay();
    disableTextToSpeech();
    disableAdPlaceholders();
  }
  updateLinkWarnings();
}

function applyKidSafeMode(enabled) {
  kidSafeModeEnabled = enabled;
  document.body?.classList.toggle("websitter-kidsafe", enabled);
  if (enabled) {
    enableCommentFiltering();
    enableImageBlurring();
  } else {
    disableCommentFiltering();
    disableImageBlurring();
  }
  updateLinkWarnings();
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
    // nsfwjs.load()'s embedded-default-model path (calling it with no
    // argument) is broken in this bundle — confirmed in real Chrome, not
    // just a Node-environment quirk: it throws "Could not load the model.
    // Make sure you are importing the model.min.js bundle." every time.
    // Loading from an explicit URL takes a different, working code path —
    // the standard tfjs load-from-hosted-files mechanism.
    nsfwModelPromise = nsfwjs.load(chrome.runtime.getURL("lib/nsfwjs/model/"));
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

  if (img.naturalWidth < MIN_IMAGE_DIMENSION || img.naturalHeight < MIN_IMAGE_DIMENSION) {
    console.debug("[WebSitter] skipped image (too small):", img.src);
    return;
  }

  try {
    const model = await getNsfwModel();
    const predictions = await model.classify(img);
    console.debug("[WebSitter] NSFW predictions for", img.src, predictions);
    const flagged = predictions.find(
      (p) => NSFW_FLAGGED_CLASSES.includes(p.className) && p.probability >= NSFW_THRESHOLD
    );
    if (flagged) blurImage(img);
  } catch (err) {
    // Cross-origin images without CORS headers can't be read by the model,
    // and the model may fail to load — fail silently in production, but log
    // so this is diagnosable instead of a silent no-op.
    console.warn("[WebSitter] NSFW classification failed for", img.src, err);
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

function showLinkWarningModal(url) {
  const overlay = document.createElement("div");
  overlay.id = "websitter-link-warning";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;
  overlay.innerHTML = `
    <div style="background:#262626; border:1px solid #3a3a3a; border-radius:18px; width:360px; max-width:calc(100vw - 40px); overflow:hidden; box-shadow:0 12px 32px rgba(0,0,0,0.5);">
      <div style="height:4px; background:#e5484d;"></div>
      <div style="padding:28px 24px; text-align:center;">
        <div style="width:44px; height:44px; margin:0 auto 14px; border-radius:50%; background:rgba(229,72,77,0.15); display:flex; align-items:center; justify-content:center; font-size:20px;">🛡️</div>
        <p style="margin:0 0 8px; font-size:17px; font-weight:700; color:#f0f0f0;">Blocked by WebSitter</p>
        <p style="margin:0 0 22px; font-size:14px; color:#a0a0a0; line-height:1.5; word-break:break-word;">
          <strong style="color:#f0f0f0;">${url}</strong> is on WebSitter's list of known-unsafe sites, so this link has been blocked.
        </p>
        <button id="websitter-link-dismiss" style="width:100%; padding:12px; border-radius:10px; border:none; background:#0077b6; color:#fff; cursor:pointer; font-size:14px; font-weight:700; font-family:inherit;">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#websitter-link-dismiss").addEventListener("click", () => overlay.remove());
}

function navigateTo(anchor) {
  if (anchor.target === "_blank") {
    window.open(anchor.href, "_blank", "noopener");
  } else {
    window.location.href = anchor.href;
  }
}

function handleLinkClick(e) {
  const anchor = e.target.closest("a[href]");
  if (!anchor) return;

  let url;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Must preventDefault() synchronously, before the (async) domain check —
  // by the time an `await` resolves, the browser has already navigated,
  // which is exactly why the warning used to show up after the page loaded.
  e.preventDefault();
  e.stopPropagation();

  loadUnsafeDomains().then((domains) => {
    if (!isUnsafeHostname(url.hostname, domains)) {
      navigateTo(anchor);
      return;
    }
    showLinkWarningModal(url.hostname);
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
  // Permanently hidden — no click-to-reveal, so a curious click can't just
  // bypass the filter and show the toxic text anyway.
  node.style.filter = "blur(6px)";
  node.style.pointerEvents = "none";
  node.title = "Hidden potentially inappropriate comment";
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

// --- Blocked-ad placeholders (Elderly Mode) ---
//
// declarativeNetRequest blocks ad/tracker *network requests*, which is
// invisible if the page's own ad markup doesn't visually depend on that
// request succeeding (e.g. a tracking pixel next to CSS-only ad content).
// This adds real "cosmetic" blocking on top: known ad-container elements
// that reference a blocked domain get swapped for a visible placeholder,
// the same way a normal ad blocker's blocked slots look.

const AD_CONTAINER_SELECTOR =
  '.ad-slot, .advertisement, .ad-container, .ad-banner, .adsbygoogle, [id^="div-gpt-ad"], [data-ad-slot]';
let adPlaceholderDomains = null;
let adPlaceholderObserver = null;
let adPlaceholderInterval = null;
const scannedAdContainers = new WeakSet();

async function loadAdPlaceholderDomains() {
  if (adPlaceholderDomains) return adPlaceholderDomains;
  const res = await fetch(chrome.runtime.getURL("data/adDomains.json"));
  const bundled = await res.json();
  const { customAdDomains } = await chrome.storage.sync.get(["customAdDomains"]);
  adPlaceholderDomains = [...bundled, ...(customAdDomains || [])];
  return adPlaceholderDomains;
}

function containerReferencesAdDomain(container, domains) {
  const candidates = container.querySelectorAll("img[src], script[src], iframe[src]");
  for (const el of candidates) {
    try {
      const hostname = new URL(el.src, window.location.href).hostname;
      if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
        return true;
      }
    } catch {
      // ignore unparseable URLs
    }
  }
  return false;
}

function replaceWithAdPlaceholder(container) {
  const rect = container.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "websitter-ad-placeholder";
  placeholder.textContent = "🚫 Ad blocked by WebSitter";
  placeholder.style.cssText = `
    display: flex; align-items: center; justify-content: center;
    min-height: ${Math.max(60, Math.round(rect.height))}px;
    background: #262626; color: #a0a0a0;
    font: 13px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    border: 1px dashed #3a3a3a; border-radius: 10px; margin: ${getComputedStyle(container).margin};
  `;
  container.replaceWith(placeholder);
}

async function scanForAdPlaceholders() {
  const containers = document.querySelectorAll(AD_CONTAINER_SELECTOR);
  if (containers.length === 0) return;

  const domains = await loadAdPlaceholderDomains();
  containers.forEach((container) => {
    if (scannedAdContainers.has(container)) return;
    scannedAdContainers.add(container);
    if (containerReferencesAdDomain(container, domains)) {
      replaceWithAdPlaceholder(container);
    }
  });
}

function scheduleAdPlaceholderScan() {
  scanForAdPlaceholders();
}

function enableAdPlaceholders() {
  scheduleAdPlaceholderScan();
  if (!adPlaceholderObserver) {
    adPlaceholderObserver = new MutationObserver(scheduleAdPlaceholderScan);
    adPlaceholderObserver.observe(document.body, { childList: true, subtree: true });
  }
  if (!adPlaceholderInterval) {
    // Ad slots are often filled in asynchronously by third-party scripts
    // after the initial page load, so keep checking periodically too.
    adPlaceholderInterval = setInterval(scanForAdPlaceholders, 2000);
  }
}

function disableAdPlaceholders() {
  adPlaceholderObserver?.disconnect();
  adPlaceholderObserver = null;
  clearInterval(adPlaceholderInterval);
  adPlaceholderInterval = null;
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
    background: #262626; color: #f0f0f0;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px; padding: 12px 16px; display: flex; align-items: center;
    justify-content: space-between; gap: 16px;
    border-bottom: 3px solid #e5484d; box-shadow: 0 2px 12px rgba(0,0,0,0.5);
  `;
  banner.innerHTML = `
    <span><span style="color:#e5484d; font-weight:700;">⚠️ Scam warning:</span> This page contains language often used in scams ("${matchedKeyword}"). Be careful before entering personal information or payment details.</span>
  `;
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.style.cssText = `
    background: transparent; color: #f0f0f0; border: 1px solid #3a3a3a; border-radius: 8px;
    padding: 6px 14px; font-weight: 600; cursor: pointer; flex-shrink: 0;
    font-family: inherit;
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
