# HEIC / HEIF receipt preview

**Doc ID:** DOC-085  
**Status:** in progress  
**Last updated:** 2026-08-05  
**Owner / area:** Expenses — attachments  

---

## 1) Summary

HEIC/HEIF receipts now render in the attachment preview. The file is decoded to JPEG at read time, so an iPhone photo opens inline like any other receipt. When decoding genuinely cannot happen, the dialog now says *why* and offers **Open in new tab** and **Download** — instead of telling the user the receipt was lost.

This affects anyone reviewing receipts photographed on an iPhone: employees checking their own submissions, and every reviewer tier opening an expense from `/review`, `/expenses/:id` or the Admin Panel.

---

## 2) Problem / requirement

HEIC is the iPhone camera default, and **no Chromium or Firefox build can decode it in an `<img>`**. Only Safari can.

Uploads have been converted to JPEG since `uploadCompression.ts` landed, but two populations of raw HEIC still reach the preview:

- **(a)** receipts uploaded before that conversion existed; and
- **(b)** uploads where conversion failed — that branch *deliberately* stores the **original** file (`failureReason: "heic-convert-failed"`) rather than dropping the receipt.

Both landed on the `<img>` `onError` handler. `AttachmentPreviewDialog` had a single `previewError` boolean, and **both** "storage returned nothing" and "the browser refused to decode these bytes" set it. Both then rendered:

> This file is no longer available in storage.
> The attachment record exists but the file was not recovered during migration.

So a user staring at a perfectly intact HEIC receipt was told their file had been lost during migration. That is not a cosmetic wording problem — it is the app reporting data loss that did not occur, which invites a reviewer to reject an expense for a "missing" receipt that is sitting in storage.

Compounding it: **Open in new tab was rendered for PDFs only**, so an image the browser could not paint had no escape hatch at all.

Requirement, as raised: make HEIC files visible; and where they cannot be shown in the dialog, give a button to open them in a new page.

---

## 3) Solution

**Decode at read time.** `resolveImagePreviewSource()` detects HEIC and converts it to JPEG via the `heic2any` dependency that upload compression already uses. The import is dynamic, so the decoder stays a lazy chunk (~341 kB gzip) fetched only on the first HEIC preview.

**Detect by bytes, not just by name.** Storage frequently serves these as `application/octet-stream` — the recorded `content_type` is whatever the browser guessed at upload, and for `.heic` that is routinely empty. So detection is content-type, *or* extension, *or* an ISO-BMFF `ftyp` brand sniff of the first 16 bytes (`heic`, `heix`, `mif1`, `msf1`, …).

**Stop conflating two different failures.** The resolver returns a status instead of a bare URL:

| status | meaning | what the dialog shows |
|---|---|---|
| `ok` | renderable | the image |
| `missing` | bytes are not in storage | the existing storage-loss message |
| `unsupported` | bytes are here, browser cannot decode them | new format message + **Open in new tab** |

It also returns `originalObjectUrl` alongside the renderable one. For HEIC these differ: the `<img>` shows a converted JPEG, while **Download** and **Open in new tab** hand back the real file the user uploaded.

**Always offer the escape hatch.** `Open in new tab` is no longer PDF-only — it renders for any attachment that resolved, and appears a second time inside the `unsupported` block, right where the image failed.

**`onError` no longer means "missing".** If the `<img>` fails after we already hold the bytes, that is by definition a format the browser cannot paint, so it now sets `unsupported`.

`AttachmentThumbnail` picks up conversion for free: it calls `resolveImagePreviewObjectUrl()`, which is retained as a thin wrapper over the new resolver (and revokes the orphaned original so a failed preview does not leak an object URL).

---

## 4) Key files

```
src/lib/attachmentPreview.ts                                        (detection, sniffing, conversion, resolver)
src/components/AttachmentPreviewDialog.tsx                          (status-driven render, new-tab button)
src/locales/{en,hi,gu}/common.json                                  (attachmentPreview.formatUnsupported*, openInNewTab)
src/lib/__tests__/heicAttachmentPreview.test.ts                     (new — 10 tests)
src/components/__tests__/attachmentPreviewUnsupportedFormat.test.tsx (new — 8 tests)
src/components/__tests__/attachmentPreviewExpenseIdRegression.test.tsx (mock updated for the new export)
```

