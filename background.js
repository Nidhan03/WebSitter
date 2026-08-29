// WebSitter background service worker (MV3).

importScripts("config.js");

const AD_RULESET_ID = "ad_rules";
const GROQ_MODEL = "openai/gpt-oss-20b";

// In-memory only, per spec — MV3 service workers unload after ~30s idle,
// so this cache resets often. That's an accepted limitation, not a bug.
const explanationCache = {};

// Shared Groq chat-completions caller with retry-on-5xx, since Groq's
// servers occasionally return a transient error. Not retried for 4xx
// (bad key, bad model, rate limit) since retrying won't help those.
async function callGroq(apiKey, prompt) {
  const MAX_ATTEMPTS = 5;
  let response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (response.ok || response.status < 500 || attempt === MAX_ATTEMPTS) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }

  if (!response.ok) {
    throw new Error(`Groq API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Groq API returned no content.");
  }
  return content;
}

async function explainButtonText(text) {
  if (explanationCache[text]) {
    return explanationCache[text];
  }

  const apiKey = CONFIG.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Groq API key. Add it to config.js.");
  }

  const prompt = `Explain in one short, plain-language sentence what clicking a button labeled "${text}" will do on a website. Assume the reader may be unfamiliar with tech jargon. Do not add extra caveats or formatting.`;
  const explanation = await callGroq(apiKey, prompt);

  explanationCache[text] = explanation;
  return explanation;
}

const MAX_COMMENTS_PER_REQUEST = 20;

async function scoreComment(text) {
  // A separate Groq account/key from tap-to-explain, so the two features
  // don't share (and potentially exhaust) the same free-tier quota.
  const apiKey = CONFIG.GROQ_MODERATION_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Groq moderation API key. Add it to config.js.");
  }

  const prompt = `Rate how toxic, hateful, or harmful the following text is, on a scale from 0 (completely fine) to 1 (extremely toxic). Respond with ONLY the number (e.g. "0.1" or "0.85"), nothing else.\n\nText: "${text}"`;
  const content = await callGroq(apiKey, prompt);

  const match = content.match(/[\d.]+/);
  const score = match ? parseFloat(match[0]) : NaN;
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
}

async function scoreComments(comments) {
  const limited = comments.slice(0, MAX_COMMENTS_PER_REQUEST);
  const results = await Promise.all(
    limited.map(async ({ id, text }) => {
      try {
        const toxicity = await scoreComment(text);
        return { id, toxicity };
      } catch (err) {
        return { id, toxicity: 0, error: err.message };
      }
    })
  );
  return results;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXPLAIN_BUTTON") {
    explainButtonText(message.payload?.text ?? "")
      .then((explanation) => sendResponse({ ok: true, explanation }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "SCORE_COMMENTS") {
    scoreComments(message.payload?.comments ?? [])
      .then((scores) => sendResponse({ ok: true, scores }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

function setAdBlockingEnabled(enabled) {
  chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? [AD_RULESET_ID] : [],
    disableRulesetIds: enabled ? [] : [AD_RULESET_ID],
  });
}

// User-added ad/tracker domains use dynamic rules (a separate mechanism
// from the bundled static ruleset above) since they're only known at
// runtime. IDs start well above the ~34 static rule IDs to avoid collision.
const CUSTOM_AD_RULE_ID_BASE = 10000;
const AD_RESOURCE_TYPES = [
  "script", "image", "xmlhttprequest", "sub_frame",
  "media", "font", "stylesheet", "ping", "other",
];

async function applyCustomAdRules(customDomains, enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = enabled
    ? customDomains.map((domain, i) => ({
        id: CUSTOM_AD_RULE_ID_BASE + i,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: `||${domain}^`, resourceTypes: AD_RESOURCE_TYPES },
      }))
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["elderlyMode", "customAdDomains"], (settings) => {
    const enabled = Boolean(settings.elderlyMode);
    setAdBlockingEnabled(enabled);
    applyCustomAdRules(settings.customAdDomains || [], enabled);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  if ("elderlyMode" in changes) {
    setAdBlockingEnabled(Boolean(changes.elderlyMode.newValue));
  }

  if ("elderlyMode" in changes || "customAdDomains" in changes) {
    chrome.storage.sync.get(["elderlyMode", "customAdDomains"], (settings) => {
      applyCustomAdRules(settings.customAdDomains || [], Boolean(settings.elderlyMode));
    });
  }
});
