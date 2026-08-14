import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Archive, Cloud, HardDrive, RotateCcw, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { supabase } from "@/integrations/supabase/client";
import { formatINR, parseLocalDate } from "@/lib/format";
import {
  dismissExpenseSubmissionDraft,
  listExpenseSubmissionDrafts,
  serverDraftToSubmittedBackup,
  type ExpenseSubmissionDraftRow,
} from "@/lib/expenseSubmissionDraftService";
import {
  countBackupReceiptsInIndexedDB,
  deleteBackupReceiptsFromIndexedDB,
} from "@/lib/expenseSubmittedBackupReceipts";
import {
  getSubmittedBackupDaysRemaining,
  listSubmittedExpenseBackups,
  removeSubmittedExpenseBackup,
  type SubmittedExpenseBackup,
} from "@/lib/expenseSubmittedBackup";

type DraftSource = "cloud" | "browser" | "both";

type DraftListItem = {
  key: string;
  backup: SubmittedExpenseBackup;
  sources: DraftSource;
  serverId?: string;
  localId?: string;
};

type Props = {
  userId: string | undefined;
  organizationId: string | null | undefined;
  knownExpenseIds: Set<string>;
  onCountChange?: (count: number) => void;
};

function mergeDraftLists(
  serverRows: ExpenseSubmissionDraftRow[],
  localBackups: SubmittedExpenseBackup[],
): DraftListItem[] {
  const byExpenseId = new Map<string, DraftListItem>();
  const items: DraftListItem[] = [];

  for (const row of serverRows) {
    const backup = serverDraftToSubmittedBackup(row);
    const item: DraftListItem = {
      key: `server-${row.id}`,
      backup,
      sources: "cloud",
      serverId: row.id,
    };
    items.push(item);
    if (row.source_expense_id) {
      byExpenseId.set(row.source_expense_id, item);
    }
  }

  for (const local of localBackups) {
    const linked =
      local.expenseId != null ? byExpenseId.get(local.expenseId) : undefined;
    if (linked) {
      linked.sources = "both";
      linked.localId = local.localId;
      continue;
    }
    items.push({
      key: `local-${local.localId}`,
      backup: local,
      sources: "browser",
      localId: local.localId,
    });
  }

  // Only show genuine unsubmitted drafts. A "submitted" entry is just a recovery safety
  // copy of an expense that already made it to the main list — it must not appear here as
  // if it still needs action. (The backup itself is kept in storage for recovery.)
  return items
    .filter((item) => item.backup.submissionStatus !== "submitted")
    .sort(
      (a, b) => new Date(b.backup.savedAt).getTime() - new Date(a.backup.savedAt).getTime(),
    );
}