No new dependency: `heic2any@^0.0.4` was already in `package.json` for upload compression.

---

## 5) Database / migrations

**None.** No schema change, no migration, no data touched. Nothing is written back — the conversion happens per preview, in the browser, and the stored file is left exactly as uploaded.

---

## 6) Test plan

Automated (all green):

- [x] `isHeicAttachment` — content type (incl. `; charset=`), extension (incl. uppercase and `?token=`), and negative cases for png/jpeg
- [x] HEIC → JPEG conversion produces a renderable source distinct from the original
- [x] magic-byte detection when storage reports `application/octet-stream` and the filename has no extension
- [x] decode failure → `unsupported`, original retained (**not** `missing`)
- [x] empty conversion result → `unsupported`
- [x] `heic2any` array return (burst / live-photo containers) unwrapped
- [x] genuinely absent bytes → `missing`, and the decoder is never loaded
- [x] ordinary PNG → untouched, decoder never loaded, one object URL reused
- [x] dialog: does not show the storage-loss copy for an undecodable file
- [x] dialog: shows the format message and an Open-in-new-tab control
- [x] dialog: opens the **original**, not the converted stand-in
- [x] dialog: Download points at the original with the right filename
- [x] dialog: a genuinely missing file still shows the storage-loss message
- [x] dialog: a converted HEIC renders the JPEG while Download keeps the original
- [x] locale keys present in en/hi/gu

Suite: **2277 tests / 115 files pass** (was 2259 / 113). `tsc --noEmit` clean, `eslint` clean on changed files, `npm run build` succeeds with `heic2any` emitted as its own lazy chunk.

**Not verified in a real browser.** Reaching this dialog needs an authenticated session and an expense carrying a real HEIC attachment; neither was available here, and no credentials were entered. The decode path itself is exercised only against a mocked `heic2any` — the library's actual output on a real iPhone photo has not been observed in this work. Worth doing on Preview before this is relied on:

- [ ] open a pre-conversion HEIC receipt in Chrome and confirm it renders
- [ ] confirm **Open in new tab** yields the original `.heic`
- [ ] confirm a genuinely orphaned attachment still reports storage loss

---

## 6a) Post-deploy incident — the preview hung on "Loading image…" (rev 2.0)

Rev 1.0 shipped and **the spinner never cleared**. Diagnosis from the production console:

```
Evaluating a string as JavaScript violates the following Content Security Policy
directive because 'unsafe-eval' is not an allowed source of script:
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
Uncaught EvalError: ... at new Function (<anonymous>)
    at QA (a8067219-42f4-439c-8947-ce1cac630040:2:1320381)
```

Those UUID-named scripts are `blob:` **Workers** — DevTools labels a blob worker by the
UUID in its URL. `heic2any` contains 2 × `new Worker` and 3 × `new Function`: it decodes
inside a blob worker whose libheif glue compiles code from a string.

The enforced production CSP (`vercel.json`, verified live on `https://pesowise.unimisk.com`)
carries **no `'unsafe-eval'`**. So `new Function` threw `EvalError` inside the worker, the
worker died without posting a result, and **heic2any's promise never settled — neither
resolving nor rejecting**. `resolveImagePreviewSource` awaited it, so the dialog's
`.finally(() => setPreviewLoading(false))` never ran. A `try/catch` cannot rescue a promise
that never completes; rev 1.0's error handling was structurally unable to fire.

Note `'wasm-unsafe-eval'` would **not** lift this — it permits WebAssembly compilation, not
`new Function`.

Three changes:

1. **`settleWithin()`** — the decode is bounded at 20 s and resolves to `null` on timeout, so
   the dialog always reaches a terminal state. This is the guarantee that matters: whatever
   the decoder does, the spinner ends.
