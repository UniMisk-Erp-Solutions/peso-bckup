import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { employeeIdFromSyntheticEmail } from "@/lib/personIdentitySearch";
import type { OrganizationIdentityPolicy } from "@/lib/organizationIdentityMode";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { hasApprovalHierarchy, hasTeamsEnabled } from "@/lib/orgFeatureGates";
import { downloadTeamExpensesCsv } from "@/lib/exportTeamExpenses";
import {
  fetchMyTeamsOverview,
  fetchTeamExpensesForLeader,
  type MyTeamMemberOverview,
  type MyTeamOverview,
  type TeamExpenseRow,
} from "@/services/MyTeamsService";
import { ChevronDown, Download, FileText, Loader2, Search, Settings, Users } from "lucide-react";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { subDays } from "date-fns";
import { useViewportMode } from "@/hooks/useViewportMode";

type ApprovedPeriodMode = "custom" | "all_time";

const LEADER_ROLES = new Set(["admin", "engineer", "team_leader", "executive"]);
const MEMBER_PAGE_SIZES = [25, 50, 100] as const;
const EXPENSE_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

function memberMatchesSearch(member: MyTeamMemberOverview, query: string, policy: OrganizationIdentityPolicy): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    member.name.toLowerCase().includes(q) ||
    (policy.includeEmailInSearch && member.email.toLowerCase().includes(q)) ||
    (policy.includeEmployeeIdInSearch && (member.employee_id ?? "").toLowerCase().includes(q)) ||
    (policy.allowSyntheticEmployeeIdFallback && !member.employee_id &&
      (employeeIdFromSyntheticEmail(member.email ?? "") ?? "").toLowerCase().includes(q))
  );
}

function expenseMatchesSearch(row: TeamExpenseRow, query: string, policy: OrganizationIdentityPolicy): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.employee_name.toLowerCase().includes(q) ||
    (policy.includeEmailInSearch && row.employee_email.toLowerCase().includes(q)) ||
    (policy.includeEmployeeIdInSearch && (row.employee_id ?? "").toLowerCase().includes(q)) ||
    (policy.allowSyntheticEmployeeIdFallback && !row.employee_id &&
      (employeeIdFromSyntheticEmail(row.employee_email ?? "") ?? "").toLowerCase().includes(q)) ||
    row.title.toLowerCase().includes(q)
  );
}

