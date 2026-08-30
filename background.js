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
async function callGroq(apiKey, messages, { temperature } = {}) {
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
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
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
  const explanation = await callGroq(apiKey, [{ role: "user", content: prompt }]);

  explanationCache[text] = explanation;
  return explanation;
}

const MAX_COMMENTS_PER_REQUEST = 20;

async function scoreComment(text) {
  const apiKey = CONFIG.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Groq API key. Add it to config.js.");
  }

  const systemPrompt = `You are a content moderation classifier. Score how toxic a piece of text is on a scale from 0.0 to 1.0.

Toxic means: personal insults, harassment, name-calling, slurs, threats, or hateful language directed at a person or group.

NOT toxic, even if negative: criticism, complaints, or negative opinions about a product, game, article, or idea (e.g. "this game is boring" or "I didn't like this update" score near 0.0) — these are not toxic unless they also contain a personal insult toward a person or group.

Score calibration:
- 0.0-0.2: Friendly, neutral, or plain negative/critical feedback with no insults.
- 0.3-0.5: Mildly rude, dismissive, or sarcastic, but not a direct personal attack.
- 0.6-0.8: A clear personal insult, name-calling, or demeaning language aimed at a person or group.
- 0.9-1.0: Severe harassment, hate speech, slurs, or threats of violence.

Respond with ONLY a decimal number between 0.0 and 1.0 (e.g. "0.1" or "0.85"). No words, no explanation, no punctuation other than the decimal point.`;

  // temperature: 0 for deterministic scoring — without it, the same comment
  // can get a different score on every scan (the model samples somewhat
  // randomly by default), which made blurring look inconsistent/flaky.
  const content = await callGroq(
    apiKey,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    { temperature: 0 }
  );

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