2. **`isDynamicCodeAllowed()`** — probes `new Function("")` before importing the decoder. A
   document without `'unsafe-eval'` goes straight to `unsupported`, skipping both the
   ~1.35 MB chunk download and the 20 s wait on *every* HEIC preview. Not memoised: the
   probe costs microseconds and a cached module-level answer is hidden order-dependent state.
3. **`browserDecodesNatively()`** — tries `createImageBitmap(blob)` first. Safari and iOS
   decode HEIC themselves, so they render the original with no conversion and no CSP
   involvement. This is currently the only path on which a HEIC actually *displays*.

**Net effect under the current CSP:** in Chrome, Edge and Firefox a HEIC receipt now fails
*fast and honestly* — format message plus **Open in new tab** and **Download** — instead of
hanging forever. It does not yet render there. Safari/iOS render it.

## 6b) Server-side decode — `convert-heic` edge function (rev 3.0)

The decision below was resolved in favour of server-side decode. **CSP is a browser-only
policy**, so decoding in Deno sidesteps `new Function` entirely — and needs no CSP change,
which keeps the DOC-082/083 posture intact.

**`supabase/functions/convert-heic/index.ts`** — POST `{ storage_path }`, returns the public
URL of a JPEG rendition. It follows `compress-upload`'s gate exactly: bearer JWT →
`getUser` → active `organization_memberships` row.

Decode once, not once per view:

1. Client probes `derived/<path>.jpg` with a plain public GET — **no function invocation**.
2. Miss → invoke `convert-heic`, which decodes and writes the rendition, then returns it.
3. Every later view of that receipt is step 1 only.

So the historical backlog self-heals as receipts get opened, and steady-state cost is one
cacheable GET.

**Not a general image converter.** Two gates, both required:

- input is an **object key inside the receipts bucket** — never a URL. `normalizeStoragePath`
  rejects `://`, absolute paths, `.`/`..` segments and anything already under `derived/`.
- the **bytes** must sniff as HEIC (`ftyp` brand). The recorded `content_type` is routinely
  empty or `application/octet-stream` for `.heic`, so it cannot be the gate.

Without both, this would be an open conversion proxy pointed at arbitrary content.

Guards: 50 MB input cap, 40 MP output cap (RGBA is 4 bytes/pixel — 40 MP is ~160 MB before
the encoder allocates; refusing beats being OOM-killed into an opaque 502), `upsert: true`
so a partially-written rendition self-heals, and `cacheControl: 31536000`.

**Client ordering** in `resolveImagePreviewSource`: native decode (Safari/iOS) → existing
rendition → invoke function → in-browser `heic2any` → `unsupported`. The server is tried
*before* the in-browser decoder because under the production CSP that decoder cannot run at
all. Every step is bounded, so an undeployed or unreachable function degrades to
`unsupported` with Open in new tab — never a hang.

The rendition keys off the path the bytes were **actually found at**, not the stored path —
`candidateReceiptPaths` recovers from stale `temp/` and expense paths, and filing a rendition
against the stored path would point it at nothing. Covered by a test.

### Deployment record — 2026-08-05

Deployed to the self-hosted Supabase on Coolify. Runtime `supabase/edge-runtime:v1.71.2`.

- Volume resolved from the container's own mount table:
  `/data/coolify/services/<service-id>/volumes/functions → /home/deno/functions`.
- `convert-heic/index.ts` present on host and in the container; folder name exact.
- `_shared/cors.ts` already existed and was **not** modified.
- Unauthenticated `POST /functions/v1/convert-heic` returned
  `{"ok":false,"errorCode":"UNAUTHORIZED","message":"Missing authorization token"}` with
  HTTP 401. That JSON originates **inside the handler**, which proves three things at once:
  the entrypoint was found, the module graph booted, and `../_shared/cors.ts` resolved.
- **The `esm.sh` imports resolved.** No `heic-decode` / `jpeg-js` module errors. The
  `npm:` fallback was not needed — this closes the largest risk rev 3.0 carried.
