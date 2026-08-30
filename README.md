# WebSitter

![WebSitter](WebSitter_thumbnail.png)

WebSitter is a browser extension that makes any website safer and easier to use for the people who need it most, from blurring inappropriate content for kids to simplifying cluttered pages and flagging scams for elderly or low-digital-literacy users.

## Development setup

1. Clone the repo:

   ```sh
   git clone https://github.com/Nidhan03/WebSitter.git
   cd WebSitter
   ```

2. Get a free Groq API key from **[console.groq.com/keys](https://console.groq.com/keys)**. Copy `config.example.js` to `config.js` and fill it in (used for both tap-to-explain and toxicity scoring).

   ```js
   // config.js
   const CONFIG = {
     GROQ_API_KEY: "gsk_your_key_here",
   };
   ```

3. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", and select this folder.
4. Click the WebSitter toolbar icon to open the options page and toggle Elderly Mode / Kid-Safe Mode.

## Features

**👴 Elderly Mode**

- Enlarges buttons, links, and form fields to ~44px tap targets
- Blocks known ad/tracker domains via `declarativeNetRequest`, plus any domains you add yourself in the options page
- Scans page text for common scam/urgency phrases and shows a dismissible warning banner
- Tap-to-explain: hover any button/link to reveal a "?" badge; click it for a plain-language explanation powered by Groq
- Text-to-speech: highlight any paragraph to get a "🔊 Listen" button that reads the selected text aloud, via the browser's built-in Web Speech API (no network call)

**👶 Kid-Safe Mode**

- Blurs images flagged as inappropriate, scanned entirely client-side via NSFW.js (no API key, lazy-loaded as images enter the viewport)
- Warns before following links to domains on WebSitter's known-unsafe blocklist, plus any sites you add yourself in the options page
- Scores page text for toxicity via Groq and blurs anything flagged, with click-to-reveal — covers comments/reviews as well as general paragraphs and list items, not just comment-shaped elements

## Project structure

```
manifest.json          MV3 manifest
background.js          Service worker: Groq API calls (explain + toxicity), ad-block toggling
content.js             Injected on every page: mode detection and all on-page behavior
options.html/js/css    Full-page settings UI (mode toggles)
data/                  Ad domains, scam keywords, unsafe domain blocklist (bundled JSON)
rules/                 declarativeNetRequest static ruleset
lib/nsfwjs/            Vendored NSFW.js + MobileNetV2 model (client-side image classification)
config.js              Your API keys (gitignored — copy from config.example.js)
```

## Future modes

WebSitter's two modes today are just the start. Planned/potential additions:

- **🌐 Language Mode** — auto-translate or simplify page text for non-native speakers, on top of the plain-language explanations tap-to-explain already gives.
- **👁️ Low-Vision Mode** — high-contrast color palettes, larger cursors, and screen-reader-friendly enhancements for users with limited vision.
- **🎯 Focus Mode** — hides distracting elements (autoplay video, infinite-scroll feeds, popups) for users who find cluttered pages overwhelming.
- **🖐️ Motor Accessibility Mode** — bigger click targets and reduced precision requirements for users with limited fine motor control.
