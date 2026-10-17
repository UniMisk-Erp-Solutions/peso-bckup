/**
 * Pure batch-processing engine for the PesoWise Tally connector.
 * All Tally I/O goes through `TallyIO`, so the same code runs against real TallyPrime and a fake in tests.
 *
 * Contract: a batch is only reported `verified` after Tally itself confirms (readback) that every item exists.
 */
import {
  activeCompanyRequest, ledgerNamesRequest, parseActiveCompany, parseImportResponse, parseLedgerNames,
  parseVoucherReadback, pruneMasters, reconcile, voucherReadbackRequest,
  type PlannedVoucher,
} from "../../../supabase/functions/_shared/pwt/index.ts";

export class TallyOfflineError extends Error {
  constructor(msg = "TallyPrime is not reachable") {
    super(msg);
    this.name = "TallyOfflineError";
  }
}

export interface TallyIO {
  /** POST an XML envelope to the local TallyPrime and return the response body. Throws TallyOfflineError. */
  post(xml: string): Promise<string>;
}

export interface ClaimedBatch {
  batch_id: string;
  kind: "masters" | "vouchers" | "report_rows";
  xml: string;
  tally_company: string;
  expected: {
    ledgers?: string[];
    group?: string;
    prune?: { prefix: string; keep: string[] };
    tag?: string;
    vouchers?: { number: string; date: string; total: number; lines: number }[];
  };
}

export type Outcome =
  | { verified: true; response: Record<string, unknown> }
  | { verified: false; permanent: boolean; offline?: boolean; error: string; response?: Record<string, unknown> };

const fail = (error: string, permanent = false, response?: Record<string, unknown>): Outcome =>
  ({ verified: false, permanent, error, response });

export async function activeCompany(io: TallyIO): Promise<string | null> {
  return parseActiveCompany(await io.post(activeCompanyRequest()));
}

async function existingNames(io: TallyIO, company: string): Promise<Set<string>> {
  const a = parseLedgerNames(await io.post(ledgerNamesRequest(company, "Ledger")));
  const g = parseLedgerNames(await io.post(ledgerNamesRequest(company, "Group")));
  return new Set([...a, ...g]);
}