- The only `wall clock duration warning` / `early termination` lines in the log belong to
  `finalize-expense-receipts` and pre-date this deploy.

**Deployment mechanic worth remembering:** the SSH user could not write under
`/data/coolify/...` without sudo, so the file was placed with `docker cp` into the mounted
volume (ownership `1000:1000`, mode `744`, matching the neighbouring functions). This means
`npm run deploy:edge-functions` — which is scp-based — will hit the same permission wall
under that account. Use `docker cp`, or an account with write access to the volume.

### Post-deploy failure — HTTP 500 on conversion (rev 5.0)

The deployed function returned **500** for every real conversion. The client behaved
correctly throughout — `derived/…heic.jpg` 400s were the expected cache-miss probe, and the
preview fell back to the format message with Open in new tab rather than hanging.

The status code alone narrowed it, without server access:

| Cause | Status it would return | Verdict |
|---|---|---|
| Missing `SUPABASE_URL` / service-role key | 500, but *before* auth | **Ruled out** — the unauthenticated smoke test returned 401, so the env is present |
| Object not in storage | 404 | Ruled out |
| Not HEIC / bad path | 400 | Ruled out |
| Decode failure | 422 | Ruled out |
| **Encode step** | had no handler → outer catch → **500** | **This** |

The defect:

```ts
jpeg.encode({ data: new Uint8Array(decoded.data.buffer), … })
```

`heic-decode` is libheif-wasm backed, so `decoded.data` is a `Uint8ClampedArray` **view into
wasm linear memory**. Reaching through to `.buffer` returns the *entire wasm heap* — tens of
megabytes — ignoring both `byteOffset` and `byteLength`. `jpeg-js` validates
`data.length === width * height * 4`, so it threw; the throw escaped the decode-specific
try/catch and surfaced as an opaque 500.

Fixed with `Uint8Array.from(decoded.data)` — an exact-length copy that is also immune to the
view being detached when wasm memory grows — plus an explicit pixel-count check and a
dedicated `try/catch` around the encoder returning a typed `ENCODE_FAILED` (422) instead of
letting anything reach the outer handler as a 500.

