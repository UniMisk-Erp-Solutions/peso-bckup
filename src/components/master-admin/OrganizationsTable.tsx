/**
 * Compact organizations list for Master Admin (DOC-165).
 * Presentational only: it reads props and calls onManage; every edit happens in the
 * organization management view, using the page's existing handlers.
 */
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Search, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Organization } from "./types";

type Props = {
  organizations: Organization[];
  memberCountByOrgId: Record<string, number>;
  /** organization_id -> feature_key -> enabled (to know who is blocked by the org_blocked flag). */
  blockedByFlag: Record<string, boolean>;
  onManage: (orgId: string) => void;
};

function isOrganizationRowBlocked(org: Organization, blockedByFlag: Record<string, boolean>): boolean {
  return blockedByFlag[org.id] === true || Boolean(org.is_blocked);
}

function paymentBadgeClass(status: string | null): string {
  switch (status) {
    case "active":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300";
    case "pending":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300";
    case "overdue":
    case "suspended":
    case "cancelled":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300";
    default:
      return "text-muted-foreground";
  }
}

export function OrganizationsTable({ organizations, memberCountByOrgId, blockedByFlag, onManage }: Props) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return organizations;
    return organizations.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.slug.toLowerCase().includes(q) ||
        (o.subdomain ?? "").toLowerCase().includes(q),
    );
  }, [organizations, query]);

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search organizations"
          aria-label="Search organizations"
          className="pl-9"
        />
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table noScrollWrapper className="table-fixed [&_td]:px-3 [&_th]:px-3">
          <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide">
            <TableRow>
              <TableHead className="w-[27%]">Organization</TableHead>
              <TableHead className="w-[10%]">Plan</TableHead>
              <TableHead className="w-[10%]">Users</TableHead>
              <TableHead className="w-[12%]">Payment</TableHead>
              <TableHead className="w-[11%]">Status</TableHead>
              <TableHead className="w-[17%]">Last active</TableHead>
              <TableHead className="w-[13%] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {organizations.length === 0 ? "No organizations" : "No organizations match your search"}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((org) => {
                const blocked = isOrganizationRowBlocked(org, blockedByFlag);
                const count = memberCountByOrgId[org.id] ?? 0;
                return (
                  <TableRow
                    key={org.id}
                    className={blocked ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20" : "hover:bg-muted/30"}
                  >
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => onManage(org.id)}
                        className="block w-full text-left"
                      >
                        <span className="block truncate font-semibold hover:underline">{org.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{org.slug}</span>
                      </button>
                    </TableCell>
                    <TableCell className="truncate capitalize">{org.plan ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {count} / {org.max_users == null ? "∞" : org.max_users}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`capitalize ${paymentBadgeClass(org.payment_status)}`}>
                        {org.payment_status ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {blocked ? (
                        <Badge variant="destructive">Blocked</Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                        >
                          Active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {org.last_activity_at ? format(new Date(org.last_activity_at), "PP") : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => onManage(org.id)} className="gap-1.5">
                        <Settings2 className="h-3.5 w-3.5" />
                        Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
