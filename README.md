# Edgeline app (frontend)

The Edgeline scanner UI, as a real standalone website (built with Vite +
React) instead of a chat-artifact preview — this is what lets it actually
call your deployed proxy server without being blocked by a sandbox.

## Run it locally (optional, needs Node + internet for the one-time install)

```
npm install
npm run dev
```

## Deploy to Vercel

See the walkthrough in chat — short version: push this folder to GitHub,
then import that repo on vercel.com. Vercel auto-detects the Vite setup,
no configuration needed.

Your server's URL is already set in `src/App.jsx` near the top:
```js
const API_BASE = "https://edgeline-proxy.onrender.com";
```
Change that if your Render URL is different.