Covered by `src/lib/__tests__/convertHeicPixelBuffer.test.ts`, which reproduces the
heap-versus-frame mismatch against a wasm-shaped view and guards the source (with comments
stripped, so the fix's own explanation cannot satisfy its own guard).

---

### Still unverified

The auth gate and module boot are proven; **the decode and upload path has never executed.**

- [ ] Authenticated conversion of a real HEIC: `ok: true, cached: false`, then `cached: true`
      on a second call.
- [ ] `public_url` actually renders the photo in a browser.
- [ ] Service role can write under `derived/` in the `receipts` bucket (only exercised by a
      real conversion).
- [ ] `receipts` serves `derived/*` publicly — the client reads it with an anonymous GET.
- [ ] Decode CPU/wall time on a real 12 MP iPhone photo against the edge-runtime limits. The
      401 alone showed `x-kong-upstream-latency: 1832` (cold start), and a decode is far
      heavier — this is the remaining plausible failure mode, since `finalize-expense-receipts`
      already trips `early termination` on this runtime.

Until a real HEIC is converted end to end, the client keeps degrading to the format message
with **Open in new tab** — no hang, no false "file was lost".

### Original decision record — making HEIC render in Chromium/Firefox

Two options, both with real cost, neither taken unilaterally:

| Option | Effect | Cost |
|---|---|---|
| Add `'unsafe-eval'` to `script-src` | heic2any works; renders everywhere | Weakens CSP **application-wide** to fix one preview, weeks after the DOC-082/083 security remediation. Hard to justify. |
| Server-side decode (`api/` route or edge function, `sharp`/`heic-convert`) | Renders everywhere, no CSP change, no 1.35 MB client chunk | New endpoint + native dependency + auth to read from storage; cold-start and CPU cost per preview. |

A third, cheapest option: fix it at the **source** instead. Upload-time conversion in
`uploadCompression.ts` calls the same `heic2any` and is therefore blocked by the same CSP —
which very likely explains why population (b) exists at all. If upload-side conversion were
moved server-side, no new raw HEIC would ever be stored, and this read-time path would only
ever need to serve the historical backlog.

---

## 7) Known trade-offs / follow-ups

- **Thumbnail decode cost.** `AttachmentThumbnail` falls back to the resolver after its direct `<img>` fails, which for HEIC it always will. A list showing many HEIC receipts will therefore decode each one. `heic2any` runs on the main thread (the library's worker loads from a CDN the production CSP blocks — the same constraint `uploadCompression.ts` documents), so a dense list of large HEIC files may feel slow. Not addressed here; a size guard or a "tap to load" thumbnail is the obvious next step if it bites.
- **No progress indication during decode.** A large HEIC sits under the existing spinner with no distinct "converting" state.
- **Root cause untouched.** This is a read-time repair. The upload path already converts; files in population (b) exist because that conversion failed, and *why* it failed has not been investigated here.

---

## 8) Related docs

- [Expense submission — storage move & attachment fix](./expense-submit-storage-and-attachment-fix.md)
- [Receipt finalization hotfix](./receipt-finalization-hotfix.md)
- [Mobile upload & PWA stability fixes](./mobile-upload-and-pwa-stability-fixes.md) (upload-time HEIC conversion + compression)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-06 | 7.0 | Agent | **Backend live and proven; frontend origin defect fixed.** imgproxy `MAX_SRC_RESOLUTION` 16.8 -> 50 and `image/webp` added to the receipts bucket (public flag and 10 MB size limit unchanged). Verified: direct transform HTTP 200 `image/webp` 103,810 bytes 1299x2000; first call `cached=false`, second `cached=true` with no second transformation; original SHA `4bf46d3d...` unchanged; no OOM, no worker cancellation. Output is WebP, not JPEG — `IMGPROXY_AUTO_WEBP=true` plus `Accept: image/jpeg,image/webp` means the format is negotiated, which is exactly why it is read from the response Content-Type. The live run exposed a frontend defect: the function's `public_url` carries the Edge Runtime's INTERNAL `http://supabase-kong:8000` origin, unresolvable from a browser, so the FIRST open of a fresh rendition would fail while a later reopen succeeded via the direct probe. The client now treats `storage_path` as authoritative, validates it at runtime (string, `derived/` prefix, no `..`, no `://`, `.jpg`/`.webp`), and builds the URL with its own configured Supabase client; a legacy URL-only reply has its key extracted and rebuilt, failing closed rather than fetching an unparseable or foreign origin. 2368 tests / 117 files. **In-app Chrome/Edge/mobile smoke still pending.** |
| 2026-08-06 | 6.0 | Agent | **Phase A — `convert-heic` rewritten to stop decoding in the isolate.** Root cause proven: imgproxy rejected the receipt with "Source image resolution is too big", not an unsupported format, so libheif was always present; the receipt measures 3768x5800 = 21.9 MP = 83 MB of RGBA against a 150 MB worker cap, which no amount of copy-elimination could fit. Removed `heic-decode`, `jpeg-js`, RGBA materialisation and `jpeg.encode`; the function now calls the Storage render endpoint (2000x2000, contain, q82, Accept jpeg+webp, never `format=origin`) and stores whichever format the response actually is — `.jpg`/`image/jpeg` or `.webp`/`image/webp`, never WebP under a false JPEG type. Cache and client both probe `.jpg` before `.webp` so legacy renditions stay valid. Typed `TRANSFORM_FAILED` (422) replaces opaque 500s; logging reduced to safe fields with the storage path hashed. 2356 tests / 117 files. **No live container changed, restarted or deployed to — the imgproxy limit change and end-to-end verification are Phase B, pending owner authorization.** |
| 2026-08-06 | 5.0 | Agent | **Fixed the HTTP 500 that every real conversion returned.** `jpeg.encode` was fed `new Uint8Array(decoded.data.buffer)`; because `heic-decode` is libheif-wasm backed, that yielded the entire wasm heap rather than the frame, jpeg-js rejected the length mismatch, and the throw escaped into the outer handler as an opaque 500. Diagnosed from the status code alone — a missing env var would have 500ed the earlier unauthenticated smoke test instead of 401ing it, a decode failure returns 422 and a missing object 404, which left only the unguarded encode. Replaced with `Uint8Array.from(decoded.data)` (exact-length copy, immune to wasm heap growth detaching the view), added a pixel-count check and gave the encoder its own `ENCODE_FAILED` (422). 7 new tests, 2328 total. **Not deployed by this work — no SSH access from this machine; the owner deploys.** |
| 2026-08-05 | 4.0 | Agent | **Deployed** to the self-hosted Supabase on Coolify (`supabase/edge-runtime:v1.71.2`). Unauthenticated POST returned the handler's own `{"errorCode":"UNAUTHORIZED"}` JSON, proving entrypoint, module graph and `_shared/cors.ts` all resolved — and **the esm.sh imports worked**, so the `npm:` fallback rev 3.0 warned about was not needed. `_shared/cors.ts` already existed and was untouched. Deployment note: the SSH user cannot write `/data/coolify/...` without sudo, so the file went in via `docker cp` (1000:1000, mode 744) — the scp-based `npm run deploy:edge-functions` will hit the same wall under that account. **Decode and upload still never executed:** no authenticated conversion, no `public_url` render check, and no measurement of decode CPU against the runtime's limits — the remaining plausible failure, given `finalize-expense-receipts` already trips `early termination` there. No code change in this revision. |
| 2026-08-05 | 3.0 | Agent | **Server-side decode — `convert-heic` edge function.** Resolves the rev 2.0 open decision without touching CSP: decoding in Deno sidesteps `new Function` because CSP is browser-only. Function mirrors `compress-upload`'s auth gate (JWT → getUser → active org membership) and writes a JPEG to `derived/<path>.jpg`, so a receipt is decoded once, ever — the client probes that path with a plain public GET and only invokes the function on a miss, letting the backlog self-heal as receipts are opened. Hardened against being an open conversion proxy: object keys inside the receipts bucket only (never URLs; `://`, absolute paths, `.`/`..` and `derived/` all rejected) plus an `ftyp` byte sniff, since the recorded content_type for `.heic` is routinely empty. 50 MB input and 40 MP output caps, `upsert` for self-healing partial writes. Client order: native → rendition → function → heic2any → unsupported, every step bounded so an undeployed function degrades rather than hangs. Rendition keys off the path the bytes were actually found at, not the stored one. 4 new tests, 2284 total; tsc, eslint and build clean. **`deno` is not installed in this environment — the function was never typechecked or executed, and its esm.sh imports are unproven in the edge runtime. Not deployed by this work.** |
| 2026-08-05 | 2.0 | Agent | **Hotfix — rev 1.0 hung the preview on "Loading image…" in production.** heic2any decodes in a blob Worker whose libheif glue calls `new Function`; the enforced CSP has no `'unsafe-eval'`, so the worker threw EvalError and died, and heic2any's promise never settled — an unbounded await that no try/catch could rescue. Added `settleWithin()` (20 s bound, always terminal), `isDynamicCodeAllowed()` (probe `new Function` and skip the decoder plus its 1.35 MB chunk when eval is barred) and `browserDecodesNatively()` (`createImageBitmap` first, so Safari/iOS render the original with no conversion). Under the current CSP, Chromium/Firefox now fail fast with the format message and Open in new tab rather than hanging; they still do not render HEIC. 3 new tests, 2280 total. Rendering there needs a decision: `'unsafe-eval'` app-wide, or server-side decode — see §6a. |
| 2026-08-05 | 1.0 | Agent | Initial — read-time HEIC→JPEG conversion with `ftyp` magic-byte detection; `missing` vs `unsupported` split so an intact receipt is never reported as lost; Open in new tab extended to all attachment types and surfaced in the failure block; download/new-tab serve the original file. 18 new tests, 2277 total. No migration, no data change. Not yet verified in a browser against a real HEIC receipt. |
