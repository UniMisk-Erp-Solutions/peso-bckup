"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDuplicateOnlyImport = isDuplicateOnlyImport;
exports.isRetryableTallyDuplicateBatch = isRetryableTallyDuplicateBatch;
exports.udfRefreshConfirmed = udfRefreshConfirmed;
/** True when Tally accepted HTTP but did not create/alter/delete (duplicate masters). */
function isDuplicateOnlyImport(parsed) {
    const confirmed = parsed.created + parsed.altered + parsed.deleted;
    const exceptions = Number.parseInt(parsed.rawExcerpt.match(/<EXCEPTIONS>(\d+)/i)?.[1] ?? "0", 10);
    return parsed.errors.length === 0 && confirmed === 0 && exceptions > 0;
}
/** Batch-level duplicate / no-op import — should retry (Alter), not fail the job. */
function isRetryableTallyDuplicateBatch(parsed) {
    if (isDuplicateOnlyImport(parsed))
        return true;
    const confirmed = parsed.created + parsed.altered + parsed.deleted;
    const exceptions = Number.parseInt(parsed.rawExcerpt.match(/<EXCEPTIONS>(\d+)/i)?.[1] ?? "0", 10);
    return confirmed === 0 && exceptions > 0;
}
function udfRefreshConfirmed(parsed) {
    return parsed.created + parsed.altered > 0;
}
