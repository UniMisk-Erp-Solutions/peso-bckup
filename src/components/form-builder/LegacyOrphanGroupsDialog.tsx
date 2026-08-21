/**
 * DOC-097 hotfix pt.3 — read-only inspector for "legacy orphan groups": a
 * template's active dependent-field configurations whose parent option is
 * no longer in the template's current options[]. Inspection only — no
 * delete/restore/repair action exists here, per explicit instruction.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";
import {
  getFormTemplateLegacyOrphanGroups,
  type OrphanGroup,
} from "@/lib/formBuilder/categoryServerSearchV2";

export function LegacyOrphanGroupsDialog({
  open,
  onOpenChange,
  organizationId,
  templateId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  templateId: string;
}) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<OrphanGroup[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoadState("loading");
    setError(null);
    getFormTemplateLegacyOrphanGroups(organizationId, templateId)
      .then((result) => {
        setGroups(result);
        setLoadState("success");
      })
      .catch((e: unknown) => {
        setLoadState("error");
        setError(e instanceof Error ? e.message : "Could not load legacy configurations.");
      });
  }, [open, organizationId, templateId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Legacy orphan configurations</DialogTitle>
          <DialogDescription>
            These are dependent-field configurations that still exist in the database, but their
            parent option is no longer present in this template. They are not used by the current
            form.
          </DialogDescription>
        </DialogHeader>

        {loadState === "loading" && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {loadState === "error" && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
          </div>
        )}

        {loadState === "success" && (
          groups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No legacy configurations found.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.parentOptionValue} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{g.parentOptionValue}</span>
                    <span className="text-xs text-muted-foreground">
                      {g.rootBranchCount + g.nestedBranchCount} dependent field
                      {g.rootBranchCount + g.nestedBranchCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Last updated {format(new Date(g.latestUpdatedAt), "MMM d, yyyy h:mm a")}
                  </div>
                  <ul className="text-sm space-y-0.5">
                    {g.fields.map((f) => (
                      <li key={f.fieldKey} className="flex items-center gap-1.5 text-muted-foreground">
                        <span>{f.name}</span>
                        {f.isNested && <span className="text-xs">(nested)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
