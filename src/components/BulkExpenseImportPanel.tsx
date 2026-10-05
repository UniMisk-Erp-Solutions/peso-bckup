/**
 * Bulk CSV import for admin-submit-for-employee. See bulkExpenseImportParse.ts
 * for why this is CSV-only. Server (admin_bulk_submit_expenses_v2) is the
 * authoritative validator; this panel's own validation exists only to give
 * fast feedback before a network round trip.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  parseBulkExpenseCsv,
  validateBulkRows,
  buildBulkExpenseCsvTemplate,
  type BulkRowValidationResult,
} from "@/lib/bulkExpenseImportParse";
import { loadOrganizationExpenseFieldConfig, type OrganizationExpenseFieldConfig } from "@/lib/orgExpenseFieldConfig";
import {
  submitBulkExpensesForEmployees,
  type BulkSubmitRow,
  type BulkSubmitRowResult,
  type AdminSubmitStatusChoice,
} from "@/lib/adminSubmitExpense";

/** Deterministic, synchronous 32-bit FNV-1a hash — good enough to derive a
 * stable per-file identity for idempotency keys; not a security primitive. */
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function BulkExpenseImportPanel({
  organizationId,
}: {
  organizationId: string;
}) {
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [config, setConfig] = useState<OrganizationExpenseFieldConfig | null>(null);
  const [validated, setValidated] = useState<BulkRowValidationResult[]>([]);
  const [status, setStatus] = useState<AdminSubmitStatusChoice>("submitted");
  const [approvedReason, setApprovedReason] = useState("");
  const [results, setResults] = useState<BulkSubmitRowResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    setResults(null);
    try {
      const text = await file.text();
      const cfg = await loadOrganizationExpenseFieldConfig(organizationId);
      const { rows } = parseBulkExpenseCsv(text);
      setFileHash(fnv1aHash(text));
      setConfig(cfg);
      setValidated(validateBulkRows(rows, cfg));
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const csv = buildBulkExpenseCsvTemplate(config);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk-expense-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    if (!fileHash) return;
    const validRows = validated.filter((r) => r.ok);
    if (validRows.length === 0) return;
    if (status === "approved" && approvedReason.trim() === "") return;

    setBusy(true);
    try {
      const payload: BulkSubmitRow[] = validRows.map((r) => ({
        rowIndex: r.rowIndex,
        employeeId: r.employeeId,
        email: r.email,
        title: r.title,
        destination: r.destination,
        tripStart: r.tripStartIso!,
        tripEnd: r.tripEndIso!,
        category: r.category,
        amount: r.amount!,
        purpose: r.purpose,
        customFieldValues: r.customFieldValues,
        status,
        statusComment: status === "approved" ? approvedReason.trim() : null,
        // Stable across retries of the SAME file: same file content + same
        // row => same key, so a re-uploaded file after a partial failure or
        // timeout never double-creates a row that already succeeded.
        clientOperationId: `bulk:${fileHash}:${r.rowIndex}`,
      }));
      const rowResults = await submitBulkExpensesForEmployees(organizationId, payload);
      setResults(rowResults);
    } finally {
      setBusy(false);
    }
  }

  const okCount = validated.filter((r) => r.ok).length;
  const failCount = validated.length - okCount;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={downloadTemplate}>
          Download CSV template
        </Button>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>

      {validated.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <Badge variant="outline">{validated.length} rows</Badge>
            <Badge className="bg-green-100 text-green-800">{okCount} valid</Badge>
            {failCount > 0 && <Badge variant="destructive">{failCount} invalid</Badge>}
          </div>

          <div className="overflow-x-auto rounded-md border max-h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validated.map((row) => (
                  <TableRow key={row.rowIndex}>
                    <TableCell>{row.rowIndex + 1}</TableCell>
                    <TableCell>{row.employeeId ?? row.email ?? "—"}</TableCell>
                    <TableCell>{row.title}</TableCell>
                    <TableCell>{row.category}</TableCell>
                    <TableCell>{row.amount ?? "—"}</TableCell>
                    <TableCell>
                      {row.ok ? (
                        <Badge className="bg-green-100 text-green-800">Ready</Badge>
                      ) : (
                        <span className="text-sm text-destructive" title={row.errors.join("; ")}>
                          {row.errors[0]}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border px-2 py-1 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value as AdminSubmitStatusChoice)}
            >
              <option value="submitted">Submitted</option>
              <option value="verified">Verified</option>
              <option value="approved">Approved</option>
            </select>
            {status === "approved" && (
              <input
                type="text"
                className="min-w-[16rem] rounded-md border px-2 py-1 text-sm"
                placeholder="Reason (required — no independent review for these rows)"
                value={approvedReason}
                onChange={(e) => setApprovedReason(e.target.value)}
              />
            )}
            <Button
              onClick={() => void handleImport()}
              disabled={busy || okCount === 0 || (status === "approved" && approvedReason.trim() === "")}
            >
              {busy ? "Importing…" : `Import ${okCount} valid rows as ${status}`}
            </Button>
          </div>
        </>
      )}

      {results && (
        <div className="space-y-2">
          <h4 className="font-medium">Import results</h4>
          <div className="overflow-x-auto rounded-md border max-h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.rowIndex}>
                    <TableCell>{r.rowIndex + 1}</TableCell>
                    <TableCell>
                      {r.ok ? (
                        <Badge className="bg-green-100 text-green-800">
                          {r.idempotentReplay ? "Already created" : "Created"}
                        </Badge>
                      ) : (
                        <span className="text-sm text-destructive">{r.error}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
