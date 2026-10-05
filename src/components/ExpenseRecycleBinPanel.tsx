import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { RotateCcw, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { formatINR, parseLocalDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import {
  listTrashedExpenses,
  restoreTrashedExpense,
  purgeCountdownLabel,
  type TrashedExpense,
} from "@/lib/expenseRecycleBin";

type Props = {
  organizationId: string | null | undefined;
  onCountChange?: (count: number) => void;
  /** Bumped by the parent after a successful Delete, so this panel refetches without its own poll. */
  refreshToken?: number;
};

export function ExpenseRecycleBinPanel({ organizationId, onCountChange, refreshToken }: Props) {
  const { toast } = useToast();
  const [items, setItems] = useState<TrashedExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organizationId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await listTrashedExpenses(organizationId);
      setItems(rows);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load the Recycle Bin");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    onCountChange?.(items.length);
  }, [items.length, onCountChange]);

  const handleRestore = async (item: TrashedExpense) => {
    try {
      setRestoringId(item.id);
      await restoreTrashedExpense(item.id);
      toast({
        title: "Expense Restored",
        description: `"${item.title}" is back in your Drafts.`,
      });
      await refresh();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to restore expense",
      });
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="h-5 w-5" />
          Recycle Bin
        </CardTitle>
        <CardDescription>
          Deleted expenses stay here for 30 days so you can restore them, then they're automatically removed for good.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground py-8 text-center">Loading…</p>
        ) : loadError ? (
          <p className="text-destructive text-sm py-8 text-center">{loadError}</p>
        ) : items.length === 0 ? (
          <div className="py-10 text-center space-y-1">
            <p className="text-muted-foreground">The Recycle Bin is empty.</p>
            <p className="text-xs text-muted-foreground">
              Expenses you delete from Drafts appear here and can be restored for 30 days.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Destination</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Expense Date</TableHead>
                  <TableHead>Deleted On</TableHead>
                  <TableHead>Days Remaining</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const tripStart = parseLocalDate(item.tripStart);
                  const deletedAt = new Date(item.deletedAt);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.title}</div>
                        <div className="text-sm text-muted-foreground">{item.destination || "—"}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatINR(item.totalAmount)}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {tripStart ? format(tripStart, "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(deletedAt, "MMM d, yyyy h:mm a")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="whitespace-nowrap">
                          {purgeCountdownLabel(item.purgeAfter)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          onClick={() => void handleRestore(item)}
                          disabled={restoringId === item.id}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          {restoringId === item.id ? "Restoring…" : "Restore"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
