import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AUDIT_EVENT_LABELS, AUDIT_SOURCE_LABELS, auditEventLabel, auditSourceLabel, describeActor, fetchAuditEvents, formatAuditValue, isPasswordEvent,
  type AuditEventRow,
} from "@/lib/userAccountAudit";
import { fetchUserManagementList, type UserManagementListRow } from "@/lib/orgUsers";

const PAGE_SIZE = 50;
const ANY = "__any__";

/** Administration → User Audit: organization-wide account audit history with simple filters. Read-only; RLS scopes it to the organization. */
export default function UserAudit() {
  const { organizationId } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserManagementListRow[]>([]);
  const [target, setTarget] = useState(ANY);
  const [actor, setActor] = useState(ANY);
  const [eventType, setEventType] = useState(ANY);
  const [source, setSource] = useState(ANY);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (!organizationId) return;
    fetchUserManagementList(organizationId).then(setUsers).catch(() => setUsers([]));
  }, [organizationId]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAuditEvents({
        organizationId,
        targetUserId: target === ANY ? null : target,
        actorUserId: actor === ANY ? null : actor,
        eventType: eventType === ANY ? null : eventType,
        source: source === ANY ? null : source,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : null,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(r.rows);
      setTotal(r.total);
    } catch {
      setError("Audit history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [organizationId, target, actor, eventType, source, from, to, page]);

  useEffect(() => { void load(); }, [load]);

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => { setPage(0); set(v); };
  const sortedUsers = useMemo(() => [...users].sort((a, b) => a.name.localeCompare(b.name)), [users]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4 p-2 sm:p-4" data-testid="user-audit-page">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>User Audit</CardTitle>
              <CardDescription>
                Every change to a user account in this organization: who made it, what changed, when, and from where. Entries cannot be edited or deleted.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate("/admin/users")}>Back to User Management</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label>Target user</Label>
              <Select value={target} onValueChange={resetPage(setTarget)}>
                <SelectTrigger><SelectValue placeholder="All users" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All users</SelectItem>
                  {sortedUsers.map((u) => <SelectItem key={u.user_id} value={u.user_id}>{u.name} ({u.email})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Changed by</Label>
              <Select value={actor} onValueChange={resetPage(setActor)}>
                <SelectTrigger><SelectValue placeholder="Anyone" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Anyone</SelectItem>
                  {sortedUsers.map((u) => <SelectItem key={u.user_id} value={u.user_id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Event type</Label>
              <Select value={eventType} onValueChange={resetPage(setEventType)}>
                <SelectTrigger><SelectValue placeholder="All events" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All events</SelectItem>
                  {Object.entries(AUDIT_EVENT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Source</Label>
              <Select value={source} onValueChange={resetPage(setSource)}>
                <SelectTrigger><SelectValue placeholder="All sources" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All sources</SelectItem>
                  {Object.entries(AUDIT_SOURCE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from">From</Label>
              <Input id="audit-from" type="date" value={from} onChange={(e) => { setPage(0); setFrom(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to">To</Label>
              <Input id="audit-to" type="date" value={to} onChange={(e) => { setPage(0); setTo(e.target.value); }} />
            </div>
          </div>

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && !error && rows.length === 0 && <p className="text-sm text-muted-foreground">No matching audit events.</p>}

          <ul className="space-y-2">
            {rows.map((e) => {
              const a = describeActor({ actor_user_id: e.actor_user_id, actor_name: e.actor_snapshot?.name ?? null, actor_type: e.actor_type, execution_context: (e.metadata?.execution_context as string) ?? null, source: e.source });
              const pw = isPasswordEvent(e.event_type);
              return (
                <li key={e.id} className="rounded-md border p-3 text-sm" data-testid="audit-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{auditEventLabel(e.event_type)} — {e.target_snapshot?.name ?? "Unknown account"}{e.target_snapshot?.email ? ` (${e.target_snapshot.email})` : ""}</span>
                    <span className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    By {a.name}{a.note ? ` (${a.note})` : ""} · {auditSourceLabel(e.source)}{e.field_name && !pw ? ` · ${e.field_name}` : ""}
                  </div>
                  {!pw && (e.old_value !== null || e.new_value !== null) && e.event_type !== "baseline_snapshot" && (
                    <div className="mt-1">{formatAuditValue(e.event_type, e.old_value)} → {formatAuditValue(e.event_type, e.new_value)}</div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{total} event{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
              <span className="text-xs">Page {page + 1} of {pages}</span>
              <Button variant="outline" size="sm" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
