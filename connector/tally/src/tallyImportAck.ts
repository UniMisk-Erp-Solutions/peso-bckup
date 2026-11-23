import type { TallyImportResult } from "./responseParser.js";

/** True when Tally accepted HTTP but did not create/alter/delete (duplicate masters). */
export function isDuplicateOnlyImport(parsed: TallyImportResult): boolean {
  const confirmed = parsed.created + parsed.altered + parsed.deleted;
  const exceptions = Number.parseInt(parsed.rawExcerpt.match(/<EXCEPTIONS>(\d+)/i)?.[1] ?? "0", 10);
  return parsed.errors.length === 0 && confirmed === 0 && exceptions > 0;
}

/** Batch-level duplicate / no-op import — should retry (Alter), not fail the job. */
export function isRetryableTallyDuplicateBatch(parsed: TallyImportResult): boolean {
  if (isDuplicateOnlyImport(parsed)) return true;
  const confirmed = parsed.created + parsed.altered + parsed.deleted;
  const exceptions = Number.parseInt(parsed.rawExcerpt.match(/<EXCEPTIONS>(\d+)/i)?.[1] ?? "0", 10);
  return confirmed === 0 && exceptions > 0;
}

export function udfRefreshConfirmed(parsed: TallyImportResult): boolean {
  return parsed.created + parsed.altered > 0;
}
