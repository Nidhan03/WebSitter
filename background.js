// WebSitter background service worker (MV3).

importScripts("config.js");

const AD_RULESET_ID = "ad_rules";
const GEMINI_MODEL = "gemini-2.0-flash";

// In-memory only, per spec — MV3 service workers unload after ~30s idle,
// so this cache resets often. That's an accepted limitation, not a bug.
const explanationCache = {};

async function explainButtonText(text) {
  if (explanationCache[text]) {
    return explanationCache[text];
  }

  const apiKey = CONFIG.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Gemini API key. Add it to config.js.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const prompt = `Explain in one short, plain-language sentence what clicking a button labeled "${text}" will do on a website. Assume the reader may be unfamiliar with tech jargon. Do not add extra caveats or formatting.`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const explanation = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!explanation) {
    throw new Error("Gemini API returned no explanation.");
  }

  explanationCache[text] = explanation;
  return explanation;
}

const MAX_COMMENTS_PER_REQUEST = 20;

async function scoreComment(text) {
  const apiKey = CONFIG.PERSPECTIVE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing Perspective API key. Add it to config.js.");
  }

  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      comment: { text },
      languages: ["en"],
      requestedAttributes: { TOXICITY: {} },
    }),
  });

  if (!response.ok) {
    throw new Error(`Perspective API error: ${response.status}`);
  }

  const data = await response.json();
  return data.attributeScores?.TOXICITY?.summaryScore?.value ?? 0;
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

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["elderlyMode"], (settings) => {
    setAdBlockingEnabled(Boolean(settings.elderlyMode));
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if ("elderlyMode" in changes) {
    setAdBlockingEnabled(Boolean(changes.elderlyMode.newValue));
  }
});
