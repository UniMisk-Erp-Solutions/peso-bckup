# DOC-157 — PWA first-submit failure and slow file upload

Last updated: 2026-10-24

## Summary
Real PWA users saw "Submission failed - The connection dropped while submitting. Nothing is lost. Your draft was preserved..." on the FIRST Submit after uploading a bill photo; pressing Submit again immediately succeeded. Users also reported slow uploads.

## What the evidence shows (Production, read-only)
- **The first request is not being slowed or aborted by the server.** In 72 h of Kong access logs there is no 5xx and no client-aborted (499) entry on any expense, attachment, function or storage-write endpoint. PostgREST logged 4 statement timeouts (SQLSTATE 57014) in the same window, none clustered like the reports.
- **The client never gives up on its own.** The generic submit path (`saveExpense`: preflight -> `resolve_or_create_expense_v1` -> receipt finalize -> custom fields -> `submitExpense`) has no AbortController, no `Promise.race` and no timeout. A failure therefore means the browser's fetch itself failed (`TypeError: Failed to fetch` / Safari `Load failed`) or the server answered an error.
- **Second submit works because the logical submission is idempotent.** `client_submission_id` maps to one expense; a retry re-resolves the same row and completes. 1,379 expenses created through that path since 2026-10-16: 1,377 submitted, 0 duplicate submit audits.
- **Root cause (most consistent explanation, not captured on a device):** the first request after the camera / file picker returns is sent on a keep-alive connection the OS or carrier already dropped while the PWA was backgrounded (Cloudflare advertises HTTP/3). iOS reports this as `Load failed`; the request never reaches the server, the next request opens a fresh connection and succeeds. No HAR from an affected device was available, so this is inferred from: zero server-side failures, no client timeout, immediate success on retry, and the message mapping below.
- **The error classifier was too broad.** `friendlySubmitFailureMessage` mapped ANY message containing `failed to fetch | networkerror | load failed | timeout | timed out | econnreset` to "connection dropped". That also caught server statement timeouts (57014) and gateway timeouts, which are not dropped connections, and it offered the user a manual retry as the only recovery.

## Submit duration (server-observed, created -> first submit audit, since 2026-10-16)
All 1,377: p50 7.4 s, p95 19.1 s, max 488 s (62 over 20 s). With a bill (211): p50 7.3 s, p95 21.2 s; first receipt row 1.6 s p50 / 4.0 s p95 after the draft; last receipt -> submit 5.4 s p50 / 16.1 s p95. Per-statement database cost is small (resolve 19 ms, preflight 42 ms, attachment insert 6 ms, status update 15 ms, notification insert 8 ms mean) with rare stalls (max 2-7 s). The median is dominated by the number of sequential round trips, so every additional request is another chance to hit a dead connection. Host load average 5.6 on 4 cores during the audit.

## Upload
Median 114 KB, p95 3.1 MB, p99 4.0 MB, max 9.4 MB over 14 days (2,304 files; 124 over 3 MB). Photos are sent raw: image compression was removed earlier at the owner's request. The `receipts` bucket refuses any file over 10 MB but the client only enforced a 50 MB total, so an oversized photo uploaded in full and was then refused. `finalize-expense-receipts` copies each file three times server-side (download, upload, verify). 15,788 orphaned `temp/` objects (6.8 GB) exist; no cleanup job.

## Fix (this change)
- `submitFailureMessages.ts`: `isConnectionDropError` (browser fetch failure with no HTTP status / SQLSTATE), `isServerSlowError` (57014, 502/503/504), `isUnknownOutcomeError`. Server slowness now says "The server took too long to respond"; real validation/bill/RLS/auth errors are never reworded as a dropped connection.
- `submitReconcile.ts` + `ExpenseForm.saveExpense`: when the outcome is unknown the SAME press is re-run ONCE automatically (after the app is visible and a 1 s settle), showing "Checking your submission…". If the first request committed, the re-run lands on the submitted row and completes. Taps are ignored during the check. A second unknown outcome is reported with the draft preserved; manual retry stays available. Real errors are never auto-retried.
- `FileUpload.tsx`: (rev 1.0 had a 10 MB per-file client check; REMOVED in rev 1.3, see "Bill-photo flow optimization" below); "Upload is taking longer than expected. Please keep this screen open." after 20 s; the misleading "Uploading compressed file" label is now "Uploading…".
- `submitTelemetry.ts`: content-free breadcrumbs (`upload_start`, `upload_done`, `receipt_finalize_done`, `submit_start`, `submit_server_done`, `submit_reconcile`, `submit_success`, `submit_failure`): durations, sizes in KB, counts and a coarse error class only.

