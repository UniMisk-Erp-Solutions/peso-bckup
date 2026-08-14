# HEIC Receipt Preview — Full Incident & Work Report

**Doc ID:** DOC-086
**Status:** BACKEND RESOLVED — FINAL FRONTEND SMOKE PENDING (see §9d–§9f)
**Last updated:** 2026-08-06
**Owner / area:** Expenses — attachments, Supabase Edge Functions
**Companion doc:** [DOC-085 — HEIC / HEIF receipt preview](./heic-attachment-preview.md) (the feature doc; this is the chronological narrative)

---

## 1) TL;DR

A reviewer opened a HEIC receipt and was told **"This file is no longer available in storage — the attachment record exists but the file was not recovered during migration."**

The file was in storage, intact. The app was reporting data loss that had not occurred.

Fixing it uncovered **four distinct defects**, three of them introduced by the fix itself, each only visible once the previous one was cleared:

| # | Defect | Symptom | Status |
|---|---|---|---|
| 1 | Two different failures shared one error flag | False "file was lost" message | Fixed, deployed |
| 2 | Unbounded `await` on a library that never settles | Preview hung forever on "Loading image…" | Fixed, deployed |
| 3 | Restoration outran the capabilities query | (Review Expenses) silent drop to page 1 | Fixed, deployed |
| 4 | Full-resolution decode inside a 150 MB isolate | HTTP 500 on every conversion | **Resolved** — decode moved to imgproxy |
| 5 | Function returned an internal Docker origin | First open of a new rendition would fail | Fixed in the client |

Current state: **the backend converts HEIC end to end** (verified: 3768 × 5800 → 1299 × 2000 WebP, 103,810 bytes, cache hit on the second call, original byte-identical). The final in-app Chrome smoke test on the Production frontend build is still outstanding.

---

## 2) The original defect

`AttachmentPreviewDialog` carried a single `previewError` boolean. **Two completely different failures both set it:**