export async function processBatch(b: ClaimedBatch, io: TallyIO): Promise<Outcome> {
  try {
    // Wrong-company protection, checked again immediately before any write.
    const active = await activeCompany(io);
    if (!active) return fail("Could not determine the active TallyPrime company");
    if (active !== b.tally_company) {
      return fail(`Active Tally company is "${active}" but this sync is for "${b.tally_company}"`);
    }
    return b.kind === "vouchers" ? await processVouchers(b, io) : await processMasters(b, io);
  } catch (e) {
    if (e instanceof TallyOfflineError) return { verified: false, permanent: false, offline: true, error: e.message };
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function processMasters(b: ClaimedBatch, io: TallyIO): Promise<Outcome> {
  const existing = await existingNames(io, b.tally_company);
  const pruned = pruneMasters(b.xml, existing);
  let created = 0;
  if (pruned.kept.length) {
    const res = parseImportResponse(await io.post(pruned.xml));
    if (!res.ok) {
      return fail(`Tally rejected masters: ${res.lineErrors.join("; ") || `errors=${res.errors}`}`, res.lineErrors.length > 0, {
        created: res.created, errors: res.errors,
      });
    }
    created = res.created;
  }
  // Readback: everything this batch promised must now exist.
  const after = pruned.kept.length ? await existingNames(io, b.tally_company) : existing;
  const want = [...(b.expected.ledgers ?? []), ...(b.expected.group ? [b.expected.group] : [])];
  const missing = want.filter((n) => !after.has(n));
  if (missing.length) return fail(`Readback missing ${missing.length} master(s), e.g. "${missing[0]}"`);

  // Report rows are versioned by content hash in their ledger name. Once the new revision is verified,
  // remove superseded revisions of the same record so the TDL shows exactly one row per record.
  let deleted = 0;
  let deleteError: string | undefined;
  if (b.kind === "report_rows" && (pruned.kept.length || b.expected.prune)) {
    // The final batch of a sync carries the complete keep-list: everything else of this report is stale
    // (older revision, or a row that is no longer in the selected data).
    const prune = b.expected.prune;
    const keepSet = new Set(prune?.keep ?? []);
    const stale = prune
      ? [...after].filter((n) => n.startsWith(prune.prefix) && !keepSet.has(n))
      : supersededRevisions(existing, pruned.kept);
    if (stale.length) {
      try {
        const res = parseImportResponse(await io.post(deleteMastersXml(b.tally_company, stale)));
        if (res.ok || res.errors === 0) deleted = stale.length;
        else deleteError = res.lineErrors.join("; ") || `errors=${res.errors}`;
      } catch (e) {
        deleteError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return {
    verified: true,
    response: { created, skipped_existing: pruned.skipped.length, checked: want.length, deleted_old_revisions: deleted, delete_error: deleteError },
  };
}

const REV_SUFFIX = /-[0-9a-f]{8}$/;

/** Old revisions share the `PWT-XX-<keyhash>-` prefix with a newly created one but have a different content suffix. */
export function supersededRevisions(existing: ReadonlySet<string>, created: readonly string[]): string[] {
  const fresh = new Map(created.filter((n) => n.startsWith("PWT-")).map((n) => [n.replace(REV_SUFFIX, "-"), n]));
  return [...existing].filter((n) => n.startsWith("PWT-") && fresh.has(n.replace(REV_SUFFIX, "-")) && fresh.get(n.replace(REV_SUFFIX, "-")) !== n);
}

export function deleteMastersXml(company: string, names: readonly string[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    names.map((n) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(n)}" ACTION="Delete"><NAME>${esc(n)}</NAME></LEDGER></TALLYMESSAGE>`).join("") +
    `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

function voucherFragments(xml: string): { number: string; fragment: string }[] {
  return [...xml.matchAll(/<TALLYMESSAGE\b[\s\S]*?<\/TALLYMESSAGE>/gi)].map((m) => ({
    number: (/<VOUCHERNUMBER>([\s\S]*?)<\/VOUCHERNUMBER>/i.exec(m[0])?.[1] ?? "").replace(/&amp;/g, "&").trim(),
    fragment: m[0],
  }));
}

async function readback(io: TallyIO, b: ClaimedBatch, planned: PlannedVoucher[]) {
  const dates = planned.map((p) => p.date).sort();
  const xml = voucherReadbackRequest(b.tally_company, b.expected.tag ?? "PWT", dates[0], dates[dates.length - 1]);
  return parseVoucherReadback(await io.post(xml));
}

async function processVouchers(b: ClaimedBatch, io: TallyIO): Promise<Outcome> {
  const exp = b.expected.vouchers ?? [];
  if (!exp.length) return fail("batch has no expected vouchers", true);
  const planned: PlannedVoucher[] = exp.map((v) => ({
    key: v.number, date: v.date, voucherType: "", voucherNumber: v.number, narration: "", lines: [], total: v.total, sourceIds: [],
  }));

  // 1) Idempotency: look first. Vouchers already in Tally (e.g. after a crash mid-import) are never re-created.
  const before = await readback(io, b, planned);
  const present = new Map(before.map((r) => [`${r.number}|${r.date}`, r]));
  const seenRef = new Set<string>();
  for (const r of before) {
    const k = `${r.number}|${r.date}`;
    if (seenRef.has(k) && planned.some((p) => `${p.voucherNumber}|${p.date}` === k)) {
      return fail(`Voucher ${r.number} exists more than once in Tally - duplicate posting, manual review needed`, true);
    }
    seenRef.add(k);
  }
  const conflicting: string[] = [];
  const toImport: string[] = [];
  for (const p of planned) {
    const r = present.get(`${p.voucherNumber}|${p.date}`);
    if (!r) toImport.push(p.voucherNumber);
    else if (r.debit !== r.credit || Math.abs(r.debit - p.total) > 0.005) conflicting.push(p.voucherNumber);
  }
  if (conflicting.length) {
    return fail(`Voucher ${conflicting[0]} already exists in Tally with different amounts - manual review needed`, true);
  }

  // 2) Import only what is missing.
  let created = 0;
  if (toImport.length) {
    const open = "<REQUESTDATA>";
    const head = b.xml.slice(0, b.xml.indexOf(open) + open.length);
    const tail = b.xml.slice(b.xml.indexOf("</REQUESTDATA>"));
    const frags = voucherFragments(b.xml).filter((f) => toImport.includes(f.number));
    const res = parseImportResponse(await io.post(head + frags.map((f) => f.fragment).join("") + tail));
    if (!res.ok) {
      return fail(`Tally rejected vouchers: ${res.lineErrors.join("; ") || `errors=${res.errors}`}`, res.lineErrors.length > 0, {
        created: res.created, errors: res.errors,
      });
    }
    created = res.created;
  }

  // 3) Verified readback gate: nothing is "done" until Tally shows every voucher balanced with the right total.
  const after = await readback(io, b, planned);
  const rec = reconcile(planned, after);
  if (!rec.ok) {
    return fail(
      `Readback failed: missing=${rec.missing.length} mismatched=${rec.mismatched.length} unbalanced=${rec.unbalanced.length}`,
      false, { ...rec },
    );
  }
  return { verified: true, response: { created, already_present: planned.length - toImport.length, verified_vouchers: planned.length } };
}
