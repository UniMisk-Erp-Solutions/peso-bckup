import { Fragment, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { reverseImportBatch, type ImportReverseResult } from "@/services/BalanceLedgerService";
import {
  getImportBatches,
  getImportRows,
  getImportSourceDownloadUrl,
  type ImportBatchSummary,
  type ImportRowDetail,
} from "@/services/BalanceImportService";

// DOC-103. Import History listing + reversal action. Never deletes or hides
// a batch row after reversal -- it stays visible with its updated status.

function batchStatusBadge(status: string) {
  switch (status) {
    case "applied":
      return <Badge variant="success">Applied</Badge>;
    case "reversed":
      return <Badge variant="secondary">Reversed</Badge>;
    case "draft":
      return <Badge variant="outline">Draft</Badge>;
    case "validated":
      return <Badge variant="outline">Validated</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function modeLabel(mode: string) {
  return mode === "historical_opening" ? "Opening / Historical" : "Allocation";
}

interface UploaderName {
  [userId: string]: string;
}

interface EmployeeName {
  [userId: string]: string;
}

export interface ImportHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}

export function ImportHistoryDialog({ open, onOpenChange, organizationId }: ImportHistoryDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<ImportBatchSummary[]>([]);
  const [uploaderNames, setUploaderNames] = useState<UploaderName>({});

  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<ImportRowDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailEmployeeNames, setDetailEmployeeNames] = useState<EmployeeName>({});

  const [downloadingBatchId, setDownloadingBatchId] = useState<string | null>(null);

  const [reverseTargetId, setReverseTargetId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [reverseResult, setReverseResult] = useState<ImportReverseResult | null>(null);
  const [reverseResultBatchId, setReverseResultBatchId] = useState<string | null>(null);

  const loadBatches = async () => {
    if (!organizationId) return;
    setLoading(true);
    try {
      const data = await getImportBatches(organizationId);
      setBatches(data);

      const creatorIds = Array.from(new Set(data.map((b) => b.created_by).filter(Boolean)));
      if (creatorIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("user_id, name")
          .in("user_id", creatorIds);
        const map: UploaderName = {};
        (profileRows ?? []).forEach((p: { user_id: string; name: string | null }) => {
          map[p.user_id] = p.name || p.user_id;
        });
        setUploaderNames(map);
      } else {
        setUploaderNames({});
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not load import history",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadBatches();
    } else {
      setExpandedBatchId(null);
      setDetailRows([]);
      setDetailEmployeeNames({});
      setReverseTargetId(null);
      setReverseReason("");
      setReverseResult(null);
      setReverseResultBatchId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, organizationId]);

  const handleToggleExpand = async (batch: ImportBatchSummary) => {
    if (expandedBatchId === batch.id) {
      setExpandedBatchId(null);
      setDetailRows([]);
      setDetailEmployeeNames({});
      return;
    }
    setExpandedBatchId(batch.id);
    setDetailLoading(true);
    try {
      const rows = await getImportRows(batch.id);
      setDetailRows(rows);

      // Bounded batched lookup (one query, not N+1) of the actual matched
      // employee's name -- the "Employee" column must show who the row was
      // actually applied to, not the raw uploaded email.
      const matchedIds = Array.from(
        new Set(rows.map((r) => r.matched_user_id).filter((id): id is string => !!id)),
      );
      if (matchedIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("user_id, name")
          .in("user_id", matchedIds);
        const map: EmployeeName = {};
        (profileRows ?? []).forEach((p: { user_id: string; name: string | null }) => {
          map[p.user_id] = p.name || p.user_id;
        });
        setDetailEmployeeNames(map);
      } else {
        setDetailEmployeeNames({});
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not load batch details",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDownloadOriginal = async (batch: ImportBatchSummary) => {
    if (!batch.source_storage_path) return;
    setDownloadingBatchId(batch.id);
    try {
      const url = await getImportSourceDownloadUrl(batch.source_storage_path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not create download link",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloadingBatchId(null);
    }
  };

  const handleOpenReverse = (batchId: string) => {
    setReverseTargetId(batchId);
    setReverseReason("");
    setReverseResult(null);
    setReverseResultBatchId(null);
  };

  const handleConfirmReverse = async () => {
    if (!reverseTargetId) return;
    if (!reverseReason.trim()) {
      toast({
        variant: "destructive",
        title: "Reason required",
        description: "Enter a reason for this reversal before continuing.",
      });
      return;
    }
    setReversing(true);
    try {
      const result = await reverseImportBatch(reverseTargetId, reverseReason.trim());
      setReverseResult(result);
      setReverseResultBatchId(reverseTargetId);
      setReverseTargetId(null);
      await loadBatches();
      if (expandedBatchId === result.batch_id) {
        const rows = await getImportRows(result.batch_id);
        setDetailRows(rows);
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Reversal failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setReversing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import History</DialogTitle>
          <DialogDescription>Every balance import batch for this organization, newest first.</DialogDescription>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground py-4">Loading...</p>}

        {!loading && batches.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No import batches yet.</p>
        )}

        {!loading && batches.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Filename</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Total Delta</TableHead>
                  <TableHead>Uploaded By</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Batch ID</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <Fragment key={batch.id}>
                    <TableRow
                      key={batch.id}
                      className="cursor-pointer"
                      onClick={() => void handleToggleExpand(batch)}
                    >
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(batch.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs max-w-[160px] truncate">{batch.original_filename}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{modeLabel(batch.mode)}</TableCell>
                      <TableCell className="text-right text-xs">{batch.row_count}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(batch.total_delta)}</TableCell>
                      <TableCell className="text-xs">
                        {uploaderNames[batch.created_by] || batch.created_by}
                      </TableCell>
                      <TableCell>{batchStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-xs font-mono max-w-[100px] truncate">{batch.id}</TableCell>
                      <TableCell className="text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                        {batch.source_storage_path && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={downloadingBatchId === batch.id}
                            onClick={() => void handleDownloadOriginal(batch)}
                          >
                            {downloadingBatchId === batch.id ? "Preparing..." : "Download Original"}
                          </Button>
                        )}
                        {batch.status === "applied" && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleOpenReverse(batch.id)}
                          >
                            Reverse Import
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>

                    {expandedBatchId === batch.id && (
                      <TableRow key={`${batch.id}-detail`}>
                        <TableCell colSpan={9} className="bg-muted/30">
                          {detailLoading ? (
                            <p className="text-sm text-muted-foreground py-2">Loading rows...</p>
                          ) : (
                            <div className="space-y-3 py-2">
                              <div className="rounded-md border overflow-x-auto bg-background">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Employee ID</TableHead>
                                      <TableHead>Employee</TableHead>
                                      <TableHead className="text-right">Before</TableHead>
                                      <TableHead className="text-right">Input</TableHead>
                                      <TableHead className="text-right">After</TableHead>
                                      <TableHead>Ledger reference</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {detailRows.map((row) => (
                                      <TableRow key={row.id}>
                                        <TableCell className="font-mono text-xs">
                                          {row.raw_employee_id || "-"}
                                        </TableCell>
                                        <TableCell className="text-xs">
                                          {(row.matched_user_id && detailEmployeeNames[row.matched_user_id]) ||
                                            (row.matched_user_id ? row.matched_user_id : "Unmatched")}
                                        </TableCell>
                                        <TableCell className="text-right text-xs">
                                          {row.current_balance_snapshot !== null
                                            ? formatINR(row.current_balance_snapshot)
                                            : "-"}
                                        </TableCell>
                                        <TableCell className="text-right text-xs">
                                          {row.input_amount !== null ? formatINR(row.input_amount) : "-"}
                                        </TableCell>
                                        <TableCell className="text-right text-xs">
                                          {row.calculated_new_balance !== null
                                            ? formatINR(row.calculated_new_balance)
                                            : "-"}
                                        </TableCell>
                                        <TableCell className="text-xs font-mono">
                                          {row.ledger_entry_id || "-"}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>

                              {reverseResultBatchId === batch.id && reverseResult && (
                                <div className="rounded-lg border p-3 text-sm space-y-2">
                                  <p className="font-medium">
                                    Reversed {reverseResult.reversed_count} employee(s).
                                  </p>
                                  {reverseResult.blocked.length > 0 && (
                                    <div>
                                      <p className="text-amber-700 font-medium text-xs">
                                        {reverseResult.blocked.length} employee(s) could not be reversed:
                                      </p>
                                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                                        {reverseResult.blocked.map((b) => (
                                          <li key={b.employee_id}>
                                            {b.employee_name} ({b.employee_id}): {b.reason}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Reversal confirmation */}
      <Dialog open={reverseTargetId !== null} onOpenChange={(o) => { if (!o) setReverseTargetId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse Import</DialogTitle>
            <DialogDescription>
              This creates compensating ledger entries for every employee this import affected. This import
              cannot be automatically reversed if any affected employee has newer balance activity -- if so,
              nothing is changed and the affected employees are listed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reverse-reason">Reason (required)</Label>
            <Textarea
              id="reverse-reason"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="Why is this import being reversed?"
              className="min-h-[90px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTargetId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmReverse()}
              disabled={reversing || !reverseReason.trim()}
            >
              {reversing ? "Reversing..." : "Reverse Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
