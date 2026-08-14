# Service worker v5 — expense list fix

After deploying **pesowise-v5** (`public/sw.js`), users who still see failed `/expenses` requests or `Failed to convert value to 'Response'` should refresh the service worker once.

## For end users

1. Open [PesoWise](https://pesowise.unimisk.com) in Chrome/Edge.
2. Hard refresh: **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac).
3. If the issue persists: DevTools → **Application** → **Service Workers** → **Unregister**, then reload the page.

## What was fixed

- Service worker no longer returns `undefined` for SPA routes like `/expenses`.
- `/index.html` is precached for offline fallback.
- New expenses are **not deleted** from the database when receipt linking fails — they remain as **draft** for re-upload.

## For admins

After Vercel deploy, confirm in DevTools → Application → Service Workers that the script URL shows updated content and cache name `pesowise-v5`.