function PaginatedListFooter({
  page,
  pageSize,
  totalItems,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      <span className="text-sm text-muted-foreground">
        Showing {start}–{end} of {totalItems}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function TeamMembersTable({
  members,
  allTime,
}: {
  members: MyTeamMemberOverview[];
  allTime: boolean;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const { policy } = useOrganizationIdentityMode();

  const filtered = useMemo(
    () => members.filter((m) => memberMatchesSearch(m, search, policy)),
    [members, search, policy],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [search, pageSize, members.length]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageMembers = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);

  const { isMobile } = useViewportMode();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, or employee ID…"
            className="pl-8 h-9"
          />
        </div>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => setPageSize(Number(v))}
        >
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEMBER_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filtered.length} member{filtered.length === 1 ? "" : "s"}
          {search.trim() && filtered.length !== members.length ? ` (of ${members.length})` : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No members match your search.</p>
      ) : (
        <>
          {isMobile ? (
            <div className="space-y-2" data-testid="members-card-list">
              {pageMembers.map((m) => (
                <div
                  key={m.user_id}
                  className="rounded-md border p-3 space-y-1"
                  data-testid="member-card"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{m.name}</span>
                    <span className="text-sm font-medium">{formatINR(Number(m.balance))}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {m.employee_id && (
                      <span className="font-mono">{m.employee_id}</span>
                    )}
                    {m.employee_id && m.email && <span> · </span>}
                    <span>{m.email}</span>
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>
                      Pending: {m.pending_expense_count}
                      {m.pending_expense_total > 0 && (
                        <span className="ml-0.5">
                          ({formatINR(Number(m.pending_expense_total))})
                        </span>
                      )}
                    </span>
                    <span>
                      Approved{allTime ? " (all)" : ""}: {m.approved_expense_count}
                      {m.approved_expense_total > 0 && (
                        <span className="ml-0.5">
                          ({formatINR(Number(m.approved_expense_total))})
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto max-h-[min(480px,60vh)] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Employee ID</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Pending</TableHead>
                    <TableHead>
                      Approved{allTime ? " (all time)" : " (period)"}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageMembers.map((m) => (
                    <TableRow key={m.user_id}>
                      <TableCell className="font-medium">{m.name}</TableCell>
                      <TableCell>{m.employee_id || "—"}</TableCell>
                      <TableCell className="text-sm">{m.email}</TableCell>
                      <TableCell>{formatINR(Number(m.balance))}</TableCell>
                      <TableCell>
                        {m.pending_expense_count}
                        {m.pending_expense_total > 0 && (
                          <span className="text-muted-foreground text-xs ml-1">
                            ({formatINR(Number(m.pending_expense_total))})
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.approved_expense_count}
                        {m.approved_expense_total > 0 && (
                          <span className="text-muted-foreground text-xs ml-1">
                            ({formatINR(Number(m.approved_expense_total))})
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <PaginatedListFooter
            page={safePage}
            pageSize={pageSize}
            totalItems={filtered.length}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}

function roleLabel(role: string): string {
  if (role === "team_leader") return "Team Leader";
  if (role === "executive") return "Executive";
  if (role === "manager") return "Manager";
  if (role === "admin") return "Admin";
  return role;
}

function TeamExpensesPanel({
  organizationId,
  team,
  dateFrom,
  dateTo,
  allTime,
}: {
  organizationId: string;
  team: MyTeamOverview;
  dateFrom: Date | null;
  dateTo: Date | null;
  allTime: boolean;
}) {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved">("pending");
  const [rows, setRows] = useState<TeamExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const {
    progress: expensesProgress,
    startOperation: startExpensesProgress,
    completeOperation: completeExpensesProgress,
  } = useOperationProgress();
  const prevExpensesLoadingRef = useRef(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const { policy } = useOrganizationIdentityMode();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTeamExpensesForLeader(organizationId, team.id, {
        statusFilter,
        dateFrom: allTime ? null : dateFrom,
        dateTo: allTime ? null : dateTo,
      });
      setRows(data);
    } catch (e) {
      toast({
        title: "Could not load expenses",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [organizationId, team.id, statusFilter, dateFrom, dateTo, allTime, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    const wasLoading = prevExpensesLoadingRef.current;
    prevExpensesLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startExpensesProgress("Loading expenses…");
    } else if (!loading && wasLoading) {
      completeExpensesProgress(`${rows.length} expense${rows.length === 1 ? "" : "s"} loaded`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const filteredRows = useMemo(
    () => rows.filter((row) => expenseMatchesSearch(row, search, policy)),
    [rows, search, policy],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [search, pageSize, statusFilter, rows.length]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safePage, pageSize]);

  const { isMobile } = useViewportMode();

  const handleExport = async () => {
    try {
      const exportRows = await fetchTeamExpensesForLeader(organizationId, team.id, {
        statusFilter,
        dateFrom: allTime ? null : dateFrom,
        dateTo: allTime ? null : dateTo,
        limit: 2000,
      });
      downloadTeamExpensesCsv(team.name, exportRows);
    } catch (e) {
      toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm">
            <ChevronDown className={`h-4 w-4 mr-1 transition-transform ${open ? "rotate-180" : ""}`} />
            View expenses
          </Button>
        </CollapsibleTrigger>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as "all" | "pending" | "approved")}
        >
          <SelectTrigger className="w-[140px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="secondary" size="sm" onClick={() => void handleExport()}>
          <Download className="h-4 w-4 mr-1" />
          Export CSV
        </Button>
      </div>
      <CollapsibleContent className="mt-3">
        {expensesProgress.status !== "idle" && (
          <div className="mb-2">
            <AsyncOperationProgress
              status={expensesProgress.status}
              title={expensesProgress.phase}
              showSuccess={expensesProgress.status === "success"}
              compact
            />
          </div>
        )}
        {loading ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No expenses match this filter.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search employee or title…"
                  className="pl-8 h-8"
                />
              </div>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => setPageSize(Number(v))}
              >
                <SelectTrigger className="w-[130px] h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">
                {filteredRows.length} expense{filteredRows.length === 1 ? "" : "s"}
                {search.trim() && filteredRows.length !== rows.length ? ` (of ${rows.length})` : ""}
              </span>
            </div>
            {filteredRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No expenses match your search.</p>
            ) : (
              <>
                {isMobile ? (
                  <div className="space-y-2" data-testid="expenses-card-list">
                    {pageRows.map((row) => (
                      <div
                        key={row.expense_id}
                        className="rounded-md border p-3 space-y-1"
                        data-testid="expense-card"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{row.employee_name}</span>
                          <span className="text-sm font-medium">{formatINR(Number(row.total_amount))}</span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {row.employee_id || row.employee_email}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm truncate">{row.title}</span>
                          <Badge variant="outline" className="text-xs shrink-0">{row.status}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(row.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border overflow-x-auto max-h-[min(400px,50vh)] overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-background z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                        <TableRow>
                          <TableHead>Employee</TableHead>
                          <TableHead>Title</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pageRows.map((row) => (
                          <TableRow key={row.expense_id}>
                            <TableCell>
                              <div className="font-medium text-sm">{row.employee_name}</div>
                              <div className="text-xs text-muted-foreground">{row.employee_id || row.employee_email}</div>
                            </TableCell>
                            <TableCell className="text-sm">{row.title}</TableCell>
                            <TableCell>{formatINR(Number(row.total_amount))}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{row.status}</Badge>
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {new Date(row.created_at).toLocaleDateString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <PaginatedListFooter
                  page={safePage}
                  pageSize={pageSize}
                  totalItems={filteredRows.length}
                  onPageChange={setPage}
                />
              </>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function MyTeams() {
  const { t } = useTranslation("nav");
  const {
    organizationId,
    userRole,
    organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
  } = useAuth();
  const { toast } = useToast();
  const featureCtx = {
    featureFlags: organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
    organizationId,
  };
  const teamsEnabled = hasTeamsEnabled(featureCtx);
  const approvalHierarchyEnabled = hasApprovalHierarchy(featureCtx);
  const myTeamsEnabled = teamsEnabled || approvalHierarchyEnabled;

  const [teams, setTeams] = useState<MyTeamOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvedPeriodMode, setApprovedPeriodMode] = useState<ApprovedPeriodMode>("custom");
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);
  const [dateFrom, setDateFrom] = useState(() => subDays(new Date(), 30).toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  const allTime = approvedPeriodMode === "all_time";

  const parsedFrom = useMemo(() => {
    if (allTime) return null;
    return dateFrom ? new Date(`${dateFrom}T00:00:00`) : null;
  }, [allTime, dateFrom]);
  const parsedTo = useMemo(() => {
    if (allTime) return null;
    return dateTo ? new Date(`${dateTo}T23:59:59`) : null;
  }, [allTime, dateTo]);

  const load = useCallback(async () => {
    if (!organizationId || !myTeamsEnabled) {
      setTeams([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchMyTeamsOverview(organizationId, parsedFrom, parsedTo);
      setTeams(data);
    } catch (e) {
      toast({
        title: "Could not load teams",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [organizationId, myTeamsEnabled, parsedFrom, parsedTo, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress("Loading teams…", { description: "Fetching team roster and balances" });
    } else if (!loading && wasLoading) {
      completeLoadProgress(`${teams.length} team${teams.length === 1 ? "" : "s"} loaded`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const summary = useMemo(() => {
    let members = 0;
    let pending = 0;
    let balance = 0;
    let approvedCount = 0;
    let approvedTotal = 0;
    for (const team of teams) {
      members += team.member_count;
      for (const m of team.members) {
        pending += m.pending_expense_count;
        balance += Number(m.balance ?? 0);
        approvedCount += m.approved_expense_count;
        approvedTotal += Number(m.approved_expense_total ?? 0);
      }
    }
    return { teamCount: teams.length, members, pending, balance, approvedCount, approvedTotal };
  }, [teams]);

  if (!myTeamsEnabled) {
    return (
      <div className="p-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>{t("myTeams", { defaultValue: "My Teams" })}</CardTitle>
            <CardDescription>
              Teams or approval hierarchy is not enabled for this organization. Ask your Master Admin to enable Teams or Approval hierarchy.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!userRole || !LEADER_ROLES.has(userRole)) {
    return (
      <div className="p-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>{t("myTeams", { defaultValue: "My Teams" })}</CardTitle>
            <CardDescription>This page is available to managers, executives, team leaders, and admins.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-7 w-7" />
            {t("myTeams", { defaultValue: "My Teams" })}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            View-only roster, balances, and expenses for teams you lead
            {approvalHierarchyEnabled && !teamsEnabled ? " (from supervisor hierarchy)" : ""}.
            {userRole === "admin" && (
              <>
                {" "}
                <Link to="/settings" className="text-primary underline inline-flex items-center gap-1">
                  <Settings className="h-3 w-3" />
                  Edit teams in Settings
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="approved-period" className="text-xs">Approved expenses</Label>
            <Select
              value={approvedPeriodMode}
              onValueChange={(v) => setApprovedPeriodMode(v as ApprovedPeriodMode)}
            >
              <SelectTrigger id="approved-period" className="w-[160px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_time">All time</SelectItem>
                <SelectItem value="custom">Date range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!allTime && (
            <>
              <div>
                <Label htmlFor="date-from" className="text-xs">From</Label>
                <Input
                  id="date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-[150px] h-9"
                />
              </div>
              <div>
                <Label htmlFor="date-to" className="text-xs">To</Label>
                <Input
                  id="date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-[150px] h-9"
                />
              </div>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/team-reports">
              <FileText className="h-4 w-4 mr-1" />
              Team Reports
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Teams</CardDescription>
            <CardTitle className="text-2xl">{summary.teamCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Members</CardDescription>
            <CardTitle className="text-2xl">{summary.members}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending expenses</CardDescription>
            <CardTitle className="text-2xl">{summary.pending}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              Approved{allTime ? " (all time)" : " (period)"}
            </CardDescription>
            <CardTitle className="text-xl">
              {summary.approvedCount}
              {summary.approvedTotal > 0 && (
                <span className="text-sm font-normal text-muted-foreground block mt-0.5">
                  {formatINR(summary.approvedTotal)}
                </span>
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total member balance</CardDescription>
            <CardTitle className="text-xl">{formatINR(summary.balance)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {loadProgress.status !== "idle" && (
        <AsyncOperationProgress
          status={loadProgress.status}
          title={loadProgress.phase}
          description={loadProgress.status === "running" ? "Fetching team roster and balances" : undefined}
          showSuccess={loadProgress.status === "success"}
          compact={loadProgress.status !== "running"}
        />
      )}
      {loading ? null : teams.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No teams assigned to you yet. If you supervise employees, ensure they have you set as their supervisor in User Management, or ask your admin to assign formal teams.
          </CardContent>
        </Card>
      ) : (
        teams.map((team) => (
          <Card key={team.id}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>{team.name}</CardTitle>
                  <CardDescription className="mt-1">
                    {team.member_count} member{team.member_count === 1 ? "" : "s"}
                    {" · "}
                    Routing: {team.routing_mode.replace(/_/g, " ")}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(team.roles_on_team ?? []).map((r) => (
                    <Badge key={r} variant="secondary">
                      {roleLabel(r)}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {team.team_leader_name && <span>TL: {team.team_leader_name}</span>}
                {team.executive_name && <span>Executive: {team.executive_name}</span>}
                {team.manager_name && <span>Manager: {team.manager_name}</span>}
              </div>
            </CardHeader>
            <CardContent>
              {team.members.length === 0 ? (
                <p className="text-sm text-muted-foreground">No members assigned to this team.</p>
              ) : (
                <TeamMembersTable members={team.members} allTime={allTime} />
              )}
              {organizationId && (
                <TeamExpensesPanel
                  organizationId={organizationId}
                  team={team}
                  dateFrom={parsedFrom}
                  dateTo={parsedTo}
                  allTime={allTime}
                />
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
