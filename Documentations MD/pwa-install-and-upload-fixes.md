# PWA install and mobile upload fixes

**Doc ID:** DOC-006  
**Status:** in progress  
**Last updated:** 2026-06-25  
**Owner / area:** PWA, mobile uploads, service worker  

---

## 1) Summary

Fixes Progressive Web App installability and receipt uploads when the app runs as an installed PWA (especially iOS/Android). Adds proper 192×192 and 512×512 install icons, stabilizes the web manifest URL, improves the service worker manifest cache, and relaxes file MIME validation for camera captures that return empty types.

---

## 2) Problem / requirement

Users reported:

- Could not install / download the PesoWise app from the browser.
- File uploads (camera / gallery) failed or behaved incorrectly in the installed app.

Root causes:

| Issue | Impact |
|-------|--------|
| Manifest declared `HERO.png` (612×531) as 192/512 icons | Chrome install criteria not met |
| Manifest link cache-busted with `?v=Date.now()` on every `PwaHead` update | `beforeinstallprompt` delayed or blocked |
| Service worker returned `index.html` for offline manifest requests | Invalid manifest MIME when offline |
| iOS/PWA camera files often have empty `file.type` | Upload rejected before compression |
| Camera button hidden in standalone desktop/tablet PWA | No easy photo capture path |

---

## 3) Solution

1. **Install icons** — `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` generated from brand artwork; referenced in manifest API, static manifest, and `index.html`.
2. **Stable manifest URL** — production uses `/site.webmanifest` without per-render cache busting; only updates link when org context changes.
3. **Service worker v7** — precaches icons; manifest fetch caches JSON; offline fallback returns manifest JSON (not HTML).
4. **Upload MIME helper** — `src/lib/uploadMimeType.ts` infers type from extension or defaults camera captures to `image/jpeg`.
5. **FileUpload** — camera shown in standalone PWA; picker opens after `requestAnimationFrame` so draft flush completes first.
6. **Install UI** — clearer manual install steps (Chrome / Edge / Android) when native prompt unavailable.
7. **Permissions-Policy** — `camera=(self)` so file/camera pickers work in installed mode.

---

## 4) Key files

```
public/icons/icon-192.png
public/icons/icon-512.png
public/icons/icon-maskable-512.png
public/site.webmanifest
public/sw.js
api/manifest.ts
src/lib/pwa.ts
src/lib/pwaManifest.ts
src/lib/pwaInstallCapture.ts
src/lib/uploadMimeType.ts
src/components/FileUpload.tsx
src/components/PwaInstallDialogs.tsx
src/components/PwaHead.tsx
vercel.json
index.html
```

---

## 5) Database / migrations

None.

---

## 6) Test plan

- [ ] **Chrome Android (production):** DevTools → Application → Manifest shows 192 and 512 icons; Install prompt or menu → Install app works.
- [ ] **Chrome desktop:** Address-bar install icon appears after engagement; Settings → Install app triggers native dialog.
- [ ] **iOS Safari:** Settings → Install app shows Add to Home Screen guide; installed app opens in standalone.
- [ ] **Service worker:** Application → Service Workers shows `/sw.js`, cache `pesowise-v7`.
- [ ] **Expense upload (installed PWA):** New expense → Take Photo → upload succeeds (no “only PNG/JPG” error on HEIC/empty MIME).
- [ ] **Expense upload (browser tab):** Choose Files + Take Photo on mobile still work.
- [ ] **Offline manifest:** Airplane mode → reload → manifest request does not return HTML (optional).

---

## 7) Related docs

- [Mobile expense form reset on photo upload](../docs/mobile-expense-form-reset-on-photo-upload.md) (DOC-L07)
- [Service worker update v5](../docs/service-worker-update-v5.md) (DOC-L14 — superseded by v7 in this doc)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-25 | 1.0 | Agent | Icons, manifest stability, SW v7, upload MIME fixes, install UI |