- storage returned nothing (the file really is gone), and
- the `<img>` refused to decode the bytes (the file is fine, the browser can't paint it).

Both rendered the storage-loss message.

HEIC is the **iPhone camera default**, and no Chromium or Firefox build can decode it in an `<img>` — only Safari can. So every HEIC receipt took the second path and was reported as data loss.

This is not a wording problem. It invites a reviewer to reject an expense over a "missing" receipt that is sitting in the bucket.

**Why raw HEIC exists in storage at all.** Upload-time conversion has existed since `uploadCompression.ts`, but three populations survive it:

- **(a)** receipts uploaded before that conversion existed
- **(b)** uploads where conversion *failed* — that branch deliberately stores the **original** rather than dropping the receipt (`failureReason: "heic-convert-failed"`)
- **(c)** the `compress-upload` edge function lists `image/heic` in `ALLOWED_MIME` but only imports `pdf-lib`; images take a `"passthrough"` branch and are stored byte-for-byte unchanged

Population (b) is almost certainly caused by the same CSP block described in §4 — the browser-side converter cannot run in production either.

---

## 3) Fix 1 — separate "missing" from "undecodable" (rev 1.0)

`resolveImagePreviewSource()` now returns a status instead of a bare URL:

| status | meaning | dialog shows |
|---|---|---|
| `ok` | renderable | the image |
| `missing` | bytes not in storage | the storage-loss message |
| `unsupported` | bytes present, browser can't decode | format message + **Open in new tab** |

Plus:

- **Detection by bytes, not name.** Storage routinely serves these as `application/octet-stream` — the recorded `content_type` is whatever the browser guessed at upload, and for `.heic` that is frequently empty. Detection is content-type **or** extension **or** an ISO-BMFF `ftyp` brand sniff of the first 16 bytes (`heic`, `heix`, `mif1`, `msf1`, …).
- **`onError` no longer means "missing".** If the `<img>` fails after the bytes are already held, that is by definition an undecodable format.
- **Open in new tab is no longer PDF-only.** It renders for any resolved attachment, and again inside the failure block.
- **Download and Open in new tab always serve the ORIGINAL**, never the converted stand-in.
- A `FileReader` fallback backs `Blob.arrayBuffer()`, which jsdom lacks — without it the byte sniff would pass tests while silently answering "not HEIC" in the test runtime.

**Commit:** `53de42d`

---

## 4) Fix 2 — the preview hung forever (rev 2.0)

Rev 1.0 shipped, and the dialog stuck on "Loading image…" permanently.

Production console:

```
Evaluating a string as JavaScript violates the following Content Security Policy
directive because 'unsafe-eval' is not an allowed source of script:
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
Uncaught EvalError: ... at new Function (<anonymous>)
    at QA (a8067219-42f4-439c-8947-ce1cac630040:2:1320381)
```

Those UUID-named scripts are **blob Workers** — DevTools labels a blob worker by the UUID in its URL. `heic2any` contains 2 × `new Worker` and 3 × `new Function`: it decodes inside a worker whose libheif glue compiles code from a string.

The enforced production CSP (verified live on the production domain) has **no `'unsafe-eval'`**. So `new Function` threw `EvalError` **inside the worker**, the worker died without posting a result, and **heic2any's promise never settled — neither resolving nor rejecting**. The resolver awaited it, so the dialog's `.finally(() => setPreviewLoading(false))` never ran.

> A `try/catch` cannot rescue a promise that never completes. Rev 1.0's error handling was structurally incapable of firing.

`'wasm-unsafe-eval'` would **not** lift this — it permits WebAssembly compilation, not `new Function`.

Three changes:

1. **`settleWithin()`** — the decode is bounded at 20 s and resolves to `null` on timeout, so the dialog always reaches a terminal state.
2. **`isDynamicCodeAllowed()`** — probes `new Function("")` *before* importing the decoder. A document without `'unsafe-eval'` goes straight to `unsupported`, skipping both the ~1.35 MB chunk download and the 20 s wait on every preview. Deliberately not memoised: the probe costs microseconds and a cached module-level answer is hidden order-dependent state.
3. **`browserDecodesNatively()`** — tries `createImageBitmap(blob)` first. Safari and iOS decode HEIC themselves, so they render the original with no conversion and no CSP involvement.

**Commit:** `7a11b80`

---

## 5) Decision — server-side decode instead of weakening CSP

Two ways to make HEIC render in Chromium/Firefox:

| Option | Cost |
|---|---|
| Add `'unsafe-eval'` to `script-src` | Weakens CSP **application-wide** to fix one preview, weeks after the DOC-082/083 security remediation |
| Decode server-side | New endpoint + dependency, no CSP change |

**Server-side was chosen.** CSP is a browser-only policy; a server never evaluates it.

`supabase/functions/convert-heic/index.ts` — POST `{ storage_path }` → public URL of a JPEG rendition. Auth gate mirrors `compress-upload` exactly: bearer JWT → `getUser` → active `organization_memberships` row.

**Decode once, not once per view:**

1. Client probes `derived/<path>.jpg` with a plain public GET — **no function invocation**
2. Miss → invoke `convert-heic`, which decodes, stores and returns it
3. Every later view is step 1 only

The historical backlog self-heals as receipts get opened.

**Deliberately not a general image converter.** Two gates, both required:

- input is an **object key inside the receipts bucket** — never a URL. `normalizeStoragePath` rejects `://`, absolute paths, `.`/`..` segments and anything already under `derived/`
- the **bytes** must sniff as HEIC via `ftyp` brand

Without both, this is an open conversion proxy pointed at arbitrary content.

Guards: 50 MB input cap, 40 MP output cap, `upsert: true` so a partial rendition self-heals, one-year `cacheControl`.

The rendition keys off the path the bytes were **actually found at**, not the stored path — `candidateReceiptPaths` recovers from stale `temp/` and expense paths, and filing against the stored path would point at nothing.

**Commit:** `b649759`

---

## 6) Deployment — self-hosted Supabase on Coolify

`supabase functions deploy` does **not** work here. Supabase is self-hosted; edge functions are files in a Docker volume.

| | |
|---|---|
| Host | `websrv`, Ubuntu 22.04.5 |
| Runtime | `supabase/edge-runtime:v1.71.2` |
| Container | `e9af7d137f14` |
| Volume | `/data/coolify/services/<service-id>/volumes/functions → /home/deno/functions` |
| Stacks on host | **5** Supabase stacks; only this one has `convert-heic`, `compress-upload`, `bulk-*` |

**Identify the right container before touching anything** — deploying to the wrong stack is easy with five present:

```bash
docker ps --format '{{.ID}} {{.Names}}' | grep -i edge
docker exec <id> ls /home/deno/functions      # PesoWise has convert-heic + compress-upload
```

**Deploy mechanic:** the SSH account **cannot write** `/data/coolify/...` without sudo, and sudo requires a password. `docker cp` writes *through* the bind mount to the host volume, so it persists across restarts:

```bash
scp supabase/functions/convert-heic/index.ts <host>:/tmp/ch-new.ts
tr -d '\r' < /tmp/ch-new.ts > /tmp/ch-clean.ts        # normalise CRLF from Windows
docker cp /tmp/ch-clean.ts <id>:/home/deno/functions/convert-heic/index.ts
docker exec <id> sh -c "chown 1000:1000 …; chmod 744 …"   # match neighbouring functions
docker restart <id>
```

> The repo's own `npm run deploy:edge-functions` is **scp-based** and will fail for that account. Use `docker cp`.

**Credential-free verification.** Without a JWT you can still prove the function deployed and its imports resolved:

```bash
curl -s -i -X POST https://<supabase-host>/functions/v1/convert-heic \
  -H "Content-Type: application/json" -d '{}'
```

- `{"errorCode":"UNAUTHORIZED"}` → **success**; that JSON can only come from inside the handler
- `could not find an appropriate entrypoint` → the file is in the wrong place
- generic gateway 401, no JSON → ambiguous; check container logs instead

The `esm.sh` imports (`heic-decode`, `jpeg-js`) **do resolve** in this runtime. The `npm:` fallback was not needed.

---

## 7) Fix 3 — the HTTP 500 (rev 5.0)

Deployed, and every real conversion returned **500**.

### Narrowing it from the status code alone

| Cause | Would return | Verdict |
|---|---|---|
| Missing `SUPABASE_URL` / service-role key | 500, but **before** auth | **Ruled out** — the unauthenticated probe returned 401, so env is present |
| Object missing | 404 | Ruled out |
| Bad path / not HEIC | 400 | Ruled out |
| Decode failure | 422 | Ruled out |
| **Encode** | had no handler → outer catch → **500** | **Candidate** |

### Defect A — the pixel buffer

```ts
jpeg.encode({ data: new Uint8Array(decoded.data.buffer), … })
```

`heic-decode` is libheif-**wasm** backed, so `decoded.data` is a `Uint8ClampedArray` **view into wasm linear memory**. Reaching through to `.buffer` returns the **entire wasm heap**, ignoring both `byteOffset` and `byteLength`.

### Defect B — the real cause, from the server logs

```
serving the request with /home/deno/functions/convert-heic
memory limit reached for the worker: isolate: 9b91fddc-1e18-4eb4-90a8-504efbc91734
failed to send request to user worker: request has been cancelled by supervisor
user worker failed to respond: request has been cancelled by supervisor
```

**The isolate is OOM-killed by the supervisor.** That is why the response had no JSON body and why none of the typed error codes ever appeared — the worker dies before it can answer.

The arithmetic:

- No memory env is set on that runtime → **default 150 MB per isolate**
- A 12 MP iPhone photo → 12M × 4 bytes = **~48 MB** of RGBA
- libheif holds its own copy in the wasm heap → **another ~48 MB+**
- The first fix used `Uint8Array.from(decoded.data)`, which **added a third full frame**
- Plus jpeg-js internals and its output buffer

### The fix applied

```ts
const rgba = new Uint8Array(
  decoded.data.buffer,
  decoded.data.byteOffset,
  decoded.data.byteLength,
);
```

An exact-length **view**. The whole wasm heap is still never exposed, so Defect A stays fixed — at **zero extra allocation**, removing ~48 MB of peak memory versus the copy.

Also added: an explicit pixel-count check returning `DECODE_FAILED`, and a dedicated `try/catch` around the encoder returning a typed `ENCODE_FAILED` (422), so nothing from that stage can surface as a bare 500 again.

**Commits:** `c27c5df`, `7ffb229`

---

## 8) Tests

`src/lib/__tests__/convertHeicPixelBuffer.test.ts` — the function runs under Deno and cannot execute in this test runtime, so these pin what *is* checkable:

- reproduces the heap-vs-frame mismatch against a **wasm-shaped view** (a small view at a non-zero offset inside a much larger `ArrayBuffer`)
- the three-argument view is exactly the frame, offset and all
- the view **aliases** rather than copies — that is the point, given the 150 MB cap
- source guards: no one-argument `new Uint8Array(decoded.data.buffer)`; the three-argument form is present; the pixel-count check exists; the encoder sits inside a `try`

The guards **strip comments first** — the fix's own explanation necessarily quotes the dangerous expression and would otherwise satisfy its own guard.

Client-side coverage lives in `heicAttachmentPreview.test.ts` (17) and `attachmentPreviewUnsupportedFormat.test.tsx` (8), including a case that reproduces the never-settling promise under fake timers.

**Suite: 2328 tests / 117 files.** tsc, eslint, build and `security:secrets` clean. No SQL, no migration, no RLS change.

---

## 9) OPEN — is 150 MB enough?

The memory fix removes ~48 MB of waste. **It may not be sufficient**: the decode alone can approach the cap on a large photo.

Open a HEIC receipt and read the outcome:

| Outcome | Meaning |
|---|---|
| Renders | Done |
| Typed `422` in the response body | A code-level problem, fixable in the function |
| Bare `500` + `memory limit reached` in logs | The decode genuinely needs more than 150 MB |

If it is the third, the fix is raising the per-worker memory limit. The host has **125 GB RAM, ~113 GB available**, so 512 MB is trivially affordable.

**Not done, deliberately:** that env change affects **every function on that Supabase stack**, not just this one. It is an owner decision.

Check the logs with:

```bash
docker logs --since 30m e9af7d137f14 2>&1 | grep -iE "convert-heic|memory limit|error"
```

Rollback if needed — the pre-fix version was backed up before deployment:

```bash
docker cp /tmp/convert-heic-BACKUP-20260806-091701.ts e9af7d137f14:/home/deno/functions/convert-heic/index.ts
docker restart e9af7d137f14
```

---

## 9a) ROOT CAUSE FOUND — source resolution, not a marginal memory overrun (2026-08-06)

The native Supabase Storage → imgproxy transformation path was probed against the real
failing receipt before any further code change. It returned **HTTP 422**, and imgproxy's own
log gives the reason:

```
status=422  error="Can't download source image: Source image resolution is too big"
```

That is **not** "unsupported format". imgproxy read the file far enough to measure it, which
means **libheif is present and HEIC decoding works**. It was rejected against
`IMGPROXY_MAX_SRC_RESOLUTION=16.8` (megapixels).

Measuring the receipt directly from its ISO-BMFF `ispe` box:

| | |
|---|---|
| Declared size | **3768 × 5800 = 21.9 MP** |
| imgproxy limit | 16.8 MP — **over by 1.3×** |
| Full RGBA if decoded | **83 MB** |
| Edge isolate limit | 150 MB |

**This retro-explains the Edge Function OOM exactly.** 83 MB of RGBA, plus libheif's own copy
in the wasm heap, plus jpeg-js working buffers, cannot fit in 150 MB. The earlier
`Uint8Array.from` copy added a *second* 83 MB on top, which is why it failed so decisively;
the three-argument view removed that copy but **could never have been sufficient** — the
fundamental full-resolution decode inside the isolate is the problem, not the extra copy.

### Consequence for the architecture

Deno-side decoding is the wrong place for this work regardless of the memory limit. imgproxy
decodes in native code (libvips/libheif), streams, and downscales without materialising a
full RGBA frame in a sandboxed JS heap.

**The preferred architecture is viable and blocked by exactly one config value.**

### Open decision — one env change, not a code change

`IMGPROXY_MAX_SRC_RESOLUTION` on `imgproxy-<service-id>` must be raised above the source
resolution of real receipts. 21.9 MP is a current iPhone; 48 MP models exist, so a value
around **50** gives real headroom.

Blast radius is limited to this stack's own imgproxy container — it is per-stack, not shared
across the five Supabase deployments on the host. It affects image transformations only, and
does **not** touch the Edge Runtime's 150 MB worker limit, which should stay as it is.

Not applied: it requires editing the Coolify service configuration and redeploying that
container, which is a materially larger action than the `docker cp` used for function
updates, and is the owner's call.

**Once raised, the `convert-heic` refactor in the task spec becomes implementable and
testable** — drop `heic-decode` and `jpeg-js` entirely, call the transformation endpoint, and
store the returned bytes. Until then, implementing that refactor would be shipping code that
cannot succeed.

---

## 9b) Phase A complete — refactor landed, live change pending (2026-08-06)

`convert-heic` has been rewritten in the repository to remove in-isolate decoding entirely.
**No live container was changed, restarted or deployed to.**

### Architecture removed

`heic-decode`, `jpeg-js`, WASM HEIC decoding, RGBA materialisation, pixel-buffer handling,
`jpeg.encode`, and all decode-time pixel-memory assumptions.

### Architecture now

Authenticate → validate path → cache probe (`.jpg` then `.webp`) → confirm original exists →
sniff 16 header bytes for `ftyp` → call the Storage render endpoint → validate the response →
store under the extension the bytes actually are.

Peak memory in the isolate is now one compressed original plus one compressed rendition.
The full-resolution decode happens in imgproxy, in native code.

| Transform parameter | Value |
|---|---|
| width | 2000 |
| height | 2000 |
| resize | contain |
| quality | 82 |
| Accept | `image/jpeg,image/webp` |
| `format=origin` | **never requested** — the origin is the unrenderable format |

**Output format is not assumed.** `IMGPROXY_AUTO_WEBP=true` on this deployment, so the format
is negotiated. The response `Content-Type` decides: JPEG → `.jpg` + `image/jpeg`, WebP →
`.webp` + `image/webp`. HEIC output, non-image output and empty bodies are rejected with a
typed `TRANSFORM_FAILED` (422, not 500 — the function is alive and has a definite answer).
WebP bytes are never stored under `.jpg`.

Cache probe order is **`.jpg` first**, so renditions created before WebP was possible stay
valid and are never bypassed. The client probes in the same order.

Logging is structured and deliberately sparse: request ID, stage, elapsed ms, input bytes,
status, output bytes, output content type, cached flag, error code. The storage path — which
identifies an expense and its owner — is reduced to a truncated one-way digest. No
Authorization header, JWT, service-role key, signed URL or public URL is ever logged.

### Validation (local)

2356 tests / 117 files pass. `tsc`, `typecheck:api`, `build`, `migrations:check`,
`security:secrets` all clean; lint at the unchanged 458 baseline with zero problems in
changed files. No SQL, no migration, no RLS change, no CSP change, no Review Expenses change.

---

## 9c) Night deployment — pending owner authorization

> **Do not execute any step below until the owner says `RUN PHASE B NOW`.**
> The owner cannot restart containers during working hours.

### Prepared artifacts

| | |
|---|---|
| Package | `…/scratchpad/heic-night-deploy/` |
| Source | `convert-heic-source.ts` |
| Normalized | `convert-heic-clean.ts` (identical — the working tree is already LF) |
| SHA-256 (both) | `a630c9452c1eccf662cfb53de89f55f8cb2d744decaf0cf206740325641a51a5` |
| Size | 15,471 bytes |
| Target | `/home/deno/functions/convert-heic/index.ts` |
| Owner / mode | `1000:1000`, `744` (matching neighbouring functions) |

### imgproxy configuration change

| | |
|---|---|
| Service | `imgproxy-evo3o0fdjaroxq7uohrm21cp` (`darthsim/imgproxy:v3.30.1`) |
| Persistent source | Coolify docker-compose, project `evo3o0fdjaroxq7uohrm21cp` |
| Current | `IMGPROXY_MAX_SRC_RESOLUTION=16.8` |
| Night target | `IMGPROXY_MAX_SRC_RESOLUTION=50` |
| Rollback | `16.8` |
| Effect of saving | Compose config-hash changes, so the container is **recreated**, not merely restarted |

**Why 50:** the controlled receipt is 21.9 MP; current iPhones produce up to 48 MP; 50 covers
normal phone photography with headroom while keeping an explicit finite ceiling. Not
unlimited, not zero. Applies to this PesoWise imgproxy only — it is per-stack, not shared
with the other four Supabase deployments.

### Sequence

1. Confirm a low-traffic maintenance window.
2. Re-identify the PesoWise stack **by evidence, never by today's container ID**:
   `docker ps --format '{{.ID}} {{.Names}} {{.Image}}'`, then for each edge-runtime
   candidate `docker exec <id> ls -1 /home/deno/functions` and require
   `convert-heic`, `compress-upload`, `bulk-*`, `_shared`, `main`.
3. Record the current container IDs for edge runtime, storage and imgproxy.
4. Back up the current imgproxy configuration (screenshot or export the compose service).
5. Back up the deployed function:
   `docker cp <edge>:/home/deno/functions/convert-heic/index.ts /tmp/convert-heic-BACKUP-$(date +%Y%m%d-%H%M%S).ts`
6. Record SHA-256 of the backup and of `convert-heic-clean.ts`.
7. Set `IMGPROXY_MAX_SRC_RESOLUTION=50` in the Coolify service configuration.
8. Redeploy **only** the PesoWise imgproxy service.
9. Wait for health: `docker exec <storage> wget -qO- http://imgproxy:8080/health` → `imgproxy is running`.
10. Re-probe the controlled 21.9 MP HEIC directly against
    `/storage/v1/render/image/public/receipts/<path>?width=2000&height=2000&resize=contain&quality=82`.
11. **Require HTTP 200 and a renderable JPEG/WebP before proceeding.**
12. **If it still fails: roll the limit back to 16.8, redeploy imgproxy, stop. Do not deploy the function.**
13. `docker cp convert-heic-clean.ts <edge>:/home/deno/functions/convert-heic/index.ts`
14. `docker exec <edge> sh -c "chown 1000:1000 …; chmod 744 …"`
15. Restart **only** the PesoWise Edge Runtime container.
16. Unauthenticated boot probe: `POST /functions/v1/convert-heic` → expect `401` with
    `{"errorCode":"UNAUTHORIZED"}`. That JSON can only come from inside the handler, so it
    proves the entrypoint and imports loaded.
17. Run one authenticated conversion.
18. Require `ok=true`, `cached=false`.
19. Render the returned `public_url` in a browser.
20. Confirm the original HEIC still exists and is unchanged.
21. Run the identical request again.
22. Require `ok=true`, `cached=true`, and no second transformation in the imgproxy log.
23. Inspect Edge Runtime, Storage and imgproxy logs.
24. Confirm no OOM, no worker cancellation, no bare 500.
25. Complete the Chrome / Edge / mobile manual checklist.
26. Only then consider merging dev into main.

### Rollback

| Failure | Action |
|---|---|
| imgproxy unhealthy after redeploy | Restore `16.8`, redeploy imgproxy, verify health |
| Direct transform still 422 | Restore `16.8`, redeploy, **stop** — do not deploy the function |
| Edge Runtime fails boot probe | `docker cp` the backup back, restart edge runtime |
| Authenticated conversion fails | Read the typed `errorCode`; restore the function backup if it is not a transform rejection |
| Wrong output Content-Type stored | Delete the offending `derived/` object only; the original is untouched |

Every rollback touches the PesoWise stack alone. The Edge Runtime `memoryLimitMb` is **not**
changed at any point, and CSP is not touched.

---

## 9d) BACKEND RESOLVED — live evidence (2026-08-06)

Phase B ran on the server. **HEIC receipts now convert end to end.**

### Configuration changed (PesoWise stack only)

| Setting | Before | After |
|---|---|---|
| `IMGPROXY_MAX_SRC_RESOLUTION` | 16.8 | **50** |
| `IMGPROXY_AUTO_WEBP` | true | true (unchanged) |
| `receipts` allowed MIME | — | `image/webp` **added** via the Storage API, alongside pdf/heic/heif/jpeg/jpg/png |
| bucket `public` | true | true (unchanged) |
| bucket `file_size_limit` | 10485760 | unchanged |

### Verified results

| | |
|---|---|
| Live function SHA-256 | `a630c9452c1eccf662cfb53de89f55f8cb2d744decaf0cf206740325641a51a5` |
| Controlled original | 3768 × 5800 HEIC, SHA-256 `4bf46d3d827def86ad1283566bcae80ff8e912d9a148e7414759cb7ea191b703` |
| Direct native transform | HTTP 200, `image/webp`, 103,810 bytes, 1299 × 2000 |
| First authenticated call | `ok=true`, `cached=false`, `image/webp` |
| Second authenticated call | `ok=true`, `cached=true`, same derived path, **no second imgproxy transformation** |
| Original after conversion | SHA-256 **unchanged** |
| Edge Runtime log | `converted` then `cache_hit` |
| OOM / worker cancellation | **none** |
| MIME or source-resolution rejection | **none** |

The output is **WebP, not JPEG** — `IMGPROXY_AUTO_WEBP=true` and the function advertises
`Accept: image/jpeg,image/webp`, so content negotiation chose WebP. This is exactly why the
format is read from the response `Content-Type` rather than assumed, and why the rendition is
stored as `.webp` with `image/webp`.

---

## 9e) Frontend defect found by the live run — internal Kong origin

The conversion succeeded, but the function's `public_url` came back as:

```
http://supabase-kong:8000/storage/v1/object/public/receipts/derived/…
```

`getPublicUrl()` **inside the Edge Runtime** resolves against that runtime's `SUPABASE_URL`,
which on this self-hosted deployment is the **internal Docker address**. A browser cannot
resolve `supabase-kong`. The maintenance test only passed because it rewrote the origin by
hand before fetching.

The symptom this would have produced in the app is deceptive: the **first** open of a freshly
converted receipt fails, and a later reopen succeeds — because the reopen uses the direct
`derived/` probe, which never touches the function's URL. A user would report it as
intermittent.

### The contract now

1. **`storage_path` is authoritative**, not `public_url`. An object key is host-independent.
2. It is validated at runtime, not merely cast: must be a string, start with `derived/`,
   contain neither `..` nor `://`, and end in `.jpg` or `.webp`.
3. The browser builds the URL with its **own** configured client:
   `supabase.storage.from("receipts").getPublicUrl(storagePath).data.publicUrl`.
4. Legacy replies carrying only a `public_url` have the **key extracted** and the URL rebuilt
   from the browser origin. Deliberately *not* `normalizeReceiptPublicUrl` — that helper
   returns its input unchanged when it cannot find a receipts key, which would turn any URL
   the function returned into a fetch. Requiring an extractable `derived/` key fails closed.
5. No internal Docker hostname is ever fetched, and no arbitrary external URL is either.

No host is hardcoded anywhere; the active origin comes from the configured client.

---

## 9f) Not yet proven

Honest status — these are **not** claimed as passed:

- [ ] authenticated in-app preview on the final Production frontend build (Chrome)
- [ ] Microsoft Edge in-app check
- [ ] mobile / PWA check
- [ ] JPG / PNG / PDF manual UI regression

Rollback assets remain on the server: the pre-change function backup and the imgproxy limit
(`50` → `16.8`).

---

## 10) Follow-ups not addressed

- **Root cause untouched.** `compress-upload` still stores HEIC unchanged (`"passthrough"`), and browser-side upload conversion is blocked by the same CSP. Until one of those changes, **new** raw HEIC keeps accumulating and this read-time path serves a growing backlog rather than a fixed one.
- **Thumbnail decode cost.** `AttachmentThumbnail` falls back to the resolver after its direct `<img>` fails, which for HEIC it always will. A list of many HEIC receipts decodes each one.
- **No progress indication during decode.** A large HEIC sits under the existing spinner with no distinct "converting" state.
- **`finalize-expense-receipts`** shows the same `wall clock duration warning` / `early termination` pattern on this runtime and predates all of this work.

---

## 11) Commit trail

| Commit | What |
|---|---|
| `53de42d` | Read-time HEIC→JPEG; `missing` vs `unsupported` split; Open in new tab for all types |
| `7a11b80` | Hotfix: bounded decode, CSP probe, native-decode path — the hang |
| `b649759` | `convert-heic` edge function + client wiring |
| `72bcb5a` | Deployment record |
| `c27c5df` | Pixel-buffer fix + typed `ENCODE_FAILED` |
| `7ffb229` | Three-argument view (memory), plus Review Expenses refresh persistence |

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-08-06 | 1.0 | Agent | Consolidated chronological report of the whole HEIC investigation: the false data-loss message, the CSP-induced hang, the server-side decode decision, the Coolify deployment mechanics, and the 500 traced to isolate OOM. One open item: whether the 150 MB per-worker limit is sufficient. |
