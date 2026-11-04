import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  auditEventLabel, auditSourceLabel, describeActor, fetchUserIdentityTimeline, formatAuditValue, isPasswordEvent,
  type UserAuditEvent,
} from "@/lib/userAccountAudit";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  userId: string | null;
  /** Current display name, only for the dialog title; every row shows the identity the account had AT THAT TIME. */
  userName?: string;
};

const FAILURE = /failed|denied/;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Audit History for ONE account: newest first, with who changed it, what, when, and from where. Read-only. */
export function UserAuditHistoryDialog({ open, onOpenChange, organizationId, userId, userName }: Props) {
  const [events, setEvents] = useState<UserAuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !organizationId || !userId) return;
    let cancelled = false;
    setEvents(null);
    setError(null);
    fetchUserIdentityTimeline(organizationId, userId)
      .then((rows) => { if (!cancelled) setEvents([...rows].reverse()); })
      .catch(() => { if (!cancelled) setError("Audit history could not be loaded."); });
    return () => { cancelled = true; };
  }, [open, organizationId, userId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="user-audit-history">
        <DialogHeader>
          <DialogTitle>Audit History{userName ? ` — ${userName}` : ""}</DialogTitle>
          <DialogDescription>
            Who changed this account, what changed, and when. Names and emails shown on each row are the ones the account had at that moment.
            Passwords are never recorded.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {!error && events === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!error && events?.length === 0 && <p className="text-sm text-muted-foreground">No audit events have been recorded for this account yet.</p>}

        <ol className="space-y-3">
          {events?.map((e) => {
            const actor = describeActor(e);
            const isPw = isPasswordEvent(e.event_type);
            const showDiff = !isPw && (e.old_value !== null || e.new_value !== null) && e.event_type !== "baseline_snapshot";
            return (
              <li key={e.event_id} className="rounded-md border p-3 text-sm" data-testid="audit-event">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{auditEventLabel(e.event_type)}</span>
                  <span className="text-xs text-muted-foreground">{formatWhen(e.occurred_at)}</span>
                </div>
                <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <div>
                    <span className="text-muted-foreground">Changed by: </span>
                    <span>{actor.name}</span>
                    {actor.note && <span className="text-xs text-muted-foreground"> ({actor.note})</span>}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Source: </span>
                    <span>{auditSourceLabel(e.source)}</span>
                  </div>
                  {e.field_name && !isPw && (
                    <div>
                      <span className="text-muted-foreground">Field: </span>
                      <span>{e.field_name}</span>
                    </div>
                  )}
                  {e.identity_name && (
                    <div>
                      <span className="text-muted-foreground">Account at the time: </span>
                      <span>{e.identity_name}{e.identity_email ? ` · ${e.identity_email}` : ""}</span>
                    </div>
                  )}
                </div>
                {showDiff && (
                  <div className="mt-2 grid gap-1 sm:grid-cols-2">
                    <div><span className="text-muted-foreground">Previous: </span><span>{formatAuditValue(e.event_type, e.old_value)}</span></div>
                    <div><span className="text-muted-foreground">New: </span><span>{formatAuditValue(e.event_type, e.new_value)}</span></div>
                  </div>
                )}
                {isPw && <p className="mt-2 text-xs text-muted-foreground">Event only. No password information is stored.</p>}
                {FAILURE.test(e.event_type) && <Badge variant="outline" className="mt-2">Not completed</Badge>}
              </li>
            );
          })}
        </ol>
      </DialogContent>
    </Dialog>
  );
}

export default UserAuditHistoryDialog;