## PR #11 (hotfix/attachment-upload-preview-performance) audit
| Change | Status |
|---|---|
| per-file 10 MB check in FileUpload | SUPERSEDED - removed in rev 1.3 (large photos are optimized, not rejected) |
| attachmentPreview 30 s / 60 s budgets, preview dialog slow state, thumbnails | STILL VALID, separate read-side fix; NOT ported (touches preview code only) |
| fetchExpenseFormFieldDisplay single RPC, ExpenseFormFieldsDisplay 25 s ceiling | STILL VALID but CONFLICTS with current custom-field helper / ExpenseForm; needs a rebase |
| attachmentPerf.ts coarse stage reporting | SUPERSEDED by submitTelemetry for the submit path |
| finalize edge function (3 copies per file) | UNCHANGED upstream; still the main server-side upload cost |
| Lessons_and_Fixes / index rows | CONFLICT (add/add); not taken |
Do not merge the old branch. 656 attachments in the last 7 days still store the internal `supabase-kong:8000` host in `file_url` (preview/thumbnail issue, not submit).

## Rebased on the Tally integration (v2, 2026-10-23)
This hotfix was re-applied on top of `integration/preet-main-2026-10-23` (Preet's Tally work merged with current main). Preet's branch touches none of the submit / upload / bill / auth files, so the hotfix applied with one documentation conflict only (`index.md`; the doc was renumbered DOC-154 -> DOC-157 because the Tally docs use DOC-154/155/156).

### Fewer sequential round trips (safe eliminations only)
- A row this press just inserted is known to be a draft, so the pre-submit status read is skipped; a reused row is still re-read (an earlier attempt may have submitted it).
- The post-submit status comes from the row `ExpenseService.submitExpense` already returns (it verifies `status = 'submitted'` from its own UPDATE). The extra read remains only as a fallback and success is still never reported unless the row is past draft.
- Net: two fewer requests on the normal new-expense path. The remaining chain (preflight, resolve, finalize, receipt rows, custom fields, submit) is unchanged.

### Canonical receipt URL for NEW rows
`finalize-expense-receipts` stores `http://supabase-kong:8000/...` in `file_url`: 13,749 active rows, 666 in the last 7 days, every one with a usable `storage_path` (readers that derive the URL from `storage_path` work). New rows now get the public base URL at insert (`receiptFileUrl.ts`). Historical rows are NOT rewritten. The edge function itself is unchanged (no deploy in this task).

### Orphan temp objects (read-only report, nothing deleted)
15,803 objects, 6.85 GB under `receipts/temp/`. Age buckets: < 2 days 308 (122 MB); 2-7 days 401 (173 MB); 7-30 days 5,916 (2.5 GB, 7 referenced by an attachment row); > 30 days 9,178 (4.0 GB, 167 referenced). Only 174 are referenced by an attachment row (the "temporary fallback" receipts) and must be kept. About 14,920 unreferenced objects older than 7 days (about 6.4 GB) are cleanup CANDIDATES for a separately designed, reviewed job (also check legacy `file_url`-only rows first).

## Bill-photo flow optimization (rev 1.3, 2026-10-24)

Requirement: no practical user-facing size limit for phone photos; bills stay readable (accounting evidence); after "uploaded", Submit must be fast.

### What changed
- **No original-size rejection.** The earlier 10 MB client check was removed. A photo is accepted up to a 150 MB pathological-file guard, decoded ONCE on the device, scaled down only if larger than needed (never upscaled), re-encoded once, and that optimized File is the only thing uploaded, cached, registered and finalized (a retry after a failed upload re-uses it; it is never compressed twice). EXIF orientation is applied by the decoder; EXIF/GPS metadata is dropped by the re-encode.
- **Settings** (`src/lib/receiptImageOptimizer.ts`): long edge 2560 px (floor 1600; 1200 only if the 9.5 MB storage ceiling forces it); JPEG quality ladder 0.85 -> 0.80 -> 0.76 -> 0.72, stopping at the first step <= 1.5 MB (accepts up to 3 MB before shrinking dimensions); files <= 400 KB and PDFs are untouched; HEIC/HEIF always converted to JPEG; transparent PNG becomes white paper. Decode/encode watchdog 30 s; on any failure the original is returned and the user gets a precise message (never an infinite spinner).
- **Bounded memory/concurrency.** One image is decoded at a time (queue); while photo N uploads, photo N+1 is prepared.
- **Stage labels:** Preparing photo... / Compressing photo... / Uploading... / "Upload is taking longer than expected" after 20 s. No fake percentages (the storage client exposes no byte progress).
- **Finalize (edge function v5, NOT DEPLOYED):** temp -> final is now a server-side object COPY with an existence check; the old download/upload/verify sequence remains as a fallback. Per file: BEFORE 2 storage reads + 1 write + 1 list, every byte through the function 3 times; AFTER 0 bytes through the function (1 copy + 2 metadata lists). Requires an edge-function deploy by the operator; the web app works either way.
- **Submit round trips:** the submitter context (org threshold, roles, reporting chain, hierarchy inputs) is loaded concurrently with preflight/resolve/finalize and handed to Submit (same queries, same routing payload, verified by test; ignored when stale/foreign/missing). Also: no pre-read of a row this press just created; no post-submit status read; one attachments read instead of two after finalize.

### Sequential requests on the critical path (new expense with one bill, ordinary employee)
BEFORE (14): preflight, resolve, finalize, attachment insert, size read, bill-exists read, status read, expense read, [org+roles], bill read, [profile+role+hierarchy], supervisor role, status UPDATE, status read.
AFTER (7): preflight, resolve, finalize, attachment insert, size+bill-count read, [expense read || bill read], status UPDATE. Context load runs beside the first five.
Measured production cost per round is about 0.6 s (created -> submitted p50 7.4 s over 12 rounds; last receipt -> submitted p50 5.4 s over 9 rounds). MODELED (not measured after deploy): press -> done about 8.4 s -> 4.2 s; last receipt -> submitted (3 rounds) about 1.8 s p50.

### Measured in a real Chromium (desktop, hidden pane; NOT a phone)
Synthetic receipt photos with sensor noise, generated locally (nothing committed). Optimizer = the shipped module (3 runs, median).
| Original | Format | Optimized | Compress time | Main-thread long tasks |
|---|---|---|---|---|
| 4.9 MB | 4032x3024 JPEG | 614 KB, 2560x1920, q0.85 | 1.19 s | none >50 ms |
| 9.8 MB | 4032x3024 | 1514 KB | 1.21 s | none |
| 14.0 MB | 5712x4284 | 615 KB | 1.32 s | none |
| 18.9 MB | 5712x4284 | 896 KB | 1.32 s | none |
| 27.1 MB | 8064x6048 (48 MP) | 483 KB | 1.61 s | none |
| 32.9 MB | 8064x6048 (48 MP) | 716 KB | 1.60 s | none |
Phone CPUs are slower than this desktop; expect roughly 2-5x (about 2-8 s). Not measured on a device.

Upload through a rate-limited local endpoint (RTT added each way, body read at the stated rate; model validated: 200 KB at 750 kbps + 150 ms = 2.45 s measured). Times in seconds, optimized vs original:
| Source | Opt. size | 3G (up 750 kbps, 150 ms) | LTE (up 5 Mbps, 60 ms) | Wi-Fi (up 20 Mbps, 20 ms) |
|---|---|---|---|---|
| 4.9 MB | 614 KB | 7.1 vs 55.4 (measured) | 1.2 vs 8.9 | 0.36 vs 2.6 |
| 9.8 MB | 1514 KB | 17.0 vs ~104 (computed) | 2.8 vs 17.7 | 0.81 vs 5.2 |
| 14.0 MB | 615 KB | 7.1 vs ~150 (computed) | 1.2 vs 25.2 | 0.36 vs 7.4 |
| 18.9 MB | 896 KB | 10.2 vs ~202 (computed) | 1.7 vs 34.0 | 0.50 vs 10.0 |
| 27.1 MB | 483 KB | 5.6 vs ~289 (computed) | 1.0 vs 48.7 | 0.29 vs 14.3 |
| 32.9 MB | 716 KB | 8.2 vs ~351 (computed) | 1.4 vs 59.0 | 0.41 vs 17.4 |
Slow 3G (up 400 kbps, 400 ms): 10.7-32.0 s for the optimized files. "Unthrottled" localhost: 4-5 ms (no network).

### Readability (accounting evidence)
Clean capture, OCR word recall of the known text (Tesseract.js, 2560 px unless stated): lossless 0.936; JPEG q0.90 0.957, q0.85 0.936, q0.80 0.979, q0.75 0.979. At 1600 px: lossless 0.872, q0.85 0.851. Dimension matters (about 8 points between 2560 and 1600 px); quality 0.75-0.90 did not reduce recall. PSNR vs lossless at 2560 px on the noisy sample: q0.90 38.7 dB, 0.85 37.5, 0.80 37.0, 0.75 36.6 (1600 px: 39.5-41.4). Noisy-sample OCR was non-monotonic (JPEG smoothing sensor noise beat the lossless PNG) and is not used as evidence. Chosen: 2560 px, start at q0.85, never below 1600 px unless storage forces it. Real HEIC could not be generated in this environment: the HEIC path is covered by unit tests with injected decoders and relies on the browser decoding HEIC (Safari/iOS does; if not, the original is passed through when it fits and the user gets a precise message otherwise).

### Production storage
`receipts` bucket `file_size_limit` = 10,485,760 bytes (10 MiB), public. The storage service limit is 500 MiB (`UPLOAD_FILE_SIZE_LIMIT`), Kong read/write timeouts 3600 s. Optimized photos are far below 10 MiB, so no change was needed; PDFs over 10 MiB are refused with a plain message. Proposal (NOT applied; needs approval): raise the `receipts` limit to 25 MiB as a generous backstop for large PDFs.

## Edge v5 deployment and the next phase (rev 1.4, 2026-10-24)

### finalize-expense-receipts v5: deployed and verified
- **Deployed** to the Production edge-functions container (`/home/deno/functions/finalize-expense-receipts`, files `index.ts` + `finalizeReceipt.ts`). Rollback: the v4 file is kept on the host (`/tmp/fv4_backup/index.ts`, md5 `3c6d1092...`, which equals the repo `main` version); copy it back with `docker cp` and delete `finalizeReceipt.ts`.
- **Production v4 vs v5 diff:** limited to the per-file finalization block; authentication, expense-ownership / admin org check, filename validation, CORS and concurrency (2) are unchanged. A degraded-outcome log line (request id, status, method; no user data) replaces the old per-step error logs.
- **Verified with QA data only** (ZZZ QA org, test user): one final object per receipt, size equals the uploaded size, `storage_path = <expenseId>/<file>`, 3 receipts in one call, retry/already-finalized is a no-op with the same objects, missing source -> `failed`, `../x` filename rejected, foreign expense -> 403, attachment row + submit of an above-threshold expense passes the bill trigger.
- **Interleaved A/B, same load, 6 runs per size** (finalize call, server-side): 120 KB 0.56 s -> 0.49 s; 1.5 MB 0.34 s -> 0.22 s; 9 MB 0.85 s -> 0.27 s.

### Where Submit time really goes
Server time of the 7-request sequence for a QA user (loopback): preflight 7 ms, resolve 8 ms, finalize 193 ms, attachment insert 75 ms, size+bill read 106 ms, expense||bill read 122 ms, status UPDATE 52 ms: median 0.56 s, p95 0.79 s (the old 14-request flow: 0.86 s median). Production's measured created -> submitted p50 was 7.4 s for 12 requests, i.e. about 0.6 s per request of which only about 0.07 s is server time. The remainder is the client -> Cloudflare -> host path per round trip. Cutting requests is therefore the lever: 14 -> 7 about halves the wait; 7 -> 1 would remove most of the rest.

### Next phase: ATOMIC EXPENSE SUBMIT RPC (not part of this hotfix)
One server-side function that, in one transaction and one round trip, validates ownership and status, applies the org attachment rule (the existing deferred trigger already enforces the bill), resolves approval routing with the SAME inputs and rules the client uses today (hierarchy flags, reporting chain, roles), performs the status transition, writes the submit audit and enqueues the notification, and returns the final row. It would replace requests 3-7 of the current sequence (plus the finalize call could be folded in), idempotent on `client_submission_id`. Requirements: byte-for-byte routing parity tests against the TypeScript implementation, no change to approval/balance semantics, MicroLink untouched.

## Not done / needs a device
No HAR from an affected PWA, no slow-4G run and no HEIC/large-photo timing were captured; there is no device or signed-in session in this environment. The reconcile behaviour is covered by model-based tests only.

## Key files
`src/lib/submitFailureMessages.ts`, `submitReconcile.ts`, `submitTelemetry.ts`, `pageVisibility.ts`, `src/pages/ExpenseForm.tsx`, `src/components/FileUpload.tsx`, tests `submitFailureClassifier`, `pwaSubmitReliability`, `pwaSubmitWiring`.

## Database
None.

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-23 | 1.0 | Evidence, narrowed classifier, one-shot reconcile, upload guard and telemetry. | Claude Code |
| 2026-10-24 | 1.3 | Removed the 10 MB original-photo rejection; adaptive on-device optimization; finalize via server-side copy (edge function v5, not deployed); submitter context loaded concurrently; benchmarks (compression, 3G/LTE/Wi-Fi uploads, OCR readability). | Claude Code |
| 2026-10-24 | 1.4 | Edge function v5 deployed to Production and verified (QA data), A/B timings, atomic submit RPC documented as the next phase, GlitchTip emergency mode. | Claude Code |
