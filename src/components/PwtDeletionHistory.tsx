import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describePwtError } from "@/lib/pwt/pwtErrors";
import { describeDeletion, listPwtDeletions, PWT_DELETION_STATUS_LABEL, retryPwtDeletion, type PwtDeletion } from "@/lib/pwt/pwtDeletion";

/**
 * Corrections made in TallyPrime because an already-synced expense was deleted in PesoWise.
 * Nothing here needs a click: they are queued and applied automatically. "Retry" only appears for a correction that was BLOCKED
 * (for example the voucher was changed in Tally by hand) and is for use after that has been sorted out.
 */
export function PwtDeletionHistory({ organizationId }: { organizationId: string }) {
  const [rows, setRows] = useState<PwtDeletion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listPwtDeletions(organizationId, 10));
      setError(null);
    } catch (e) {
      setError(describePwtError(e, "Could not load the corrections. Refresh the page."));
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const retry = async (id: string) => {
    try {
      await retryPwtDeletion(organizationId, id);
      await load();
    } catch (e) {
      setError(describePwtError(e, "The retry did not work. Try again."));
    }
  };

  return (
    <Card data-testid="pwt-deletion-history">
      <CardHeader>
        <CardTitle>Corrections in Tally</CardTitle>
        <CardDescription>
          When an expense that was already synced to Tally is deleted or edited in PesoWise, the matching accounting entry is corrected in Tally automatically (an edited expense is then posted again with its new values).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <ul className="space-y-2 text-sm">
          {rows.map((d) => (
            <li key={d.id} data-testid="pwt-deletion-row">
              <Badge variant={d.status === "completed" ? "success" : d.status === "blocked" ? "destructive" : "secondary"} className="mr-2 text-[10px]">
                {PWT_DELETION_STATUS_LABEL[d.status]}
              </Badge>
              {new Date(d.created_at).toLocaleString()}
              <div className="text-xs text-muted-foreground">{describeDeletion(d)}</div>
              {d.status === "blocked" && (
                <Button size="sm" variant="outline" className="mt-1" onClick={() => void retry(d.id)}>Retry</Button>
              )}
            </li>
          ))}
          {!rows.length && !error && <li className="text-muted-foreground">Nothing has needed a correction.</li>}
        </ul>
      </CardContent>
    </Card>
  );
}