export function ExpenseSavedDraftsPanel({
  userId,
  organizationId,
  knownExpenseIds,
  onCountChange,
}: Props) {
  const { t } = useTranslation(["expenses", "common"]);
  const navigate = useNavigate();
  const [serverRows, setServerRows] = useState<ExpenseSubmissionDraftRow[]>([]);
  const [localBackups, setLocalBackups] = useState<SubmittedExpenseBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receiptCounts, setReceiptCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    if (!userId || !organizationId) {
      setServerRows([]);
      setLocalBackups([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError(null);

    const local = listSubmittedExpenseBackups(userId, organizationId);
    setLocalBackups(local);

    try {
      const { rows, error } = await listExpenseSubmissionDrafts(supabase, userId, organizationId);
      setServerRows(rows);
      if (error) setLoadError(error);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load saved drafts";
      setLoadError(msg);
      setServerRows([]);
    } finally {
      setLoading(false);
    }
  }, [userId, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Refresh only when another tab writes a draft backup (storage event). We intentionally
    // do NOT refetch on window focus — that caused a DB refetch on every tab switch (and the
    // focus listener was never cleaned up, leaking handlers). Mount + storage cover updates.
    const onStorage = (event: StorageEvent) => {
      if (event.key?.includes("pesowise:expense-submitted-backups")) {
        void refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const items = useMemo(
    () => mergeDraftLists(serverRows, localBackups),
    [serverRows, localBackups],
  );

  useEffect(() => {
    onCountChange?.(items.length);
  }, [items.length, onCountChange]);

  useEffect(() => {
    if (!userId || !organizationId || items.length === 0) {
      setReceiptCounts({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const counts: Record<string, number> = {};
      for (const item of items) {
        const id = item.localId ?? item.backup.localId;
        counts[item.key] = await countBackupReceiptsInIndexedDB(userId, organizationId, id);
      }
      if (!cancelled) setReceiptCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [items, userId, organizationId]);

  const handleResubmit = (backup: SubmittedExpenseBackup) => {
    navigate("/expenses/new", { state: { resubmitFromBackup: backup } });
  };

  const handleDismiss = async (item: DraftListItem) => {
    const idForReceipts = item.localId ?? item.backup.localId;
    if (item.localId && userId && organizationId) {
      removeSubmittedExpenseBackup(userId, organizationId, item.localId);
    } else if (userId && organizationId && idForReceipts) {
      await deleteBackupReceiptsFromIndexedDB(userId, organizationId, idForReceipts);
    }
    if (item.serverId) {
      await dismissExpenseSubmissionDraft(supabase, item.serverId);
    }
    await refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-5 w-5" />
          {t("expenses:savedDrafts.tabTitle")}
        </CardTitle>
        <CardDescription>{t("expenses:savedDrafts.tabDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground py-8 text-center">{t("common:loading")}</p>
        ) : items.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            {loadError ? (
              <>
                <p className="text-destructive text-sm">{loadError}</p>
                <p className="text-muted-foreground text-sm">{t("expenses:savedDrafts.migrationHint")}</p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground">{t("expenses:savedDrafts.empty")}</p>
                <p className="text-xs text-muted-foreground max-w-md mx-auto">
                  {t("expenses:savedDrafts.emptyHint")}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {loadError ? (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-200">
                {t("expenses:savedDrafts.migrationHint")}
              </p>
            ) : null}
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("expenses:form.fields.title")}</TableHead>
                  <TableHead>{t("expenses:form.location")}</TableHead>
                  <TableHead>{t("expenses:form.amount")}</TableHead>
                  <TableHead>{t("expenses:savedDrafts.saved")}</TableHead>
                  <TableHead>{t("expenses:savedDrafts.storage")}</TableHead>
                  <TableHead className="text-right">{t("expenses:savedDrafts.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const expense = item.backup.payload.expense;
                  const expenseDate = parseLocalDate(expense.expense_date.slice(0, 10));
                  const serverMissing =
                    item.backup.expenseId != null &&
                    item.backup.expenseId !== "" &&
                    !knownExpenseIds.has(item.backup.expenseId);

                  return (
                    <TableRow key={item.key}>
                      <TableCell>
                        <div className="font-medium">{expense.title || t("expenses:localBackups.untitled")}</div>
                        {serverMissing && (
                          <Badge variant="destructive" className="text-xs mt-1">
                            {t("expenses:localBackups.missingOnServer")}
                          </Badge>
                        )}
                        {item.backup.submissionStatus === "draft" && (
                          <Badge variant="outline" className="text-xs mt-1 ml-1">
                            {t("expenses:localBackups.savedAsDraft")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{expense.destination || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatINR(Number(expense.amount) || 0)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        <div>{format(new Date(item.backup.savedAt), "MMM d, yyyy h:mm a")}</div>
                        <div className="text-xs">
                          {expenseDate ? format(expenseDate, "MMM d, yyyy") : ""}
                          {" · "}
                          {t("expenses:localBackups.expiresIn", {
                            days: getSubmittedBackupDaysRemaining(item.backup),
                          })}
                        </div>
                      </TableCell>
                      <TableCell>
                        {item.sources === "both" ? (
                          <Badge variant="outline" className="text-xs gap-1">
                            <Cloud className="h-3 w-3" />
                            <HardDrive className="h-3 w-3" />
                            {t("expenses:savedDrafts.both")}
                          </Badge>
                        ) : item.sources === "cloud" ? (
                          <Badge variant="outline" className="text-xs gap-1">
                            <Cloud className="h-3 w-3" />
                            {t("expenses:savedDrafts.cloud")}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs gap-1">
                            <HardDrive className="h-3 w-3" />
                            {t("expenses:savedDrafts.browser")}
                          </Badge>
                        )}
                        {(receiptCounts[item.key] ?? 0) > 0 && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {t("expenses:localBackups.receiptCount", {
                              count: receiptCounts[item.key],
                            })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => handleResubmit(item.backup)}>
                            <RotateCcw className="h-4 w-4 mr-1" />
                            {t("expenses:localBackups.submitAgain")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleDismiss(item)}
                            aria-label={t("expenses:localBackups.dismiss")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
